import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";
import type { JsonValue } from "@echo-brain/federation-protocol";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  STATE_LINEAGE_MANIFEST_TABLE,
  STATE_LINEAGE_ROLES_V2,
  STATE_LINEAGE_ROLE_APPLICATION_IDS_V1,
  STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME,
  STATE_LINEAGE_ROOT_MANIFEST_V2_KIND,
  stateLineageDatabaseManifestSha256V1,
  stateLineageDatabaseSlotsV2,
  stateLineageRootManifestSha256V2,
  validateStateLineageDatabaseManifestV1,
  validateStateLineageRootManifestV2,
  validateStoredStateLineageDatabaseManifestV1,
} from "../../src/state-lineage/state-lineage-manifest-v1.js";
import {
  databaseManifestBody as goldenDatabaseManifest,
  rootManifestBody as goldenRootManifest,
} from "./state-lineage-fixtures.js";

const ROOT_MANIFEST_SHA256 =
  "sha256:cec1c3a2f923fa568bb1a595a9589fa8c22b12d4b2d91365113f0872c4509f57";
const DATABASE_MANIFEST_SHA256 =
  "sha256:286138c1afb64727afb40b2be70297ee3edc32171cafa4e71ca3f4670002f9c9";

describe("state-lineage manifest contracts", () => {
  it("freezes the canonical root manifest and golden digest", () => {
    const body = validateStateLineageRootManifestV2(goldenRootManifest());
    expect(Object.isFrozen(body)).toBe(true);
    expect(body.databases).toHaveLength(6);
    expect(body.databases.map((slot) => slot.role)).toEqual([
      ...STATE_LINEAGE_ROLES_V2,
    ]);
    expect(stateLineageRootManifestSha256V2(goldenRootManifest())).toBe(
      ROOT_MANIFEST_SHA256,
    );
    expect(STATE_LINEAGE_ROOT_MANIFEST_V2_FILENAME).toBe(
      "state-lineage-root.v2.json",
    );
  });

  it("pins the six role identities, locations, and application IDs", () => {
    const ascii = (value: number): string =>
      Buffer.from([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ]).toString("latin1");
    // Every fresh database carries its shipped role ID. These IDs stay stable
    // across schema versions; manifest and schema digests bind the lineage.
    expect(STATE_LINEAGE_ROLE_APPLICATION_IDS_V1).toEqual({
      authority: 0x45434155,
      "control-plane": 0x45434f50,
      "record-log": 0x4543524c,
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
      "retrieval-facts": "ERFT",
      "retrieval-lexical": "ERLX",
      "retrieval-content": "ERCT",
    });
    const slots = stateLineageDatabaseSlotsV2();
    expect(
      slots
        .filter((slot) => slot.location.kind === "state_file")
        .map((slot) => [slot.role, slot.location.filename]),
    ).toEqual([
      ["authority", "authority.sqlite"],
      ["control-plane", "integrations.sqlite"],
      ["record-log", "record-log.sqlite"],
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
    // Domain separation: the two kinds can never verify as one another.
    expect(() =>
      validateStateLineageDatabaseManifestV1({
        ...goldenDatabaseManifest(),
        kind: STATE_LINEAGE_ROOT_MANIFEST_V2_KIND,
      }),
    ).toThrowError(/kind is unsupported/);
    expect(() =>
      validateStateLineageRootManifestV2({
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
    const row = {
      singleton: 1,
      manifest_json: canonical,
      manifest_sha256: DATABASE_MANIFEST_SHA256,
    };
    for (const [name, change, pattern] of [
      ["padded json", { manifest_json: ` ${canonical}` }, /not canonical/],
      [
        "mismatched digest",
        {
          manifest_sha256:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        /does not match its body/,
      ],
      ["singleton 2", { singleton: 2 }, /singleton must be 1/],
      ["invalid json", { manifest_json: "not json {" }, /is not JSON/],
    ] as const) {
      expect(
        () => validateStoredStateLineageDatabaseManifestV1({ ...row, ...change }),
        name,
      ).toThrowError(pattern);
    }
  });

  it("rejects mutated, reordered, and hostile bodies", () => {
    const base = goldenRootManifest();
    for (const key of Object.keys(base)) {
      const missing = { ...base };
      delete (missing as Record<string, unknown>)[key];
      expect(
        () => validateStateLineageRootManifestV2(missing),
        `missing ${key}`,
      ).toThrowError();
    }
    expect(() =>
      validateStateLineageRootManifestV2({ ...base, extra: true }),
    ).toThrowError(/unexpected shape/);
    expect(() =>
      validateStateLineageRootManifestV2({ ...base, schema_version: 1 }),
    ).toThrowError(/schema_version is unsupported/);
    expect(() =>
      validateStateLineageRootManifestV2({
        ...base,
        creating_artifact_revision: null,
      }),
    ).toThrowError(/bounded canonical text/);

    const slots = (goldenRootManifest().databases as unknown[]).slice();
    const first = slots[0] as Record<string, unknown>;
    for (const [name, databases, pattern] of [
      ["swapped", [slots[1], slots[0], ...slots.slice(2)], /out of canonical order/],
      ["duplicated", [slots[0], slots[0], ...slots.slice(2)], /out of canonical order/],
      ["retired", [...slots, { role: "record-derived", location: { kind: "state_file", filename: "record-derived.sqlite" }, application_id: 0x45435244 }], /every state-lineage role exactly once/],
      ["short", slots.slice(0, 5), /every state-lineage role exactly once/],
      ["wrongId", [{ ...first, application_id: 0x45434f50 }, ...slots.slice(1)], /application_id does not match/],
      ["wrongFile", [{ ...first, location: { kind: "state_file", filename: "integrations.sqlite" } }, ...slots.slice(1)], /does not match the canonical location/],
    ] as const) {
      expect(
        () => validateStateLineageRootManifestV2({ ...goldenRootManifest(), databases }),
        name,
      ).toThrowError(pattern);
    }

    let getterCalls = 0;
    const hostile = Object.defineProperty(goldenRootManifest(), "kind", {
      get() {
        getterCalls += 1;
        return STATE_LINEAGE_ROOT_MANIFEST_V2_KIND;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => validateStateLineageRootManifestV2(hostile)).toThrowError(
      /enumerable data properties/,
    );
    expect(getterCalls).toBe(0);
    const symboled = goldenRootManifest();
    (symboled as Record<PropertyKey, unknown>)[Symbol("x")] = 1;
    expect(() => validateStateLineageRootManifestV2(symboled)).toThrowError(
      /symbol properties/,
    );
    expect(() =>
      validateStateLineageRootManifestV2(
        Object.assign(Object.create({ inherited: true }), goldenRootManifest()),
      ),
    ).toThrowError(/plain object/);
  });

  const root = { validate: validateStateLineageRootManifestV2, golden: goldenRootManifest };
  const database = { validate: validateStateLineageDatabaseManifestV1, golden: goldenDatabaseManifest };
  it.each([
    ["padded state_lineage_id", root, "state_lineage_id", " padded", /bounded canonical text/],
    ["overlong state_lineage_id", root, "state_lineage_id", "a".repeat(129), /bounded canonical text/],
    ["control-character state_lineage_id", root, "state_lineage_id", "control\u0007char", /bounded canonical text/],
    ["created_at without milliseconds", root, "created_at", "2026-08-21T00:00:00Z", undefined],
    ["created_at with an offset", root, "created_at", "2026-08-21T00:00:00.000+00:00", undefined],
    ["negative database_schema_version", database, "database_schema_version", -1, /nonnegative safe integer/],
    ["fractional database_schema_version", database, "database_schema_version", 1.5, /nonnegative safe integer/],
    ["short schema_sha256", database, "schema_sha256", "sha256:short", undefined],
    ["unsupported role", database, "role", "authority-2", /not a supported state-lineage role/],
    ["retired derived role", database, "role", "record-derived", /not a supported state-lineage role/],
    ["non-UUID authority_id", database, "authority_id", "oau_not-a-uuid", undefined],
  ] as const)(
    "rejects non-canonical text, timestamps, and version bounds: %s",
    (_name, { validate, golden }, field, value, pattern) => {
      expect(() => validate({ ...golden(), [field]: value })).toThrowError(pattern);
    },
  );

  it("keeps every role's database manifest digest distinct", () => {
    const digests = new Set(
      STATE_LINEAGE_ROLES_V2.map((role) =>
        stateLineageDatabaseManifestSha256V1(goldenDatabaseManifest(role)),
      ),
    );
    expect(digests.size).toBe(6);
  });
});
