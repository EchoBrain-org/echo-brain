import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, RETURNED_MEMBER, addMembership, authorization, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });

function requestId(value: number): string { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }
function memberSet(number: number, project_id: string, membership_id: string, role: 'lead' | 'member') {
  return { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(number), project_id, membership_id, role };
}
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
  it('creates, discovers and administers projects through current exact-tenure grants', () => {
    const f = fixture(); const created = project(f, 10);
    expect(f.application.listProjectsV2('owner', {}).items).toEqual([expect.objectContaining({ project_id: created.project_id, role: 'lead' })]);
    expect(f.application.readProjectV2('owner', created.project_id)).toMatchObject({ project_id: created.project_id, name: 'Project 10' });
    expect(() => f.application.readProjectV2('member', created.project_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    f.application.setMember('owner', memberSet(11, created.project_id, MEMBER.membership_id, 'member'));
    expect(f.application.listMembers('member', { project_id: created.project_id })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ membership_id: MEMBER.membership_id, role: 'member' })]),
    });
    expect(() => f.application.setMember('owner', memberSet(12, created.project_id, OWNER.membership_id, 'member'))).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => f.application.setMember('member', memberSet(13, created.project_id, OWNER.membership_id, 'lead'))).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('archives without revoking existing reads, while blocking new project-scoped writes', () => {
    const f = fixture(); const alpha = project(f, 110); const beta = project(f, 111);
    for (const projectId of [alpha.project_id, beta.project_id]) {
      f.application.setMember('owner', memberSet(projectId === alpha.project_id ? 112 : 113, projectId, MEMBER.membership_id, 'member'));
    }
    expect(() => f.application.renameProject('member', { schema_version: 1, kind: 'echo-project-rename-v1', request_id: requestId(121), project_id: alpha.project_id, name: 'Forbidden' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => f.application.archiveProject('member', { schema_version: 1, kind: 'echo-project-archive-v1', request_id: requestId(122), project_id: alpha.project_id, archived: true })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const activePage = f.application.listProjectsV2('member', { status: 'active', limit: 1 });
    expect(activePage.next_cursor).not.toBeNull();
    const betaUpload = f.application.submitUploadV3('owner', {
      schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: requestId(115), title: 'Active evidence', text: 'Alternate project access remains readable.',
      association_project_ids: [beta.project_id], audience: { kind: 'project', project_id: beta.project_id },
    });
    const archive = { schema_version: 1 as const, kind: 'echo-project-archive-v1' as const, request_id: requestId(116), project_id: alpha.project_id, archived: true };
    expect(f.application.archiveProject('owner', archive)).toMatchObject({ operation: 'archive', state: 'applied' });
    expect(f.application.archiveProject('owner', archive)).toMatchObject({ operation: 'archive' });
    expect(() => f.application.listProjectsV2('member', { status: 'archived', limit: 1, cursor: activePage.next_cursor! })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(f.application.listProjectsV2('member', {}).items.map(item => item.project_id)).not.toContain(alpha.project_id);
    expect(f.application.listProjectsV2('member', { status: 'archived' }).items).toEqual([expect.objectContaining({ project_id: alpha.project_id, status: 'archived' })]);
    expect(f.application.readProjectV2('member', alpha.project_id)).toMatchObject({ status: 'archived' });
    expect(f.application.listMembers('member', { project_id: alpha.project_id }).items.map(item => item.membership_id)).toContain(MEMBER.membership_id);
    expect(() => f.application.submitUploadV3('owner', {
      schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: requestId(117), title: 'Blocked', text: 'No new archive content.',
      association_project_ids: [alpha.project_id], audience: { kind: 'team' },
    })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => f.application.associateContext('owner', {
      schema_version: 1, kind: 'echo-project-context-associate-v1', request_id: requestId(118), project_id: alpha.project_id, context_id: betaUpload.context_id,
    })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(f.application.renameProject('owner', { schema_version: 1, kind: 'echo-project-rename-v1', request_id: requestId(119), project_id: alpha.project_id, name: 'Archived Launch' })).toMatchObject({ operation: 'rename' });
    const leave = { schema_version: 1 as const, kind: 'echo-project-leave-v1' as const, request_id: requestId(120), project_id: alpha.project_id };
    expect(f.application.leaveProject('member', leave)).toMatchObject({ operation: 'leave' });
    expect(f.application.leaveProject('member', leave)).toMatchObject({ operation: 'leave' });
    expect(() => f.application.leaveProject('owner', { ...leave, request_id: requestId(121) })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('lets a lead add a selected organization member without treating a stale selection as a role change', () => {
    const f = fixture(); const created = project(f, 14);
    const add = { schema_version: 1 as const, kind: 'echo-project-member-add-v1' as const, request_id: requestId(15), project_id: created.project_id, membership_id: MEMBER.membership_id };
    expect(f.application.addMember('owner', add)).toMatchObject({ operation: 'member_set', membership_id: MEMBER.membership_id });
    f.application.setMember('owner', memberSet(16, created.project_id, MEMBER.membership_id, 'lead'));
    expect(f.application.addMember('owner', { ...add, request_id: requestId(17) })).toMatchObject({ operation: 'member_set' });
    expect(f.application.listMembers('owner', { project_id: created.project_id }).items.find(item => item.membership_id === MEMBER.membership_id)).toMatchObject({ role: 'lead' });
    const unshared = project(f, 18);
    expect(() => f.application.addMember('member', { ...add, request_id: requestId(19), project_id: unshared.project_id, membership_id: OWNER.membership_id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const reused = { ...add, request_id: requestId(20) };
    f.application.addMember('owner', reused);
    expect(() => f.application.setMember('owner', memberSet(20, reused.project_id, reused.membership_id, 'member'))).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('finds no retired V2 note: its association and status answer not_found (ADR-0048)', () => {
    const f = fixture(); const alpha = project(f, 20);
    const context_id = `ctx_${'e'.repeat(64)}`;
    f.database.prepare(`INSERT INTO authority_person_updates_v2
      (organization_id,principal_id,membership_id,membership_type,request_id,request_version,context_id,payload_sha256,title,text,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at)
      VALUES (?,?,?,?,?,2,?,?,?,?,'only_me',NULL,'[]','[]',NULL,?)`).run(OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type,
      requestId(23), context_id, `sha256:${'0'.repeat(64)}`, 'Retired', 'Retired V2 note', PROJECT_CONTEXT_NOW);
    expect(() => f.application.associateContext('owner', { schema_version: 1, kind: 'echo-project-context-associate-v1', request_id: requestId(24), project_id: alpha.project_id, context_id }))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => f.application.uploadStatusV3('owner', requestId(23))).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('requires a fresh organization and project grant after rejoin without reusing old access', () => {
    const f = fixture(); const alpha = project(f, 30);
    f.application.setMember('owner', memberSet(31, alpha.project_id, MEMBER.membership_id, 'member'));
    f.application.removeMember('owner', { schema_version: 1, kind: 'echo-project-member-remove-v1', request_id: requestId(33), project_id: alpha.project_id, membership_id: MEMBER.membership_id });
    revokeMembership(f.database, MEMBER);
    expect(() => f.application.listProjectsV2('member', {})).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    addMembership(f.database, RETURNED_MEMBER, 'Member returned', 'member@example.test');
    f.application.setMember('owner', memberSet(34, alpha.project_id, RETURNED_MEMBER.membership_id, 'member'));
    expect(f.application.readProjectV2('returned', alpha.project_id)).toMatchObject({ project_id: alpha.project_id, role: 'member' });
    expect(f.database.prepare("SELECT count(*) AS n FROM authority_project_memberships_v1 WHERE project_id = ? AND principal_id = ? AND status = 'active'").get(alpha.project_id, MEMBER.principal_id)).toEqual({ n: 1 });
  });
});
