import { describe, expect, it, vi } from 'vitest';
import { createJiraContextSourceV1, type JiraContextSourceReadGrantFenceV1 } from '../src/jira-context-source-v1.js';
import type { JiraCloudRequestV1, JiraCloudTransportV1 } from '../src/jira-cloud-transport-v1.js';

const cloudid = '11111111-1111-1111-1111-111111111111';
const origin = 'https://echo.atlassian.net';
const prefix = `/ex/jira/${cloudid}/rest/api/3`;
const binding = Object.freeze({
  organization_id: 'org-context', principal_id: 'person-context', membership_id: 'membership-context',
  tool_id: 'jira' as const, external_scope_id: cloudid, external_subject_id: 'account-context',
  read_grant_sha256: `sha256:${'a'.repeat(64)}` as const,
});

function issue(input: { updated?: string; status?: string; labels?: readonly string[]; summary?: string } = {}) {
  return {
    id: '10001', key: 'ECHO-1', self: `${origin}/rest/api/3/issue/10001`,
    fields: {
      summary: input.summary ?? 'Ship context capture',
      project: { id: '10000', key: 'ECHO', self: `${origin}/rest/api/3/project/10000` },
      created: '2026-10-01T00:00:00.000+0000',
      updated: input.updated ?? '2026-10-02T03:04:05.000-0700',
      status: { name: input.status ?? 'Open' },
      assignee: { displayName: 'Ada Lovelace', accountId: 'account-ada' },
      duedate: '2026-10-08',
      labels: input.labels ?? ['context', 'capture'],
      priority: { name: 'High' },
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this exact Jira evidence bounded.' }] }] },
    },
  };
}

function fixture(options: { current?: () => void | Promise<void>; issue?: ReturnType<typeof issue>; projectSelf?: string; page?: unknown; representation?: 'pointer' | 'excerpt'; now?: () => Date } = {}) {
  const raw = options.issue ?? issue();
  if (options.projectSelf !== undefined) raw.fields.project.self = options.projectSelf;
  const request = vi.fn(async (input: JiraCloudRequestV1): Promise<unknown> => {
    if (input.path === '/oauth/token/accessible-resources') return [{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }];
    if (input.path === `${prefix}/myself`) return { accountId: 'account-context', active: true, accountType: 'atlassian' };
    if (input.path === `${prefix}/project/ECHO`) return raw.fields.project;
    if (input.path === `${prefix}/search/jql`) return options.page ?? { isLast: true, issues: [{ id: '10001' }] };
    if (input.path === `${prefix}/issue/10001`) return raw;
    throw new Error(`unexpected path ${input.path}`);
  });
  const transport: JiraCloudTransportV1 = { binding, request };
  const requireCurrent: JiraContextSourceReadGrantFenceV1['requireCurrent'] = vi.fn(async () => { await options.current?.(); });
  return {
    request,
    requireCurrent,
    source: createJiraContextSourceV1({
      transport,
      read_grant_fence: { requireCurrent },
      project: 'ECHO',
      identity: { kind: 'source', adapter_id: 'jira-context-capture', instance_id: `jira-cloud:${cloudid}:project:ECHO`, version: '1.0.0' },
      representation: options.representation ?? 'excerpt',
      now: options.now ?? (() => new Date('2026-10-03T00:00:00.000Z')),
    }),
  };
}

describe('Jira context source V1', () => {
  it('maps a provider response through the existing person-bound transport into a bounded ticket excerpt', async () => {
    const f = fixture();
    const result = await f.source.pull({ limit: 2 });
    expect(f.requireCurrent).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({
      path: `${prefix}/search/jql`, method: 'POST', body: {
        jql: 'project = 10000 ORDER BY updated ASC, id ASC', maxResults: 2, fields: ['id'],
      },
    }));
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({
      path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,status,assignee,duedate,description,updated,labels,priority' },
    }));
    expect(result.next_cursor).toBeUndefined();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      item: { adapter: { adapter_id: 'jira-context-capture', instance_id: `jira-cloud:${cloudid}:project:ECHO`, version: '1.0.0' }, external_id: 'issue:10001' },
      revision: { captured_at: '2026-10-03T00:00:00.000Z' },
      content: {
        source_type: 'ticket', label: 'ECHO-1: Ship context capture',
        provenance: { origin_ref: `${origin}/browse/ECHO-1`, source_updated_at: '2026-10-02T10:04:05.000Z' },
        payload: { key: 'ECHO-1', status: 'Open', labels: ['context', 'capture'], priority: 'High', assignee_ref: 'jira:account:account-ada' },
        representation: { kind: 'excerpt', passages: [{ id: 'rendered-body', source_anchor: 'jira:issue:10001:rendered-v1', start: 0, text: 'ECHO-1: Ship context capture\n\nKeep this exact Jira evidence bounded.' }] },
      },
    });
    const source = result.sources[0]!;
    if (source.content.representation.kind !== 'excerpt') throw new Error('expected excerpt');
    expect(source.content.representation.passages[0]!.end).toBe(source.content.representation.passages[0]!.text.length);
    expect(source.content.payload).not.toHaveProperty('due_at');
    expect(source.content.payload).not.toHaveProperty('owner');
  });

  it('accepts the exact cloud API project self URL', async () => {
    const source = fixture({ projectSelf: `https://api.atlassian.com/ex/jira/${cloudid}/rest/api/3/project/10000` }).source;
    await expect(source.pull({ limit: 1 })).resolves.toMatchObject({ sources: [expect.anything()] });
  });

  it.each([
    ['another cloud', 'https://api.atlassian.com/ex/jira/22222222-2222-2222-2222-222222222222/rest/api/3/project/10000'],
    ['another project coordinate', `https://api.atlassian.com/ex/jira/${cloudid}/rest/api/3/project/99999`],
  ])('rejects a project self URL for %s', async (_description, projectSelf) => {
    await expect(fixture({ projectSelf }).source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('keeps the source identity on a replay while changed provider state receives a new immutable revision', async () => {
    const initial = await fixture({ now: () => new Date('2026-10-03T00:00:00.000Z') }).source.pull({ limit: 1 });
    const replay = await fixture({ now: () => new Date('2026-10-03T01:00:00.000Z') }).source.pull({ limit: 1 });
    const changed = await fixture({
      issue: issue({ updated: '2026-10-04T03:04:05.000-0700', status: 'Done', labels: ['context'] }),
      now: () => new Date('2026-10-04T00:00:00.000Z'),
    }).source.pull({ limit: 1 });
    expect(replay.sources[0]!.item.source_id).toBe(initial.sources[0]!.item.source_id);
    expect(replay.sources[0]!.revision.revision_id).toBe(initial.sources[0]!.revision.revision_id);
    expect(replay.sources[0]!.revision.captured_at).not.toBe(initial.sources[0]!.revision.captured_at);
    expect(changed.sources[0]!.item.source_id).toBe(initial.sources[0]!.item.source_id);
    expect(changed.sources[0]!.revision.revision_id).not.toBe(initial.sources[0]!.revision.revision_id);
    expect(changed.sources[0]!.revision.content_sha256).not.toBe(initial.sources[0]!.revision.content_sha256);
  });

  it.each([
    '2026-02-30T03:04:05Z',
    '2026-02-29T03:04:05.000-0700',
    '2100-02-29T03:04:05.000+05:30',
    '2026-04-31T03:04:05.000Z',
    '2026-01-00T03:04:05Z',
    '2026-13-01T03:04:05Z',
    '2026-10-02T24:00:00Z',
    '2026-10-02T03:60:00Z',
    '2026-10-02T03:04:60Z',
  ])('rejects an impossible provider update timestamp before returning a capture: %s', async (updated) => {
    await expect(fixture({ issue: issue({ updated }) }).source.pull({ limit: 1 }))
      .rejects.toMatchObject({ code: 'invalid_output' });
  });

  it.each([
    ['2000-02-29T03:04:05Z', '2000-02-29T03:04:05.000Z'],
    ['2024-02-29T03:04:05.1Z', '2024-02-29T03:04:05.100Z'],
    ['2026-10-02T03:04:05.12+0000', '2026-10-02T03:04:05.120Z'],
    ['2026-10-02T03:04:05.123+00:00', '2026-10-02T03:04:05.123Z'],
    ['2026-03-01T00:04:05+0530', '2026-02-28T18:34:05.000Z'],
    ['2026-03-01T00:04:05+05:30', '2026-02-28T18:34:05.000Z'],
    ['2026-02-28T23:04:05-0700', '2026-03-01T06:04:05.000Z'],
    ['2026-02-28T23:04:05-07:00', '2026-03-01T06:04:05.000Z'],
  ])('preserves a valid provider update timestamp in canonical provenance: %s', async (updated, expected) => {
    const result = await fixture({ issue: issue({ updated }) }).source.pull({ limit: 1 });
    expect(result.sources[0]!.content.provenance.source_updated_at).toBe(expected);
  });

  it('does not return fetched source bytes when the bound person grant is revoked during the pull', async () => {
    let calls = 0;
    const f = fixture({ current: () => {
      calls += 1;
      if (calls === 2) throw new Error('grant was revoked');
    } });
    await expect(f.source.pull({ limit: 1 })).rejects.toThrow('grant was revoked');
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001` }));
    expect(f.requireCurrent).toHaveBeenCalledTimes(2);
  });

  it('can preserve only a pointer when Authority selected pointer capture', async () => {
    const source = fixture({ representation: 'pointer' }).source;
    const result = await source.pull({ limit: 1 });
    expect(result.sources[0]!.content.representation).toEqual({ kind: 'pointer', pointer: `${origin}/browse/ECHO-1` });
  });

  it('rejects a nonterminal Jira page that repeats the submitted cursor', async () => {
    const f = fixture({
      page: { isLast: false, nextPageToken: 'same-page', issues: [] },
    });

    await expect(f.source.pull({ limit: 1, cursor: 'same-page' })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(f.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: `${prefix}/issue/10001` }),
    );
  });

  it('snapshots mutable construction seams before a grant fence yields to the provider', async () => {
    const raw = issue();
    const originalRequest = vi.fn(async (input: JiraCloudRequestV1): Promise<unknown> => {
      if (input.path === '/oauth/token/accessible-resources') return [{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }];
      if (input.path === `${prefix}/myself`) return { accountId: binding.external_subject_id, active: true, accountType: 'atlassian' };
      if (input.path === `${prefix}/project/ECHO`) return raw.fields.project;
      if (input.path === `${prefix}/search/jql`) return { isLast: true, issues: [{ id: '10001' }] };
      if (input.path === `${prefix}/issue/10001`) return raw;
      throw new Error(`unexpected path ${input.path}`);
    });
    const divertedRequest = vi.fn(async () => { throw new Error('mutated transport was used'); });
    const transport: JiraCloudTransportV1 = { binding, request: originalRequest };
    const fence = { requireCurrent: vi.fn(async () => {
      // These mutations occur after construction and before the first HTTP call.
      (transport as { request: JiraCloudTransportV1['request'] }).request = divertedRequest;
      (options as { representation: 'pointer' | 'excerpt' }).representation = 'pointer';
      (fence as { requireCurrent: JiraContextSourceReadGrantFenceV1['requireCurrent'] }).requireCurrent = async () => { throw new Error('mutated fence was used'); };
    }) };
    const options = {
      transport, read_grant_fence: fence, project: 'ECHO',
      identity: { kind: 'source' as const, adapter_id: 'jira-context-capture', instance_id: `jira-cloud:${cloudid}:project:ECHO`, version: '1.0.0' },
      representation: 'excerpt' as const, now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const source = createJiraContextSourceV1(options);
    const result = await source.pull({ limit: 1 });
    expect(divertedRequest).not.toHaveBeenCalled();
    expect(originalRequest).toHaveBeenCalled();
    expect(result.sources[0]!.content.representation.kind).toBe('excerpt');
  });
});
