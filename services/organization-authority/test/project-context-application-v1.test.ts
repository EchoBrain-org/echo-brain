import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, RETURNED_MEMBER, addMembership, authorization, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });

const create = {
  schema_version: 1 as const,
  kind: 'echo-project-create-v1' as const,
  request_id: '00000000-0000-4000-8000-000000000001',
  name: 'Launch',
};
function requestId(value: number): string { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }
function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  const application = createProjectContextApplicationV1({
    authenticate: token => authorization(token === 'member' ? MEMBER : token === 'returned' ? RETURNED_MEMBER : OWNER),
    repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW),
  });
  return { database, application };
}
function project(f: ReturnType<typeof fixture>, number: number) {
  return f.application.createProject('owner', {
    schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(number), name: `Project ${number}`,
  });
}

describe('ProjectContextApplicationV1', () => {
  it('authenticates and validates before forming the repository-owned create scope', () => {
    const database = projectContextDatabase(); databases.push(database);
    const authenticate = (token: string) => {
      if (token !== 'good') throw new AuthorityOperationError('unauthorized', 'request failed');
      return authorization(OWNER);
    };
    const application = createProjectContextApplicationV1({
      authenticate,
      repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW),
    });

    expect(() => application.createProject('bad', create)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => application.createProject('good', { ...create, authorization_revision: 'caller' })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(application.createProject('good', create)).toMatchObject({ request_id: create.request_id, state: 'created' });
  });

  it('reauthenticates in the final release transaction and releases no selected bytes after a changed session', () => {
    const database = projectContextDatabase(); databases.push(database);
    const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
    const stable = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository });
    stable.createProject('token', create);
    let calls = 0;
    const application = createProjectContextApplicationV1({
      authenticate: () => authorization(OWNER, { session_state_sha256: canonicalSha256({ session: ++calls }) }),
      repository,
    });

    expect(() => application.listProjects('token', {})).toThrow(expect.objectContaining<Partial<AuthorityOperationError>>({ code: 'stale_access_state' }));
    expect(database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get()).toEqual({ n: 0 });
  });

  it('creates, discovers and administers projects through current exact-tenure grants', () => {
    const f = fixture(); const created = project(f, 10);
    expect(f.application.listProjects('owner', {}).items).toEqual([expect.objectContaining({ project_id: created.project_id, role: 'lead' })]);
    expect(f.application.readProject('owner', created.project_id)).toMatchObject({ project_id: created.project_id, name: 'Project 10' });
    expect(() => f.application.readProject('member', created.project_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    f.application.setMember('owner', {
      schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(11), project_id: created.project_id,
      membership_id: MEMBER.membership_id, role: 'member',
    });
    expect(f.application.listMembers('member', { project_id: created.project_id })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ membership_id: MEMBER.membership_id, role: 'member' })]),
    });
    expect(() => f.application.setMember('owner', {
      schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(12), project_id: created.project_id,
      membership_id: OWNER.membership_id, role: 'member',
    })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => f.application.setMember('member', {
      schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(13), project_id: created.project_id,
      membership_id: OWNER.membership_id, role: 'lead',
    })).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('lets a lead add a selected organization member without treating a stale selection as a role change', () => {
    const f = fixture(); const created = project(f, 14);
    const add = { schema_version: 1 as const, kind: 'echo-project-member-add-v1' as const, request_id: requestId(15), project_id: created.project_id, membership_id: MEMBER.membership_id };
    expect(f.application.addMember('owner', add)).toMatchObject({ operation: 'member_set', membership_id: MEMBER.membership_id });
    f.application.setMember('owner', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(16), project_id: created.project_id, membership_id: MEMBER.membership_id, role: 'lead' });
    expect(f.application.addMember('owner', { ...add, request_id: requestId(17) })).toMatchObject({ operation: 'member_set' });
    expect(f.application.listMembers('owner', { project_id: created.project_id }).items.find(item => item.membership_id === MEMBER.membership_id)).toMatchObject({ role: 'lead' });
    const unshared = project(f, 18);
    expect(() => f.application.addMember('member', { ...add, request_id: requestId(19), project_id: unshared.project_id, membership_id: OWNER.membership_id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const reused = { ...add, request_id: requestId(20) };
    f.application.addMember('owner', reused);
    expect(() => f.application.setMember('owner', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: reused.request_id, project_id: reused.project_id, membership_id: reused.membership_id, role: 'member' })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('keeps source audience separate from association, visibility, and association replay', () => {
    const f = fixture(); const alpha = project(f, 20); const beta = project(f, 21);
    f.application.setMember('owner', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(22), project_id: alpha.project_id, membership_id: MEMBER.membership_id, role: 'member' });
    const privateReceipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(23), title: 'Private', text: 'Private original', project_id: null, audience: { kind: 'only_me' },
    });
    const association = { schema_version: 1 as const, kind: 'echo-project-context-associate-v1' as const, request_id: requestId(24), project_id: alpha.project_id, context_id: privateReceipt.context_id };
    const first = f.application.associateContext('owner', association);
    expect(f.application.associateContext('owner', association)).toEqual(first);
    expect(() => f.application.associateContext('owner', { ...association, request_id: requestId(25), project_id: beta.project_id })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => f.application.readContext('member', alpha.project_id, privateReceipt.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => f.application.dissociateContext('member', { schema_version: 1, kind: 'echo-project-context-dissociate-v1', request_id: requestId(26), project_id: alpha.project_id, context_id: privateReceipt.context_id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    f.application.dissociateContext('owner', { schema_version: 1, kind: 'echo-project-context-dissociate-v1', request_id: requestId(27), project_id: alpha.project_id, context_id: privateReceipt.context_id });
    expect(f.application.associateContext('owner', association)).toEqual(first);
    expect(f.database.prepare('SELECT count(*) AS n FROM authority_project_context_associations_v1 WHERE context_id = ?').get(privateReceipt.context_id)).toEqual({ n: 0 });

    const team = f.application.submitUpload('owner', { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(28), title: 'Team', text: 'Team original', project_id: alpha.project_id, audience: { kind: 'team' } });
    const scoped = f.application.submitUpload('owner', { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(29), title: 'Project', text: 'Project original', project_id: alpha.project_id, audience: { kind: 'project', project_id: alpha.project_id } });
    expect(f.application.feed('member', { project_id: alpha.project_id }).items.map(item => item.context_id).sort()).toEqual([scoped.context_id, team.context_id].sort());
    expect(f.application.readUpload('member', team.context_id).text).toBe('Team original');
    expect(f.application.readUpload('member', scoped.context_id).text).toBe('Project original');
    expect(() => f.application.readUpload('member', privateReceipt.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('requires a fresh organization and project grant after rejoin without reusing old access', () => {
    const f = fixture(); const alpha = project(f, 30);
    f.application.setMember('owner', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(31), project_id: alpha.project_id, membership_id: MEMBER.membership_id, role: 'member' });
    const receipt = f.application.submitUpload('owner', { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(32), title: 'Project', text: 'Project original', project_id: alpha.project_id, audience: { kind: 'project', project_id: alpha.project_id } });
    f.application.removeMember('owner', { schema_version: 1, kind: 'echo-project-member-remove-v1', request_id: requestId(33), project_id: alpha.project_id, membership_id: MEMBER.membership_id });
    revokeMembership(f.database, MEMBER);
    expect(() => f.application.readUpload('member', receipt.context_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    addMembership(f.database, RETURNED_MEMBER, 'Member returned', 'member@example.test');
    f.application.setMember('owner', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(34), project_id: alpha.project_id, membership_id: RETURNED_MEMBER.membership_id, role: 'member' });
    expect(f.application.readUpload('returned', receipt.context_id)).toMatchObject({ text: 'Project original' });
    expect(f.database.prepare("SELECT count(*) AS n FROM authority_project_memberships_v1 WHERE project_id = ? AND principal_id = ? AND status = 'active'").get(alpha.project_id, MEMBER.principal_id)).toEqual({ n: 1 });
  });
});
