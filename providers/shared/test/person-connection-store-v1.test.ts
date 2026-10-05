import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { JiraConnectionStoreV1 } from '../../jira/src/jira-connection-store-v1.js';
import { ConfluenceConnectionStoreV1 } from '../../confluence/src/confluence-connection-store-v1.js';
import { JIRA_PERSON_PROVIDER_V1 } from '../../jira/src/jira-validation-v1.js';
import { createPersonConnectionLifecycleV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { PersonProjectMappingStoreV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

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

describe('provider registration without shared engine branches', () => {
  type Mapping = { schema_version: 1; project_id: string; revision: string | null; mapping: null };
  const validateMapping = (value: unknown): Mapping => value as Mapping;
  function descriptor() {
    return { ...JIRA_PERSON_PROVIDER_V1, id: 'notebook', display_name: 'Notebook', storage_namespace: 'notebook_store',
      copyBinding(binding: PersonConnectorReadBindingV1) {
        if (binding.tool_id !== 'notebook') JIRA_PERSON_PROVIDER_V1.failure('unauthorized');
        return Object.freeze({ ...binding });
      },
    };
  }

  it('runs a third provider in both stores with a stable namespace and unchanged grant identity formula', () => {
    const database = new Database(':memory:');
    try {
      const provider = descriptor();
      const connections = new PersonConnectionStoreV1(database, provider);
      const mappings = new PersonProjectMappingStoreV1(database, provider, validateMapping);
      // Configuration objects cannot retarget a constructed store or its grant identity.
      provider.id = 'changed'; provider.storage_namespace = 'changed'; provider.display_name = 'Changed';
      const attempt = connections.begin(person);
      const grant = connections.complete(person, attempt.attempt, 'reference-fixture', cloud, 'account-fixture', site);
      expect(grant.binding.tool_id).toBe('notebook');
      expect(grant.binding.read_grant_sha256).toBe(canonicalSha256({ kind: 'echo-notebook-person-read-grant-v1', ...person,
        cloud, account: 'account-fixture', reference: grant.reference, version: grant.version }));
      expect(connections.requireCurrent(grant.binding)).toEqual(grant);
      expect(mappings.provider).toBe('notebook');
      const saved = mappings.set(person.organization_id, 'project-fixture', null, 'command-fixture', null);
      expect(mappings.read(person.organization_id, 'project-fixture')).toEqual(saved);
      expect(() => mappings.set(person.organization_id, 'project-fixture', null, 'different-command', null)).toThrow('Notebook project setting changed');
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
        { name: 'notebook_store_person_attempt_v1' }, { name: 'notebook_store_person_binding_v1' }, { name: 'notebook_store_project_mapping_v1' },
      ]);
    } finally { database.close(); }
  });

  it.each(['', 'with-hyphen', 'UPPER', 'x; DROP TABLE authority', 'a'.repeat(65)])('rejects an invalid SQL namespace before creating either store (%s)', storage_namespace => {
    const database = new Database(':memory:');
    try {
      const provider = { ...descriptor(), storage_namespace };
      expect(() => new PersonConnectionStoreV1(database, provider)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
      expect(() => new PersonProjectMappingStoreV1(database, provider, validateMapping)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally { database.close(); }
  });
});
