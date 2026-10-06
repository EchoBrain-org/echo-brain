import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonPageCitationV1, PersonSlackMessageCitationV1, PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskItemV1, EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { PersonLiveEvidenceCitationV1, PersonLiveEvidenceItemV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createPersonLiveEvidenceDeskV2, createRegisteredPersonLiveEvidenceDeskV2, type RegisteredPersonLiveEvidenceSourceV2 } from '../src/composition/person-live-evidence-desk-v2.js';
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
const empty = { items: [], truncated: false, receipt_digests: [] };
const receipt = (source: string) => canonicalSha256({ source });
function live<C extends PersonLiveEvidenceCitationV1>(tool_id: string, items: readonly PersonLiveEvidenceItemV1<C>[]): PersonLiveEvidenceSourceV1<C> {
  const result = { items, truncated: false, receipt_digests: [receipt(tool_id)] };
  return { tool_id, search: vi.fn(async () => result), open: vi.fn(async () => result), list: vi.fn(async () => result), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}) };
}
function mixedFixture() {
  const f = fixture();
  const local: EvidenceDeskItemV1[] = [1, 2].map(index => ({ id: `local-${index}`, kind: 'note', label: 'Approved Granola transcript', text: `Launch transcript ${index}`, visibility: 'team', receipt_sha256: receipt('local'), citation: { kind: 'source_revision', source_id: `source:${'1'.repeat(64)}`, revision_id: 'revision-1', source_sha256: receipt('source'), representation_sha256: receipt('representation'), anchor_sha256: receipt(`anchor-${index}`) } }));
  const tickets: PersonLiveEvidenceItemV1<PersonTicketCitationV1>[] = [1, 2, 3].map(index => ({ id: `ticket-${index}`, kind: 'ticket', label: `ECHO-${index}`, text: `Launch ticket ${index}`, visibility: 'only_me', receipt_sha256: receipt('jira'), citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: '11111111-1111-4111-8111-111111111111', ticket_id: String(index), permalink: `https://fixture.atlassian.net/browse/ECHO-${index}`, text_sha256: receipt(`ticket-${index}`) } }));
  const messages: PersonLiveEvidenceItemV1<PersonSlackMessageCitationV1>[] = [1, 2, 3].map(index => ({ id: `slack-${index}`, kind: 'slack_message', label: '#launch', text: `Launch message ${index}`, visibility: 'team', receipt_sha256: receipt('slack'), citation: { kind: 'slack_message', team_id: 'T0001', channel_id: 'C0001', message_ts: `1790966400.00000${index}`, permalink: `https://fixture.slack.com/archives/C0001/p179096640000000${index}`, text_sha256: receipt(`slack-${index}`) } }));
  const pages: PersonLiveEvidenceItemV1<PersonPageCitationV1>[] = [1, 2].map(index => ({ id: `page-${index}`, kind: 'page', label: `Launch plan section ${index}`, text: `Launch plan section ${index}`, visibility: 'only_me', receipt_sha256: receipt('knowledge'), citation: { kind: 'page', tool_id: 'knowledge', external_scope_id: 'site-one', page_id: 'launch-plan', section_id: `s${index}`, version: '7', permalink: `https://knowledge.example.test/wiki/pages/viewpage.action?pageId=${index}`, text_sha256: receipt(`page-${index}`) } }));
  vi.mocked(f.base.search).mockResolvedValue({ items: local, truncated: false, receipt_digests: [receipt('local')] });
  return { ...f, local, tickets, messages, pages, ticket: live('jira', tickets), page: live('knowledge', pages), slack: live('slack', messages) };
}
function fixture(scope: EvidenceDeskPortV1['scope'] = { kind: 'global' }) {
  let current = true;
  const base: EvidenceDeskPortV1 = { scope, search: vi.fn(async () => empty), open: vi.fn(async () => empty), list: vi.fn(async () => empty), revalidate: vi.fn(async () => { if (!current) throw new AuthorityOperationError('stale_access_state', 'Fixture base grant revoked'); return { checked_at: '2026-10-01T00:00:00.000Z' }; }) };
  const ticket: PersonLiveEvidenceSourceV1 = { tool_id: 'jira', search: vi.fn(async () => empty), open: vi.fn(async () => empty), list: vi.fn(async () => empty), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}) };
  return { base, ticket, revokeBase: () => { current = false; } };
}
describe('thin live ticket dispatcher', () => {
  it('overlaps independent provider checks while preserving both local fences', async () => {
    vi.useFakeTimers();
    try {
      const f = mixedFixture();
      vi.mocked(f.ticket.revalidate).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 80)));
      vi.mocked(f.page.revalidate).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));
      const start = Date.now(); let elapsed = 0;
      const pending = createPersonLiveEvidenceDeskV2(f.base, f.ticket, undefined, undefined, f.page)
        .revalidate({}).then(() => { elapsed = Date.now() - start; });
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(elapsed).toBe(80);
      expect(f.base.revalidate).toHaveBeenCalledTimes(2);
      expect(f.ticket.revalidate).toHaveBeenCalledTimes(1);
      expect(f.page.revalidate).toHaveBeenCalledTimes(1);
      expect(f.ticket.assertCurrent).toHaveBeenCalledTimes(1);
      expect(f.page.assertCurrent).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('describes only the live sources bound for this request using provider-neutral source kinds', () => {
    const f = mixedFixture();
    const ticket = { ...f.ticket, tool_id: 'issue-fixture' };
    expect(createPersonLiveEvidenceDeskV2(f.base, ticket, f.slack)).toHaveProperty('live_sources', [
      { source_id: 'ticket', kind: 'ticket', selector: 'tickets', description: expect.any(String), metadata_only_list: true, tool_id: 'issue-fixture' },
      { source_id: 'slack', kind: 'slack_message', selector: 'slack', description: expect.any(String), metadata_only_list: false, tool_id: 'slack', requires_channel: true, default_since_days: 14 },
    ]);
    expect(createPersonLiveEvidenceDeskV2(f.base)).toHaveProperty('live_sources', []);
  });

  it('distinguishes an empty live lookup from a denied lookup without capturing query or provider content', async () => {
    const f = fixture();
    const events: CoreRuntimeObservationV1[] = [];
    const content = vi.fn();
    const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket);
    await observeCoreRuntimeV1('ask_request', async () => {
      await desk.search({ query: 'private-query' });
      vi.mocked(f.ticket.search).mockRejectedValueOnce(new AuthorityOperationError('unauthorized', 'private-provider-error'));
      await expect(desk.search({ query: 'private-query' })).rejects.toMatchObject({ code: 'unauthorized' });
    }, { observer: event => { events.push(event); }, content_observer: content });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'evidence_search', event: 'succeeded', evidence_source: 'ticket', result: 'empty', counts: expect.objectContaining({ included_count: 0 }) }),
      expect.objectContaining({ phase: 'evidence_search', event: 'failed', evidence_source: 'ticket', result: 'authorization' }),
    ]));
    expect(new Set(events.map(event => event.operation_id)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain('private-query');
    expect(content).not.toHaveBeenCalled();
  });

  it('interleaves a common query across local Granola evidence, Jira and Slack without crowding out a source', async () => {
    const f = mixedFixture();
    const result = await createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).search({ query: 'launch', limit: 6 });
    expect(result.items.map(item => item.id)).toEqual(['local-1', 'ticket-1', 'slack-1', 'local-2', 'ticket-2', 'slack-2']);
    expect(result.truncated).toBe(true);
    expect(result.receipt_digests).toEqual([receipt('local'), receipt('jira'), receipt('slack')]);
    expect(f.base.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'launch', kinds: ['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage'] }));
  });
  it('routes provider-neutral page sections through opaque request ids and publishes only their descriptor', async () => {
    const f = mixedFixture();
    const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack, undefined, f.page);
    expect(desk.live_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: 'page', kind: 'page', selector: 'pages', metadata_only_list: true, tool_id: 'knowledge' }),
    ]));
    const result = await desk.search({ query: 'launch', kinds: ['page'], limit: 2 });
    expect(result.items.map(item => item.id)).toEqual(['page-1', 'page-2']);
    await desk.open({ item: 'page-1' });
    expect(f.page.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'launch' }));
    expect(f.page.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'page-1' }));
    expect(f.ticket.search).not.toHaveBeenCalled();
    expect(f.slack.search).not.toHaveBeenCalled();
  });
  it('starts independent local, Jira and Slack lookups together and merges reverse completions in source order', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      return { promise: new Promise<T>(done => { resolve = done; }), resolve };
    };
    const local = deferred<Awaited<ReturnType<EvidenceDeskPortV1['search']>>>();
    const ticket = deferred<Awaited<ReturnType<typeof f.ticket.search>>>();
    const slack = deferred<Awaited<ReturnType<typeof f.slack.search>>>();
    vi.mocked(f.base.search).mockImplementation(() => local.promise);
    vi.mocked(f.ticket.search).mockImplementation(() => ticket.promise);
    vi.mocked(f.slack.search).mockImplementation(() => slack.promise);

    const search = desk.search({ query: 'launch', limit: 6 });
    await vi.waitFor(() => {
      expect(f.base.search).toHaveBeenCalledTimes(1);
      expect(f.ticket.search).toHaveBeenCalledTimes(1);
      expect(f.slack.search).toHaveBeenCalledTimes(1);
    });
    slack.resolve({ items: f.messages, truncated: false, receipt_digests: [receipt('slack')] });
    ticket.resolve({ items: f.tickets, truncated: false, receipt_digests: [receipt('jira')] });
    local.resolve({ items: f.local, truncated: false, receipt_digests: [receipt('local')] });

    expect((await search).items.map(item => item.id)).toEqual(['local-1', 'ticket-1', 'slack-1', 'local-2', 'ticket-2', 'slack-2']);
  });
  it('fans a queryless inventory search out to independent live lists', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    vi.mocked(f.base.search).mockImplementation(async () => { started.push('local'); await pending; return { items: f.local, truncated: false, receipt_digests: [receipt('local')] }; });
    vi.mocked(f.ticket.list).mockImplementation(async () => { started.push('ticket'); await pending; return { items: f.tickets, truncated: false, receipt_digests: [receipt('jira')] }; });
    vi.mocked(f.slack.list).mockImplementation(async () => { started.push('slack'); await pending; return { items: f.messages, truncated: false, receipt_digests: [receipt('slack')] }; });

    const search = desk.search({ limit: 3 });
    await vi.waitFor(() => expect(started).toEqual(['local', 'ticket', 'slack']));
    release();
    expect((await search).items.map(item => item.id)).toEqual(['local-1', 'ticket-1', 'slack-1']);
  });
  it('fails the whole fanout when one concurrent source is denied', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    vi.mocked(f.slack.search).mockRejectedValueOnce(new AuthorityOperationError('unauthorized', 'Fixture Slack access revoked'));
    await expect(desk.search({ query: 'launch' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.base.search).toHaveBeenCalledTimes(1);
    expect(f.ticket.search).toHaveBeenCalledTimes(1);
    expect(f.slack.search).toHaveBeenCalledTimes(1);
  });
  it('observes actual list and open calls once without changing provider routing or results', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1('ask_request', async () => {
      expect((await desk.list({ source: 'ticket' })).items).toHaveLength(3);
      await desk.open({ item: 'ticket-1' });
      await desk.search({ kinds: ['slack_message'] }); // A queryless search calls live list.
    }, { observer: event => { events.push(event); throw new Error('observer failure'); } });
    expect(events.filter(event => !event.root && event.event === 'succeeded')).toMatchObject([
      { phase: 'evidence_list', evidence_source: 'ticket', result: 'returned', counts: { included_count: 3 } },
      { phase: 'evidence_open', evidence_source: 'ticket', result: 'returned', counts: { included_count: 3 } },
      { phase: 'evidence_list', evidence_source: 'slack', result: 'returned', counts: { included_count: 3 } },
    ]);
    expect(f.ticket.list).toHaveBeenCalledTimes(1); expect(f.ticket.open).toHaveBeenCalledTimes(1); expect(f.slack.list).toHaveBeenCalledTimes(1);
    for (const value of ['ticket-1', 'Launch ticket', 'atlassian.net', 'launch']) expect(JSON.stringify(events)).not.toContain(value);
  });
  it.each(['note', 'ticket', 'slack_message'] as const)('routes a %s kind filter only to its selected source', async kind => {
    const f = mixedFixture();
    const result = await createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).search({ query: 'launch', kinds: [kind], limit: 3 });
    expect(result.items.every(item => item.kind === kind)).toBe(true);
    expect(f.base.search).toHaveBeenCalledTimes(kind === 'note' ? 1 : 0);
    expect(f.ticket.search).toHaveBeenCalledTimes(kind === 'ticket' ? 1 : 0);
    expect(f.slack.search).toHaveBeenCalledTimes(kind === 'slack_message' ? 1 : 0);
  });
  it('routes Slack history to the bound source container and keeps Jira and local selectors separate', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    await desk.list({ source: 'slack', channel: 'launch', since: '2026-10-01', until: '2026-10-02', limit: 4, cursor: 'request-owned-cursor' });
    expect(f.slack.list).toHaveBeenCalledWith({ container: 'launch', since: '2026-10-01', until: '2026-10-02', limit: 4, cursor: 'request-owned-cursor', signal: undefined });
    await expect(desk.list({ source: 'slack', channel: 'launch', kinds: ['ticket'] })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.base.list).not.toHaveBeenCalled(); expect(f.ticket.list).not.toHaveBeenCalled();
  });
  it('opens only request-issued handles through their original source', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    await desk.search({ query: 'launch', limit: 3 });
    await expect(desk.open({ item: 'ticket-3' })).rejects.toMatchObject({ code: 'not_found' });
    await desk.open({ item: 'local-1' }); await desk.open({ item: 'ticket-1' }); await desk.open({ item: 'slack-1' });
    expect(f.base.open).toHaveBeenCalledTimes(1); expect(f.ticket.open).toHaveBeenCalledTimes(1); expect(f.slack.open).toHaveBeenCalledTimes(1);
    await expect(desk.open({ item: 'foreign-request-item' })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.base.open).toHaveBeenCalledTimes(1); expect(f.ticket.open).toHaveBeenCalledTimes(1); expect(f.slack.open).toHaveBeenCalledTimes(1);
  });
  it('preserves partial-source notices and receipts even when the result cap omits a provider', async () => {
    const f = mixedFixture();
    vi.mocked(f.base.search).mockResolvedValue({ items: f.local, truncated: true, notice: 'Meeting records were unavailable when this request began.', receipt_digests: [receipt('local')] });
    const result = await createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).search({ query: 'launch', limit: 2 });
    expect(result.items.map(item => item.id)).toEqual(['local-1', 'ticket-1']);
    expect(result).toMatchObject({ truncated: true, notice: 'Meeting records were unavailable when this request began.', receipt_digests: [receipt('local'), receipt('jira'), receipt('slack')] });
  });
  it('revalidates both live sources before the final local fence and propagates a Slack denial', async () => {
    const f = mixedFixture(); const order: string[] = [];
    vi.mocked(f.base.revalidate).mockImplementation(async () => { order.push('local'); return { checked_at: '2026-10-02T00:00:00.000Z' }; });
    vi.mocked(f.ticket.revalidate).mockImplementation(async () => { order.push('jira'); });
    vi.mocked(f.slack.revalidate).mockImplementation(async () => { order.push('slack'); });
    const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    await desk.revalidate({}); expect(order).toEqual(['local', 'jira', 'slack', 'local']);
    vi.mocked(f.slack.revalidate).mockRejectedValue(new AuthorityOperationError('unauthorized', 'Fixture Slack access revoked'));
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it.each(['slack', 'local'] as const)('refuses a Jira grant revoked during the final %s await without repeating provider reads', async later => {
    const f = mixedFixture(); let revoked = false; let localChecks = 0;
    vi.mocked(f.ticket.assertCurrent).mockImplementation(() => { if (revoked) throw new AuthorityOperationError('stale_access_state', 'Fixture Jira grant revoked'); });
    vi.mocked(f.ticket.revalidate).mockImplementation(async () => { if (revoked) throw new AuthorityOperationError('stale_access_state', 'Fixture Jira grant revoked'); });
    vi.mocked(f.slack.revalidate).mockImplementation(async () => { await Promise.resolve(); if (later === 'slack') revoked = true; });
    vi.mocked(f.base.revalidate).mockImplementation(async () => { await Promise.resolve(); if (++localChecks === 2 && later === 'local') revoked = true; return { checked_at: '2026-10-02T00:00:00.000Z' }; });
    await expect(createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.ticket.revalidate).toHaveBeenCalledTimes(1); expect(f.slack.revalidate).toHaveBeenCalledTimes(1);
  });
  it('checks every local live grant synchronously after the last await', async () => {
    const f = mixedFixture(); const order: string[] = [];
    vi.mocked(f.base.revalidate).mockImplementation(async () => { order.push('local'); return { checked_at: '2026-10-02T00:00:00.000Z' }; });
    vi.mocked(f.ticket.revalidate).mockImplementation(async () => { order.push('jira-provider'); });
    vi.mocked(f.slack.revalidate).mockImplementation(async () => { order.push('slack-provider'); });
    vi.mocked(f.ticket.assertCurrent).mockImplementation(() => { order.push('jira-grant'); queueMicrotask(() => order.push('next-microtask')); });
    vi.mocked(f.slack.assertCurrent).mockImplementation(() => { order.push('slack-grant'); });
    await createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).revalidate({});
    expect(order).toEqual(['local', 'jira-provider', 'slack-provider', 'local', 'jira-grant', 'slack-grant', 'next-microtask']);
  });
  it('honors cancellation raised by a synchronous final grant fence', async () => {
    const f = mixedFixture(); const controller = new AbortController();
    vi.mocked(f.slack.assertCurrent).mockImplementation(() => { controller.abort(); });
    await expect(createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).revalidate({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not mask a provider denial as an empty cross-source answer', async () => {
    const f = mixedFixture();
    vi.mocked(f.ticket.search).mockRejectedValue(new AuthorityOperationError('unauthorized', 'Fixture Jira access revoked'));
    await expect(createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack).search({ query: 'launch' })).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('honors cancellation before work and after awaited provider reads', async () => {
    const f = mixedFixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, f.slack);
    const early = new AbortController(); early.abort();
    await expect(desk.search({ query: 'launch', signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.base.search).not.toHaveBeenCalled(); expect(f.ticket.search).not.toHaveBeenCalled(); expect(f.slack.search).not.toHaveBeenCalled();
    const late = new AbortController();
    vi.mocked(f.ticket.search).mockImplementation(async () => { late.abort(); return empty; });
    await expect(desk.search({ query: 'launch', signal: late.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.slack.search).toHaveBeenCalledTimes(1);
  });
  it('rechecks local grants/snapshot after provider visibility awaits, suppressing mixed evidence after drift', async () => {
    const f = fixture(); vi.mocked(f.ticket.revalidate).mockImplementation(async () => { f.revokeBase(); });
    await expect(createPersonLiveEvidenceDeskV2(f.base, f.ticket).revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.base.revalidate).toHaveBeenCalledTimes(2);
  });
  it.each([{ kind: 'mine' as const }, { kind: 'project' as const, project_id: 'prj_00000000-0000-4000-8000-000000000001' as const }])('excludes tickets in unsupported scope and refuses explicit ticket reads without global fallback', async scope => {
    const f = fixture(scope);
    expect(() => createPersonLiveEvidenceDeskV2(f.base, f.ticket)).toThrow(AuthorityOperationError);
    expect(() => createPersonLiveEvidenceDeskV2(f.base, undefined, mixedFixture().slack)).toThrow(AuthorityOperationError);
    const desk = createPersonLiveEvidenceDeskV2(f.base);
    await desk.search({ query: 'launch' });
    await expect(desk.list({ source: 'ticket' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.search({ query: 'launch', kinds: ['ticket'] })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.ticket.search).not.toHaveBeenCalled(); expect(f.ticket.list).not.toHaveBeenCalled();
  });
  it('admits a server-bound project ticket source only for that exact project and keeps Slack excluded', async () => {
    const scope = { kind: 'project' as const, project_id: 'prj_00000000-0000-4000-8000-000000000001' as const };
    const f = fixture(scope);
    const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket, undefined, scope.project_id);
    expect(desk.live_sources).toEqual([{ source_id: 'ticket', kind: 'ticket', selector: 'tickets', description: expect.any(String), metadata_only_list: true, tool_id: 'jira' }]);
    await desk.list({ source: 'ticket' });
    expect(f.ticket.list).toHaveBeenCalled();
    expect(() => createPersonLiveEvidenceDeskV2(f.base, f.ticket, undefined, 'another-project')).toThrow(AuthorityOperationError);
    expect(() => createPersonLiveEvidenceDeskV2(f.base, f.ticket, mixedFixture().slack, scope.project_id)).toThrow(AuthorityOperationError);
  });
  it('does not forward live cursors or project/container selectors into other desk sources', async () => {
    const f = fixture(); const desk = createPersonLiveEvidenceDeskV2(f.base, f.ticket);
    await expect(desk.list({ source: 'ticket', channel: 'unsupported-project-map' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.list({ source: 'document', kinds: ['ticket'] })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.ticket.list).not.toHaveBeenCalled(); expect(f.base.list).not.toHaveBeenCalled();
  });
});


describe('registered live source dispatch', () => {
  const registration = (source: PersonLiveEvidenceSourceV1, source_id: string, scope: RegisteredPersonLiveEvidenceSourceV2['scope'] = { kind: 'global' }): RegisteredPersonLiveEvidenceSourceV2 => ({
    source, scope, descriptor: { source_id, selector: source_id, kind: 'page', description: `Pages from ${source_id}`, metadata_only_list: true, tool_id: source.tool_id },
  });
  it('observes a provider revalidation failure without capturing content or changing the failure fences', async () => {
    const f = mixedFixture();
    const failure = new AuthorityOperationError('unavailable', 'private-provider-revalidation-error');
    vi.mocked(f.page.revalidate).mockRejectedValueOnce(failure);
    const desk = createRegisteredPersonLiveEvidenceDeskV2(f.base, [registration(f.page, 'knowledge-one')]);
    const events: CoreRuntimeObservationV1[] = [];
    const content = vi.fn();
    const input = { signal: new AbortController().signal };
    await observeCoreRuntimeV1('ask_request', async () => {
      await expect(desk.revalidate(input)).rejects.toBe(failure);
    }, { observer: event => { events.push(event); }, content_observer: content });
    expect(events.filter(event => !event.root && event.event === 'failed')).toMatchObject([
      { phase: 'evidence_revalidate', evidence_source: 'page', result: 'unavailable' },
    ]);
    expect(new Set(events.map(event => event.operation_id)).size).toBe(1);
    expect(f.page.revalidate).toHaveBeenCalledExactlyOnceWith(input);
    expect(f.base.revalidate).toHaveBeenCalledTimes(1);
    expect(f.page.assertCurrent).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('private-provider-revalidation-error');
    expect(content).not.toHaveBeenCalled();
  });
  it.each(['search', 'list'] as const)('runs %s concurrently across local, ticket and two page providers without changing ownership', async method => {
    const f = mixedFixture();
    const secondItems = f.pages.map(item => ({ ...item, id: `second-${item.id}`, citation: { ...item.citation, tool_id: 'other-knowledge' } }));
    const second = live('other-knowledge', secondItems);
    const ticket = registration(f.ticket, 'issues');
    const desk = createRegisteredPersonLiveEvidenceDeskV2(f.base, [
      { ...ticket, descriptor: { ...ticket.descriptor, kind: 'ticket' } },
      registration(f.page, 'knowledge-one'), registration(second, 'knowledge-two'),
    ]);
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const gate = (id: string) => {
      const pending = new Promise<void>(resolve => { releases.push(resolve); });
      return async () => { started.push(id); await pending; };
    };
    const local = gate('local');
    vi.mocked(f.base.search).mockImplementation(async () => {
      await local(); return { items: f.local, truncated: false, receipt_digests: [receipt('local')] };
    });
    const plans: { id: string; source: PersonLiveEvidenceSourceV1; items: readonly PersonLiveEvidenceItemV1[] }[] = [
      { id: 'issues', source: f.ticket, items: f.tickets },
      { id: 'knowledge-one', source: f.page, items: f.pages },
      { id: 'knowledge-two', source: second, items: secondItems },
    ];
    for (const { id, source, items } of plans) {
      const wait = gate(id);
      vi.mocked(source[method]).mockImplementation(async () => {
        await wait(); return { items, truncated: false, receipt_digests: [receipt(id)] };
      });
    }
    const search = desk.search({ ...(method === 'search' ? { query: 'launch' } : {}), limit: 8 });
    try {
      await vi.waitFor(() => expect(started).toEqual(['local', 'issues', 'knowledge-one', 'knowledge-two']));
    } finally {
      for (const release of releases.reverse()) release();
    }
    const result = await search;
    expect(result.items.map(item => item.id)).toEqual(['local-1', 'ticket-1', 'page-1', 'second-page-1', 'local-2', 'ticket-2', 'page-2', 'second-page-2']);
    expect(result.items.filter(item => item.kind === 'page').map(item => item.source_id)).toEqual(['knowledge-one', 'knowledge-two', 'knowledge-one', 'knowledge-two']);
    await desk.open({ item: 'page-1' }); await desk.open({ item: 'second-page-1' });
    expect(f.page.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'page-1' }));
    expect(second.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'second-page-1' }));
  });
  it('lists, searches and opens two same-kind providers by their own source identities', async () => {
    const f = mixedFixture();
    const secondItems = (await f.page.list({})).items.map(item => ({ ...item, id: `second-${item.id}`, citation: { ...item.citation, tool_id: 'other-knowledge' } }));
    const second = live('other-knowledge', secondItems);
    vi.mocked(f.page.list).mockClear();
    const desk = createRegisteredPersonLiveEvidenceDeskV2(f.base, [registration(f.page, 'knowledge-one'), registration(second, 'knowledge-two')]);
    expect(desk.live_sources?.map(value => 'source_id' in value ? value.source_id : undefined)).toEqual(['knowledge-one', 'knowledge-two']);
    const one = await desk.list({ source: 'knowledge-one' });
    expect(one.items[0]).toMatchObject({ id: 'page-1', source_id: 'knowledge-one' });
    expect(second.list).not.toHaveBeenCalled();
    const two = await desk.search({ query: 'launch', source: 'knowledge-two', kinds: ['page'] });
    expect(two.items[0]).toMatchObject({ id: 'second-page-1', source_id: 'knowledge-two' });
    expect(f.page.search).not.toHaveBeenCalled(); expect(f.base.search).not.toHaveBeenCalled();
    await desk.open({ item: 'page-1' }); await desk.open({ item: 'second-page-1' });
    expect(f.page.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'page-1' }));
    expect(second.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'second-page-1' }));
    const both = await desk.search({ kinds: ['page'], limit: 4 });
    expect(both.items.map(item => item.source_id)).toEqual(['knowledge-one', 'knowledge-two', 'knowledge-one', 'knowledge-two']);
    await expect(desk.list({ source: 'unregistered' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.open({ item: 'unissued' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('pins the exact project and rechecks every same-kind source grant after provider awaits', async () => {
    const scope = { kind: 'project' as const, project_id: 'prj_00000000-0000-4000-8000-000000000001' as const };
    const f = mixedFixture(); const base = { ...f.base, scope };
    const second = live('other-knowledge', []);
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(base, [registration(f.page, 'knowledge-one')])).toThrow(AuthorityOperationError);
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(base, [registration(f.page, 'knowledge-one', { kind: 'project', project_id: 'another-project' })])).toThrow(AuthorityOperationError);
    let revoked = false;
    vi.mocked(second.revalidate).mockImplementation(async () => { revoked = true; });
    vi.mocked(f.page.assertCurrent).mockImplementation(() => { if (revoked) throw new AuthorityOperationError('stale_access_state', 'Membership changed'); });
    const desk = createRegisteredPersonLiveEvidenceDeskV2(base, [registration(f.page, 'knowledge-one', scope), registration(second, 'knowledge-two', scope)]);
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.page.revalidate).toHaveBeenCalledOnce(); expect(second.revalidate).toHaveBeenCalledOnce();
  });
  it('refuses ambiguous registration and cross-source handle ownership', async () => {
    const f = mixedFixture();
    const first = registration(f.page, 'knowledge-one');
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(f.base, [first, first])).toThrow(AuthorityOperationError);
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(f.base, [{ ...first, descriptor: { ...first.descriptor, tool_id: 'different-provider' } }])).toThrow(AuthorityOperationError);
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(f.base, [{ ...first, descriptor: { ...first.descriptor, source_id: 'meetings' } }])).toThrow(AuthorityOperationError);
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(f.base, [first, { ...first, descriptor: { ...first.descriptor, source_id: 'knowledge-two' } }])).toThrow(AuthorityOperationError);
    const other = live('other-knowledge', (await f.page.list({})).items);
    const desk = createRegisteredPersonLiveEvidenceDeskV2(f.base, [first, registration(other, 'knowledge-two')]);
    await desk.list({ source: 'knowledge-one' });
    await expect(desk.list({ source: 'knowledge-two' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(other.open).not.toHaveBeenCalled();
    const wrongKind = createRegisteredPersonLiveEvidenceDeskV2(f.base, [{ ...first, descriptor: { ...first.descriptor, kind: 'ticket' } }]);
    await expect(wrongKind.list({ source: first.descriptor.source_id })).rejects.toMatchObject({ code: 'invalid_output' });
  });
});
