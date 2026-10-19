import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { describe, expect, it, vi } from 'vitest';
import { createPersonProjectMappingAccessV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { JiraProjectMappingStoreV1 } from '../../jira/src/jira-project-mapping-store-v1.js';
import { ConfluenceProjectMappingStoreV1 } from '../../confluence/src/confluence-project-mapping-store-v1.js';
import { JIRA_PERSON_PROVIDER_V1 } from '../../jira/src/jira-validation-v1.js';

const organization = 'org-fixture';
const project = 'prj_00000000-0000-4000-8000-000000000010';
const cloud = '00000000-0000-4000-8000-000000000007';
const revision = '00000000-0000-4000-8000-000000000008';

describe('shared project mapping storage', () => {
  it.each([
    { product: 'jira', Store: JiraProjectMappingStoreV1, mapping: { cloud_id: cloud, project_id: '10001', project_key: 'ECHO' } },
    { product: 'confluence', Store: ConfluenceProjectMappingStoreV1, mapping: { cloud_id: cloud, space_ids: ['10002'] } },
  ])('preserves existing $product rows, replay identity and atomic revision checks', ({ product, Store, mapping }) => {
    const db = new Database(':memory:');
    try {
      const table = `${product}_project_mapping_v1`;
      db.exec(`CREATE TABLE ${table} (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, body_json TEXT NOT NULL, command_sha256 TEXT NOT NULL, PRIMARY KEY(organization_id, project_id))`);
      const original = { schema_version: 1, project_id: project, revision, mapping };
      const serialized = canonicalJson(original);
      db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(organization, project, serialized, 'original-command');
      const store = new Store(db);
      expect(store.read(organization, project)).toEqual(original);
      expect(store.prepare(organization, project, null, 'original-command')).toEqual(original);
      expect(db.prepare(`SELECT body_json FROM ${table}`).get()).toEqual({ body_json: serialized });
      expect(store.read('different-org', project)).toEqual({ schema_version: 1, project_id: project, revision: null, mapping: null });
      expect(() => store.set(organization, project, null, 'new-command', null)).toThrow(expect.objectContaining({ code: 'conflict' }));

      // Provider resolution can run between prepare and set. A competing update
      // must be detected again by the atomic final CAS, never overwritten.
      expect(store.prepare(organization, project, revision, 'new-command')).toBeUndefined();
      const cleared = store.set(organization, project, revision, 'competing-command', null);
      expect(cleared.revision).not.toBe(revision);
      expect(() => store.set(organization, project, revision, 'new-command', null)).toThrow(expect.objectContaining({ code: 'conflict' }));
      expect(store.set(organization, project, revision, 'competing-command', null)).toEqual(cleared);
      expect(store.replay(organization, project, 'original-command')).toBeUndefined();
      expect(db.prepare(`SELECT body_json, command_sha256 FROM ${table}`).get()).toEqual({ body_json: canonicalJson(cleared), command_sha256: 'competing-command' });
    } finally { db.close(); }
  });

  it('keeps provider namespaces independent for the same organization and project', () => {
    const db = new Database(':memory:');
    try {
      const jira = new JiraProjectMappingStoreV1(db), confluence = new ConfluenceProjectMappingStoreV1(db);
      const saved = jira.set(organization, project, null, 'shared-command', null);
      expect(confluence.replay(organization, project, 'shared-command')).toBeUndefined();
      expect(confluence.read(organization, project).revision).toBeNull();
      confluence.set(organization, project, null, 'shared-command', null);
      expect(jira.read(organization, project)).toEqual(saved);
    } finally { db.close(); }
  });
});

it('requires project leadership for changes and fences authorization drift independently of provider grants', () => {
  const db = new Database(':memory:');
  try {
    const project_mappings = new JiraProjectMappingStoreV1(db);
    const grant: { role: 'lead' | 'member'; authorization_sha256: ReturnType<typeof canonicalSha256> } = { role: 'member', authorization_sha256: canonicalSha256('first') };
    const authorize_project = vi.fn(() => grant);
    const access = createPersonProjectMappingAccessV1(JIRA_PERSON_PROVIDER_V1, { project_mappings, authorize_project });
    expect(() => access.projectAccess('session', project, true)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    grant.role = 'lead';
    const selected = access.projectAccess('session', project, true);
    expect(selected.store).toBe(project_mappings);
    selected.current();
    grant.authorization_sha256 = canonicalSha256('changed');
    expect(() => selected.current()).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(authorize_project).toHaveBeenCalledWith('session', project);
    expect(() => access.mappingInput(() => { throw new Error('untrusted validator detail'); })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => createPersonProjectMappingAccessV1(JIRA_PERSON_PROVIDER_V1, {}).projectAccess('session', project)).toThrow(expect.objectContaining({ code: 'unavailable' }));
    expect(() => createPersonProjectMappingAccessV1(JIRA_PERSON_PROVIDER_V1, { project_mappings: new ConfluenceProjectMappingStoreV1(db), authorize_project }).projectAccess('session', project)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  } finally { db.close(); }
});

describe('the ECHO project names a tool container carries (research tool contract v1)', () => {
  const projects = [10, 11, 12, 13].map(index => `prj_00000000-0000-4000-8000-0000000000${index}`);
  /** Four mapped ECHO projects, the first two on one Jira project; the asker belongs to the first three. */
  function fixture() {
    const db = new Database(':memory:');
    const project_mappings = new JiraProjectMappingStoreV1(db);
    const map = (id: string, jira: string) => project_mappings.set(organization, id, project_mappings.read(organization, id).revision, canonicalSha256(randomUUID()), { cloud_id: cloud, project_id: jira, project_key: `K${jira}` });
    for (const [index, jira] of ['10001', '10001', '10002', '10003'].entries()) map(projects[index]!, jira);
    const visible = new Set(projects.slice(0, 3));
    const names = new Map(projects.map((id, index) => [id, ['Atlas', 'Beacon', 'Comet', 'Hidden'][index]!]));
    const authorize_project = vi.fn((_token: string, id: string) => {
      if (!visible.has(id)) throw new AuthorityOperationError('unauthorized', 'Fixture project access is unavailable');
      return { role: 'member' as const, authorization_sha256: canonicalSha256(id) };
    });
    // As the port promises: names only for the projects the asker can see.
    const project_names = vi.fn((_token: string, ids: readonly string[]) => new Map(ids.filter(id => visible.has(id)).map(id => [id, names.get(id)!])));
    const access = createPersonProjectMappingAccessV1(JIRA_PERSON_PROVIDER_V1, { project_mappings, authorize_project, project_names });
    const named = access.containerProjects('session', organization, mapping => mapping.cloud_id === cloud ? [mapping.project_id] : []);
    return { db, project_mappings, map, visible, names, authorize_project, project_names, named };
  }

  it('pins with each mapped project\'s grant, then fences with one mapping read and one names read, never a grant per project', () => {
    const f = fixture();
    try {
      expect([...f.named.names]).toEqual([['10001', ['Atlas', 'Beacon']], ['10002', ['Comet']]]);
      f.authorize_project.mockClear(); f.project_names.mockClear();
      const list = vi.spyOn(f.project_mappings, 'list');
      for (let check = 0; check < 3; check += 1) f.named.current();
      expect(f.authorize_project).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(3);
      expect(f.project_names).toHaveBeenCalledTimes(3);
      // Every mapped project at once; the port names only those the asker can see.
      expect(f.project_names).toHaveBeenLastCalledWith('session', projects);
    } finally { f.db.close(); }
  });

  it.each([
    ['losing access to a mapped project', (f: ReturnType<typeof fixture>) => { f.visible.delete(projects[2]!); }],
    ['gaining access to a mapped project', (f: ReturnType<typeof fixture>) => { f.visible.add(projects[3]!); }],
    ['a mapping change', (f: ReturnType<typeof fixture>) => { f.map(projects[2]!, '10004'); }],
    ['a rename', (f: ReturnType<typeof fixture>) => { f.names.set(projects[0]!, 'Atlas Two'); }],
  ])('refuses %s at the next fence', (_change, change) => {
    const f = fixture();
    try {
      f.named.current();
      f.authorize_project.mockClear();
      change(f);
      expect(() => f.named.current()).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
      expect(f.authorize_project).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it('passes a change to a project the asker cannot see', () => {
    const f = fixture();
    try {
      f.map(projects[3]!, '10005'); f.names.set(projects[3]!, 'Hidden Two');
      expect(() => f.named.current()).not.toThrow();
    } finally { f.db.close(); }
  });
});
