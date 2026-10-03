import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  apps: [] as readonly { readonly routes: readonly { readonly route_id: string; readonly path: string }[]; accept(input: unknown): Promise<unknown> }[],
  captures: 0,
  jira: 0,
  demoteDuringCapture: false,
}));

vi.mock('@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage', () => ({
  verifyAuthorityStateLineage: () => ({ root: { authority_id: 'oau_fixture', organization_id: 'org_fixture', state_lineage_id: 'lineage-fixture' } }),
}));
vi.mock('@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database', () => ({
  openAuthorityDatabase: () => ({
    prepare(sql: string) {
      return { get: () => sql.includes('authority_memberships') ? { present: 1 } : sql.includes('authority_metadata') ? { organization_id: 'org_fixture' } : undefined };
    },
    close() {},
  }),
}));
vi.mock('@echo-brain/provider-granola/granola-meeting-source-bundle-v1', () => ({
  createGranolaMeetingSourceBundleV1: () => ({ source_cursor_policy: {}, assert_admission_commitments() {}, create_source() { throw new Error('not admitted'); } }),
}));
vi.mock('@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1', () => ({
  createOpenRouterDecisionProcessorBundleV1: () => ({ processor_adapter_id: 'fixture', assert_admission_commitments() {} }),
}));
vi.mock('../src/composition/organization-authority-setup-cli.js', () => ({
  readOrganizationAuthoritySetupManifest: (directory: string) => ({ state_directory: directory, authority_url: 'https://authority-staging.echobrain.org', authority_id: 'oau_fixture', organization_id: 'org_fixture', state_lineage_id: 'lineage-fixture', owner_principal_id: 'prn_fixture', owner_membership_id: 'mem_fixture' }),
}));
vi.mock('../src/composition/connector-rehearsal-capture-v1.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/composition/connector-rehearsal-capture-v1.js')>(),
  openConnectorRehearsalCaptureV1: () => ({
    async capture() {
      state.captures += 1;
      return { schema_version: 1, kind: 'echo-context-capture-rehearsal-receipt-v1', source_identity_sha256: `sha256:${'a'.repeat(64)}`, captures: [], counts: { captured: 0, admitted: 0, duplicate: 0, request_only: 0 } };
    },
    close() {},
  }),
}));
vi.mock('../src/composition/jira-person-live-runtime-v1.js', () => ({
  openJiraPersonLiveRuntimeV1: () => ({
    application: {},
    connection_http: { routes: [{ route_id: 'jira-connect', method: 'POST', path: '/v1/person/tools/jira/connect' }], async accept() { state.jira += 1; return { status: 201, body: { ok: true } }; } },
    close() {},
  }),
}));
vi.mock('../src/composition/slack-context-capture-runtime-v1.js', () => ({
  openSlackContextCaptureRuntimeV1: () => ({ async create_source() { throw new Error('not linked'); }, close() {} }),
}));
vi.mock('../src/composition/organization-authority-composition-root.js', () => ({
  async openOrganizationAuthorityService(_config: unknown, dependencies: { person_http_runtime_factory_with_slack: (sessions: unknown, slack: unknown) => { applications: typeof state.apps } }) {
    state.apps = dependencies.person_http_runtime_factory_with_slack({
      authenticateAccess({ access_token }: { access_token: string }) {
        return access_token === 'owner' && !(state.demoteDuringCapture && state.captures > 0)
          ? { organization_id: 'org_fixture', principal_id: 'prn_fixture', membership_id: 'mem_fixture', membership_type: 'owner', access_credential_sha256: 'access', person_state_sha256: 'person', session_state_sha256: 'session' }
          : { organization_id: 'org_fixture', principal_id: 'prn_other', membership_id: 'mem_other', membership_type: 'member', access_credential_sha256: 'access', person_state_sha256: 'person', session_state_sha256: 'session' };
      },
    }, {}).applications;
    return { processing: 'active', address: {}, runExclusive: <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal), async drain() {}, async close() {} };
  },
}));

import { openStagingConnectorRehearsalService } from '../src/composition/staging-connector-rehearsal-runtime.js';
import { STAGING_CONNECTOR_REHEARSAL_PATH_V1, STAGING_CONNECTOR_REHEARSAL_POLICY_V2 } from '../src/composition/staging-connector-rehearsal-protocol.js';

const roots: string[] = [];
afterEach(() => { state.apps = []; state.captures = 0; state.jira = 0; state.demoteDuringCapture = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function selection() {
  return { release_id: 'clean-v1-connector-test', authority_host: 'authority-staging.echobrain.org', profile: {
    schema_version: 2 as const, kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
    capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2 as typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
    jira: { cloud_id: '00000000-0000-4000-8000-000000000001', integration_key: 'jira', project: 'ECHO' },
    slack: { channel_id: 'C01234567' },
  } };
}
function config(directory: string) {
  return {
    state_directory: directory, authority_url: 'https://authority-staging.echobrain.org', host: '127.0.0.1', port: 39478,
    oidc: {}, client_authentication: { method: 'none' as const }, pkce_key_file: '/fixture/pkce',
    granola_credential_file: '/fixture/granola', granola_owner_email_file: '/fixture/owner', openrouter_credential_file: '/fixture/openrouter',
    slack_nango: { secret_key: 'not-a-live-secret', integration_key: 'slack' },
  } as never;
}
function request(route_id: string, token: string, body: unknown) {
  return { route_id, method: 'POST' as const, path: route_id === 'staging-connector-rehearsal' ? STAGING_CONNECTOR_REHEARSAL_PATH_V1 : '/v1/person/tools/jira/connect', headers: { authorization: `Bearer ${token}` }, content_type: 'application/json', raw_body: new TextEncoder().encode(JSON.stringify(body)) };
}

it('refuses a Slack live-evidence factory under the capture-only V2 profile before opening state', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-connector-')); roots.push(root);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const factory = vi.fn(() => ({ application: { async source() { return undefined; } }, close() {} }));
  const result = await openStagingConnectorRehearsalService(config(stateDirectory), selection(), {
    api: { slack_live_runtime_factory: factory },
  }).then(async opened => { await opened.close(); return 'opened'; }, (error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('Staging connector rehearsal selection is invalid');
  expect(factory).not.toHaveBeenCalled();
  expect(state.apps).toEqual([]);
  expect(existsSync(join(root, 'staging-connector-rehearsal-v1'))).toBe(false);
});

it('binds a staging-only owner surface to a lineage/profile sidecar and returns content-free receipts', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-connector-')); roots.push(root);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const selected = selection();
  const opened = await openStagingConnectorRehearsalService(config(stateDirectory), selected);
  const capture = state.apps.find(app => app.routes.some(route => route.path === STAGING_CONNECTOR_REHEARSAL_PATH_V1))!;
  const profile_sha256 = (await import('@echo-brain/federation-protocol')).canonicalSha256(selected.profile);
  await expect(capture.accept(request('staging-connector-rehearsal', 'other', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'status' }))).rejects.toThrow('unavailable');
  const status = await capture.accept(request('staging-connector-rehearsal', 'owner', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'status' })) as { body: { qualified: boolean; granola_available: boolean } };
  expect(status.body).toMatchObject({ qualified: false, granola_available: false });
  const captured = await capture.accept(request('staging-connector-rehearsal', 'owner', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 })) as { body: { receipt: { captures: unknown[] }; qualified: boolean } };
  expect(captured.body).toMatchObject({ qualified: false, receipt: { captures: [] } });
  expect(state.captures).toBe(1);
  const marker = JSON.parse(readFileSync(join(root, 'staging-connector-rehearsal-v1', 'binding.json'), 'utf8')) as Record<string, unknown>;
  expect(marker).toMatchObject({ state_lineage_id: 'lineage-fixture', principal_id: 'prn_fixture', membership_id: 'mem_fixture', profile_sha256 });
  expect(marker).not.toHaveProperty('release_id');
  await opened.close();
});

it('withholds a capture receipt if the owner loses eligibility during provider work', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-connector-')); roots.push(root);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const selected = selection();
  const opened = await openStagingConnectorRehearsalService(config(stateDirectory), selected);
  const capture = state.apps.find(app => app.routes.some(route => route.path === STAGING_CONNECTOR_REHEARSAL_PATH_V1))!;
  const profile_sha256 = (await import('@echo-brain/federation-protocol')).canonicalSha256(selected.profile);
  state.demoteDuringCapture = true;
  await expect(capture.accept(request('staging-connector-rehearsal', 'owner', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 }))).rejects.toThrow('unavailable');
  await opened.close();
});

it('does not expose Jira connection commands to a non-owner', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-connector-')); roots.push(root);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const opened = await openStagingConnectorRehearsalService(config(stateDirectory), selection());
  const jira = state.apps.find(app => app.routes.some(route => route.path === '/v1/person/tools/jira/connect'))!;
  expect(() => jira.accept(request('jira-connect', 'other', { schema_version: 1 }))).toThrow('unavailable');
  expect(state.jira).toBe(0);
  await opened.close();
});
