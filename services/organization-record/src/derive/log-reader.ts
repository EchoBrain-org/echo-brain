import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow } from '../application/contracts.js';
import {
  toOrganizationRecordLogRow,
  type RawOrganizationRecordLogRow,
} from '../application/log-row.js';
import type { OrganizationRecordLogReaderPort } from '../application/ports.js';

/**
 * Derive's read side of the log.
 *
 * Append, derive, and retrieve are three separate logical machines that never
 * call each other. This reader is derive's whole view of the log: rows at
 * rest, no append entry point, no authority handle, nothing to write.
 */
export class OrganizationRecordLogReader implements OrganizationRecordLogReaderPort {
  constructor(private readonly database: Database.Database) {}

  readAfter(position: number, limit: number): readonly OrganizationRecordLogRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM organization_record_log
           WHERE position > ?
           ORDER BY position
           LIMIT ?`,
        )
        .all(position, limit) as RawOrganizationRecordLogRow[]
    ).map(toOrganizationRecordLogRow);
  }
}
