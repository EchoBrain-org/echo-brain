import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import type { ProjectContextApplicationV1, ProjectReadResponseV1 } from '../src/application/ports/project-context-v1.js';
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (database.open) database.close();
});

function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function fixture() {
  const database = projectContextDatabase();
  databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const application = createProjectContextApplicationV1({ authenticate: () => authorization(), repository });
  const project = application.createProject('person', {
    schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(1), name: 'Release proof',
  });
  application.setMember('person', {
    schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(2),
    project_id: project.project_id, membership_id: MEMBER.membership_id, role: 'member',
  });
  const upload = application.submitUpload('person', {
    schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(3),
    title: 'Original needle', text: 'Immutable original needle.',
    project_id: project.project_id, audience: { kind: 'project', project_id: project.project_id },
  });
  return { database, repository, application, project, upload };
}

type Fixture = ReturnType<typeof fixture>;
const reads: ReadonlyArray<{
  name: string;
  run: (application: ProjectContextApplicationV1, state: Fixture) => ProjectReadResponseV1;
}> = [
  { name: 'project list', run: app => app.listProjects('person', {}) },
  { name: 'project read', run: (app, s) => app.readProject('person', s.project.project_id) },
  { name: 'roster', run: (app, s) => app.listMembers('person', { project_id: s.project.project_id }) },
  { name: 'directory', run: (app, s) => app.searchDirectory('person', { project_id: s.project.project_id, query: 'member' }) },
  { name: 'feed', run: (app, s) => app.feed('person', { project_id: s.project.project_id }) },
  { name: 'project search', run: (app, s) => app.search('person', { project_id: s.project.project_id, query: 'needle' }) },
  { name: 'project original', run: (app, s) => app.readContext('person', s.project.project_id, s.upload.context_id) },
  { name: 'upload status', run: (app, s) => app.uploadStatus('person', s.upload.request_id) },
  { name: 'upload original', run: (app, s) => app.readUpload('person', s.upload.context_id) },
  { name: 'upload search', run: app => app.searchUploads('person', { query: 'needle' }) },
];

function audits(database: Database.Database): number {
  return (database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get() as { n: number }).n;
}

describe('project application final release boundary', () => {
  it.each(reads)('reauthenticates $name inside the audit transaction before releasing its exact response', ({ run }) => {
    const state = fixture();
    const phases: boolean[] = [];
    const authenticate = vi.fn(() => {
      phases.push(state.database.inTransaction);
      return authorization();
    });
    const application = createProjectContextApplicationV1({ authenticate, repository: state.repository });
    const response = run(application, state);
    expect(phases).toEqual([false, true]);
    expect(authenticate.mock.calls).toHaveLength(2);
    expect(state.database.inTransaction).toBe(false);
    expect(Object.isFrozen(response)).toBe(true);
    const row = state.database.prepare('SELECT body_json FROM authority_project_read_audit_v1').get() as { body_json: string };
    expect(JSON.parse(row.body_json)).toMatchObject({ response_sha256: canonicalSha256(response) });
    expect(audits(state.database)).toBe(1);
  });

  it.each(reads)('releases no $name response or audit after the session is revoked during selection', ({ run }) => {
    const state = fixture();
    const authenticate = vi.fn(() => authorization()).mockImplementationOnce(() => authorization());
    authenticate.mockImplementation(() => { throw new AuthorityOperationError('unauthorized', 'request failed'); });
    const application = createProjectContextApplicationV1({ authenticate, repository: state.repository });
    expect(() => run(application, state)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(audits(state.database)).toBe(0);
    expect(state.database.inTransaction).toBe(false);
  });

  it('returns the repository audited object itself only after the repository commits', () => {
    const state = fixture();
    let audited: ProjectReadResponseV1 | undefined;
    const application = createProjectContextApplicationV1({
      authenticate: () => authorization(),
      repository: {
        withWriteTransaction: operation => state.repository.withWriteTransaction(operation),
        withReadTransaction: operation => state.repository.withReadTransaction(transaction => {
          const original = transaction.revalidateAndAuditRelease.bind(transaction);
          vi.spyOn(transaction, 'revalidateAndAuditRelease').mockImplementation((snapshot, actor, response) => {
            const exact = original(snapshot, actor, response);
            audited = exact;
            expect(state.database.inTransaction).toBe(true);
            return exact;
          });
          return operation(transaction);
        }),
      },
    });
    const response = application.feed('person', { project_id: state.project.project_id });
    expect(response).toBe(audited);
    expect(Object.isFrozen(response.items)).toBe(true);
    expect(Object.isFrozen(response.items[0])).toBe(true);
    expect(state.database.inTransaction).toBe(false);
  });

  it('releases nothing when audit persistence fails and keeps the original readable afterward', () => {
    const state = fixture();
    state.database.exec(`CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON authority_project_read_audit_v1
      BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
    expect(() => state.application.readUpload('person', state.upload.context_id)).toThrow('fixture audit failure');
    expect(audits(state.database)).toBe(0);
    state.database.exec('DROP TRIGGER fixture_reject_audit');
    expect(state.application.readUpload('person', state.upload.context_id).text).toBe('Immutable original needle.');
  });

  it('releases nothing when COMMIT fails after a successful audit append', () => {
    const state = fixture();
    // A deferred constraint fails at COMMIT, after the release callback returns.
    state.database.exec(`
      CREATE TABLE fixture_commit_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_commit_child (parent_id INTEGER REFERENCES fixture_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fixture_fail_commit AFTER INSERT ON authority_project_read_audit_v1
      BEGIN INSERT INTO fixture_commit_child(parent_id) VALUES (1); END;
    `);
    expect(() => state.application.readUpload('person', state.upload.context_id)).toThrow('FOREIGN KEY constraint failed');
    expect(state.database.inTransaction).toBe(false);
    expect(audits(state.database)).toBe(0);
    expect(state.database.prepare('SELECT count(*) AS n FROM fixture_commit_child').get()).toEqual({ n: 0 });
  });

  it('denies removal of the reader project grant between candidate admission and final release', () => {
    const state = fixture();
    let calls = 0;
    const application = createProjectContextApplicationV1({
      repository: state.repository,
      authenticate: () => {
        if (++calls === 2) state.database.prepare(`UPDATE authority_project_memberships_v1
          SET status = 'revoked', revoked_at = ? WHERE membership_id = ? AND project_id = ?`)
          .run(PROJECT_CONTEXT_NOW, MEMBER.membership_id, state.project.project_id);
        return authorization(MEMBER);
      },
    });
    expect(() => application.readContext('person', state.project.project_id, state.upload.context_id))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(calls).toBe(2);
    expect(audits(state.database)).toBe(0);
  });

  it.each<Partial<PersonAccessAuthorization>>([
    { principal_id: MEMBER.principal_id },
    { membership_id: MEMBER.membership_id },
    { organization_id: 'org_other' },
    { session_family_id: 'different-family' },
    { person_state_sha256: canonicalSha256('different person state') },
    { access_credential_sha256: canonicalSha256('different credential') },
  ])('denies substitution of the authenticated Person binding: %j', changes => {
    const state = fixture();
    const authenticate = vi.fn(() => authorization(OWNER, changes)).mockImplementationOnce(() => authorization());
    const application = createProjectContextApplicationV1({ authenticate, repository: state.repository });
    expect(() => application.readUpload('person', state.upload.context_id))
      .toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(audits(state.database)).toBe(0);
  });

  it('rejects unknown caller authorization fields and accessors before opening a transaction', () => {
    const state = fixture();
    const write = vi.spyOn(state.repository, 'withWriteTransaction');
    const read = vi.spyOn(state.repository, 'withReadTransaction');
    const getter = vi.fn(() => 'Caller-chosen name');
    const base = { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(4), name: 'New project' };
    const accessor = { ...base };
    Object.defineProperty(accessor, 'name', { enumerable: true, get: getter });
    for (const value of [{ ...base, membership_id: MEMBER.membership_id }, { ...base, authorization_revision: 1 }, accessor]) {
      expect(() => state.application.createProject('person', value)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(() => state.application.listProjects('person', { organization_id: OWNER.organization_id }))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('distinguishes malformed coordinates from valid missing or inaccessible coordinates without opening an invalid scope', () => {
    const state = fixture();
    const read = vi.spyOn(state.repository, 'withReadTransaction');
    for (const action of [
      () => state.application.readProject('person', 'not-a-project'),
      () => state.application.readContext('person', state.project.project_id, 'not-a-context'),
      () => state.application.readContext('person', 'not-a-project', state.upload.context_id),
      () => state.application.uploadStatus('person', 'not-a-request'),
      () => state.application.readUpload('person', 'not-a-context'),
    ]) expect(action).toThrow(expect.objectContaining({ code: 'invalid_request', message: 'request failed' }));
    expect(read).not.toHaveBeenCalled();

    const member = createProjectContextApplicationV1({ authenticate: () => authorization(MEMBER), repository: state.repository });
    const privateReceipt = state.application.submitUpload('person', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(5),
      title: 'Private needle', text: 'Hidden original.', audience: { kind: 'only_me' }, project_id: state.project.project_id,
    });
    for (const contextId of [privateReceipt.context_id, `ctx_${'f'.repeat(64)}`]) {
      expect(() => member.readUpload('person', contextId))
        .toThrow(expect.objectContaining({ code: 'not_found', message: 'request failed' }));
      expect(() => member.readContext('person', state.project.project_id, contextId))
        .toThrow(expect.objectContaining({ code: 'not_found', message: 'request failed' }));
    }
    expect(audits(state.database)).toBe(0);
  });
});
