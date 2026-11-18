import { describe, expect, it } from 'vitest';
import { PERSON_HOME_ROWS_V1 } from '@echo-brain/organization-api';
import { askFollowUpPointerV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { impactItemKeyV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { addMembership } from './fixtures/project-context-sqlite.js';
import { chatFollowUpsFixture } from './fixtures/chat-follow-ups.js';
import { assign, setState } from './fixtures/open-items.js';

/** Follow-ups from a chat answer (ADR-0053): storage, Home's drafts, who sees them, Send and edit, and their place among run items. */

const SEND_THE_PLAN = { task: 'Send the vendor the pilot plan', owner_name: 'Mina Patel', due_on: '2026-10-20' } as const;

describe('follow-ups from a chat: the sink and the store', () => {
  it('saves each draft once as its asker\'s own unsent follow-up, with no run, no record and its owner matched by name', async () => {
    const f = await chatFollowUpsFixture();
    const [planned, alone] = f.draft('ari', [SEND_THE_PLAN, { task: 'Book the pilot room' }], 'ask-1');
    // Saving the same answer again writes nothing, even with other words: the first save stands.
    f.draft('ari', [{ ...SEND_THE_PLAN, task: 'Something else' }, { task: 'Book the pilot room', owner_name: 'Rafael Moreno' }], 'ask-1');
    const rows = [f.items.read(planned!)!, f.items.read(alone!)!];
    expect(rows.map(row => ({ run_id: row.run_id, record: row.record_sha256, relation: row.relation, expected: row.expected, due_on: row.due_on, state: row.state,
      approver: row.approver.membership_id, owner: row.owner_membership_id, match: row.owner_match, pointer: row.pointer }))).toEqual([
      { run_id: null, record: null, relation: 'needs_updating', expected: 'Send the vendor the pilot plan', due_on: '2026-10-20', state: 'unsent',
        approver: f.membership('ari'), owner: f.membership('mina'), match: 'name', pointer: askFollowUpPointerV1(planned!) },
      // Nobody owns it yet: it stays with its creator.
      { run_id: null, record: null, relation: 'needs_updating', expected: 'Book the pilot room', due_on: null, state: 'unsent',
        approver: f.membership('ari'), owner: f.membership('ari'), match: 'approver', pointer: askFollowUpPointerV1(alone!) },
    ]);
    expect(rows[0]!.item_key).toBe(impactItemKeyV1(askFollowUpPointerV1(planned!)));
    expect(f.db.prepare('SELECT count(*) FROM authority_impact_items_v1').pluck().get()).toBe(2);
  });

  it('gives a follow-up to the one active member with the name, else leaves it with its asker', async () => {
    const f = await chatFollowUpsFixture();
    // A second, revoked-free "Rafael Moreno" makes the name ambiguous.
    const twin = { organization_id: f.person.organization_id, principal_id: 'prn_00000000-0000-4000-8000-0000000ddd41', membership_id: 'mem_00000000-0000-4000-8000-0000000ddd42', membership_type: 'employee' as const };
    addMembership(f.db, twin, 'Rafael Moreno', 'twin@example.test');
    const ids = f.draft('mina', [
      { task: 'One', owner_name: '  mina patel ' }, { task: 'Two', owner_name: 'S. Okafor' }, { task: 'Three', owner_name: 'Rafael Moreno' },
      { task: 'Four', owner_name: 'Mina' }, { task: 'Five', owner_name: '' }, { task: 'Six', owner_name: 'Ari' },
    ]);
    expect(ids.map(id => { const row = f.items.read(id)!; return [row.owner_membership_id, row.owner_match]; })).toEqual([
      [f.membership('mina'), 'name'], [f.membership('okafor'), 'name'], [f.membership('mina'), 'approver'],
      [f.membership('mina'), 'approver'], [f.membership('mina'), 'approver'], [f.membership('ari'), 'name'],
    ]);
    // A revoked member is never matched.
    f.revoke('okafor');
    const [later] = f.draft('mina', [{ task: 'Seven', owner_name: 'S. Okafor' }]);
    expect(f.items.read(later!)).toMatchObject({ owner_membership_id: f.membership('mina'), owner_match: 'approver' });
  });

  it('points at the one item it is about when that pointer names an item, else at itself', async () => {
    const f = await chatFollowUpsFixture();
    const [onTicket, noKey, meeting] = f.draft('ari', [
      { task: 'Update the ticket', about: f.ticket }, { task: 'No key', about: { kind: 'ticket', tool_id: 'jira' } },
      { task: 'A meeting action is no item to be about', about: { kind: 'meeting_action', record_sha256: f.record, signal_id: 'a1' } },
    ]);
    expect(f.items.read(onTicket!)).toMatchObject({ pointer: f.ticket, item_key: impactItemKeyV1(f.ticket) });
    expect(f.items.read(noKey!)!.pointer).toEqual(askFollowUpPointerV1(noKey!));
    expect(f.items.read(meeting!)!.pointer).toEqual(askFollowUpPointerV1(meeting!));
  });

  it('saves all of an answer\'s drafts or none', async () => {
    const f = await chatFollowUpsFixture();
    expect(() => f.draft('ari', [{ task: 'Fine' }, { task: 'x'.repeat(121) }])).toThrow(/CHECK/u);
    expect(() => f.draft('ari', [{ task: 'Fine' }, { task: 'Bad day', due_on: '2026-02-30' }])).toThrow(/CHECK/u);
    expect(f.db.prepare('SELECT count(*) FROM authority_impact_items_v1').pluck().get()).toBe(0);
  });

  it('keeps a run item\'s line fixed, gives it no due date, and never lets it lose its run', async () => {
    const f = await chatFollowUpsFixture();
    await f.finishImpactRun();
    const row = f.items.forRun(f.runId)[0]!;
    const update = (set: string, ...values: unknown[]) => f.db.prepare(`UPDATE authority_impact_items_v1 SET ${set} WHERE item_id = ?`).run(...values, row.item_id);
    expect(() => update('expected = ?', 'other words')).toThrow('identity is immutable');
    expect(() => update('due_on = ?', '2026-10-20')).toThrow(/CHECK|immutable/u);
    expect(() => update('run_id = NULL')).toThrow(/CHECK|immutable/u);
    expect(() => update('run_id = NULL, record_sha256 = NULL')).toThrow(/CHECK|identity is immutable/u);
    expect(() => update('record_sha256 = NULL')).toThrow(/CHECK|immutable/u);
    // A run item cannot start without its run's record, nor be stored with a due date.
    expect(f.items.edit(row.item_id, { expected: 'other words' })).toBeUndefined();
    expect(f.items.read(row.item_id)).toEqual(row);
    // The store's send of one item ignores it, and the run's own Send ignores chat rows.
    expect(f.items.sendItem({ item_id: row.item_id, by: f.membership('ari'), command_id: 'c1', include: true })).toEqual({ kind: 'missing' });
  });
});

describe('follow-ups from a chat: Home and who sees them', () => {
  it("lists the creator's unsent ones as Home's drafts, newest first, with the right to edit and send them", async () => {
    const f = await chatFollowUpsFixture();
    const [first] = f.draft('ari', [SEND_THE_PLAN]);
    f.advance(1_000);
    const [second] = f.draft('ari', [{ task: 'Update the ticket', about: f.ticket }]);
    f.draft('mina', [{ task: 'Mina\'s own' }]);
    const home = await f.app.home({ access_token: 'ari' });
    expect(home.send).toEqual([]);
    expect(home.items).toEqual([]);
    expect(home.drafts.map(entry => entry.item_id)).toEqual([second, first]);
    expect(home.drafts[1]).toMatchObject({
      run_id: null, kind: 'action', relation: 'needs_updating', expected: 'Send the vendor the pilot plan', due_on: '2026-10-20', state: 'unsent',
      approver: { membership_id: f.membership('ari'), name: 'Ari' }, owner: { membership_id: f.membership('mina'), name: 'Mina Patel', match: 'name' },
      waits_on: 'approver', send_included: null, can: { set_state: false, assign: true, edit: true, send: true }, reach: 'not_read',
    });
    expect(home.drafts[1]).not.toHaveProperty('decision');
    // The draft about a ticket reads that ticket live, as the creator.
    expect(home.drafts[0]).toMatchObject({ kind: 'ticket', reach: 'opened', current: { assignee: 'Mina Patel' } });
    // Rows only: no live read.
    expect((await f.app.home({ access_token: 'ari', request: { schema_version: 1, operation: 'home', read: 'rows' } })).drafts.map(entry => entry.reach)).toEqual(['not_read', 'not_read']);
    // Nobody else sees them, the matched owner included.
    expect((await f.app.home({ access_token: 'mina' })).drafts.map(entry => entry.expected)).toEqual(['Mina\'s own']);
    expect((await f.app.home({ access_token: 'rafael' })).drafts).toEqual([]);
  });

  it(`shows at most ${String(PERSON_HOME_ROWS_V1)} drafts, the newest, and leaves sent ones out`, async () => {
    const f = await chatFollowUpsFixture();
    const ids: string[] = [];
    for (let index = 0; index < PERSON_HOME_ROWS_V1 + 2; index += 1) { ids.push(...f.draft('ari', [{ task: `Task ${String(index)}` }])); f.advance(1_000); }
    await f.sendItem('ari', ids.at(-1)!, false);
    const drafts = (await f.app.home({ access_token: 'ari' })).drafts.map(entry => entry.item_id);
    expect(drafts).toEqual(ids.slice(0, -1).reverse().slice(0, PERSON_HOME_ROWS_V1));
  });

  it('shows a follow-up to its owner only once it is sent to them, and to nobody else ever', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [SEND_THE_PLAN]);
    for (const name of ['mina', 'rafael', 'okafor'] as const) {
      await expect(f.item(name, id!)).rejects.toMatchObject({ code: 'not_found' });
      expect((await f.mine(name)).items).toEqual([]);
      expect((await f.app.items({ access_token: name, request: { schema_version: 1, operation: 'items', scope: 'involved' } })).items).toEqual([]);
    }
    expect((await f.mine('ari')).items.map(entry => entry.item_id)).toEqual([id]);
    await expect(f.sendItem('ari', id!, true)).resolves.toEqual({ state: 'open' });
    const seen = await f.item('mina', id!);
    expect(seen).toMatchObject({ state: 'open', waits_on: 'owner', send_included: true, can: { set_state: true, assign: true, edit: false, send: false } });
    expect(seen).not.toHaveProperty('decision');
    expect((await f.app.home({ access_token: 'mina' })).items.map(entry => entry.item_id)).toEqual([id]);
    // The creator still sees it, and it waits on someone else for them.
    expect(await f.item('ari', id!)).toMatchObject({ can: { set_state: true, assign: true, edit: true, send: false } });
    expect((await f.app.home({ access_token: 'ari' })).waiting).toBe(1);
    // A project lead, a decision reader or anyone else never sees it.
    for (const name of ['rafael', 'okafor'] as const) await expect(f.item(name, id!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never puts a follow-up from a chat in a run, a record or a project, nor counts it as a decision or a stage', async () => {
    const f = await chatFollowUpsFixture();
    await f.finishImpactRun();
    f.draft('ari', [SEND_THE_PLAN, { task: 'Book the pilot room' }]);
    const runItems = (await f.runItems()).items;
    expect(runItems.length).toBeGreaterThan(0);
    expect(runItems.every(entry => entry.run_id === f.runId)).toBe(true);
    const record = await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
    const project = await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'project', id: f.projectA } });
    for (const scoped of [record, project]) expect(scoped.items.map(entry => entry.run_id)).not.toContain(null);
    const mine = await f.mine('ari');
    expect(mine.items.filter(entry => entry.run_id === null)).toHaveLength(2);
    expect(mine.summary.unsent).toBe(runItems.length + 2);
    expect(mine.summary.decisions).toBe(1);
    expect(mine.summary.by_decision).toEqual([{ record_sha256: f.record, unsent: runItems.length, open: 0 }]);
    expect(mine.stages.map(stage => stage.record_sha256)).toEqual([f.record]);
    // The run's Send row counts its own items only.
    expect((await f.app.home({ access_token: 'ari' })).send).toMatchObject([{ run_id: f.runId, items: runItems.length }]);
    // With only chat rows, a summary names no decision and no stage.
    const g = await chatFollowUpsFixture();
    g.draft('ari', [SEND_THE_PLAN]);
    expect(await g.mine('ari')).toMatchObject({ summary: { unsent: 1, decisions: 0, by_decision: [] }, stages: [] });
  });
});

describe('follow-ups from a chat: Send, edit, close and hand on', () => {
  it('lets only its creator send it, never while nobody owns it, with an owner pick', async () => {
    const f = await chatFollowUpsFixture();
    const [owned, unowned] = f.draft('ari', [SEND_THE_PLAN, { task: 'Book the pilot room' }]);
    // Its matched owner, or anyone else, cannot send it: to them it is not there.
    for (const name of ['mina', 'rafael', 'okafor'] as const) await expect(f.sendItem(name, owned!, true)).rejects.toMatchObject({ code: 'not_found' });
    // Nobody owns it yet: pick one first.
    await expect(f.sendItem('ari', unowned!, true)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.items.read(unowned!)!.state).toBe('unsent');
    // A pick must be an active member.
    f.revoke('okafor');
    await expect(f.sendItem('ari', unowned!, true, { owner: 'okafor' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.sendItem('ari', unowned!, true, { owner: 'rafael' })).resolves.toEqual({ state: 'open' });
    expect(f.items.read(unowned!)).toMatchObject({ owner_membership_id: f.membership('rafael'), owner_match: 'picked', owner_set_by: f.membership('ari'), send_included: true });
    expect(await f.item('rafael', unowned!)).toMatchObject({ state: 'open', owner: { match: 'picked' } });
    // A run's items are not sent this way.
    await f.finishImpactRun();
    await expect(f.sendItem('ari', f.items.forRun(f.runId)[0]!.item_id, true)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('dismisses a follow-up its owner then never sees, and answers a repeated command with its first result', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [SEND_THE_PLAN]);
    await expect(f.sendItem('ari', id!, false, { command_id: 'dismiss-1' })).resolves.toEqual({ state: 'not_relevant' });
    await expect(f.item('mina', id!)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.item('ari', id!)).toMatchObject({ state: 'not_relevant', send_included: false, can: { set_state: false, assign: false, edit: false, send: false } });
    // The same command again answers what it did; another one, or the other choice under it, is a conflict.
    await expect(f.sendItem('ari', id!, false, { command_id: 'dismiss-1' })).resolves.toEqual({ state: 'not_relevant' });
    await expect(f.sendItem('ari', id!, true, { command_id: 'dismiss-1' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.sendItem('ari', id!, true, { command_id: 'send-2' })).rejects.toMatchObject({ code: 'conflict' });
    // A replay answers even after the item changed since.
    const [sent] = f.draft('ari', [SEND_THE_PLAN]);
    await f.sendItem('ari', sent!, true, { command_id: 'send-3' });
    await setState(f, 'mina', sent!, 'done');
    await expect(f.sendItem('ari', sent!, true, { command_id: 'send-3' })).resolves.toEqual({ state: 'open' });
    expect(f.items.read(sent!)!.state).toBe('done');
  });

  it('lets its creator change its line and due date until it is closed, and nobody else ever', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [SEND_THE_PLAN]);
    await expect(f.edit('ari', id!, { expected: 'Send the vendor the final plan' })).resolves.toEqual({ expected: 'Send the vendor the final plan', due_on: '2026-10-20' });
    await expect(f.edit('ari', id!, { due_on: null })).resolves.toEqual({ expected: 'Send the vendor the final plan', due_on: null });
    await expect(f.edit('ari', id!, { expected: 'Send the plan', due_on: '2026-11-02' })).resolves.toEqual({ expected: 'Send the plan', due_on: '2026-11-02' });
    for (const name of ['mina', 'rafael', 'okafor'] as const) await expect(f.edit(name, id!, { expected: 'Mine now' })).rejects.toMatchObject({ code: 'not_found' });
    await f.sendItem('ari', id!, true);
    // Sent, its owner sees the change and still cannot make one.
    await f.edit('ari', id!, { expected: 'Send the signed plan' });
    expect(await f.item('mina', id!)).toMatchObject({ expected: 'Send the signed plan', due_on: '2026-11-02' });
    await expect(f.edit('mina', id!, { due_on: '2026-12-01' })).rejects.toMatchObject({ code: 'not_found' });
    // Closed, it cannot change; reopened, it can again.
    await setState(f, 'mina', id!, 'done');
    await expect(f.edit('ari', id!, { expected: 'Too late' })).rejects.toMatchObject({ code: 'conflict' });
    await setState(f, 'ari', id!, 'open');
    await expect(f.edit('ari', id!, { expected: 'Not too late' })).resolves.toMatchObject({ expected: 'Not too late' });
    // A run's item is never edited.
    await f.finishImpactRun();
    await expect(f.edit('ari', f.items.forRun(f.runId)[0]!.item_id, { expected: 'Mine now' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is closed, reopened and handed on like any follow-up once sent, and never before', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [SEND_THE_PLAN]);
    // Before Send its creator picks its owner and sets no state.
    await expect(setState(f, 'ari', id!, 'done')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(assign(f, 'mina', id!, 'rafael')).rejects.toMatchObject({ code: 'not_found' });
    await expect(assign(f, 'ari', id!, 'rafael')).resolves.toMatchObject({ owner: { membership_id: f.membership('rafael') } });
    expect(f.items.read(id!)).toMatchObject({ owner_match: 'picked', state: 'unsent' });
    await f.sendItem('ari', id!, true);
    // Its owner hands it on: the new owner sees it, the old one no longer does.
    await expect(assign(f, 'rafael', id!, 'okafor')).resolves.toMatchObject({ owner: { membership_id: f.membership('okafor') } });
    await expect(f.item('rafael', id!)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.item('okafor', id!)).toMatchObject({ owner: { match: 'reassigned' }, can: { set_state: true, assign: true, edit: false, send: false } });
    await expect(setState(f, 'okafor', id!, 'done')).resolves.toEqual({ state: 'done' });
    expect(await f.item('ari', id!)).toMatchObject({ state: 'done', state_set_by: { membership_id: f.membership('okafor') }, can: { edit: false } });
  });
});

describe('follow-ups from a chat: review fixes', () => {
  it('keeps a dismissed draft final and its creator\'s alone: never closed, reopened or handed on, never shown to its owner', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [SEND_THE_PLAN]);
    await f.sendItem('ari', id!, false);
    expect(await f.item('ari', id!)).toMatchObject({ state: 'not_relevant', send_included: false, can: { set_state: false, assign: false, edit: false, send: false } });
    for (const state of ['done', 'open'] as const) await expect(setState(f, 'ari', id!, state)).rejects.toMatchObject({ code: 'conflict' });
    await expect(assign(f, 'ari', id!, 'rafael')).rejects.toMatchObject({ code: 'conflict' });
    expect(f.items.read(id!)).toMatchObject({ state: 'not_relevant', owner_membership_id: f.membership('mina'), state_set_by: f.membership('ari') });
    // Even a row the store moved on is never its owner's: it was never sent to them.
    f.items.setState(id!, 'done', f.membership('ari'));
    await expect(f.item('mina', id!)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.mine('mina')).items).toEqual([]);
    expect((await f.app.home({ access_token: 'mina' })).items).toEqual([]);
    await expect(setState(f, 'mina', id!, 'open')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('still lets an approver reopen a run item Send dismissed, handing it to its owner', async () => {
    const f = await chatFollowUpsFixture();
    await f.finishImpactRun();
    const ticket = (await f.runItems()).items.find(entry => entry.kind === 'ticket')!;
    await f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'send-1', items: [{ item_id: ticket.item_id, include: false }] } });
    await expect(setState(f, 'ari', ticket.item_id, 'open')).resolves.toEqual({ state: 'open' });
    expect(await f.item('mina', ticket.item_id)).toMatchObject({ state: 'open', send_included: false });
  });

  it("builds Home's Send rows from run items only, however many chat drafts name the caller", async () => {
    const f = await chatFollowUpsFixture();
    // Mina's answer drafted more follow-ups for Ari than Home reads at once; Ari cannot see any of them.
    f.draft('mina', Array.from({ length: 1001 }, (_, index) => ({ task: `Task ${String(index)}`, owner_name: 'Ari' })));
    f.advance(1_000);
    await f.finishImpactRun();
    const home = await f.app.home({ access_token: 'ari' });
    expect(home.send.map(row => row.run_id)).toEqual([f.runId]);
    expect(home.drafts).toEqual([]);
    expect((await f.app.home({ access_token: 'mina' })).drafts).toHaveLength(PERSON_HOME_ROWS_V1);
  });

  it('refuses to send a follow-up to an owner who is no longer a member', async () => {
    const f = await chatFollowUpsFixture();
    const [id] = f.draft('ari', [{ task: 'Book the pilot room', owner_name: 'Rafael Moreno' }]);
    f.revoke('rafael');
    await expect(f.sendItem('ari', id!, true)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.items.read(id!)!.state).toBe('unsent');
    // Dismissing needs no owner; picking an active one sends it.
    await expect(f.sendItem('ari', id!, true, { owner: 'mina' })).resolves.toEqual({ state: 'open' });
    const [other] = f.draft('ari', [{ task: 'Another', owner_name: 'Rafael Moreno' }]);
    await expect(f.sendItem('ari', other!, false)).resolves.toEqual({ state: 'not_relevant' });
  });
});
