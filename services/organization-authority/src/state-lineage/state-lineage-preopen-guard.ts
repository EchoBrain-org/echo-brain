import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson } from "@echo-brain/federation-protocol";
import type { JsonValue, Sha256Digest } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_RETRIEVAL_DIRECTORY,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
  STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
  stateLineageDatabaseSlotsV1,
  validateStateLineageRootManifestV1,
  validateStoredStateLineageDatabaseManifestV1,
} from "./state-lineage-manifest-v1.js";
import type {
  StateLineageDatabaseManifestV1,
  StateLineageRoleV1,
  StateLineageRootManifestV1,
} from "./state-lineage-manifest-v1.js";

/**
 * Read-only pre-open verifier for one versioned Authority state directory.
 *
 * The guard takes an explicit state directory and expectation — no default,
 * no discovery, no environment read — and either returns a verified coherence
 * result or throws a refusal naming its family: a state condition from the
 * canonical refusal matrix of the lineage contract, or `invalid_input` for a
 * malformed caller expectation, which is a caller-error family outside that
 * state matrix. It opens every database strictly read-only with `query_only`
 * on, never creates, migrates, checkpoints, or writes, and is deliberately
 * called from no composition root. Symlinks inside the state directory are
 * followed, exactly as the production openers would follow them: the guard
 * verifies the bytes those openers would open, wherever they resolve.
 *
 * Wiring this guard into composition is NOT authorized until the four
 * open-database entry points are split into open-then-migrate: today each of
 * them migrates inside the open call, so a guard wired in front of them would
 * be advisory rather than blocking.
 */

export type StateLineageRefusalFamilyV1 =
  | "invalid_input"
  | "missing_manifest"
  | "missing_database"
  | "legacy_state"
  | "duplicated_manifest"
  | "wrong_role"
  | "wrong_binding"
  | "mixed_binding"
  | "wrong_application_id"
  | "schema_version_mismatch"
  | "artifact_state_mismatch"
  | "partial_publish"
  | "dangling_generation_pointer";

export class StateLineagePreopenRefusal extends Error {
  readonly family: StateLineageRefusalFamilyV1;

  constructor(family: StateLineageRefusalFamilyV1, message: string) {
    super(message);
    this.name = "StateLineagePreopenRefusal";
    this.family = family;
  }
}

export interface StateLineageExpectedBindingV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface StateLineageExpectedSchemaV1 {
  readonly database_schema_version: number;
  readonly schema_sha256: Sha256Digest;
}

export interface StateLineagePreopenExpectationV1 {
  readonly state_directory: string;
  readonly expected_binding: StateLineageExpectedBindingV1;
  readonly expected_schemas: Readonly<
    Record<StateLineageRoleV1, StateLineageExpectedSchemaV1>
  >;
}

export interface VerifiedStateLineageDatabaseV1 {
  readonly role: StateLineageRoleV1;
  readonly path: string;
  readonly manifest: StateLineageDatabaseManifestV1;
}

export interface VerifiedStateLineageRetrievalTreeV1 {
  readonly present: boolean;
  readonly generation_count: number;
  readonly segment_count: number;
}

export interface StateLineagePreopenResultV1 {
  readonly root: StateLineageRootManifestV1;
  readonly databases: readonly VerifiedStateLineageDatabaseV1[];
  readonly retrieval: VerifiedStateLineageRetrievalTreeV1;
}

const ACTIVE_GENERATION_TABLE =
  "authority_readable_search_active_generation" as const;
const GENERATIONS_DIRECTORY = "generations" as const;
const GENERATION_MANIFEST_FILENAME = "manifest.json" as const;
const SEGMENTS_DIRECTORY = "segments" as const;
// Historical and current publishers use both a bare operation prefix
// (`.installing-...`) and a prepared-file suffix
// (`.integrations.sqlite.installing-...`). Accept neither as state: either
// name signals an interrupted publish that must refuse before opening.
const STATE_ROOT_DEBRIS =
  /^\.(?:(?:installing|rebuilding)-|.+\.(?:installing|rebuilding)-)/;
const GENERATIONS_DEBRIS = /^\.staging-/;

function refuse(family: StateLineageRefusalFamilyV1, message: string): never {
  throw new StateLineagePreopenRefusal(family, message);
}

interface InspectedDatabase {
  readonly application_id: number;
  readonly user_version: number;
  readonly manifest: StateLineageDatabaseManifestV1;
  readonly pointer_generation_id: string | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function validatedExpectation(
  expectation: StateLineagePreopenExpectationV1,
): void {
  const binding = expectation.expected_binding as unknown;
  if (
    binding === null ||
    typeof binding !== "object" ||
    ["authority_id", "organization_id", "state_lineage_id"].some((key) => {
      const value = (binding as Record<string, unknown>)[key];
      return typeof value !== "string" || value.length === 0;
    })
  ) {
    refuse(
      "invalid_input",
      "expected_binding must name authority_id, organization_id, and state_lineage_id",
    );
  }
  const schemas = expectation.expected_schemas as unknown;
  if (schemas === null || typeof schemas !== "object") {
    refuse("invalid_input", "expected_schemas must cover every role");
  }
  for (const slot of stateLineageDatabaseSlotsV1()) {
    const entry = (schemas as Record<string, unknown>)[slot.role] as
      Record<string, unknown> | undefined;
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isSafeInteger(entry.database_schema_version) ||
      (entry.database_schema_version as number) < 0 ||
      typeof entry.schema_sha256 !== "string" ||
      !DIGEST.test(entry.schema_sha256)
    ) {
      refuse(
        "invalid_input",
        `expected_schemas must give the ${slot.role} role an exact schema version and digest`,
      );
    }
  }
}

/** A stat that folds unreadable entries into a familied refusal. */
function statEntry(path: string, label: string): Stats {
  try {
    return statSync(path);
  } catch {
    refuse("partial_publish", `${label} is unreadable publish debris`);
  }
}

/** Opens SQLite read-only and never creates, migrates, checkpoints, or writes. */
function inspectDatabase(
  databasePath: string,
  role: StateLineageRoleV1,
  label: string,
): InspectedDatabase {
  let database: Database.Database;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
  } catch {
    refuse(
      "missing_database",
      `${label} could not be opened read-only as a SQLite database`,
    );
  }
  try {
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    const applicationId = database.pragma("application_id", {
      simple: true,
    }) as number;
    const userVersion = database.pragma("user_version", {
      simple: true,
    }) as number;
    const tables = new Set(
      (
        database
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    if (!tables.has(STATE_LINEAGE_MANIFEST_TABLE)) {
      refuse(
        "legacy_state",
        `${label} has no ${STATE_LINEAGE_MANIFEST_TABLE} table and is not versioned Authority state; no automatic upgrade exists`,
      );
    }
    const rows = database
      .prepare(
        `SELECT singleton, manifest_json, manifest_sha256
         FROM ${STATE_LINEAGE_MANIFEST_TABLE}`,
      )
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      refuse("missing_manifest", `${label} lineage manifest row is missing`);
    }
    if (rows.length > 1) {
      refuse(
        "duplicated_manifest",
        `${label} holds ${String(rows.length)} lineage manifest rows`,
      );
    }
    let stored;
    try {
      stored = validateStoredStateLineageDatabaseManifestV1({
        singleton: rows[0]?.singleton,
        manifest_json: rows[0]?.manifest_json,
        manifest_sha256: rows[0]?.manifest_sha256,
      });
    } catch (error) {
      refuse(
        "missing_manifest",
        `${label} lineage manifest row is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let pointerGenerationId: string | null = null;
    if (role === "authority" && tables.has(ACTIVE_GENERATION_TABLE)) {
      const pointer = database
        .prepare(`SELECT generation_id FROM ${ACTIVE_GENERATION_TABLE}`)
        .all() as Array<{ generation_id: unknown }>;
      if (pointer.length > 0) {
        const generationId = pointer[0]?.generation_id;
        if (typeof generationId !== "string" || generationId.length === 0) {
          refuse(
            "dangling_generation_pointer",
            `${label} active-generation pointer names no generation`,
          );
        }
        pointerGenerationId = generationId;
      }
    }
    return {
      application_id: applicationId,
      user_version: userVersion,
      manifest: stored.body,
      pointer_generation_id: pointerGenerationId,
    };
  } catch (error) {
    if (error instanceof StateLineagePreopenRefusal) throw error;
    refuse(
      "missing_database",
      `${label} could not be read as a SQLite database`,
    );
  } finally {
    database.close();
  }
}

function verifyDatabase(
  inspected: InspectedDatabase,
  role: StateLineageRoleV1,
  expectation: StateLineagePreopenExpectationV1,
  label: string,
): StateLineageDatabaseManifestV1 {
  const manifest = inspected.manifest;
  // Roles are location-determined, so a duplicated role always surfaces here
  // as a wrong-role manifest at the duplicated location; the matrix's
  // duplicated-manifest family is the duplicated stored row, refused above.
  if (manifest.role !== role) {
    refuse(
      "wrong_role",
      `${label} carries a ${manifest.role} manifest where ${role} is required`,
    );
  }
  if (
    inspected.application_id !== STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[role]
  ) {
    refuse(
      "wrong_application_id",
      `${label} application_id ${String(inspected.application_id)} does not match the ${role} role`,
    );
  }
  const expectedSchema = expectation.expected_schemas[role];
  if (
    inspected.user_version !== expectedSchema.database_schema_version ||
    manifest.database_schema_version !== expectedSchema.database_schema_version
  ) {
    refuse(
      "schema_version_mismatch",
      `${label} schema version is not exactly ${String(expectedSchema.database_schema_version)}`,
    );
  }
  if (manifest.schema_sha256 !== expectedSchema.schema_sha256) {
    refuse(
      "artifact_state_mismatch",
      `${label} schema digest does not match the running artifact's ${role} schema`,
    );
  }
  return manifest;
}

function checkCoherence(
  bindings: ReadonlyArray<{
    readonly label: string;
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  }>,
  expected: StateLineageExpectedBindingV1,
): void {
  for (const dimension of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
  ] as const) {
    const values = new Set(bindings.map((binding) => binding[dimension]));
    if (values.size > 1) {
      refuse(
        "mixed_binding",
        `opened state disagrees with itself on ${dimension}`,
      );
    }
    const [value] = values;
    if (value !== expected[dimension]) {
      refuse(
        "wrong_binding",
        `opened state ${dimension} does not match the expected binding`,
      );
    }
  }
}

function readRootManifest(stateDirectory: string): StateLineageRootManifestV1 {
  const rootPath = join(stateDirectory, STATE_LINEAGE_ROOT_MANIFEST_FILENAME);
  if (!existsSync(rootPath)) {
    refuse(
      "missing_manifest",
      `state directory has no ${STATE_LINEAGE_ROOT_MANIFEST_FILENAME}`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(rootPath, "utf8");
  } catch {
    refuse("missing_manifest", "root manifest could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    refuse("missing_manifest", "root manifest is not JSON");
  }
  let root;
  try {
    root = validateStateLineageRootManifestV1(parsed);
  } catch (error) {
    refuse(
      "missing_manifest",
      `root manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (raw !== canonicalJson(root as unknown as JsonValue)) {
    refuse("missing_manifest", "root manifest is not canonical bytes");
  }
  return root;
}

function scanStateRootDebris(stateDirectory: string): void {
  for (const entry of readdirSync(stateDirectory)) {
    if (STATE_ROOT_DEBRIS.test(entry)) {
      refuse(
        "partial_publish",
        `state directory holds unfinished publish debris ${entry}`,
      );
    }
  }
}

interface RetrievalScan {
  readonly tree: VerifiedStateLineageRetrievalTreeV1;
  readonly generation_ids: ReadonlySet<string>;
  readonly databases: readonly VerifiedStateLineageDatabaseV1[];
}

function scanRetrievalTree(
  stateDirectory: string,
  expectation: StateLineagePreopenExpectationV1,
  bindings: Array<{
    label: string;
    authority_id: string;
    organization_id: string;
    state_lineage_id: string;
  }>,
): RetrievalScan {
  const retrievalRoot = join(stateDirectory, STATE_LINEAGE_RETRIEVAL_DIRECTORY);
  if (!existsSync(retrievalRoot)) {
    return {
      tree: { present: false, generation_count: 0, segment_count: 0 },
      generation_ids: new Set(),
      databases: [],
    };
  }
  const generationsRoot = join(retrievalRoot, GENERATIONS_DIRECTORY);
  if (!existsSync(generationsRoot)) {
    return {
      tree: { present: true, generation_count: 0, segment_count: 0 },
      generation_ids: new Set(),
      databases: [],
    };
  }
  const generationIds = new Set<string>();
  const databases: VerifiedStateLineageDatabaseV1[] = [];
  let segmentCount = 0;
  const retrievalSlots = stateLineageDatabaseSlotsV1().filter(
    (slot) => slot.location.kind === "retrieval_segment_tree",
  );
  for (const entry of readdirSync(generationsRoot)) {
    if (GENERATIONS_DEBRIS.test(entry)) {
      refuse(
        "partial_publish",
        `retrieval generations hold unfinished publish debris ${entry}`,
      );
    }
    const generationPath = join(generationsRoot, entry);
    if (!statEntry(generationPath, `generation entry ${entry}`).isDirectory())
      continue;
    if (!existsSync(join(generationPath, GENERATION_MANIFEST_FILENAME))) {
      refuse(
        "partial_publish",
        `generation ${entry} has no ${GENERATION_MANIFEST_FILENAME}`,
      );
    }
    generationIds.add(entry);
    const segmentsRoot = join(generationPath, SEGMENTS_DIRECTORY);
    if (!existsSync(segmentsRoot)) continue;
    for (const segment of readdirSync(segmentsRoot)) {
      const segmentPath = join(segmentsRoot, segment);
      if (!statEntry(segmentPath, `segment entry ${segment}`).isDirectory())
        continue;
      segmentCount += 1;
      for (const slot of retrievalSlots) {
        if (slot.location.kind !== "retrieval_segment_tree") continue;
        const label = `${slot.role} database for generation ${entry} segment ${segment}`;
        const planePath = join(segmentPath, slot.location.filename);
        if (!existsSync(planePath)) {
          refuse("missing_database", `${label} is missing`);
        }
        const inspected = inspectDatabase(planePath, slot.role, label);
        const manifest = verifyDatabase(
          inspected,
          slot.role,
          expectation,
          label,
        );
        bindings.push({
          label,
          authority_id: manifest.authority_id,
          organization_id: manifest.organization_id,
          state_lineage_id: manifest.state_lineage_id,
        });
        databases.push(
          Object.freeze({ role: slot.role, path: planePath, manifest }),
        );
      }
    }
  }
  return {
    tree: {
      present: true,
      generation_count: generationIds.size,
      segment_count: segmentCount,
    },
    generation_ids: generationIds,
    databases,
  };
}

/**
 * Verify one state directory against an explicit expectation without opening
 * anything writable. Returns the verified coherence result or throws a
 * `StateLineagePreopenRefusal` naming the canonical refusal family.
 */
export function verifyStateLineageBeforeOpen(
  expectation: StateLineagePreopenExpectationV1,
): StateLineagePreopenResultV1 {
  const stateDirectory = expectation.state_directory;
  if (
    typeof stateDirectory !== "string" ||
    stateDirectory.length === 0 ||
    !isAbsolute(stateDirectory)
  ) {
    refuse(
      "invalid_input",
      "state_directory must be an explicit absolute path",
    );
  }
  validatedExpectation(expectation);
  if (!existsSync(stateDirectory)) {
    refuse("missing_database", "state directory does not exist");
  }
  scanStateRootDebris(stateDirectory);
  const root = readRootManifest(stateDirectory);
  const bindings: Array<{
    label: string;
    authority_id: string;
    organization_id: string;
    state_lineage_id: string;
  }> = [
    {
      label: "root manifest",
      authority_id: root.authority_id,
      organization_id: root.organization_id,
      state_lineage_id: root.state_lineage_id,
    },
  ];
  const databases: VerifiedStateLineageDatabaseV1[] = [];
  let pointerGenerationId: string | null = null;
  for (const slot of root.databases) {
    if (slot.location.kind !== "state_file") continue;
    const label = `${slot.role} database ${slot.location.filename}`;
    const databasePath = join(stateDirectory, slot.location.filename);
    if (!existsSync(databasePath)) {
      refuse("missing_database", `${label} is missing`);
    }
    const inspected = inspectDatabase(databasePath, slot.role, label);
    const manifest = verifyDatabase(inspected, slot.role, expectation, label);
    bindings.push({
      label,
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
    });
    databases.push(
      Object.freeze({ role: slot.role, path: databasePath, manifest }),
    );
    if (slot.role === "authority") {
      pointerGenerationId = inspected.pointer_generation_id;
    }
  }
  const retrieval = scanRetrievalTree(stateDirectory, expectation, bindings);
  checkCoherence(bindings, expectation.expected_binding);
  if (
    pointerGenerationId !== null &&
    !retrieval.generation_ids.has(pointerGenerationId)
  ) {
    refuse(
      "dangling_generation_pointer",
      `active-generation pointer names ${pointerGenerationId}, which is not a published generation directory`,
    );
  }
  return Object.freeze({
    root,
    databases: Object.freeze([...databases, ...retrieval.databases]),
    retrieval: retrieval.tree,
  });
}
