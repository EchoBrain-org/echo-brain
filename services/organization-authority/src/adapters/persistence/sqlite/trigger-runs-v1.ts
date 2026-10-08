import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Sha256Digest } from '@echo-brain/federation-protocol';

/** Kept structural so this persistence adapter does not depend on approval composition. */
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
export interface AfterApprovedRecordEventV1 {
  readonly approval_id: string; readonly record_sha256: Sha256Digest; readonly reviewer: ApprovalActorV1; readonly decided_at: string;
}
export type AfterApprovedRecordHookV1 = (transaction: Database.Database, event: AfterApprovedRecordEventV1) => void;

export type TriggerRunStateV1 = 'pending' | 'running' | 'done' | 'failed';
export type TriggerRunErrorV1 = 'no_access' | 'unavailable' | 'timed_out' | 'research_failed';
export interface TriggerRunRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly actor: ApprovalActorV1; readonly record_sha256: Sha256Digest; readonly state: TriggerRunStateV1;
  readonly attempts: number; readonly lease_token: string | null; readonly lease_expires_at: string | null;
  readonly result_json: string | null; readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
interface StoredRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly record_sha256: Sha256Digest; readonly state: TriggerRunStateV1; readonly attempts: number;
  readonly lease_token: string | null; readonly lease_expires_at: string | null; readonly result_json: string | null;
  readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
const selectRows = `SELECT run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256,
  state, attempts, lease_token, lease_expires_at, result_json, error_code, created_at, updated_at FROM authority_trigger_runs_v1`;
function publicRow(value: StoredRowV1): TriggerRunRowV1 {
  return Object.freeze({ run_id: value.run_id, trigger: value.trigger, event_ref: value.event_ref,
    actor: Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id }),
    record_sha256: value.record_sha256, state: value.state, attempts: value.attempts, lease_token: value.lease_token,
    lease_expires_at: value.lease_expires_at, result_json: value.result_json, error_code: value.error_code,
    created_at: value.created_at, updated_at: value.updated_at });
}

/** Durable, actor-fenced runs for the only product trigger currently enabled. */
export class SqliteTriggerRunsV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => Date = () => new Date()) {
    if (database.pragma('user_version', { simple: true }) !== 12 || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Trigger runs require Authority V12 state with foreign keys enabled');
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

  list(actor: ApprovalActorV1, limit: number): readonly TriggerRunRowV1[] {
    if (!Number.isFinite(limit)) throw new TypeError('Trigger run limit must be finite');
    const capped = Math.max(0, Math.min(100, Math.floor(limit)));
    return (this.database.prepare(`${selectRows} WHERE organization_id=? AND principal_id=? AND membership_id=? ORDER BY created_at DESC, run_id DESC LIMIT ?`)
      .all(actor.organization_id, actor.principal_id, actor.membership_id, capped) as StoredRowV1[]).map(publicRow);
  }

  read(actor: ApprovalActorV1, runId: string): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} WHERE run_id=? AND organization_id=? AND principal_id=? AND membership_id=?`).get(
      runId, actor.organization_id, actor.principal_id, actor.membership_id) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  claim(actor: ApprovalActorV1, runId: string, leaseMs: number): { readonly kind: 'claimed'; readonly lease_token: string } | { readonly kind: 'running' | 'busy' | 'done' | 'failed' | 'not_found' } {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('Trigger run lease must be a positive integer');
    return this.immediate(() => {
      const current = this.read(actor, runId);
      if (current === undefined) return { kind: 'not_found' } as const;
      if (current.state === 'done' || current.state === 'failed') return { kind: current.state } as const;
      const currentTime = this.currentTime();
      const timestamp = currentTime.toISOString();
      if (current.state === 'running' && current.lease_expires_at! > timestamp) return { kind: 'running' } as const;
      const anotherLiveRun = this.database.prepare(`SELECT 1 FROM authority_trigger_runs_v1
        WHERE organization_id=? AND principal_id=? AND membership_id=? AND run_id!=? AND state='running' AND lease_expires_at>? LIMIT 1`).get(
        actor.organization_id, actor.principal_id, actor.membership_id, runId, timestamp);
      if (anotherLiveRun !== undefined) return { kind: 'busy' } as const;
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
      const current = this.database.prepare('SELECT state, lease_token, lease_expires_at, attempts FROM authority_trigger_runs_v1 WHERE run_id=?').get(runId) as Pick<StoredRowV1, 'state' | 'lease_token' | 'lease_expires_at' | 'attempts'> | undefined;
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

  finish(runId: string, leaseToken: string, result: { readonly json: string; readonly sha256: Sha256Digest }): boolean {
    return this.immediate(() => {
      const timestamp = this.timestamp();
      return this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='done', lease_token=NULL, lease_expires_at=NULL,
      result_json=?, result_sha256=?, error_code=NULL, updated_at=? WHERE run_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`).run(
      result.json, result.sha256, timestamp, runId, leaseToken, timestamp).changes === 1;
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

  retry(actor: ApprovalActorV1, runId: string): boolean {
    return this.immediate(() => this.database.prepare(`UPDATE authority_trigger_runs_v1 SET state='pending', attempts=0, lease_token=NULL,
      lease_expires_at=NULL, error_code=NULL, updated_at=? WHERE run_id=? AND organization_id=? AND principal_id=? AND membership_id=? AND state='failed'`).run(
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
