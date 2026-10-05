import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { JiraConnectionStoreV1 } from '../../jira/src/jira-connection-store-v1.js';
import { ConfluenceConnectionStoreV1 } from '../../confluence/src/confluence-connection-store-v1.js';
import { JIRA_PERSON_PROVIDER_V1 } from '../../jira/src/jira-validation-v1.js';
import { createPersonConnectionLifecycleV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';

const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'membership-fixture' };
const cloud = '00000000-0000-4000-8000-000000000007';
const site = 'https://fixture.atlassian.net';

describe('shared Atlassian custody with separate product identities', () => {
  it.each([
    { product: 'jira', Store: JiraConnectionStoreV1, table: 'jira_person_binding_v1' },
    { product: 'confluence', Store: ConfluenceConnectionStoreV1, table: 'confluence_person_binding_v1' },
  ])('reads the existing $product row unchanged and retains its grant hash format', ({ product, Store, table }) => {
    const database = new Database(':memory:');
    try {
      // Seed the pre-extraction schema and serialized grant, not a row produced
      // by the new implementation. Existing connections require no migration.
      database.exec(`CREATE TABLE ${table} (person_key TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL)`);
      const grant = { kind: `echo-${product}-person-read-grant-v1`, ...person, cloud, account: 'account-fixture', reference: 'reference-fixture', version: 'version-fixture' };
      const stored = { binding: { ...person, tool_id: product, external_scope_id: cloud, external_subject_id: grant.account, read_grant_sha256: canonicalSha256(grant) }, reference: grant.reference, site, version: grant.version, active: true, attempt: 'attempt-fixture' };
      const original = canonicalJson(stored);
      database.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(canonicalSha256(person), stored.reference, original);
      const store = new Store(database);
      expect(store.current(person)).toEqual(stored);
      expect(store.requireCurrent(stored.binding)).toEqual(stored);
      expect(database.prepare(`SELECT body_json FROM ${table}`).get()).toEqual({ body_json: original });
      const attempt = store.begin(person);
      const next = store.complete(person, attempt.attempt, 'new-reference', cloud, grant.account, site);
      expect(next.binding.read_grant_sha256).toBe(canonicalSha256({ ...grant, reference: next.reference, version: next.version }));
    } finally { database.close(); }
  });

  it('keeps grants and consent attempts independent even for the same person and reference', () => {
    const database = new Database(':memory:');
    try {
      const jira = new JiraConnectionStoreV1(database);
      const confluence = new ConfluenceConnectionStoreV1(database);
      const jiraAttempt = jira.begin(person);
      const confluenceAttempt = confluence.begin(person);
      const jiraGrant = jira.complete(person, jiraAttempt.attempt, 'same-reference', cloud, 'account-fixture', site);
      const confluenceGrant = confluence.complete(person, confluenceAttempt.attempt, 'same-reference', cloud, 'account-fixture', site);
      expect(jiraGrant.binding.read_grant_sha256).not.toBe(confluenceGrant.binding.read_grant_sha256);
      confluence.revoke(person);
      expect(() => confluence.requireCurrent(confluenceGrant.binding)).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
      expect(jira.requireCurrent(jiraGrant.binding)).toEqual(jiraGrant);
      expect(jira.status(person, jiraAttempt.attempt).status).toBe('complete');
      expect(() => confluence.status(person, jiraAttempt.attempt)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
      const fetch = vi.fn();
      expect(() => createPersonConnectionLifecycleV1({ provider: JIRA_PERSON_PROVIDER_V1, store: confluence, scope_id: cloud, nango: {} as never, fetch, authenticate: vi.fn(), verify: vi.fn() })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { database.close(); }
  });
});
