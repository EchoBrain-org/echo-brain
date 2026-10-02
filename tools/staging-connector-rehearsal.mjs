#!/usr/bin/env node

/**
 * Mac-side client for one bounded staging connector observation. It reads the
 * current installed Person session only through the Person client, keeps the
 * bearer inside its bounded transport, and prints a validated receipt only.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";

const STAGING_ORIGIN = "https://authority-staging.echobrain.org";
const MAX_PROFILE_BYTES = 64 * 1024;

class StagingConnectorRehearsalError extends Error {}

function fail(message = "Staging connector rehearsal failed") {
  throw new StagingConnectorRehearsalError(message);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
    fail(`${label} must be an absolute canonical path`);
  }
  return value;
}

function profileFile(path) {
  const result = absolutePath(path, "profile");
  let metadata;
  try { metadata = lstatSync(result); } catch { fail("profile is unavailable"); }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0 || metadata.size > MAX_PROFILE_BYTES) {
    fail("profile is invalid");
  }
  let value;
  try { value = JSON.parse(readFileSync(result, "utf8")); } catch { fail("profile is invalid"); }
  return value;
}

function inputUrl(input) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  if (input !== null && typeof input === "object" && typeof input.url === "string") return new URL(input.url);
  fail();
}

function guardedFetch(fetchImplementation) {
  return async (input, init) => {
    if (inputUrl(input).origin !== STAGING_ORIGIN) fail();
    return fetchImplementation(input, { ...init, redirect: "error" });
  };
}

function assertOwnerSession(stored, descriptor) {
  if (stored.authority_origin !== STAGING_ORIGIN || stored.session.membership_type !== "owner" ||
      descriptor.authority_descriptor.authority_id !== stored.authority_id ||
      descriptor.authority_descriptor.organization_id !== stored.session.organization_id) fail();
}

function matchingResponse(response, request) {
  if (response.release_id !== request.release_id || response.profile_sha256 !== request.profile_sha256 ||
      response.action !== request.action ||
      (request.action === "capture" && response.tool !== request.tool)) fail();
  if (request.action === "capture" && response.receipt.counts.captured > request.limit) fail();
  return response;
}

async function dependencies() {
  const [contract, federation, client, store, authority] = await Promise.all([
    import("../services/organization-authority/dist/composition/staging-connector-rehearsal-protocol-v1.js"),
    import("@echo-brain/federation-protocol"),
    import("../src/product/person-client/dist/client.js"),
    import("../src/product/person-client/dist/session-store.js"),
    import("../src/product/person-client/dist/authority-client.js"),
  ]);
  return { contract, federation, client, store, authority };
}

/**
 * This function is exported for synthetic transport tests. The only optional
 * dependency is fetch; it remains guarded to the fixed staging origin.
 */
export async function runStagingConnectorRehearsal(input, options = {}) {
  try {
    if (input === null || typeof input !== "object") fail();
    if (input.action !== "status" && input.action !== "capture") fail();
    const { contract, federation, client, store, authority } = await dependencies();
    const profile = contract.validateStagingConnectorRehearsalProfileV1(profileFile(input.profile_path));
    const releaseId = input.release_id;
    const request = contract.validateStagingConnectorRehearsalRequestV1(
      input.action === "status"
        ? { schema_version: 1, release_id: releaseId, profile_sha256: federation.canonicalSha256(profile), action: "status" }
        : { schema_version: 1, release_id: releaseId, profile_sha256: federation.canonicalSha256(profile), action: "capture", tool: input.tool, limit: input.limit },
    );
    const personHome = absolutePath(input.person_home ?? homedir(), "person home");
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") fail();
    const fetch = guardedFetch(fetchImplementation);
    const sessions = new store.PersonSessionStore(personHome);
    const before = sessions.read();
    if (before.authority_origin !== STAGING_ORIGIN || before.session.membership_type !== "owner") fail();
    const descriptor = await new authority.PersonAuthorityClient({ authority_origin: STAGING_ORIGIN, fetch }).descriptor();
    assertOwnerSession(before, descriptor);
    const person = new client.PersonClient({ home_directory: personHome, fetch });
    const response = await person.withToolSession(async session => {
      if (session.identity.organization_id !== before.session.organization_id || session.identity.membership_id !== before.session.membership_id) fail();
      return session.transport.json({
        path: contract.STAGING_CONNECTOR_REHEARSAL_PATH_V1,
        body: request,
        validate_request: contract.validateStagingConnectorRehearsalRequestV1,
        validate_response: contract.validateStagingConnectorRehearsalResponseV1,
        maximum_response_bytes: 64 * 1024,
        timeout_ms: 75_000,
      });
    });
    assertOwnerSession(sessions.read(), descriptor);
    return matchingResponse(response, request);
  } catch (error) {
    if (error instanceof StagingConnectorRehearsalError) throw error;
    fail();
  }
}

function usage() {
  return "usage: node tools/staging-connector-rehearsal.mjs <status|capture> --release-id <clean-v1-release> --profile <absolute-local-profile-json> [--person-home <absolute-home>] [--tool <granola|jira> --limit <1..5>]";
}

function parseCli(argv) {
  const action = argv[0];
  const expected = action === "status" ? 5 : action === "capture" ? 9 : 0;
  const personHomeOffset = action === "status" ? 5 : 9;
  const withPersonHome = argv.length === expected + 2 && argv[personHomeOffset] === "--person-home";
  if ((argv.length !== expected && !withPersonHome) || argv[1] !== "--release-id" || argv[3] !== "--profile") fail(usage());
  const base = {
    action,
    release_id: argv[2],
    profile_path: absolutePath(argv[4], "profile"),
    ...(withPersonHome ? { person_home: absolutePath(argv[personHomeOffset + 1], "person home") } : {}),
  };
  if (action === "status") return Object.freeze(base);
  if (argv[5] !== "--tool" || argv[7] !== "--limit" || !["granola", "jira"].includes(argv[6]) || !/^[1-5]$/.test(argv[8])) fail(usage());
  return Object.freeze({ ...base, tool: argv[6], limit: Number(argv[8]) });
}

export async function main(argv = process.argv.slice(2)) {
  const receipt = await runStagingConnectorRehearsal(parseCli(argv));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  void main().then(
    code => { process.exitCode = code; },
    error => { process.stderr.write(`${error instanceof StagingConnectorRehearsalError ? error.message : "Staging connector rehearsal failed"}\n`); process.exitCode = 1; },
  );
}
