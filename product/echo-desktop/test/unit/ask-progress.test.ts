// Ask progress and internal links v1 (ADR-0039), in the store: the steps of
// the Ask on its way and the one line they make, an answer's sources opening
// beside a running Ask, and what an answer looked through.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerSource, AskReceipt, Expect } from '../../src/shared/protocol.js';
import {
  ACCOUNT, asking as askingWith, byClass, byTestId, byType, elements, fail, flush, Held, latestTurn, ok, paneTurn, plainHooks, project, render, rpcFor, startStore,
  storeLifecycle, text,
} from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const EXPECT: Expect = { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id };
const coordinates = { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha('6') };
const decision: AnswerSource = { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha('1') };
const note: AnswerSource = { kind: 'original', label: 'Launch notes', ref: coordinates, item: { kind: 'note', id: `ctx_${'8'.repeat(64)}` } };
const ticket: AnswerSource = { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7' };
const receipt: AskReceipt = { looked_through: 3 };
const answer = (withReceipt = true): Answer => ({
  scope: { kind: 'global' }, sources: [decision], outcome: 'answered',
  parts: [{ question: 'What did we agree?', status: 'answered', statements: [{ text: 'Ship it.', citation_indexes: [0], private: false }],
    blocks: [{ kind: 'text', statements: [0] }] }],
  ...(withReceipt ? { receipt } : {}),
});
const record = { title: 'Tuesday sync', all_day: false, participants: [], participants_more: false, visibility: 'project',
  decisions: { items: [{ text: 'Ship it.', excerpts: [], atom_id: sha('1') }] }, actions: { items: [] }, rationales: { items: [] } };

let held: Held;
storeLifecycle();
beforeEach(() => {
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'ask.record': () => ok(record),
    'ask.source': () => ok({ label: 'Launch notes', text: 'We agreed to ship.' }),
    'source.openExternal': () => ok(null),
  }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
});

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
/** A question on its way, its reply held. */
const asking = (question?: string) => askingWith(rpc, held, question);

describe('the steps of the Ask on its way', () => {
  it('build its stage and what it reads; a step of another Ask, a cancelled one or another account is dropped', async () => {
    const { store, step, release } = await asking();
    const progress = () => store.getState().ask?.asking?.progress;
    expect(progress()).toEqual({ started: expect.any(Number), stage: null, pending: 0, read: [] });
    step({ type: 'stage', stage: 'searching' });
    step({ type: 'searched' });
    step({ type: 'stage', stage: 'reading', pending: 2 });
    expect(progress()).toMatchObject({ stage: 'reading', pending: 2, read: [] });
    // Another Ask's id, another account, another Authority: nothing changes.
    step({ type: 'read', items: [decision] }, { cancel_id: '00000000-0000-4000-8000-000000000000' });
    step({ type: 'read', items: [decision] }, { expect: { ...EXPECT, membership_id: 'someone-else' } });
    step({ type: 'read', items: [decision] }, { expect: { ...EXPECT, authority: 'https://other.invalid' } });
    expect(progress()).toMatchObject({ pending: 2, read: [] });
    step({ type: 'read', items: [decision, note] });
    expect(progress()).toMatchObject({ pending: 0, read: [decision, note] });
    // Answered: a late step goes nowhere.
    release(ok(answer()));
    await flush();
    step({ type: 'stage', stage: 'writing' });
    expect(store.getState().ask?.asking).toBeNull();
    expect(latestTurn(store)?.text).toBe('What did we agree?');
  });

  it('show one line while it works: a pulse, the step now and what it reads, how long, and Cancel, with nothing to open under it', async () => {
    const { step, thread } = await asking();
    step({ type: 'stage', stage: 'searching' });
    step({ type: 'searched' });
    step({ type: 'stage', stage: 'reading', pending: 3 });
    step({ type: 'read', items: [decision, note, ticket] });
    vi.advanceTimersByTime(4_000);
    const shown = thread();
    const line = byTestId(shown, 'asking')[0]!;
    expect(byClass(line, 'pulse')).toHaveLength(1);
    expect(text(byTestId(line, 'ask-stage'))).toBe('Reading Tuesday sync and 2 more');
    expect(text(byTestId(line, 'ask-timer'))).toBe('4s');
    // Cancel is its one button: the line opens onto nothing, and no list shows under it.
    expect(byType(line, 'button').map(node => node.props['data-testid'])).toEqual(['ask-cancel']);
    expect(elements(byClass(shown, 'ask-trail')[0]).filter(node => node.type === 'ul' || node.type === 'li')).toEqual([]);
  });

  it('cancelled, takes no step more, and Ask closes', async () => {
    const { store, step } = await asking();
    step({ type: 'read', items: [decision] });
    store.cancelAsk();
    step({ type: 'read', items: [note] });
    expect(store.getState().ask).toBeNull();
    expect(store.getState().sources).toBeNull();
    expect(calls('ask.cancel')).toHaveLength(1);
  });
});

describe('an answer\'s source opens beside Ask, and Ask keeps running', () => {
  it('a decision an answer cites opens its meeting, lit, while a new question is on its way; Open waits for that answer', async () => {
    const first = await asking();
    first.release(ok(answer(false)));
    await flush();
    const { store } = first;
    const earlier = paneTurn(store)!;
    // A follow-up on its way: the decision the first answer cites, its number chosen meanwhile, opens its meeting beside Ask.
    const second = held.hold('ask.run');
    void store.ask('And then?');
    await flush();
    store.chooseSource(0, '0.0', earlier);
    await flush();
    expect(store.paneTarget()).toMatchObject({ sources: [decision], number: 0 });
    expect([...store.litAtoms(store.getState(), store.paneTarget()!)]).toEqual([sha('1')]);
    expect(store.getState().sources?.records[sha('2')]).toMatchObject({ loading: false, value: { title: 'Tuesday sync' } });
    // Still asking: nothing was cancelled, and there is no Open, since leaving Ask would cancel it.
    expect(store.getState().ask?.asking).not.toBeNull();
    expect(calls('ask.cancel')).toHaveLength(0);
    expect(store.fullPageOffered()).toBe(false);
    store.openFullPage();
    expect(store.getState().ask?.asking).not.toBeNull();

    // The answer comes, and the pane starts over, closed on its sources. Chosen again, the decision offers Open.
    second(ok(answer(false)));
    await flush();
    expect(store.paneTarget()).toBeNull();
    store.chooseSource(0, null, earlier);
    await flush();
    // One read of the meeting served every answer that cites it.
    expect(calls('ask.record')).toEqual([{ expect: EXPECT, record: decision.kind === 'record' ? decision.record : null }]);
    expect(store.fullPageOffered()).toBe(true);
    store.openFullPage();
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(store.getState().reader?.ref).toEqual({ kind: 'meeting', id: sha('2') });
    // The reader reads the meeting as the pane did, by its digest alone.
    expect(calls('ask.record').at(-1)).toEqual({ expect: EXPECT, record: { record_sha256: sha('2') } });
    expect(calls('open.ref')).toHaveLength(0);
    expect(calls('ask.cancel')).toHaveLength(0);
  });

  it('Open on a cited decision goes to its meeting\'s page with that item lit by its atom id, in one read; from a list nothing is lit', async () => {
    // The cited decision is the meeting's second, and the reader reads the whole record, as the pane does.
    const whole = { ...record, decisions: { items: [{ text: 'Hold monthly plans.', excerpts: [], atom_id: sha('9') }, { text: 'Ship it.', excerpts: [], atom_id: sha('1') }] } };
    rpc.mockImplementation(rpcFor(held, { 'ask.record': () => ok(whole) }, () => ({ active: [project(1, 30, { name: 'Apollo' })], archived: [] })));
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
    // One read by its digest alone, lit by the atom ids the pane lit.
    expect(calls('ask.record').at(-1)).toEqual({ expect: EXPECT, record: { record_sha256: sha('2') } });
    expect(calls('open.ref')).toHaveLength(0);
    expect(store.getState().reader).toMatchObject({ ref: { kind: 'meeting', id: sha('2') }, cited: [sha('1')], loading: false });
    expect(store.getState().reader?.record?.decisions.items.map(item => item.text)).toEqual(['Hold monthly plans.', 'Ship it.']);

    const { Reader } = await import('../../src/renderer/screens/reader.js');
    const shown = (backTo: string) => render(Reader({ state: store.getState(), reader: store.getState().reader!, backTo }));
    expect(lit(shown('Home')).map(text)).toEqual(['Cited: Ship it.']);
    // The whole record is there: nothing reads on, and there is no More.
    expect(byTestId(shown('Home'), 'reader-more')).toHaveLength(0);

    // The same meeting opened from a list lights nothing.
    store.closeReader();
    await store.openOnlyMe();
    await store.openListItem({ ref: { kind: 'meeting', id: sha('2') } } as Parameters<typeof store.openListItem>[0]);
    await flush();
    expect(store.getState().reader?.ref).toEqual({ kind: 'meeting', id: sha('2') });
    expect(store.getState().reader?.cited).toBeUndefined();
    expect(lit(shown('Only me'))).toHaveLength(0);
    expect(calls('open.ref')).toHaveLength(0);
  });

  it('a meeting an answer cites at two of its items lights both when its row opens it, and only the one a sentence cites by its number', async () => {
    const other: AnswerSource = { ...decision, atom_id: sha('9') } as AnswerSource;
    const { store, release } = await asking();
    release(ok({ ...answer(false), sources: [decision, other], parts: [{ question: 'What did we agree?', status: 'answered', statements: [
      { text: 'Ship it.', citation_indexes: [0], private: false }, { text: 'Hold monthly plans.', citation_indexes: [1], private: false },
    ], blocks: [{ kind: 'text', statements: [0] }, { kind: 'text', statements: [1] }] }] }));
    await flush();
    // One meeting is one source: its row lights every item the answer cites in it.
    expect(store.answerGroups()).toHaveLength(1);
    store.chooseSource(0, null, paneTurn(store));
    await flush();
    const target = store.paneTarget()!;
    expect(target.sources).toEqual([decision, other]);
    expect([...store.litAtoms(store.getState(), target)]).toEqual([sha('1'), sha('9')]);
    store.chooseSource(0, '0.1', paneTurn(store));
    expect([...store.litAtoms(store.getState(), store.paneTarget()!)]).toEqual([sha('9')]);
    // One read of their meeting serves both.
    expect(calls('ask.record')).toHaveLength(1);
  });

  it('reads a passage in the scope of the answer that cites it, whatever question is on its way; a ticket opens only in its app', async () => {
    const inApollo = { kind: 'project', project_id: project(1, 30).project_id } as const;
    const store = await startStore();
    const first = held.hold('ask.run');
    void store.ask('What did we agree?', inApollo);
    await flush();
    first(ok({ ...answer(false), scope: inApollo, sources: [note, ticket], parts: [{ question: 'What did we agree?', status: 'answered',
      statements: [{ text: 'Ship it, as ECHO-7 says.', citation_indexes: [0, 1], private: false }], blocks: [{ kind: 'text', statements: [0] }] }] }));
    await flush();
    const earlier = paneTurn(store)!;
    // A question across everything on its way: the earlier answer's passage is read where that answer was asked.
    const second = held.hold('ask.run');
    void store.ask('And everywhere?', { kind: 'global' });
    await flush();
    store.chooseSource(0, null, earlier);
    await flush();
    expect(calls('ask.source')).toEqual([{ expect: EXPECT, scope: inApollo, ref: coordinates }]);
    expect(store.getState().sources?.evidence).toMatchObject({ group: 0, reads: { 0: { loading: false, value: { text: 'We agreed to ship.' } } } });

    store.chooseSource(1, null, earlier);
    expect(store.paneTarget()?.sources).toEqual([ticket]);
    expect(await store.openExternalSource(ticket as Extract<AnswerSource, { kind: 'ticket' }>)).toBe(true);
    expect(calls('source.openExternal')).toEqual([{ kind: 'ticket', permalink: ticket.kind === 'ticket' ? ticket.permalink : '' }]);
    second(ok(answer(false)));
    await flush();
    store.chooseSource(1, null, earlier);
    // A ticket has no page in the app: Open in Jira is all it has.
    expect(store.fullPageOffered()).toBe(false);
  });

  it('heads a live item beside Ask by its tool and kind: a Jira ticket, a Confluence page', async () => {
    const page: AnswerSource = { kind: 'page', tool_id: 'confluence', label: 'DVT plan', permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=31010' };
    const { store, release, pane } = await asking();
    release(ok({ ...answer(false), sources: [ticket, page], parts: [{ question: 'What did we agree?', status: 'answered',
      statements: [{ text: 'ECHO-7 and the DVT plan agree.', citation_indexes: [0, 1], private: false }], blocks: [{ kind: 'text', statements: [0] }] }] }));
    await flush();
    for (const [group, heading] of [[0, 'Jira · Ticket'], [1, 'Confluence · Page']] as const) {
      store.chooseSource(group, null, paneTurn(store));
      await flush();
      expect(text(byTestId(pane(), 'source-pane'))).toContain(heading);
    }
  });

  it('starts the pane over when a question gets no answer: a refusal or a cancel closes what was chosen while it ran', async () => {
    // Asked from a page with nothing before it, refused: no answer, and no pane.
    const { store, release } = await asking();
    release(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.getState().ask?.failed?.failure.code).toBe('unavailable');
    expect(store.getState().sources).toBeNull();
    // Answered, then a follow-up refused: the pane closes on the source chosen while it ran.
    const answered = held.hold('ask.run');
    void store.ask('Answered?');
    await flush();
    answered(ok(answer(false)));
    await flush();
    const earlier = paneTurn(store)!;
    const refused = held.hold('ask.run');
    void store.ask('Refused?');
    await flush();
    store.chooseSource(0, null, earlier);
    expect(store.paneTarget()?.sources).toEqual([decision]);
    refused(fail('unavailable', { retryable: true }));
    await flush();
    expect(store.paneTarget()).toBeNull();
    // A follow-up that is cancelled: the answer before comes back, its pane closed.
    const cancelled = held.hold('ask.run');
    void store.ask('Cancelled?');
    await flush();
    store.chooseSource(0, null, earlier);
    store.cancelAsk();
    expect(latestTurn(store)?.text).toBe('Answered?');
    expect(store.paneTarget()).toBeNull();
    cancelled(ok(answer()));
  });

  it('closes when another app comes in front', async () => {
    const { store, release } = await asking();
    release(ok(answer(false)));
    await flush();
    store.chooseSource(0, null, paneTurn(store));
    expect(store.paneTarget()?.sources).toEqual([decision]);
    store.windowState({ onScreen: true, front: false });
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

  it('says what an answer with no sources looked through as plain words under it: there is nothing to open', async () => {
    const { store, release, thread } = await asking();
    vi.advanceTimersByTime(3_000);
    release(ok({ ...answer(), sources: [], outcome: 'not_found', parts: [{ question: 'What did we agree?', status: 'not_found', statements: [] }] }));
    await flush();
    expect(latestTurn(store)?.receipt).toEqual(receipt);
    const foot = byTestId(thread(), 'turn-foot').at(-1)!;
    expect(byTestId(foot, 'sources-toggle')).toEqual([]);
    expect(text(byTestId(foot, 'foot-label'))).toBe('Looked through 3 items · 3s');
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
    ], blocks: [{ kind: 'text', statements: [0] }, { kind: 'text', statements: [1] }] }] }));
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
