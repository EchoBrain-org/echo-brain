import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AUTHORITY_BASELINE_SCHEMA_VERSION, isCurrentAuthorityState } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import { publishedApprovalOfRecordV1 } from './published-approval-records-v1.js';

/** Kept structural so this persistence adapter does not depend on approval composition. */
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
/** `approval_id` is the record's own (the run's event_ref); `proposal_approval_id` the decided proposal its sibling records share. */
export interface AfterApprovedRecordEventV1 {
  readonly approval_id: string; readonly proposal_approval_id: string; readonly record_sha256: Sha256Digest; readonly reviewer: ApprovalActorV1; readonly decided_at: string;
}
export type AfterApprovedRecordHookV1 = (transaction: Database.Database, event: AfterApprovedRecordEventV1) => void;

type TriggerRunStateV1 = 'pending' | 'running' | 'done' | 'failed';
type TriggerRunErrorV1 = 'no_access' | 'unavailable' | 'timed_out' | 'research_failed';
/** An approved record's impact check: the run of one record its reviewer published. */
export interface TriggerRunRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly actor: ApprovalActorV1; readonly record_sha256: Sha256Digest;
  readonly state: TriggerRunStateV1; readonly attempts: number; readonly lease_token: string | null; readonly lease_expires_at: string | null;
  readonly result_json: string | null; readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
interface StoredRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly organization_id: string; readonly principal_id: string; readonly membership_id: string; readonly record_sha256: Sha256Digest;
  readonly state: TriggerRunStateV1; readonly attempts: number;
  readonly lease_token: string | null; readonly lease_expires_at: string | null; readonly result_json: string | null;
  readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
/**
 * Every read is of approved-record runs, each of which has its record: a sweep row an Authority left before sweeps were retired
 * (SVC-2) is never read, listed, claimed or started. Each read adds its own terms after it with `AND`.
 */
const selectRows = `SELECT run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256,
  state, attempts, lease_token, lease_expires_at, result_json, error_code, created_at, updated_at FROM authority_trigger_runs_v1 WHERE trigger='approved_record'`;
function publicRow(value: StoredRowV1): TriggerRunRowV1 {
  return Object.freeze({ run_id: value.run_id, trigger: value.trigger, event_ref: value.event_ref,
    actor: Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id }),
    record_sha256: value.record_sha256, state: value.state, attempts: value.attempts, lease_token: value.lease_token,
    lease_expires_at: value.lease_expires_at, result_json: value.result_json, error_code: value.error_code,
    created_at: value.created_at, updated_at: value.updated_at });
}

/**
 * A run's state as a reader is told it at `at`: a running run whose lease has
 * lapsed (its attempt stopped without finishing, as when the Authority
 * restarted mid-run) reads `pending`, because `claim` takes it again. The
 * stored state is unchanged.
 */
export function triggerRunStateAtV1(row: Pick<TriggerRunRowV1, 'state' | 'lease_expires_at'>, at: string): TriggerRunStateV1 {
  return row.state === 'running' && row.lease_expires_at !== null && row.lease_expires_at <= at ? 'pending' : row.state;
}

/**
 * Durable runs: an approved record's impact check. Actor-fenced, except the
 * reads named unfenced, whose callers apply the open-items access policy before
 * returning anything from them.
 */
export class SqliteTriggerRunsV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => Date = () => new Date()) {
    if (!isCurrentAuthorityState(database)) {
      throw new Error(`Trigger runs require Authority V${AUTHORITY_BASELINE_SCHEMA_VERSION} state with foreign keys enabled`);
    }
  }

  /** The after-record hook supplies its active receipt transaction. */
  enqueueApprovedRecord(transaction: Database.Database, event: AfterApprovedRecordEventV1): void {
    if (transaction !== this.database || !transaction.inTransaction) throw new Error('Approved-record enqueue needs the caller transaction');
    const timestamp = this.timestamp();
    transaction.prepare(`INSERT INTO authority_trigger_runs_v1
      (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, state, attempts, created_at, updated_at)
      VALUES (?, 'approved_record', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(trigger, event_ref) DO NOTHING`).run(`run_${randomUUID()}`, event.approval_id,
      event.reviewer.organization_id, event.reviewer.principal_id, event.reviewer.membership_id, event.record_sha256, timestamp, timestamp);
  }

  /** The actor's newest runs, newest first. */
  list(actor: ApprovalActorV1, limit: number): readonly TriggerRunRowV1[] {
    if (!Number.isFinite(limit)) throw new TypeError('Trigger run limit must be finite');
    const capped = Math.max(0, Math.min(100, Math.floor(limit)));
    return (this.database.prepare(`${selectRows} AND organization_id=? AND principal_id=? AND membership_id=?
      ORDER BY created_at DESC, run_id DESC LIMIT ?`)
      .all(actor.organization_id, actor.principal_id, actor.membership_id, capped) as StoredRowV1[]).map(publicRow);
  }

  /**
   * The actor's oldest queued impact check, by `created_at, run_id`: pending, or running with a lapsed lease (its attempt
   * stopped without finishing, which `claim` takes again).
   */
  nextQueued(actor: ApprovalActorV1): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} AND organization_id=? AND principal_id=? AND membership_id=?
      AND (state='pending' OR (state='running' AND lease_expires_at<=?)) ORDER BY created_at, run_id LIMIT 1`).get(
      actor.organization_id, actor.principal_id, actor.membership_id, this.timestamp()) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  read(actor: ApprovalActorV1, runId: string): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} AND run_id=? AND organization_id=? AND principal_id=? AND membership_id=?`).get(
      runId, actor.organization_id, actor.principal_id, actor.membership_id) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /** Not fenced: callers must apply the open-items access policy before returning anything from it. */
  readUnfenced(runId: string): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} AND run_id=?`).get(runId) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /**
   * The other records published with one of the approver's records: the receipt records of the decision whose receipt names
   * it (its siblings: the same meeting sent to other destinations), never that record itself. [] for any other digest.
   */
  siblingRecords(approver: ApprovalActorV1, recordSha256: Sha256Digest): readonly Sha256Digest[] {
    const published = publishedApprovalOfRecordV1(this.database, approver, { record_sha256: recordSha256 });
    return (published?.records ?? []).map(record => record.record_sha256 as Sha256Digest).filter(record => record !== recordSha256);
  }

  /**
   * The source the meeting of one of the approver's records was read from: the custody that holds the meeting's unapproved
   * notes and any transcript of it. undefined for any other digest.
   */
  meetingSource(approver: ApprovalActorV1, recordSha256: Sha256Digest): string | undefined {
    return publishedApprovalOfRecordV1(this.database, approver, { record_sha256: recordSha256 })?.meeting_source ?? undefined;
  }

  /** The runs of these records. Not fenced, as above. */
  impactRunsFor(recordSha256s: readonly Sha256Digest[]): readonly TriggerRunRowV1[] {
    if (recordSha256s.length === 0) return [];
    return (this.database.prepare(`${selectRows} AND record_sha256 IN (SELECT value FROM json_each(?))
      ORDER BY created_at, run_id`).all(JSON.stringify([...new Set(recordSha256s)])) as StoredRowV1[]).map(publicRow);
  }

  /**
   * One live run per person: `busy` while another of the actor's runs is
   * running, and while `admit` says the process already runs as many as it
   * allows.
   */
  claim(actor: ApprovalActorV1, runId: string, leaseMs: number, admit?: () => boolean): { readonly kind: 'claimed'; readonly lease_token: string } | { readonly kind: 'running' | 'busy' | 'done' | 'failed' | 'not_found' } {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('Trigger run lease must be a positive integer');
    return this.immediate(() => {
      const current = this.read(actor, runId);
      if (current === undefined) return { kind: 'not_found' } as const;
      if (current.state === 'done' || current.state === 'failed') return { kind: current.state } as const;
      const currentTime = this.currentTime();
      const timestamp = currentTime.toISOString();
      if (current.state === 'running' && current.lease_expires_at! > timestamp) return { kind: 'running' } as const;
      const anotherLiveRun = this.database.prepare(`SELECT 1 FROM authority_trigger_runs_v1 WHERE trigger='approved_record'
        AND organization_id=? AND principal_id=? AND membership_id=? AND run_id!=? AND state='running' AND lease_expires_at>? LIMIT 1`).get(
        actor.organization_id, actor.principal_id, actor.membership_id, runId, timestamp);
      if (anotherLiveRun !== undefined || admit?.() === false) return { kind: 'busy' } as const;
      const lease_token = randomUUID();
      const lease_expires_at = new Date(currentTime.getTime() + leaseMs).toISOString();
      const changed = this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='running', lease_token=?, lease_expires_at=?, updated_at=?
        WHERE run_id=? AND organization_id=? AND principal_id=? AND membership_id=?
          AND (state='pending' OR (state='running' AND lease_expires_at<=?))`).run(
        lease_token, lease_expires_at, timestamp, runId, actor.organization_id, actor.principal_id, actor.membership_id, timestamp).changes;
      return changed === 1 ? { kind: 'claimed', lease_token } : { kind: 'running' };
    });
  }

  release(runId: string, leaseToken: string, attempt: { readonly counted: false } | { readonly counted: true; readonly exhausted: 'timed_out' | 'unavailable' }): void {
    this.immediate(() => {
      const timestamp = this.timestamp();
      const current = this.database.prepare("SELECT state, lease_token, lease_expires_at, attempts FROM authority_trigger_runs_v1 WHERE trigger='approved_record' AND run_id=?").get(runId) as Pick<StoredRowV1, 'state' | 'lease_token' | 'lease_expires_at' | 'attempts'> | undefined;
      if (current === undefined || current.state !== 'running' || current.lease_token !== leaseToken || current.lease_expires_at === null || current.lease_expires_at <= timestamp) return;
      if (!attempt.counted) {
        this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='pending', lease_token=NULL, lease_expires_at=NULL, updated_at=?
          WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(timestamp, runId, leaseToken, timestamp);
      } else {
        const attempts = current.attempts + 1;
        if (attempts >= 3) this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='failed', attempts=?, lease_token=NULL,
          lease_expires_at=NULL, error_code=?, updated_at=? WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(attempts, attempt.exhausted, timestamp, runId, leaseToken, timestamp);
        else this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='pending', attempts=?, lease_token=NULL,
          lease_expires_at=NULL, updated_at=? WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(attempts, timestamp, runId, leaseToken, timestamp);
      }
    });
  }

  /** `then` runs inside the same immediate transaction, only when this call moved the run to done. */
  finish(runId: string, leaseToken: string, result: { readonly json: string; readonly sha256: Sha256Digest }, then?: (transaction: Database.Database) => void): boolean {
    return this.immediate(() => {
      const timestamp = this.timestamp();
      const finished = this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='done', lease_token=NULL, lease_expires_at=NULL,
      result_json=?, result_sha256=?, error_code=NULL, updated_at=? WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(
      result.json, result.sha256, timestamp, runId, leaseToken, timestamp).changes === 1;
      if (finished) then?.(this.database);
      return finished;
    });
  }

  fail(runId: string, leaseToken: string, error: TriggerRunErrorV1): boolean {
    return this.immediate(() => {
      const timestamp = this.timestamp();
      return this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='failed', lease_token=NULL, lease_expires_at=NULL,
      error_code=?, updated_at=? WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(
      error, timestamp, runId, leaseToken, timestamp).changes === 1;
    });
  }

  /** failed → pending. */
  retry(actor: ApprovalActorV1, runId: string): boolean {
    return this.immediate(() => this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='pending', attempts=0, lease_token=NULL,
      lease_expires_at=NULL, error_code=NULL, updated_at=? WHERE run_id=? AND organization_id=? AND principal_id=? AND membership_id=? AND state='failed'
      AND trigger='approved_record'`).run(
      this.timestamp(), runId, actor.organization_id, actor.principal_id, actor.membership_id).changes === 1);
  }

  private timestamp(): string {
    return this.currentTime().toISOString();
  }
  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('Trigger run clock returned an invalid date');
    return value;
  }
  private immediate<T>(operation: () => T): T {
    if (this.database.inTransaction) throw new Error('Trigger run operation needs an idle database');
    return this.database.transaction(operation).immediate();
  }
}

export const enqueueApprovedRecordRunV1 = (runs: SqliteTriggerRunsV1): AfterApprovedRecordHookV1 =>
  (transaction, event) => runs.enqueueApprovedRecord(transaction, event);
