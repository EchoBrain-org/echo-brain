import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { createGranolaPostCutoffCursor, createGranolaMeetingSourceAdapter } from '../../../providers/granola/src/source/meeting-source-adapter.js';
import { granolaAdmittedMeetingSourceCursorPolicyV1 } from '../../../providers/granola/src/granola-admitted-meeting-source-cursor-policy-v1.js';
import type { GranolaApiClient, GranolaListParams, GranolaNoteDetail } from '../../../providers/granola/src/source/granola-api-client.js';
import { createJiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { openConnectorRehearsalCaptureV1 } from '../src/composition/connector-rehearsal-capture-v1.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const CLOUD = '00000000-0000-4000-8000-000000000007';
const SITE = 'https://fixture.atlassian.net';
const OWNER_TOKEN = 'owner-token';

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

class GranolaFixture implements GranolaApiClient {
  readonly list = vi.fn(async (_params: GranolaListParams) => ({
    notes: [{ id: 'note-1', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' }],
    hasMore: false, cursor: null,
  }));
  readonly detail = vi.fn(async (): Promise<GranolaNoteDetail> => ({
    id: 'note-1', title: 'Private Granola meeting', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
    summary_text: 'The body must only remain in retained local custody.', transcript: [{ text: 'Capture this one meeting.' }],
  }));
  listNotes(params: GranolaListParams) { return this.list(params); }
  getNote(_id: string) { return this.detail(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-connector-rehearsal-')); chmodSync(root, 0o700); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'), organization_display_name: 'Fixture', owner_display_name: 'Founder',
    created_at: '2026-10-01T00:00:00.000Z', creating_artifact_revision: 'connector-rehearsal-fixture',
  });
  const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  const cutoff = '2026-10-01T00:00:00.000Z';
  const cursor = createGranolaPostCutoffCursor(cutoff);
  database.prepare(`INSERT INTO authority_live_source_admission_v2 (
    singleton, organization_id, principal_id, membership_id, membership_type,
    source_adapter_id, source_adapter_version, source_adapter_instance_id, normalizer_version,
    source_custodian_sha256, source_custodian_assurance, source_custodian_observed_at,
    source_credential_reference_sha256, initial_cursor, cutoff_at,
    processor_adapter_id, processor_adapter_version, processor_instance_id,
    processor_configuration_sha256, processor_credential_reference_sha256, semantic_input_sha256, admitted_at
  ) VALUES (1, ?, ?, ?, 'owner', 'granola', '2.2.0', 'primary', '2.2.0', ?, 'authority_initial_owner_identity', ?, ?, ?, ?, 'fixture-processor', '1.0.0', 'fixture-processor', ?, ?, ?, ?)`)
    .run(initialized.organization_id, initialized.owner_principal_id, initialized.owner_membership_id,
      canonicalSha256('owner'), cutoff, canonicalSha256('granola-credential'), cursor, cutoff,
      canonicalSha256('processor'), canonicalSha256('processor-credential'), canonicalSha256('admission'), cutoff);
  database.close();

  let authorization: PersonAccessAuthorization = {
    organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id,
    membership_id: initialized.owner_membership_id, membership_type: 'owner', identity_binding_id: 'fixture-identity',
    session_family_id: 'fixture-session', access_credential_sha256: canonicalSha256('access'), person_state_sha256: canonicalSha256('person'),
    session_state_sha256: canonicalSha256('session'), checked_at: cutoff, access_expires_at: '2026-10-03T00:00:00.000Z', hard_reauthentication_at: '2026-10-04T00:00:00.000Z',
  };
  const authenticateAccess = vi.fn(({ access_token }: { access_token: string }) => {
    if (access_token !== OWNER_TOKEN) throw new Error('bad token');
    return authorization;
  });
  const granolaClient = new GranolaFixture();
  const granola = createGranolaMeetingSourceAdapter({ adapter_id: 'granola', instance_id: 'primary', settings: { page_size: 1 } }, {
    client: granolaClient, now: () => '2026-10-03T00:00:00.000Z',
  });

  const jiraDatabase = new Database(':memory:');
  const connectionRows = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly access_token: string; readonly updated_at: string }>();
  let pendingReference = '';
  const nango: JiraNangoV1 = {
    connect: vi.fn(async _tags => { pendingReference = 'jira-ref'; return { link: 'https://connect.nango.dev/private' }; }),
    find: vi.fn(async tags => [...connectionRows].find(([, row]) => canonicalSha256(row.tags) === canonicalSha256(tags))?.[0]),
    connection: vi.fn(async reference => {
      const row = connectionRows.get(reference); if (row === undefined) throw new Error('private reference'); return row;
    }),
    disconnect: vi.fn(async reference => { connectionRows.delete(reference); }),
  };
  const jiraFetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/oauth/token/accessible-resources') return response([{ id: CLOUD, url: SITE, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (path === `/ex/jira/${CLOUD}/rest/api/3/myself`) return response({ accountId: 'fixture-account', active: true, accountType: 'atlassian' });
    if (path === `/ex/jira/${CLOUD}/rest/api/3/project/ECHO`) return response({ id: '10000', key: 'ECHO', self: `${SITE}/rest/api/3/project/10000` });
    if (path === `/ex/jira/${CLOUD}/rest/api/3/search/jql`) return response({ isLast: true, issues: [{ id: '10001' }] });
    if (path === `/ex/jira/${CLOUD}/rest/api/3/issue/10001`) return response({ id: '10001', key: 'ECHO-1', self: `${SITE}/rest/api/3/issue/10001`, fields: { summary: 'Private ticket', project: { id: '10000', key: 'ECHO', self: `${SITE}/rest/api/3/project/10000` }, description: null, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-02T00:00:00.000Z', status: { name: 'Open' }, assignee: null, duedate: null, labels: [], priority: null } });
    throw new Error(`unexpected ${path}`);
  });
  const jira = createJiraPersonConnectionV1({
    store: new JiraConnectionStoreV1(jiraDatabase), nango, cloud_id: CLOUD, fetch: jiraFetch,
    authenticate: token => ({ ...authenticateAccess({ access_token: token }), authorization_sha256: canonicalSha256('auth') }),
  });
  const connectJira = async () => {
    const begun = await jira.connect({ access_token: OWNER_TOKEN });
    const tags = vi.mocked(nango.connect).mock.calls.at(-1)![0];
    connectionRows.set(pendingReference, { tags, access_token: 'private-oauth', updated_at: cutoff });
    await jira.status({ access_token: OWNER_TOKEN, attempt: begun.attempt });
  };
  const exclusive = { run_exclusive: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal) };
  const open = (includeGranola = true, initialOwner = { organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id }) => openConnectorRehearsalCaptureV1({
    state_directory: initialized.state_directory,
    initial_owner: initialOwner,
    authenticate_access: { authenticateAccess }, exclusive,
    ...(includeGranola ? { granola: { source: granola, source_cursor_policy: granolaAdmittedMeetingSourceCursorPolicyV1, processor_adapter_id: 'fixture-processor' } } : {}),
    jira: { connection: jira, project: 'ECHO', source_instance_id: `jira-cloud:${CLOUD}:project:ECHO` },
  });
  return { initialized, cursor, authorization: (value?: PersonAccessAuthorization) => { if (value !== undefined) authorization = value; return authorization; }, granolaClient, jiraFetch, connectJira, open, jiraDatabase };
}

describe('connector rehearsal capture V1', () => {
  it('retains one Granola full snapshot only under the initial-owner qualification policy', async () => {
    const f = fixture(); const rehearsal = f.open();
    try {
      const receipt = await rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 });
      expect(receipt).toMatchObject({ counts: { captured: 1, admitted: 1 }, captures: [{ source_type: 'note', admission: 'admitted' }] });
      expect(JSON.stringify(receipt)).not.toContain('Private Granola meeting');
      const db = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
      try {
        expect(db.prepare("SELECT access_policy_ref FROM authority_sources_v1 WHERE access_policy_ref LIKE 'connector-rehearsal-granola-initial-owner:%'").all()).toHaveLength(1);
        // readAdmission can initialize the progress row, but rehearsal must never advance it.
        expect(db.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get()).toEqual({ cursor: f.cursor });
      } finally { db.close(); }
      expect(f.granolaClient.list).toHaveBeenCalledTimes(1);
      f.authorization({ ...f.authorization(), membership_type: 'employee' });
      await expect(rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 })).rejects.toThrow('Context capture rehearsal failed');
      expect(f.granolaClient.list).toHaveBeenCalledTimes(1);
    } finally { rehearsal.close(); f.jiraDatabase.close(); }
  });


  it('requires the admitted Granola custodian to be the same initial owner before a provider read', async () => {
    const f = fixture();
    const db = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    try {
      db.prepare("INSERT INTO authority_principals(principal_id,organization_id,display_name,provisioned_at) VALUES ('prn_other',?,'Other','2026-10-01T00:00:00.000Z')").run(f.initialized.organization_id);
      db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at,revoked_at,revocation_reason) VALUES ('mem_other',?,'prn_other','owner','active','2026-10-01T00:00:00.000Z',NULL,NULL)").run(f.initialized.organization_id);
    } finally { db.close(); }
    f.authorization({ ...f.authorization(), principal_id: 'prn_other', membership_id: 'mem_other', membership_type: 'owner' });
    const rehearsal = f.open(true, { organization_id: f.initialized.organization_id, principal_id: 'prn_other', membership_id: 'mem_other' });
    try {
      await expect(rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 })).rejects.toThrow('Context capture rehearsal failed');
      expect(f.granolaClient.list).not.toHaveBeenCalled();
    } finally { rehearsal.close(); f.jiraDatabase.close(); }
  });

  it('uses the real Jira connection handoff through request-only capture and revokes before provider reads', async () => {
    const f = fixture(); await f.connectJira(); const rehearsal = f.open(false);
    try {
      const receipt = await rehearsal.capture({ tool: 'jira', access_token: OWNER_TOKEN, limit: 1 });
      expect(receipt).toMatchObject({ counts: { captured: 1, request_only: 1 }, captures: [{ source_type: 'ticket', admission: 'request_only' }] });
      expect(f.jiraFetch).toHaveBeenCalledWith(expect.stringContaining('/search/jql'), expect.anything());
      f.authorization({ ...f.authorization(), membership_type: 'employee' });
      const before = f.jiraFetch.mock.calls.length;
      await expect(rehearsal.capture({ tool: 'jira', access_token: OWNER_TOKEN, limit: 1 })).rejects.toThrow('Context capture rehearsal failed');
      expect(f.jiraFetch).toHaveBeenCalledTimes(before);
    } finally { rehearsal.close(); f.jiraDatabase.close(); }
  });
});
