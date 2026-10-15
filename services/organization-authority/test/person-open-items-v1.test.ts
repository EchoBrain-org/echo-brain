import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonOpenItemV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonOpenItemsV1 } from '../src/composition/person-open-items-v1.js';
import { CLOUD, openItemsFixture, sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';
import { addMembership } from './fixtures/project-context-sqlite.js';

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
    expect(rafael.items.find(item => item.kind === 'ticket')).toMatchObject({ reach: 'no_access' });
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
      state_set_by: null, owner_set_at: null, owner_set_by: null, send_included: null,
      approver: { membership_id: f.membership('ari'), name: 'Ari', active: true },
      owner: { membership_id: f.membership('mina'), name: 'Mina Patel', active: true, match: 'jira_account' },
      decision: { approval_id: f.approvalId, record_sha256: f.record, title: 'Pilot planning', first_line: 'The pilot starts next week.', project_ids: [f.projectA] },
      current: { says_now: `${f.outsideText} ships on Oct 30.`, assignee: 'Mina Patel', status: 'In Progress', due_at: '2026-10-30', citation: { kind: 'ticket', label: `ECHO-12 ${f.outsideText}` } },
      reach: 'opened',
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
      by_decision: [{ record_sha256: f.record, unsent: 2, open: 0, landed: 0, unreadable: 0 }] });
    expect(first.stages).toEqual([{ record_sha256: f.record, run_id: f.runId, state: 'done', error_code: null, mine: true }]);
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
    expect(first.summary).toMatchObject({ unsent: 55, decisions: 1, by_decision: [{ record_sha256: f.record, unsent: 55, open: 0, landed: 0, unreadable: 0 }] });
  });

  it('shows a decision reader the impact stage before the check finishes', async () => {
    const f = await openItemsFixture();
    expect(await scope(f, 'mina', 'record')).toMatchObject({ items: [], stages: [{ record_sha256: f.record, run_id: f.runId, state: 'pending', error_code: null }] });
    expect((await scope(f, 'okafor', 'record')).stages).toEqual([]);
    // A project's page shows the stage of every decision the reader reads there, items or none.
    expect(await scope(f, 'mina', 'project')).toMatchObject({ items: [], stages: [{ record_sha256: f.record, run_id: f.runId, state: 'pending', error_code: null }] });
    expect((await scope(f, 'okafor', 'project')).stages).toEqual([]);
  });

  it("says whose impact check a stage is: the approver's own, and no other reader's", async () => {
    const f = await openItemsFixture();
    const stages = async (access_token: FixturePerson, summary_only?: true) => (await f.app.items({ access_token, request: {
      schema_version: 1, operation: 'items', scope: 'record', id: f.record, ...(summary_only === undefined ? {} : { summary_only }) } })).stages;
    expect(await stages('ari')).toEqual([{ record_sha256: f.record, run_id: f.runId, state: 'pending', error_code: null, mine: true }]);
    expect(await stages('mina')).toEqual([{ record_sha256: f.record, run_id: f.runId, state: 'pending', error_code: null, mine: false }]);
    await f.finishImpactRun();
    // The Impact line reads counts only: Ari may Send, Mina only sees the check.
    expect((await stages('ari', true)).map(stage => [stage.state, stage.mine])).toEqual([['done', true]]);
    expect((await stages('mina', true)).map(stage => [stage.state, stage.mine])).toEqual([['done', false]]);
    expect((await stages('rafael')).map(stage => stage.mine)).toEqual([false]);
  });

  it('shows rows without live parts when the desk cannot vouch for a read', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const reaches = async () => Object.fromEntries((await scope(f, 'mina', 'run')).items.map(entry => [entry.kind, entry.reach]));
    const live = async () => (await scope(f, 'mina', 'run')).items.filter(entry => entry.current !== undefined).map(entry => entry.kind).sort();
    expect(await live()).toEqual(['record', 'ticket']);
    const wrongItem = { id: 'desk-other', citation: { kind: 'approved_record', atom_id: `sha256:${'b'.repeat(64)}`, record_sha256: `sha256:${'c'.repeat(64)}`, policy_id: 'project-members-readable-person-v1' },
      kind: 'decision', label: 'Another meeting', visibility: 'team', text: 'Something else.', receipt_sha256: `sha256:${'d'.repeat(64)}` };
    const desk = (overrides: Record<string, unknown>) => async () => ({ openCitation: async () => ({ items: [wrongItem], truncated: false, receipt_digests: [] }), revalidate: async () => ({}), ...overrides });
    // A read of anything but the item itself is not a read of the item: the desk did not release it to this viewer.
    f.bindDesk.mockImplementationOnce(desk({}) as never);
    expect(await reaches()).toEqual({ ticket: 'no_access', record: 'no_access' });
    expect(f.liveFailures).toEqual([]);
    // Nothing read in a request whose desk fails its final check is shown, and nothing blames access for it.
    const fixtureDesk = f.bindDesk.getMockImplementation()!;
    f.bindDesk.mockImplementationOnce((async (...args: Parameters<typeof fixtureDesk>) => ({ ...(await fixtureDesk(...args)), revalidate: async () => { throw new Error('access changed'); } })) as never);
    expect(await reaches()).toEqual({ ticket: 'unavailable', record: 'unavailable' });
    expect(f.liveFailures).toEqual([{ kind: 'open_items_live_read', reason: 'fence', code: 'error' }]);
    // A desk that cannot be bound leaves every row in place, with no live part: ECHO could not read them just now.
    f.bindDesk.mockImplementationOnce((async () => { throw new AuthorityOperationError('unavailable', 'Jira is unavailable'); }) as never);
    const unbound = await scope(f, 'mina', 'run');
    expect(unbound.items).toHaveLength(2);
    expect(unbound.items.some(entry => entry.current !== undefined)).toBe(false);
    expect(unbound.items.map(entry => entry.reach)).toEqual(['unavailable', 'unavailable']);
    expect(f.liveFailures.at(-1)).toEqual({ kind: 'open_items_live_read', reason: 'bind', code: 'unavailable' });
    expect(f.liveFailures).toHaveLength(2);
    expect(await live()).toEqual(['record', 'ticket']);
    expect(await reaches()).toEqual({ ticket: 'opened', record: 'opened' });
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
    // A title the API cannot carry leaves the row without its live part: read, but not in a form ECHO can show.
    oddTicket(item => ({ ...item, label: 'x'.repeat(2000) }));
    const untitled = (await scope(f, 'ari', 'run')).items.find(entry => entry.kind === 'ticket')!;
    expect(untitled).not.toHaveProperty('current');
    expect(untitled.reach).toBe('unavailable');
    expect(untitled.owner.name).toBe('Mina Patel');
    expect(f.liveFailures).toEqual([{ kind: 'open_items_live_read', reason: 'open', code: 'invalid_output' }]);
  });

  it('answers one item rebuilt for the viewer, and not_found to anyone who cannot see it', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const [ticket] = (await scope(f, 'ari', 'run')).items.filter(entry => entry.kind === 'ticket');
    await expect(item(f, 'rafael', ticket!.item_id)).resolves.toMatchObject({ item: { item_id: ticket!.item_id, decision: { title: 'Pilot planning' }, reach: 'no_access' } });
    expect((await item(f, 'rafael', ticket!.item_id)).item).not.toHaveProperty('current');
    await expect(item(f, 'okafor', ticket!.item_id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(item(f, 'ari', 'itm_00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('open items: counts and live reads', () => {
  it('answers counts without a single live read', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const opens = f.openCitation.mock.calls.length;
    const binds = f.bindDesk.mock.calls.length;
    const result = await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'project', id: f.projectA, summary_only: true } });
    expect(result).toMatchObject({ items: [], next_cursor: null, summary: { unsent: 2 } });
    // The same counts and stages a full read answers.
    const full = await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'project', id: f.projectA } });
    expect(result.summary).toEqual(full.summary);
    expect(result.stages).toEqual(full.stages);
    expect(f.openCitation.mock.calls.length - opens).toBe(2);              // only the full read opened anything
    expect(f.bindDesk.mock.calls.length - binds).toBe(1);
    await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record, summary_only: true } });
    expect(f.openCitation.mock.calls.length - opens).toBe(2);
    expect(f.bindDesk.mock.calls.length - binds).toBe(1);
  });

  it('pages the items in some states only past older ones in others, opens only those, and still counts the whole scope (R51)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const run = f.runs.read(f.person, f.runId)!;
    const ticketAt = (name: string, index: number) => ({
      item_key: canonicalSha256(`${name} ${index}`), relation: 'conflicts' as const, expected: 'launch next week', owner_membership_id: f.membership('ari'), owner_match: 'approver' as const,
      pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(30_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${300 + index}`, text_sha256: canonicalSha256(`${name} text ${index}`) },
    });
    // Sixty closed items, older than every open one: the check's two and 58 more, half done and half not relevant.
    f.advance(1_000);
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 58 }, (_, index) => ticketAt('closed', index))))();
    const closed = f.items.forRun(f.runId);
    expect(closed).toHaveLength(60);
    expect(f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'close', choices: closed.map((row, index) => ({ item_id: row.item_id, include: index % 2 === 0 })) }))
      .toMatchObject({ kind: 'sent', sent: 30, not_relevant: 30 });
    for (const [index, row] of closed.entries()) if (index % 2 === 0) expect(f.items.setState(row.item_id, 'done', f.membership('ari'))?.state).toBe('done');
    // A closed item's last check counts nowhere.
    f.check(closed[0]!.item_id, 'landed');
    // Then three open ones: one landed, one ECHO could not read, one still open.
    f.advance(1_000);
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 3 }, (_, index) => ticketAt('open', index))))();
    const open = f.items.forRun(f.runId).filter(row => row.state === 'unsent');
    f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'open', choices: open.map(row => ({ item_id: row.item_id, include: true })) });
    f.check(open[0]!.item_id, 'landed');
    f.check(open[1]!.item_id, 'unreadable');
    f.check(open[2]!.item_id, 'still_open');
    const ids = (page: { readonly items: readonly PersonOpenItemV1[] }) => page.items.map(entry => entry.item_id);

    const opens = f.opened.length;
    const binds = f.bindDesk.mock.calls.length;
    const request = { schema_version: 1, operation: 'items', scope: 'project', id: f.projectA, states: ['unsent', 'open'] } as const;
    const first = await f.app.items({ access_token: 'ari', request });
    expect(ids(first)).toEqual(open.map(row => row.item_id));
    expect(first.next_cursor).toBeNull();
    // Only those three were opened live, on one desk.
    expect(f.opened.length - opens).toBe(3);
    expect(f.bindDesk.mock.calls.length - binds).toBe(1);
    // The summary still counts the closed items, and each decision says how many of its open items landed or went unread.
    expect(first.summary).toEqual({ unsent: 0, open: 3, done: 30, not_relevant: 30, landed: 1, changed: 0, unreadable: 1, decisions: 1, last_checked_at: f.clock().toISOString(),
      by_decision: [{ record_sha256: f.record, unsent: 0, open: 3, landed: 1, unreadable: 1 }] });
    // As a read of every state does, whose first page holds no open item at all.
    const all = await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'project', id: f.projectA } });
    expect(all.items).toHaveLength(50);
    expect(all.items.some(entry => entry.state === 'open')).toBe(false);
    expect(first.summary).toEqual(all.summary);
    expect(first.stages).toEqual(all.stages);
    // A cursor pages the same filtered items.
    const after = Buffer.from(`${first.items[0]!.created_at}|${first.items[0]!.item_id}`, 'utf8').toString('base64url');
    expect(ids(await f.app.items({ access_token: 'ari', request: { ...request, cursor: after } }))).toEqual(open.slice(1).map(row => row.item_id));
    // Every scope keeps the states asked for only.
    for (const scope of [{ scope: 'mine' }, { scope: 'run', id: f.runId }, { scope: 'record', id: f.record }] as const) {
      expect(ids(await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', ...scope, states: ['open'] } }))).toEqual(open.map(row => row.item_id));
    }
    // The closed part pages on its own, fifty at a time, with its own cursor over the closed items alone.
    const closedRequest = { schema_version: 1, operation: 'items', scope: 'record', id: f.record, states: ['done', 'not_relevant'] } as const;
    const closedFirst = await f.app.items({ access_token: 'ari', request: closedRequest });
    expect(closedFirst.items).toHaveLength(50);
    expect(closedFirst.items.every(entry => entry.state === 'done' || entry.state === 'not_relevant')).toBe(true);
    const closedNext = await f.app.items({ access_token: 'ari', request: { ...closedRequest, cursor: closedFirst.next_cursor! } });
    expect(closedNext.next_cursor).toBeNull();
    expect(ids(closedFirst).concat(ids(closedNext))).toEqual(closed.map(row => row.item_id));
    expect(closedNext.summary).toEqual(first.summary);
    // Done alone is a subset too.
    expect((await f.app.items({ access_token: 'ari', request: { ...closedRequest, states: ['done'] } })).items.map(entry => entry.state)).toEqual(Array(30).fill('done'));
  });

  it('tells an outage from lost access, and reports the outage without content', async () => {
    const failures: unknown[] = [];
    const f = await openItemsFixture({ on_live_failure: event => failures.push(event), openFails: { ticket: new AuthorityOperationError('rate_limited', 'slow down') } });
    await f.finishImpactRun();
    const items = (await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } })).items;
    expect(items.find(item => item.kind === 'ticket')).toMatchObject({ reach: 'unavailable' });
    expect(items.find(item => item.kind === 'ticket')).not.toHaveProperty('current');
    expect(items.find(item => item.kind === 'record')).toMatchObject({ reach: 'opened', current: { says_now: 'Start the pilot after the freeze.' } });
    expect(failures).toEqual([{ kind: 'open_items_live_read', reason: 'open', code: 'rate_limited' }]);
    const rafael = (await f.app.items({ access_token: 'rafael', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } })).items;
    expect(rafael.find(item => item.kind === 'ticket')).toMatchObject({ reach: 'no_access' });
    expect(failures).toHaveLength(1);                                       // a refusal is not an outage
  });

  // A refusal by the viewer's own access is no_access; anything else says nothing about access, and is reported without content.
  it.each([
    { name: 'unauthorized', error: new AuthorityOperationError('unauthorized', 'refused'), reach: 'no_access', code: null },
    { name: 'not_found', error: new AuthorityOperationError('not_found', 'refused'), reach: 'no_access', code: null },
    { name: 'stale_access_state', error: new AuthorityOperationError('stale_access_state', 'refused'), reach: 'no_access', code: null },
    { name: 'rate_limited', error: new AuthorityOperationError('rate_limited', 'slow down'), reach: 'unavailable', code: 'rate_limited' },
    { name: 'unavailable', error: new AuthorityOperationError('unavailable', 'down'), reach: 'unavailable', code: 'unavailable' },
    { name: 'a timeout', error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), reach: 'unavailable', code: 'error' },
    { name: 'a plain Error', error: new Error('ECHO-12 Kestrel cooling fan drift 0xC0FFEE failed'), reach: 'unavailable', code: 'error' },
  ] as const)('reads $name from the desk as $reach', async ({ error, reach, code }) => {
    const f = await openItemsFixture({ openFails: { ticket: error } }); await f.finishImpactRun();
    const ticket = (await scope(f, 'mina', 'run')).items.find(entry => entry.kind === 'ticket')!;
    expect(ticket.reach).toBe(reach);
    expect(ticket).not.toHaveProperty('current');
    expect(f.liveFailures).toEqual(code === null ? [] : [{ kind: 'open_items_live_read', reason: 'open', code }]);
  });

  it('logs a failed live read by default as one line of JSON, without an id, a title or the tool\'s words', async () => {
    const f = await openItemsFixture({ openFails: { ticket: new AuthorityOperationError('unavailable', `ECHO-12 ${'Kestrel cooling fan drift 0xC0FFEE'} timed out`) } });
    await f.finishImpactRun();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createPersonOpenItemsV1({ ...f.openItemsOptions, on_live_failure: undefined });
      const { items } = await app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'run', id: f.runId } });
      expect(items.find(item => item.kind === 'ticket')).toMatchObject({ reach: 'unavailable' });
      expect(logged.mock.calls).toEqual([[JSON.stringify({ kind: 'open_items_live_read', reason: 'open', code: 'unavailable' })]]);
    } finally {
      logged.mockRestore();
    }
  });

  it('reports a stored card it cannot read, and shows the decision without its first line', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const runs = new Proxy(f.runs, { get(target, property, receiver) {
      if (property === 'readUnfenced') return (runId: string) => {
        const row = target.readUnfenced(runId);
        return row === undefined ? undefined : { ...row, result_json: '{' };
      };
      return Reflect.get(target, property, receiver);
    } });
    const app = createPersonOpenItemsV1({ ...f.openItemsOptions, runs });
    const { items } = await app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'run', id: f.runId } });
    expect(items.map(entry => entry.decision?.first_line)).toEqual([null, null]);
    expect(items.map(entry => entry.reach)).toEqual(['opened', 'opened']);
    expect(f.liveFailures).toEqual([{ kind: 'open_items_live_read', reason: 'first_line', code: 'unavailable' }]);
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
    // A card drawn before its items were sent: a conflict to open again, never a sign the account lost access.
    await expect(f.app.send({ access_token: 'ari', request: { ...send, command_id: 'c2' } })).rejects.toMatchObject({ code: 'conflict', message: 'The items changed. Open them again.' });
    const okaforHome = await f.app.home({ access_token: 'okafor' });
    expect(okaforHome.items).toHaveLength(1);
    expect(okaforHome.items[0]).not.toHaveProperty('decision');       // Okafor cannot read the decision; only Send told them
    expect(okaforHome.items[0]).toMatchObject({ expected: 'pilot starts next week', approver: { name: 'Ari' }, owner: { name: 'S. Okafor', match: 'picked' }, waits_on: 'owner', can: { set_state: true, assign: true } });
    await f.app.set_state({ access_token: 'okafor', request: { schema_version: 1, operation: 'set_state', item_id: okaforHome.items[0]!.item_id, state: 'done' } });
    expect((await f.app.home({ access_token: 'okafor' })).items).toEqual([]);
    // Mina, the matched ticket owner, has hers on Home.
    expect((await f.app.home({ access_token: 'mina' })).items.map(entry => entry.kind)).toEqual(['ticket']);
  });

  it('sends the items it lists, dismisses the ones it unticks, and leaves the rest for a later send (F1)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const ticket = unsent.find(entry => entry.kind === 'ticket')!;
    const action = unsent.find(entry => entry.kind === 'record')!;
    const send = (command_id: string, items: readonly { readonly item_id: string; readonly include: boolean }[]) =>
      f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id, items } });
    await expect(send('c1', [{ item_id: ticket.item_id, include: true }])).resolves.toEqual({ sent: 1, not_relevant: 0 });
    await expect(send('c1', [{ item_id: ticket.item_id, include: true }])).resolves.toEqual({ sent: 1, not_relevant: 0 });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'unsent', sent_at: null });
    // The Send row stays, with what is left to send; the ticket is Mina's now.
    expect((await f.app.home({ access_token: 'ari' })).send).toMatchObject([{ run_id: f.runId, items: 1, kinds: ['record'], owners: [] }]);
    expect((await f.app.home({ access_token: 'mina' })).items.map(entry => entry.item_id)).toEqual([ticket.item_id]);
    // A send that lists the ticket again is stale: it was sent meanwhile. Nothing is written.
    await expect(send('c2', [{ item_id: ticket.item_id, include: false }, { item_id: action.item_id, include: false }])).rejects.toMatchObject({ code: 'conflict' });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'unsent' });
    await expect(send('c2', [{ item_id: action.item_id, include: false }])).resolves.toEqual({ sent: 0, not_relevant: 1 });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'not_relevant', send_included: false, state_set_by: f.membership('ari') });
    expect((await f.app.home({ access_token: 'ari' })).send).toEqual([]);
    await expect(send('c3', [{ item_id: action.item_id, include: true }])).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a sent command id reused for other items as a conflict, and replays an exact retry', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const ticket = unsent.find(entry => entry.kind === 'ticket')!;
    const action = unsent.find(entry => entry.kind === 'record')!;
    const send = (items: readonly { readonly item_id: string; readonly include: boolean }[]) =>
      f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'c1', items } });
    await expect(send([{ item_id: ticket.item_id, include: true }])).resolves.toEqual({ sent: 1, not_relevant: 0 });
    // The same command id for the action, or for both: the old answer would leave the action unsent while saying it was handled.
    await expect(send([{ item_id: action.item_id, include: true }])).rejects.toMatchObject({ code: 'conflict', message: 'The items changed. Open them again.' });
    await expect(send([{ item_id: ticket.item_id, include: true }, { item_id: action.item_id, include: true }])).rejects.toMatchObject({ code: 'conflict' });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'unsent', send_command_id: null });
    // An exact retry still answers what it did, even once the approver can no longer read the decision; another list never does.
    f.removeProjectMembership(f.projectA);
    await expect(send([{ item_id: ticket.item_id, include: false }])).resolves.toEqual({ sent: 1, not_relevant: 0 });
    await expect(send([{ item_id: action.item_id, include: false }])).rejects.toMatchObject({ code: 'conflict' });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'unsent' });
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

  it('answers a replayed send with its counts even after the picked owner left', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const choose = (entry: PersonOpenItemV1) => ({ include: true, ...(entry.kind === 'record' ? { owner_membership_id: f.membership('rafael') } : {}) });
    await expect(sendAll(f, unsent, 'c1', choose)).resolves.toEqual({ sent: 2, not_relevant: 0 });
    // The picked owner leaves, then the approver can no longer read the decision: a retry of the sent command still answers what it did.
    f.revoke('rafael');
    await expect(sendAll(f, unsent, 'c1', choose)).resolves.toEqual({ sent: 2, not_relevant: 0 });
    f.removeProjectMembership(f.projectA);
    await expect(sendAll(f, unsent, 'c1', choose)).resolves.toEqual({ sent: 2, not_relevant: 0 });
    // Only the caller's own run replays; a new command goes through every check.
    await expect(f.app.send({ access_token: 'mina', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'c1', items: unsent.map(entry => ({ item_id: entry.item_id, include: true })) } }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(sendAll(f, unsent, 'c2', () => ({ include: true }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('says who set each item\'s state and owner, and when, and what Send did with it (F3)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const ticket = unsent.find(entry => entry.kind === 'ticket')!;
    const action = unsent.find(entry => entry.kind === 'record')!;
    f.advance(1_000);
    await assign(f, 'ari', action.item_id, 'rafael');
    const pickedAt = f.clock().toISOString();
    f.advance(1_000);
    await sendAll(f, unsent, 'c1', entry => ({ include: entry.kind === 'ticket' }));
    const sentAt = f.clock().toISOString();
    const ari = { membership_id: f.membership('ari'), name: 'Ari', active: true };
    const read = async (access_token: FixturePerson, itemId: string) => (await item(f, access_token, itemId)).item;
    expect(await read('ari', ticket.item_id)).toMatchObject({ state: 'open', state_set_at: sentAt, state_set_by: ari, owner_set_at: null, owner_set_by: null, send_included: true });
    // Dismissed at Send: it never reached Rafael, who was picked before Send.
    expect(await read('ari', action.item_id)).toMatchObject({ state: 'not_relevant', state_set_by: ari, owner_set_at: pickedAt, owner_set_by: ari, send_included: false,
      owner: { name: 'Rafael Moreno', match: 'picked' } });
    // Mina closes her ticket, then Ari reassigns it to Rafael: each says who and when, and the owner sees it too.
    f.advance(1_000);
    await setState(f, 'mina', ticket.item_id, 'done');
    const doneAt = f.clock().toISOString();
    f.advance(1_000);
    await assign(f, 'ari', ticket.item_id, 'rafael');
    const reassignedAt = f.clock().toISOString();
    expect(await read('rafael', ticket.item_id)).toMatchObject({ state: 'done', state_set_at: doneAt, state_set_by: { membership_id: f.membership('mina'), name: 'Mina Patel', active: true },
      owner_set_at: reassignedAt, owner_set_by: ari, owner: { name: 'Rafael Moreno', match: 'reassigned' }, send_included: true });
    // Who acted stays named after they leave; reopening the dismissed item hands it to its owner, and Send's choice stays as it
    // was made.
    f.revoke('mina');
    expect((await read('ari', ticket.item_id)).state_set_by).toEqual({ membership_id: f.membership('mina'), name: 'Mina Patel', active: false });
    f.advance(1_000);
    await setState(f, 'ari', action.item_id, 'open');
    expect(await read('ari', action.item_id)).toMatchObject({ state: 'open', send_included: false, state_set_by: ari, sent_at: sentAt, state_set_at: f.clock().toISOString() });
    expect(await read('rafael', action.item_id)).toMatchObject({ state: 'open', send_included: false, owner: { name: 'Rafael Moreno' } });
  });

  it('writes nothing when an item is assigned to its current owner', async () => {
    const f = await sentFixture();
    const ticket = f.ticket.item_id;                                       // Mina's, matched by her Jira account
    const before = f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(ticket);
    f.advance(5_000);
    await expect(assign(f, 'ari', ticket, 'mina')).resolves.toEqual({ owner: { membership_id: f.membership('mina'), name: 'Mina Patel', active: true } });
    expect(f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(ticket)).toEqual(before);
    expect(f.items.read(ticket)).toMatchObject({ owner_membership_id: f.membership('mina'), owner_match: 'jira_account' });
    expect(f.db.prepare('SELECT owner_set_by FROM authority_impact_items_v1 WHERE item_id=?').pluck().get(ticket)).toBeNull();
    // Someone who may not reassign it learns nothing more than before.
    await expect(assign(f, 'rafael', ticket, 'mina')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replays Send with its original counts after an owner marks an item not relevant', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const choose = () => ({ include: true });
    await expect(sendAll(f, unsent, 'c1', choose)).resolves.toEqual({ sent: 2, not_relevant: 0 });
    const ticket = unsent.find(entry => entry.kind === 'ticket')!;
    await expect(setState(f, 'mina', ticket.item_id, 'not_relevant')).resolves.toEqual({ state: 'not_relevant' });
    await expect(sendAll(f, unsent, 'c1', choose)).resolves.toEqual({ sent: 2, not_relevant: 0 });
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
    // Before Send only the approver picks an owner: its owner or a project lead may reassign it once it is sent.
    await expect(assign(f, 'mina', ticket!.item_id, 'rafael')).rejects.toMatchObject({ code: 'invalid_request', message: 'Send it first' });
    f.makeLead('rafael');
    await expect(assign(f, 'rafael', ticket!.item_id, 'rafael')).rejects.toMatchObject({ code: 'invalid_request', message: 'Send it first' });
    await expect(assign(f, 'okafor', ticket!.item_id, 'okafor')).rejects.toMatchObject({ code: 'not_found' });
    expect(f.items.read(ticket!.item_id)).toMatchObject({ state: 'unsent', owner_match: 'jira_account' });
  });

  it('lets the approver pick an owner before sending, stored at once, and kept by Send (F2)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const ticket = unsent.find(entry => entry.kind === 'ticket')!;          // Mina's, matched by her Jira account
    expect(ticket.can).toEqual({ set_state: false, assign: true });
    expect(unsent.find(entry => entry.kind === 'record')!.can).toEqual({ set_state: false, assign: true });
    f.advance(5_000);
    await expect(assign(f, 'ari', ticket.item_id, 'rafael')).resolves.toEqual({ owner: { membership_id: f.membership('rafael'), name: 'Rafael Moreno', active: true } });
    expect(f.items.read(ticket.item_id)).toMatchObject({ state: 'unsent', owner_membership_id: f.membership('rafael'), owner_match: 'picked', sent_at: null });
    expect(f.db.prepare('SELECT owner_set_by, owner_set_at FROM authority_impact_items_v1 WHERE item_id=?').get(ticket.item_id))
      .toEqual({ owner_set_by: f.membership('ari'), owner_set_at: f.clock().toISOString() });
    // Its new owner again writes nothing.
    const before = f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(ticket.item_id);
    f.advance(5_000);
    await expect(assign(f, 'ari', ticket.item_id, 'rafael')).resolves.toMatchObject({ owner: { name: 'Rafael Moreno' } });
    expect(f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(ticket.item_id)).toEqual(before);
    // The Send row names the picked owner; the item still waits on its approver, and nobody but readers sees it.
    expect((await f.app.home({ access_token: 'ari' })).send).toMatchObject([{ run_id: f.runId, items: 2, owners: ['Rafael Moreno'] }]);
    expect((await f.app.home({ access_token: 'rafael' })).items).toEqual([]);
    expect((await scope(f, 'ari', 'run')).items.find(entry => entry.item_id === ticket.item_id)).toMatchObject({ state: 'unsent', waits_on: 'approver', owner: { name: 'Rafael Moreno', match: 'picked' } });
    // An owner who is not an active member is refused, and nothing changes.
    f.revoke('okafor');
    await expect(assign(f, 'ari', ticket.item_id, 'okafor')).rejects.toMatchObject({ code: 'invalid_request' });
    // Send with no pick sends it to the picked owner.
    await expect(sendAll(f, unsent, 'c1', () => ({ include: true }))).resolves.toEqual({ sent: 2, not_relevant: 0 });
    expect(f.items.read(ticket.item_id)).toMatchObject({ state: 'open', owner_membership_id: f.membership('rafael'), owner_match: 'picked' });
    expect((await f.app.home({ access_token: 'rafael' })).items.map(entry => entry.item_id)).toEqual([ticket.item_id]);
    // Once sent, a change of owner is a reassignment, as before.
    await expect(assign(f, 'ari', ticket.item_id, 'mina')).resolves.toMatchObject({ owner: { name: 'Mina Patel' } });
    expect(f.items.read(ticket.item_id)).toMatchObject({ owner_membership_id: f.membership('mina'), owner_match: 'reassigned' });
  });

  it('lets the approver take an item ECHO gave them for want of a match, so it no longer asks for an owner (F2)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const action = (await scope(f, 'ari', 'run')).items.find(entry => entry.kind === 'record')!;   // no member is named Nobody Here
    expect(action.owner).toMatchObject({ membership_id: f.membership('ari'), match: 'approver' });
    f.advance(5_000);
    await expect(assign(f, 'ari', action.item_id, 'ari')).resolves.toEqual({ owner: { membership_id: f.membership('ari'), name: 'Ari', active: true } });
    const ari = { membership_id: f.membership('ari'), name: 'Ari', active: true };
    expect((await item(f, 'ari', action.item_id)).item).toMatchObject({ state: 'unsent', owner: { ...ari, match: 'picked' }, owner_set_by: ari, owner_set_at: f.clock().toISOString() });
    // Picked now: picking them again writes nothing, and Send keeps it.
    const before = f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(action.item_id);
    f.advance(5_000);
    await expect(assign(f, 'ari', action.item_id, 'ari')).resolves.toEqual({ owner: ari });
    expect(f.db.prepare('SELECT * FROM authority_impact_items_v1 WHERE item_id=?').get(action.item_id)).toEqual(before);
    await expect(f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'c1', items: [{ item_id: action.item_id, include: true }] } }))
      .resolves.toEqual({ sent: 1, not_relevant: 0 });
    expect(f.items.read(action.item_id)).toMatchObject({ state: 'open', owner_membership_id: f.membership('ari'), owner_match: 'picked' });
  });

  it('takes the approver ECHO fell back to as picked at Send, and as reassigned once sent (F2)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    f.advance(1_000);
    await expect(sendAll(f, unsent, 'c1', entry => ({ include: true, ...(entry.kind === 'record' ? { owner_membership_id: f.membership('ari') } : {}) })))
      .resolves.toEqual({ sent: 2, not_relevant: 0 });
    const action = unsent.find(entry => entry.kind === 'record')!.item_id;
    expect(f.items.read(action)).toMatchObject({ state: 'open', owner_membership_id: f.membership('ari'), owner_match: 'picked', owner_set_by: f.membership('ari'), owner_set_at: f.clock().toISOString() });
    // Sent with no pick, it still reads as the fallback; taking it afterwards is a reassignment to the same person.
    const sent = await sentFixture();
    expect(sent.items.read(sent.action.item_id)).toMatchObject({ state: 'open', owner_membership_id: sent.membership('ari'), owner_match: 'approver', owner_set_by: null });
    await expect(assign(sent, 'ari', sent.action.item_id, 'ari')).resolves.toMatchObject({ owner: { name: 'Ari' } });
    expect(sent.items.read(sent.action.item_id)).toMatchObject({ owner_membership_id: sent.membership('ari'), owner_match: 'reassigned', owner_set_by: sent.membership('ari'), owner_set_at: sent.clock().toISOString() });
  });

  it('refuses an owner pick before Send to an approver who can no longer read the decision', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const ticket = (await scope(f, 'ari', 'run')).items.find(entry => entry.kind === 'ticket')!;
    f.removeProjectMembership(f.projectA);
    await expect(assign(f, 'ari', ticket.item_id, 'rafael')).rejects.toMatchObject({ code: 'not_found' });
    expect(f.items.read(ticket.item_id)).toMatchObject({ owner_membership_id: f.membership('mina'), owner_match: 'jira_account' });
  });

  it('hides an unticked item from an owner who cannot read the decision until it is reopened, and keeps one sent then closed (R13, R54)', async () => {
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
    // The approver reopens it: it now waits on its owner, who sees it, though Send left it out (R54).
    await expect(setState(unticked, 'ari', hidden, 'open')).resolves.toEqual({ state: 'open' });
    expect((await unticked.app.home({ access_token: 'okafor' })).items).toMatchObject([{ item_id: hidden, state: 'open', waits_on: 'owner' }]);
    expect((await scope(unticked, 'okafor', 'mine')).items.map(entry => entry.item_id)).toEqual([hidden]);
    expect((await item(unticked, 'okafor', hidden)).item).not.toHaveProperty('decision');

    const closed = await sentFixture({ ticketOwner: 'okafor' });
    expect((await scope(closed, 'okafor', 'mine')).items.map(entry => entry.item_id)).toEqual([closed.ticket.item_id]);
    await expect(setState(closed, 'ari', closed.ticket.item_id, 'not_relevant')).resolves.toEqual({ state: 'not_relevant' });
    expect((await scope(closed, 'okafor', 'mine')).items).toMatchObject([{ item_id: closed.ticket.item_id, state: 'not_relevant' }]);
    expect((await item(closed, 'okafor', closed.ticket.item_id)).item).not.toHaveProperty('decision');
  });
});

describe('open items: meeting actions (follow-ups thread v1)', () => {
  const ACTIONS = [{ signal_id: 'act-1', text: 'Send the vendor the pilot plan', owner: 'Rafael Moreno' }, { signal_id: 'act-2', text: 'Book the lab', owner: null }] as const;

  it('shows a meeting action as an item of kind action, from ECHO data alone, never read live', async () => {
    const f = await openItemsFixture({ meetingActions: ACTIONS }); await f.finishImpactRun();
    const opens = f.opened.length;
    const { items, summary } = await scope(f, 'mina', 'run');
    const actions = items.filter(entry => entry.kind === 'action');
    expect(actions).toHaveLength(2);
    expect(actions.map(entry => entry.reach)).toEqual(['not_read', 'not_read']);
    expect(actions.some(entry => Object.hasOwn(entry, 'current'))).toBe(false);
    expect(actions.find(entry => entry.expected === 'Send the vendor the pilot plan')).toMatchObject({
      relation: 'needs_updating', state: 'unsent', waits_on: 'approver', send_included: null,
      owner: { membership_id: f.membership('rafael'), name: 'Rafael Moreno', match: 'name' }, decision: { title: 'Pilot planning' },
    });
    expect(actions.find(entry => entry.expected === 'Book the lab')).toMatchObject({ owner: { name: 'Ari', match: 'approver' } });
    // Only the ticket and the other decision's action were opened live.
    expect(f.opened.slice(opens).map(open => open.kind).sort()).toEqual(['approved_record', 'ticket']);
    expect(summary).toMatchObject({ unsent: 4, decisions: 1 });
    // Ari's Send row names the actions first, and their owners.
    expect((await f.app.home({ access_token: 'ari' })).send).toMatchObject([{ items: 4, kinds: ['action', 'ticket', 'record'], owners: ['Mina Patel', 'Rafael Moreno'] }]);
  });

  it('names every owner of a run on its Send row, past the twenty a card alone could have', async () => {
    const f = await openItemsFixture({ meetingActions: Array.from({ length: 20 }, (_, at) => ({ signal_id: `act-${at}`, text: `Action ${at}`, owner: null })) });
    await f.finishImpactRun();
    // Twenty-two items: the card's two and twenty actions, each action picked to its own person before Send.
    const actions = f.items.forRun(f.runId).filter(row => row.pointer.kind === 'meeting_action');
    const people = Array.from({ length: 21 }, (_, at) => ({ principal_id: `prn_00000000-0000-4000-8000-${String(at).padStart(12, '9')}`, membership_id: `mem_00000000-0000-4000-8000-${String(at).padStart(12, '8')}`, name: `Person ${String(at).padStart(2, '0')}` }));
    for (const person of people) addMembership(f.db, { organization_id: f.person.organization_id, principal_id: person.principal_id, membership_id: person.membership_id, membership_type: 'employee' }, person.name, `${person.membership_id}@example.test`);
    for (const [at, row] of actions.entries()) f.items.assign(row.item_id, people[at]!.membership_id, f.membership('ari'));
    const [row] = (await f.app.home({ access_token: 'ari' })).send;
    expect(row!.items).toBe(22);
    expect(row!.owners).toHaveLength(21);                                // Mina, and the twenty picked
    expect(row!.owners).toContain('Mina Patel');
  });

  it('sends a meeting action to its owner, who closes it by hand', async () => {
    const f = await openItemsFixture({ meetingActions: ACTIONS }); await f.finishImpactRun();
    const unsent = (await scope(f, 'ari', 'run')).items;
    const action = unsent.find(entry => entry.kind === 'action' && entry.owner.match === 'name')!;
    // Ari sends only Rafael's action; everything else stays to send later.
    await expect(f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'c1', items: [{ item_id: action.item_id, include: true }] } }))
      .resolves.toEqual({ sent: 1, not_relevant: 0 });
    const opens = f.opened.length;
    const home = await f.app.home({ access_token: 'rafael' });
    expect(home.items).toMatchObject([{ item_id: action.item_id, kind: 'action', state: 'open', waits_on: 'owner', reach: 'not_read', send_included: true, can: { set_state: true, assign: true } }]);
    expect(f.opened.length).toBe(opens);
    await expect(setState(f, 'rafael', action.item_id, 'done')).resolves.toEqual({ state: 'done' });
    expect((await item(f, 'ari', action.item_id)).item).toMatchObject({ state: 'done', state_set_by: { name: 'Rafael Moreno' } });
    expect((await f.app.home({ access_token: 'ari' })).send).toMatchObject([{ items: 3 }]);
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

  it('answers the same Home with no live read when asked for rows only (F8)', async () => {
    const f = await sentFixture({ owner: 'mina' });
    f.check(f.ticket.item_id, 'landed');
    const binds = f.bindDesk.mock.calls.length;
    const opens = f.opened.length;
    const sweepReads = [vi.spyOn(f.runs, 'newestSweep'), vi.spyOn(f.runs, 'runningSweep')];
    const quiet = await f.app.home({ access_token: 'mina', request: { schema_version: 1, operation: 'home', rows_only: true } });
    expect(f.bindDesk.mock.calls.length).toBe(binds);                  // no desk bound, nothing opened
    expect(f.opened.length).toBe(opens);
    expect(quiet.items).toHaveLength(2);
    expect(quiet.items.map(entry => entry.reach)).toEqual(['not_read', 'not_read']);
    expect(quiet.items.some(entry => Object.hasOwn(entry, 'current'))).toBe(false);
    // The quiet check never says a sweep is due, so it never starts one, and does not even ask about sweeps.
    expect(quiet.sweep_due).toBe(false);
    expect(sweepReads.map(read => read.mock.calls.length)).toEqual([0, 0]);
    // Everything else is what a full Home read answers, which does find a sweep due: Mina's action was never checked.
    const full = await f.app.home({ access_token: 'mina' });
    expect(full.items.map(entry => entry.reach)).toEqual(['opened', 'opened']);
    expect(full.sweep_due).toBe(true);
    const rows = (home: typeof full) => ({ ...home, sweep_due: undefined, items: home.items.map(({ current: _current, reach: _reach, ...rest }) => rest) });
    expect(rows(quiet)).toEqual(rows(full));
    // A Send row needs no live read either.
    const unsent = await openItemsFixture(); await unsent.finishImpactRun();
    const quietSend = await unsent.app.home({ access_token: 'ari', request: { schema_version: 1, operation: 'home', rows_only: true } });
    expect(quietSend).toEqual(await unsent.app.home({ access_token: 'ari' }));
    expect(quietSend.send).toHaveLength(1);
  });

  it('lists what changed, then what newly waits first, so a new follow-up is never past the twenty, quiet check or not (F8)', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const run = f.runs.read(f.person, f.runId)!;
    const ticket = (index: number) => ({
      item_key: canonicalSha256(`waiting ${index}`), relation: 'conflicts' as const, expected: 'launch next week', owner_membership_id: f.membership('mina'), owner_match: 'jira_account' as const,
      pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(40_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${400 + index}`, text_sha256: canonicalSha256(`waiting text ${index}`) },
    });
    const sendTo = (rows: readonly { readonly item_id: string }[], command_id: string) => {
      f.advance(1_000);
      expect(f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id, choices: rows.map(row => ({ item_id: row.item_id, include: true })) })).toMatchObject({ kind: 'sent' });
    };
    // Twenty-two tickets for Mina sent long ago, and the check's own two: more than Home answers.
    f.advance(1_000);
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 22 }, (_, index) => ticket(index))))();
    const older = f.items.forRun(f.runId).filter(row => row.state === 'unsent');
    sendTo(older, 'older');
    const quiet = () => f.app.home({ access_token: 'mina', request: { schema_version: 1, operation: 'home', rows_only: true } });
    const full = () => f.app.home({ access_token: 'mina' });
    const ids = (home: { readonly items: readonly PersonOpenItemV1[] }) => home.items.map(entry => entry.item_id);
    expect((await quiet()).items).toHaveLength(20);
    // A new one is sent: both reads list it first, the same rows in the same order.
    f.advance(1_000);
    f.db.transaction(() => f.items.insertForRun(f.db, run, [ticket(99)]))();
    const fresh = f.items.forRun(f.runId).find(row => row.state === 'unsent')!;
    sendTo([fresh], 'fresh');
    expect(ids(await quiet())[0]).toBe(fresh.item_id);
    expect(ids(await full())).toEqual(ids(await quiet()));
    // One given to Mina since waits on her from then: first. So does one she closed and Ari reopened.
    const theirs = older.find(row => row.owner_membership_id === f.membership('ari'))!;
    f.advance(1_000);
    await assign(f, 'ari', theirs.item_id, 'mina');
    expect(ids(await quiet()).slice(0, 2)).toEqual([theirs.item_id, fresh.item_id]);
    const reopened = older.at(-1)!;
    f.advance(1_000);
    await setState(f, 'mina', reopened.item_id, 'done');
    expect(ids(await quiet())).not.toContain(reopened.item_id);
    f.advance(1_000);
    await setState(f, 'ari', reopened.item_id, 'open');
    expect(ids(await quiet()).slice(0, 3)).toEqual([reopened.item_id, theirs.item_id, fresh.item_id]);
    // What a check saw change comes before all of them.
    const changed = older[0]!;
    f.check(changed.item_id, 'changed');
    expect(ids(await quiet()).slice(0, 2)).toEqual([changed.item_id, reopened.item_id]);
    expect(ids(await full())).toEqual(ids(await quiet()));
  });

  it('makes no Send row, and binds no desk, when there is nothing to send', async () => {
    const f = await openItemsFixture();
    expect(await f.app.home({ access_token: 'ari' })).toEqual({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
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
    expect((await f.app.home({ access_token: 'okafor' }))).toEqual({ send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
  });
});

describe('open items: sweep requests', () => {
  it('asks the caller who they are before anything else', async () => {
    const f = await sentFixture({ owner: 'mina' });
    await expect(f.openItemsApp.sweep({ access_token: 'stranger', request: { schema_version: 1, operation: 'sweep', scope: 'mine' } })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.runs.list(f.person, 10).map(run => run.trigger)).toEqual(['approved_record']);
  });
});
