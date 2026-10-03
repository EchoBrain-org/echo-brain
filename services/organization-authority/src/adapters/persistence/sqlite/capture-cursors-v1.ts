import type Database from 'better-sqlite3';
import { assertCaptureSourceCursorV2, assertCaptureTextV1, isCanonicalTimestamp } from '@echo-brain/organization-processing/core';
import type { CaptureCursorStoreV1 } from '../../../application/capture-source-run-v1.js';

/**
 * Bookmarks live in the capture-cursors.sqlite sidecar, never in authority.sqlite, whose
 * baseline is fresh-init only. Not atomic with custody: replay is idempotent.
 */
export class SqliteCaptureCursorStoreV1 implements CaptureCursorStoreV1 {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS capture_cursors_v1 (
      source_id TEXT PRIMARY KEY NOT NULL, cursor TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`);
  }
  read(source_id: string): string | undefined {
    assertCaptureTextV1(source_id, 'Capture source ID', 256);
    const row = this.database.prepare('SELECT cursor FROM capture_cursors_v1 WHERE source_id=?').get(source_id) as { cursor: unknown } | undefined;
    if (row === undefined) return undefined;
    assertCaptureSourceCursorV2(row.cursor);
    return row.cursor;
  }
  write(input: { readonly source_id: string; readonly cursor: string; readonly updated_at: string }): void {
    assertCaptureTextV1(input.source_id, 'Capture source ID', 256); assertCaptureSourceCursorV2(input.cursor);
    if (!isCanonicalTimestamp(input.updated_at)) throw new Error('Capture bookmark time must be canonical UTC');
    this.database.prepare(`INSERT INTO capture_cursors_v1(source_id,cursor,updated_at) VALUES (?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`).run(input.source_id, input.cursor, input.updated_at);
  }
}
