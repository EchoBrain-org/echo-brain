import type Database from 'better-sqlite3';
import { assertCaptureSourceCursorV2, assertCaptureTextV1, isCanonicalTimestamp } from '@echo-brain/organization-processing/core';
import type { CaptureBookmarkV1, CaptureCursorStoreV1 } from '../../../application/capture-source-run-v1.js';

function retained(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Capture bookmark count is invalid');
}

/**
 * Bookmarks live in the capture-cursors.sqlite sidecar, never in authority.sqlite, whose
 * baseline is fresh-init only. Not atomic with custody: replay is idempotent. A bookmark
 * written under another state lineage is treated as absent, so a reset pulls from the start.
 */
export class SqliteCaptureCursorStoreV1 implements CaptureCursorStoreV1 {
  private readonly lineage: string;
  constructor(private readonly database: Database.Database, binding: { readonly state_lineage_id: string }) {
    assertCaptureTextV1(binding.state_lineage_id, 'State lineage', 256);
    this.lineage = binding.state_lineage_id;
    database.exec(`CREATE TABLE IF NOT EXISTS capture_cursors_v1 (
      source_id TEXT PRIMARY KEY NOT NULL, cursor TEXT NOT NULL, retained INTEGER NOT NULL CHECK(retained >= 0),
      adapter_id TEXT NOT NULL, instance_id TEXT NOT NULL, state_lineage_id TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`);
  }
  read(source_id: string): CaptureBookmarkV1 | undefined {
    assertCaptureTextV1(source_id, 'Capture source ID', 256);
    const row = this.database.prepare('SELECT cursor, retained, adapter_id, instance_id, state_lineage_id FROM capture_cursors_v1 WHERE source_id=?').get(source_id) as
      { cursor: unknown; retained: unknown; adapter_id: unknown; instance_id: unknown; state_lineage_id: unknown } | undefined;
    if (row === undefined || row.state_lineage_id !== this.lineage) return undefined;
    assertCaptureSourceCursorV2(row.cursor); retained(row.retained);
    assertCaptureTextV1(row.adapter_id, 'Capture bookmark adapter'); assertCaptureTextV1(row.instance_id, 'Capture bookmark adapter instance');
    return Object.freeze({ cursor: row.cursor, retained: row.retained, adapter_id: row.adapter_id, instance_id: row.instance_id });
  }
  write(input: CaptureBookmarkV1 & { readonly source_id: string; readonly updated_at: string }): void {
    assertCaptureTextV1(input.source_id, 'Capture source ID', 256); assertCaptureSourceCursorV2(input.cursor); retained(input.retained);
    assertCaptureTextV1(input.adapter_id, 'Capture bookmark adapter'); assertCaptureTextV1(input.instance_id, 'Capture bookmark adapter instance');
    if (!isCanonicalTimestamp(input.updated_at)) throw new Error('Capture bookmark time must be canonical UTC');
    this.database.prepare(`INSERT INTO capture_cursors_v1(source_id,cursor,retained,adapter_id,instance_id,state_lineage_id,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor, retained=excluded.retained, adapter_id=excluded.adapter_id,
        instance_id=excluded.instance_id, state_lineage_id=excluded.state_lineage_id, updated_at=excluded.updated_at`)
      .run(input.source_id, input.cursor, input.retained, input.adapter_id, input.instance_id, this.lineage, input.updated_at);
  }
  clear(source_id: string): void {
    assertCaptureTextV1(source_id, 'Capture source ID', 256);
    this.database.prepare('DELETE FROM capture_cursors_v1 WHERE source_id=?').run(source_id);
  }
}
