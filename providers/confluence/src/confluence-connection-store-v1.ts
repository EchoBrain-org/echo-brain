import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { copyConfluenceBindingV1, confluenceFailure, confluenceString } from './confluence-validation-v1.js';

export type ConfluenceConnectionAttemptStatusV1 = 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
export type ConfluenceConnectionAttemptFailureV1 = 'provider_rejected' | 'provider_unavailable' | 'account_mismatch';
export type ConfluencePersonV1 = Pick<PersonConnectorReadBindingV1, 'organization_id' | 'principal_id' | 'membership_id'>;
export interface ConfluenceStoredConnectionV1 { readonly binding: PersonConnectorReadBindingV1; readonly reference: string; readonly site: string; readonly version: string; readonly active: boolean; readonly attempt: string }
export interface ConfluenceConnectionAttemptV1 {
  readonly attempt: string;
  readonly expires: number;
  readonly status: ConfluenceConnectionAttemptStatusV1;
  readonly failure_reason: ConfluenceConnectionAttemptFailureV1 | null;
}
interface AttemptBody extends Omit<ConfluenceConnectionAttemptV1, 'attempt'> { readonly person: ConfluencePersonV1; readonly expected_account?: string }

/** Provider-owned database; immutable Authority SQL baselines are not modified. No credentials or evidence. */
export class ConfluenceConnectionStoreV1 {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS confluence_person_binding_v1 (person_key TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS confluence_person_attempt_v1 (attempt TEXT PRIMARY KEY, person_key TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);`);
  }
  private key(person: ConfluencePersonV1): string { return canonicalSha256(person); }
  private attemptBody(person: ConfluencePersonV1, attempt: string): AttemptBody {
    const row = this.db.prepare('SELECT body_json FROM confluence_person_attempt_v1 WHERE attempt=? AND person_key=?').get(attempt, this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) confluenceFailure('unauthorized');
    const value = JSON.parse(row.body_json) as Partial<AttemptBody>;
    if (value.person === undefined || this.key(value.person) !== this.key(person) || typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires)) confluenceFailure('unauthorized');
    const status = value.status ?? 'pending';
    if (status !== 'pending' && status !== 'complete' && status !== 'cancelled' && status !== 'expired' && status !== 'failed') confluenceFailure('unauthorized');
    const failure_reason = value.failure_reason ?? null;
    if (failure_reason !== null && failure_reason !== 'provider_rejected' && failure_reason !== 'provider_unavailable' && failure_reason !== 'account_mismatch') confluenceFailure('unauthorized');
    return { person: Object.freeze({ ...value.person }), expires: value.expires, status, failure_reason,
      ...(typeof value.expected_account === 'string' ? { expected_account: value.expected_account } : {}) } as AttemptBody;
  }
  private writeAttempt(person: ConfluencePersonV1, attempt: string, body: AttemptBody): void {
    this.db.prepare('UPDATE confluence_person_attempt_v1 SET body_json=? WHERE attempt=? AND person_key=?').run(canonicalJson(body), attempt, this.key(person));
  }
  private publicAttempt(attempt: string, body: AttemptBody): ConfluenceConnectionAttemptV1 {
    return Object.freeze({ attempt, expires: body.expires, status: body.status, failure_reason: body.failure_reason });
  }
  current(person: ConfluencePersonV1): ConfluenceStoredConnectionV1 | undefined {
    const row = this.db.prepare('SELECT body_json FROM confluence_person_binding_v1 WHERE person_key=?').get(this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.body_json) as ConfluenceStoredConnectionV1;
    return Object.freeze({ ...value, binding: copyConfluenceBindingV1(value.binding) });
  }
  begin(person: ConfluencePersonV1): ConfluenceConnectionAttemptV1 {
    return this.db.transaction(() => {
      const old = this.current(person); this.revoke(person);
      const attempt = randomUUID();
      const body: AttemptBody = { person: Object.freeze({ ...person }), expires: this.now() + 30 * 60_000, status: 'pending', failure_reason: null,
        ...(old === undefined ? {} : { expected_account: old.binding.external_subject_id }) };
      this.db.prepare('INSERT OR REPLACE INTO confluence_person_attempt_v1 VALUES(?,?,?)').run(attempt, this.key(person), canonicalJson(body));
      return this.publicAttempt(attempt, body);
    })();
  }
  status(person: ConfluencePersonV1, attempt: string): ConfluenceConnectionAttemptV1 {
    const value = this.attemptBody(person, attempt);
    if (value.status === 'pending' && value.expires <= this.now()) {
      const expired: AttemptBody = { ...value, status: 'expired', failure_reason: null };
      this.writeAttempt(person, attempt, expired);
      return this.publicAttempt(attempt, expired);
    }
    return this.publicAttempt(attempt, value);
  }
  pending(person: ConfluencePersonV1, attempt: string): AttemptBody {
    const result = this.status(person, attempt);
    if (result.status !== 'pending') confluenceFailure('stale_access_state');
    return this.attemptBody(person, attempt);
  }
  complete(person: ConfluencePersonV1, attempt: string, reference: string, cloud: string, account: string, site: string): ConfluenceStoredConnectionV1 {
    return this.db.transaction(() => {
      const pending = this.pending(person, attempt);
      if (pending.expected_account !== undefined && pending.expected_account !== account) confluenceFailure('unauthorized');
      const version = randomUUID();
      const binding = copyConfluenceBindingV1({ ...person, tool_id: 'confluence', external_scope_id: cloud, external_subject_id: account, read_grant_sha256: canonicalSha256({ kind: 'echo-confluence-person-read-grant-v1', ...person, cloud, account, reference, version }) });
      const stored = Object.freeze({ binding, reference: confluenceString(reference, 512), site, version, active: true, attempt });
      // A Nango reference cannot be claimed by another Person or membership tenure.
      const owner = this.db.prepare('SELECT person_key FROM confluence_person_binding_v1 WHERE reference=?').get(reference) as { person_key: string } | undefined;
      if (owner !== undefined && owner.person_key !== this.key(person)) confluenceFailure('unauthorized');
      this.db.prepare('INSERT OR REPLACE INTO confluence_person_binding_v1 VALUES(?,?,?)').run(this.key(person), reference, canonicalJson(stored));
      this.writeAttempt(person, attempt, { ...pending, status: 'complete', failure_reason: null });
      return stored;
    })();
  }
  fail(person: ConfluencePersonV1, attempt: string, reason: ConfluenceConnectionAttemptFailureV1): ConfluenceConnectionAttemptV1 {
    return this.db.transaction(() => {
      const pending = this.pending(person, attempt);
      const failed: AttemptBody = { ...pending, status: 'failed', failure_reason: reason };
      this.writeAttempt(person, attempt, failed);
      return this.publicAttempt(attempt, failed);
    })();
  }
  cancel(person: ConfluencePersonV1, attempt: string): ConfluenceConnectionAttemptV1 {
    const current = this.status(person, attempt);
    if (current.status !== 'pending') return current;
    const pending = this.attemptBody(person, attempt);
    const cancelled: AttemptBody = { ...pending, status: 'cancelled', failure_reason: null };
    this.writeAttempt(person, attempt, cancelled);
    return this.publicAttempt(attempt, cancelled);
  }
  revoke(person: ConfluencePersonV1): ConfluenceConnectionAttemptV1 | undefined {
    const old = this.current(person);
    if (old !== undefined) this.db.prepare('UPDATE confluence_person_binding_v1 SET body_json=? WHERE person_key=?').run(canonicalJson({ ...old, active: false }), this.key(person));
    const row = this.db.prepare('SELECT attempt FROM confluence_person_attempt_v1 WHERE person_key=?').get(this.key(person)) as { attempt: string } | undefined;
    if (row === undefined) return undefined;
    return this.cancel(person, row.attempt);
  }
  requireCurrent(binding: PersonConnectorReadBindingV1): ConfluenceStoredConnectionV1 {
    const current = this.current({ organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id });
    if (current === undefined || !current.active || canonicalSha256(current.binding) !== canonicalSha256(binding)) confluenceFailure('stale_access_state');
    return current;
  }
}
