import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonProviderV1 } from './person-provider-v1.js';

export type PersonConnectionAttemptStatusV1 = 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
export type PersonConnectionAttemptFailureV1 = 'provider_rejected' | 'provider_unavailable' | 'account_mismatch';
export type ConnectedPersonV1 = Pick<PersonConnectorReadBindingV1, 'organization_id' | 'principal_id' | 'membership_id'>;
export interface StoredPersonConnectionV1 { readonly binding: PersonConnectorReadBindingV1; readonly reference: string; readonly site: string; readonly version: string; readonly active: boolean; readonly attempt: string }
export interface PersonConnectionAttemptV1 {
  readonly attempt: string;
  readonly expires: number;
  readonly status: PersonConnectionAttemptStatusV1;
  readonly failure_reason: PersonConnectionAttemptFailureV1 | null;
}
interface AttemptBody extends Omit<PersonConnectionAttemptV1, 'attempt'> { readonly person: ConnectedPersonV1; readonly expected_account?: string }

/** Provider-owned database; immutable Authority SQL baselines are not modified. No credentials or evidence. */
export class PersonConnectionStoreV1 {
  private readonly bindingTable: 'jira_person_binding_v1' | 'confluence_person_binding_v1';
  private readonly attemptTable: 'jira_person_attempt_v1' | 'confluence_person_attempt_v1';

  constructor(private readonly db: Database.Database, readonly provider: PersonProviderV1, private readonly now: () => number = Date.now) {
    if (provider.id !== 'jira' && provider.id !== 'confluence') provider.failure('invalid_request');
    this.bindingTable = provider.id === 'jira' ? 'jira_person_binding_v1' : 'confluence_person_binding_v1';
    this.attemptTable = provider.id === 'jira' ? 'jira_person_attempt_v1' : 'confluence_person_attempt_v1';
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.bindingTable} (person_key TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${this.attemptTable} (attempt TEXT PRIMARY KEY, person_key TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);`);
  }
  private key(person: ConnectedPersonV1): string { return canonicalSha256(person); }
  private attemptBody(person: ConnectedPersonV1, attempt: string): AttemptBody {
    const row = this.db.prepare(`SELECT body_json FROM ${this.attemptTable} WHERE attempt=? AND person_key=?`).get(attempt, this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) this.provider.failure('unauthorized');
    const value = JSON.parse(row.body_json) as Partial<AttemptBody>;
    if (value.person === undefined || this.key(value.person) !== this.key(person) || typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires)) this.provider.failure('unauthorized');
    const status = value.status ?? 'pending';
    if (status !== 'pending' && status !== 'complete' && status !== 'cancelled' && status !== 'expired' && status !== 'failed') this.provider.failure('unauthorized');
    const failure_reason = value.failure_reason ?? null;
    if (failure_reason !== null && failure_reason !== 'provider_rejected' && failure_reason !== 'provider_unavailable' && failure_reason !== 'account_mismatch') this.provider.failure('unauthorized');
    return { person: Object.freeze({ ...value.person }), expires: value.expires, status, failure_reason,
      ...(typeof value.expected_account === 'string' ? { expected_account: value.expected_account } : {}) } as AttemptBody;
  }
  private writeAttempt(person: ConnectedPersonV1, attempt: string, body: AttemptBody): void {
    this.db.prepare(`UPDATE ${this.attemptTable} SET body_json=? WHERE attempt=? AND person_key=?`).run(canonicalJson(body), attempt, this.key(person));
  }
  private publicAttempt(attempt: string, body: AttemptBody): PersonConnectionAttemptV1 {
    return Object.freeze({ attempt, expires: body.expires, status: body.status, failure_reason: body.failure_reason });
  }
  current(person: ConnectedPersonV1): StoredPersonConnectionV1 | undefined {
    const row = this.db.prepare(`SELECT body_json FROM ${this.bindingTable} WHERE person_key=?`).get(this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.body_json) as StoredPersonConnectionV1;
    return Object.freeze({ ...value, binding: this.provider.copyBinding(value.binding) });
  }
  begin(person: ConnectedPersonV1): PersonConnectionAttemptV1 {
    return this.db.transaction(() => {
      const old = this.current(person); this.revoke(person);
      const attempt = randomUUID();
      const body: AttemptBody = { person: Object.freeze({ ...person }), expires: this.now() + 30 * 60_000, status: 'pending', failure_reason: null,
        ...(old === undefined ? {} : { expected_account: old.binding.external_subject_id }) };
      this.db.prepare(`INSERT OR REPLACE INTO ${this.attemptTable} VALUES(?,?,?)`).run(attempt, this.key(person), canonicalJson(body));
      return this.publicAttempt(attempt, body);
    })();
  }
  status(person: ConnectedPersonV1, attempt: string): PersonConnectionAttemptV1 {
    const value = this.attemptBody(person, attempt);
    if (value.status === 'pending' && value.expires <= this.now()) {
      const expired: AttemptBody = { ...value, status: 'expired', failure_reason: null };
      this.writeAttempt(person, attempt, expired);
      return this.publicAttempt(attempt, expired);
    }
    return this.publicAttempt(attempt, value);
  }
  pending(person: ConnectedPersonV1, attempt: string): AttemptBody {
    const result = this.status(person, attempt);
    if (result.status !== 'pending') this.provider.failure('stale_access_state');
    return this.attemptBody(person, attempt);
  }
  complete(person: ConnectedPersonV1, attempt: string, reference: string, cloud: string, account: string, site: string): StoredPersonConnectionV1 {
    return this.db.transaction(() => {
      const pending = this.pending(person, attempt);
      if (pending.expected_account !== undefined && pending.expected_account !== account) this.provider.failure('unauthorized');
      const version = randomUUID();
      const binding = this.provider.copyBinding({ ...person, tool_id: this.provider.id, external_scope_id: cloud, external_subject_id: account, read_grant_sha256: canonicalSha256({ kind: `echo-${this.provider.id}-person-read-grant-v1`, ...person, cloud, account, reference, version }) });
      const stored = Object.freeze({ binding, reference: this.provider.string(reference, 512), site, version, active: true, attempt });
      // A Nango reference cannot be claimed by another Person or membership tenure.
      const owner = this.db.prepare(`SELECT person_key FROM ${this.bindingTable} WHERE reference=?`).get(reference) as { person_key: string } | undefined;
      if (owner !== undefined && owner.person_key !== this.key(person)) this.provider.failure('unauthorized');
      this.db.prepare(`INSERT OR REPLACE INTO ${this.bindingTable} VALUES(?,?,?)`).run(this.key(person), reference, canonicalJson(stored));
      this.writeAttempt(person, attempt, { ...pending, status: 'complete', failure_reason: null });
      return stored;
    })();
  }
  fail(person: ConnectedPersonV1, attempt: string, reason: PersonConnectionAttemptFailureV1): PersonConnectionAttemptV1 {
    return this.db.transaction(() => {
      const pending = this.pending(person, attempt);
      const failed: AttemptBody = { ...pending, status: 'failed', failure_reason: reason };
      this.writeAttempt(person, attempt, failed);
      return this.publicAttempt(attempt, failed);
    })();
  }
  cancel(person: ConnectedPersonV1, attempt: string): PersonConnectionAttemptV1 {
    const current = this.status(person, attempt);
    if (current.status !== 'pending') return current;
    const pending = this.attemptBody(person, attempt);
    const cancelled: AttemptBody = { ...pending, status: 'cancelled', failure_reason: null };
    this.writeAttempt(person, attempt, cancelled);
    return this.publicAttempt(attempt, cancelled);
  }
  revoke(person: ConnectedPersonV1): PersonConnectionAttemptV1 | undefined {
    const old = this.current(person);
    if (old !== undefined) this.db.prepare(`UPDATE ${this.bindingTable} SET body_json=? WHERE person_key=?`).run(canonicalJson({ ...old, active: false }), this.key(person));
    const row = this.db.prepare(`SELECT attempt FROM ${this.attemptTable} WHERE person_key=?`).get(this.key(person)) as { attempt: string } | undefined;
    if (row === undefined) return undefined;
    return this.cancel(person, row.attempt);
  }
  requireCurrent(binding: PersonConnectorReadBindingV1): StoredPersonConnectionV1 {
    const current = this.current({ organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id });
    if (current === undefined || !current.active || canonicalSha256(current.binding) !== canonicalSha256(binding)) this.provider.failure('stale_access_state');
    return current;
  }
}
