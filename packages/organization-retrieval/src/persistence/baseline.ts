import { readFileSync } from 'node:fs';
import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type { ReadableSearchPlane } from '../application/readable-search-contracts.js';
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_FACTS_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
} from './database-definition.js';

/**
 * State-lineage baseline v1 for the three readable-search plane database roles.
 *
 * One exact baseline per plane replaces the historical migration chain: the
 * applier stamps the plane's role application ID and `user_version = 1` on an
 * empty database and the committed SQL file creates the complete behavior
 * schema. The legacy migration-ledger objects are deliberately absent. The
 * state-lineage manifest digest and pre-open guard bind each plane to its
 * readable-search runtime generation before it is opened.
 */
export const READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1 = 1;
export const READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2 = 2;

export interface ReadableSearchPlaneBaselineV1 {
  readonly plane: ReadableSearchPlane;
  readonly application_id: number;
  readonly baseline_sql_url: URL;
}

export interface ReadableSearchPlaneBaselineV2
  extends ReadableSearchPlaneBaselineV1 {
  readonly schema_version: 2;
}

export type ReadableSearchPlaneBaseline =
  | ReadableSearchPlaneBaselineV1
  | ReadableSearchPlaneBaselineV2;

export const READABLE_SEARCH_FACTS_BASELINE_V1: ReadableSearchPlaneBaselineV1 = {
  plane: 'facts',
  application_id: READABLE_SEARCH_FACTS_DATABASE.application_id,
  baseline_sql_url: new URL(
    '../../baselines/readable-search-facts-baseline-v1.sql',
    import.meta.url,
  ),
};

/**
 * Facts-plane v2 adds only the disposable, segment-local related-atom pairs.
 * V1 remains pinned for historical artifact inspection; builders always create
 * fresh v2 facts planes and never attempt an in-place upgrade.
 */
export const READABLE_SEARCH_FACTS_BASELINE_V2: ReadableSearchPlaneBaselineV2 = {
  plane: 'facts',
  application_id: READABLE_SEARCH_FACTS_DATABASE.application_id,
  schema_version: 2,
  baseline_sql_url: new URL(
    '../../baselines/readable-search-facts-baseline-v2.sql',
    import.meta.url,
  ),
};

export const READABLE_SEARCH_CONTENT_BASELINE_V1: ReadableSearchPlaneBaselineV1 = {
  plane: 'content',
  application_id: READABLE_SEARCH_CONTENT_DATABASE.application_id,
  baseline_sql_url: new URL(
    '../../baselines/readable-search-content-baseline-v1.sql',
    import.meta.url,
  ),
};

export const READABLE_SEARCH_LEXICAL_BASELINE_V1: ReadableSearchPlaneBaselineV1 = {
  plane: 'lexical',
  application_id: READABLE_SEARCH_LEXICAL_DATABASE.application_id,
  baseline_sql_url: new URL(
    '../../baselines/readable-search-lexical-baseline-v1.sql',
    import.meta.url,
  ),
};

export function readableSearchPlaneBaselineSqlV1(
  baseline: ReadableSearchPlaneBaselineV1,
): string {
  return readableSearchPlaneBaselineSql(baseline);
}

export function readableSearchPlaneBaselineSql(
  baseline: ReadableSearchPlaneBaseline,
): string {
  return readFileSync(baseline.baseline_sql_url, 'utf8');
}

export function readableSearchPlaneBaselineSha256V1(
  baseline: ReadableSearchPlaneBaselineV1,
): Sha256Digest {
  return readableSearchPlaneBaselineSha256(baseline);
}

export function readableSearchPlaneBaselineSha256(
  baseline: ReadableSearchPlaneBaseline,
): Sha256Digest {
  return sha256Digest(readableSearchPlaneBaselineSql(baseline));
}

/**
 * Installs the plane's baseline v1 into a completely empty writable database:
 * no schema objects, `user_version = 0`, and `application_id = 0`. Anything
 * else is refused without mutation — a baseline never upgrades, relabels, or
 * claims an existing database, whatever lineage it belongs to.
 */
export function applyReadableSearchPlaneBaselineV1(
  database: Database.Database,
  baseline: ReadableSearchPlaneBaselineV1,
): void {
  applyReadableSearchPlaneBaseline(database, baseline);
}

/** Installs an exact V1 or V2 baseline into a completely empty database. */
export function applyReadableSearchPlaneBaseline(
  database: Database.Database,
  baseline: ReadableSearchPlaneBaseline,
): void {
  const sql = readableSearchPlaneBaselineSql(baseline);
  const schemaVersion =
    'schema_version' in baseline
      ? baseline.schema_version
      : READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1;
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
        `readable-search ${baseline.plane} baseline requires a completely empty database`,
      );
    }
    database.exec(sql);
    database.pragma(`application_id = ${baseline.application_id}`);
    database.pragma(`user_version = ${schemaVersion}`);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
