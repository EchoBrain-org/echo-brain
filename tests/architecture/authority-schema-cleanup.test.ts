import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import { OrganizationRecordAppenderV4, PersonRecordReaderV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { initializeAuthorityStateLineageV1, type InitializeAuthorityStateLineageV1Input } from "../../services/organization-authority/src/state-lineage/authority-state-lineage-initializer.js";
import { STATE_LINEAGE_ROLE_APPLICATION_IDS_V1, type StateLineageRoleV1 } from "@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { COORDINATES, appendInput, protocolAuthority } from "../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { convertAuthoritySchemaCleanup, inspectAuthoritySchemaCleanup } from "../../tools/authority-schema-cleanup.mjs";

const roots: string[] = [];
const repo = resolve(import.meta.dirname, "../..");
const now = "2026-09-12T00:00:00.000Z";
const artifact = "a".repeat(40);
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps the historical recovery SQL byte-pinned outside runtime artifacts", () => {
  for (const [path, expected] of [
    ["packages/organization-authority-kernel/baselines/authority-approval-delivery-quarantine-v4.sql", "sha256:8b794b37802f8ec4b07b16bb86cd9b50e289c49ee1da3a157b871c46a386b022"],
    ["packages/organization-authority-kernel/baselines/authority-baseline-v1.sql", "sha256:007a1498dd1db87d03ba2876086c5ec6b6c655f77e5c25691abafd18451465d6"],
    ["packages/organization-authority-kernel/baselines/authority-meeting-processing-v3.sql", "sha256:fa9f46b6b6e5ecffb1908e46899894addb5bb42ff1e0f10ddb65d9a0de4c46e8"],
    ["packages/organization-authority-kernel/baselines/authority-private-approval-v2.sql", "sha256:28bdc61d6536040e589af11754b3d4fe2faee46c482ea15a407741d03722b4d7"],
    ["packages/organization-control-plane/baselines/organization-control-plane-baseline-v1.sql", "sha256:90eb0939f930d3dbd8abc51b98d2af42eb3d75471ff244f026fd52aff7d8d030"],
    ["packages/organization-control-plane/baselines/organization-control-plane-private-approval-v2.sql", "sha256:23b791c1b8f6a89f4913b41795f2be551ba7b221072caa690579d7cd6017b5bb"],
    ["packages/organization-record/baselines/organization-record-derived-baseline-v1.sql", "sha256:06f5ac7ee52a3a6be7583743db99c7d75c32923b559388e2b7a52bf26d76d99d"],
    ["packages/organization-record/baselines/organization-record-log-baseline-v1.sql", "sha256:4362ff17a61c2896f8825c2788287503355c5c9be9470464f23315dc058c33f9"],
    ["packages/organization-record/baselines/organization-record-log-baseline-v2.sql", "sha256:7cecee2317e76aad6a7f4c0155e0da7e7018e4ebe9c5fc6e1c587ad9f6ed38a9"],
    ["packages/organization-retrieval/baselines/readable-search-facts-baseline-v1.sql", "sha256:86ae26a03c4b2b38cc2c2e27833127188a609b2e4396a0dbf121d9db6b53e74e"],
  ]) expect(sha256Digest(readFileSync(join(repo, path!), "utf8"))).toBe(expected);
});

// Exact pre-cleanup schemas. These immutable assets remain conversion fixtures.
function fixture() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "echo-offline-schema-")); chmodSync(parent, 0o700); roots.push(parent);
  const source = join(parent, "source"), output = join(parent, "output");
  const definitions: [StateLineageRoleV1, number, string, string[]][] = [
    ["authority", 4, "organization-authority-kernel", ["authority-baseline-v1.sql", "authority-meeting-processing-v3.sql", "authority-approval-delivery-quarantine-v4.sql"]],
    ["control-plane", 2, "organization-control-plane", ["organization-control-plane-baseline-v1.sql", "organization-control-plane-private-approval-v2.sql"]],
    ["record-log", 2, "organization-record", ["organization-record-log-baseline-v2.sql"]],
    ["record-derived", 1, "organization-record", ["organization-record-derived-baseline-v1.sql"]],
    ["retrieval-facts", 2, "organization-retrieval", ["readable-search-facts-baseline-v2.sql"]],
    ["retrieval-lexical", 1, "organization-retrieval", ["readable-search-lexical-baseline-v1.sql"]],
    ["retrieval-content", 1, "organization-retrieval", ["readable-search-content-baseline-v1.sql"]],
  ];
  const sql = Object.fromEntries(definitions.map(([role, , directory, files]) => [role, files.map(file => readFileSync(join(repo, "packages", directory, "baselines", file), "utf8")).join("\n")]));
  initializeAuthorityStateLineageV1({ state_directory: source, binding: COORDINATES, created_at: now, creating_artifact_revision: "2f338552c16de80ad73600e86dd66cf78a11af4f",
    schemas: Object.fromEntries(definitions.map(([role, version]) => [role, { database_schema_version: version, schema_sha256: sha256Digest(sql[role]!) }])) as InitializeAuthorityStateLineageV1Input["schemas"],
    top_level_appliers: Object.fromEntries(definitions.slice(0, 4).map(([role, version]) => [role, { apply: (db: Database.Database) => { db.exec(sql[role]!); db.pragma(`application_id = ${STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[role]}`); db.pragma(`user_version = ${version}`); } }])) as InitializeAuthorityStateLineageV1Input["top_level_appliers"],
    open_writable_database: path => new Database(path),
  });
  const db = new Database(join(source, "authority.sqlite"));
  db.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Fixture', '{}', ?, ?)").run(COORDINATES.authority_id, COORDINATES.organization_id, now, now);
  db.prepare("INSERT INTO authority_principals VALUES ('prn_fixture', ?, 'Owner', ?)").run(COORDINATES.organization_id, now);
  db.prepare("INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at) VALUES ('mem_fixture', ?, 'prn_fixture', 'owner', 'active', ?)").run(COORDINATES.organization_id, now);
  db.close();
  const control = new Database(join(source, "integrations.sqlite"));
  control.pragma("foreign_keys = ON");
  control.prepare("INSERT INTO organization_control_plane_metadata VALUES (1, 'ocp_fixture', ?, ?, ?, ?)").run(COORDINATES.organization_id, COORDINATES.authority_id, sha256Digest("descriptor"), now);
  control.prepare("INSERT INTO organization_tool_connection_contracts VALUES ('con_fixture', ?, ?, ?)").run(canonicalJson({ fixture: "connection", secret_handle: "opaque-fixture-handle" }), sha256Digest("connection"), now);
  control.prepare("INSERT INTO organization_tool_connection_current_state VALUES ('con_fixture', ?, '{}', ?, 'active', ?)").run(sha256Digest("connection"), sha256Digest("state"), now);
  control.close();
  mkdirSync(join(source, "keys"), { mode: 0o700 });
  writeFileSync(join(source, "keys", "fixture-key"), "synthetic private bytes", { mode: 0o600 });
  return { parent, source, output };
}

it("converts populated records without changing identities, signed bytes, permissions or replay", async () => {
  const { source, output } = fixture();
  const authority = protocolAuthority();
  const input = appendInput({ authority, approval_id: "retained-restricted" });
  const db = new Database(join(source, "record-log.sqlite"));
  db.prepare("INSERT INTO organization_record_log_metadata VALUES (1, ?, ?, ?, ?)").run(COORDINATES.authority_id, COORDINATES.organization_id, COORDINATES.state_lineage_id, now);
  const appended = await new OrganizationRecordAppenderV4(db, COORDINATES).append(input);
  const member = await new OrganizationRecordAppenderV4(db, COORDINATES).append(appendInput({ authority, approval_id: "retained-member-readable", policy_id: "organization-member-readable-person-v2" }));
  const recordsBefore = db.prepare("SELECT * FROM organization_record_log").all();
  const receiptsBefore = db.prepare("SELECT * FROM organization_record_signed_receipt").all();
  const readerInput = { ...COORDINATES, principal_id: "principal-1", membership_id: "membership-1" };
  const readableBefore = new PersonRecordReaderV1(db).list(readerInput);
  expect(readableBefore).toHaveLength(2);
  db.close();
  const checked = inspectAuthoritySchemaCleanup(source);
  const receipt = convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact });
  expect(receipt).toMatchObject({ source_unchanged: true, retained_rows_unchanged: true, retired_tables: 22 });
  expect(inspectAuthoritySchemaCleanup(source)).toEqual(checked);
  expect(verifyAuthorityStateLineage(output).root).toMatchObject({ ...COORDINATES, schema_version: 2 });
  expect(existsSync(join(output, "record-derived.sqlite"))).toBe(false);
  expect(readFileSync(join(output, "keys", "fixture-key"))).toEqual(readFileSync(join(source, "keys", "fixture-key")));
  const converted = new Database(join(output, "record-log.sqlite"));
  try {
    expect(converted.prepare("SELECT * FROM organization_record_log").all()).toEqual(recordsBefore);
    expect(converted.prepare("SELECT * FROM organization_record_signed_receipt").all()).toEqual(receiptsBefore);
    expect(new PersonRecordReaderV1(converted).list(readerInput)).toEqual(readableBefore);
    expect(new PersonRecordReaderV1(converted).list({ ...readerInput, principal_id: "other", membership_id: "other" }).map(row => row.record_sha256)).toEqual([member.record_sha256]);
    expect(await new OrganizationRecordAppenderV4(converted, COORDINATES).append(input)).toEqual({ ...appended, outcome: "duplicate" });
  } finally { converted.close(); }
  const identities = new Database(join(output, "authority.sqlite"), { readonly: true });
  expect(identities.prepare("SELECT membership_id FROM authority_memberships").all()).toEqual([{ membership_id: "mem_fixture" }]);
  identities.close();
  const control = new Database(join(output, "integrations.sqlite"));
  try {
    expect(control.prepare("SELECT current_status, connection_contract_sha256 FROM organization_tool_connection_current_state").get()).toEqual({ current_status: "active", connection_contract_sha256: sha256Digest("connection") });
    expect(() => control.prepare("UPDATE organization_tool_connection_contracts SET contract_json = '{}'").run()).toThrow("immutable");
    expect(control.pragma("foreign_key_check")).toEqual([]);
  } finally { control.close(); }
});

it("refuses drift and never publishes a partial output or changes the source", () => {
  const { source, output, parent } = fixture();
  const checked = inspectAuthoritySchemaCleanup(source);
  writeFileSync(join(source, "changed"), "changed", { mode: 0o600 });
  expect(() => convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact })).toThrow("source_changed");
  expect(existsSync(output)).toBe(false);
  const db = new Database(join(source, "authority.sqlite")); db.exec("CREATE TABLE unexpected (value TEXT)"); db.close();
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("schema_drift");
  expect(readdirSync(parent)).toEqual(["source"]);
});

it.each([
  "CREATE TABLE sqliteXunregistered (payload TEXT)",
  "CREATE INDEX sqliteXunregistered ON authority_memberships(status)",
  "CREATE TRIGGER echo_state_lineage_manifest AFTER UPDATE ON authority_memberships BEGIN SELECT 1; END",
])("refuses schema objects whose names resemble exempt metadata: %s", (sql) => {
  const { source, output } = fixture();
  const db = new Database(join(source, "authority.sqlite"));
  db.exec(sql);
  db.close();
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("schema_drift");
  expect(existsSync(output)).toBe(false);
});

it("refuses historical contents in a retired table instead of deleting them", () => {
  const { source, output } = fixture();
  const db = new Database(join(source, "record-derived.sqlite"));
  db.prepare("INSERT INTO organization_derived_cursor VALUES (1, 5, ?)").run(now); db.close();
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("derived_state_not_empty");
  expect(existsSync(output)).toBe(false);
});

it("refuses nonempty retired projection tables and leaves their evidence intact", () => {
  const { source } = fixture();
  const db = new Database(join(source, "record-derived.sqlite"));
  db.prepare("INSERT INTO organization_derived_edge VALUES ('supports', 'old-a', 'old-b', 1)").run();
  db.close();
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("retired_table_not_empty");
  const retained = new Database(join(source, "record-derived.sqlite"), { readonly: true });
  expect(retained.prepare("SELECT count(*) AS n FROM organization_derived_edge").get()).toEqual({ n: 1 });
  retained.close();
});

it("discards an interrupted output and allows a retry against the unchanged source", () => {
  const { source, output, parent } = fixture();
  const checked = inspectAuthoritySchemaCleanup(source);
  const execute = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql === "DROP TABLE authority_record_write_inputs") throw new Error("injected-copy-failure");
    return execute.call(this, sql);
  });
  const convert = () => convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact });
  expect(convert).toThrow("injected-copy-failure");
  vi.restoreAllMocks();
  expect(readdirSync(parent)).toEqual(["source"]);
  expect(inspectAuthoritySchemaCleanup(source)).toEqual(checked);
  expect(convert()).toMatchObject({ retained_rows_unchanged: true });
});

it("does not publish output when copied bytes cannot be flushed", () => {
  const { source, output, parent } = fixture();
  const checked = inspectAuthoritySchemaCleanup(source);
  vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("injected-flush-failure"); });
  syncBuiltinESMExports();
  expect(() => convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact })).toThrow("injected-flush-failure");
  expect(readdirSync(parent)).toEqual(["source"]);
  expect(inspectAuthoritySchemaCleanup(source)).toEqual(checked);
});

it("identifies a published output whose final directory flush is unconfirmed", () => {
  const { source, output, parent } = fixture();
  const checked = inspectAuthoritySchemaCleanup(source);
  const parentIdentity = fs.statSync(parent);
  const flush = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const file = fs.fstatSync(fd);
    if (file.dev === parentIdentity.dev && file.ino === parentIdentity.ino) throw new Error("injected-parent-flush-failure");
    flush(fd);
  });
  syncBuiltinESMExports();
  let failure: unknown;
  try { convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({
    message: "schema_cleanup_output_published_sync_unconfirmed",
    cause: { kind: "echo-authority-schema-cleanup-publication-pending-v1", source_inventory_sha256: checked.source_inventory_sha256, output_inventory_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(verifyAuthorityStateLineage(output).root.schema_version).toBe(2);
  expect(inspectAuthoritySchemaCleanup(source)).toEqual(checked);
  expect(readdirSync(parent).sort()).toEqual(["output", "source"]);
});

it("rejects unknown lineage, symlinks, hot journals and existing destinations", () => {
  const { source, output } = fixture();
  const checked = inspectAuthoritySchemaCleanup(source);
  mkdirSync(output, { mode: 0o700 });
  const convert = () => convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256: checked.source_inventory_sha256, artifactSourceSha: artifact });
  expect(convert).toThrow("output_exists");
  symlinkSync(join(source, "keys", "fixture-key"), join(source, "link"));
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("unsafe_entry"); rmSync(join(source, "link"));
  writeFileSync(join(source, "authority.sqlite-wal"), "journal", { mode: 0o600 });
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow("database_not_offline"); rmSync(join(source, "authority.sqlite-wal"));
  const path = join(source, "state-lineage-root.v1.json"), root = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, canonicalJson({ ...root, schema_version: 999 }));
  expect(() => inspectAuthoritySchemaCleanup(source)).toThrow();
});
