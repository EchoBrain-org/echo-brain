#!/usr/bin/env node

// Verifier-owned registration and third-party commitment receipts. No signing
// key, seed, or expected answer is sent to the timestamp authority: only a hash.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST_ROOT = join(HERE, "trust", "freetsa-ca.pem");
const TRUST_ROOT_SHA256 = "2151b61137ffa86bf664691ba67e7da0b19f98c758e3d228d5d8ebf27e044438";
export const TIMESTAMP_AUTHORITY = "https://freetsa.org/tsr";
const DIGEST = /^[a-f0-9]{64}$/;
const ENTRY_FILE = /^\d{8}-[a-f0-9]{64}\.json$/;

export function canonicalRegistryJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Registry numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRegistryJson).join(",")}]`;
  assert.ok(typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "Registry values must be plain JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalRegistryJson(value[key])}`).join(",")}}`;
}

export const registrySha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function privateDirectory(directory) {
  const path = resolve(directory);
  assert.equal(realpathSync(dirname(path)), dirname(path), "Registry parent must not traverse symlinks");
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const state = lstatSync(path);
  assert.ok(state.isDirectory() && !state.isSymbolicLink(), "Registry path must be a real directory");
  assert.equal(state.mode & 0o777, 0o700, "Registry directory must be mode 0700");
  if (process.getuid) assert.equal(state.uid, process.getuid(), "Registry must belong to the verifier user");
  return path;
}

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeOnce(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

export function readRegistry(directory) {
  const root = privateDirectory(directory);
  const files = readdirSync(root).filter((name) => ENTRY_FILE.test(name)).sort();
  const entries = [];
  for (const [index, name] of files.entries()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Registry entries must be regular files");
    const bytes = readFileSync(path);
    const entry = JSON.parse(bytes.toString("utf8"));
    const digest = registrySha256(canonicalRegistryJson(entry));
    assert.equal(name, `${String(index + 1).padStart(8, "0")}-${digest}.json`, "Registry entry sequence/digest mismatch");
    assert.equal(entry.sequence, index + 1);
    assert.equal(entry.previous_sha256, entries.at(-1)?.sha256 ?? null, "Registry chain mismatch");
    entries.push({ ...entry, sha256: digest, path });
  }
  return entries;
}

export function appendRegistryEntry(directory, body, validatePrevious = () => {}) {
  const root = privateDirectory(directory);
  const lock = join(root, ".writer-lock");
  mkdirSync(lock, { mode: 0o700 }); // A stale lock fails closed; no lock stealing.
  try {
    const previous = readRegistry(root);
    validatePrevious(previous);
    const entry = { schema_version: 1, sequence: previous.length + 1, previous_sha256: previous.at(-1)?.sha256 ?? null, body };
    const bytes = canonicalRegistryJson(entry);
    const digest = registrySha256(bytes);
    const path = join(root, `${String(entry.sequence).padStart(8, "0")}-${digest}.json`);
    writeOnce(path, `${bytes}\n`);
    return Object.freeze({ sequence: entry.sequence, sha256: digest, path });
  } finally { rmdirSync(lock); }
}

function checkedTrustRoot() {
  assert.equal(registrySha256(readFileSync(TRUST_ROOT)), TRUST_ROOT_SHA256, "Third-party trust root changed");
  return TRUST_ROOT;
}

function openssl(args) {
  return execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000, env: { ...process.env, LC_ALL: "C" } });
}

/** Cryptographically verifies both the message imprint and query nonce. */
export function verifyTimestampReceipt({ digest, directory, notAfterMs = Date.now() + 1000 }) {
  assert.match(digest, DIGEST);
  const root = privateDirectory(directory);
  const authority = JSON.parse(readFileSync(join(root, "authority.json"), "utf8"));
  assert.equal(authority.url, TIMESTAMP_AUTHORITY);
  assert.equal(authority.digest, digest);
  const reply = join(root, "response.tsr");
  const trust = checkedTrustRoot();
  const verification = ["-in", reply, "-CAfile", trust];
  openssl(["ts", "-verify", "-queryfile", join(root, "request.tsq"), ...verification]);
  openssl(["ts", "-verify", "-digest", digest, ...verification]);
  const details = openssl(["ts", "-reply", "-in", reply, "-text"]);
  const stamp = /^Time stamp: (.+)$/m.exec(details)?.[1];
  const timestampMs = Date.parse(stamp ?? "");
  assert.ok(Number.isFinite(timestampMs), "Timestamp receipt has no parseable signed time");
  assert.ok(timestampMs <= notAfterMs, "Timestamp commitment postdates the permitted start");
  return Object.freeze({ kind: "rfc3161-third-party-anchor-v1", digest, authority: TIMESTAMP_AUTHORITY, signed_at: new Date(timestampMs).toISOString(), response_sha256: registrySha256(readFileSync(reply)), trust_root_sha256: TRUST_ROOT_SHA256, directory: root });
}

export async function timestampDigest({ digest, directory, fetchImpl = fetch, timeoutMs = 20000 }) {
  assert.match(digest, DIGEST);
  checkedTrustRoot();
  const root = privateDirectory(directory);
  assert.equal(readdirSync(root).length, 0, "Timestamp receipt directory must be fresh");
  const queryPath = join(root, "request.tsq");
  // OpenSSL mints an unpredictable query nonce; query contains the digest only.
  const query = execFileSync("openssl", ["ts", "-query", "-digest", digest, "-sha256", "-cert"], { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  writeOnce(queryPath, query);
  writeOnce(join(root, "authority.json"), `${canonicalRegistryJson({ url: TIMESTAMP_AUTHORITY, digest })}\n`);
  const response = await fetchImpl(TIMESTAMP_AUTHORITY, { method: "POST", headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply, application/timestamp-response" }, body: query, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(response.status, 200, "Timestamp authority rejected the commitment");
  assert.match(response.headers.get("content-type") ?? "", /^application\/timestamp-(?:reply|response)(?:;|$)/i);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    assert.ok(total <= 1024 * 1024, "Timestamp response exceeds 1 MiB");
    chunks.push(chunk);
  }
  writeOnce(join(root, "response.tsr"), Buffer.concat(chunks));
  return verifyTimestampReceipt({ digest, directory: root });
}

/** Local chain is useful evidence only when these external receipts verify. */
export function createAnchoredRegistry({ directory, anchorRoot, environmentDigest, verifierDigest, anchorTransport = timestampDigest, verifyAnchor = verifyTimestampReceipt }) {
  assert.match(environmentDigest, DIGEST);
  assert.match(verifierDigest, DIGEST);
  const registryRoot = privateDirectory(directory);
  const anchors = privateDirectory(anchorRoot);
  const anchor = async (entry) => {
    const anchorDirectory = join(anchors, entry.sha256);
    const proof = await anchorTransport({ digest: entry.sha256, directory: anchorDirectory });
    assert.equal(proof?.digest, entry.sha256, "External anchor digest does not match registry entry");
    return Object.freeze({ ...entry, external_anchor: proof });
  };
  const readReceipt = (receipt) => {
    const entry = readRegistry(registryRoot).find((value) => value.sha256 === receipt?.sha256);
    assert.ok(entry, "Receipt is absent from the verified registry chain");
    verifyAnchor({ digest: entry.sha256, directory: receipt.external_anchor.directory });
    return entry;
  };
  return Object.freeze({
    async registerCandidate(candidate) {
      for (const key of ["candidate_digest", "source_digest", "config_digest", "metric_contract_digest"]) assert.match(candidate[key], DIGEST);
      assert.ok(["M1", "M2", "M3"].includes(candidate.milestone));
      return anchor(appendRegistryEntry(registryRoot, { kind: "candidate-registration", candidate, environment_digest: environmentDigest, verifier_digest: verifierDigest }, (existing) => {
        const sameAttempt = existing.some(({ body }) => body.kind === "candidate-registration" && body.candidate.candidate_digest === candidate.candidate_digest && body.candidate.config_digest === candidate.config_digest && body.candidate.metric_contract_digest === candidate.metric_contract_digest && body.candidate.milestone === candidate.milestone);
        assert.equal(sameAttempt, false, "Qualification attempt already registered; never silently retry or replace it");
      }));
    },
    async commitManifest({ candidate_registration, manifest_digest, commitment }) {
      const entry = readReceipt(candidate_registration);
      assert.equal(entry.body.kind, "candidate-registration");
      assert.match(manifest_digest, DIGEST); assert.match(commitment, DIGEST);
      return anchor(appendRegistryEntry(registryRoot, { kind: "manifest-commitment", candidate_registration_sha256: entry.sha256, manifest_digest, commitment }, (existing) => {
        assert.ok(!existing.some(({ body }) => body.kind === "manifest-commitment" && body.candidate_registration_sha256 === entry.sha256), "Manifest already committed for candidate");
      }));
    },
    async recordRunClosure({ candidate_registration, manifest_commitment, run_closure_digest }) {
      const candidate = readReceipt(candidate_registration);
      const commitment = readReceipt(manifest_commitment);
      assert.equal(candidate.body.kind, "candidate-registration");
      assert.equal(commitment.body.kind, "manifest-commitment");
      assert.equal(commitment.body.candidate_registration_sha256, candidate.sha256, "Run closure candidate does not match the sealed manifest");
      assert.match(run_closure_digest, DIGEST);
      return anchor(appendRegistryEntry(registryRoot, {
        kind: "run-closure",
        candidate_registration_sha256: candidate.sha256,
        manifest_commitment_sha256: commitment.sha256,
        run_closure_digest,
      }, (existing) => {
        assert.ok(!existing.some(({ body }) => body.kind === "run-closure" && body.manifest_commitment_sha256 === commitment.sha256), "Run closure already recorded for sealed manifest");
      }));
    },
    async revealManifest(value) {
      assert.match(value.commitment, DIGEST); assert.match(value.manifest_digest, DIGEST);
      const closure = readReceipt(value.run_closure);
      assert.equal(closure.body.kind, "run-closure");
      assert.equal(registrySha256(`${value.manifest_digest}:${value.salt}`), value.commitment, "Reveal does not match sealed commitment");
      assert.equal(registrySha256(canonicalRegistryJson(value.manifest)), value.manifest_digest, "Revealed manifest digest mismatch");
      const commitment = readRegistry(registryRoot).find((entry) => entry.sha256 === closure.body.manifest_commitment_sha256);
      assert.ok(commitment && commitment.body.kind === "manifest-commitment" && commitment.body.commitment === value.commitment, "Run closure does not match sealed manifest commitment");
      return anchor(appendRegistryEntry(registryRoot, { kind: "manifest-reveal", ...value }));
    },
    async verifyRegistration({ stage, receipt, candidate, commitment, manifest_digest }) {
      const entry = readReceipt(receipt);
      assert.equal(entry.body.kind, stage);
      if (stage === "candidate-registration") assert.equal(canonicalRegistryJson(entry.body.candidate), canonicalRegistryJson(candidate));
      else if (stage === "manifest-commitment") { assert.equal(entry.body.commitment, commitment); assert.equal(entry.body.manifest_digest, manifest_digest); }
      else if (stage === "run-closure") assert.match(entry.body.run_closure_digest, DIGEST);
      else assert.fail(`Unsupported registration stage ${stage}`);
      return true;
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, digest, directory] = process.argv.slice(2);
    assert.ok(command === "timestamp" || command === "verify", "Usage: registry.mjs timestamp|verify <sha256> <fresh-receipt-directory>");
    assert.ok(directory, "Receipt directory is required");
    const result = command === "timestamp" ? await timestampDigest({ digest, directory }) : verifyTimestampReceipt({ digest, directory });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`capacity registry: ${error.message}`); process.exitCode = 1; }
}
