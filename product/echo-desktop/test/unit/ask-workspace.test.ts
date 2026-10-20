// Your project, a person, a tool and a tool's container, as Ask cites or
// names them (research tool contract v1), in the store and on the page: each
// opens in Ask's side panel by its name while Ask keeps running, and nothing
// is read for it. Once the answer came, Open goes to the project, or to
// Tools; a person has nowhere to go; a Jira project or Confluence space says
// its tool and key on its source row, and opens in its tool.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerSource, AskReceipt, ConnectedTool, Expect } from '../../src/shared/protocol.js';
import { Folder, Plug } from '../../src/renderer/screens/icons.js';
import { ACCOUNT, asking as askingWith, byTestId, elements, fail, flush, Held, ok, plainHooks, project, render, rpcFor, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below.
vi.mock('preact/hooks', original => plainHooks(original));

const EXPECT: Expect = { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id };
/** Apollo, in the sidebar, and a project of yours past its pages. */
const apollo = project(1, 30, { name: 'Apollo' });
const thermal = project(9, 21, { name: 'Thermal recovery', role: 'member' });
const cited: AnswerSource = { kind: 'project', label: 'Apollo', project_id: apollo.project_id };
const unlisted: AnswerSource = { kind: 'project', label: 'Thermal recovery', project_id: thermal.project_id };
const mara: AnswerSource = { kind: 'person', label: 'Mara Lind', membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' };
const jira: AnswerSource = { kind: 'tool', label: 'Jira', tool_id: 'jira' };
const therm: AnswerSource = { kind: 'container', tool_id: 'jira', label: 'Thermal', permalink: 'https://example.atlassian.net/browse/THERM', container: 'jira_project', key: 'THERM' };
const space: AnswerSource = { kind: 'container', tool_id: 'confluence', label: 'Thermal team', permalink: 'https://example.atlassian.net/wiki/spaces/THT', container: 'confluence_space' };
/** An answer whose one sentence cites every source given. */
const answering = (sources: readonly AnswerSource[], receipt?: AskReceipt): Answer => ({
  text: 'Thermal recovery is led by Mara.', scope: { kind: 'global' }, sources, outcome: 'answered', ...(receipt ? { receipt } : {}),
  parts: [{ question: 'Who leads Thermal recovery?', status: 'answered',
    statements: [{ text: 'Thermal recovery is led by Mara.', citation_indexes: sources.map((_, index) => index), private: false }] }],
});

let held: Held;
let projectReads: (() => unknown)[];
let tools: ConnectedTool[];
storeLifecycle(new Date('2026-10-19T11:00:00.000Z'));
beforeEach(() => {
  held = new Held();
  projectReads = [];
  tools = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'projects.read': () => (projectReads.shift() ?? (() => fail('not_found')))(),
    'account.tools': () => ok({ tools }),
    'source.openExternal': () => ok(null),
  }, () => ({ active: [apollo], archived: [] })));
});

const called = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);

/** What the pane's head calls what it shows. */
const heading = (tree: unknown) => text(elements(tree).filter(node => node.props.class === 'section-label'));
/** An icon, by the lines it draws. */
const drawn = (tree: unknown) => elements(tree).filter(node => node.type === 'path').map(node => node.props.d);

/** A question on its way, its reply held; and the page's pane and thread as they show now. */
const asking = (question = 'Who leads Thermal recovery?') => askingWith(rpc, held, question);

describe('your workspace and your tools\' containers open beside Ask (research tool contract v1)', () => {
  it('shows a project by its name while Ask runs, with nothing read and no Open; once answered, Open goes to the project, from its sidebar row', async () => {
    const { store, release, read, pane } = await asking();
    read([cited]);
    const before = rpc.mock.calls.length;
    store.openNamed([cited]);
    await flush();
    // Nothing is read for it: the pane shows what Ask cited.
    expect(rpc.mock.calls).toHaveLength(before);
    const shown = pane();
    expect(heading(shown)).toBe('Project');
    expect(text(byTestId(shown, 'pane-project').flatMap(node => elements(node).filter(child => child.type === 'h2')))).toBe('Apollo');
    // Leaving Ask would cancel it: no Open, and Open does nothing.
    expect(byTestId(shown, 'source-open')).toEqual([]);
    store.openFullPage();
    expect(store.getState().ask?.asking).not.toBeNull();

    // The answer cites it, and its receipt names it: the pane stays on it, and Open shows.
    vi.advanceTimersByTime(3_000);
    release(ok(answering([cited], { looked_through: 1, elapsed_ms: 31_000, rows: [{ type: 'searched', sources: [{ kind: 'projects' }], found: 1 },
      { type: 'read', items: [cited] }] })));
    await flush();
    expect(store.paneTarget()?.sources).toEqual([cited]);
    expect(byTestId(pane(), 'source-open')).toHaveLength(1);
    store.openFullPage();
    await flush();
    // The project, from its row in the sidebar, as the sidebar opens it; Ask is gone and was never cancelled.
    expect(store.getState().ask).toBeNull();
    expect(store.getState().route).toEqual({ page: 'project', project: apollo });
    expect(store.getState().barScope).toEqual({ kind: 'project', project_id: apollo.project_id });
    expect(called('projects.read')).toEqual([]);
    expect(called('ask.cancel')).toEqual([]);
  });

  it.each([
    { outcome: 'opens it in place of Ask', reply: () => ok(thermal), opened: true, route: { page: 'project', project: thermal }, toast: null },
    { outcome: 'says you no longer have access, by its name, over the answer', reply: () => fail('not_found'), opened: false, route: { page: 'home' }, toast: 'You no longer have access to Thermal recovery' },
    { outcome: 'says why it could not be read, over the answer', reply: () => fail('unavailable', { retryable: true }), opened: false, route: { page: 'home' }, toast: 'ECHO is unavailable right now. Try again.' },
  ])('reads a project past the sidebar\'s pages on its own once Open is chosen, and $outcome', async ({ reply, opened, route, toast }) => {
    projectReads = [reply];
    const { store, release, pane } = await asking();
    release(ok(answering([unlisted])));
    await flush();
    store.chooseSource(0);
    await flush();
    expect(called('projects.read')).toEqual([]);
    expect(byTestId(pane(), 'source-open')).toHaveLength(1);
    const answer = store.getState().ask!.shown;
    store.openFullPage();
    await flush();
    expect(called('projects.read')).toEqual([{ expect: EXPECT, project_id: thermal.project_id }]);
    // Ask goes only once the project is read: a project that could not be read leaves the answer as it was.
    expect(store.getState().ask?.shown ?? null).toBe(opened ? null : answer);
    expect(store.getState().route).toEqual(route);
    expect(store.getState().toast).toBe(toast);
  });

  it('keeps Ask while it reads the project, and drops the read once you asked again', async () => {
    const { store, release } = await asking();
    release(ok(answering([unlisted])));
    await flush();
    store.chooseSource(0);
    const read = held.hold('projects.read');
    store.openFullPage();
    await flush();
    expect(store.getState().ask?.shown?.answer.sources).toEqual([unlisted]);
    const again = held.hold('ask.run');
    void store.ask('Who else is in Thermal recovery?');
    await flush();
    read(ok(thermal));
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().ask?.asking?.question).toBe('Who else is in Thermal recovery?');
    again(ok(answering([unlisted])));
    await flush();
  });

  it('drops a project read that lands once you moved on', async () => {
    const { store, release } = await asking();
    release(ok(answering([unlisted])));
    await flush();
    store.chooseSource(0);
    const read = held.hold('projects.read');
    store.openFullPage();
    await flush();
    void store.openMine();
    await flush();
    read(ok(thermal));
    await flush();
    expect(store.getState().route).toEqual({ page: 'mine' });
    expect(store.getState().toast).toBeNull();
  });

  it('shows a person by their name alone, with nothing read and no Open, even once the answer came', async () => {
    const { store, release, pane, thread } = await asking();
    release(ok(answering([mara])));
    await flush();
    const before = rpc.mock.calls.length;
    store.chooseSource(0);
    await flush();
    expect(rpc.mock.calls).toHaveLength(before);
    const shown = pane();
    expect(heading(shown)).toBe('Person');
    expect(text(byTestId(shown, 'pane-person'))).toBe('Mara Lind');
    expect(byTestId(shown, 'source-open')).toEqual([]);
    store.openFullPage();
    expect(store.getState().ask).not.toBeNull();
    // Its source row names them, with no qualifier.
    expect(text(byTestId(thread(), 'source-row'))).toBe('1Mara Lind');
  });

  it('shows a tool by its name alone, never a connection Tools read earlier; Open goes to Tools', async () => {
    tools = [{ tool_id: 'jira', name: 'Jira', status: 'revoked' }];
    const { store, release, pane, thread } = await asking();
    release(ok(answering([jira])));
    await flush();
    const [row] = byTestId(thread(), 'source-row');
    expect(text(row)).toBe('1Jira');
    expect(drawn(row)).toEqual(drawn(render(Plug())));
    const before = rpc.mock.calls.length;
    store.chooseSource(0);
    await flush();
    // Tools has not been read here: its name alone, and nothing is read for it.
    expect(rpc.mock.calls).toHaveLength(before);
    expect(heading(pane())).toBe('Tool');
    expect(text(byTestId(pane(), 'pane-tool'))).toBe('Jira');
    expect(byTestId(pane(), 'pane-tool-status')).toEqual([]);
    expect(byTestId(pane(), 'source-open')).toHaveLength(1);
    store.openFullPage();
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(store.getState().route).toEqual({ page: 'tools' });
    expect(store.getState().tools?.items).toEqual(tools);

    // Asked again from Tools, which has read your connection: the pane still names the tool alone. The connection may
    // have changed since Tools read it, and the answer says it as the Authority read it for this Ask.
    const again = held.hold('ask.run');
    void store.ask('Is Jira connected?');
    await flush();
    again(ok(answering([jira])));
    await flush();
    store.chooseSource(0);
    expect(text(byTestId(pane(), 'pane-tool'))).toBe('Jira');
    expect(byTestId(pane(), 'pane-tool-status')).toEqual([]);
  });

  it('names a container\'s tool and key on its source row and beside Ask, and opens it in its tool, never on a page of ECHO\'s', async () => {
    const { store, release, pane, thread } = await asking();
    release(ok(answering([therm, space])));
    await flush();
    const rows = byTestId(thread(), 'source-row');
    // "Jira · THERM"; a container with no key says its tool alone.
    expect(rows.map(text)).toEqual(['1ThermalJira · THERM', '2Thermal teamConfluence']);
    // A Jira project and a Confluence space are folders.
    expect(drawn(rows[0])).toEqual(drawn(render(Folder())));
    expect(drawn(rows[1])).toEqual(drawn(render(Folder())));
    const before = rpc.mock.calls.length;
    store.chooseSource(0);
    await flush();
    expect(rpc.mock.calls).toHaveLength(before);
    const shown = pane();
    expect(heading(shown)).toBe('Jira · Project');
    expect(text(byTestId(shown, 'pane-container-meta'))).toBe('Jira · THERM');
    expect(byTestId(shown, 'source-open')).toEqual([]);
    const [open] = byTestId(shown, 'open-container-source');
    expect(text(open)).toBe('Open in Jira');
    await (open!.props.onClick as () => Promise<void>)();
    expect(called('source.openExternal')).toEqual([{ kind: 'container', permalink: 'https://example.atlassian.net/browse/THERM' }]);
    store.chooseSource(1);
    expect(heading(pane())).toBe('Confluence · Space');
    expect(text(byTestId(pane(), 'pane-container-meta'))).toBe('Confluence');
  });
});
