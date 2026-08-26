#!/usr/bin/env node

/**
 * Offline structural verifier for a restored clean-v1 Authority state volume.
 *
 * This command deliberately has no deployment, Docker, AWS, or network code.
 * Its two inputs are explicit so an operator can stage a checksum-verified
 * accepted source build on a helper and mount the restored volume separately.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPORT = Object.freeze({
  schema_version: 1,
  kind: "echo-authority-offline-recovery-verification-v1",
});
const RUNTIME_ENVIRONMENT_FIELDS = Object.freeze([
  "ECHO_CLEAN_AUTHORITY_HOST",
  "ECHO_CLEAN_AUTHORITY_URL",
  "ECHO_CLEAN_AUTHORITY_UID",
  "ECHO_CLEAN_AUTHORITY_GID",
  "ECHO_CLEAN_AUTHORITY_IMAGE",
  "ECHO_CLEAN_RELEASE_ID",
  "ECHO_CLEAN_RELEASE_SOURCE_SHA",
  "ECHO_CLEAN_RUNTIME_PROFILE_SHA256",
  "ECHO_CLEAN_RUNTIME_PROFILE_VERSION",
  "ECHO_CLEAN_AWS_REGION",
  "ECHO_CLEAN_AUTHORITY_LOG_GROUP",
  "ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID",
  "ECHO_CLEAN_OWNER_EMAIL",
]);
const RELEASE_BOUND_ENVIRONMENT_FIELDS = Object.freeze([
  "ECHO_CLEAN_AUTHORITY_IMAGE",
  "ECHO_CLEAN_RELEASE_ID",
  "ECHO_CLEAN_RELEASE_SOURCE_SHA",
  "ECHO_CLEAN_RUNTIME_PROFILE_SHA256",
  "ECHO_CLEAN_RUNTIME_PROFILE_VERSION",
]);
const SQLITE_HOT_STATE_SUFFIX = /-(?:journal|wal|shm)$/;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function fail() {
  throw new Error("offline recovery verification refused");
}

function normalizePaths(cleanData, sourceRoot) {
  if (
    typeof cleanData !== "string" ||
    typeof sourceRoot !== "string" ||
    cleanData.length === 0 ||
    sourceRoot.length === 0 ||
    !isAbsolute(cleanData) ||
    !isAbsolute(sourceRoot)
  ) {
    fail();
  }
  return Object.freeze({
    cleanData: resolve(cleanData),
    sourceRoot: resolve(sourceRoot),
  });
}

function parseArguments(argv) {
  if (argv.length !== 4) fail();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== "--clean-data" && flag !== "--source-root") ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(flag) ||
      !isAbsolute(value)
    ) {
      fail();
    }
    values.set(flag, value);
  }
  const cleanData = values.get("--clean-data");
  const sourceRoot = values.get("--source-root");
  if (cleanData === undefined || sourceRoot === undefined) fail();
  return normalizePaths(cleanData, sourceRoot);
}

function decodeMountinfoPath(value) {
  if (typeof value !== "string" || value.length === 0) fail();
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      decoded += value[index];
      continue;
    }
    const escaped = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(escaped)) fail();
    decoded += String.fromCharCode(Number.parseInt(escaped, 8));
    index += 3;
  }
  if (!isAbsolute(decoded) || decoded.includes("\0")) fail();
  return resolve(decoded);
}

/** Parse Linux procfs mountinfo without following any target filesystem path. */
export function parseLinuxMountinfo(text) {
  if (typeof text !== "string" || text.length === 0) fail();
  const mounts = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator === -1) fail();
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (
      left.length < 6 ||
      right.length < 3 ||
      !/^[0-9]+$/.test(left[0]) ||
      !/^[0-9]+$/.test(left[1])
    ) {
      fail();
    }
    const options = left[5].split(",");
    if (options.some((option) => option.length === 0)) fail();
    mounts.push(
      Object.freeze({
        mount_id: left[0],
        mount_point: decodeMountinfoPath(left[4]),
        mount_options: Object.freeze(options),
      }),
    );
  }
  if (mounts.length === 0) fail();
  return Object.freeze(mounts);
}

function isWithinMountpoint(path, mountPoint) {
  return mountPoint === "/"
    ? path.startsWith("/")
    : path === mountPoint || path.startsWith(`${mountPoint}/`);
}

/**
 * Require the closest Linux mount containing `path` to be read-only. The CLI
 * always uses this function against the live kernel table; tests may supply a
 * mountinfo reader only through the programmatic verifier API.
 */
export function inspectLinuxReadOnlyMount(
  path,
  readMountinfo = () => readFileSync("/proc/self/mountinfo", "utf8"),
) {
  if (typeof path !== "string" || !isAbsolute(path)) fail();
  const target = resolve(path);
  let mounts;
  try {
    mounts = parseLinuxMountinfo(readMountinfo());
  } catch {
    fail();
  }
  const candidates = mounts.filter((mount) =>
    isWithinMountpoint(target, mount.mount_point),
  );
  const longestMountpoint = Math.max(
    ...candidates.map((mount) => mount.mount_point.length),
  );
  const closest = candidates.filter(
    (mount) => mount.mount_point.length === longestMountpoint,
  );
  if (
    closest.length !== 1 ||
    !closest[0].mount_options.includes("ro") ||
    closest[0].mount_options.includes("rw")
  ) {
    fail();
  }
  return closest[0];
}

function safeDirectory(path) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail();
  }
  if (state.isSymbolicLink() || !state.isDirectory()) fail();
}

function safeRegularFile(path, { privateFile = false } = {}) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail();
  }
  if (state.isSymbolicLink() || !state.isFile() || state.size <= 0) fail();
  if (privateFile && (state.mode & 0o077) !== 0) fail();
}

/**
 * The production lineage verifier follows symlinks because its production
 * callers do. An offline restored-volume verifier has a stricter boundary:
 * inspect the complete state tree with lstat before it imports lineage code or
 * opens SQLite, so no restored state node can redirect the helper into private
 * material or any other path outside state/.
 */
function refuseUnsafeStateTree(path) {
  safeDirectory(path);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    fail();
  }
  for (const entry of entries) {
    if (SQLITE_HOT_STATE_SUFFIX.test(entry.name)) fail();
    const entryPath = join(path, entry.name);
    let state;
    try {
      state = lstatSync(entryPath);
    } catch {
      fail();
    }
    if (state.isSymbolicLink()) fail();
    if (state.isDirectory()) {
      refuseUnsafeStateTree(entryPath);
    } else if (!state.isFile()) {
      fail();
    }
  }
}

/**
 * Inspect only names, lstat metadata, and permission bits below private/.
 * Do not open private files, hash their contents, or emit their paths.
 */
function inspectPrivateDirectory(path, expectedOwner) {
  safeDirectory(path);
  const rootState = lstatSync(path);
  if (
    (rootState.mode & 0o777) !== 0o700 ||
    rootState.uid !== expectedOwner.uid ||
    rootState.gid !== expectedOwner.gid
  ) {
    fail();
  }
  let entries = 0;
  const inspect = (directory) => {
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail();
    }
    for (const child of children) {
      const childPath = join(directory, child.name);
      let state;
      try {
        state = lstatSync(childPath);
      } catch {
        fail();
      }
      entries += 1;
      if (
        state.isSymbolicLink() ||
        state.uid !== expectedOwner.uid ||
        state.gid !== expectedOwner.gid
      ) {
        fail();
      }
      if (state.isDirectory()) {
        if ((state.mode & 0o777) !== 0o700) fail();
        inspect(childPath);
      } else if (!state.isFile() || (state.mode & 0o777) !== 0o600) {
        fail();
      }
    }
  };
  inspect(path);
  return entries;
}

function requirePython3() {
  const result = spawnSync("python3", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !/^Python 3\.\d+\.\d+\s*$/.test(result.stdout)) {
    fail();
  }
  return "python3";
}

function sha256(python3, path) {
  const result = spawnSync(
    python3,
    [
      "-c",
      "import hashlib, pathlib, sys\nprint(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())",
      path,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0 || !/^[0-9a-f]{64}\n$/.test(result.stdout)) fail();
  return result.stdout.trim();
}

function verifyEnvironmentSnapshot(python3, path, release) {
  safeRegularFile(path, { privateFile: true });
  const expected = Object.freeze({
    ECHO_CLEAN_AUTHORITY_IMAGE: release.authority_image.reference,
    ECHO_CLEAN_RELEASE_ID: release.release_id,
    ECHO_CLEAN_RELEASE_SOURCE_SHA: release.source_sha,
    ECHO_CLEAN_RUNTIME_PROFILE_SHA256: release.runtime_profile.artifact_sha256,
    ECHO_CLEAN_RUNTIME_PROFILE_VERSION: release.runtime_profile.profile_version,
  });
  const program = [
    "import pathlib, stat, sys",
    "path = pathlib.Path(sys.argv[1])",
    "expected = dict(item.split('=', 1) for item in sys.argv[2:])",
    `fields = ${JSON.stringify(RUNTIME_ENVIRONMENT_FIELDS)}`,
    `release_bound_fields = ${JSON.stringify(RELEASE_BOUND_ENVIRONMENT_FIELDS)}`,
    "state = path.lstat()",
    "if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or state.st_mode & 0o077: raise SystemExit(1)",
    "text = path.read_text(encoding='utf-8')",
    "if not text or text.endswith('\\n') or '\\r' in text: raise SystemExit(1)",
    "lines = text.split('\\n')",
    "if len(lines) != len(fields): raise SystemExit(1)",
    "actual = {}",
    "for field, line in zip(fields, lines):",
    "    if line.count('=') != 1:",
    "        raise SystemExit(1)",
    "    name, value = line.split('=', 1)",
    "    if name != field or not value or name in actual:",
    "        raise SystemExit(1)",
    "    actual[name] = value",
    "if set(actual) != set(fields): raise SystemExit(1)",
    "for name in release_bound_fields:",
    "    if actual[name] != expected[name]: raise SystemExit(1)",
    "host = actual['ECHO_CLEAN_AUTHORITY_HOST']",
    "labels = host.split('.')",
    "if len(host) > 253 or len(labels) < 2 or any(not __import__('re').fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels): raise SystemExit(1)",
    "if actual['ECHO_CLEAN_AUTHORITY_URL'] != 'https://' + host: raise SystemExit(1)",
    "if not __import__('re').fullmatch(r'[1-9][0-9]*', actual['ECHO_CLEAN_AUTHORITY_UID']): raise SystemExit(1)",
    "if not __import__('re').fullmatch(r'[0-9]+', actual['ECHO_CLEAN_AUTHORITY_GID']): raise SystemExit(1)",
    "if not __import__('re').fullmatch(r'[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*', actual['ECHO_CLEAN_AWS_REGION']): raise SystemExit(1)",
    "if actual['ECHO_CLEAN_AUTHORITY_LOG_GROUP'] != '/echo-brain/authority/' + host: raise SystemExit(1)",
    "if not __import__('re').fullmatch(r'[CG][A-Z0-9]{8,}', actual['ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID']): raise SystemExit(1)",
    "if not __import__('re').fullmatch(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', actual['ECHO_CLEAN_OWNER_EMAIL']): raise SystemExit(1)",
    "print(actual['ECHO_CLEAN_AUTHORITY_UID'])",
    "print(actual['ECHO_CLEAN_AUTHORITY_GID'])",
  ].join("\n");
  const result = spawnSync(
    python3,
    [
      "-c",
      program,
      path,
      ...RELEASE_BOUND_ENVIRONMENT_FIELDS.map(
        (field) => `${field}=${expected[field]}`,
      ),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) fail();
  const owner = result.stdout.split("\n");
  if (
    owner.length !== 3 ||
    !/^[1-9][0-9]*$/.test(owner[0]) ||
    !/^[0-9]+$/.test(owner[1]) ||
    owner[2] !== ""
  ) {
    fail();
  }
  const uid = Number(owner[0]);
  const gid = Number(owner[1]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) fail();
  return Object.freeze({ uid, gid });
}

function integrityCheck(python3, paths) {
  const checkedProgram = [
    "import pathlib, sqlite3, sys",
    "for raw in sys.argv[1:]:",
    "    uri = pathlib.Path(raw).as_uri() + '?mode=ro&immutable=1'",
    "    connection = sqlite3.connect(uri, uri=True)",
    "    try:",
    "        connection.execute('PRAGMA query_only = ON')",
    "        if connection.execute('PRAGMA integrity_check(1)').fetchall() != [('ok',)]: raise SystemExit(1)",
    "    finally:",
    "        connection.close()",
  ].join("\n");
  const result = spawnSync(python3, ["-c", checkedProgram, ...paths], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.status !== 0) fail();
}

function runValidator(tool, path) {
  const result = spawnSync(process.execPath, [tool, "validate", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) fail();
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail();
  }
}

async function importedValidator(sourceRoot) {
  const releasePath = join(sourceRoot, "tools", "clean-v1-release.mjs");
  const profilePath = join(sourceRoot, "tools", "clean-v1-runtime-profile.mjs");
  const lineagePath = join(
    sourceRoot,
    "services",
    "organization-authority",
    "dist",
    "composition",
    "verify-clean-state-lineage.js",
  );
  safeRegularFile(releasePath);
  safeRegularFile(profilePath);
  safeRegularFile(lineagePath);
  try {
    const lineage = await import(pathToFileURL(lineagePath).href);
    if (typeof lineage.verifyCleanStateLineage !== "function") fail();
    return Object.freeze({
      readRelease: (path) => runValidator(releasePath, path),
      readProfile: (path) => runValidator(profilePath, path),
      verifyLineage: lineage.verifyCleanStateLineage,
    });
  } catch {
    fail();
  }
}

function canonicalCleanDataPath(path) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch {
    fail();
  }
  return canonical;
}

function sameMount(before, after) {
  return (
    before.mount_id === after.mount_id &&
    before.mount_point === after.mount_point &&
    before.mount_options.join(",") === after.mount_options.join(",")
  );
}

export async function verifyAuthorityRecovery({
  cleanData,
  sourceRoot,
  mountInspector = inspectLinuxReadOnlyMount,
}) {
  const paths = normalizePaths(cleanData, sourceRoot);
  cleanData = canonicalCleanDataPath(paths.cleanData);
  sourceRoot = paths.sourceRoot;
  if (typeof mountInspector !== "function") fail();
  const mountBefore = mountInspector(cleanData);
  safeDirectory(cleanData);
  safeDirectory(sourceRoot);
  const python3 = requirePython3();
  const releaseDirectory = join(cleanData, "release");
  const stateDirectory = join(cleanData, "state");
  const privateDirectory = join(cleanData, "private");
  safeDirectory(releaseDirectory);
  safeDirectory(stateDirectory);
  refuseUnsafeStateTree(stateDirectory);
  const validators = await importedValidator(sourceRoot);

  const currentReleasePath = join(releaseDirectory, "current.clean-v1.json");
  safeRegularFile(currentReleasePath, { privateFile: true });
  let release;
  try {
    release = validators.readRelease(currentReleasePath);
  } catch {
    fail();
  }

  const activeProfilePath = join(releaseDirectory, "runtime-profile.active");
  const storedProfilePath = join(
    releaseDirectory,
    "runtime-profiles",
    `${release.release_id}.profile`,
  );
  safeDirectory(join(releaseDirectory, "runtime-profiles"));
  safeRegularFile(activeProfilePath, { privateFile: true });
  safeRegularFile(storedProfilePath, { privateFile: true });
  let activeProfile;
  let storedProfile;
  try {
    activeProfile = validators.readProfile(activeProfilePath);
    storedProfile = validators.readProfile(storedProfilePath);
  } catch {
    fail();
  }
  if (
    sha256(python3, activeProfilePath) !==
      release.runtime_profile.artifact_sha256 ||
    sha256(python3, storedProfilePath) !==
      release.runtime_profile.artifact_sha256 ||
    activeProfile.source_sha !== release.source_sha ||
    storedProfile.source_sha !== release.source_sha
  ) {
    fail();
  }
  const environmentsDirectory = join(releaseDirectory, "runtime-environments");
  safeDirectory(environmentsDirectory);
  const expectedPrivateOwner = verifyEnvironmentSnapshot(
    python3,
    join(environmentsDirectory, `${release.release_id}.env`),
    release,
  );
  const privateEntryCount = inspectPrivateDirectory(
    privateDirectory,
    expectedPrivateOwner,
  );

  let lineage;
  try {
    lineage = validators.verifyLineage(stateDirectory);
  } catch {
    fail();
  }
  const primaryDatabases = lineage.databases.filter(
    (database) => !database.role.startsWith("retrieval-"),
  );
  const retrievalDatabases = lineage.databases.filter((database) =>
    database.role.startsWith("retrieval-"),
  );
  if (
    primaryDatabases.length !== 4 ||
    retrievalDatabases.length !== lineage.retrieval.segment_count * 3
  ) {
    fail();
  }
  integrityCheck(
    python3,
    [...primaryDatabases, ...retrievalDatabases].map(
      (database) => database.path,
    ),
  );

  const mountAfter = mountInspector(cleanData);
  if (!sameMount(mountBefore, mountAfter)) fail();

  return Object.freeze({
    ...REPORT,
    ok: true,
    release_runtime_profile_tuple_valid: true,
    runtime_environment_snapshot_schema_valid: true,
    release_bound_environment_fields_valid: true,
    state_lineage_valid: true,
    private_metadata_valid: true,
    private_entry_count: privateEntryCount,
    primary_sqlite_database_count: primaryDatabases.length,
    primary_sqlite_integrity_valid: true,
    retrieval_generation_count: lineage.retrieval.generation_count,
    retrieval_segment_count: lineage.retrieval.segment_count,
    retrieval_sqlite_database_count: retrievalDatabases.length,
    retrieval_sqlite_integrity_valid: true,
  });
}

async function main(argv) {
  const result = await verifyAuthorityRecovery(parseArguments(argv));
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch {
    process.stderr.write("authority offline recovery verification failed\n");
    process.exitCode = 1;
  }
}
