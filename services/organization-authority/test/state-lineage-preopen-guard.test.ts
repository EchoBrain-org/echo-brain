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
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROLES_V1,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
  STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
  STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
  stateLineageDatabaseSlotsV1,
} from "../src/state-lineage/state-lineage-manifest-v1.js";
import type { StateLineageRoleV1 } from "../src/state-lineage/state-lineage-manifest-v1.js";
import {
  StateLineagePreopenRefusal,
  verifyStateLineageBeforeOpen,
} from "../src/state-lineage/state-lineage-preopen-guard.js";
import type {
  StateLineagePreopenExpectationV1,
  StateLineageRefusalFamilyV1,
} from "../src/state-lineage/state-lineage-preopen-guard.js";

const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const OTHER_AUTHORITY_ID = "oau_33333333-3333-4333-8333-333333333333";
const STATE_LINEAGE_ID = "lineage-2026-08-21-fresh-baseline";
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const ARTIFACT_REVISION = "42dd37a0000000000000000000000000000000aa";
const SCHEMA_SHA256 =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GENERATION_ID = "gen-0000000000000001";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface FixtureOverrides {
  readonly binding?: {
    readonly authority_id?: string;
    readonly organization_id?: string;
    readonly state_lineage_id?: string;
  };
  readonly withRetrievalTree?: boolean;
  readonly withPointerRow?: boolean;
  readonly pointerGenerationId?: string;
}

function databaseManifestBody(
  role: StateLineageRoleV1,
  binding: FixtureOverrides["binding"] = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    authority_id: binding?.authority_id ?? AUTHORITY_ID,
    organization_id: binding?.organization_id ?? ORGANIZATION_ID,
    state_lineage_id: binding?.state_lineage_id ?? STATE_LINEAGE_ID,
    database_schema_version: 1,
    schema_sha256: SCHEMA_SHA256,
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT_REVISION,
  };
}

function writeLineageDatabase(
  path: string,
  role: StateLineageRoleV1,
  options: {
    readonly binding?: FixtureOverrides["binding"];
    readonly applicationId?: number;
    readonly userVersion?: number;
    readonly omitManifestTable?: boolean;
    readonly omitManifestRow?: boolean;
    readonly duplicateManifestRow?: boolean;
    readonly manifestBody?: Record<string, unknown>;
    readonly withPointerRow?: boolean;
    readonly pointerGenerationId?: string;
  } = {},
): void {
  const database = new Database(path);
  try {
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

function rootManifestBody(
  binding: FixtureOverrides["binding"] = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
    authority_id: binding?.authority_id ?? AUTHORITY_ID,
    organization_id: binding?.organization_id ?? ORGANIZATION_ID,
    state_lineage_id: binding?.state_lineage_id ?? STATE_LINEAGE_ID,
    databases: stateLineageDatabaseSlotsV1().map((slot) => ({
      role: slot.role,
      location:
        slot.location.kind === "state_file"
          ? { kind: "state_file", filename: slot.location.filename }
          : {
              kind: "retrieval_segment_tree",
              directory: slot.location.directory,
              filename: slot.location.filename,
            },
      application_id: slot.application_id,
    })),
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT_REVISION,
  };
}

function buildFixture(overrides: FixtureOverrides = {}): string {
  const root = mkdtempSync(join(tmpdir(), "echo-lineage-guard-"));
  temporaryRoots.push(root);
  writeFileSync(
    join(root, STATE_LINEAGE_ROOT_MANIFEST_FILENAME),
    canonicalJson(rootManifestBody(overrides.binding) as unknown as JsonValue),
  );
  for (const slot of stateLineageDatabaseSlotsV1()) {
    if (slot.location.kind !== "state_file") continue;
    writeLineageDatabase(join(root, slot.location.filename), slot.role, {
      binding: overrides.binding,
      withPointerRow: slot.role === "authority" && overrides.withPointerRow,
      pointerGenerationId: overrides.pointerGenerationId,
    });
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
    for (const filename of [
      "facts.sqlite",
      "lexical.sqlite",
      "content.sqlite",
    ]) {
      const role = (
        {
          "facts.sqlite": "retrieval-facts",
          "lexical.sqlite": "retrieval-lexical",
          "content.sqlite": "retrieval-content",
        } as const
      )[filename] as StateLineageRoleV1;
      writeLineageDatabase(join(segmentDir, filename), role, {
        binding: overrides.binding,
      });
    }
  }
  return root;
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
      STATE_LINEAGE_ROLES_V1.map((role) => [
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

describe("state-lineage pre-open guard", () => {
  it("verifies a coherent state directory without a retrieval tree", () => {
    const root = buildFixture();
    const result = verifyStateLineageBeforeOpen(expectation(root));
    expect(result.root.state_lineage_id).toBe(STATE_LINEAGE_ID);
    expect(result.databases).toHaveLength(4);
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
    expect(result.databases).toHaveLength(7);
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
    rmSync(join(noRoot, STATE_LINEAGE_ROOT_MANIFEST_FILENAME));
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(noRoot)),
      "missing_manifest",
      /has no state-lineage-root\.v1\.json/,
    );

    const noDatabase = buildFixture();
    rmSync(join(noDatabase, "record-log.sqlite"));
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(noDatabase)),
      "missing_database",
      /record-log database record-log\.sqlite is missing/,
    );

    const noRow = buildFixture();
    rmSync(join(noRow, "integrations.sqlite"));
    writeLineageDatabase(join(noRow, "integrations.sqlite"), "control-plane", {
      omitManifestRow: true,
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(noRow)),
      "missing_manifest",
      /lineage manifest row is missing/,
    );
  });

  it("refuses a non-canonical root manifest", () => {
    const root = buildFixture();
    const body = rootManifestBody();
    writeFileSync(
      join(root, STATE_LINEAGE_ROOT_MANIFEST_FILENAME),
      `${canonicalJson(body as unknown as JsonValue)}\n`,
    );
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "missing_manifest",
      /not canonical bytes/,
    );
  });

  it("refuses legacy state with no upgrade attempted", () => {
    const root = buildFixture();
    rmSync(join(root, "authority.sqlite"));
    writeLineageDatabase(join(root, "authority.sqlite"), "authority", {
      omitManifestTable: true,
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "legacy_state",
      /no automatic upgrade exists/,
    );
  });

  it("refuses duplicated manifest rows", () => {
    const root = buildFixture();
    rmSync(join(root, "record-derived.sqlite"));
    writeLineageDatabase(
      join(root, "record-derived.sqlite"),
      "record-derived",
      {
        duplicateManifestRow: true,
      },
    );
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "duplicated_manifest",
      /2 lineage manifest rows/,
    );
  });

  it("refuses wrong-role and swapped databases even when each is self-consistent", () => {
    const wrongRole = buildFixture();
    rmSync(join(wrongRole, "record-log.sqlite"));
    writeLineageDatabase(join(wrongRole, "record-log.sqlite"), "record-log", {
      manifestBody: databaseManifestBody("record-derived"),
      applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-log"],
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(wrongRole)),
      "wrong_role",
      /carries a record-derived manifest where record-log is required/,
    );

    const swapped = buildFixture();
    rmSync(join(swapped, "record-log.sqlite"));
    rmSync(join(swapped, "record-derived.sqlite"));
    writeLineageDatabase(join(swapped, "record-log.sqlite"), "record-derived", {
      applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-derived"],
    });
    writeLineageDatabase(join(swapped, "record-derived.sqlite"), "record-log", {
      applicationId: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1["record-log"],
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(swapped)),
      "wrong_role",
      /carries a record-derived manifest where record-log is required/,
    );
  });

  it("refuses a wrong application ID for the role", () => {
    const root = buildFixture();
    rmSync(join(root, "integrations.sqlite"));
    writeLineageDatabase(join(root, "integrations.sqlite"), "control-plane", {
      applicationId: 0x45434350,
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "wrong_application_id",
      /does not match the control-plane role/,
    );
  });

  it("refuses an inexact schema version in header or manifest", () => {
    const headerDrift = buildFixture();
    rmSync(join(headerDrift, "authority.sqlite"));
    writeLineageDatabase(join(headerDrift, "authority.sqlite"), "authority", {
      userVersion: 2,
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(headerDrift)),
      "schema_version_mismatch",
      /schema version is not exactly 1/,
    );

    const manifestDrift = buildFixture();
    rmSync(join(manifestDrift, "authority.sqlite"));
    writeLineageDatabase(join(manifestDrift, "authority.sqlite"), "authority", {
      manifestBody: {
        ...databaseManifestBody("authority"),
        database_schema_version: 2,
      },
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(manifestDrift)),
      "schema_version_mismatch",
      /schema version is not exactly 1/,
    );
  });

  it("refuses an artifact/state schema-digest mismatch in either direction", () => {
    const root = buildFixture();
    rmSync(join(root, "record-log.sqlite"));
    writeLineageDatabase(join(root, "record-log.sqlite"), "record-log", {
      manifestBody: {
        ...databaseManifestBody("record-log"),
        schema_sha256: `sha256:${"c".repeat(64)}`,
      },
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "artifact_state_mismatch",
      /schema digest does not match the running artifact/,
    );

    const invalidRow = buildFixture();
    rmSync(join(invalidRow, "record-log.sqlite"));
    writeLineageDatabase(join(invalidRow, "record-log.sqlite"), "record-log", {
      manifestBody: {
        ...databaseManifestBody("record-log"),
        schema_sha256: "sha256:not-a-digest",
      },
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(invalidRow)),
      "missing_manifest",
      /lineage manifest row is invalid/,
    );
  });

  it("distinguishes wrong-binding from mixed-binding refusals", () => {
    const wrong = buildFixture({
      binding: { authority_id: OTHER_AUTHORITY_ID },
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(wrong)),
      "wrong_binding",
      /authority_id does not match the expected binding/,
    );

    const mixed = buildFixture();
    rmSync(join(mixed, "integrations.sqlite"));
    writeLineageDatabase(join(mixed, "integrations.sqlite"), "control-plane", {
      binding: { state_lineage_id: "lineage-other" },
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(mixed)),
      "mixed_binding",
      /disagrees with itself on state_lineage_id/,
    );
  });

  it("refuses partial-publish debris while accepting the absent pointer state", () => {
    const rootDebris = buildFixture();
    writeFileSync(join(rootDebris, ".rebuilding-abc123"), "");
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(rootDebris)),
      "partial_publish",
      /unfinished publish debris \.rebuilding-abc123/,
    );

    for (const filename of [
      ".integrations.sqlite.installing-abc123",
      ".record-derived.sqlite.rebuilding-def456",
    ]) {
      const preparedFileDebris = buildFixture();
      writeFileSync(join(preparedFileDebris, filename), "");
      expectRefusal(
        () => verifyStateLineageBeforeOpen(expectation(preparedFileDebris)),
        "partial_publish",
        new RegExp(
          `unfinished publish debris ${filename.replace(/\./g, "\\.")}`,
        ),
      );
    }

    const stagingDebris = buildFixture({ withRetrievalTree: true });
    mkdirSync(
      join(stagingDebris, "record-retrieval", "generations", ".staging-ffff"),
    );
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(stagingDebris)),
      "partial_publish",
      /unfinished publish debris \.staging-ffff/,
    );

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
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(bareGeneration)),
      "partial_publish",
      /has no manifest\.json/,
    );

    // An absent record-retrieval tree and an absent pointer row are both the
    // legal not-built state, never refusals.
    const notBuilt = buildFixture();
    expect(
      verifyStateLineageBeforeOpen(expectation(notBuilt)).retrieval.present,
    ).toBe(false);
  });

  it("refuses an active-generation pointer naming an absent generation", () => {
    const root = buildFixture({
      withRetrievalTree: true,
      withPointerRow: true,
      pointerGenerationId: "gen-that-never-published",
    });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "dangling_generation_pointer",
      /gen-that-never-published/,
    );

    const noTree = buildFixture({ withPointerRow: true });
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(noTree)),
      "dangling_generation_pointer",
      /is not a published generation directory/,
    );
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
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(root)),
      "missing_database",
      /retrieval-lexical database .* is missing/,
    );
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
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(corrupt)),
      "missing_database",
      /could not be (?:opened read-only as|read as) a SQLite database/,
    );

    const dangling = buildFixture({ withRetrievalTree: true });
    symlinkSync(
      join(dangling, "no-such-target"),
      join(dangling, "record-retrieval", "generations", "gen-broken-link"),
    );
    expectRefusal(
      () => verifyStateLineageBeforeOpen(expectation(dangling)),
      "partial_publish",
      /generation entry gen-broken-link is unreadable publish debris/,
    );
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
      join(root, "record-derived.sqlite"),
      join(root, STATE_LINEAGE_ROOT_MANIFEST_FILENAME),
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
