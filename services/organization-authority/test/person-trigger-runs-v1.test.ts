import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteImpactItemsV1 } from '../src/adapters/persistence/sqlite/impact-items-v1.js';
import { SqliteOpenItemPeopleV1 } from '../src/adapters/persistence/sqlite/open-item-people-v1.js';
import { observeCoreRuntimeV1, coreRuntimeIdentityV1, annotateCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createPersonDiagnosticsV1, type PersonDiagnosticsV1 } from '../src/composition/person-diagnostics-v1.js';
import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from '../../../tests/support/telemetry-fixture-vocabulary-v1.js';

import { SqliteTriggerRunsV1, enqueueApprovedRecordRunV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { readStoredImpactCardV1 } from '../src/composition/person-stored-impact-card-v1.js';
import { createPersonTriggerRunsV1 } from '../src/composition/person-trigger-runs-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import { openItemsFixture } from './fixtures/open-items.js';

const captures: PersonDiagnosticsV1[] = [];
afterEach(() => { for (const capture of captures.splice(0)) capture.close(); });

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
  // Only the approver reads this "only me" decision.
  const readableDecisions = ({ access_token, record_sha256s }: { readonly access_token: string; readonly record_sha256s: readonly string[] }) => new Map(access_token !== 'approver' ? [] :
    record_sha256s.map(sha => [sha, { approval_id: f.approvalId, record_sha256: sha, title: 'Approved display', approved_at: now.toISOString(), project_ids: [] }] as const));
  const diagnostics = createPersonDiagnosticsV1({ sessions: { authenticateAccess: ({ access_token }) => auth(access_token) } });
  captures.push(diagnostics);
  const create = (serviceRuns: SqliteTriggerRunsV1 = runs) => createPersonTriggerRunsV1({ runs: serviceRuns, sessions: { authenticateAccess: ({ access_token }) => auth(access_token) as never }, records: { recordAnchor: () => (options.anchor ?? (() => record))(), recordProjects: () => [], readableDecisions: readableDecisions as never, projectRecords: () => [] }, bindDesk: bindDesk as never, audit: {} as never, bind_options: { authority_id: 'authority', state_lineage_id: 'lineage', diagnostics } as never, research: research as never, lease_ms: 1_000,
    items: new SqliteImpactItemsV1(f.db, () => now), people: new SqliteOpenItemPeopleV1(f.db) });
  const app = create();
  const settled = async () => await vi.waitFor(() => expect(runs.read(f.person, row.run_id)!.state).not.toBe('running'));
  return { ...f, runs, row, app, create, research, diagnostics, desk, renderInputs, bindDesk, openCitation, settled, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
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

  it('lists at most the 20 newest sweeps, so they never push an impact run off the list', async () => {
    const f = await fixture();
    // An older impact check that failed: its Try again row must stay listed.
    const impact = f.runs.claim(f.person, f.row.run_id, 60_000);
    if (impact.kind !== 'claimed') throw new Error('expected lease');
    expect(f.runs.fail(f.row.run_id, impact.lease_token, 'research_failed')).toBe(true);
    const sweeps: string[] = [];
    for (let index = 0; index < 30; index++) {
      f.advance(1_000);
      const sweep = f.runs.enqueueSweep(f.person, { kind: 'mine' });
      const lease = f.runs.claim(f.person, sweep.run_id, 60_000);
      if (lease.kind !== 'claimed' || !f.runs.fail(sweep.run_id, lease.lease_token, 'unavailable')) throw new Error('expected a failed sweep');
      sweeps.push(sweep.run_id);
    }
    // A newer approval's impact check, queued after them all.
    f.advance(1_000);
    const other = await f.otherProposal();
    f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'approve-other' }), () => f.session);
    await f.publisher([enqueueApprovedRecordRunV1(f.runs)]).appendFinalizedApprovalsToV4(new AbortController().signal);
    const newer = f.runs.list(f.person, 1, 'approved_record')[0]!.run_id;
    const { runs } = await f.app.list({ access_token: 'approver' });
    // Newest first overall, as before: the 20 newest sweeps among the impact runs.
    expect(runs.map(run => run.run_id)).toEqual([newer, ...sweeps.slice(-20).reverse(), f.row.run_id]);
    expect(runs.at(-1)).toMatchObject({ trigger: 'approved_record', state: 'failed', error_code: 'research_failed' });
  });

  it('captures one approved run with a linked background root and preserves its research outcome after committing output', async () => {
    const f = await fixture({ render: async () => { annotateCoreRuntimeV1({ result: 'partial' }); return card; } });
    const capture = await f.diagnostics.prepare({ access_token: 'approver', request: { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id: f.row.run_id } } });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1('http_request', () => f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id, capture_id: capture.capture_id } }), {
      vocabulary: { ...TELEMETRY_FIXTURE_VOCABULARY_V1, triggers: ['approved_record'] }, observer: event => { events.push(event); },
    });
    await f.settled();
    const result = await f.diagnostics.read({ access_token: 'approver', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } });
    expect(result).toMatchObject({ status: 'completed', trace: { complete: true, events: [
      { kind: 'lifecycle', stage: 'trigger', data: { trigger: 'approved_record', run_id: f.row.run_id, event_id: f.row.event_ref } },
      { kind: 'lifecycle', stage: 'persistence', event: 'succeeded' },
      { kind: 'lifecycle', stage: 'application', event: 'succeeded' },
    ] } });
    expect(f.desk.revalidate).toHaveBeenCalledTimes(1);
    const http = events.find(event => event.phase === 'http_request' && event.event === 'succeeded')!;
    const run = events.find(event => event.phase === 'research_run' && event.event === 'succeeded')!;
    expect(run).toMatchObject({ root: true, parent_operation_id: http.operation_id, parent_span_id: null, trigger: 'approved_record',
      run_id: coreRuntimeIdentityV1('research-run', f.row.run_id), event_id: coreRuntimeIdentityV1('research-event', f.row.event_ref),
      output_id: coreRuntimeIdentityV1('research-output', canonicalSha256(JSON.parse(f.runs.read(f.person, f.row.run_id)!.result_json!))), result: 'partial',
    });
    expect(run.operation_id).not.toBe(http.operation_id);
    expect(events.find(event => event.phase === 'research_run' && event.event === 'started')).toMatchObject({ run_id: run.run_id, event_id: run.event_id, attempt_id: run.attempt_id, trigger: 'approved_record' });
    expect(result.trace!.events.every(event => event.operation_id === run.operation_id)).toBe(true);
    await expect(f.diagnostics.read({ access_token: 'other', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } })).rejects.toMatchObject({ code: 'not_found' });
    await f.app.view({ access_token: 'approver', request: { schema_version: 1, operation: 'view', run_id: f.row.run_id } });
    expect(f.research).toHaveBeenCalledTimes(1);
  });

  it('releases the run lease without an attempt when a capture belongs to another target', async () => {
    const f = await fixture();
    const capture = await f.diagnostics.prepare({ access_token: 'approver', request: { schema_version: 1, operation: 'prepare', target: { kind: 'ask' } } });
    await expect(f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id, capture_id: capture.capture_id } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.runs.read(f.person, f.row.run_id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(f.research).not.toHaveBeenCalled();
  });

  it('marks the capture failed when a completed renderer has lost the durable run lease', async () => {
    const f = await fixture();
    const capture = await f.diagnostics.prepare({ access_token: 'approver', request: { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id: f.row.run_id } } });
    const finish = vi.spyOn(f.runs, 'finish').mockReturnValueOnce(false);
    await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id, capture_id: capture.capture_id } });
    await f.settled();
    expect(finish).toHaveBeenCalledTimes(1);
    const result = await f.diagnostics.read({ access_token: 'approver', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
    expect(result.trace!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'persistence', event: 'skipped' }), expect.objectContaining({ stage: 'application', event: 'failed' }),
    ]));
    expect(result.trace!.events.some(event => event.stage === 'application' && event.event === 'succeeded')).toBe(false);
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
      if (property === 'readUnfenced') return (runId: string) => {
        const row = target.readUnfenced(runId);
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

  it('reads a stored card back with what the decision expects of each item (R6)', async () => {
    const f = await fixture({ render: async () => ({ ...card, affected: [{ ...card.affected[0], expected: 'two decimals from DVT' }] }) });
    await f.app.start({ access_token: 'approver', request: { schema_version: 1, operation: 'start', run_id: f.row.run_id } }); await f.settled();
    const stored = readStoredImpactCardV1(f.runs.read(f.person, f.row.run_id)!.result_json!);
    expect(stored.affected).toEqual([{ citation_index: 1, relation: 'conflicts', expected: 'two decimals from DVT' }]);
    expect(stored.decided).toEqual([{ text: 'Approved display decision.', citation_index: 0 }]);
    expect(() => readStoredImpactCardV1('{')).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });
});

describe('open items written when an impact check finishes', () => {
  it('writes one unsent item per conflict or needs-updating row at finish, with exact owners, and no outside text', async () => {
    const f = await openItemsFixture({ outsideText: 'Kestrel cooling fan drift 0xC0FFEE' });
    await f.finishImpactRun();
    const rows = f.db.prepare('SELECT * FROM authority_impact_items_v1').all();
    expect(rows).toHaveLength(2);                                        // the confirms row made none
    expect(rows.map(row => (row as { owner_match: string }).owner_match).sort()).toEqual(['approver', 'jira_account']);
    expect(JSON.stringify(rows)).not.toContain('0xC0FFEE');
    expect(JSON.stringify(rows)).not.toContain('acct-mina');
    expect(f.db.prepare('SELECT result_json FROM authority_trigger_runs_v1').pluck().all().join('')).not.toContain('0xC0FFEE');
    const items = f.items.forRun(f.runId);
    expect(items.find(item => item.pointer.kind === 'ticket')).toMatchObject({ state: 'unsent', relation: 'needs_updating', expected: 'launch next week', owner_membership_id: f.membership('mina'), owner_match: 'jira_account', record_sha256: f.record });
    expect(items.find(item => item.pointer.kind === 'approved_record')).toMatchObject({ state: 'unsent', relation: 'conflicts', expected: 'pilot starts next week', owner_membership_id: f.membership('ari'), owner_match: 'approver' });
    // One bulk assignee read, with the approver's own session.
    expect(f.jira_owners.assignees).toHaveBeenCalledTimes(1);
    expect(f.jira_owners.assignees).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'ari', ticket_ids: ['10012'] }));
  });

  it('reports a run whose attempt stopped without finishing as pending, without changing it, and starts it again (R60)', async () => {
    const f = await openItemsFixture();
    const mina = { organization_id: f.person.organization_id, principal_id: f.people.mina.principal_id, membership_id: f.membership('mina') };
    // The Authority stops while Ari's impact check and Mina's sweep run.
    if (f.runs.claim(f.person, f.runId, 60_000).kind !== 'claimed') throw new Error('expected lease');
    const sweep = f.runs.enqueueSweep(mina, { kind: 'mine' });
    if (f.runs.claim(mina, sweep.run_id, 60_000).kind !== 'claimed') throw new Error('expected lease');
    const stage = async () => (await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record, summary_only: true } })).stages;
    expect((await f.app.list({ access_token: 'ari' })).runs.map(run => run.state)).toEqual(['running']);
    expect(await stage()).toMatchObject([{ run_id: f.runId, state: 'running' }]);
    f.advance(60_001);
    expect((await f.app.list({ access_token: 'ari' })).runs).toMatchObject([{ run_id: f.runId, trigger: 'approved_record', state: 'pending', error_code: null }]);
    expect((await f.app.list({ access_token: 'mina' })).runs).toMatchObject([{ run_id: sweep.run_id, trigger: 'sweep', state: 'pending', error_code: null }]);
    expect(await stage()).toMatchObject([{ run_id: f.runId, state: 'pending', error_code: null }]);
    expect([f.runs.readUnfenced(f.runId)!.state, f.runs.readUnfenced(sweep.run_id)!.state]).toEqual(['running', 'running']);
    // The desktop starts it again: claim takes over the lapsed attempt.
    await expect(f.app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id: f.runId } })).resolves.toEqual({ state: 'running' });
    await vi.waitFor(() => expect(f.runs.read(f.person, f.runId)!.state).toBe('done'));
  });

  it('matches an ECHO action owner by a name exactly one active member holds', async () => {
    const f = await openItemsFixture({ actionOwner: 'rafael  MORENO' });
    await f.finishImpactRun();
    expect(f.items.forRun(f.runId).find(item => item.pointer.kind === 'approved_record')).toMatchObject({ owner_membership_id: f.membership('rafael'), owner_match: 'name' });
  });

  it('writes an item for each not-assessed row, with no relation or expected phrase', async () => {
    const f = await openItemsFixture({ assessed: false });
    await f.finishImpactRun();
    const items = f.items.forRun(f.runId);
    expect(items).toHaveLength(2);
    expect(items.map(item => [item.relation, item.expected])).toEqual([[null, null], [null, null]]);
  });

  it('keeps one item per item key and gives the approver every ticket when the assignee read fails', async () => {
    const f = await openItemsFixture({ duplicateTicket: true, jiraFails: true });
    await f.finishImpactRun();
    const items = f.items.forRun(f.runId);
    expect(items.filter(item => item.pointer.kind === 'ticket')).toHaveLength(1);
    expect(items.find(item => item.pointer.kind === 'ticket')).toMatchObject({ relation: 'needs_updating', expected: 'launch next week', owner_membership_id: f.membership('ari'), owner_match: 'approver' });
  });

  it('opens a finished card to any decision reader and to nobody else', async () => {
    const f = await openItemsFixture();
    await f.finishImpactRun();
    const view = (access_token: string) => f.app.view({ access_token, request: { schema_version: 1, operation: 'view', run_id: f.runId } });
    await expect(view('ari')).resolves.toMatchObject({ card: { decided: [{ text: 'The pilot starts next week.' }] } });
    const mina = await view('mina');
    expect(mina.card.affected).toHaveLength(3);
    // The card is rebuilt with Mina's own access, on a desk bound to her session.
    expect(f.bindDesk.mock.calls.at(-1)![2]).toMatchObject({ access_token: 'mina' });
    await expect(view('okafor')).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.app.view({ access_token: 'okafor', request: { schema_version: 1, operation: 'view', run_id: 'run_missing-run' } })).rejects.toMatchObject({ code: 'not_found' });
    f.revoke('rafael');
    await expect(view('rafael')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('shows a decision reader the card without the item the desk refuses them', async () => {
    const f = await openItemsFixture();
    await f.finishImpactRun();
    // Rafael reads the decision, but the desk refuses him the Jira ticket.
    const rafael = await f.app.view({ access_token: 'rafael', request: { schema_version: 1, operation: 'view', run_id: f.runId } });
    expect(rafael.hidden).toBe(1);
    expect(rafael.card.citations.map(entry => entry.kind)).toEqual(['decision', 'action', 'page']);
    expect(rafael.card.affected.map(row => row.relation)).toEqual(['conflicts', 'confirms']);
    expect(rafael.card.decided).toEqual([{ text: 'The pilot starts next week.', citation_index: 0 }]);
    // Nothing of the ticket: no key, id, link, or the assignee only its details name.
    for (const withheld of ['ECHO-12', '10012', 'browse/', 'Mina Patel']) expect(JSON.stringify(rafael)).not.toContain(withheld);
    expect(f.bindDesk.mock.calls.at(-1)![2]).toMatchObject({ access_token: 'rafael' });
    // Mina, who can open it, sees the same card with the ticket.
    const mina = await f.app.view({ access_token: 'mina', request: { schema_version: 1, operation: 'view', run_id: f.runId } });
    expect(mina.hidden).toBe(0);
    expect(mina.card.citations.map(entry => entry.kind)).toEqual(['decision', 'ticket', 'action', 'page']);
  });
});
