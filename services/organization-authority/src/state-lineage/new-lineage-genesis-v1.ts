import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import type { JsonValue, Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
  STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
  stateLineageDatabaseManifestSha256V1,
  stateLineageDatabaseSlotsV1,
  validateStateLineageDatabaseManifestV1,
  validateStateLineageRootManifestV1,
} from "./state-lineage-manifest-v1.js";
import type {
  StateLineagePreopenExpectationV1,
  StateLineagePreopenResultV1,
} from "./state-lineage-preopen-guard.js";
import { verifyStateLineageBeforeOpen } from "./state-lineage-preopen-guard.js";
import type { StateLineageRoleV1 } from "./state-lineage-manifest-v1.js";

/**
 * Private, dependency-injected new-lineage genesis.
 *
 * This deliberately owns no baseline SQL and selects no runtime. Callers must
 * supply the exact v1 appliers and their frozen schema digests. It writes only
 * an absent target directory through a private staging directory, verifies the
 * published bytes read-only, and returns no writable handles. Existing
 * init-development and serve composition intentionally do not call it.
 */

type TopLevelRoleV1 = Exclude<
  StateLineageRoleV1,
  "retrieval-facts" | "retrieval-lexical" | "retrieval-content"
>;

const TOP_LEVEL_ROLES: readonly TopLevelRoleV1[] = Object.freeze([
  "authority",
  "control-plane",
  "record-log",
  "record-derived",
]);

export interface NewLineageSchemaV1 {
  readonly database_schema_version: number;
  readonly schema_sha256: Sha256Digest;
}

export interface NewLineageBindingV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface NewLineageRoleApplierV1 {
  /** Applies the role's frozen baseline to the completely empty handle. */
  readonly apply: (database: Database.Database) => void;
}

export interface NewLineageStagedStateV1 {
  readonly state_directory: string;
  readonly binding: NewLineageBindingV1;
  readonly created_at: string;
  readonly creating_artifact_revision: string;
}

export interface InitializeNewStateLineageV1Input {
  /** An absent, normalized absolute directory. Its parent must already exist. */
  readonly state_directory: string;
  readonly binding: NewLineageBindingV1;
  readonly created_at: string;
  readonly creating_artifact_revision: string;
  /** Exact schemas for all seven roles, including the not-yet-built retrieval roles. */
  readonly schemas: Readonly<Record<StateLineageRoleV1, NewLineageSchemaV1>>;
  /** Appliers only for the four state-directory peer databases. */
  readonly top_level_appliers: Readonly<
    Record<TopLevelRoleV1, NewLineageRoleApplierV1>
  >;
  /**
   * Deliberately injected so this private scaffold does not guess opener
   * behavior or import a baseline-owning workspace. The implementation must
   * return one writable handle for the supplied path and no shared handle.
   */
  readonly open_writable_database: (
    path: string,
    role: TopLevelRoleV1,
  ) => Database.Database;
  /**
   * Optional exact metadata preparation while the state remains private
   * staging output. It must close every handle it opens and may not publish
   * files outside `state_directory`.
   */
  readonly prepare_staged_state?: (state: NewLineageStagedStateV1) => void;
}

export interface InitializedNewStateLineageV1 {
  readonly state_directory: string;
  readonly verification: StateLineagePreopenResultV1;
}

function assertPrivateExistingDirectory(path: string, label: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} must be a current-user 0700 directory`);
  }
}

function preopenExpectation(
  stateDirectory: string,
  binding: NewLineageBindingV1,
  schemas: InitializeNewStateLineageV1Input["schemas"],
): StateLineagePreopenExpectationV1 {
  return {
    state_directory: stateDirectory,
    expected_binding: binding,
    expected_schemas: schemas,
  };
}

function schemaForRole(
  schemas: unknown,
  role: StateLineageRoleV1,
): NewLineageSchemaV1 {
  if (
    schemas === null ||
    typeof schemas !== "object" ||
    Array.isArray(schemas) ||
    !Object.prototype.hasOwnProperty.call(schemas, role)
  ) {
    throw new Error(`new-lineage schemas must give the ${role} role a schema`);
  }
  const schema = (schemas as Record<string, unknown>)[role];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`new-lineage schemas must give the ${role} role a schema`);
  }
  return schema as NewLineageSchemaV1;
}

function validateInput(input: InitializeNewStateLineageV1Input): void {
  if (
    typeof input.state_directory !== "string" ||
    input.state_directory.length === 0 ||
    !isAbsolute(input.state_directory) ||
    resolve(input.state_directory) !== input.state_directory ||
    input.state_directory === "/"
  ) {
    throw new Error(
      "new-lineage state directory must be an explicit non-root absolute path",
    );
  }
  if (existsSync(input.state_directory)) {
    throw new Error("new-lineage state directory must not already exist");
  }
  const parent = dirname(input.state_directory);
  if (!existsSync(parent)) {
    throw new Error("new-lineage state directory parent must already exist");
  }
  assertPrivateExistingDirectory(parent, "new-lineage state directory parent");
  if (typeof input.open_writable_database !== "function") {
    throw new Error(
      "new-lineage genesis requires an open_writable_database function",
    );
  }
  for (const role of TOP_LEVEL_ROLES) {
    if (typeof input.top_level_appliers?.[role]?.apply !== "function") {
      throw new Error(
        `new-lineage genesis requires a ${role} baseline applier`,
      );
    }
  }

  // Validate every caller-provided identity member before touching the
  // filesystem. The same bodies are written below, so this also rejects an
  // invalid schema digest, timestamp, or artifact revision up front.
  const root = validateStateLineageRootManifestV1({
    schema_version: 1,
    kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
    ...input.binding,
    databases: stateLineageDatabaseSlotsV1(),
    created_at: input.created_at,
    creating_artifact_revision: input.creating_artifact_revision,
  });
  void root;
  for (const slot of stateLineageDatabaseSlotsV1()) {
    const schema = schemaForRole(input.schemas, slot.role);
    validateStateLineageDatabaseManifestV1({
      schema_version: 1,
      kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
      role: slot.role,
      ...input.binding,
      database_schema_version: schema.database_schema_version,
      schema_sha256: schema.schema_sha256,
      created_at: input.created_at,
      creating_artifact_revision: input.creating_artifact_revision,
    });
  }
}

function stampDatabaseManifest(
  database: Database.Database,
  role: TopLevelRoleV1,
  input: InitializeNewStateLineageV1Input,
): void {
  const schema = schemaForRole(input.schemas, role);
  const body = validateStateLineageDatabaseManifestV1({
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    ...input.binding,
    database_schema_version: schema.database_schema_version,
    schema_sha256: schema.schema_sha256,
    created_at: input.created_at,
    creating_artifact_revision: input.creating_artifact_revision,
  });
  const manifestJson = canonicalJson(body as unknown as JsonValue);
  const manifestSha256 = stateLineageDatabaseManifestSha256V1(body);
  const existing = database
    .prepare(
      `SELECT count(*) AS count FROM sqlite_schema
       WHERE type = 'table' AND name = ?`,
    )
    .pluck()
    .get(STATE_LINEAGE_MANIFEST_TABLE) as number;
  if (existing !== 0) {
    throw new Error(
      `${role} baseline must not create ${STATE_LINEAGE_MANIFEST_TABLE}`,
    );
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(
      `CREATE TABLE ${STATE_LINEAGE_MANIFEST_TABLE} (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`,
    );
    database
      .prepare(
        `INSERT INTO ${STATE_LINEAGE_MANIFEST_TABLE}
         (singleton, manifest_json, manifest_sha256) VALUES (?, ?, ?)`,
      )
      .run(1, manifestJson, manifestSha256);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function writeRootManifest(
  stagingDirectory: string,
  input: InitializeNewStateLineageV1Input,
): void {
  const root = validateStateLineageRootManifestV1({
    schema_version: 1,
    kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
    ...input.binding,
    databases: stateLineageDatabaseSlotsV1(),
    created_at: input.created_at,
    creating_artifact_revision: input.creating_artifact_revision,
  });
  const path = join(stagingDirectory, STATE_LINEAGE_ROOT_MANIFEST_FILENAME);
  writeFileSync(path, canonicalJson(root as unknown as JsonValue), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

/**
 * Creates and validates an isolated v1 state lineage. This does not make that
 * lineage live: the caller receives only read-only verification evidence.
 */
export function initializeNewStateLineageV1(
  input: InitializeNewStateLineageV1Input,
): InitializedNewStateLineageV1 {
  validateInput(input);
  const stateParent = dirname(input.state_directory);
  const stagingDirectory = mkdtempSync(join(stateParent, ".installing-"));
  chmodSync(stagingDirectory, 0o700);
  let published = false;
  try {
    for (const slot of stateLineageDatabaseSlotsV1()) {
      if (slot.location.kind !== "state_file") continue;
      const role = slot.role as TopLevelRoleV1;
      const databasePath = join(stagingDirectory, slot.location.filename);
      const database = input.open_writable_database(databasePath, role);
      try {
        input.top_level_appliers[role].apply(database);
        stampDatabaseManifest(database, role, input);
      } finally {
        database.close();
      }
      chmodSync(databasePath, 0o600);
    }
    input.prepare_staged_state?.({
      state_directory: stagingDirectory,
      binding: input.binding,
      created_at: input.created_at,
      creating_artifact_revision: input.creating_artifact_revision,
    });
    writeRootManifest(stagingDirectory, input);

    // Validate staged bytes first so a schema/applier defect never gets
    // published. The required post-publish check below also proves the exact
    // renamed directory is the state the caller receives.
    verifyStateLineageBeforeOpen(
      preopenExpectation(stagingDirectory, input.binding, input.schemas),
    );
    renameSync(stagingDirectory, input.state_directory);
    published = true;
    const verification = verifyStateLineageBeforeOpen(
      preopenExpectation(input.state_directory, input.binding, input.schemas),
    );
    return Object.freeze({
      state_directory: input.state_directory,
      verification,
    });
  } catch (error) {
    if (!published && existsSync(stagingDirectory)) {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
