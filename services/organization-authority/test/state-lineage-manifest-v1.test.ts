import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";
import type { JsonValue } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROLES_V1,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
  STATE_LINEAGE_ROOT_MANIFEST_FILENAME,
  STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
  stateLineageDatabaseManifestSha256V1,
  stateLineageDatabaseSlotsV1,
  stateLineageRootManifestSha256V1,
  validateStateLineageDatabaseManifestV1,
  validateStateLineageRootManifestV1,
  validateStoredStateLineageDatabaseManifestV1,
} from "../src/state-lineage/state-lineage-manifest-v1.js";
import type { StateLineageRoleV1 } from "../src/state-lineage/state-lineage-manifest-v1.js";

const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const STATE_LINEAGE_ID = "lineage-2026-08-21-fresh-baseline";
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const ARTIFACT_REVISION = "42dd37a0000000000000000000000000000000aa";

const ROOT_MANIFEST_SHA256 =
  "sha256:98d89794f60ecc414cd9ee79b681b72493300b7bfb04877f6dcb5743f6988a1e";
const DATABASE_MANIFEST_SHA256 =
  "sha256:286138c1afb64727afb40b2be70297ee3edc32171cafa4e71ca3f4670002f9c9";

function goldenRootManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
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

function goldenDatabaseManifest(
  role: StateLineageRoleV1 = "authority",
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    database_schema_version: 1,
    schema_sha256:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT_REVISION,
  };
}

describe("private state-lineage manifest v1 contracts", () => {
  it("freezes the canonical root manifest and golden digest", () => {
    const body = validateStateLineageRootManifestV1(goldenRootManifest());
    expect(Object.isFrozen(body)).toBe(true);
    expect(body.databases).toHaveLength(7);
    expect(body.databases.map((slot) => slot.role)).toEqual([
      ...STATE_LINEAGE_ROLES_V1,
    ]);
    expect(stateLineageRootManifestSha256V1(goldenRootManifest())).toBe(
      ROOT_MANIFEST_SHA256,
    );
    expect(STATE_LINEAGE_ROOT_MANIFEST_FILENAME).toBe(
      "state-lineage-root.v1.json",
    );
  });

  it("pins the seven role identities, locations, and application IDs", () => {
    const ascii = (value: number): string =>
      Buffer.from([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ]).toString("latin1");
    // Six values are the shipped constants; authority is the single new
    // assignment and no current authority.sqlite carries it, by design:
    // control-plane from services/organization-control-plane/src/persistence/
    // migrate.ts, record roles from services/organization-record/src/
    // persistence/database-definition.ts, retrieval roles from
    // services/organization-retrieval/src/persistence/database-definition.ts.
    expect(STATE_LINEAGE_ROLE_APPLICATION_IDS_V1).toEqual({
      authority: 0x45434155,
      "control-plane": 0x45434f50,
      "record-log": 0x4543524c,
      "record-derived": 0x45435244,
      "retrieval-facts": 0x45524654,
      "retrieval-lexical": 0x45524c58,
      "retrieval-content": 0x45524354,
    });
    expect(
      Object.fromEntries(
        Object.entries(STATE_LINEAGE_ROLE_APPLICATION_IDS_V1).map(
          ([role, id]) => [role, ascii(id)],
        ),
      ),
    ).toEqual({
      authority: "ECAU",
      "control-plane": "ECOP",
      "record-log": "ECRL",
      "record-derived": "ECRD",
      "retrieval-facts": "ERFT",
      "retrieval-lexical": "ERLX",
      "retrieval-content": "ERCT",
    });
    const slots = stateLineageDatabaseSlotsV1();
    expect(
      slots
        .filter((slot) => slot.location.kind === "state_file")
        .map((slot) => [slot.role, slot.location.filename]),
    ).toEqual([
      ["authority", "authority.sqlite"],
      ["control-plane", "integrations.sqlite"],
      ["record-log", "record-log.sqlite"],
      ["record-derived", "record-derived.sqlite"],
    ]);
    for (const slot of slots) {
      if (slot.location.kind === "retrieval_segment_tree") {
        expect(slot.location.directory).toBe("record-retrieval");
        expect(["facts.sqlite", "lexical.sqlite", "content.sqlite"]).toContain(
          slot.location.filename,
        );
      }
    }
    expect(STATE_LINEAGE_MANIFEST_TABLE).toBe("echo_state_lineage_manifest");
  });

  it("freezes the database manifest, stored row, and golden digest", () => {
    const body = validateStateLineageDatabaseManifestV1(
      goldenDatabaseManifest(),
    );
    expect(Object.isFrozen(body)).toBe(true);
    expect(stateLineageDatabaseManifestSha256V1(goldenDatabaseManifest())).toBe(
      DATABASE_MANIFEST_SHA256,
    );
    const stored = validateStoredStateLineageDatabaseManifestV1({
      singleton: 1,
      manifest_json: canonicalJson(body as unknown as JsonValue),
      manifest_sha256: DATABASE_MANIFEST_SHA256,
    });
    expect(stored.manifest_sha256).toBe(DATABASE_MANIFEST_SHA256);
    expect(stored.body.role).toBe("authority");
    // Domain separation: the two kinds can never verify as one another, and
    // aligned content still yields distinct digests.
    expect(ROOT_MANIFEST_SHA256).not.toBe(DATABASE_MANIFEST_SHA256);
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
      }),
    ).toThrowError(/kind is unsupported/);
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
      }),
    ).toThrowError(/kind is unsupported/);
  });

  it("rejects tampered, non-canonical, and mismatched stored rows", () => {
    const body = validateStateLineageDatabaseManifestV1(
      goldenDatabaseManifest(),
    );
    const canonical = canonicalJson(body as unknown as JsonValue);
    expect(() =>
      validateStoredStateLineageDatabaseManifestV1({
        singleton: 1,
        manifest_json: ` ${canonical}`,
        manifest_sha256: DATABASE_MANIFEST_SHA256,
      }),
    ).toThrowError(/not canonical/);
    expect(() =>
      validateStoredStateLineageDatabaseManifestV1({
        singleton: 1,
        manifest_json: canonical,
        manifest_sha256:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrowError(/does not match its body/);
    expect(() =>
      validateStoredStateLineageDatabaseManifestV1({
        singleton: 2,
        manifest_json: canonical,
        manifest_sha256: DATABASE_MANIFEST_SHA256,
      }),
    ).toThrowError(/singleton must be 1/);
    expect(() =>
      validateStoredStateLineageDatabaseManifestV1({
        singleton: 1,
        manifest_json: "not json {",
        manifest_sha256: DATABASE_MANIFEST_SHA256,
      }),
    ).toThrowError(/is not JSON/);
  });

  it("rejects mutated, reordered, and hostile bodies", () => {
    const base = goldenRootManifest();
    for (const key of Object.keys(base)) {
      const missing = { ...base };
      delete (missing as Record<string, unknown>)[key];
      expect(
        () => validateStateLineageRootManifestV1(missing),
        `missing ${key}`,
      ).toThrowError();
    }
    expect(() =>
      validateStateLineageRootManifestV1({ ...base, extra: true }),
    ).toThrowError(/unexpected shape/);
    expect(() =>
      validateStateLineageRootManifestV1({ ...base, schema_version: 2 }),
    ).toThrowError(/schema_version is unsupported/);
    expect(() =>
      validateStateLineageRootManifestV1({
        ...base,
        creating_artifact_revision: null,
      }),
    ).toThrowError(/bounded canonical text/);

    const slots = (goldenRootManifest().databases as unknown[]).slice();
    const swapped = goldenRootManifest();
    swapped.databases = [slots[1], slots[0], ...slots.slice(2)];
    expect(() => validateStateLineageRootManifestV1(swapped)).toThrowError(
      /out of canonical order/,
    );
    const duplicated = goldenRootManifest();
    duplicated.databases = [slots[0], slots[0], ...slots.slice(2)];
    expect(() => validateStateLineageRootManifestV1(duplicated)).toThrowError(
      /out of canonical order/,
    );
    const short = goldenRootManifest();
    short.databases = slots.slice(0, 6);
    expect(() => validateStateLineageRootManifestV1(short)).toThrowError(
      /every state-lineage role exactly once/,
    );
    const wrongId = goldenRootManifest();
    const wrongIdSlot = {
      ...(slots[0] as Record<string, unknown>),
      application_id: 0x45434f50,
    };
    wrongId.databases = [wrongIdSlot, ...slots.slice(1)];
    expect(() => validateStateLineageRootManifestV1(wrongId)).toThrowError(
      /application_id does not match/,
    );
    const wrongFile = goldenRootManifest();
    const wrongFileSlot = {
      ...(slots[0] as Record<string, unknown>),
      location: { kind: "state_file", filename: "integrations.sqlite" },
    };
    wrongFile.databases = [wrongFileSlot, ...slots.slice(1)];
    expect(() => validateStateLineageRootManifestV1(wrongFile)).toThrowError(
      /does not match the canonical location/,
    );

    let getterCalls = 0;
    const hostile = Object.defineProperty(goldenRootManifest(), "kind", {
      get() {
        getterCalls += 1;
        return STATE_LINEAGE_ROOT_MANIFEST_V1_KIND;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => validateStateLineageRootManifestV1(hostile)).toThrowError(
      /enumerable data properties/,
    );
    expect(getterCalls).toBe(0);
    const symboled = goldenRootManifest();
    (symboled as Record<PropertyKey, unknown>)[Symbol("x")] = 1;
    expect(() => validateStateLineageRootManifestV1(symboled)).toThrowError(
      /symbol properties/,
    );
    expect(() =>
      validateStateLineageRootManifestV1(
        Object.assign(Object.create({ inherited: true }), goldenRootManifest()),
      ),
    ).toThrowError(/plain object/);
  });

  it("rejects non-canonical text, timestamps, and version bounds", () => {
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        state_lineage_id: " padded",
      }),
    ).toThrowError(/bounded canonical text/);
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        state_lineage_id: "a".repeat(129),
      }),
    ).toThrowError(/bounded canonical text/);
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        state_lineage_id: "control\u0007char",
      }),
    ).toThrowError(/bounded canonical text/);
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        created_at: "2026-08-21T00:00:00Z",
      }),
    ).toThrowError();
    expect(() =>
      validateStateLineageRootManifestV1({
        ...goldenRootManifest(),
        created_at: "2026-08-21T00:00:00.000+00:00",
      }),
    ).toThrowError();
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        database_schema_version: -1,
      }),
    ).toThrowError(/nonnegative safe integer/);
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        database_schema_version: 1.5,
      }),
    ).toThrowError(/nonnegative safe integer/);
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        schema_sha256: "sha256:short",
      }),
    ).toThrowError();
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        role: "authority-2",
      }),
    ).toThrowError(/not a supported state-lineage role/);
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        authority_id: "oau_not-a-uuid",
      }),
    ).toThrowError();
  });

  it("keeps every role's database manifest digest distinct", () => {
    const digests = new Set(
      STATE_LINEAGE_ROLES_V1.map((role) =>
        stateLineageDatabaseManifestSha256V1(goldenDatabaseManifest(role)),
      ),
    );
    expect(digests.size).toBe(7);
  });
});
