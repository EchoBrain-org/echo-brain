import { readFileSync } from 'node:fs';
import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import { ORGANIZATION_RECORD_DERIVED_DATABASE } from './database-definition.js';

/**
 * New-lineage baseline v1 for the organization record derived database role.
 *
 * One exact baseline replaces the historical migration chain: the applier
 * stamps the role application ID and `user_version = 1` on an empty database
 * and the committed SQL file creates the complete behavior schema. The legacy
 * migration-ledger objects are deliberately absent; new-lineage schema
 * identity is carried by the state-lineage manifest digest and the pre-open
 * guard's exact-version check. This module is private and unwired: the
 * new-lineage initializer that composes it is later Phase 3 work, and no
 * current runtime path may create new-lineage state.
 *
 * The record log role has no baseline here on purpose: its current schema
 * carries an installation-scoped dedupe identity, so its new-lineage shape is
 * contract work beside the authority baseline, not a mechanical dump.
 */
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
      `application_id = ${ORGANIZATION_RECORD_DERIVED_DATABASE.application_id}`,
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
