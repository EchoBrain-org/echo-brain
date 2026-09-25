import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { PersonAuthorityClient } from '../../../src/product/person-client/authority-client.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { OWNER, MEMBER, PROJECT_CONTEXT_NOW, addMembership, authorization, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

// Real PC-03 HTTP checkpoint 77e1b75 and PC-02 application checkpoint 7244fc5,
// with the actual V7 repository. Authentication uses synthetic fixture people;
// runtime authentication/worker/release qualification belongs to PC-06.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function start(enabled = true) {
  const database = projectContextDatabase();
  let changeSession = false; let resolutions = 0;
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const application = createProjectContextApplicationV1({ repository, authenticate: token => {
    if (token !== 'owner' && token !== 'member') throw new AuthorityOperationError('unauthorized', 'fixture diagnostic');
    return authorization(token === 'owner' ? OWNER : MEMBER,
      changeSession ? { session_state_sha256: canonicalSha256({ resolution: ++resolutions }) } : {});
  } });
  const server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
    ...(enabled ? { project_context: application } : {}),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  cleanup.push(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; database.close(); });
  const origin = `http://127.0.0.1:${address.port}`;
  return { database, origin, client: new PersonAuthorityClient({ authority_origin: origin, allow_insecure_loopback: true }),
    changeSession: () => { changeSession = true; } };
}
function create(name: string) {
  return { schema_version: 1 as const, kind: 'echo-project-create-v1' as const, request_id: randomUUID(), name };
}

describe('Person project transport against committed Authority routes and policy', () => {
  it('executes every operation with current project and original audience checks', async () => {
    const { client } = await start();
    const alpha = (await client.createProject('owner', create('Alpha'))).project_id;
    const beta = (await client.createProject('owner', create('Beta'))).project_id;
    const first = await client.projects('owner', { limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    const second = await client.projects('owner', { limit: 1, cursor: first.next_cursor! });
    expect(new Set([...first.items, ...second.items].map(item => item.project_id))).toEqual(new Set([alpha, beta]));
    expect(await client.readProject('owner', alpha)).toMatchObject({ name: 'Alpha', role: 'lead' });
    expect((await client.projectDirectory('owner', { project_id: alpha, query: 'Member' })).items).toEqual([
      { membership_id: MEMBER.membership_id, display_name: 'Member' },
    ]);
    const grant = { schema_version: 1 as const, kind: 'echo-project-member-set-v1' as const, request_id: randomUUID(),
      project_id: alpha, membership_id: MEMBER.membership_id, role: 'member' as const };
    await client.setProjectMember('owner', grant);
    expect((await client.projectMembers('member', { project_id: alpha })).items).toHaveLength(2);
    await client.setProjectMember('owner', { ...grant, request_id: randomUUID(), role: 'lead' });
    expect(await client.readProject('member', alpha)).toMatchObject({ role: 'lead' });
    await client.setProjectMember('owner', { ...grant, request_id: randomUUID(), role: 'member' });

    const privateNote = await client.submitUpdateV2('owner', { schema_version: 2, kind: 'echo-person-update-submit-v2',
      request_id: randomUUID(), title: 'Private original', text: 'Private release plan.\n', project_id: alpha, audience: { kind: 'only_me' } });
    const request = { schema_version: 2 as const, kind: 'echo-person-update-submit-v2' as const,
      request_id: randomUUID(), title: 'Project original', text: 'Project release plan.\n', project_id: beta,
      audience: { kind: 'project' as const, project_id: alpha } };
    const note = await client.submitUpdateV2('owner', request);
    expect(await client.updateStatusV2('owner', request.request_id)).toMatchObject({ project_id: beta, audience: request.audience, metadata: 'pending' });
    expect(await client.readUploadV2('member', note.context_id)).toMatchObject({ text: request.text, audience: request.audience });
    expect((await client.searchUploadsV2('member', { query: 'release' })).results.map(item => item.context_id)).toEqual([note.context_id]);
    expect((await client.projectFeed('member', { project_id: alpha })).items).toEqual([]);
    await expect(client.readUploadV2('member', privateNote.context_id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(client.readProjectContext('member', { project_id: beta, context_id: note.context_id })).rejects.toMatchObject({ code: 'not_found', status: 404 });

    await client.setProjectMember('owner', { ...grant, request_id: randomUUID(), project_id: beta });
    expect((await client.projectFeed('member', { project_id: beta })).items.map(item => item.context_id)).toEqual([note.context_id]);
    expect((await client.searchProjectContext('member', { project_id: beta, query: 'release' })).items.map(item => item.context_id)).toEqual([note.context_id]);
    expect(await client.readProjectContext('member', { project_id: beta, context_id: note.context_id })).toMatchObject({ text: request.text });

    const association = { schema_version: 1 as const, kind: 'echo-project-context-dissociate-v1' as const,
      request_id: randomUUID(), project_id: beta, context_id: note.context_id };
    await client.dissociateProjectContext('owner', association);
    await client.associateProjectContext('owner', { ...association, kind: 'echo-project-context-associate-v1', request_id: randomUUID(), project_id: alpha });
    expect((await client.projectFeed('member', { project_id: beta })).items).toEqual([]);
    expect((await client.projectFeed('member', { project_id: alpha })).items.map(item => item.context_id)).toEqual([note.context_id]);
    // Status is the immutable initial admission coordinate, never current association state.
    expect(await client.updateStatusV2('owner', request.request_id)).toMatchObject({ project_id: beta, audience: request.audience });
    const teamNote = await client.submitUpdateV2('owner', { ...request, request_id: randomUUID(), title: 'Team original', audience: { kind: 'team' } });
    await client.removeProjectMember('owner', { schema_version: 1, kind: 'echo-project-member-remove-v1',
      request_id: randomUUID(), project_id: alpha, membership_id: MEMBER.membership_id });
    await expect(client.readUploadV2('member', note.context_id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect((await client.projectFeed('member', { project_id: beta })).items.map(item => item.context_id)).toEqual([teamNote.context_id]);
    expect(await client.readUploadV2('member', teamNote.context_id)).toMatchObject({ audience: { kind: 'team' } });
  });

  it('reconciles a committed upload after a lost response without changing its draft or replay identity', async () => {
    const { client, origin } = await start();
    const project_id = (await client.createProject('owner', create('Recovery'))).project_id;
    const request = { schema_version: 2 as const, kind: 'echo-person-update-submit-v2' as const, request_id: randomUUID(),
      title: 'Recovery note', text: 'Exact immutable source.\n', project_id, audience: { kind: 'project' as const, project_id } };
    const calls: string[] = [];
    const unreliable = new PersonAuthorityClient({ authority_origin: origin, allow_insecure_loopback: true, fetch: async (url, init) => {
      calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      const response = await fetch(url, init);
      if (init?.method === 'POST') { await response.arrayBuffer(); throw new Error('lost after commit'); }
      return response;
    } });
    await expect(unreliable.submitUpdateV2('owner', request)).rejects.toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: request.request_id });
    const status = await unreliable.updateStatusV2('owner', request.request_id);
    expect(status).toMatchObject({ status: 'stored', project_id, audience: request.audience });
    expect(calls).toEqual(['POST /v2/person/updates', `GET /v2/person/updates/${request.request_id}`]);
    expect(await client.submitUpdateV2('owner', request)).toMatchObject({ context_id: status.context_id });
    await expect(client.submitUpdateV2('owner', { ...request, text: 'changed draft' })).rejects.toMatchObject({
      code: 'conflict', status: 409, mutation_outcome: 'not_submitted', request_id: request.request_id,
    });
    // Current-attempt conflict is not evidence that the earlier commit was lost.
    expect(await client.updateStatusV2('owner', request.request_id)).toEqual(status);
    expect(await client.readUploadV2('owner', status.context_id)).toMatchObject({ text: request.text, audience: request.audience });
    expect((await client.projectFeed('owner', { project_id })).items).toHaveLength(1);
  });

  it('lets a member with no project page the organization directory; revoked, unknown or absent sessions get nothing', async () => {
    const { client, database } = await start();
    for (let number = 4; number <= 13; number += 1) {
      addMembership(database, { organization_id: OWNER.organization_id, principal_id: `prn_directory_${number}`,
        membership_id: `mem_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, membership_type: 'employee' },
      `Directory ${number}`, `directory-${number}@example.test`);
    }
    expect((await client.projects('member')).items).toEqual([]);
    const first = await client.organizationDirectory('member', { limit: 10 });
    expect(first).toMatchObject({ schema_version: 1, kind: 'echo-organization-directory-v1' });
    expect(first.items).toHaveLength(10); expect(first.next_cursor).not.toBeNull();
    const second = await client.organizationDirectory('member', { limit: 10, cursor: first.next_cursor! });
    expect(second.items).toHaveLength(2); expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.membership_id)).size).toBe(12);
    expect((await client.organizationDirectory('member', { query: 'Owner' })).items).toEqual([{ membership_id: OWNER.membership_id, display_name: 'Owner' }]);
    // Another person cannot continue this person's page.
    await expect(client.organizationDirectory('owner', { limit: 10, cursor: first.next_cursor! })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(client.organizationDirectory('nobody', {})).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    revokeMembership(database, MEMBER);
    await expect(client.organizationDirectory('member', {})).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect((await client.organizationDirectory('owner', { query: 'Member' })).items).toEqual([]);
    const absent = await start(false);
    await expect(absent.client.organizationDirectory('owner', {})).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('keeps capability absence, hidden coordinates, and final session revalidation failures explicit', async () => {
    const absent = await start(false);
    await expect(absent.client.projects('owner')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const active = await start();
    const project = (await active.client.createProject('owner', create('Hidden'))).project_id;
    expect((await active.client.projects('member')).items).toEqual([]);
    await expect(active.client.readProject('member', project)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(active.client.projectMembers('expired', { project_id: project })).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    active.changeSession();
    const audits = active.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get();
    await expect(active.client.projects('owner')).rejects.toMatchObject({ code: 'stale_access_state', status: 400 });
    expect(active.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get()).toEqual(audits);
  });
});
