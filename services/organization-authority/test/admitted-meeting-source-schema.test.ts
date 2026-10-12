import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { seedOwnerWithAdmission } from "./fixtures/authority-admission-seed.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-29T00:00:00.000Z";
/** A personal source key; the admission table keys every source by its own text key. */
const SOURCE_KEY = "pms_fixture";

const databases: ReturnType<typeof openAuthorityDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function openedCurrentDatabase() {
  const database = openAuthorityDatabase(":memory:");
  databases.push(database);
  applyAuthorityBaseline(database);
  return database;
}

describe("Authority admitted meeting-source schema", () => {
  it('cannot attach progress to a different source admission', () => {
    const database = openedCurrentDatabase();
    seedOwnerWithAdmission(database, SOURCE_KEY, NOW);
    expect(() => database.prepare(`INSERT INTO authority_live_source_progress_v2
      (source_key,admission_semantic_input_sha256,cursor,cursor_version,updated_at)
      VALUES ('another-person',?,'cursor',0,?)`).run(DIGEST, NOW)).toThrow(/FOREIGN KEY/);
  });
  it('persists personal intake settings without another meeting body and requires ordered mapping changes', () => {
    const database = openedCurrentDatabase();
    seedOwnerWithAdmission(database, SOURCE_KEY, NOW);
    database.prepare('INSERT INTO authority_person_meeting_sources_v2 VALUES (?, ?, NULL, NULL, 0)').run(SOURCE_KEY, DIGEST);
    expect(() => database.prepare('UPDATE authority_person_meeting_sources_v2 SET settings_revision=2 WHERE source_key=?').run(SOURCE_KEY)).toThrow('ordered');
    expect(() => database.prepare('UPDATE authority_person_meeting_sources_v2 SET folder_id=?,settings_revision=1 WHERE source_key=?').run('folder', SOURCE_KEY)).toThrow('CHECK');
    expect(database.prepare('SELECT settings_revision FROM authority_person_meeting_sources_v2').pluck().get()).toBe(0);
    expect((database.pragma('table_info(authority_person_meeting_sources_v2)') as { name: string }[]).map(row => row.name)).toEqual(['source_key', 'person_key', 'folder_id', 'folder_project_id', 'settings_revision']);
    expect((database.pragma('table_info(authority_person_meeting_suggestions_v1)') as { name: string }[]).map(row => row.name)).toEqual(['source_key', 'external_id', 'project_id', 'created_at']);
    expect((database.pragma('table_info(authority_person_meeting_pending_suggestions_v1)') as { name: string }[]).map(row => row.name)).toEqual(['source_key', 'external_id', 'project_id', 'created_at']);
    expect((database.pragma('table_info(authority_approval_decisions_v1)') as { name: string }[]).map(row => row.name)).toEqual(['sequence', 'approval_id', 'command_id', 'surface', 'action', 'body_json', 'receipt_json']);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all();
    expect(tables).not.toContain('authority_person_meeting_approval_actions_v1');
    expect(tables).not.toContain('authority_live_approval_delivery_quarantines_v1');
  });
  it("is a provider-neutral schema", () => {
    const database = openedCurrentDatabase();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[];
    expect(tables).toEqual(
      expect.arrayContaining([
        "authority_live_source_admission_v2",
        "authority_live_source_progress_v2",
        "authority_live_source_candidates_v2",
        "authority_live_source_review_lineage_heads_v2",
        "authority_live_approval_outbox_v2",
      ]),
    );
    expect(tables).not.toContain("authority_clean_granola_source_admission_v1");
    expect(tables).not.toContain("authority_private_approval_assignments_v3");
    expect(tables).not.toContain("authority_private_approval_terminal_receipts_v3");
    expect(
      database
        .prepare("SELECT count(*) FROM sqlite_master WHERE lower(sql) LIKE '%granola%'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("accepts opaque provider cursors while retaining ordered, immutable state", () => {
    const database = openedCurrentDatabase();
    seedOwnerWithAdmission(database, SOURCE_KEY, NOW);
    database
      .prepare(
        `INSERT INTO authority_live_source_progress_v2 (
          source_key, admission_semantic_input_sha256, cursor, cursor_version, updated_at
        ) VALUES (?, ?, 'not-a-granola-prefix', 0, ?)`,
      )
      .run(SOURCE_KEY, DIGEST, NOW);
    database
      .prepare(
        `UPDATE authority_live_source_progress_v2
         SET cursor = 'arbitrary-provider-cursor', cursor_version = 1, updated_at = ?
         WHERE source_key = ?`,
      )
      .run(NOW, SOURCE_KEY);
    expect(() =>
      database
        .prepare(
          `UPDATE authority_live_source_progress_v2
           SET cursor = 'same-version', cursor_version = 1, updated_at = ?
           WHERE source_key = ?`,
        )
        .run(NOW, SOURCE_KEY),
    ).toThrow(/ordered cursor advances/);
    expect(() =>
      database
        .prepare("UPDATE authority_live_source_admission_v2 SET cutoff_at = ?")
        .run(NOW),
    ).toThrow(/admission is immutable/);
  });
});
