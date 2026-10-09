import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { personSweepResultStatusV1, type PersonRunsResultsV1, type PersonSweepVerdictV1 } from '@echo-brain/organization-api';
import { impactItemKeyV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import type { SweepTriggerInputV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/sweep-renderer-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { enqueueApprovedRecordRunV1 } from '../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { createPersonDiagnosticsV1, type PersonDiagnosticsV1 } from '../src/composition/person-diagnostics-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { createPersonTriggerRunsV1 } from '../src/composition/person-trigger-runs-v1.js';
import { sentFixture, type FixturePerson, type OpenItemsFixtureOptionsV1 } from './fixtures/open-items.js';

const captures: PersonDiagnosticsV1[] = [];
afterEach(() => { for (const capture of captures.splice(0)) capture.close(); });

type Verdict = PersonSweepVerdictV1 | null;
type SweepScope = { readonly scope: 'mine' } | { readonly scope: 'record' | 'project'; readonly id: string };
const HOUR = 3_600_000;
const MINE = { scope: 'mine' } as const;
const NOTHING = { state: 'nothing_to_check' } as const;
const ZERO = { schema_version: 1, landed: 0, still_open: 0, changed: 0, unreadable: 0, not_assessed: 0 };

function runOf(result: PersonRunsResultsV1['sweep']): string {
  if (!('run_id' in result)) throw new Error('expected a sweep run');
  return result.run_id;
}

/**
 * Ari's decision after Send (the open-items fixture): the Jira ticket and the
 * other decision's action, both open. A sweep's model says `verdicts` of each
 * finding, by the kind of the item it is about (null: not assessed), and
 * writes outside words into its lines and labels, which nothing may store.
 * Sweeps wait for their research until `settled` lets them finish, so a test
 * can change the world while a sweep is in flight.
 */
async function sweepFixture(options: OpenItemsFixtureOptionsV1 & { readonly owner?: FixturePerson; readonly verdicts?: Partial<Record<string, Verdict>> } = {}) {
  const f = await sentFixture(options);
  const verdicts = options.verdicts ?? {};
  /** Each sweep's findings, as its research was given them. */
  const findings: SweepTriggerInputV1['findings'][] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.renderSweepsWith(async ({ trigger_input }) => {
    const input = trigger_input as SweepTriggerInputV1;
    findings.push(input.findings);
    await gate;
    const citations: unknown[] = [];
    const results = input.findings.map((finding, finding_index) => {
      const pointer = finding.citations[0] as { readonly kind: string };
      const verdict = verdicts[pointer.kind] ?? null;
      if (verdict === null || verdict === 'unreadable') return { finding_index, verdict, line: verdict === null ? 'Not assessed.' : 'ECHO could not read this item.', citation_indexes: [] };
      citations.push({ citation: pointer, kind: pointer.kind === 'approved_record' ? 'action' : pointer.kind, label: `Now ${f.outsideText}`, visibility: 'only_me' });
      return { finding_index, verdict, line: `It reads ${f.outsideText} now.`, citation_indexes: [citations.length - 1] };
    });
    return { findings: results, status: personSweepResultStatusV1(results), citations };
  });
  const sweep = (access_token: FixturePerson, scope: SweepScope) => f.app.sweep({ access_token, request: { schema_version: 1, operation: 'sweep', ...scope } });
  const start = (access_token: FixturePerson, run_id: string) => f.app.start({ access_token, request: { schema_version: 1, operation: 'start', run_id } });
  return {
    ...f, findings, sweep, start,
    /** Queues a sweep and starts it, once its research has begun: what it checks was read as it started. */
    async queueAndStart(access_token: FixturePerson = 'ari', scope: SweepScope = MINE) {
      const run_id = runOf(await sweep(access_token, scope));
      const before = findings.length;
      expect(await start(access_token, run_id)).toEqual({ state: 'running' });
      await vi.waitFor(() => expect(findings.length).toBeGreaterThan(before));
      return { run_id };
    },
    /** Lets every sweep's research finish, and waits until this run is no longer running. */
    async settled(run_id: string) {
      release();
      await vi.waitFor(() => expect(f.runs.readUnfenced(run_id)!.state).not.toBe('running'));
    },
    /** The ticket's and the action's last verdicts, in that order. */
    verdicts: () => [f.ticket, f.action].map(item => f.items.read(item.item_id)!.check?.verdict ?? null),
    sweepDue: async (access_token: FixturePerson) => (await f.app.home({ access_token })).sweep_due,
    counts: (run_id: string) => JSON.parse(f.runs.readUnfenced(run_id)!.result_json!) as unknown,
    /** Ari approves another meeting into project A; its impact check waits to start. */
    async approveAnother() {
      const other = await f.otherProposal();
      f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: 'approve-other', project_ids: [f.projectA] }), () => f.session);
      await f.publisher([enqueueApprovedRecordRunV1(f.runs)]).appendFinalizedApprovalsToV4(new AbortController().signal);
      return f.runs.list(f.person, 10).find(run => run.trigger === 'approved_record' && run.event_ref === other.approvalId)!.run_id;
    },
  };
}

describe('sweep runs record a shared last check', () => {
  it('records verdicts on the items the sweep checked, never their state', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'changed' } });
    const checkedAt = f.clock().toISOString();
    const { run_id } = await f.queueAndStart('ari');
    await f.settled(run_id);
    const row = (itemId: string) => f.db.prepare('SELECT state, checked_verdict, checked_by, checked_at, checked_run_id FROM authority_impact_items_v1 WHERE item_id=?').get(itemId);
    const check = { checked_by: f.membership('ari'), checked_at: checkedAt, checked_run_id: run_id };
    // A landed item stays open: only a person's click closes it.
    expect(row(f.ticket.item_id)).toEqual({ state: 'open', checked_verdict: 'landed', ...check });
    expect(row(f.action.item_id)).toEqual({ state: 'open', checked_verdict: 'changed', ...check });
    // The run keeps the counts by verdict, and nothing stored holds a word the sweep read.
    expect(f.runs.readUnfenced(run_id)).toMatchObject({ trigger: 'sweep', state: 'done', error_code: null });
    expect(f.counts(run_id)).toEqual({ ...ZERO, landed: 1, changed: 1 });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM authority_trigger_runs_v1 WHERE run_id=?').get(run_id))).not.toContain('0xC0FFEE');
    expect(JSON.stringify(f.db.prepare('SELECT * FROM authority_impact_items_v1').all())).not.toContain('0xC0FFEE');
    // The check is shared: Mina, who owns both, sees Ari's.
    const mina = await f.app.home({ access_token: 'mina' });
    expect(mina.items.map(entry => [entry.item_id, entry.check])).toEqual([
      [f.action.item_id, { verdict: 'changed', checked_at: checkedAt, checked_by: 'Ari' }],
      [f.ticket.item_id, { verdict: 'landed', checked_at: checkedAt, checked_by: 'Ari' }],
    ]);
  });

  it('keeps a newer check and skips an item the sweeper lost', async () => {
    // No Jira match: the ticket stays Ari's own; the action goes to Mina.
    const f = await sweepFixture({ ticketOwner: 'none', owner: 'mina', verdicts: { ticket: 'changed', approved_record: 'landed' } });
    const { run_id } = await f.queueAndStart('ari');
    expect(f.findings.at(-1)).toHaveLength(2);                   // it set out to check both
    f.advance(1_000);
    f.check(f.ticket.item_id, 'landed', 'mina');                 // another person's sweep finished first
    f.removeProjectMembership(f.projectA);                       // Ari no longer reads the decision: he keeps his own ticket, not Mina's action
    f.advance(1_000);                                            // Ari's sweep finishes later still: its check is as of when it read the items
    await f.settled(run_id);
    expect(f.verdicts()).toEqual(['landed', null]);
    expect(f.items.read(f.ticket.item_id)!.check).toMatchObject({ verdict: 'landed', by: f.membership('mina') });
    expect([f.ticket, f.action].map(item => f.items.read(item.item_id)!.state)).toEqual(['open', 'open']);
    expect(f.runs.readUnfenced(run_id)).toMatchObject({ state: 'done' });
  });

  it('records checks only in the transaction that finishes the run', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const finish = vi.spyOn(f.runs, 'finish').mockReturnValueOnce(false);   // the attempt lost its lease meanwhile
    const { run_id } = await f.queueAndStart('ari');
    await f.settled(run_id);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(f.verdicts()).toEqual([null, null]);
  });

  it('queues one sweep per scope and asks for another once it is done', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    const mine = runOf(await f.sweep('ari', MINE));
    expect(await f.sweep('ari', MINE)).toEqual({ run_id: mine });
    const ofRecord = runOf(await f.sweep('ari', { scope: 'record', id: f.record }));
    const ofProject = runOf(await f.sweep('ari', { scope: 'project', id: f.projectA }));
    const minas = runOf(await f.sweep('mina', MINE));
    expect(new Set([mine, ofRecord, ofProject, minas]).size).toBe(4);
    expect(f.runs.readUnfenced(ofRecord)!.scope).toEqual({ kind: 'record', record_sha256: f.record });
    // While it runs, a request for the same scope answers the same run.
    expect(await f.start('ari', mine)).toEqual({ state: 'running' });
    expect(await f.sweep('ari', MINE)).toEqual({ run_id: mine });
    await f.settled(mine);
    expect(runOf(await f.sweep('ari', MINE))).not.toBe(mine);
  });

  it('says a sweep is due for stale items, at most hourly and never while one runs, while Check now still queues one', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    expect(await f.sweepDue('ari')).toBe(true);                  // he sent both; neither was ever checked
    expect(await f.sweepDue('mina')).toBe(true);                 // she owns both
    expect(await f.sweepDue('rafael')).toBe(false);              // he reads the decision, but sent and owns nothing
    expect(await f.sweepDue('okafor')).toBe(false);
    const run_id = runOf(await f.sweep('ari', MINE));
    expect(await f.sweepDue('ari')).toBe(false);                 // asked for within the hour
    f.advance(2 * HOUR);
    // Still waiting two hours on (the desktop closed before starting it): due again, and asking hands back that run to start (R58).
    expect(await f.sweepDue('ari')).toBe(true);
    expect(await f.sweep('ari', MINE)).toEqual({ run_id });
    await f.start('ari', run_id);
    expect(await f.sweepDue('ari')).toBe(false);                 // running
    await f.settled(run_id);
    expect(await f.sweepDue('ari')).toBe(false);                 // just checked
    expect(await f.sweepDue('mina')).toBe(false);                // Ari's check is hers too
    f.advance(24 * HOUR);
    expect(await f.sweepDue('ari')).toBe(false);                 // a day old, not older
    f.advance(1);
    expect(await f.sweepDue('ari')).toBe(true);
    // A sweep that fails is not asked for again within the hour...
    f.renderSweepsWith(async () => { throw new Error('The model gave up'); });
    const failed = runOf(await f.sweep('ari', MINE));
    await f.start('ari', failed); await f.settled(failed);
    expect(f.runs.readUnfenced(failed)).toMatchObject({ state: 'failed', error_code: 'research_failed' });
    expect(await f.sweepDue('ari')).toBe(false);
    // ...but Check now, a person's own request, queues one at once.
    f.advance(30 * 60_000);
    const again = runOf(await f.sweep('ari', MINE));
    expect(again).not.toBe(failed);
    await f.start('ari', again); await f.settled(again);
    expect(await f.sweepDue('ari')).toBe(false);
    f.advance(HOUR - 1);
    expect(await f.sweepDue('ari')).toBe(false);                 // within the hour of the newest sweep
    f.advance(1);
    expect(await f.sweepDue('ari')).toBe(true);
  });

  it('answers nothing_to_check without queuing a run', async () => {
    const f = await sweepFixture({ owner: 'mina' });
    const queued = () => f.db.prepare("SELECT count(*) FROM authority_trigger_runs_v1 WHERE trigger='sweep'").pluck().get();
    for (const [person, scope] of [
      ['okafor', MINE], ['rafael', MINE],                                          // nothing they sent or own
      ['okafor', { scope: 'record', id: f.record }], ['okafor', { scope: 'project', id: f.projectA }], // a decision he cannot read, asked by id
      ['ari', { scope: 'record', id: canonicalSha256('another record') }], ['ari', { scope: 'project', id: f.projectB }],
    ] as const) {
      expect(await f.sweep(person, scope), `${person} ${JSON.stringify(scope)}`).toEqual(NOTHING);
    }
    expect(queued()).toBe(0);
    // A reader may sweep a decision's or a project's items, though none is his own.
    expect(runOf(await f.sweep('rafael', { scope: 'record', id: f.record }))).toMatch(/^run_/);
    // Once every item is done, there is nothing to check.
    for (const item of [f.ticket, f.action]) await f.app.set_state({ access_token: 'mina', request: { schema_version: 1, operation: 'set_state', item_id: item.item_id, state: 'done' } });
    for (const scope of [MINE, { scope: 'record', id: f.record }, { scope: 'project', id: f.projectA }] as const) expect(await f.sweep('ari', scope)).toEqual(NOTHING);
    expect(queued()).toBe(1);
  });

  it('finishes with zero counts, reading nothing, when every item closed before it started', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const run_id = runOf(await f.sweep('ari', MINE));
    for (const item of [f.ticket, f.action]) await f.app.set_state({ access_token: 'mina', request: { schema_version: 1, operation: 'set_state', item_id: item.item_id, state: 'done' } });
    const binds = f.bindDesk.mock.calls.length;
    await f.start('ari', run_id); await f.settled(run_id);
    expect(f.runs.readUnfenced(run_id)).toMatchObject({ state: 'done' });
    expect(f.counts(run_id)).toEqual(ZERO);
    expect(f.bindDesk.mock.calls.length).toBe(binds);
    expect(f.findings).toEqual([]);
    expect(f.verdicts()).toEqual([null, null]);
  });

  it('runs impact checks before sweeps on one person\'s single live run', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const sweep = runOf(await f.sweep('ari', MINE));
    const impact = await f.approveAnother();
    expect(await f.start('ari', sweep)).toEqual({ state: 'busy' });   // the new decision's impact check is pending
    const lease = f.runs.claim(f.person, impact, 60_000);
    if (lease.kind !== 'claimed') throw new Error('expected the impact check to start');
    expect(await f.start('ari', sweep)).toEqual({ state: 'busy' });   // and now running
    expect(f.runs.readUnfenced(sweep)).toMatchObject({ state: 'pending', attempts: 0 });
    // Ari's impact checks do not hold up Mina's sweep.
    const minas = runOf(await f.sweep('mina', MINE));
    expect(await f.start('mina', minas)).toEqual({ state: 'running' });
    await f.settled(minas);
    expect(f.runs.finish(impact, lease.lease_token, { json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) })).toBe(true);
    expect(await f.start('ari', sweep)).toEqual({ state: 'running' });
    await f.settled(sweep);
    expect(f.runs.readUnfenced(sweep)).toMatchObject({ state: 'done' });
  });
});

describe('what a sweep checks and how', () => {
  it('names the decision in a finding only to those who read it', async () => {
    // S. Okafor owns the ticket (his Jira account) and cannot read the decision; Ari approved both items.
    const f = await sweepFixture({ ticketOwner: 'okafor', owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    const okafor = await f.queueAndStart('okafor');
    await f.settled(okafor.run_id);
    expect(f.findings.at(-1)).toEqual([{ finding: 'Outdated Jira ticket', expected: 'launch next week', citations: [f.card.pointers.ticket] }]);
    const ari = await f.queueAndStart('ari');
    await f.settled(ari.run_id);
    // Each item first (the one never checked before the one Okafor just checked), the decision after it as context.
    expect(f.findings.at(-1)).toEqual([
      { finding: 'Conflicting ECHO record from Pilot planning', expected: 'pilot starts next week', citations: [f.card.pointers.rollout, f.decisionCitation] },
      { finding: 'Outdated Jira ticket from Pilot planning', expected: 'launch next week', citations: [f.card.pointers.ticket, f.decisionCitation] },
    ]);
  });

  it('says what was decided from the first decided line, to readers only, when an item has no expected phrase', async () => {
    const f = await sweepFixture({ withoutExpected: true, ticketOwner: 'okafor', owner: 'mina', verdicts: { ticket: 'still_open' } });
    const okafor = await f.queueAndStart('okafor');
    await f.settled(okafor.run_id);
    expect(f.findings.at(-1)).toEqual([{ finding: 'Outdated Jira ticket', expected: 'the approved decision', citations: [f.card.pointers.ticket] }]);
    const ari = await f.queueAndStart('ari');
    await f.settled(ari.run_id);
    expect(f.findings.at(-1)!.map(finding => finding.expected)).toEqual(['The pilot starts next week.', 'The pilot starts next week.']);
    // The action was not assessed: its last check stays as it was, and the run still finishes.
    expect(f.runs.readUnfenced(ari.run_id)).toMatchObject({ state: 'done' });
    expect(f.counts(ari.run_id)).toEqual({ ...ZERO, still_open: 1, not_assessed: 1 });
    expect(f.verdicts()).toEqual(['still_open', null]);
  });

  it('reads as the person who asked, on a desk scoped to the sweep', async () => {
    const f = await sweepFixture({ ticketOwner: 'okafor', owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    const projectA = { kind: 'project', project_id: f.projectA };
    for (const [person, scope, desk] of [
      ['ari', MINE, { kind: 'global' }],
      ['ari', { scope: 'record', id: f.record }, projectA],
      ['ari', { scope: 'project', id: f.projectA }, projectA],
      ['okafor', { scope: 'record', id: f.record }, { kind: 'global' }],    // his own item there, in a decision he cannot read
    ] as const) {
      const { run_id } = await f.queueAndStart(person, scope);
      await f.settled(run_id);
      expect(f.runs.readUnfenced(run_id), `${person} ${JSON.stringify(scope)}`).toMatchObject({ state: 'done' });
      const [, , bound, context] = f.bindDesk.mock.calls.at(-1)! as unknown as [unknown, unknown, { readonly access_token: string; readonly scope: unknown }, { readonly request_id: string }];
      expect(bound).toMatchObject({ access_token: person, scope: desk });
      expect(context.request_id.startsWith(`${run_id}_`)).toBe(true);
    }
  });

  it('checks the twenty items checked longest ago, never-checked first', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    const kinds = () => f.findings.at(-1)!.map(finding => (finding.citations[0] as { readonly kind: string }).kind);
    f.check(f.ticket.item_id, 'still_open', 'mina');
    const { run_id } = await f.queueAndStart('ari');
    await f.settled(run_id);
    expect(kinds()).toEqual(['approved_record', 'ticket']);
    f.advance(1_000);
    f.check(f.action.item_id, 'still_open', 'mina');
    const next = await f.queueAndStart('ari');
    await f.settled(next.run_id);
    // Both were checked by now; the ticket longest ago.
    expect(kinds()).toEqual(['ticket', 'approved_record']);
  });

  it('checks at most twenty items at a time; the others wait for the next sweep', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open' } });
    // Twenty more tickets the impact check found, all sent: 22 open items.
    const tickets = Array.from({ length: 20 }, (_, index) => ({ ...f.card.pointers.ticket, ticket_id: String(20_000 + index) }));
    f.db.transaction(() => f.items.insertForRun(f.db, f.runs.readUnfenced(f.runId)!, tickets.map(pointer => ({ item_key: impactItemKeyV1(pointer)!, pointer,
      relation: 'needs_updating' as const, expected: 'launch next week', owner_membership_id: f.membership('mina'), owner_match: 'approver' as const }))))();
    const unsent = f.items.forRun(f.runId).filter(row => row.state === 'unsent');
    expect(f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'send-more', choices: unsent.map(row => ({ item_id: row.item_id, include: true })) })).toMatchObject({ sent: 20 });
    const unchecked = () => f.items.forRun(f.runId).filter(row => row.state === 'open' && row.check === null).map(row => row.item_id);
    const first = await f.queueAndStart('ari');
    await f.settled(first.run_id);
    expect(f.findings.at(-1)).toHaveLength(20);
    const waiting = unchecked();
    expect(waiting).toHaveLength(2);
    f.advance(1_000);
    const next = await f.queueAndStart('ari');
    await f.settled(next.run_id);
    // The two never checked come first; the rest of the twenty are those checked longest ago.
    const pointerKey = (pointer: unknown) => impactItemKeyV1(pointer);
    const keysOf = (itemIds: readonly string[]) => itemIds.map(itemId => f.items.read(itemId)!.item_key).sort();
    expect(f.findings.at(-1)!.slice(0, 2).map(finding => pointerKey(finding.citations[0])).sort()).toEqual(keysOf(waiting));
    expect(unchecked()).toEqual([]);
  });

  it('sweeps an item on a Slack message, which counts toward a due sweep', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'still_open', approved_record: 'still_open', slack_message: 'landed' } });
    // A Slack message the impact check found, sent to Mina.
    const slack = { kind: 'slack_message', team_id: 'T0FIXTURE', channel_id: 'C0FIXTURE', message_ts: '1700000000.000100',
      permalink: 'https://echo-fixture.slack.com/archives/C0FIXTURE/p1700000000000100', text_sha256: canonicalSha256('Slack text') };
    f.db.transaction(() => f.items.insertForRun(f.db, f.runs.readUnfenced(f.runId)!, [{ item_key: impactItemKeyV1(slack)!, pointer: slack,
      relation: 'needs_updating', expected: 'launch next week', owner_membership_id: f.membership('ari'), owner_match: 'approver' }]))();
    const slackItem = f.items.forRun(f.runId).find(row => row.pointer.kind === 'slack_message')!;
    expect(f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'send-2', choices: [{ item_id: slackItem.item_id, include: true, owner_membership_id: f.membership('mina') }] }))
      .toMatchObject({ kind: 'sent', sent: 1 });
    // The ticket and the action were checked just now; only the Slack message never was, and it makes a sweep due.
    f.check(f.ticket.item_id, 'still_open', 'mina');
    f.advance(1_000);
    f.check(f.action.item_id, 'still_open', 'mina');
    expect(await f.sweepDue('ari')).toBe(true);
    const { run_id } = await f.queueAndStart('ari');
    await f.settled(run_id);
    expect(f.findings.at(-1)!.map(finding => (finding.citations[0] as { readonly kind: string }).kind)).toEqual(['slack_message', 'ticket', 'approved_record']);
    expect(f.findings.at(-1)![0]).toMatchObject({ finding: 'Outdated Slack message from Pilot planning', citations: [slack, f.decisionCitation] });
    expect(f.items.read(slackItem.item_id)!.check).toMatchObject({ verdict: 'landed', by: f.membership('ari'), run_id });
    expect(await f.sweepDue('ari')).toBe(false);
    // With only the Slack message open, a sweep still has it to check.
    for (const item of [f.ticket, f.action]) await f.app.set_state({ access_token: 'mina', request: { schema_version: 1, operation: 'set_state', item_id: item.item_id, state: 'done' } });
    expect(runOf(await f.sweep('ari', MINE))).toMatch(/^run_/);
  });
});

describe('sweeps on the runs API', () => {
  it('lists sweeps, has no card to view, and never retries one', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const { run_id } = await f.queueAndStart('ari');
    await f.settled(run_id);
    const { runs } = await f.app.list({ access_token: 'ari' });
    expect(runs.map(run => run.trigger)).toEqual(['sweep', 'approved_record']);
    expect(runs[0]).toMatchObject({ run_id, trigger: 'sweep', event_ref: expect.stringMatching(/^sweep_/), state: 'done', error_code: null });
    expect((await f.app.list({ access_token: 'mina' })).runs).toEqual([]);
    await expect(f.app.view({ access_token: 'ari', request: { schema_version: 1, operation: 'view', run_id } })).rejects.toMatchObject({ code: 'not_found' });
    // A failed sweep stays failed; the next sweep replaces it.
    f.renderSweepsWith(async () => { throw new Error('The model gave up'); });
    const failed = runOf(await f.sweep('ari', MINE));
    await f.start('ari', failed); await f.settled(failed);
    await expect(f.app.retry({ access_token: 'ari', request: { schema_version: 1, operation: 'retry', run_id: failed } })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.runs.readUnfenced(failed)).toMatchObject({ state: 'failed', error_code: 'research_failed' });
    expect(runOf(await f.sweep('ari', MINE))).not.toBe(failed);
    // Another person's sweep is not theirs to start.
    await expect(f.start('mina', failed)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('observes a sweep as it observes an impact check, and a finish that lost its lease as a conflict', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const diagnostics = createPersonDiagnosticsV1({ sessions: f.openItemsOptions.sessions });
    captures.push(diagnostics);
    const runsApp = createPersonTriggerRunsV1({ runs: f.runs, sessions: f.openItemsOptions.sessions, records: f.records, items: f.items, people: f.directory, bindDesk: f.bindDesk as never,
      audit: {} as never, bind_options: { authority_id: 'authority', state_lineage_id: 'lineage', diagnostics } as never, research: f.research as never, lease_ms: 60_000, now: f.clock });
    const captured = async (run_id: string) => {
      const capture = await diagnostics.prepare({ access_token: 'ari', request: { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id } } });
      expect(await runsApp.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id, capture_id: capture.capture_id } })).toEqual({ state: 'running' });
      await f.settled(run_id);
      return diagnostics.read({ access_token: 'ari', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } });
    };
    const run_id = runOf(await f.sweep('ari', MINE));
    expect(await captured(run_id)).toMatchObject({ status: 'completed', trace: { complete: true, events: [
      { kind: 'lifecycle', stage: 'trigger', data: { trigger: 'sweep', run_id, event_id: f.runs.readUnfenced(run_id)!.event_ref } },
      { kind: 'lifecycle', stage: 'persistence', event: 'succeeded' },
      { kind: 'lifecycle', stage: 'application', event: 'succeeded' },
    ] } });
    const lost = runOf(await f.sweep('ari', MINE));
    vi.spyOn(f.runs, 'finish').mockReturnValueOnce(false);
    const failed = await captured(lost);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
    expect(failed.trace!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'persistence', event: 'skipped' }), expect.objectContaining({ stage: 'application', event: 'failed' }),
    ]));
  });

  it('records nothing when the sweeper loses their membership mid-run, and ends without access', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const { run_id } = await f.queueAndStart('mina');
    f.revoke('mina');
    await f.settled(run_id);
    expect(f.runs.readUnfenced(run_id)).toMatchObject({ state: 'failed', error_code: 'no_access', result_json: null });
    expect(f.verdicts()).toEqual([null, null]);
  });

  it('lets a capture read a sweep that found nothing to check, once the session still holds', async () => {
    const f = await sweepFixture({ owner: 'mina' });
    const diagnostics = createPersonDiagnosticsV1({ sessions: f.openItemsOptions.sessions });
    captures.push(diagnostics);
    const runsApp = createPersonTriggerRunsV1({ runs: f.runs, sessions: f.openItemsOptions.sessions, records: f.records, items: f.items, people: f.directory, bindDesk: f.bindDesk as never,
      audit: {} as never, bind_options: { authority_id: 'authority', state_lineage_id: 'lineage', diagnostics } as never, research: f.research as never, lease_ms: 60_000, now: f.clock });
    const run_id = runOf(await f.sweep('ari', MINE));
    for (const item of [f.ticket, f.action]) await f.app.set_state({ access_token: 'mina', request: { schema_version: 1, operation: 'set_state', item_id: item.item_id, state: 'done' } });
    const capture = await diagnostics.prepare({ access_token: 'ari', request: { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id } } });
    const binds = f.bindDesk.mock.calls.length;
    expect(await runsApp.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id, capture_id: capture.capture_id } })).toEqual({ state: 'running' });
    await f.settled(run_id);
    expect(f.bindDesk.mock.calls.length).toBe(binds);
    const read = () => diagnostics.read({ access_token: 'ari', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } });
    expect(await read()).toMatchObject({ status: 'completed', trace: { complete: true, events: [
      { kind: 'lifecycle', stage: 'trigger', data: { trigger: 'sweep', run_id } },
      { kind: 'lifecycle', stage: 'persistence', event: 'succeeded' },
      { kind: 'lifecycle', stage: 'application', event: 'succeeded' },
    ] } });
  });

  it('maps a sweep\'s failures as an impact check\'s', async () => {
    const f = await sweepFixture({ owner: 'mina', verdicts: { ticket: 'landed', approved_record: 'landed' } });
    const attempt = async (failure: () => void) => {
      failure();
      const run_id = runOf(await f.sweep('ari', MINE));
      await f.start('ari', run_id); await f.settled(run_id);
      return f.runs.readUnfenced(run_id)!;
    };
    // The record index is behind the record log: try again later, no attempt counted.
    const lag = vi.spyOn(f.records, 'recordAnchor').mockImplementationOnce(() => { throw new PersonRecordSearchIndexLagV1(); });
    expect(await attempt(() => undefined)).toMatchObject({ state: 'pending', attempts: 0 });
    lag.mockRestore();
    // An outage counts an attempt; a result the contract refuses fails the sweep.
    const pending = f.runs.newestSweep(f.person)!.run_id;
    f.renderSweepsWith(async () => { throw new AuthorityOperationError('unavailable', 'Jira is unavailable'); });
    await f.start('ari', pending); await f.settled(pending);
    expect(f.runs.readUnfenced(pending)).toMatchObject({ state: 'pending', attempts: 1 });
    f.renderSweepsWith(async () => ({ findings: [], status: 'assessed', citations: [] }));
    await f.start('ari', pending); await f.settled(pending);
    expect(f.runs.readUnfenced(pending)).toMatchObject({ state: 'failed', error_code: 'research_failed' });
    // A person whose access to the decision was refused mid-run: no access.
    vi.spyOn(f.records, 'recordAnchor').mockImplementationOnce(() => { throw new AuthorityOperationError('not_found', 'record evidence is not available'); });
    expect(await attempt(() => undefined)).toMatchObject({ state: 'failed', error_code: 'no_access' });
    expect(f.verdicts()).toEqual([null, null]);
  });
});
