import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListItem } from '../../src/shared/protocol.js';
import { byTestId, fail, flush, Held, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';
import { renamedProject, reread } from '../../src/renderer/feed.js';

const row = (title: string, hour: number, kind: ListItem['ref']['kind'] = 'note'): ListItem => ({
  ref: { kind, id: `${kind}-${title}` }, title, added_at: `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`, visibility: 'project', projects: [],
});
const key = (item: ListItem) => `${item.ref.kind}:${item.ref.id}`;

describe('a first page read again', () => {
  const hours = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => row(`n${from - index}`, from - index));

  it('leads with the page and keeps the older rows More loaded, with the cursor past them', () => {
    // Shown: twelve rows, read to the end. A new one pushes the tenth off the first page.
    const shown = { items: hours(20, 9), next: null };
    const first = { items: [row('new', 21), ...hours(20, 12)], next: 'page2' };
    const again = reread(shown, first, key);
    expect(again.items.map(item => item.title)).toEqual(['new', ...hours(20, 9).map(item => item.title)]);
    expect(again.next).toBeNull();
  });

  it('drops a shown row the page should hold but does not, and takes the page whole when it reaches the end', () => {
    // n15 left the list; n10 was loaded with More.
    const shown = { items: hours(20, 10), next: 'page2' };
    const first = { items: hours(20, 11).filter(item => item.title !== 'n15'), next: 'page2b' };
    const again = reread(shown, first, key);
    expect(again.items.map(item => item.title)).toEqual(['n20', 'n19', 'n18', 'n17', 'n16', 'n14', 'n13', 'n12', 'n11', 'n10']);
    expect(again.next).toBe('page2');
    expect(reread(shown, { items: hours(20, 16), next: null }, key)).toEqual({ items: hours(20, 16), next: null });
  });

  it('keeps notes, documents and meetings of the same time apart by their refs', () => {
    const shown = { items: [row('a', 12, 'meeting'), row('a', 11, 'note'), row('a', 11, 'document')], next: null };
    const first = { items: [row('b', 13), row('a', 12, 'meeting')], next: 'page2' };
    expect(reread(shown, first, key).items.map(key)).toEqual(['note:note-b', 'meeting:meeting-a', 'note:note-a', 'document:document-a']);
  });
});

describe('a project renamed while its rows show', () => {
  it('renames it in every row that names it, older rows included, and leaves the rest', () => {
    const filed = (title: string, hour: number, projects: string[]): ListItem => ({ ...row(title, hour), projects });
    const shown = [filed('first', 20, ['Apollo', 'Beacon']), filed('mine', 19, []), filed('older', 3, ['Apollo']), filed('other', 2, ['Beacon'])];
    const renamed = renamedProject(shown, 'Apollo', 'Apollo 2');
    expect(renamed.map(item => item.projects)).toEqual([['Apollo 2', 'Beacon'], [], ['Apollo 2'], ['Beacon']]);
    expect(renamed[1]).toBe(shown[1]);
    expect(shown[0]!.projects).toEqual(['Apollo', 'Beacon']);
  });
});

describe('rows added at the same instant', () => {
  it('are told apart by ref, as the Authority orders them: one the page should hold but does not is dropped', () => {
    const same = (title: string, kind: ListItem['ref']['kind'] = 'note') => row(title, 10, kind);
    // document:… sorts before note:…, so the page's last row (note b) is followed by note c, not by the document.
    const shown = { items: [row('new', 12), same('a', 'document'), same('b'), same('c'), row('old', 9)], next: 'page2' };
    const first = { items: [row('new', 12), same('b')], next: 'page1b' };
    const again = reread(shown, first, key);
    expect(again.items.map(item => item.title)).toEqual(['new', 'b', 'c', 'old']);
    expect(again.next).toBe('page2');
  });
});


const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));
const beacon = project(2, 29, { name: 'Beacon', role: 'member' });
const notes = Array.from({ length: 13 }, (_, index) => row(`Note ${index}`, 20 - index));
let held: Held;
storeLifecycle();
beforeEach(() => {
  held = new Held(); rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'list.page': params => ok({ items: params.cursor ? notes.slice(10) : notes.slice(0, 10), next_cursor: params.cursor ? null : 'c2', meetings_held: false }),
    'notes.submit': () => ok({}),
  }, () => ({ active: [beacon], archived: [] })));
});
const reads = () => rpc.mock.calls.filter(([method]) => method === 'list.page').map(([, params]) => params);
const page = async (store: Awaited<ReturnType<typeof startStore>>) => render((await import('../../src/renderer/screens/project.js')).Project({ state: store.getState(), project: beacon }));

describe('the feed on a project page', () => {
  it('a page More could not read says why below the rows, and Try again reads only it', async () => {
    const store = await startStore(); await store.openProject(beacon);
    held.hold('list.page')(fail('unavailable', { retryable: true }));
    await store.moreList();
    expect(store.getState().list).toMatchObject({ failure: { code: 'unavailable' }, next: 'c2' });
    expect(store.getState().list?.items).toHaveLength(10);
    const shown = await page(store);
    expect(text(byTestId(shown, 'feed-failure'))).toContain('ECHO is unavailable right now.');
    expect(byTestId(shown, 'feed-error')).toHaveLength(0);
    expect(byTestId(shown, 'feed-row')).toHaveLength(10);
    await store.retryList();
    expect(reads().map(params => params.cursor)).toEqual([undefined, 'c2', 'c2']);
    expect(store.getState().list?.items).toHaveLength(13);
    expect(store.getState().list?.failure).toBeUndefined();
    expect(store.getState().list?.next).toBeNull();
  });

  it('a save keeps every row when its quiet read fails; the next read leads with the new note', async () => {
    const store = await startStore(); await store.openProject(beacon); await store.moreList();
    held.hold('list.page')(fail('unavailable', { retryable: true }));
    store.openCompose(); store.setComposeText('Beacon standup'); await store.sendCompose(); await flush();
    expect(store.getState().toast).toBe('Saved to Beacon');
    expect(store.getState().list?.items).toHaveLength(13);
    expect(store.getState().list?.failure).toBeUndefined();
    for (const id of ['feed-error', 'feed-failure']) expect(byTestId(await page(store), id)).toHaveLength(0);
    held.hold('list.page')(ok({ items: [row('Beacon standup', 21), ...notes.slice(0, 9)], next_cursor: 'c2b', meetings_held: false }));
    store.openCompose(); store.setComposeText('Beacon standup'); await store.sendCompose(); await flush();
    expect(store.getState().list?.items).toHaveLength(14);
    expect(store.getState().list?.items[0]?.title).toBe('Beacon standup');
    expect(store.getState().list?.items.at(-1)?.title).toBe('Note 12');
    expect(store.getState().list?.next).toBeNull();
    expect(reads()).toHaveLength(4);
  });

  it.each([['only-me', 'Only me · '], ['project', ''], ['team', 'Organization · ']] as const)('the reader labels a %s original', async (audience, prefix) => {
    const store = await startStore(); await store.openProject(beacon);
    held.hold('open.ref')(ok({ kind: 'note', content: { context_id: 'ctx_note', title: 'A note', text: 'Words', audience,
      project_ids: [beacon.project_id], received_at: '2026-09-20T10:00:00.000Z' } }));
    await store.openListItem(row('note', 10));
    const { Reader } = await import('../../src/renderer/screens/reader.js');
    const shown = render(Reader({ state: store.getState(), reader: store.getState().reader!, backTo: 'Beacon' }));
    const meta = text(byTestId(shown, 'reader-meta'));
    if (prefix) expect(meta.startsWith(prefix)).toBe(true);
    else expect(meta).not.toMatch(/Only me|Organization/);
  });
});
