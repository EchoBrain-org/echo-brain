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
/** What a sweep re-checks: the caller's own open items, or those of one decision or one project. */
export type TriggerRunScopeV1 =
  | { readonly kind: 'mine' }
  | { readonly kind: 'record'; readonly record_sha256: Sha256Digest }
  | { readonly kind: 'project'; readonly project_id: string };
/** An approved-record run carries its record and no scope; a sweep carries a scope and no record. */
export interface TriggerRunRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record' | 'sweep'; readonly event_ref: string;
  readonly actor: ApprovalActorV1; readonly record_sha256: Sha256Digest | null; readonly scope: TriggerRunScopeV1 | null;
  readonly state: TriggerRunStateV1; readonly attempts: number; readonly lease_token: string | null; readonly lease_expires_at: string | null;
  readonly result_json: string | null; readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
interface StoredRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record' | 'sweep'; readonly event_ref: string;
  readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly record_sha256: Sha256Digest | null; readonly scope_kind: TriggerRunScopeV1['kind'] | null; readonly scope_id: string | null;
  readonly state: TriggerRunStateV1; readonly attempts: number;
  readonly lease_token: string | null; readonly lease_expires_at: string | null; readonly result_json: string | null;
  readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
const selectRows = `SELECT run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, scope_kind, scope_id,
  state, attempts, lease_token, lease_expires_at, result_json, error_code, created_at, updated_at FROM authority_trigger_runs_v1`;
function publicScope(kind: StoredRowV1['scope_kind'], id: string | null): TriggerRunScopeV1 | null {
  if (kind === null) return null;
  if (kind === 'mine') return Object.freeze({ kind });
  return Object.freeze(kind === 'record' ? { kind, record_sha256: id as Sha256Digest } : { kind, project_id: id! });
}
function storedScope(scope: TriggerRunScopeV1): readonly [kind: TriggerRunScopeV1['kind'], id: string | null] {
  switch (scope.kind) {
    case 'mine': return [scope.kind, null];
    case 'record': return [scope.kind, scope.record_sha256];
    case 'project': return [scope.kind, scope.project_id];
    default: throw new TypeError('Sweep scope is invalid');
  }
}
function publicRow(value: StoredRowV1): TriggerRunRowV1 {
  return Object.freeze({ run_id: value.run_id, trigger: value.trigger, event_ref: value.event_ref,
    actor: Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id }),
    record_sha256: value.record_sha256, scope: publicScope(value.scope_kind, value.scope_id), state: value.state, attempts: value.attempts, lease_token: value.lease_token,
    lease_expires_at: value.lease_expires_at, result_json: value.result_json, error_code: value.error_code,
    created_at: value.created_at, updated_at: value.updated_at });
}

/**
 * Durable runs: an approved record's impact check, and sweeps that re-check open
 * items. Actor-fenced, except the reads named unfenced, whose callers apply the
 * open-items access policy before returning anything from them.
 */
export class SqliteTriggerRunsV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => Date = () => new Date()) {
    if (database.pragma('user_version', { simple: true }) !== 13 || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Trigger runs require Authority V13 state with foreign keys enabled');
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

  /** One immediate transaction: the actor's pending or running sweep of the same scope, else a new pending one (`event_ref` = `sweep_<uuid>`). */
  enqueueSweep(actor: ApprovalActorV1, scope: TriggerRunScopeV1): { readonly run_id: string; readonly created: boolean } {
    const [scopeKind, scopeId] = storedScope(scope);
    return this.immediate(() => {
      const live = this.database.prepare(`SELECT run_id FROM authority_trigger_runs_v1
        WHERE organization_id=? AND principal_id=? AND membership_id=? AND scope_kind=? AND ifnull(scope_id, '')=?
          AND trigger = 'sweep' AND state IN ('pending', 'running')`).pluck().get(
        actor.organization_id, actor.principal_id, actor.membership_id, scopeKind, scopeId ?? '') as string | undefined;
      if (live !== undefined) return Object.freeze({ run_id: live, created: false });
      const run_id = `run_${randomUUID()}`;
      const timestamp = this.timestamp();
      this.database.prepare(`INSERT INTO authority_trigger_runs_v1
        (run_id, trigger, event_ref, organization_id, principal_id, membership_id, scope_kind, scope_id, state, attempts, created_at, updated_at)
        VALUES (?, 'sweep', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(run_id, `sweep_${randomUUID()}`,
        actor.organization_id, actor.principal_id, actor.membership_id, scopeKind, scopeId, timestamp, timestamp);
      return Object.freeze({ run_id, created: true });
    });
  }

  /** The actor's pending or running sweep of any scope. */
  liveSweep(actor: ApprovalActorV1): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} WHERE organization_id=? AND principal_id=? AND membership_id=?
      AND trigger='sweep' AND state IN ('pending', 'running') ORDER BY created_at, run_id LIMIT 1`).get(
      actor.organization_id, actor.principal_id, actor.membership_id) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /** The actor's most recently created sweep of any scope, whatever its state. */
  newestSweep(actor: ApprovalActorV1): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} WHERE organization_id=? AND principal_id=? AND membership_id=?
      AND trigger='sweep' ORDER BY created_at DESC, run_id DESC LIMIT 1`).get(
      actor.organization_id, actor.principal_id, actor.membership_id) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /** The actor's newest runs, of one trigger when `trigger` names it, newest first. */
  list(actor: ApprovalActorV1, limit: number, trigger?: TriggerRunRowV1['trigger']): readonly TriggerRunRowV1[] {
    if (!Number.isFinite(limit)) throw new TypeError('Trigger run limit must be finite');
    const capped = Math.max(0, Math.min(100, Math.floor(limit)));
    return (this.database.prepare(`${selectRows} WHERE organization_id=? AND principal_id=? AND membership_id=? AND (? IS NULL OR trigger=?)
      ORDER BY created_at DESC, run_id DESC LIMIT ?`)
      .all(actor.organization_id, actor.principal_id, actor.membership_id, trigger ?? null, trigger ?? null, capped) as StoredRowV1[]).map(publicRow);
  }

  read(actor: ApprovalActorV1, runId: string): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} WHERE run_id=? AND organization_id=? AND principal_id=? AND membership_id=?`).get(
      runId, actor.organization_id, actor.principal_id, actor.membership_id) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /** Not fenced: callers must apply the open-items access policy before returning anything from it. */
  readUnfenced(runId: string): TriggerRunRowV1 | undefined {
    const found = this.database.prepare(`${selectRows} WHERE run_id=?`).get(runId) as StoredRowV1 | undefined;
    return found === undefined ? undefined : publicRow(found);
  }

  /** The approved-record runs of these records. Not fenced, as above. */
  impactRunsFor(recordSha256s: readonly Sha256Digest[]): readonly TriggerRunRowV1[] {
    if (recordSha256s.length === 0) return [];
    return (this.database.prepare(`${selectRows} WHERE trigger='approved_record' AND record_sha256 IN (SELECT value FROM json_each(?))
      ORDER BY created_at, run_id`).all(JSON.stringify([...new Set(recordSha256s)])) as StoredRowV1[]).map(publicRow);
  }

  /**
   * One live run per person. Impact checks start before sweeps: a sweep is
   * `busy` while one of the actor's impact checks is pending or running.
   */
  claim(actor: ApprovalActorV1, runId: string, leaseMs: number): { readonly kind: 'claimed'; readonly lease_token: string } | { readonly kind: 'running' | 'busy' | 'done' | 'failed' | 'not_found' } {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('Trigger run lease must be a positive integer');
    return this.immediate(() => {
      const current = this.read(actor, runId);
      if (current === undefined) return { kind: 'not_found' } as const;
      if (current.state === 'done' || current.state === 'failed') return { kind: current.state } as const;
      const currentTime = this.currentTime();
      const timestamp = currentTime.toISOString();
      if (current.state === 'running' && current.lease_expires_at! > timestamp) return { kind: 'running' } as const;
      const impactFirst = current.trigger === 'sweep' && this.database.prepare(`SELECT 1 FROM authority_trigger_runs_v1
        WHERE organization_id=? AND principal_id=? AND membership_id=? AND trigger='approved_record' AND state IN ('pending', 'running') LIMIT 1`).get(
        actor.organization_id, actor.principal_id, actor.membership_id) !== undefined;
      if (impactFirst) return { kind: 'busy' } as const;
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

  /** failed → pending for approved-record runs only; a failed sweep stays failed and the next sweep replaces it. */
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
