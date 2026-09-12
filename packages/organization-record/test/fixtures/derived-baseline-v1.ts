import { readFileSync } from 'node:fs';
import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';

/** Historical seven-role fixture only; never shipped as a runtime initializer. */
export const ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1 = 1;

const BASELINE_SQL_URL = new URL(
  '../../baselines/organization-record-derived-baseline-v1.sql',
  import.meta.url,
);

export function organizationRecordDerivedBaselineSqlV1(): string {
  return readFileSync(BASELINE_SQL_URL, 'utf8');
}

export function organizationRecordDerivedBaselineSha256V1(): Sha256Digest {
  return sha256Digest(organizationRecordDerivedBaselineSqlV1());
}

/**
 * Installs baseline v1 into a completely empty writable database: no schema
 * objects, `user_version = 0`, and `application_id = 0`. Anything else is
 * refused without mutation — a baseline never upgrades, relabels, or claims
 * an existing database, whatever lineage it belongs to.
 */
export function applyOrganizationRecordDerivedBaselineV1(
  database: Database.Database,
): void {
  const sql = organizationRecordDerivedBaselineSqlV1();
  database.exec('BEGIN IMMEDIATE');
  try {
    const userVersion = database.pragma('user_version', {
      simple: true,
    }) as number;
    const applicationId = database.pragma('application_id', {
      simple: true,
    }) as number;
    const objectCount = database
      .prepare('SELECT count(*) AS objects FROM sqlite_master')
      .pluck()
      .get() as number;
    if (userVersion !== 0 || applicationId !== 0 || objectCount !== 0) {
      throw new Error(
        'organization record derived baseline requires a completely empty database',
      );
    }
    database.exec(sql);
    database.pragma(
      `application_id = ${0x45435244}`,
    );
    database.pragma(
      `user_version = ${ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1}`,
    );
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
