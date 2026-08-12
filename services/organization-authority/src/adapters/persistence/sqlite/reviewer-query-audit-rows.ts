import type Database from 'better-sqlite3';
import { timestampMillis } from '../../../domain/rules.js';
import type { StoredReviewerQueryAuditEntry } from '../../../application/ports/authority-repository.js';
import { validateStoredReviewerQueryAuditRow } from '../../../application/reviewer-query-audit.js';

/**
 * The row shapes the online append and the stopped-state maintenance path both
 * read.
 *
 * They live here so the two capabilities can stay in separate modules without
 * either one re-deriving the other's column list: the online repository never
 * imports maintenance, and maintenance never imports the online repository's
 * write surface.
 */

export const REVIEWER_QUERY_AUDIT_ROW_COLUMNS =
  'audit_sequence, occurred_at, retain_until, operation, decision, reason_code, detail_json';

export const AUTHORITY_AUDIT_ROW_COLUMNS =
  'audit_sequence, occurred_at, actor_kind, action, subject_id, detail_json';

export interface RawReviewerQueryAuditRow {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  operation: string;
  decision: string;
  reason_code: string;
  detail_json: string;
}

export interface AuthorityAuditRow {
  audit_sequence: number;
  occurred_at: string;
  actor_kind: string;
  action: string;
  subject_id: string;
  detail_json: string;
}

export function reviewerQueryAuditRowBySequence(
  database: Database.Database,
  auditSequence: number,
): StoredReviewerQueryAuditEntry | undefined {
  const row = database
    .prepare(
      `SELECT ${REVIEWER_QUERY_AUDIT_ROW_COLUMNS}
         FROM authority_query_decision_audit
        WHERE audit_sequence = ?`,
    )
    .get(auditSequence) as RawReviewerQueryAuditRow | undefined;
  if (row === undefined) return undefined;
  return validateStoredReviewerQueryAuditRow(row);
}

/**
 * Canonical UTC millisecond timestamps are fixed width and lexically ordered,
 * so plain text comparison is the exact instant comparison. Nothing here
 * truncates a value to whole seconds to compare it.
 */
export function assertReviewerQueryAuditRange(
  fromInclusive: string,
  untilExclusive: string,
): void {
  timestampMillis(fromInclusive, 'reviewer query audit range from_inclusive');
  timestampMillis(untilExclusive, 'reviewer query audit range until_exclusive');
  if (!(fromInclusive < untilExclusive)) {
    throw new Error('reviewer query audit range must be positive');
  }
}
