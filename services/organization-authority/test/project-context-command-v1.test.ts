import { describe, expect, it } from 'vitest';
import { validatePersonUpdateSubmitV2, type PersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { projectCommandIdentityV1 } from '../src/application/project-context-command-v1.js';

const id = '00000000-0000-4000-8000-000000000001';
const project = `prj_${id}` as const;
const otherProject = 'prj_00000000-0000-4000-8000-000000000002' as const;
const actor: AuthorityPersonMembershipBinding = {
  organization_id: `org_${id}`, principal_id: `prn_${id}`,
  membership_id: `mem_${id}`, membership_type: 'employee',
};
const upload = validatePersonUpdateSubmitV2({
  schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: id,
  title: 'Launch notes', text: '  Original café notes.\n\n',
  audience: { kind: 'only_me' }, project_id: project,
});
const identity = (request: PersonUpdateSubmitV2, member = actor) =>
  projectCommandIdentityV1(member, { operation: 'upload_submit', request });

describe('PC-00 immutable command identity (no persistence or authorization implementation)', () => {
  it('replays the same accepted bytes independent of JSON property order', () => {
    const reordered = Object.fromEntries(Object.entries(upload).reverse()) as unknown as PersonUpdateSubmitV2;
    expect(identity(reordered)).toEqual(identity(upload));
    expect(upload.text).toBe('  Original café notes.\n\n');
  });

  it.each([
    { title: 'Other title' },
    { text: upload.text.trim() },
    { text: '  Original cafe\u0301 notes.\n\n' },
    { project_id: otherProject },
    { project_id: null },
    { audience: { kind: 'team' } },
    { audience: { kind: 'project', project_id: project } },
    { audience: { kind: 'project', project_id: otherProject } },
  ])('binds each changed original/audience/association coordinate: %j', (change) => {
    const changed = identity(validatePersonUpdateSubmitV2({ ...upload, ...change }));
    const original = identity(upload);
    expect(changed.organization_id).toBe(original.organization_id);
    expect(changed.membership_id).toBe(original.membership_id);
    expect(changed.request_id).toBe(original.request_id);
    expect(changed.command_sha256).not.toBe(original.command_sha256);
  });

  it('never carries a command across an organization or membership tenure', () => {
    for (const change of [
      { organization_id: 'org_00000000-0000-4000-8000-000000000002' },
      { membership_id: 'mem_00000000-0000-4000-8000-000000000002' },
      { principal_id: 'prn_00000000-0000-4000-8000-000000000002' },
    ]) expect(identity(upload, { ...actor, ...change }).command_sha256).not.toBe(identity(upload).command_sha256);
  });

  it('does not reinterpret the accepted command when the current org role changes', () => {
    expect(identity(upload, { ...actor, membership_type: 'owner' })).toEqual(identity(upload));
  });

  it('shares a retry namespace across mutation operations without conflating their commitments', () => {
    const add = projectCommandIdentityV1(actor, { operation: 'associate', request: {
      schema_version: 1, kind: 'echo-project-context-associate-v1',
      request_id: id, project_id: project, context_id: `ctx_${'a'.repeat(64)}`,
    } });
    const remove = projectCommandIdentityV1(actor, { operation: 'dissociate', request: {
      schema_version: 1, kind: 'echo-project-context-dissociate-v1',
      request_id: id, project_id: project, context_id: `ctx_${'a'.repeat(64)}`,
    } });
    expect({ ...add, command_sha256: null }).toEqual({ ...remove, command_sha256: null });
    expect(add.command_sha256).not.toBe(remove.command_sha256);
  });

  it('binds project name, member target and assigned role', () => {
    const create = (name: string) => projectCommandIdentityV1(actor, { operation: 'create', request: {
      schema_version: 1, kind: 'echo-project-create-v1', request_id: id, name,
    } });
    expect(create('Launch').command_sha256).not.toBe(create('Planning').command_sha256);
    const request = {
      schema_version: 1 as const, kind: 'echo-project-member-set-v1' as const,
      request_id: id, project_id: project, membership_id: actor.membership_id, role: 'member' as const,
    };
    const original = projectCommandIdentityV1(actor, { operation: 'member_set', request });
    for (const change of [{ role: 'lead' as const }, { membership_id: 'mem_00000000-0000-4000-8000-000000000002' }, { project_id: otherProject }]) {
      expect(projectCommandIdentityV1(actor, { operation: 'member_set', request: { ...request, ...change } }).command_sha256).not.toBe(original.command_sha256);
    }
  });

  it('rejects forged fields before deriving an apparently valid replay identity', () => {
    expect(() => identity({ ...upload, authorization_revision: 'caller-selected' } as PersonUpdateSubmitV2)).toThrow();
    expect(() => projectCommandIdentityV1(actor, { operation: 'create', request: upload } as never)).toThrow();
    expect(Object.keys(identity(upload)).sort()).toEqual(['command_sha256', 'membership_id', 'organization_id', 'request_id']);
  });
});
