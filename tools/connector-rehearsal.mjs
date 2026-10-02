#!/usr/bin/env node

/**
 * Prepares and checks the local-only filesystem boundary for connector rehearsal.
 * `prepare` and `preflight` never start an Authority, open a network connection,
 * or read credential files. Lifecycle actions dispatch through the compiled,
 * isolated Authority runtime; only OIDC's non-secret configuration metadata is
 * read here to determine whether a client-secret file is needed.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, parse as parsePath, resolve, sep } from "node:path";

const CONFIG_NAME = "connector-rehearsal.json";
const MARKER_NAME = ".echo-connector-rehearsal-v1.json";
const KIND = "echo-connector-rehearsal-config-v1";
const MARKER_KIND = "echo-connector-rehearsal-root-v1";
const STATUS_KIND = "echo-connector-rehearsal-status-v1";
const PRIVATE_FILES = Object.freeze({
  oidc_config: "oidc-config.json",
  oidc_client_secret: "oidc-client-secret",
  nango_secret_key: "nango-secret-key",
  granola_credential: "granola-organization-key",
  granola_owner_email: "granola-owner-email",
  openrouter_credential: "openrouter-credential",
});
const FORBIDDEN_ORIGINS = new Set([
  "https://authority-staging.echobrain.org",
  "https://authority.echobrain.org",
]);
const UID = process.getuid();
const MAX_PRIVATE_FILE_BYTES = 64 * 1024;
const MAX_OIDC_BYTES = 64 * 1024;

class RehearsalValidationError extends Error {}

function fail(message) {
  throw new RehearsalValidationError(message);
}

function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === parsePath(value).root) {
    fail(`${label} must be an absolute canonical path`);
  }
  return value;
}

function mode(value) {
  return statSync(value).mode & 0o777;
}

function assertNoSymlinkPath(value, label) {
  const absolute = canonicalAbsolutePath(value, label);
  const root = parsePath(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = current === root ? `${root}${part}` : `${current}${sep}${part}`;
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) fail(`${label} must not contain symbolic links`);
  }
  return absolute;
}

function assertDirectory(value, label) {
  assertNoSymlinkPath(value, label);
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.uid !== UID || mode(value) !== 0o700) {
    fail(`${label} must be owned 0700 directory`);
  }
}

function assertPrivateRegularFile(value, label, maximum = MAX_PRIVATE_FILE_BYTES) {
  assertNoSymlinkPath(value, label);
  const metadata = lstatSync(value);
  if (!metadata.isFile() || metadata.uid !== UID || mode(value) !== 0o600 ||
      metadata.size === 0 || metadata.size > maximum) {
    fail(`${label} is not a current-user 0600 bounded regular file`);
  }
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join(",") !== expected.join(",")) fail(`${label} has an unexpected shape`);
  return value;
}

function text(value, label, maximum = 2048) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\u0000")) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requiredText(value, label, maximum = 2048) {
  const result = text(value, label, maximum);
  if (result.trim() === "") fail(`${label} is missing`);
  return result;
}

function oidcText(value, label, maximum) {
  const result = requiredText(value, label, maximum);
  if (/[\u0000-\u001f\u007f]/.test(result)) fail(`${label} is invalid`);
  return result;
}

function integrationKey(value, label) {
  const result = requiredText(value, label, 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) fail(`${label} is invalid`);
  return result;
}

function privatePath(root, value, label) {
  const result = canonicalAbsolutePath(text(value, label), label);
  const privateDirectory = `${root}${sep}private`;
  if (dirname(result) !== privateDirectory) fail(`${label} must be directly inside the rehearsal private directory`);
  return result;
}

function authorityUrl(value) {
  const raw = requiredText(value, "authority_url");
  let url;
  try { url = new URL(raw); } catch { fail("authority_url is invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw !== url.origin ||
      host === "localhost" || host === "::1" || host === "[::1]" || isPrivateIpv4(host) ||
      FORBIDDEN_ORIGINS.has(url.origin)) fail("authority_url is not a permitted rehearsal origin");
  return url.origin;
}

function isPrivateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function missingInput(value, name, result) {
  if (typeof value !== "string" || value.trim() === "") result.push(name);
}

function expectedPersonEmail(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 254 ||
      value !== value.trim() || value !== value.toLowerCase() ||
      !/^[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) return false;
  const [local, domain] = value.split("@");
  return local !== undefined && domain !== undefined && local.length <= 64 && domain.length <= 253 &&
    domain.split(".").every(label => label.length <= 63);
}

function pathEntryExists(value, label) {
  try { lstatSync(value); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    fail(`${label} cannot be inspected`);
  }
}

function configTemplate(root) {
  const privateDirectory = `${root}${sep}private`;
  return {
    schema_version: 1,
    kind: KIND,
    authority_url: "",
    organization_name: "",
    owner_name: "",
    owner_email: "",
    oidc: {
      config_file: `${privateDirectory}${sep}${PRIVATE_FILES.oidc_config}`,
      client_secret_file: null,
    },
    nango: {
      secret_key_file: `${privateDirectory}${sep}${PRIVATE_FILES.nango_secret_key}`,
      slack_integration_key: "slack",
      jira_integration_key: "jira",
    },
    jira: { cloud_id: "", project: "" },
    granola: {
      credential_file: `${privateDirectory}${sep}${PRIVATE_FILES.granola_credential}`,
      owner_email_file: `${privateDirectory}${sep}${PRIVATE_FILES.granola_owner_email}`,
    },
    openrouter: { credential_file: `${privateDirectory}${sep}${PRIVATE_FILES.openrouter_credential}` },
  };
}

function marker(root) {
  return { schema_version: 1, kind: MARKER_KIND, root, uid: UID };
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function rootPaths(root) {
  return Object.freeze({
    root,
    marker: `${root}${sep}${MARKER_NAME}`,
    config: `${root}${sep}${CONFIG_NAME}`,
    state: `${root}${sep}state`,
    person: `${root}${sep}person`,
    private: `${root}${sep}private`,
    receipts: `${root}${sep}receipts`,
  });
}

function readJson(path, label, maximum = MAX_PRIVATE_FILE_BYTES) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { fail(`${label} must be readable JSON`); }
  if (Buffer.byteLength(raw, "utf8") > maximum) fail(`${label} exceeds its bound`);
  try { return JSON.parse(raw); } catch { fail(`${label} must be readable JSON`); }
}

function readConfiguration(root) {
  const paths = rootPaths(root);
  assertPrivateRegularFile(paths.marker, "rehearsal marker");
  const rootMarker = exactRecord(readJson(paths.marker, "rehearsal marker"), ["schema_version", "kind", "root", "uid"], "rehearsal marker");
  if (rootMarker.schema_version !== 1 || rootMarker.kind !== MARKER_KIND || rootMarker.root !== root || rootMarker.uid !== UID) {
    fail("rehearsal marker does not bind this root");
  }
  assertPrivateRegularFile(paths.config, "rehearsal configuration");
  const config = exactRecord(readJson(paths.config, "rehearsal configuration"), [
    "schema_version", "kind", "authority_url", "organization_name", "owner_name", "owner_email",
    "oidc", "nango", "jira", "granola", "openrouter",
  ], "rehearsal configuration");
  if (config.schema_version !== 1 || config.kind !== KIND) fail("rehearsal configuration version is invalid");
  exactRecord(config.oidc, ["config_file", "client_secret_file"], "OIDC configuration reference");
  exactRecord(config.nango, ["secret_key_file", "slack_integration_key", "jira_integration_key"], "Nango configuration reference");
  exactRecord(config.jira, ["cloud_id", "project"], "Jira configuration reference");
  exactRecord(config.granola, ["credential_file", "owner_email_file"], "Granola configuration reference");
  exactRecord(config.openrouter, ["credential_file"], "OpenRouter configuration reference");
  for (const [value, label] of [
    [config.oidc.config_file, "oidc.config_file"], [config.nango.secret_key_file, "nango.secret_key_file"],
    [config.granola.credential_file, "granola.credential_file"], [config.granola.owner_email_file, "granola.owner_email_file"],
    [config.openrouter.credential_file, "openrouter.credential_file"],
  ]) privatePath(root, value, label);
  if (config.oidc.client_secret_file !== null) privatePath(root, config.oidc.client_secret_file, "oidc.client_secret_file");
  return config;
}

function readOidcConfiguration(path, authority) {
  assertPrivateRegularFile(path, "OIDC configuration", MAX_OIDC_BYTES);
  const record = exactRecord(readJson(path, "OIDC configuration", MAX_OIDC_BYTES), [
    "issuer", "client_id", "redirect_uri", "tenant", "id_token_algorithms", "client_authentication",
  ], "OIDC configuration");
  let issuer;
  try { issuer = new URL(oidcText(record.issuer, "OIDC issuer", 2048)); } catch { fail("OIDC issuer must be an absolute HTTPS URL"); }
  if (issuer.protocol !== "https:" || issuer.username !== "" || issuer.password !== "" ||
      issuer.hash !== "" || issuer.search !== "" ||
      (record.issuer !== issuer.origin && record.issuer !== issuer.href)) {
    fail("OIDC issuer must be an absolute HTTPS URL");
  }
  oidcText(record.client_id, "OIDC client ID", 1024);
  if (record.tenant === null || typeof record.tenant !== "object" || Array.isArray(record.tenant)) {
    fail("OIDC tenant constraint is invalid");
  }
  if (record.tenant.kind === "issuer") {
    exactRecord(record.tenant, ["kind"], "OIDC tenant constraint");
  } else if (record.tenant.kind === "claim") {
    const tenant = exactRecord(record.tenant, ["kind", "claim_name", "claim_value"], "OIDC tenant constraint");
    oidcText(tenant.claim_name, "OIDC tenant claim name", 200);
    oidcText(tenant.claim_value, "OIDC tenant claim value", 1024);
  } else fail("OIDC tenant constraint is invalid");
  if (!Array.isArray(record.id_token_algorithms) || record.id_token_algorithms.length === 0 ||
      new Set(record.id_token_algorithms).size !== record.id_token_algorithms.length) fail("OIDC id-token algorithms are invalid");
  for (const algorithm of record.id_token_algorithms) {
    if (oidcText(algorithm, "OIDC id-token algorithm", 100) === "none") fail("OIDC id-token algorithms are invalid");
  }
  if (!["none", "client_secret_basic", "client_secret_post"].includes(record.client_authentication)) {
    fail("OIDC client authentication is invalid");
  }
  if (record.redirect_uri !== `${authority}/v2/session/oidc/callback`) fail("OIDC redirect URI differs from authority_url");
  return record.client_authentication;
}

function assertRehearsalRoot(root) {
  const paths = rootPaths(root);
  assertDirectory(paths.root, "rehearsal root");
  for (const path of [paths.person, paths.private, paths.receipts]) assertDirectory(path, "rehearsal directory");
  if (pathEntryExists(paths.state, "rehearsal state directory")) fail("rehearsal state directory must remain absent before bootstrap");
  return paths;
}

function assertExecutionRoot(root) {
  const paths = rootPaths(root);
  assertDirectory(paths.root, "rehearsal root");
  for (const path of [paths.person, paths.private, paths.receipts]) assertDirectory(path, "rehearsal directory");
  return paths;
}

function inputFileReady(path) {
  try { assertPrivateRegularFile(path, "private input"); return true; } catch { return false; }
}

export function prepare(directory) {
  const root = assertNoSymlinkPath(directory, "rehearsal directory");
  if (existsSync(root)) fail("rehearsal directory must be new");
  const parent = dirname(root);
  if (!existsSync(parent)) fail("rehearsal directory parent must exist");
  assertNoSymlinkPath(parent, "rehearsal directory parent");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const paths = rootPaths(root);
  for (const path of [paths.person, paths.private, paths.receipts]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  writePrivateJson(paths.marker, marker(root));
  writePrivateJson(paths.config, configTemplate(root));
  return Object.freeze({ schema_version: 1, kind: STATUS_KIND, status: "prepared", directory: root, qualified: false });
}

export function preflight(directory) {
  const root = assertNoSymlinkPath(directory, "rehearsal directory");
  const paths = assertRehearsalRoot(root);
  const config = readConfiguration(root);
  const missing = [];
  for (const [value, name] of [
    [config.authority_url, "authority_url"], [config.organization_name, "organization_name"],
    [config.owner_name, "owner_name"], [config.owner_email, "owner_email"],
    [config.jira.cloud_id, "jira.cloud_id"], [config.jira.project, "jira.project"],
  ]) missingInput(value, name, missing);
  let authority;
  if (!missing.includes("authority_url")) authority = authorityUrl(config.authority_url);
  if (!missing.includes("organization_name")) requiredText(config.organization_name, "organization_name", 256);
  if (!missing.includes("owner_name")) requiredText(config.owner_name, "owner_name", 256);
  if (!missing.includes("owner_email") && !expectedPersonEmail(config.owner_email)) fail("owner_email is invalid");
  if (!missing.includes("jira.cloud_id") && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.jira.cloud_id)) fail("jira.cloud_id is invalid");
  if (!missing.includes("jira.project") && !/^[A-Z][A-Z0-9_]{1,31}$/.test(config.jira.project)) fail("jira.project is invalid");
  integrationKey(config.nango.slack_integration_key, "nango.slack_integration_key");
  integrationKey(config.nango.jira_integration_key, "nango.jira_integration_key");
  const fileInputs = [
    [config.oidc.config_file, "oidc.config_file"], [config.nango.secret_key_file, "nango.secret_key_file"],
    [config.granola.credential_file, "granola.credential_file"], [config.granola.owner_email_file, "granola.owner_email_file"],
    [config.openrouter.credential_file, "openrouter.credential_file"],
  ];
  for (const [path, name] of fileInputs) if (!inputFileReady(path)) missing.push(name);
  if (!missing.includes("oidc.config_file") && authority !== undefined) {
    const authentication = readOidcConfiguration(config.oidc.config_file, authority);
    if (authentication === "none") {
      if (config.oidc.client_secret_file !== null) fail("OIDC client secret file is forbidden for client_authentication none");
    } else if (config.oidc.client_secret_file === null || !inputFileReady(config.oidc.client_secret_file)) {
      missing.push("oidc.client_secret_file");
    }
  }
  const uniqueMissing = [...new Set(missing)].sort();
  return Object.freeze({
    schema_version: 1,
    kind: STATUS_KIND,
    status: uniqueMissing.length === 0 ? "configuration_ready" : "prepared",
    directory: paths.root,
    qualified: false,
    missing_inputs: uniqueMissing,
  });
}

/**
 * The lifecycle runner receives only this marker-bound root and its nonsecret
 * configuration references. It owns the post-bootstrap state/lineage fence,
 * so this deliberately permits a state directory after bootstrap.
 */
export function readExecutionConfiguration(directory) {
  const root = assertNoSymlinkPath(directory, "rehearsal directory");
  const paths = assertExecutionRoot(root);
  const configuration = readConfiguration(root);
  return Object.freeze({
    directory: root,
    paths,
    configuration: Object.freeze(configuration),
  });
}

function usage() {
  return "usage: node tools/connector-rehearsal.mjs <prepare|preflight|bootstrap|credentials-install|finalize|serve|capture|cycle-once|person> --directory <absolute-path> [--tool <granola|jira> --limit <1..5>|-- <person arguments>]";
}

function parseCli(argv) {
  const action = argv[0];
  if (action === "prepare" || action === "preflight" ||
      action === "bootstrap" || action === "credentials-install" || action === "finalize" ||
      action === "serve" || action === "cycle-once") {
    if (argv.length !== 3 || argv[1] !== "--directory") fail(usage());
    return Object.freeze({ action, directory: canonicalAbsolutePath(argv[2], "rehearsal directory") });
  }
  if (action === "capture") {
    if (argv.length !== 7 || argv[1] !== "--directory" || argv[3] !== "--tool" || argv[5] !== "--limit" ||
        !["granola", "jira"].includes(argv[4]) || !/^[1-5]$/.test(argv[6])) fail(usage());
    return Object.freeze({
      action,
      directory: canonicalAbsolutePath(argv[2], "rehearsal directory"),
      argv: Object.freeze(["--tool", argv[4], "--limit", argv[6]]),
    });
  }
  if (action === "person") {
    if (argv.length < 5 || argv[1] !== "--directory" || argv[3] !== "--") fail(usage());
    return Object.freeze({
      action,
      directory: canonicalAbsolutePath(argv[2], "rehearsal directory"),
      argv: Object.freeze(argv.slice(4)),
    });
  }
  fail(usage());
}

async function runAuthorityLifecycle(input) {
  const execution = readExecutionConfiguration(input.directory);
  const runtime = await import("../services/organization-authority/dist/composition/connector-rehearsal-runtime-v1.js");
  let accessToken;
  if (input.action === "capture" || input.action === "cycle-once") {
    const { PersonSessionStore } = await import("../src/product/person-client/dist/session-store.js");
    const stored = new PersonSessionStore(execution.paths.person).read();
    if (stored.authority_origin !== execution.configuration.authority_url) {
      fail("rehearsal Person session does not match authority_url");
    }
    const accessExpiresAt = Date.parse(stored.session.access_expires_at);
    if (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= Date.now()) {
      fail("rehearsal Person session access is expired; run an authenticated Person command through this rehearsal and retry");
    }
    accessToken = stored.session.access_token;
  }
  return runtime.runConnectorRehearsalV1({
    action: input.action,
    directory: execution.directory,
    configuration: execution.configuration,
    ...(input.argv === undefined ? {} : { argv: input.argv }),
    ...(accessToken === undefined ? {} : { access_token: accessToken }),
  });
}

async function runPersonCommand(input) {
  const execution = readExecutionConfiguration(input.directory);
  const person = await import("../src/product/person-client/dist/composition.js");
  return person.runPersonClientCli(input.argv, { home_directory: execution.paths.person });
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseCli(argv);
  if (input.action === "prepare" || input.action === "preflight") {
    const result = input.action === "prepare" ? prepare(input.directory) : preflight(input.directory);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (input.action === "person") return runPersonCommand(input);
  return runAuthorityLifecycle(input);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  void main().then(
    exitCode => { process.exitCode = exitCode; },
    error => { process.stderr.write(`${error instanceof RehearsalValidationError ? error.message : "connector rehearsal failed"}\n`); process.exitCode = 1; },
  );
}
