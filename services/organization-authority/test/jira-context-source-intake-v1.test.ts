import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJiraCloudTransportV1 } from '@echo-brain/provider-jira/jira-cloud-transport-v1';
import type { ContextIntakeAuthorityV1, ContextIntakePolicyV1 } from '../src/application/context-intake-v1.js';
import { SqliteContextCaptureStoreV1 } from '../src/adapters/persistence/sqlite/context-capture-store-v1.js';
import { createJiraContextIntakeV1 } from '../src/composition/provider-context-intakes-v1.js';

const cloudid = '22222222-2222-4222-8222-222222222222';
const organizationId = 'org_jira_context';
const origin = 'https://context-fixture.atlassian.net';
const api = `/ex/jira/${cloudid}/rest/api/3`;
const identity = Object.freeze({
  kind: 'source' as const,
  adapter_id: 'jira-context-capture',
  instance_id: `jira-cloud:${cloudid}:project:ECHO`,
  version: '1.0.0',
});
const binding = Object.freeze({
  organization_id: organizationId,
  principal_id: 'person_jira_context',
  membership_id: 'membership_jira_context',
  tool_id: 'jira' as const,
  external_scope_id: cloudid,
  external_subject_id: 'jira-account-context',
  read_grant_sha256: `sha256:${'b'.repeat(64)}` as const,
});

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function rawIssue() {
  return {
    id: '10001', key: 'ECHO-1', self: `${origin}/rest/api/3/issue/10001`,
    fields: {
      summary: 'Keep context intake inactive',
      project: { id: '10000', key: 'ECHO', self: `${origin}/rest/api/3/project/10000` },
      created: '2026-10-01T00:00:00.000+0000',
      updated: '2026-10-02T12:34:56.000+0000',
      status: { name: 'Open' },
      assignee: { displayName: 'Ada', accountId: 'account-ada' },
      duedate: '2026-10-08',
      labels: ['context'],
      priority: { name: 'High' },
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A real provider response enters the shared gate.' }] }] },
    },
  };
}

function policy(disposition: ContextIntakePolicyV1['disposition']): ContextIntakePolicyV1 {
  return {
    disposition,
    scope: { organization_id: organizationId, custody_ref: `organization:${organizationId}`, access_policy_ref: 'jira-context-test', analysis_policy: 'on_request' },
    permitted_representations: ['excerpt'],
  };
}

function fixture(options: {
  readonly sourceCurrent?: () => Promise<void>;
  readonly compositionCurrent?: () => Promise<void>;
  readonly selectedDisposition?: ContextIntakePolicyV1['disposition'];
} = {}) {
  const calls: URL[] = [];
  const fetch = vi.fn(async (url: string) => {
    const target = new URL(url);
    calls.push(target);
    if (target.pathname === '/oauth/token/accessible-resources') return response([{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (target.pathname === `${api}/myself`) return response({ accountId: binding.external_subject_id, active: true, accountType: 'atlassian' });
    if (target.pathname === `${api}/project/ECHO`) return response(rawIssue().fields.project);
    if (target.pathname === `${api}/search/jql`) return response({ isLast: true, issues: [{ id: '10001' }] });
    if (target.pathname === `${api}/issue/10001`) return response(rawIssue());
    throw new Error(`unexpected Jira request ${target.pathname}`);
  });
  const sourceCurrent = vi.fn(async () => options.sourceCurrent?.());
  const compositionCurrent = vi.fn(async () => options.compositionCurrent?.());
  const transport = createJiraCloudTransportV1({ binding, fetch });
  const authority: ContextIntakeAuthorityV1 = {
    select: () => policy(options.selectedDisposition ?? 'request_only'),
    requireCurrent: () => undefined,
  };
  const intake = createJiraContextIntakeV1({
    transport, read_grant_fence: { requireCurrent: sourceCurrent }, project: 'ECHO', representation: 'excerpt',
    source_instance_id: identity.instance_id, organization_id: organizationId, authority,
    require_read_current: compositionCurrent, now: () => new Date('2026-10-03T00:00:00.000Z'),
  });
  return { calls, fetch, sourceCurrent, compositionCurrent, intake, transport, authority };
}

afterEach(() => vi.restoreAllMocks());

describe('Jira context source through Authority intake', () => {
  it('takes a real provider response through the forced request-only shared gate without invoking durable admission', async () => {
    const f = fixture();
    const admit = vi.spyOn(SqliteContextCaptureStoreV1.prototype, 'admitSourceRevision');
    const result = await f.intake.pull();
    expect(result).toMatchObject({
      captures: [{
        admission: 'request_only',
        source: {
          item: { adapter: identity, external_id: 'issue:10001' },
          content: {
            source_type: 'ticket',
            provenance: { origin_ref: `${origin}/browse/ECHO-1`, source_updated_at: '2026-10-02T12:34:56.000Z' },
            payload: { key: 'ECHO-1', status: 'Open', labels: ['context'], assignee_ref: 'jira:account:account-ada' },
            representation: { kind: 'excerpt', passages: [{ source_anchor: 'jira:issue:10001:rendered-v1', text: 'ECHO-1: Keep context intake inactive\n\nA real provider response enters the shared gate.' }] },
          },
        },
      }],
    });
    expect(admit).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledWith(expect.stringContaining(`${api}/search/jql`), expect.objectContaining({ method: 'POST', body: expect.stringContaining('"maxResults":50') }));
    expect(f.calls.some(call => call.pathname === `${api}/issue/10001`)).toBe(true);
    expect(f.sourceCurrent).toHaveBeenCalledTimes(2);
    expect(f.compositionCurrent).toHaveBeenCalledTimes(2);
  });

  it('denies the Authority read grant before the source can make a Jira HTTP request', async () => {
    const f = fixture({ compositionCurrent: async () => { throw new Error('read grant denied'); } });
    await expect(f.intake.pull({ limit: 1 })).rejects.toThrow('read grant denied');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sourceCurrent).not.toHaveBeenCalled();
  });

  it('does not return fetched captures when the source-bound grant is revoked during the provider pull', async () => {
    let checks = 0;
    const f = fixture({ sourceCurrent: async () => {
      checks += 1;
      if (checks === 2) throw new Error('source grant revoked');
    } });
    await expect(f.intake.pull({ limit: 1 })).rejects.toThrow('source grant revoked');
    expect(f.calls.some(call => call.pathname === `${api}/issue/10001`)).toBe(true);
    expect(f.sourceCurrent).toHaveBeenCalledTimes(2);
    // The source failure happens before Authority admission's second grant fence.
    expect(f.compositionCurrent).toHaveBeenCalledTimes(1);
  });

  it('rejects an Authority policy that attempts to upgrade a request-only Jira composition to retained custody', async () => {
    const f = fixture({ selectedDisposition: 'retained' });
    const admit = vi.spyOn(SqliteContextCaptureStoreV1.prototype, 'admitSourceRevision');
    await expect(f.intake.pull({ limit: 1 })).rejects.toThrow('retention or organization differs');
    expect(admit).not.toHaveBeenCalled();
  });

  it('rejects construction when the person-bound Jira transport belongs to another organization', () => {
    const f = fixture();
    const foreignTransport = createJiraCloudTransportV1({ binding: { ...binding, organization_id: 'org_someone_else' }, fetch: f.fetch });
    expect(() => createJiraContextIntakeV1({
      transport: foreignTransport,
      read_grant_fence: { requireCurrent: f.sourceCurrent }, project: 'ECHO', representation: 'excerpt',
      source_instance_id: identity.instance_id, organization_id: organizationId, authority: f.authority,
      require_read_current: f.compositionCurrent,
    })).toThrow('configured organization');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
