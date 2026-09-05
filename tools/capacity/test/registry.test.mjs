import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRegistryEntry, canonicalRegistryJson, createAnchoredRegistry, readRegistry, timestampDigest, verifyTimestampReceipt } from "../registry.mjs";

function temp() { return realpathSync(mkdtempSync(join(tmpdir(), "capacity-registry-"))); }

test("local registry verifies chained content and rejects modified earlier entries", () => {
  const root = temp();
  const first = appendRegistryEntry(root, { kind: "first", candidate_digest: "a".repeat(64) });
  appendRegistryEntry(root, { kind: "second" });
  const entries = readRegistry(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].previous_sha256, first.sha256);
  const altered = JSON.parse(readFileSync(first.path, "utf8"));
  altered.body.candidate_digest = "b".repeat(64);
  writeFileSync(first.path, JSON.stringify(altered));
  assert.throws(() => readRegistry(root), /sequence\/digest mismatch/);
});

test("stale or concurrent writer lock fails closed", () => {
  const root = temp();
  mkdirSync(join(root, ".writer-lock"), { mode: 0o700 });
  assert.throws(() => appendRegistryEntry(root, { kind: "cannot-steal-lock" }), /EEXIST/);
});

test("canonical commitments reject undefined and non-finite values", () => {
  assert.throws(() => canonicalRegistryJson({ missing: undefined }));
  assert.throws(() => canonicalRegistryJson({ latency: Infinity }));
  assert.equal(canonicalRegistryJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("a local claimed verified receipt cannot qualify without an actual signed response", () => {
  const root = temp();
  writeFileSync(join(root, "authority.json"), JSON.stringify({ url: "https://freetsa.org/tsr", digest: "a".repeat(64), verified: true }));
  assert.throws(() => verifyTimestampReceipt({ digest: "a".repeat(64), directory: root }));
});

test("timestamp client sends only a digest query and rejects non-timestamp HTTP output", async () => {
  const root = temp();
  let sent;
  await assert.rejects(() => timestampDigest({ digest: "a".repeat(64), directory: root, fetchImpl: async (url, request) => {
    sent = { url, request };
    return new Response("not a timestamp", { status: 200, headers: { "content-type": "text/html" } });
  } }), /timestamp/);
  assert.equal(sent.url, "https://freetsa.org/tsr");
  assert.equal(sent.request.method, "POST");
  assert.ok(Buffer.isBuffer(sent.request.body));
  assert.ok(sent.request.body.length < 1024);
  assert.equal(sent.request.body.includes(Buffer.from("candidate_digest")), false);
});

test("registry refuses an unanchored registration as a manifest predecessor", async () => {
  const root = temp();
  const anchors = temp();
  const receipt = appendRegistryEntry(root, { kind: "candidate-registration", candidate: {} });
  const registry = createAnchoredRegistry({ directory: root, anchorRoot: anchors, environmentDigest: "a".repeat(64), verifierDigest: "b".repeat(64) });
  await assert.rejects(() => registry.commitManifest({ candidate_registration: receipt, manifest_digest: "c".repeat(64), commitment: "d".repeat(64) }));
  assert.equal(readRegistry(root).length, 1);
});

test("verifies a real third-party timestamp offline and rejects a forged local imprint", () => {
  const root = temp();
  for (const name of ["request.tsq", "response.tsr", "authority.json"]) {
    copyFileSync(fileURLToPath(new URL(`./fixtures/timestamp-v1/${name}`, import.meta.url)), join(root, name));
  }
  const authority = JSON.parse(readFileSync(join(root, "authority.json"), "utf8"));
  const proof = verifyTimestampReceipt({ digest: authority.digest, directory: root });
  assert.equal(proof.signed_at, "2026-09-05T23:01:06.000Z");
  assert.throws(() => verifyTimestampReceipt({ digest: authority.digest, directory: root, notAfterMs: Date.parse("2026-09-05T23:01:05Z") }), /postdates/);
  authority.digest = "b".repeat(64);
  writeFileSync(join(root, "authority.json"), JSON.stringify(authority));
  assert.throws(() => verifyTimestampReceipt({ digest: authority.digest, directory: root }), /openssl/);
});
