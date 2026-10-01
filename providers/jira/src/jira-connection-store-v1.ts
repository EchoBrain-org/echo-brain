import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { copyJiraBindingV1, jiraFailure, jiraString } from './jira-validation-v1.js';

export type JiraPersonV1 = Pick<PersonConnectorReadBindingV1, 'organization_id' | 'principal_id' | 'membership_id'>;
export interface JiraStoredConnectionV1 { readonly binding: PersonConnectorReadBindingV1; readonly reference: string; readonly site: string; readonly version: string; readonly active: boolean; readonly attempt: string }
interface Attempt { readonly person: JiraPersonV1; readonly expected_account?: string; readonly expires: number }

/** Provider-owned database; immutable Authority SQL baselines are not modified. No credentials or evidence. */
export class JiraConnectionStoreV1 {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS jira_person_binding_v1 (person_key TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jira_person_attempt_v1 (attempt TEXT PRIMARY KEY, person_key TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);`);
  }
  private key(person: JiraPersonV1): string { return canonicalSha256(person); }
  current(person: JiraPersonV1): JiraStoredConnectionV1 | undefined {
    const row = this.db.prepare('SELECT body_json FROM jira_person_binding_v1 WHERE person_key=?').get(this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.body_json) as JiraStoredConnectionV1;
    return Object.freeze({ ...value, binding: copyJiraBindingV1(value.binding) });
  }
  begin(person: JiraPersonV1): { readonly attempt: string } {
    return this.db.transaction(() => {
      const old = this.current(person); this.revoke(person);
      const attempt = randomUUID();
      const body: Attempt = { person: Object.freeze({ ...person }), expires: this.now() + 30 * 60_000, ...(old === undefined ? {} : { expected_account: old.binding.external_subject_id }) };
      this.db.prepare('INSERT OR REPLACE INTO jira_person_attempt_v1 VALUES(?,?,?)').run(attempt, this.key(person), canonicalJson(body));
      return Object.freeze({ attempt });
    })();
  }
  attempt(person: JiraPersonV1, attempt: string): Attempt {
    const row = this.db.prepare('SELECT body_json FROM jira_person_attempt_v1 WHERE attempt=? AND person_key=?').get(attempt, this.key(person)) as { body_json: string } | undefined;
    if (row === undefined) jiraFailure('unauthorized');
    const value = JSON.parse(row.body_json) as Attempt;
    if (value.expires <= this.now() || this.key(value.person) !== this.key(person)) jiraFailure('unauthorized');
    return value;
  }
  complete(person: JiraPersonV1, attempt: string, reference: string, cloud: string, account: string, site: string): JiraStoredConnectionV1 {
    return this.db.transaction(() => {
      const pending = this.attempt(person, attempt);
      if (pending.expected_account !== undefined && pending.expected_account !== account) jiraFailure('unauthorized');
      const version = randomUUID();
      const binding = copyJiraBindingV1({ ...person, tool_id: 'jira', external_scope_id: cloud, external_subject_id: account, read_grant_sha256: canonicalSha256({ kind: 'echo-jira-person-read-grant-v1', ...person, cloud, account, reference, version }) });
      const stored = Object.freeze({ binding, reference: jiraString(reference, 512), site, version, active: true, attempt });
      // A Nango reference cannot be claimed by another Person or membership tenure.
      const owner = this.db.prepare('SELECT person_key FROM jira_person_binding_v1 WHERE reference=?').get(reference) as { person_key: string } | undefined;
      if (owner !== undefined && owner.person_key !== this.key(person)) jiraFailure('unauthorized');
      this.db.prepare('INSERT OR REPLACE INTO jira_person_binding_v1 VALUES(?,?,?)').run(this.key(person), reference, canonicalJson(stored));
      this.db.prepare('DELETE FROM jira_person_attempt_v1 WHERE attempt=?').run(attempt);
      return stored;
    })();
  }
  revoke(person: JiraPersonV1): void {
    const old = this.current(person);
    if (old !== undefined) this.db.prepare('UPDATE jira_person_binding_v1 SET body_json=? WHERE person_key=?').run(canonicalJson({ ...old, active: false }), this.key(person));
    this.db.prepare('DELETE FROM jira_person_attempt_v1 WHERE person_key=?').run(this.key(person));
  }
  requireCurrent(binding: PersonConnectorReadBindingV1): JiraStoredConnectionV1 {
    const current = this.current({ organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id });
    if (current === undefined || !current.active || canonicalSha256(current.binding) !== canonicalSha256(binding)) jiraFailure('stale_access_state');
    return current;
  }
}
