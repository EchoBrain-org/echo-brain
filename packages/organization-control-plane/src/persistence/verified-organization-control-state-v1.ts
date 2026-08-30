import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import {
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  organizationControlBaselineSha256V2,
} from "./baseline.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";

const ROOT_MANIFEST_FILE = "state-lineage-root.v1.json";
const LINEAGE_MANIFEST_TABLE = "echo_state_lineage_manifest";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_ROLES = [
  "authority",
  "control-plane",
  "record-log",
  "record-derived",
  "retrieval-facts",
  "retrieval-lexical",
  "retrieval-content",
] as const;

export interface VerifiedOrganizationControlStateV1 {
  readonly state_directory: string;
  readonly integrations_database_path: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync(path) !== path ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} must be a current-user canonical 0700 directory`);
  }
}

function assertPrivateFile(path: string, label: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    realpathSync(path) !== path ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      `${label} must be a current-user canonical 0600 regular file`,
    );
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

interface OrganizationControlRootBinding {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

function parseRootManifest(path: string): OrganizationControlRootBinding {
  assertPrivateFile(path, "organization control state root manifest");
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
    throw new Error("organization control state root manifest exceeds the size limit");
  }
  let root: unknown;
  try {
    root = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("organization control state root manifest is not JSON");
  }
  if (canonicalJson(root) !== raw) {
    throw new Error("organization control state root manifest is not canonical");
  }
  const body = exactObject(
    root,
    [
      "schema_version",
      "kind",
      "authority_id",
      "organization_id",
      "state_lineage_id",
      "databases",
      "created_at",
      "creating_artifact_revision",
    ],
    "organization control state root manifest",
  );
  if (
    body.schema_version !== 1 ||
    body.kind !== "echo-state-lineage-root-manifest-v1" ||
    !Array.isArray(body.databases) ||
    body.databases.length !== REQUIRED_ROLES.length
  ) {
    throw new Error("organization control state root manifest is not v1");
  }
  const roles = new Set<string>();
  let controlPlane = false;
  for (const slot of body.databases) {
    const value = exactObject(
      slot,
      ["role", "location", "application_id"],
      "organization control state database slot",
    );
    const role = text(value.role, "organization control state database slot role");
    if (!REQUIRED_ROLES.includes(role as (typeof REQUIRED_ROLES)[number])) {
      throw new Error("organization control state root manifest has an unsupported role");
    }
    roles.add(role);
    if (role === "control-plane") {
      const location = exactObject(
        value.location,
        ["kind", "filename"],
        "control-plane location",
      );
      if (
        location.kind !== "state_file" ||
        location.filename !== "integrations.sqlite" ||
        value.application_id !== ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID
      ) {
        throw new Error(
          "organization control state root manifest has an invalid control-plane slot",
        );
      }
      controlPlane = true;
    }
  }
  if (roles.size !== REQUIRED_ROLES.length || !controlPlane) {
    throw new Error(
      "organization control state root manifest does not cover the v1 roles",
    );
  }
  return Object.freeze({
    authority_id: text(body.authority_id, "organization control state authority_id"),
    organization_id: text(body.organization_id, "organization control state organization_id"),
    state_lineage_id: text(
      body.state_lineage_id,
      "organization control state state_lineage_id",
    ),
  });
}

function verifyControlDatabase(path: string, binding: OrganizationControlRootBinding): void {
  assertPrivateFile(path, "integrations database");
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (
      database.pragma("application_id", { simple: true }) !==
        ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID ||
      database.pragma("user_version", { simple: true }) !==
        ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2
    ) {
      throw new Error(
        "integrations database has the wrong baseline identity",
      );
    }
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id
         FROM organization_control_plane_metadata WHERE singleton = 1`,
      )
      .get() as { authority_id: string; organization_id: string } | undefined;
    if (
      metadata === undefined ||
      metadata.authority_id !== binding.authority_id ||
      metadata.organization_id !== binding.organization_id
    ) {
      throw new Error(
        "integrations metadata does not match its root manifest",
      );
    }
    const manifest = database
      .prepare(
        `SELECT manifest_json, manifest_sha256 FROM ${LINEAGE_MANIFEST_TABLE}
         WHERE singleton = 1`,
      )
      .get() as { manifest_json: string; manifest_sha256: string } | undefined;
    if (manifest === undefined || !DIGEST.test(manifest.manifest_sha256)) {
      throw new Error("integrations database has no lineage manifest");
    }
    let body: unknown;
    try {
      body = JSON.parse(manifest.manifest_json) as unknown;
    } catch {
      throw new Error("integrations lineage manifest is not JSON");
    }
    if (
      canonicalJson(body) !== manifest.manifest_json ||
      canonicalSha256(body) !== manifest.manifest_sha256
    ) {
      throw new Error("integrations lineage manifest digest is invalid");
    }
    const record = exactObject(
      body,
      [
        "schema_version",
        "kind",
        "role",
        "authority_id",
        "organization_id",
        "state_lineage_id",
        "database_schema_version",
        "schema_sha256",
        "created_at",
        "creating_artifact_revision",
      ],
      "integrations lineage manifest",
    );
    if (
      record.schema_version !== 1 ||
      record.kind !== "echo-state-lineage-database-manifest-v1" ||
      record.role !== "control-plane" ||
      record.authority_id !== binding.authority_id ||
      record.organization_id !== binding.organization_id ||
      record.state_lineage_id !== binding.state_lineage_id ||
      record.database_schema_version !==
        ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2 ||
      record.schema_sha256 !== organizationControlBaselineSha256V2()
    ) {
      throw new Error(
        "integrations lineage manifest does not match private-approval baseline v2",
      );
    }
  } finally {
    database.close();
  }
}

/**
 * Local control-plane pre-open verification for the stopped-state command.
 * It intentionally verifies only the root and control-plane slice; the full
 * cross-role Authority pre-open guard remains Authority-owned and is not
 * imported into this package.
 */
export function verifyOrganizationControlStateV1(
  stateDirectory: string,
): VerifiedOrganizationControlStateV1 {
  if (
    typeof stateDirectory !== "string" ||
    !isAbsolute(stateDirectory) ||
    resolve(stateDirectory) !== stateDirectory ||
    !existsSync(stateDirectory)
  ) {
    throw new Error(
      "organization control state directory must be an existing normalized absolute path",
    );
  }
  assertPrivateDirectory(stateDirectory, "organization control state directory");
  const binding = parseRootManifest(join(stateDirectory, ROOT_MANIFEST_FILE));
  const integrationsDatabasePath = join(stateDirectory, "integrations.sqlite");
  verifyControlDatabase(integrationsDatabasePath, binding);
  return Object.freeze({
    state_directory: stateDirectory,
    integrations_database_path: integrationsDatabasePath,
    ...binding,
  });
}
