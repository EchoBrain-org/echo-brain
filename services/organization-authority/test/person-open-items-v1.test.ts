import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonOpenItemV1 } from '@echo-brain/organization-api';
import { CLOUD, openItemsFixture, sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

const scope = (f: OpenItemsFixtureV1, access_token: FixturePerson, kind: 'mine' | 'run' | 'record' | 'project', cursor?: string) => f.app.items({ access_token, request: {
  schema_version: 1, operation: 'items', scope: kind, ...(kind === 'mine' ? {} : { id: kind === 'run' ? f.runId : kind === 'record' ? f.record : f.projectA }), ...(cursor === undefined ? {} : { cursor }),
} });
const setState = (f: OpenItemsFixtureV1, access_token: FixturePerson, item_id: string, state: 'open' | 'done' | 'not_relevant') =>
  f.app.set_state({ access_token, request: { schema_version: 1, operation: 'set_state', item_id, state } });
const assign = (f: OpenItemsFixtureV1, access_token: FixturePerson, item_id: string, owner: FixturePerson) =>
  f.app.assign({ access_token, request: { schema_version: 1, operation: 'assign', item_id, owner_membership_id: f.membership(owner) } });
const item = (f: OpenItemsFixtureV1, access_token: FixturePerson, item_id: string) => f.app.item({ access_token, request: { schema_version: 1, operation: 'item', item_id } });
const sendAll = (f: OpenItemsFixtureV1, unsent: readonly PersonOpenItemV1[], command_id: string, choose: (item: PersonOpenItemV1) => { readonly include: boolean; readonly owner_membership_id?: string }) =>
  f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id, items: unsent.map(entry => ({ item_id: entry.item_id, ...choose(entry) })) } });

describe('open items: who sees what', () => {
  it('shows unsent items to decision readers, the decision only to readers, and live parts only to those who can open them', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const mina = await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
    expect(mina.items).toHaveLength(2);
    expect(mina.items.every(item => item.state === 'unsent' && item.decision?.title === 'Pilot planning')).toBe(true);
    const rafael = await f.app.items({ access_token: 'rafael', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
    expect(rafael.items.find(item => item.kind === 'ticket')).not.toHaveProperty('current');   // the desk refuses Rafael this ticket
    expect(JSON.stringify(rafael)).not.toContain('ECHO-12');                                   // no title, permalink or citation leaks
    expect(JSON.stringify(rafael)).not.toContain(f.outsideText);
    expect(JSON.stringify(rafael)).not.toContain('acct-');                                     // nor the Jira account matched at finish
    const okafor = await f.app.items({ access_token: 'okafor', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
    expect(okafor.items).toEqual([]);
  });

  it('builds each row from ECHO data, and the live details only from a fresh open as the viewer', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const { items } = await scope(f, 'mina', 'run');
    const ticket = items.find(entry => entry.kind === 'ticket')!;
    expect(ticket).toMatchObject({
      run_id: f.runId, relation: 'needs_updating', expected: 'launch next week', state: 'unsent', waits_on: 'approver', sent_at: null, state_set_at: null, check: null,
      approver: { membership_id: f.membership('ari'), name: 'Ari', active: true },
      owner: { membership_id: f.membership('mina'), name: 'Mina Patel', active: true, match: 'jira_account' },
      decision: { approval_id: f.approvalId, record_sha256: f.record, title: 'Pilot planning', first_line: 'The pilot starts next week.', project_ids: [f.projectA] },
      current: { says_now: `${f.outsideText} ships on Oct 30.`, assignee: 'Mina Patel', status: 'In Progress', due_at: '2026-10-30', citation: { kind: 'ticket', label: `ECHO-12 ${f.outsideText}` } },
      can: { set_state: false, assign: false },                           // Send picks the owner; nothing changes it before
    });
    expect(items.find(entry => entry.kind === 'record')).toMatchObject({ owner: { name: 'Ari', match: 'approver' }, current: { says_now: 'Start the pilot after the freeze.', assignee: 'Nobody Here' } });
    // One desk for the request, bound to the viewer, revalidated after the opens; each item opened once.
    expect(f.bindDesk.mock.calls.at(-1)![2]).toMatchObject({ access_token: 'mina', scope: { kind: 'global' } });
    expect(f.opened.filter(open => open.token === 'mina').map(open => open.kind).sort()).toEqual(['approved_record', 'ticket']);
    expect(f.revalidated).toContain('mina');
  });

  it('pages a scope oldest first, and counts the whole visible scope', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const first = await scope(f, 'ari', 'project');
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeNull();
    expect(first.summary).toEqual({ unsent: 2, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 1, last_checked_at: null,
      by_decision: [{ record_sha256: f.record, unsent: 2, open: 0 }] });
    expect(first.stages).toEqual([{ record_sha256: f.record, run_id: f.runId, state: 'done', error_code: null }]);
    // Page by page with a cursor: the same rows, in the same order.
    const ordered = [...first.items].map(entry => entry.item_id);
    const byCodePoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
    expect(ordered).toEqual([...first.items].sort((left, right) => byCodePoint(left.created_at, right.created_at) || byCodePoint(left.item_id, right.item_id)).map(entry => entry.item_id));
    const page = await f.openItemsApp.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'mine' } });
    expect(page.items.map(entry => entry.item_id)).toEqual(ordered);
    const cursor = Buffer.from(`${first.items[0]!.created_at}|${first.items[0]!.item_id}`, 'utf8').toString('base64url');
    expect((await scope(f, 'ari', 'mine', cursor)).items.map(entry => entry.item_id)).toEqual(ordered.slice(1));
    await expect(scope(f, 'ari', 'mine', 'bm90LWEtY3Vyc29y')).rejects.toMatchObject({ code: 'invalid_request' });
    // Someone outside project A sees no row, no count and no stage.
    expect(await scope(f, 'okafor', 'project')).toEqual({ items: [], next_cursor: null, summary: { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] }, stages: [] });
    expect((await scope(f, 'okafor', 'run')).stages).toEqual([]);
  });

  it('pages fifty rows at a time, with at most fifty live opens a call', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const run = f.runs.read(f.person, f.runId)!;
    f.advance(1_000);
    // More rows than any one card makes, straight into the store: the page bound is the service's.
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 53 }, (_, index) => ({
      item_key: canonicalSha256(`extra ${index}`), relation: 'conflicts' as const, expected: 'launch next week', owner_membership_id: f.membership('ari'), owner_match: 'approver' as const,
      pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(20_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${100 + index}`, text_sha256: canonicalSha256(`extra text ${index}`) },
    }))))();
    const opens = f.opened.length;
    const first = await scope(f, 'mina', 'record');
    expect(first.items).toHaveLength(50);
    expect(f.opened.length - opens).toBe(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await scope(f, 'mina', 'record', first.next_cursor!);
    expect(second.items).toHaveLength(5);
    expect(second.next_cursor).toBeNull();
    expect([...first.items, ...second.items].map(entry => entry.item_id)).toEqual(f.items.forRun(f.runId).map(row => row.item_id));
    expect(second.summary).toEqual(first.summary);
    expect(first.summary).toMatchObject({ unsent: 55, decisions: 1, by_decision: [{ record_sha256: f.record, unsent: 55, open: 0 }] });
  });

  it('shows a decision reader the impact stage before the check finishes', async () => {
    const f = await openItemsFixture();
    expect(await scope(f, 'mina', 'record')).toMatchObject({ items: [], stages: [{ record_sha256: f.record, run_id: f.runId, state: 'pending', error_code: null }] });
    expect((await scope(f, 'okafor', 'record')).stages).toEqual([]);
  });

  it('shows rows without live parts when the desk cannot vouch for a read', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const live = async () => (await scope(f, 'mina', 'run')).items.filter(entry => entry.current !== undefined).map(entry => entry.kind).sort();
    expect(await live()).toEqual(['record', 'ticket']);
    const wrongItem = { id: 'desk-other', citation: { kind: 'approved_record', atom_id: `sha256:${'b'.repeat(64)}`, record_sha256: `sha256:${'c'.repeat(64)}`, policy_id: 'project-members-readable-person-v1' },
      kind: 'decision', label: 'Another meeting', visibility: 'team', text: 'Something else.', receipt_sha256: `sha256:${'d'.repeat(64)}` };
    const desk = (overrides: Record<string, unknown>) => async () => ({ openCitation: async () => ({ items: [wrongItem], truncated: false, receipt_digests: [] }), revalidate: async () => ({}), ...overrides });
    // A read of anything but the item itself is not a read of the item.
    f.bindDesk.mockImplementationOnce(desk({}) as never);
    expect(await live()).toEqual([]);
    // Nothing read in a request whose desk fails its final check is shown.
    const fixtureDesk = f.bindDesk.getMockImplementation()!;
    f.bindDesk.mockImplementationOnce((async (...args: Parameters<typeof fixtureDesk>) => ({ ...(await fixtureDesk(...args)), revalidate: async () => { throw new Error('access changed'); } })) as never);
    expect(await live()).toEqual([]);
    // A desk that cannot be bound leaves every row in place, with no live part.
    f.bindDesk.mockImplementationOnce((async () => { throw new Error('Jira is unavailable'); }) as never);
    const unbound = await scope(f, 'mina', 'run');
    expect(unbound.items).toHaveLength(2);
    expect(unbound.items.some(entry => entry.current !== undefined)).toBe(false);
    expect(await live()).toEqual(['record', 'ticket']);
  });

  it('keeps an odd member name or live value from failing a response', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    f.db.prepare('UPDATE authority_principals SET display_name=? WHERE principal_id=?').run('  Mina Patel \t', f.people.mina.principal_id);
    const fixtureDesk = f.bindDesk.getMockImplementation()!;
    const oddTicket = (patch: (item: Record<string, unknown>) => Record<string, unknown>) => f.bindDesk.mockImplementationOnce((async (...args: Parameters<typeof fixtureDesk>) => {
      const desk = await fixtureDesk(...args);
      return { ...desk, async openCitation(input: Parameters<typeof desk.openCitation>[0]) {
        const result = await desk.openCitation(input);
        return { ...result, items: result.items.map(item => ((item as { kind: string }).kind === 'ticket' ? patch(item as Record<string, unknown>) : item)) };
      } };
    }) as never);
    oddTicket(item => ({ ...item, attributes: { owner: ' Mina\nPatel ', status: 'In Progress', due_at: ' ' } }));
    const ticket = (await scope(f, 'ari', 'run')).items.find(entry => entry.kind === 'ticket')!;
    expect(ticket.owner.name).toBe('Mina Patel');
    expect(ticket.current).toMatchObject({ assignee: 'Mina Patel', status: 'In Progress' });
    expect(ticket.current).not.toHaveProperty('due_at');
    // A title the API cannot carry leaves the row without its live part.
    oddTicket(item => ({ ...item, label: 'x'.repeat(2000) }));
    const untitled = (await scope(f, 'ari', 'run')).items.find(entry => entry.kind === 'ticket')!;
    expect(untitled).not.toHaveProperty('current');
    expect(untitled.owner.name).toBe('Mina Patel');
  });

  it('answers one item rebuilt for the viewer, and not_found to anyone who cannot see it', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const [ticket] = (await scope(f, 'ari', 'run')).items.filter(entry => entry.kind === 'ticket');
    await expect(item(f, 'rafael', ticket!.item_id)).resolves.toMatchObject({ item: { item_id: ticket!.item_id, decision: { title: 'Pilot planning' } } });
    expect((await item(f, 'rafael', ticket!.item_id)).item).not.toHaveProperty('current');
    await expect(item(f, 'okafor', ticket!.item_id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(item(f, 'ari', 'itm_00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('open items: send, update, reassign', () => {
  it('sends once, refuses a stale card, and gives the owner an Update row they can close', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'run', id: f.runId } })).items;
    const send = { schema_version: 1 as const, operation: 'send' as const, run_id: f.runId, command_id: 'c1',
      items: unsent.map(item => ({ item_id: item.item_id, include: true, ...(item.owner.match === 'approver' ? { owner_membership_id: f.okaforMembership } : {}) })) };
    await expect(f.app.send({ access_token: 'ari', request: send })).resolves.toEqual({ sent: 2, not_relevant: 0 });
    await expect(f.app.send({ access_token: 'ari', request: send })).resolves.toEqual({ sent: 2, not_relevant: 0 });
    await expect(f.app.send({ access_token: 'ari', request: { ...send, command_id: 'c2' } })).rejects.toMatchObject({ code: 'stale_access_state' });
    const okaforHome = await f.app.home({ access_token: 'okafor' });
    expect(okaforHome.items).toHaveLength(1);
    expect(okaforHome.items[0]).not.toHaveProperty('decision');       // Okafor cannot read the decision; only Send told them
    expect(okaforHome.items[0]).toMatchObject({ expected: 'pilot starts next week', approver: { name: 'Ari' }, owner: { name: 'S. Okafor', match: 'picked' }, waits_on: 'owner', can: { set_state: true, assign: true } });
    await f.app.set_state({ access_token: 'okafor', request: { schema_version: 1, operation: 'set_state', item_id: okaforHome.items[0]!.item_id, state: 'done' } });
    expect((await f.app.home({ access_token: 'okafor' })).items).toEqual([]);
    // Mina, the matched ticket owner, has hers on Home.
    expect((await f.app.home({ access_token: 'mina' })).items.map(entry => entry.kind)).toEqual(['ticket']);
  });

  it('refuses a send that is not the caller\'s own finished run, or a pick who is not an active member', async () => {
    const f = await openItemsFixture();
    const pending = { schema_version: 1 as const, operation: 'send' as const, run_id: f.runId, command_id: 'c1', items: [{ item_id: 'itm_00000000-0000-4000-8000-000000000000', include: true }] };
    await expect(f.app.send({ access_token: 'ari', request: pending })).rejects.toMatchObject({ code: 'not_found' });
    await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    await expect(f.app.send({ access_token: 'mina', request: { ...pending, items: unsent.map(entry => ({ item_id: entry.item_id, include: true })) } })).rejects.toMatchObject({ code: 'not_found' });
    f.revoke('rafael');
    await expect(sendAll(f, unsent, 'c1', entry => ({ include: true, ...(entry.kind === 'record' ? { owner_membership_id: f.membership('rafael') } : {}) })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    // An approver who can no longer read the decision cannot send it.
    f.removeProjectMembership(f.projectA);
    await expect(sendAll(f, unsent, 'c1', () => ({ include: true }))).rejects.toMatchObject({ code: 'not_found' });
    expect(f.items.forRun(f.runId).map(row => row.state)).toEqual(['unsent', 'unsent']);
  });

  it('lets only the approver or the owner change state, and a project lead reassign', async () => {
    const f = await sentFixture();
    const ticket = f.ticket.item_id;                                       // sent to Mina, its matched owner
    await expect(setState(f, 'rafael', ticket, 'done')).rejects.toMatchObject({ code: 'not_found' });   // a reader, not its owner
    await expect(setState(f, 'okafor', ticket, 'done')).rejects.toMatchObject({ code: 'not_found' });   // cannot see it
    await expect(assign(f, 'rafael', ticket, 'rafael')).rejects.toMatchObject({ code: 'not_found' });
    await expect(setState(f, 'mina', ticket, 'done')).resolves.toEqual({ state: 'done' });
    await expect(setState(f, 'ari', ticket, 'open')).resolves.toEqual({ state: 'open' });            // the approver may reopen it
    f.makeLead('rafael');
    await expect(assign(f, 'rafael', ticket, 'okafor')).resolves.toEqual({ owner: { membership_id: f.okaforMembership, name: 'S. Okafor', active: true } });
    expect(f.items.read(ticket)).toMatchObject({ owner_membership_id: f.okaforMembership, owner_match: 'reassigned' });
    expect(f.db.prepare('SELECT owner_set_by FROM authority_impact_items_v1 WHERE item_id=?').pluck().get(ticket)).toBe(f.membership('rafael'));
    expect((await f.app.home({ access_token: 'okafor' })).items.map(entry => entry.item_id)).toEqual([ticket]);
    await expect(assign(f, 'ari', ticket, 'mina')).resolves.toMatchObject({ owner: { name: 'Mina Patel' } });
    // A new owner must be an active member.
    f.revoke('okafor');
    await expect(assign(f, 'ari', ticket, 'okafor')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('asks the approver to send an item before closing it, and tells no one else it exists', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const [ticket] = (await scope(f, 'ari', 'run')).items.filter(entry => entry.kind === 'ticket');
    await expect(setState(f, 'ari', ticket!.item_id, 'done')).rejects.toMatchObject({ code: 'invalid_request', message: 'Send it first' });
    await expect(setState(f, 'mina', ticket!.item_id, 'done')).rejects.toMatchObject({ code: 'invalid_request', message: 'Send it first' });   // its owner, who reads the decision
    await expect(setState(f, 'rafael', ticket!.item_id, 'done')).rejects.toMatchObject({ code: 'not_found' });
    await expect(setState(f, 'okafor', ticket!.item_id, 'done')).rejects.toMatchObject({ code: 'not_found' });
    await expect(assign(f, 'ari', ticket!.item_id, 'rafael')).rejects.toMatchObject({ code: 'invalid_request', message: 'Send it first' });
    expect(f.items.read(ticket!.item_id)).toMatchObject({ state: 'unsent', owner_match: 'jira_account' });
  });

  it('hides an unticked item from an owner who cannot read the decision, and keeps one sent then closed (R13)', async () => {
    const unticked = await openItemsFixture({ ticketOwner: 'okafor' }); await unticked.finishImpactRun();
    const unsent = (await scope(unticked, 'ari', 'run')).items;
    await expect(sendAll(unticked, unsent, 'c1', entry => ({ include: entry.kind !== 'ticket' }))).resolves.toEqual({ sent: 1, not_relevant: 1 });
    const hidden = unsent.find(entry => entry.kind === 'ticket')!.item_id;
    expect(unticked.items.read(hidden)).toMatchObject({ state: 'not_relevant', owner_membership_id: unticked.okaforMembership });
    expect((await scope(unticked, 'okafor', 'mine')).items).toEqual([]);
    await expect(item(unticked, 'okafor', hidden)).rejects.toMatchObject({ code: 'not_found' });
    // Marking it not relevant again changes nothing, so it stays unsent to its owner.
    unticked.advance(5_000);
    await expect(setState(unticked, 'ari', hidden, 'not_relevant')).resolves.toEqual({ state: 'not_relevant' });
    expect((await scope(unticked, 'okafor', 'mine')).items).toEqual([]);

    const closed = await sentFixture({ ticketOwner: 'okafor' });
    expect((await scope(closed, 'okafor', 'mine')).items.map(entry => entry.item_id)).toEqual([closed.ticket.item_id]);
    await expect(setState(closed, 'ari', closed.ticket.item_id, 'not_relevant')).resolves.toEqual({ state: 'not_relevant' });
    expect((await scope(closed, 'okafor', 'mine')).items).toMatchObject([{ item_id: closed.ticket.item_id, state: 'not_relevant' }]);
    expect((await item(closed, 'okafor', closed.ticket.item_id)).item).not.toHaveProperty('decision');
  });
});

describe('open items: Home', () => {
  it('lists Send rows only to the approver and counts what waits on others', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const home = await f.app.home({ access_token: 'ari' });
    expect(home.send).toEqual([{ run_id: f.runId, decision: { approval_id: f.approvalId, record_sha256: f.record, title: 'Pilot planning', first_line: 'The pilot starts next week.',
      approved_at: '2026-10-07T09:00:00.000Z', project_ids: [f.projectA] }, items: 2, kinds: ['ticket', 'record'], owners: ['Mina Patel'], finished_at: f.runs.read(f.person, f.runId)!.updated_at }]);
    expect(home).toMatchObject({ items: [], landed: 0, waiting: 0, last_checked_at: null });
    expect((await f.app.home({ access_token: 'mina' })).send).toEqual([]);
    const unsent = (await scope(f, 'ari', 'run')).items;
    await sendAll(f, unsent, 'c1', () => ({ include: true }));
    const after = await f.app.home({ access_token: 'ari' });
    expect(after.send).toEqual([]);
    expect(after.waiting).toBe(1);                                         // the ticket waits on Mina
    expect(after.items.map(entry => [entry.kind, entry.waits_on])).toEqual([['record', 'owner']]);   // Ari owns the action
  });

  it('makes no Send row, and binds no desk, when there is nothing to send', async () => {
    const f = await openItemsFixture();
    expect(await f.app.home({ access_token: 'ari' })).toEqual({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null });
    expect(f.bindDesk).not.toHaveBeenCalled();
  });

  it('moves an item to the approver when the owner leaves, and to the project leads when both leave', async () => {
    const f = await sentFixture({ owner: 'mina', untickAction: true });
    f.revoke('mina');
    expect((await f.app.home({ access_token: 'ari' })).items.map(item => item.waits_on)).toEqual(['approver']);
    f.revoke('ari'); f.makeLead('rafael');
    expect((await f.app.home({ access_token: 'rafael' })).items.map(item => item.waits_on)).toEqual(['leads']);
    expect((await f.app.home({ access_token: 'rafael' })).items[0]).toMatchObject({ approver: { name: 'Ari', active: false }, owner: { name: 'Mina Patel', active: false }, can: { set_state: false, assign: true } });
  });

  it('shows the approver a changed item, puts changed items first, and counts what landed', async () => {
    const f = await sentFixture({ owner: 'mina' });
    f.check(f.ticket.item_id, 'landed');
    f.advance(60_000);
    f.check(f.action.item_id, 'changed', 'mina');
    const ari = await f.app.home({ access_token: 'ari' });
    expect(ari.items.map(entry => entry.item_id)).toEqual([f.action.item_id]);
    expect(ari.items[0]!.check).toEqual({ verdict: 'changed', checked_at: f.clock().toISOString(), checked_by: 'Mina Patel' });
    expect(ari).toMatchObject({ landed: 1, waiting: 2, last_checked_at: f.clock().toISOString() });
    const mina = await f.app.home({ access_token: 'mina' });
    expect(mina.items.map(entry => entry.item_id)).toEqual([f.action.item_id, f.ticket.item_id]);
    expect(mina).toMatchObject({ landed: 1, waiting: 0 });
    expect((await f.app.home({ access_token: 'okafor' }))).toEqual({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null });
  });
});
