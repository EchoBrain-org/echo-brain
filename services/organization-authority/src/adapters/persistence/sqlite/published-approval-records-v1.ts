import type Database from 'better-sqlite3';

/** Kept structural so this persistence read does not depend on approval composition. */
interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
interface PublishedApprovalV1 {
  /** The decided proposal's approval id. */
  readonly approval_id: string;
  /** The source the meeting was read from: the decision's frozen transcript_source, which holds its unapproved notes. */
  readonly meeting_source: string | null;
  /** Every record the decision's receipt names, in receipt order: the meeting's destination groups. */
  readonly records: readonly { readonly approval_id: string; readonly record_sha256: string }[];
}

/**
 * The approver's own published decision whose receipt names a record, found by the record's digest or by its approval id;
 * undefined for any other record, an unpublished decision, or another person's.
 */
export function publishedApprovalOfRecordV1(database: Database.Database, approver: ApprovalActorV1,
  record: { readonly record_sha256: string } | { readonly approval_id: string }): PublishedApprovalV1 | undefined {
  const [path, value] = 'record_sha256' in record ? ['$.record_sha256', record.record_sha256] : ['$.approval_id', record.approval_id];
  const row = database.prepare(`SELECT d.approval_id, json_extract(d.body_json, '$.transcript_source.source_id') AS meeting_source,
      json_extract(d.receipt_json, '$.records') AS records
    FROM authority_approval_decisions_v1 d, json_each(d.receipt_json, '$.records') AS named
    WHERE json_extract(d.body_json, '$.actor.membership_id') = ? AND d.action = 'approve' AND d.receipt_json IS NOT NULL
      AND json_extract(d.body_json, '$.actor.organization_id') = ? AND json_extract(d.body_json, '$.actor.principal_id') = ?
      AND json_extract(named.value, ?) = ? LIMIT 1`).get(approver.membership_id, approver.organization_id, approver.principal_id, path, value) as
    { approval_id: string; meeting_source: unknown; records: string } | undefined;
  if (row === undefined) return undefined;
  const records = (JSON.parse(row.records) as { approval_id: string; record_sha256: string }[])
    .map(published => Object.freeze({ approval_id: published.approval_id, record_sha256: published.record_sha256 }));
  return Object.freeze({ approval_id: row.approval_id, meeting_source: typeof row.meeting_source === 'string' ? row.meeting_source : null, records: Object.freeze(records) });
}

/**
 * Every record the approver's own published decisions name: each destination record of each meeting they approved, by its
 * digest. A decision whose receipt is not written yet names none. Read through the partial index on the decision's actor.
 */
export function publishedRecordsOfApproverV1(database: Database.Database, approver: ApprovalActorV1): ReadonlySet<string> {
  const records = database.prepare(`SELECT json_extract(named.value, '$.record_sha256')
    FROM authority_approval_decisions_v1 d, json_each(d.receipt_json, '$.records') AS named
    WHERE json_extract(d.body_json, '$.actor.membership_id') = ? AND d.action = 'approve' AND d.receipt_json IS NOT NULL
      AND json_extract(d.body_json, '$.actor.organization_id') = ? AND json_extract(d.body_json, '$.actor.principal_id') = ?`).pluck()
    .all(approver.membership_id, approver.organization_id, approver.principal_id) as unknown[];
  return new Set(records.filter((record): record is string => typeof record === 'string'));
}
