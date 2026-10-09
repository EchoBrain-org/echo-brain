import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import type { JsonValue } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROLES_V2,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
  STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME,
  stateLineageDatabaseSlotsV2,
} from "../../src/state-lineage/state-lineage-manifest-v1.js";
import type { StateLineageRoleV2 } from "../../src/state-lineage/state-lineage-manifest-v1.js";
import {
  StateLineagePreopenRefusal,
  verifyStateLineageBeforeOpen,
} from "../../src/state-lineage/state-lineage-preopen-guard.js";
import type {
  StateLineagePreopenExpectationV1,
  StateLineageRefusalFamilyV1,
} from "../../src/state-lineage/state-lineage-preopen-guard.js";
import {
  AUTHORITY_ID,
  ORGANIZATION_ID,
  SCHEMA_SHA256,
  STATE_LINEAGE_ID,
  databaseManifestBody,
  rootManifestBody,
} from "./state-lineage-fixtures.js";
import type { ManifestBindingOverrides } from "./state-lineage-fixtures.js";

const OTHER_AUTHORITY_ID = "oau_33333333-3333-4333-8333-333333333333";
const GENERATION_ID = "gen-0000000000000001";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface DatabaseOptions {
  readonly binding?: ManifestBindingOverrides;
  readonly applicationId?: number;
  readonly userVersion?: number;
  readonly omitManifestTable?: boolean;
  readonly omitManifestRow?: boolean;
  readonly duplicateManifestRow?: boolean;
  readonly manifestBody?: Record<string, unknown>;
  readonly withPointerRow?: boolean;
  readonly pointerGenerationId?: string;
}

interface FixtureOverrides {
  readonly binding?: ManifestBindingOverrides;
  readonly withRetrievalTree?: boolean;
  readonly withPointerRow?: boolean;
  readonly pointerGenerationId?: string;
  /** State files written as this role with these options instead of the default. */
  readonly replace?: Readonly<
    Record<string, readonly [StateLineageRoleV2, DatabaseOptions]>
  >;
}

function writeLineageDatabase(
  path: string,
  role: StateLineageRoleV2,
  options: DatabaseOptions = {},
): void {
  const database = new Database(path);
  try {
    // Fixture writes need no durability; the guard reads every file read-only.
    database.pragma("synchronous = OFF");
    database.pragma(
      `application_id = ${String(
        options.applicationId ?? STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[role],
      )}`,
    );
    database.pragma(`user_version = ${String(options.userVersion ?? 1)}`);
    if (options.omitManifestTable === true) return;
    database.exec(
      `CREATE TABLE ${STATE_LINEAGE_MANIFEST_TABLE} (
         singleton INTEGER NOT NULL,
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       )`,
    );
    if (options.omitManifestRow !== true) {
      const body =
        options.manifestBody ?? databaseManifestBody(role, options.binding);
      const canonical = canonicalJson(body as unknown as JsonValue);
      const digest = canonicalSha256(body as unknown as JsonValue);
      const insert = database.prepare(
        `INSERT INTO ${STATE_LINEAGE_MANIFEST_TABLE}
         (singleton, manifest_json, manifest_sha256) VALUES (?, ?, ?)`,
      );
      insert.run(1, canonical, digest);
      if (options.duplicateManifestRow === true) {
        insert.run(1, canonical, digest);
      }
    }
    if (options.withPointerRow === true) {
      database.exec(
        `CREATE TABLE authority_readable_search_active_generation (
           singleton INTEGER NOT NULL,
           organization_id TEXT NOT NULL,
           generation_id TEXT NOT NULL
         )`,
      );
      database
        .prepare(
          `INSERT INTO authority_readable_search_active_generation
           (singleton, organization_id, generation_id) VALUES (?, ?, ?)`,
        )
        .run(1, ORGANIZATION_ID, options.pointerGenerationId ?? GENERATION_ID);
    }
  } finally {
    database.close();
  }
}

function buildFixture(overrides: FixtureOverrides = {}): string {
  const root = mkdtempSync(join(tmpdir(), "echo-lineage-guard-"));
  temporaryRoots.push(root);
  writeFileSync(
    join(root, STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME),
    canonicalJson(rootManifestBody(overrides.binding) as unknown as JsonValue),
  );
  for (const slot of stateLineageDatabaseSlotsV2()) {
    if (slot.location.kind !== "state_file") continue;
    const [role, options] = overrides.replace?.[slot.location.filename] ?? [
      slot.role,
      {
        binding: overrides.binding,
        withPointerRow: slot.role === "authority" && overrides.withPointerRow,
        pointerGenerationId: overrides.pointerGenerationId,
      },
    ];
    writeLineageDatabase(join(root, slot.location.filename), role, options);
  }
  if (overrides.withRetrievalTree === true) {
    const segmentDir = join(
      root,
      "record-retrieval",
      "generations",
      GENERATION_ID,
      "segments",
      "seg-0001",
    );
    mkdirSync(segmentDir, { recursive: true });
    writeFileSync(
      join(
        root,
        "record-retrieval",
        "generations",
        GENERATION_ID,
        "manifest.json",
      ),
      "{}",
    );
    for (const [filename, role] of [
      ["facts.sqlite", "retrieval-facts"],
      ["lexical.sqlite", "retrieval-lexical"],
      ["content.sqlite", "retrieval-content"],
    ] as const) {
      writeLineageDatabase(join(segmentDir, filename), role, {
        binding: overrides.binding,
      });
    }
  }
  return root;
}

/** A default fixture whose `filename` state file is written as `role` with `options`. */
function replaced(
  filename: string,
  role: StateLineageRoleV2,
  options: DatabaseOptions,
): string {
  return buildFixture({ replace: { [filename]: [role, options] } });
}

function expectation(stateDirectory: string): StateLineagePreopenExpectationV1 {
  return {
    state_directory: stateDirectory,
    expected_binding: {
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
    },
    expected_schemas: Object.fromEntries(
      STATE_LINEAGE_ROLES_V2.map((role) => [
        role,
        { database_schema_version: 1, schema_sha256: SCHEMA_SHA256 },
      ]),
    ) as unknown as StateLineagePreopenExpectationV1["expected_schemas"],
  };
}

function expectRefusal(
  run: () => unknown,
  family: StateLineageRefusalFamilyV1,
  pattern: RegExp,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StateLineagePreopenRefusal);
  const refusal = thrown as StateLineagePreopenRefusal;
  expect(refusal.family).toBe(family);
  expect(refusal.message).toMatch(pattern);
}

function refuses(
  root: string,
  family: StateLineageRefusalFamilyV1,
  pattern: RegExp,
): void {
  expectRefusal(
    () => verifyStateLineageBeforeOpen(expectation(root)),
    family,
    pattern,
  );
}

describe("state-lineage pre-open guard", () => {
  it.each(["state-lineage-root.v1.json", "record-derived.sqlite"])(
    "refuses retired state %s alongside current state without changing files",
    (filename) => {
      const root = buildFixture();
      const retired = join(root, filename);
      writeFileSync(retired, "retired-state-sentinel");
      const paths = [retired, join(root, STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME),
        ...stateLineageDatabaseSlotsV2()
          .filter(slot => slot.location.kind === "state_file")
          .map(slot => join(root, slot.location.filename))];
      const before = paths.map(path => readFileSync(path));
      refuses(root, "legacy_state", /unsupported|retired/);
      expect(paths.map(path => readFileSync(path))).toEqual(before);
    },
  );

  it("verifies a coherent state directory without a retrieval tree", () => {
    const root = buildFixture();
    const result = verifyStateLineageBeforeOpen(expectation(root));
    expect(result.root.state_lineage_id).toBe(STATE_LINEAGE_ID);
    expect(result.databases).toHaveLength(3);
    expect(result.retrieval).toEqual({
      present: false,
      generation_count: 0,
      segment_count: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("verifies a retrieval tree and a satisfied active-generation pointer", () => {
    const root = buildFixture({
      withRetrievalTree: true,
      withPointerRow: true,
    });
    const result = verifyStateLineageBeforeOpen(expectation(root));
    expect(result.databases).toHaveLength(6);
    expect(result.retrieval).toEqual({
      present: true,
      generation_count: 1,
      segment_count: 1,
    });
  });

  it("requires an explicit absolute state directory", () => {
    expectRefusal(
      () =>
        verifyStateLineageBeforeOpen({
          ...expectation("/tmp/none"),
          state_directory: "relative/path",
        }),
      "invalid_input",
      /explicit absolute path/,
    );
  });

  it("refuses a missing root manifest, database, or manifest row", () => {
    const noRoot = buildFixture();
    rmSync(join(noRoot, STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME));
    refuses(noRoot, "missing_manifest", /has no state-lineage-root\.v2\.json/);

    const noDatabase = buildFixture();
    rmSync(join(noDatabase, "record-log.sqlite"));
    refuses(noDatabase, "missing_database", /record-log database record-log\.sqlite is missing/);

    const noRow = replaced("integrations.sqlite", "control-plane", {
      omitManifestRow: true,
    });
    refuses(noRow, "missing_manifest", /lineage manifest row is missing/);
  });

  it("refuses a non-canonical root manifest", () => {
    const root = buildFixture();
    const body = rootManifestBody();
    writeFileSync(
      join(root, STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME),
      `${canonicalJson(body as unknown as JsonValue)}\n`,
    );
    refuses(root, "missing_manifest", /not canonical bytes/);
  });

  it("refuses legacy state with no upgrade attempted", () => {
    const root = replaced("authority.sqlite", "authority", {
      omitManifestTable: true,
    });
    refuses(root, "legacy_state", /no automatic upgrade exists/);
  });

  it("refuses duplicated manifest rows", () => {
    const root = replaced("integrations.sqlite", "control-plane", {
      duplicateManifestRow: true,
    });
    refuses(root, "duplicated_manifest", /2 lineage manifest rows/);
  });

  it("refuses wrong-role and swapped databases even when each is self-consistent", () => {
    const wrongRole = replaced("record-log.sqlite", "record-log", {
      manifestBody: databaseManifestBody("control-plane"),
      applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-log"],
    });
    refuses(wrongRole, "wrong_role", /carries a control-plane manifest where record-log is required/);

    const swapped = buildFixture({
      replace: {
        "record-log.sqlite": ["control-plane", {
          applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["control-plane"],
        }],
        "integrations.sqlite": ["record-log", {
          applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-log"],
        }],
      },
    });
    refuses(swapped, "wrong_role", /carries a record-log manifest where control-plane is required/);
  });

  it("refuses a wrong application ID for the role", () => {
    const root = replaced("integrations.sqlite", "control-plane", {
      applicationId: 0x45434350,
    });
    refuses(root, "wrong_application_id", /does not match the control-plane role/);
  });

  it("refuses an inexact schema version in header or manifest", () => {
    const headerDrift = replaced("authority.sqlite", "authority", {
      userVersion: 2,
    });
    refuses(headerDrift, "schema_version_mismatch", /schema version is not exactly 1/);

    const manifestDrift = replaced("authority.sqlite", "authority", {
      manifestBody: {
        ...databaseManifestBody("authority"),
        database_schema_version: 2,
      },
    });
    refuses(manifestDrift, "schema_version_mismatch", /schema version is not exactly 1/);
  });

  it("refuses an artifact/state schema-digest mismatch in either direction", () => {
    const root = replaced("record-log.sqlite", "record-log", {
      manifestBody: {
        ...databaseManifestBody("record-log"),
        schema_sha256: `sha256:${"c".repeat(64)}`,
      },
    });
    refuses(root, "artifact_state_mismatch", /schema digest does not match the running artifact/);

    const invalidRow = replaced("record-log.sqlite", "record-log", {
      manifestBody: {
        ...databaseManifestBody("record-log"),
        schema_sha256: "sha256:not-a-digest",
      },
    });
    refuses(invalidRow, "missing_manifest", /lineage manifest row is invalid/);
  });

  it("distinguishes wrong-binding from mixed-binding refusals", () => {
    const wrong = buildFixture({
      binding: { authority_id: OTHER_AUTHORITY_ID },
    });
    refuses(wrong, "wrong_binding", /authority_id does not match the expected binding/);

    const mixed = replaced("integrations.sqlite", "control-plane", {
      binding: { state_lineage_id: "lineage-other" },
    });
    refuses(mixed, "mixed_binding", /disagrees with itself on state_lineage_id/);
  });

  it("refuses partial-publish debris", () => {
    const rootDebris = buildFixture();
    writeFileSync(join(rootDebris, ".rebuilding-abc123"), "");
    refuses(rootDebris, "partial_publish", /unfinished publish debris \.rebuilding-abc123/);

    for (const filename of [
      ".integrations.sqlite.installing-abc123",
      ".integrations.sqlite.rebuilding-def456",
    ]) {
      const preparedFileDebris = buildFixture();
      writeFileSync(join(preparedFileDebris, filename), "");
      refuses(
        preparedFileDebris,
        "partial_publish",
        new RegExp(`unfinished publish debris ${filename.replace(/\./g, "\\.")}`),
      );
    }

    const stagingDebris = buildFixture({ withRetrievalTree: true });
    mkdirSync(
      join(stagingDebris, "record-retrieval", "generations", ".staging-ffff"),
    );
    refuses(stagingDebris, "partial_publish", /unfinished publish debris \.staging-ffff/);

    const bareGeneration = buildFixture({ withRetrievalTree: true });
    rmSync(
      join(
        bareGeneration,
        "record-retrieval",
        "generations",
        GENERATION_ID,
        "manifest.json",
      ),
    );
    refuses(bareGeneration, "partial_publish", /has no manifest\.json/);
  });

  it("refuses an active-generation pointer naming an absent generation", () => {
    const root = buildFixture({
      withRetrievalTree: true,
      withPointerRow: true,
      pointerGenerationId: "gen-that-never-published",
    });
    refuses(root, "dangling_generation_pointer", /gen-that-never-published/);

    const noTree = buildFixture({ withPointerRow: true });
    refuses(noTree, "dangling_generation_pointer", /is not a published generation directory/);
  });

  it("refuses a missing retrieval plane inside an existing segment", () => {
    const root = buildFixture({ withRetrievalTree: true });
    rmSync(
      join(
        root,
        "record-retrieval",
        "generations",
        GENERATION_ID,
        "segments",
        "seg-0001",
        "lexical.sqlite",
      ),
    );
    refuses(root, "missing_database", /retrieval-lexical database .* is missing/);
  });

  it("refuses malformed expectations, corrupt databases, and broken symlinks as families", () => {
    const root = buildFixture();
    expectRefusal(
      () =>
        verifyStateLineageBeforeOpen({
          ...expectation(root),
          expected_binding: undefined as never,
        }),
      "invalid_input",
      /expected_binding must name/,
    );
    const partialSchemas = expectation(root);
    expectRefusal(
      () =>
        verifyStateLineageBeforeOpen({
          ...partialSchemas,
          expected_schemas: {
            authority: partialSchemas.expected_schemas.authority,
          } as never,
        }),
      "invalid_input",
      /must give the control-plane role/,
    );

    const corrupt = buildFixture();
    rmSync(join(corrupt, "authority.sqlite"));
    writeFileSync(join(corrupt, "authority.sqlite"), "not a sqlite database");
    refuses(corrupt, "missing_database", /could not be (?:opened read-only as|read as) a SQLite database/);

    const dangling = buildFixture({ withRetrievalTree: true });
    symlinkSync(
      join(dangling, "no-such-target"),
      join(dangling, "record-retrieval", "generations", "gen-broken-link"),
    );
    refuses(dangling, "partial_publish", /generation entry gen-broken-link is unreadable publish debris/);
  });

  it("never writes: fixture bytes are identical before and after the guard", () => {
    const root = buildFixture({
      withRetrievalTree: true,
      withPointerRow: true,
    });
    const paths = [
      join(root, "authority.sqlite"),
      join(root, "integrations.sqlite"),
      join(root, "record-log.sqlite"),
      join(root, STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME),
    ];
    const before = paths.map((path) => readFileSync(path));
    const first = verifyStateLineageBeforeOpen(expectation(root));
    const second = verifyStateLineageBeforeOpen(expectation(root));
    const after = paths.map((path) => readFileSync(path));
    for (let index = 0; index < paths.length; index += 1) {
      expect(after[index]?.equals(before[index] as Buffer), paths[index]).toBe(
        true,
      );
    }
    expect(second.root).toEqual(first.root);
    expect(second.databases.map((entry) => entry.manifest)).toEqual(
      first.databases.map((entry) => entry.manifest),
    );
  });
});
