// Only me's rows (One place to look v1, variant I): a grey kind mark, the title, a tile per project it is filed in, and a short
// age. Rows carry project names only (ADR-0024 N-20), so a tile takes its hue from the one project of yours with that name.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../../src/renderer/store.js';
import type { ListItem } from '../../src/shared/protocol.js';
import { identity } from '../../src/renderer/format.js';
import { ACCOUNT, byTestId, elements, plainHooks, project, render, text, type Node } from './harness.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

/** Thursday Oct 30, 12:00 here: every time below is local, so the test reads the same in any time zone. */
const NOW = new Date(2026, 9, 30, 12, 0).getTime();
const at = (day: number, hour = 9, minute = 0, month = 9) => new Date(2026, month, day, hour, minute).toISOString();
const APOLLO = project(1, 30, { name: 'Apollo' });
const BEACON = project(2, 29, { name: 'Beacon' });
const COMET = project(3, 28, { name: 'Comet' });

function item(title: string, extra: Partial<ListItem> = {}): ListItem {
  return { ref: { kind: 'note', id: `ctx_${title}` }, title, added_at: at(30), visibility: 'only-me', projects: [], ...extra };
}

async function row(of: ListItem, projects = [APOLLO, BEACON, COMET]): Promise<Node> {
  const { OnlyMeRow, projectsByName } = await import('../../src/renderer/screens/only-me-row.js');
  return render(OnlyMeRow({ item: of, byName: projectsByName(projects), now: NOW, onOpen: () => undefined })) as Node;
}

/** Each element's type and attributes, without what Preact numbers every node with. */
const shape = (tree: unknown) => elements(tree).map(({ type, props: { children, ...attributes } }) => [type, attributes]);
const tiles = (tree: Node) => elements(byTestId(tree, 'only-me-tiles')[0]).filter(node => String(node.props.class ?? '').includes('alt-tile'));

beforeEach(() => { vi.useFakeTimers({ now: NOW }); });

describe('the age', () => {
  it('is the time today, days under a week, then the day', async () => {
    const { shortAge } = await import('../../src/renderer/screens/only-me-row.js');
    expect(shortAge(at(30, 10, 12), NOW)).toBe('10:12');
    expect(shortAge(at(30, 0, 0), NOW)).toBe('00:00');
    expect(shortAge(at(29, 23, 59), NOW)).toBe('1d');
    expect(shortAge(at(28, 0, 1), NOW)).toBe('2d');
    expect(shortAge(at(24, 9), NOW)).toBe('6d');
    expect(shortAge(at(23, 23, 59), NOW)).toBe('Oct 23');
    expect(shortAge(at(18, 9, 0, 8), NOW)).toBe('Sep 18');
    // A clock a little ahead of this one still reads as today.
    expect(shortAge(at(30, 12, 5), NOW)).toBe('12:05');
    expect(shortAge('not a time', NOW)).toBe('');
  });

  it('tells today’s time in the time zone you are in now, not the one ECHO started in', async () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      vi.resetModules();
      const { shortAge } = await import('../../src/renderer/screens/only-me-row.js');
      // Flown to Tokyo with ECHO running: 09:00 there is 20:00 the evening before in New York.
      process.env.TZ = 'Asia/Tokyo';
      const added = at(30, 9, 0);
      expect(new Date(added).getHours()).toBe(9);
      expect(shortAge(added, new Date(2026, 9, 30, 12, 0).getTime())).toBe('09:00');
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
      vi.resetModules();
    }
  });

  it('says when it was added on hover', async () => {
    const tree = await row(item('Supplier sync', { added_at: at(30, 9, 30) }));
    const age = byTestId(tree, 'only-me-age')[0]!;
    expect(text(age)).toBe('09:30');
    expect(age.props.title).toMatch(/^Added Oct 30, 9:30\s?AM$/);
  });
});

describe('the tiles', () => {
  it('one per project, in the hue of the one project of yours with that name, and the hover names them', async () => {
    const tree = await row(item('Launch risks', { projects: ['Apollo', 'Beacon'] }));
    expect(tiles(tree).map(tile => [text(tile), tile.props.style])).toEqual([['A', identity(APOLLO.project_id)], ['B', identity(BEACON.project_id)]]);
    expect(byTestId(tree, 'only-me-tiles')[0]!.props.title).toBe('Apollo, Beacon');
    expect(tree.props['aria-label']).toMatch(/^Note: Launch risks\. Filed in Apollo, Beacon\. Added Oct 30, 9:00\sAM$/);
  });

  it('a name none of your projects has, or two of them share, gets a neutral tile, still named on hover', async () => {
    const twins = [APOLLO, BEACON, project(4, 27, { name: 'Beacon' })];
    const tree = await row(item('Supplier call notes', { projects: ['Apollo', 'Beacon', 'Retired'] }), twins);
    const shown = tiles(tree);
    expect(shown.map(text)).toEqual(['A', 'B', 'R']);
    expect(shown[0]!.props.style).toEqual(identity(APOLLO.project_id));
    for (const neutral of shown.slice(1)) {
      expect(neutral.props.class).toBe('alt-tile only-me-unplaced');
      expect(neutral.props.style).toBeUndefined();
    }
    expect(byTestId(tree, 'only-me-tiles')[0]!.props.title).toBe('Apollo, Beacon, Retired');
  });

  it('shows at most three, then how many more; the hover and the label name every one', async () => {
    const many = ['Apollo', 'Beacon', 'Comet', 'Dune', 'Echo'];
    const tree = await row(item('Pricing', { projects: many }));
    expect(tiles(tree).map(text)).toEqual(['A', 'B', 'C']);
    expect(text(byTestId(tree, 'only-me-tiles-more')[0])).toBe('+2');
    expect(byTestId(tree, 'only-me-tiles')[0]!.props.title).toBe(many.join(', '));
    expect(tree.props['aria-label']).toContain(`Filed in ${many.join(', ')}.`);
  });

  it('a row filed nowhere has none, and its label says nothing of projects', async () => {
    const tree = await row(item('Pricing decision'));
    expect(tiles(tree)).toEqual([]);
    expect(byTestId(tree, 'only-me-tiles')[0]!.props.title).toBeUndefined();
    expect(tree.props['aria-label']).not.toContain('Filed');
  });
});

describe('the kind mark', () => {
  it('a grey shape per kind, with no box and no lock; a file\'s hover gives its type and size', async () => {
    const { Calendar, Note, Page } = await import('../../src/renderer/screens/icons.js');
    const kinds = [
      [item('Notes'), 'note', 'Note', Note],
      [item('Review', { ref: { kind: 'meeting', id: 'sha256:1' } }), 'meeting', 'Meeting', Calendar],
      [item('Imported', { ref: { kind: 'imported_meeting', id: 'sha256:2' } }), 'imported_meeting', 'Meeting', Calendar],
      [item('Contract', { ref: { kind: 'document', id: 'doc_1' }, document: { type: 'pdf', size: 2_100_000, extraction: 'ready' } }), 'document', 'File · PDF · 2.1 MB', Page],
    ] as const;
    for (const [of, kind, title, Icon] of kinds) {
      const tree = await row(of);
      expect(tree.props['data-kind']).toBe(kind);
      expect(tree.props['data-testid']).toBe('only-me-row');
      const mark = byTestId(tree, 'only-me-kind')[0]!;
      expect(mark.props.title).toBe(title);
      expect(shape(mark.props.children)).toEqual(shape(render(Icon())));
      expect(tree.props['aria-label']).toMatch(new RegExp(`^${title.split(' · ')[0]}: ${of.title}\\.`));
      // No boxed icon, and nothing on who can read it: every row here is only yours.
      expect(elements(tree).filter(node => /\b(item-icon|mark)\b/.test(String(node.props.class ?? '')))).toEqual([]);
      expect(elements(tree).filter(node => /Only me|Organization/.test(String(node.props['aria-label'] ?? '') + String(node.props.title ?? '')))).toEqual([]);
    }
  });
});

describe('Only me', () => {
  async function page(items: ListItem[], projects: Partial<State['projects']>, list: State['altitude']['list'] = null): Promise<Node> {
    const { getState } = await import('../../src/renderer/store.js');
    const { OnlyMe } = await import('../../src/renderer/screens/only-me.js');
    const base = getState();
    const state: State = {
      ...base, status: { client_version: 'test', signed_in: true, account: ACCOUNT },
      projects: { items: [APOLLO, BEACON], next: null, loading: false, ...projects },
      altitude: { ...base.altitude, list },
      list: { scope: { kind: 'only-me' }, opened: 1, items, next: 'more', loading: false },
    };
    return render(OnlyMe({ state })) as Node;
  }

  it('lists every row newest first in the new row, with More after them', async () => {
    const tree = await page([item('Pricing decision'), item('Supplier call notes', { projects: ['Apollo'] })], {});
    expect(byTestId(tree, 'only-me-row').map(each => text(byTestId(each, 'only-me-title')[0]))).toEqual(['Pricing decision', 'Supplier call notes']);
    expect(tiles(byTestId(tree, 'only-me-row')[1]!).map(tile => tile.props.style)).toEqual([identity(APOLLO.project_id)]);
    expect(text(byTestId(tree, 'only-me-more')[0])).toBe('More');
  });

  it('finds a project past the sidebar\'s pages in the whole list Home read', async () => {
    const tree = await page([item('Comet notes', { projects: ['Comet'] })], { next: 'page-2' }, [APOLLO, BEACON, COMET]);
    expect(tiles(byTestId(tree, 'only-me-row')[0]!).map(tile => tile.props.style)).toEqual([identity(COMET.project_id)]);
  });
});
