import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { describe, expect, it, vi } from 'vitest';
import { SqliteTriggerRunsV1, enqueueApprovedRecordRunV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { createPersonTriggerRunsV1 } from '../src/composition/person-trigger-runs-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';

const record = { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' as const };
const ticket = { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud', ticket_id: '46', permalink: 'https://example.test/THERM-46', text_sha256: canonicalSha256('ticket') };
const card = { decided: [{ text: 'Approved display decision.', citation_index: 0 }], affected: [{ citation_index: 1, says_now: 'ignored', relation: 'conflicts' as const }], unconfirmed: [], people: [], status: 'assessed' as const,
  citations: [{ citation: record, kind: 'decision' as const, label: 'Approved display', visibility: 'team' as const }, { citation: ticket, kind: 'ticket' as const, label: 'Kestrel cooling fan drift 0xC0FFEE', visibility: 'only_me' as const }] };

async function fixture(options: { readonly anchor?: () => typeof record; readonly render?: (input: { readonly signal?: AbortSignal }) => Promise<unknown> } = {}) {
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
  const renderInputs: unknown[] = [];
  const research = vi.fn(() => ({ renderWithResearch: async (input: { readonly signal?: AbortSignal }) => {
    renderInputs.push(input);
    return { rendered: await (options.render ?? (async () => card))(input), research: { items: [{ citation: record, title: 'Approved display' }, { citation: ticket, title: 'Kestrel cooling fan drift 0xC0FFEE' }] } };
  } }));
  const create = (serviceRuns: SqliteTriggerRunsV1 = runs) => createPersonTriggerRunsV1({ runs: serviceRuns, sessions: { authenticateAccess: ({ access_token }) => auth(access_token) as never }, records: { recordAnchor: () => (options.anchor ?? (() => record))(), recordProjects: () => [] }, bindDesk: bindDesk as never, audit: {} as never, bind_options: { authority_id: 'authority', state_lineage_id: 'lineage' } as never, research: research as never, lease_ms: 1_000 });
  const app = create();
  const settled = async () => await vi.waitFor(() => expect(runs.read(f.person, row.run_id)!.state).not.toBe('running'));
  return { ...f, runs, row, app, create, research, renderInputs, bindDesk, openCitation, settled, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('durable approved-record trigger runs', () => {
  it('acts as the approver, stores pointers only, and hides every operation from another person', async () => {
    const f = await fixture();
    await expect(f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).resolves.toEqual({ state: 'running' });
    await f.settled();
    expect(f.research).toHaveBeenCalled(); expect(f.bindDesk.mock.calls[0]![2]).toMatchObject({ access_token: 'approver' });
    const trigger = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'approved_record')!;
    expect(f.renderInputs[0]).toMatchObject({
      trigger: 'approved_record', trigger_input: { record }, renderer: trigger.renderer,
      brief: { starting: [{ citation: record, if_unreadable: 'fail' }], budget: trigger.brief(trigger.parseEvent({ record })).budget },
    });
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

  it('stores what the record expects of a conflicting item and reads the stored card back', async () => {
    const f = await fixture({ render: async () => ({ ...card, affected: [{ ...card.affected[0], expected: 'two decimals from DVT' }] }) });
    await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } }); await f.settled();
    expect(JSON.parse(f.runs.read(f.person, f.row.run_id)!.result_json!).affected).toEqual([{ citation_index: 1, relation: 'conflicts', expected: 'two decimals from DVT' }]);
    await expect(f.app.view({ access_token: 'approver', request: { schema_version: 1, operation: 'view', run_id: f.row.run_id } })).resolves.toMatchObject({ hidden: 0 });
  });

  it('refuses an invalid stored pointer card before opening a citation', async () => {
    const f = await fixture(); await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } }); await f.settled();
    const invalid = canonicalJson({ schema_version: 1, status: 'assessed', citations: [ticket], decided: [{ citation_index: 0, text: 'Outside ticket text must never persist.' }], affected: [], unconfirmed: [] });
    const malformed = f.create(new Proxy(f.runs, { get(target, property, receiver) {
      if (property === 'read') return (actor: typeof f.person, runId: string) => {
        const row = target.read(actor, runId);
        return row === undefined ? undefined : { ...row, result_json: invalid };
      };
      return Reflect.get(target, property, receiver);
    } }));
    await expect(malformed.view({ access_token: 'approver', request: { schema_version: 1, operation: 'view', run_id: f.row.run_id } })).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.openCitation).not.toHaveBeenCalled();
  });

  it('leaves a shutdown worker running until its lease expires, then permits one replacement', async () => {
    let calls = 0;
    const f = await fixture({ render: async ({ signal }) => {
      calls++;
      if (calls === 1) return await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('runner observed shutdown abort')), { once: true }));
      return card;
    } });
    await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } });
    await vi.waitFor(() => expect(f.research).toHaveBeenCalledTimes(1));
    f.app.close();
    await vi.waitFor(() => expect(f.runs.read(f.person, f.row.run_id)!.state).toBe('running'));
    const restarted = f.create();
    expect(await restarted.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).toEqual({ state: 'running' });
    f.advance(1_001);
    expect(await restarted.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } })).toEqual({ state: 'running' });
    await f.settled(); expect(f.research).toHaveBeenCalledTimes(2);
  });
});
