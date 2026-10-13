import type { VNode } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../../src/renderer/store.js';
import type { UpdateState } from '../../src/shared/protocol.js';

const { loadProjects, loadArchivedProjects, installUpdate } = vi.hoisted(() => ({ loadProjects: vi.fn(), loadArchivedProjects: vi.fn(), installUpdate: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  // Keep the archived section expanded for these component-level checks.
  useState: () => [true, vi.fn()],
}));
vi.mock('../../src/renderer/store.js', async original => ({
  ...await original<typeof import('../../src/renderer/store.js')>(), loadProjects, loadArchivedProjects, installUpdate,
}));

beforeEach(() => { vi.clearAllMocks(); });

function descendants(value: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as VNode<Record<string, unknown>>;
  return [node, ...descendants(node.props.children)];
}

async function projectFailure(archived: boolean): Promise<State> {
  const { getState } = await import('../../src/renderer/store.js');
  return {
    ...getState(),
    status: { client_version: 'test', signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } },
    [archived ? 'archivedProjects' : 'projects']: { items: [], next: null, loading: false, failure: { code: 'unavailable', retryable: true } },
    home: { seq: 1, loading: false, rows: [], meetings: true, reviews: [], runs: [], open: null, closing: {}, closeFailures: {}, sent: {} },
  };
}

describe('project list failures', () => {
  it.each([false, true])('keeps a retry available for an empty failed project list, archived: %s', async archived => {
    const state = await projectFailure(archived);
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    const tree = descendants(Sidebar({ state }));
    const failure = tree.find(node => node.props['data-testid'] === (archived ? 'archived-projects-error' : 'sidebar-projects-error'));
    expect(failure).toBeDefined();
    expect(failure?.props.children).toContain('ECHO is unavailable right now. Try again.');
    const retry = descendants(failure).find(node => node.type === 'button');
    expect(retry?.props.children).toBe('Try again');
    (retry?.props.onClick as () => void)();
    expect(archived ? loadArchivedProjects : loadProjects).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, true])('does not present a failed project read as an empty account, archived: %s', async archived => {
    const state = await projectFailure(archived);
    const { Home } = await import('../../src/renderer/screens/home.js');
    expect(Home({ state }).props['data-testid']).not.toBe('home-empty');
  });
});

const RELEASE = 'clean-v1-release-b';
const HELD = { code: 'update_held', retryable: true };

/** The words a node shows, its children's included. */
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as VNode<Record<string, unknown>>).props.children);
}

/** The update row over the store's first state, with this row and anything else set. */
async function updateRow(update: UpdateState, extra: Partial<State> = {}) {
  const { getState } = await import('../../src/renderer/store.js');
  const { UpdateRow } = await import('../../src/renderer/screens/sidebar.js');
  const shown = UpdateRow({ state: { ...getState(), update, ...extra } });
  const tree = descendants(shown);
  return {
    shown, tree,
    row: tree.find(node => node.props['data-testid'] === 'sidebar-update'),
    note: tree.find(node => node.props['data-testid'] === 'sidebar-update-note'),
  };
}

describe('the update row', () => {
  it('is not there while there is no new version', async () => {
    expect((await updateRow({ state: 'none' })).shown).toBeNull();
  });

  it.each([
    [{ state: 'available', release: RELEASE }, 'New version · Restart'],
    [{ state: 'restart', release: RELEASE }, 'New version · Restart'],
    [{ state: 'failed', release: RELEASE, reason: 'failed' }, 'Couldn\'t update · Try again'],
  ] as const)('%o is one button, "%s", that installs', async (update, words) => {
    const { row, note } = await updateRow(update);
    expect(row?.type).toBe('button');
    expect(text(row)).toBe(words);
    // Home says Update for open items: nothing clickable here does.
    expect(text(row)).not.toMatch(/Update/);
    expect(note).toBeUndefined();
    (row?.props.onClick as () => void)();
    expect(installUpdate).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    [{ state: 'installing', release: RELEASE }, 'Updating'],
    [{ state: 'failed', release: RELEASE, reason: 'location' }, 'Move ECHO to Applications to update'],
  ] as const)('%o only says "%s"', async (update, words) => {
    const { tree, row } = await updateRow(update);
    // Still the one button, so a keyboard click keeps focus, but unavailable and inert.
    expect(row?.type).toBe('button');
    expect(row?.props['aria-disabled']).toBe('true');
    expect(text(row)).toBe(words);
    expect(tree.some(node => node.props.onClick !== undefined)).toBe(false);
    // Installing shows the busy dots.
    expect(descendants(row).some(node => node.props.class === 'asking')).toBe(update.state === 'installing');
  });

  it.each([
    [HELD, {}, 'Finish the current save first.'],
    [HELD, { compose: { status: 'unknown' } }, 'A save may not have arrived. Check it in Capture first.'],
    [HELD, { change: { status: 'unknown' } }, 'A project change may not have finished. Try it again or dismiss it first.'],
    [{ code: 'invalid_request', retryable: false }, {}, 'That cannot be sent.'],
  ])('says under the row what to settle first, as sign out does, or any other refusal in the standard words: %o %o', async (failure, extra, words) => {
    const { row, note } = await updateRow({ state: 'available', release: RELEASE }, { ...extra, updateFailure: failure } as Partial<State>);
    expect(text(row)).toBe('New version · Restart');
    expect(text(note)).toBe(words);
  });

  it('neither takes a dropped file nor lets the window capture it', async () => {
    const { tree } = await updateRow({ state: 'available', release: RELEASE });
    const holder = tree[0]!;
    for (const handler of ['onDragOver', 'onDrop']) {
      const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
      (holder.props[handler] as (event: unknown) => void)(event);
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});
