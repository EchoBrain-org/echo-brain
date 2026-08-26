#!/usr/bin/env node

/**
 * A deliberately local-only Authority exercise harness.
 *
 * It never consumes the deployment environment file or provider credentials.
 * The compose profile itself is byte-bound to a release profile, therefore this
 * tool writes a separate overlay below a sentinel-owned state directory rather
 * than changing the deployment profile for developer convenience.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TOOL_KIND = "echo-authority-local-v1";
const SENTINEL = ".echo-authority-local-v1.json";
const TUPLE = ".echo-authority-local-v1.tuple.json";
const REPO = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const DEPLOYMENT = resolve(REPO, "deploy", "organization-authority");
const BASE_COMPOSE = resolve(DEPLOYMENT, "compose.clean-v1.yaml");
const PRODUCTION_DATA = resolve(DEPLOYMENT, "clean-data");
const PRODUCTION_ROOT = "/srv/echo-authority-clean-v1";
const CADDY_IMAGE =
  "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";

function fail(message) {
  throw new Error(`authority-local: ${message}`);
}

export function canonicalWorktreeId(repo = REPO) {
  return createHash("sha256").update(repo, "utf8").digest("hex").slice(0, 16);
}

function localSourceRevision(repo = REPO) {
  return createHash("sha256")
    .update(`local-nonreleasable:${repo}`, "utf8")
    .digest("hex")
    .slice(0, 40);
}

export function localProjectName(
  repo = REPO,
  uid = process.getuid?.() ?? 0,
  state = defaultStateDirectory(repo),
) {
  const stateId = createHash("sha256")
    .update(state, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `echo_authority_local_${String(uid)}_${canonicalWorktreeId(repo)}_${stateId}`;
}

function defaultStateDirectory(repo = REPO) {
  const root = process.env.XDG_STATE_HOME;
  const parent =
    root !== undefined && isAbsolute(root)
      ? root
      : join(homedir(), ".local", "state");
  return join(
    parent,
    "echo-brain",
    "authority-local",
    canonicalWorktreeId(repo),
  );
}

function pathWithin(candidate, parent) {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function existingAncestor(path) {
  let cursor = path;
  for (;;) {
    if (existsSync(cursor)) return cursor;
    const next = dirname(cursor);
    if (next === cursor) return cursor;
    cursor = next;
  }
}

function canonicalExistingPath(path) {
  const ancestor = existingAncestor(path);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function assertNoSymlinkPath(path) {
  const ancestor = existingAncestor(path);
  if (lstatSync(ancestor).isSymbolicLink()) {
    fail(`state path contains a symlink: ${ancestor}`);
  }
  const pieces = relative(ancestor, path).split(sep).filter(Boolean);
  let cursor = ancestor;
  for (const piece of pieces) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      fail(`state path contains a symlink: ${cursor}`);
    cursor = join(cursor, piece);
  }
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
    fail(`state path contains a symlink: ${cursor}`);
  }
}

function expectedSentinel({
  repo = REPO,
  uid = process.getuid?.() ?? 0,
  state,
}) {
  return {
    kind: TOOL_KIND,
    repository: repo,
    state_directory: state,
    uid,
  };
}

/** Exported for focused safety tests. */
export function validateStateDirectory(input, options = {}) {
  const repo = options.repo ?? REPO;
  const productionData = options.productionData ?? PRODUCTION_DATA;
  const requested = input ?? defaultStateDirectory(repo);
  if (!isAbsolute(requested)) fail("--state-dir must be an absolute path");
  const lexicalState = resolve(requested);
  assertNoSymlinkPath(lexicalState);
  const state = canonicalExistingPath(lexicalState);
  const repoReal = realpathSync(repo);
  const productionDataReal = canonicalExistingPath(productionData);
  if (
    state === sep ||
    state === repoReal ||
    pathWithin(state, repoReal) ||
    state === productionDataReal ||
    pathWithin(state, PRODUCTION_ROOT)
  ) {
    fail(
      "state directory must be outside this repository and the production deployment path",
    );
  }
  return state;
}

function assertOwner(path, label) {
  const details = statSync(path);
  if (
    details.uid !== (process.getuid?.() ?? 0) ||
    details.gid !== (process.getgid?.() ?? 0)
  ) {
    fail(`${label} must be owned by the current user and group: ${path}`);
  }
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function assertRegularFile(path, mode, label) {
  const details = lstatIfExists(path);
  if (details === undefined || details.isSymbolicLink() || !details.isFile()) {
    fail(`${label} must be a regular non-symlink file: ${path}`);
  }
  if ((details.mode & 0o777) !== mode)
    fail(`${label} has unsafe mode: ${path}`);
  assertOwner(path, label);
}

function assertDirectory(path, mode, label) {
  const details = lstatIfExists(path);
  if (
    details === undefined ||
    details.isSymbolicLink() ||
    !details.isDirectory()
  ) {
    fail(
      `${label} must be a directory, not a symlink or special node: ${path}`,
    );
  }
  if ((details.mode & 0o777) !== mode)
    fail(`${label} has unsafe mode: ${path}`);
  assertOwner(path, label);
}

function assertSafeTree(path, label) {
  const details = lstatIfExists(path);
  if (details === undefined) return;
  if (
    details.isSymbolicLink() ||
    (!details.isDirectory() && !details.isFile())
  ) {
    fail(`${label} contains a symlink or special node: ${path}`);
  }
  if (details.isDirectory()) {
    for (const name of readdirSync(path))
      assertSafeTree(join(path, name), label);
  }
}

function assertOwnedState(state, { create }) {
  const wanted = expectedSentinel({ state });
  if (!existsSync(state)) {
    if (!create) fail(`state directory does not exist: ${state}`);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    chownSync(state, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    chmodSync(state, 0o700);
    writeFileSync(join(state, SENTINEL), `${JSON.stringify(wanted)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chownSync(
      join(state, SENTINEL),
      process.getuid?.() ?? 0,
      process.getgid?.() ?? 0,
    );
    assertOwner(state, "state directory");
    assertOwner(join(state, SENTINEL), "state sentinel");
    return;
  }
  const metadataPath = join(state, SENTINEL);
  if (lstatIfExists(metadataPath) === undefined) {
    fail(`refusing unowned state directory: ${state}`);
  }
  assertDirectory(state, 0o700, "state directory");
  assertRegularFile(metadataPath, 0o600, "state sentinel");
  let actual;
  try {
    actual = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    fail(`state sentinel is not valid JSON: ${metadataPath}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`state sentinel does not belong to this worktree and user: ${state}`);
  }
}

function choosePorts(project) {
  const digest = createHash("sha256").update(project, "utf8").digest();
  const base = 42000 + (digest.readUInt16BE(0) % 8000) * 2;
  const configuredHttp = process.env.ECHO_LOCAL_AUTHORITY_HTTP_PORT;
  const configuredHttps = process.env.ECHO_LOCAL_AUTHORITY_HTTPS_PORT;
  const http = configuredHttp === undefined ? base : Number(configuredHttp);
  const https =
    configuredHttps === undefined ? base + 1 : Number(configuredHttps);
  for (const [name, port] of [
    ["HTTP", http],
    ["HTTPS", https],
  ]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      fail(`${name} port must be an available high TCP port`);
    }
  }
  if (http === https) fail("HTTP and HTTPS ports must differ");
  return { http, https };
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
  });
  if (result.error !== undefined)
    fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `${command} ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout ?? "";
}

function portIsFree(port) {
  const script = [
    "const net = require('node:net');",
    "const port = Number(process.argv[1]);",
    "const server = net.createServer();",
    "server.once('error', () => process.exit(1));",
    "server.listen(port, '127.0.0.1', () => server.close(() => process.exit(0)));",
  ].join(" ");
  const result = spawnSync(process.execPath, ["-e", script, String(port)], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function assertPortsFree(ports) {
  for (const port of [ports.http, ports.https]) {
    if (!portIsFree(port))
      fail(
        `loopback TCP port ${String(port)} is unavailable; choose another before Docker is changed`,
      );
  }
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

/** Exported for focused profile-isolation tests. */
export function localOverlay({ state, ports, localSource }) {
  return `# Generated by tools/authority-local.mjs. Do not edit.\nservices:\n  authority:\n    build:\n      args:\n        ECHO_SOURCE_SHA: ${yamlScalar(localSource)}\n    volumes: !override\n      - ${yamlScalar(`${state}:/echo-clean`)}\n    ports: !override\n      - ${yamlScalar(`127.0.0.1:${String(ports.http)}:80`)}\n      - ${yamlScalar(`127.0.0.1:${String(ports.https)}:443`)}\n`;
}

function localEnvironment({
  project,
  ports,
  state,
  image,
  releaseId,
  runtimeProfileSha256,
}) {
  return {
    ECHO_CLEAN_AUTHORITY_GID: String(process.getgid?.() ?? 0),
    ECHO_CLEAN_AUTHORITY_HOST: "localhost",
    ECHO_CLEAN_AUTHORITY_IMAGE: image,
    ECHO_CLEAN_AUTHORITY_UID: String(process.getuid?.() ?? 0),
    ECHO_CLEAN_RELEASE_ID: releaseId,
    ECHO_CLEAN_RUNTIME_PROFILE_SHA256: runtimeProfileSha256,
    ECHO_LOCAL_AUTHORITY_HTTP_PORT: String(ports.http),
    ECHO_LOCAL_AUTHORITY_HTTPS_PORT: String(ports.https),
    ECHO_LOCAL_AUTHORITY_PROJECT: project,
    ECHO_LOCAL_AUTHORITY_STATE_DIR: state,
  };
}

function inputFor(values) {
  return {
    image: values.image,
    ports: values.ports,
    release_id: values.releaseId,
    runtime_profile_sha256: values.runtimeProfileSha256,
    source_revision: values.sourceRevision,
  };
}

function inputBytes(values) {
  return `${JSON.stringify(inputFor(values))}\n`;
}

function tuplePath(state) {
  return join(state, TUPLE);
}

function writeTuple(state, values) {
  const path = tuplePath(state);
  if (lstatIfExists(path) !== undefined) fail(`tuple already exists: ${path}`);
  writeFileSync(path, inputBytes(values), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  assertRegularFile(path, 0o600, "local tuple");
}

function readTuple(state) {
  const path = tuplePath(state);
  assertRegularFile(path, 0o600, "local tuple");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`local tuple is not valid JSON: ${path}`);
  }
}

function assertTuple(values, state) {
  if (JSON.stringify(readTuple(state)) !== JSON.stringify(inputFor(values))) {
    fail(
      "complete synthetic state belongs to a different tuple; run reset before changing it",
    );
  }
}

function valuesFromInput(state, input) {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.image !== "string" ||
    typeof input.release_id !== "string" ||
    typeof input.runtime_profile_sha256 !== "string" ||
    typeof input.source_revision !== "string" ||
    input.ports === null ||
    typeof input.ports !== "object" ||
    !Number.isInteger(input.ports.http) ||
    !Number.isInteger(input.ports.https)
  ) {
    fail("local tuple has an invalid shape");
  }
  return {
    image: input.image,
    noBuild: true,
    ports: { http: input.ports.http, https: input.ports.https },
    project: localProjectName(REPO, process.getuid?.() ?? 0, state),
    releaseId: input.release_id,
    runtimeProfileSha256: input.runtime_profile_sha256,
    sourceRevision: input.source_revision,
    state,
  };
}

function tupleArgumentsProvided(requested) {
  return (
    requested.image !== undefined ||
    requested.releaseId !== undefined ||
    requested.runtimeProfileSha256 !== undefined ||
    requested.sourceRevision !== undefined ||
    requested.noBuild ||
    process.env.ECHO_LOCAL_AUTHORITY_HTTP_PORT !== undefined ||
    process.env.ECHO_LOCAL_AUTHORITY_HTTPS_PORT !== undefined
  );
}

function writeOverlay(state, values) {
  const generated = join(state, "generated");
  if (lstatIfExists(generated) !== undefined) {
    assertDirectory(
      generated,
      0o700,
      "generated local configuration directory",
    );
  } else {
    mkdirSync(generated, { recursive: false, mode: 0o700 });
  }
  chmodSync(generated, 0o700);
  assertDirectory(generated, 0o700, "generated local configuration directory");
  const overlay = join(generated, "compose.local.yaml");
  const input = join(generated, "local-input.json");
  const existing = [overlay, input].map(lstatIfExists);
  for (const [index, path] of [overlay, input].entries()) {
    const details = existing[index];
    if (
      details !== undefined &&
      (details.isSymbolicLink() || !details.isFile())
    ) {
      fail(`generated local configuration has an unsafe entry: ${path}`);
    }
  }
  if (existing[0] !== undefined || existing[1] !== undefined) {
    if (existing[0] === undefined || existing[1] === undefined) {
      fail(
        "generated local configuration is incomplete; run reset rather than replacing it",
      );
    }
    return assertGenerated(values, state);
  }
  writeFileSync(
    overlay,
    localOverlay({
      state,
      ports: values.ports,
      localSource: values.sourceRevision,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(input, inputBytes(values), { encoding: "utf8", mode: 0o600 });
  assertRegularFile(overlay, 0o600, "generated local Compose overlay");
  assertRegularFile(input, 0o600, "generated local input record");
  return overlay;
}

function assertGenerated(values, state) {
  const generated = join(state, "generated");
  const overlay = join(generated, "compose.local.yaml");
  const input = join(generated, "local-input.json");
  assertDirectory(generated, 0o700, "generated local configuration directory");
  assertRegularFile(overlay, 0o600, "generated local Compose overlay");
  assertRegularFile(input, 0o600, "generated local input record");
  if (
    readFileSync(overlay, "utf8") !==
    localOverlay({
      state,
      ports: values.ports,
      localSource: values.sourceRevision,
    })
  ) {
    fail(
      "generated local Compose overlay differs from the current safe materialization",
    );
  }
  if (readFileSync(input, "utf8") !== inputBytes(values)) {
    fail("generated local input record differs from the current tuple");
  }
  return overlay;
}

function composeArgs(values, overlay) {
  return [
    "compose",
    "--project-name",
    values.project,
    "--file",
    BASE_COMPOSE,
    "--file",
    overlay,
  ];
}

function compose(values, overlay, args, options = {}) {
  return command("docker", [...composeArgs(values, overlay), ...args], {
    ...options,
    env: { ...localEnvironment(values), ...(options.env ?? {}) },
  });
}

function projectIsRunning(values, overlay) {
  const services = compose(values, overlay, [
    "ps",
    "--status",
    "running",
    "--services",
  ])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  return services.includes("authority") || services.includes("proxy");
}

function validateMaterialization(values, overlay) {
  const configured = compose(values, overlay, ["config", "--format", "json"]);
  let parsed;
  try {
    parsed = JSON.parse(configured);
  } catch {
    fail("docker compose did not produce JSON configuration");
  }
  const ports = parsed?.services?.authority?.ports;
  const volumes = parsed?.services?.authority?.volumes;
  const expectedPorts = [
    `127.0.0.1:${String(values.ports.http)}:80`,
    `127.0.0.1:${String(values.ports.https)}:443`,
  ];
  if (
    !Array.isArray(ports) ||
    ports.length !== 2 ||
    !ports.every((item, index) => {
      const published = `${item.host_ip ?? ""}:${String(item.published ?? "")}:${String(item.target ?? "")}`;
      return published === expectedPorts[index];
    })
  ) {
    fail("local overlay did not replace the base 80/443 bindings");
  }
  if (
    !Array.isArray(volumes) ||
    volumes.length !== 1 ||
    volumes[0]?.source !== values.state
  ) {
    fail("local overlay did not replace the base clean-data bind mount");
  }
}

const SEED_MANIFEST = String.raw`
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
const reset = JSON.parse(readFileSync("/echo-clean/reset.json", "utf8"));
const createdAt = "2026-08-25T00:00:00.000Z";
const state = "/echo-clean/state";
const privateDirectory = "/echo-clean/private";
function privateFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
privateFile(privateDirectory + "/oidc.json", canonicalJson({
  client_authentication: "client_secret_post",
  client_id: "local-synthetic-client",
  id_token_algorithms: ["RS256"],
  issuer: "https://issuer.example.invalid",
  redirect_uri: "https://localhost/v2/session/oidc/callback",
  tenant: { kind: "issuer" },
}) + "\n");
privateFile(privateDirectory + "/oidc-client-secret", "local-synthetic-not-a-provider-secret");
privateFile(privateDirectory + "/pkce-key", "A".repeat(43));
const manifest = {
  schema_version: 1,
  kind: "echo-clean-founder-onboarding-manifest-v1",
  state_directory: state,
  created_at: createdAt,
  artifact_revision: process.env.ECHO_LOCAL_SOURCE,
  authority_url: "https://localhost",
  oidc_config_path: privateDirectory + "/oidc.json",
  pkce_key_file: privateDirectory + "/pkce-key",
  invitation_path: state + "/onboarding/founder-person-invitation.json",
  slack_approval_channel_id: "C00000001",
  slack_connection_id: "con_00000000-0000-4000-8000-000000000001",
  authority_id: reset.authority_id,
  organization_id: reset.organization_id,
  state_lineage_id: reset.state_lineage_id,
  owner_principal_id: reset.owner_principal_id,
  owner_membership_id: reset.owner_membership_id,
  granola_credential_file: privateDirectory + "/not-present-granola-credential",
  granola_owner_email_file: privateDirectory + "/not-present-granola-owner-email",
  llm_credential_file: privateDirectory + "/not-present-llm-credential",
  setup_seed: {
    authority_id: reset.authority_id,
    organization_id: reset.organization_id,
    state_lineage_id: reset.state_lineage_id,
    owner_principal_id: reset.owner_principal_id,
    owner_membership_id: reset.owner_membership_id,
    control_plane_id: reset.control_plane_id,
    slack_connection_id: "con_00000000-0000-4000-8000-000000000001",
  },
  owner_email: "local-owner@example.test",
  organization_name: "Local synthetic organization",
  owner_display_name: "Local synthetic owner",
};
privateFile(state + "/onboarding/clean-founder-v1.json", canonicalJson(manifest) + "\n");
`;

function seed(values, overlay) {
  assertOwnedState(values.state, { create: false });
  assertGenerated(values, values.state);
  const resetOutput = compose(values, overlay, [
    "run",
    "--pull",
    "never",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "authority",
    "services/organization-authority/dist/clean-reset-main.js",
    "--state-dir",
    "/echo-clean/state",
    "--organization-name",
    "Local synthetic organization",
    "--owner-display-name",
    "Local synthetic owner",
    "--created-at",
    "2026-08-25T00:00:00.000Z",
    "--artifact-revision",
    values.sourceRevision,
  ]);
  const resetPath = join(values.state, "reset.json");
  if (lstatIfExists(resetPath) !== undefined)
    fail("synthetic reset record already exists");
  writeFileSync(resetPath, resetOutput, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  assertRegularFile(resetPath, 0o600, "synthetic reset record");
  assertOwnedState(values.state, { create: false });
  assertGenerated(values, values.state);
  compose(
    values,
    overlay,
    [
      "run",
      "--pull",
      "never",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "--env",
      `ECHO_LOCAL_SOURCE=${values.sourceRevision}`,
      "authority",
      "--input-type=module",
      "-",
    ],
    { input: SEED_MANIFEST },
  );
}

function clearSyntheticState(state) {
  for (const name of [
    "caddy-local-root-ca.crt",
    "private",
    "release",
    "reset.json",
    "state",
  ]) {
    const target = join(state, name);
    assertSafeTree(target, "synthetic state cleanup");
    if (lstatIfExists(target) !== undefined)
      rmSync(target, { recursive: true, force: true });
  }
}

function syntheticStateStatus(state) {
  const required = [
    "reset.json",
    "private/oidc.json",
    "private/oidc-client-secret",
    "private/pkce-key",
    "state/onboarding/clean-founder-v1.json",
  ].map((name) => join(state, name));
  for (const path of required) {
    const details = lstatIfExists(path);
    if (
      details !== undefined &&
      (details.isSymbolicLink() || !details.isFile())
    ) {
      fail(`synthetic state contains an unsafe required path: ${path}`);
    }
    if (details !== undefined)
      assertRegularFile(path, 0o600, "synthetic required state file");
  }
  assertSafeTree(join(state, "private"), "synthetic private state");
  assertSafeTree(join(state, "state"), "synthetic Authority state");
  const present = required.filter(
    (path) => lstatIfExists(path) !== undefined,
  ).length;
  if (present === 0) return "empty";
  if (present === required.length) return "complete";
  return "incomplete";
}

function writeCaCertificate(values, overlay) {
  const certificate = compose(values, overlay, [
    "exec",
    "-T",
    "proxy",
    "sh",
    "-ec",
    "cat /data/caddy/pki/authorities/local/root.crt",
  ]);
  if (!certificate.includes("BEGIN CERTIFICATE"))
    fail("Caddy local root certificate was not available");
  const path = join(values.state, "caddy-local-root-ca.crt");
  if (lstatIfExists(path) !== undefined) {
    assertRegularFile(path, 0o600, "Caddy local root certificate");
  }
  writeFileSync(path, certificate, { encoding: "utf8", mode: 0o600 });
  assertRegularFile(path, 0o600, "Caddy local root certificate");
  return path;
}

function buildPersonAuthorityClient() {
  command("npm", ["run", "build", "--workspace", "@echo-brain/person-client"]);
}

function verifyDescriptor(values, overlay, certificate) {
  compose(values, overlay, [
    "exec",
    "-T",
    "authority",
    "node",
    "--input-type=module",
    "-e",
    "const response = await fetch('http://127.0.0.1:39479/v1/authority-descriptor'); if (!response.ok) process.exit(1);",
  ]);
  const personClient = resolve(
    REPO,
    "src",
    "product",
    "person-client",
    "dist",
    "authority-client.js",
  );
  if (!existsSync(personClient))
    fail("Person Authority client build did not produce its entrypoint");
  const script = [
    'import { PersonAuthorityClient } from "./src/product/person-client/dist/authority-client.js";',
    "const value = await new PersonAuthorityClient({ authority_origin: process.argv[1] }).descriptor();",
    "if (value.authority_descriptor?.authority_id !== process.argv[2]) throw new Error('Authority descriptor did not match the seeded reset authority ID');",
  ].join(" ");
  const reset = join(values.state, "reset.json");
  assertRegularFile(reset, 0o600, "synthetic reset record");
  let resetValue;
  try {
    resetValue = JSON.parse(readFileSync(reset, "utf8"));
  } catch {
    fail("synthetic reset record is not valid JSON");
  }
  if (typeof resetValue.authority_id !== "string")
    fail("synthetic reset record lacks authority_id");
  command(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      `https://localhost:${String(values.ports.https)}`,
      resetValue.authority_id,
    ],
    {
      env: { NODE_EXTRA_CA_CERTS: certificate },
    },
  );
}

function inspectService(values, overlay, service, expectedImage) {
  assertGenerated(values, values.state);
  const id = compose(values, overlay, ["ps", "--quiet", service]).trim();
  if (id === "") fail(`${service} container is not running`);
  const output = command("docker", [
    "inspect",
    "--format",
    '{{.Config.Image}}\n{{index .Config.Labels "io.echo-brain.release-id"}}\n{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}',
    id,
  ])
    .trim()
    .split("\n");
  if (
    output.length !== 3 ||
    output[0] !== expectedImage ||
    output[1] !== values.releaseId ||
    output[2] !== values.runtimeProfileSha256
  ) {
    fail(
      `${service} container image or release tuple labels do not match the requested tuple`,
    );
  }
}

function verifyRunningTuple(values, overlay) {
  inspectService(values, overlay, "authority", values.image);
  inspectService(values, overlay, "proxy", CADDY_IMAGE);
}

function valuesFor(state, requested) {
  const project = localProjectName(REPO, process.getuid?.() ?? 0, state);
  const localId = canonicalWorktreeId();
  const supplied = [
    requested.image,
    requested.releaseId,
    requested.runtimeProfileSha256,
    requested.sourceRevision,
  ].filter((value) => value !== undefined);
  if (supplied.length !== 0 && supplied.length !== 4) {
    fail(
      "--image, --source-revision, --release-id, and --runtime-profile-sha256 must be supplied together",
    );
  }
  if (requested.noBuild && supplied.length === 0) {
    fail(
      "--no-build is reserved for a separately verified image and exact release tuple",
    );
  }
  return {
    image: requested.image ?? `echo-organization-authority:local-${localId}`,
    noBuild: requested.noBuild,
    ports: choosePorts(project),
    project,
    releaseId: requested.releaseId ?? `clean-v1-local-${localId}`,
    runtimeProfileSha256:
      requested.runtimeProfileSha256 ?? `local-nonreleasable-${localId}`,
    sourceRevision: requested.sourceRevision ?? localSourceRevision(),
    state,
  };
}

function up(state, requested) {
  const stateExists = existsSync(state);
  if (stateExists) assertOwnedState(state, { create: false });
  const values = valuesFor(state, requested);
  const status = stateExists ? syntheticStateStatus(state) : "empty";
  if (status === "complete") assertTuple(values, state);
  if (
    status === "empty" &&
    stateExists &&
    lstatIfExists(tuplePath(state)) !== undefined
  ) {
    assertTuple(values, state);
  }
  const generated = join(state, "generated");
  const existingOverlay =
    stateExists && lstatIfExists(generated) !== undefined
      ? assertGenerated(values, state)
      : undefined;
  const alreadyRunning =
    existingOverlay === undefined
      ? false
      : projectIsRunning(values, existingOverlay);
  if (!alreadyRunning) assertPortsFree(values.ports);
  buildPersonAuthorityClient();
  if (!stateExists) assertOwnedState(state, { create: true });
  if (lstatIfExists(tuplePath(state)) === undefined) writeTuple(state, values);
  assertTuple(values, state);
  const overlay = writeOverlay(state, values);
  validateMaterialization(values, overlay);
  const stateStatus = syntheticStateStatus(state);
  if (stateStatus === "incomplete") {
    fail("synthetic state is incomplete; run reset rather than reusing it");
  }
  if (!values.noBuild) {
    assertOwnedState(state, { create: false });
    assertTuple(values, state);
    assertGenerated(values, state);
    compose(values, overlay, ["build"]);
  }
  if (stateStatus === "empty") seed(values, overlay);
  assertOwnedState(state, { create: false });
  assertTuple(values, state);
  assertGenerated(values, state);
  compose(values, overlay, [
    "up",
    "--detach",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "120",
  ]);
  verifyRunningTuple(values, overlay);
  const certificate = writeCaCertificate(values, overlay);
  verifyDescriptor(values, overlay, certificate);
  process.stdout.write(
    `${JSON.stringify({
      authority_url: `https://localhost:${String(values.ports.https)}`,
      caddy_local_ca: certificate,
      kind: TOOL_KIND,
      project: values.project,
      state_directory: state,
    })}\n`,
  );
}

function reset(state, requested) {
  assertOwnedState(state, { create: true });
  const status = syntheticStateStatus(state);
  if (status === "complete") {
    const previous = valuesFromInput(state, readTuple(state));
    const previousOverlay = assertGenerated(previous, state);
    validateMaterialization(previous, previousOverlay);
    assertOwnedState(state, { create: false });
    assertGenerated(previous, state);
    compose(previous, previousOverlay, [
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  } else if (status !== "empty") {
    fail("synthetic state is incomplete; refusing reset cleanup");
  }
  clearSyntheticState(state);
  for (const path of [join(state, "generated"), tuplePath(state)]) {
    assertSafeTree(path, "local tuple reset cleanup");
    if (lstatIfExists(path) !== undefined)
      rmSync(path, { recursive: true, force: true });
  }
  up(state, requested);
}

function down(state, requested) {
  assertOwnedState(state, { create: false });
  if (syntheticStateStatus(state) !== "complete")
    fail("synthetic state is not complete");
  const stored = valuesFromInput(state, readTuple(state));
  if (tupleArgumentsProvided(requested))
    assertTuple(valuesFor(state, requested), state);
  const values = stored;
  const overlay = assertGenerated(values, state);
  assertOwnedState(state, { create: false });
  assertGenerated(values, state);
  compose(values, overlay, ["down", "--volumes", "--remove-orphans"]);
  process.stdout.write(
    `${JSON.stringify({ kind: TOOL_KIND, project: values.project, state_directory: state, stopped: true })}\n`,
  );
}

function caPath(state) {
  assertOwnedState(state, { create: false });
  const path = join(state, "caddy-local-root-ca.crt");
  if (lstatIfExists(path) === undefined)
    fail("local CA is unavailable; run up first");
  assertRegularFile(path, 0o600, "Caddy local root certificate");
  process.stdout.write(`${path}\n`);
}

function usage() {
  return "usage: npm run authority:local -- <up|reset|down|ca-path> [--state-dir /absolute/path] [--image tag --source-revision sha --release-id id --runtime-profile-sha256 sha --no-build]\n";
}

function parse(argv) {
  const [action, ...rest] = argv;
  const values = { noBuild: false };
  const options = new Map([
    ["--image", "image"],
    ["--release-id", "releaseId"],
    ["--runtime-profile-sha256", "runtimeProfileSha256"],
    ["--source-revision", "sourceRevision"],
    ["--state-dir", "state"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--no-build") {
      if (values.noBuild) fail(usage().trim());
      values.noBuild = true;
      continue;
    }
    const key = options.get(rest[index]);
    if (
      key === undefined ||
      values[key] !== undefined ||
      rest[index + 1] === undefined
    )
      fail(usage().trim());
    values[key] = rest[index + 1];
    index += 1;
  }
  if (
    action === undefined ||
    !["up", "reset", "down", "ca-path"].includes(action)
  )
    fail(usage().trim());
  return { action, ...values, state: validateStateDirectory(values.state) };
}

export function main(argv = process.argv.slice(2)) {
  const requested = parse(argv);
  if (requested.action === "up") up(requested.state, requested);
  else if (requested.action === "reset") reset(requested.state, requested);
  else if (requested.action === "down") down(requested.state, requested);
  else caPath(requested.state);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
