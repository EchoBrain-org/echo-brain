// Ask progress and internal links v1 (ADR-0039), in the store: the steps of
// the Ask on its way, the items they name opening beside a running Ask, and
// the receipt an answer keeps.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerSource, AskReceipt, Expect } from '../../src/shared/protocol.js';
import { ACCOUNT, asking as askingWith, byTestId, elements, fail, flush, Held, latestTurn, ok, paneTurn, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const EXPECT: Expect = { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id };
const coordinates = { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha('6') };
const decision: AnswerSource = { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha('1') };
const note: AnswerSource = { kind: 'original', label: 'Launch notes', ref: coordinates, item: { kind: 'note', id: `ctx_${'8'.repeat(64)}` } };
const ticket: AnswerSource = { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7' };
const receipt: AskReceipt = { looked_through: 3, rows: [
  { type: 'searched', sources: [{ kind: 'meetings' }], found: 3 }, { type: 'read', items: [decision, note, ticket] },
] };
const answer = (withReceipt = true): Answer => ({
  text: 'Ship it.', scope: { kind: 'global' }, sources: [decision], outcome: 'answered',
  parts: [{ question: 'What did we agree?', status: 'answered', statements: [{ text: 'Ship it.', citation_indexes: [0], private: false }] }],
  ...(withReceipt ? { receipt } : {}),
});
const record = { title: 'Tuesday sync', all_day: false, participants: [], participants_more: false, visibility: 'project',
  decisions: { items: [{ text: 'Ship it.', excerpts: [], atom_id: sha('1') }], more: false }, actions: { items: [], more: false }, rationales: { items: [], more: false } };

let held: Held;
storeLifecycle();
beforeEach(() => {
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'ask.record': () => ok(record),
    'ask.source': () => ok({ label: 'Launch notes', text: 'We agreed to ship.' }),
    'open.ref': () => ok({ kind: 'meeting', record, next_cursor: null }),
    'source.openExternal': () => ok(null),
  }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
});

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
/** A question on its way, its reply held. */
const asking = (question?: string) => askingWith(rpc, held, question);

describe('the steps of the Ask on its way', () => {
  it('build its stage and rows; a step of another Ask, a cancelled one or another account is dropped', async () => {
    const { store, step, release } = await asking();
    const progress = () => store.getState().ask?.asking?.progress;
    expect(progress()).toMatchObject({ stage: null, pending: 0, rows: [] });
    step({ type: 'stage', stage: 'searching' });
    step({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 });
    step({ type: 'stage', stage: 'reading', pending: 2 });
    expect(progress()).toMatchObject({ stage: 'reading', pending: 2, rows: [{ type: 'searched', found: 22 }] });
    // Another Ask's id, another account, another Authority: nothing changes.
    step({ type: 'read', items: [decision] }, { cancel_id: '00000000-0000-4000-8000-000000000000' });
    step({ type: 'read', items: [decision] }, { expect: { ...EXPECT, membership_id: 'someone-else' } });
    step({ type: 'read', items: [decision] }, { expect: { ...EXPECT, authority: 'https://other.invalid' } });
    expect(progress()?.rows).toHaveLength(1);
    step({ type: 'read', items: [decision, note] });
    expect(progress()).toMatchObject({ pending: 0, rows: [{ type: 'searched' }, { type: 'read', items: [decision, note] }] });
    // Answered: a late step goes nowhere.
    release(ok(answer()));
    await flush();
    step({ type: 'stage', stage: 'writing' });
    expect(store.getState().ask?.asking).toBeNull();
    expect(latestTurn(store)?.text).toBe('What did we agree?');
  });

  it('cancelled, takes no step more, and Ask closes with what it named', async () => {
    const { store, step } = await asking();
    step({ type: 'read', items: [decision] });
    store.openNamed([decision]);
    store.cancelAsk();
    step({ type: 'read', items: [note] });
    expect(store.getState().ask).toBeNull();
    expect(store.getState().sources).toBeNull();
    expect(calls('ask.cancel')).toHaveLength(1);
  });
});

describe('a name opens beside Ask, and Ask keeps running', () => {
  it('a decision opens its meeting, lit; Open waits for the answer and then goes to the meeting\'s page', async () => {
    const { store, step, release } = await asking();
    step({ type: 'read', items: [decision] });
    store.openNamed([decision]);
    await flush();
    expect(store.paneTarget()).toEqual({ sources: [decision], group: null, number: null });
    expect(calls('ask.record')).toEqual([{ expect: EXPECT, record: decision.kind === 'record' ? decision.record : null }]);
    expect(store.getState().sources?.records[sha('2')]).toMatchObject({ loading: false, value: { title: 'Tuesday sync' } });
    // Still asking: nothing was cancelled, and there is no Open, since leaving Ask would cancel it.
    expect(store.getState().ask?.asking).not.toBeNull();
    expect(calls('ask.cancel')).toHaveLength(0);
    expect(store.fullPageOffered()).toBe(false);
    store.openFullPage();
    expect(store.getState().ask?.asking).not.toBeNull();

    // The answer comes: the pane stays on the item, with what it read, and Open shows.
    vi.advanceTimersByTime(3_000);
    release(ok(answer()));
    await flush();
    expect(store.paneTarget()?.sources).toEqual([decision]);
    expect(calls('ask.record')).toHaveLength(1);
    expect(store.fullPageOffered()).toBe(true);
    store.openFullPage();
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(store.getState().reader?.ref).toEqual({ kind: 'meeting', id: sha('2') });
    expect(calls('open.ref').at(-1)).toMatchObject({ ref: { kind: 'meeting', id: sha('2') } });
    expect(calls('ask.cancel')).toHaveLength(0);
  });

  it('Open on a cited decision goes to its meeting\'s page with that item lit, read on until it shows', async () => {
    // The cited decision is the meeting's second. The reader's record has no atom ids, and its first page holds only the first decision.
    const first = { text: 'Hold monthly plans.', excerpts: [] };
    const cited = { text: 'Ship it.', excerpts: [] };
    const page = (items: readonly object[]) => ({ ...record, decisions: { items, more: false } });
    rpc.mockImplementation(rpcFor(held, {
      'ask.record': () => ok(page([{ ...first, atom_id: sha('9') }, { ...cited, atom_id: sha('1') }])),
      'open.ref': params => ok(params.cursor === undefined ? { kind: 'meeting', record: page([first]), next_cursor: 'page-2' } : { kind: 'meeting', record: page([cited]), next_cursor: null }),
    }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
    const { store, release, pane } = await asking();
    vi.advanceTimersByTime(3_000);
    release(ok(answer()));
    await flush();
    store.chooseSource(0, null, paneTurn(store));
    await flush();
    const lit = (tree: unknown) => elements(tree).filter(node =>
      String(node.props.class ?? '').split(' ').includes('record-item') && String(node.props.class ?? '').split(' ').includes('on'));
    expect(lit(pane()).map(text)).toEqual(['Cited: Ship it.']);
    store.openFullPage();
    await flush();
    expect(store.getState().ask).toBeNull();
    // Read on to the page that holds it, and lit where the pane lit it.
    expect(calls('open.ref').map(params => params.cursor)).toEqual([undefined, 'page-2']);
    expect(store.getState().reader).toMatchObject({ ref: { kind: 'meeting', id: sha('2') }, cited: [{ section: 'decisions', index: 1 }], recordNext: null });
    expect(store.getState().reader?.record?.decisions.items.map(item => item.text)).toEqual(['Hold monthly plans.', 'Ship it.']);

    const { Reader } = await import('../../src/renderer/screens/reader.js');
    expect(lit(render(Reader({ state: store.getState(), reader: store.getState().reader!, backTo: 'Home' }))).map(text)).toEqual(['Cited: Ship it.']);

    // The same meeting opened from a list lights nothing.
    store.closeReader();
    await store.openOnlyMe();
    await store.openListItem({ ref: { kind: 'meeting', id: sha('2') } } as Parameters<typeof store.openListItem>[0]);
    await flush();
    expect(store.getState().reader?.ref).toEqual({ kind: 'meeting', id: sha('2') });
    expect(store.getState().reader?.cited).toBeUndefined();
  });

  it('a name of a place lights every item of it Ask read, and shows every passage', async () => {
    const other: AnswerSource = { ...decision, atom_id: sha('9') } as AnswerSource;
    const passage: AnswerSource = { ...note, ref: { ...coordinates, anchor_sha256: sha('a') } } as AnswerSource;
    const { store } = await asking();
    store.openNamed([decision, other]);
    await flush();
    const target = store.paneTarget()!;
    expect(target.sources).toEqual([decision, other]);
    expect([...store.litAtoms(store.getState(), target)]).toEqual([sha('1'), sha('9')]);
    // One read of their meeting serves both.
    expect(calls('ask.record')).toHaveLength(1);

    store.openNamed([note, passage]);
    await flush();
    expect(calls('ask.source').map(params => (params.ref as { anchor_sha256: string }).anchor_sha256)).toEqual([sha('6'), sha('a')]);
    expect(store.getState().sources?.evidence).toMatchObject({ group: null, reads: { 0: { loading: false }, 1: { loading: false } } });
  });

  it('a passage is read under the Ask\'s own scope, and a ticket opens only in its app', async () => {
    const store = await startStore();
    const release = held.hold('ask.run');
    void store.ask('What did we agree?', { kind: 'project', project_id: project(1, 30).project_id });
    await flush();
    store.openNamed([note]);
    await flush();
    expect(calls('ask.source')).toEqual([{ expect: EXPECT, scope: { kind: 'project', project_id: project(1, 30).project_id }, ref: coordinates }]);
    expect(store.getState().sources?.evidence).toMatchObject({ group: null, reads: { 0: { loading: false, value: { text: 'We agreed to ship.' } } } });

    store.openNamed([ticket]);
    expect(await store.openExternalSource(ticket as Extract<AnswerSource, { kind: 'ticket' }>)).toBe(true);
    expect(calls('source.openExternal')).toEqual([{ kind: 'ticket', permalink: ticket.kind === 'ticket' ? ticket.permalink : '' }]);
    release(ok(answer()));
    await flush();
    // A ticket has no page in the app: Open in Jira is all it has.
    expect(store.fullPageOffered()).toBe(false);
  });

  it('closes with no answer: a refusal, a timeout or a cancel removes what the Ask named', async () => {
    const { store, step, release } = await asking();
    step({ type: 'read', items: [decision] });
    store.openNamed([decision]);
    release(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask?.failed?.failure.code).toBe('unavailable');
    expect(store.getState().sources).toBeNull();
    expect(store.paneTarget()).toBeNull();

    // A follow-up that is cancelled: the answer before comes back, its pane closed.
    const first = held.hold('ask.run');
    void store.ask('First?');
    await flush();
    first(ok(answer(false)));
    await flush();
    const second = held.hold('ask.run');
    void store.ask('Second?');
    await flush();
    store.openNamed([note]);
    store.cancelAsk();
    expect(latestTurn(store)?.text).toBe('First?');
    expect(store.getState().sources?.named).toBeNull();
    expect(store.paneTarget()).toBeNull();
    second(ok(answer()));
  });

  it('keeps a named item in the pane after the answer only when the audited answer names it', async () => {
    const { store, step, release } = await asking();
    step({ type: 'read', items: [decision, note] });
    store.openNamed([note]);
    await flush();
    expect(store.paneTarget()?.sources).toEqual([note]);
    // The answer releases without the note, in its receipt or its sources: the pane closes on it.
    vi.advanceTimersByTime(3_000);
    release(ok({ ...answer(), receipt: { ...receipt, rows: [{ type: 'read', items: [decision] }] } }));
    await flush();
    expect(latestTurn(store)?.text).toBe('What did we agree?');
    expect(store.getState().sources?.named).toBeNull();
    expect(store.getState().sources?.evidence).toBeNull();
    expect(store.paneTarget()).toBeNull();
  });

  it('closes when another app comes in front', async () => {
    const { store } = await asking();
    store.openNamed([decision]);
    store.windowState({ onScreen: true, front: false });
    expect(store.getState().sources?.named).toBeNull();
    expect(store.paneTarget()).toBeNull();
  });
});

describe('the receipt above an answer', () => {
  it('stays only for an Ask that took long enough to show its work', async () => {
    const quick = await asking('Quick?');
    quick.release(ok(answer()));
    await flush();
    expect(latestTurn(quick.store)?.receipt).toBeUndefined();
    // The answer itself came with it, but only the Ask that brought it reads it: the timeline keeps none.
    expect(latestTurn(quick.store)?.answer).not.toHaveProperty('receipt');

    const slow = held.hold('ask.run');
    void quick.store.ask('Slow?');
    await flush();
    vi.advanceTimersByTime(3_000);
    slow(ok(answer()));
    await flush();
    expect(latestTurn(quick.store)?.receipt).toEqual(receipt);
  });

  it('times the wait by the page\'s clock, and keeps it with the receipt', async () => {
    const { store, release } = await asking();
    vi.advanceTimersByTime(3_400);
    release(ok(answer()));
    await flush();
    expect(latestTurn(store)).toMatchObject({ receipt, took: 3_400 });
  });

  it('an Authority that answers without streaming sends none, and the answer shows without a receipt', async () => {
    const { store, release } = await asking();
    vi.advanceTimersByTime(10_000);
    release(ok(answer(false)));
    await flush();
    expect(latestTurn(store)).toMatchObject({ question: 'What did we agree?' });
    expect(latestTurn(store)?.receipt).toBeUndefined();
  });
});

describe('the cited evidence as it reads now', () => {
  it('says a cited record you can no longer read is gone, with no Try again that cannot work', async () => {
    rpc.mockImplementation(rpcFor(held, { 'ask.record': () => fail('not_found') }, () => ({ active: [], archived: [] })));
    const { store, release, pane, thread } = await asking();
    release(ok(answer(false)));
    await flush();
    store.toggleSourceList(paneTurn(store));
    expect(text(byTestId(thread(), 'source-row'))).toBe('1Tuesday sync');
    store.chooseSource(0, null, paneTurn(store));
    await flush();
    expect(text(byTestId(pane(), 'source-error'))).toBe('This is no longer available to you.');
    expect(elements(pane()).filter(node => node.type === 'button').map(text)).not.toContain('Try again');
    expect(calls('ask.record')).toHaveLength(2);
  });

  it('shows each cited passage of one file as the file reads, and lights the one a sentence cites', async () => {
    const first: AnswerSource = { ...note, label: 'Apollo-launch-plan-v2.md' };
    const second: AnswerSource = { ...first, ref: { ...coordinates, anchor_sha256: sha('a') } } as AnswerSource;
    rpc.mockImplementation(rpcFor(held, { 'ask.record': () => ok(record), 'ask.source': params => ok({ label: first.label,
      text: (params.ref as { anchor_sha256: string }).anchor_sha256 === sha('a')
        ? 'Apollo-launch-plan-v2.md ## Pricing\n\n- **Monthly** plans follow the launch.' : 'We agreed to ship.' }) }, () => ({ active: [], archived: [] })));
    const { store, release, pane } = await asking();
    release(ok({ ...answer(false), sources: [decision, first, second], parts: [{ question: 'What did we agree?', status: 'answered', statements: [
      { text: 'We agreed to ship Apollo with annual plans first.', citation_indexes: [0, 1], private: false },
      { text: 'Monthly plans follow the launch.', citation_indexes: [2], private: false },
    ] }] }));
    await flush();
    store.chooseSource(1, '0.1', paneTurn(store));
    await flush();
    expect(elements(pane()).filter(node => node.type === 'h2').map(text)).toEqual(['Apollo launch plan']);
    expect(text(byTestId(pane(), 'source-meta'))).toBe('v2 · 2 passages cited');
    const lit = () => byTestId(pane(), 'evidence-text').map(node => String(node.props.class ?? '').split(' ').includes('on'));
    expect(lit()).toEqual([false, true]);
    expect(elements(byTestId(pane(), 'evidence-text')[1]).filter(node => node.type === 'h3').map(text)).toEqual(['Pricing']);
    expect(text(pane())).not.toContain('Apollo-launch-plan-v2.md');
    expect(calls('ask.source')).toHaveLength(2);
    store.chooseSource(1, null, paneTurn(store));
    await flush();
    expect(lit()).toEqual([false, false]);
  });

  it('says a passage could not be read, and Try again reads it again', async () => {
    let reads = 0;
    rpc.mockImplementation(rpcFor(held, { 'ask.source': () => ++reads === 1 ? fail('unavailable', { retryable: true }) : ok({ label: note.label, text: 'We agreed to ship.' }) }, () => ({ active: [], archived: [] })));
    const { store, release, pane } = await asking();
    release(ok({ ...answer(false), sources: [note] }));
    await flush();
    store.chooseSource(0, null, paneTurn(store));
    await flush();
    expect(text(byTestId(pane(), 'source-error'))).toBe('ECHO is unavailable right now. Try again.');
    expect(byTestId(pane(), 'evidence-text')).toHaveLength(0);
    expect(text(byTestId(pane(), 'retry-evidence'))).toBe('Try again');
    store.retryEvidence();
    await flush();
    expect(text(byTestId(pane(), 'evidence-text'))).toBe('We agreed to ship.');
    expect(calls('ask.source')).toHaveLength(2);
  });

  it('shows at most 2,000 characters of a passage', async () => {
    rpc.mockImplementation(rpcFor(held, { 'ask.source': () => ok({ label: note.label, text: 'x'.repeat(3_000) }) }, () => ({ active: [], archived: [] })));
    const { store, release, pane } = await asking();
    release(ok({ ...answer(false), sources: [note] }));
    await flush();
    store.chooseSource(0, null, paneTurn(store));
    await flush();
    expect(text(byTestId(pane(), 'evidence-text'))).toBe(`${'x'.repeat(2_000)}…`);
  });
});
