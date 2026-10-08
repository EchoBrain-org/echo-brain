import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { describe, expect, it, vi } from 'vitest';
import { SqliteTriggerRunsV1, enqueueApprovedRecordRunV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { createPersonTriggerRunsV1 } from '../src/composition/person-trigger-runs-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';

const record = { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' as const };
const ticket = { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud', ticket_id: '46', permalink: 'https://example.test/THERM-46', text_sha256: canonicalSha256('ticket') };
const card = { decided: [{ text: 'Approved display decision.', citation_index: 0 }], affected: [{ citation_index: 1, says_now: 'ignored', relation: 'conflicts' as const }], unconfirmed: [], people: [], status: 'assessed' as const,
  citations: [{ citation: record, kind: 'decision' as const, label: 'Approved display', visibility: 'team' as const }, { citation: ticket, kind: 'ticket' as const, label: 'Kestrel cooling fan drift 0xC0FFEE', visibility: 'only_me' as const }] };

async function fixture(options: { readonly anchor?: () => typeof record; readonly render?: () => Promise<unknown> } = {}) {
  let now = new Date('2026-10-07T10:00:00.000Z');
  const f = await approvalCoreFixture(); const runs = new SqliteTriggerRunsV1(f.db, () => now);
  f.core.decide('desktop', f.approve(), () => f.session);
  await f.publisher([enqueueApprovedRecordRunV1(runs)]).appendFinalizedApprovalsToV4(new AbortController().signal);
  const row = runs.list(f.person, 1)[0]!;
  const auth = (token: string) => token === 'approver' ? { ...f.person, session_family_id: 'family', checked_at: now.toISOString() } :
    token === 'other' ? { ...f.person, principal_id: 'prn_00000000-0000-4000-8000-0000000000f1', membership_id: 'mem_00000000-0000-4000-8000-0000000000f2', session_family_id: 'other', checked_at: now.toISOString() } : (() => { throw new AuthorityOperationError('unauthorized', 'bad token'); })();
  const openCitation = vi.fn(async ({ citation }: { readonly citation: unknown }) => ({ items: [{ citation: (citation as { kind: string }).kind === 'approved_record' ? record : ticket, kind: (citation as { kind: string }).kind === 'approved_record' ? 'decision' : 'ticket', label: 'Current title', visibility: 'team', text: 'Current live ticket text', receipt_sha256: canonicalSha256('receipt') }], truncated: false, receipt_digests: [] }));
  const desk = { openCitation, revalidate: vi.fn(async () => ({ checked_at: now.toISOString() })) };
  const bindDesk = vi.fn(async (..._args: unknown[]) => desk);
  const research = vi.fn(() => ({ renderWithResearch: async () => ({ rendered: await (options.render ?? (async () => card))(), research: { items: [{ citation: record, title: 'Approved display' }, { citation: ticket, title: 'Kestrel cooling fan drift 0xC0FFEE' }] } }) }));
  const app = createPersonTriggerRunsV1({ runs, sessions: { authenticateAccess: ({ access_token }) => auth(access_token) as never }, records: { recordAnchor: () => (options.anchor ?? (() => record))(), recordProjects: () => [] }, bindDesk: bindDesk as never, audit: {} as never, bind_options: { authority_id: 'authority', state_lineage_id: 'lineage' } as never, research: research as never, lease_ms: 1_000 });
  const settled = async () => await vi.waitFor(() => expect(runs.read(f.person, row.run_id)!.state).not.toBe('running'));
  return { ...f, runs, row, app, research, bindDesk, openCitation, settled, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('durable approved-record trigger runs', () => {
  it('acts as the approver, stores pointers only, and hides every operation from another person', async () => {
    const f = await fixture();
    await expect(f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).resolves.toEqual({ state: 'running' });
    await f.settled();
    expect(f.research).toHaveBeenCalled(); expect(f.bindDesk.mock.calls[0]![2]).toMatchObject({ access_token: 'approver' });
    expect(f.runs.read(f.person, f.row.run_id)!.result_json).not.toContain('0xC0FFEE');
    await expect(f.app.start({ access_token: 'other', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.app.view({ access_token: 'other', request: { schema_version: 1, operation: 'view', run_id: f.row.run_id } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.app.retry({ access_token: 'other', request: { schema_version: 1, operation: 'retry', run_id: f.row.run_id } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.app.list({ access_token: 'other' })).resolves.toEqual({ runs: [] });
  });

  it('releases index lag without an attempt and maps access loss and repeated timeouts', async () => {
    const lag = await fixture({ anchor: () => { throw new PersonRecordSearchIndexLagV1(); } });
    await lag.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: lag.row.run_id } }); await lag.settled();
    expect(lag.runs.read(lag.person, lag.row.run_id)).toMatchObject({ state: 'pending', attempts: 0 });
    const timeout = await fixture({ render: async () => { throw new AgenticAskDeadlineErrorV1(); } });
    for (let at = 0; at < 3; at++) { await timeout.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: timeout.row.run_id } }); await timeout.settled(); }
    expect(timeout.runs.read(timeout.person, timeout.row.run_id)).toMatchObject({ state: 'failed', error_code: 'timed_out', attempts: 3 });
    const lost = await fixture({ anchor: () => { throw new AuthorityOperationError('not_found', 'record is no longer readable'); } });
    await lost.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: lost.row.run_id } }); await lost.settled();
    expect(lost.runs.read(lost.person, lost.row.run_id)).toMatchObject({ state: 'failed', error_code: 'no_access' });
  });

  it('freshens a completed card, hiding an empty open and retaining no outside stored text', async () => {
    const f = await fixture(); await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } }); await f.settled();
    f.openCitation.mockResolvedValueOnce({ items: [{ citation: record, kind: 'decision', label: 'Approved display', visibility: 'team', text: 'local', receipt_sha256: canonicalSha256('local') }], truncated: false, receipt_digests: [] }).mockResolvedValueOnce({ items: [], truncated: false, receipt_digests: [] });
    await expect(f.app.view({ access_token: 'approver', request: { schema_version: 1, operation: 'view', run_id: f.row.run_id } })).resolves.toMatchObject({ hidden: 1, card: { citations: [expect.anything()] } });
  });

  it('leaves a shutdown worker running until its lease expires, then permits one replacement', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ render: async () => { await blocked; return card; } });
    await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } });
    f.app.close();
    await vi.waitFor(() => expect(f.runs.read(f.person, f.row.run_id)!.state).toBe('running'));
    expect(await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).toEqual({ state: 'running' });
    f.advance(1_001);
    expect(await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).toEqual({ state: 'running' });
    release(); await f.settled(); expect(f.research).toHaveBeenCalledTimes(2);
  });
});
