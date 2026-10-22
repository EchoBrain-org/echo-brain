import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../../src/renderer/store.js';
import type { UpdateState } from '../../src/shared/protocol.js';
import { elements, text } from './harness.js';

const { loadProjects, loadArchivedProjects, installUpdate, openNewProject } = vi.hoisted(() => ({
  loadProjects: vi.fn(), loadArchivedProjects: vi.fn(), installUpdate: vi.fn(), openNewProject: vi.fn(),
}));
vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  // Keep the archived section expanded for these component-level checks.
  useState: () => [true, vi.fn()],
}));
vi.mock('../../src/renderer/store.js', async original => ({
  ...await original<typeof import('../../src/renderer/store.js')>(), loadProjects, loadArchivedProjects, installUpdate, openNewProject,
}));

beforeEach(() => { vi.clearAllMocks(); });

async function projectFailure(archived: boolean): Promise<State> {
  const { getState } = await import('../../src/renderer/store.js');
  return {
    ...getState(),
    status: { client_version: 'test', signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } },
    [archived ? 'archivedProjects' : 'projects']: { items: [], next: null, loading: false, failure: { code: 'unavailable', retryable: true } },
    home: { seq: 1, loading: false, meetings: true, reviews: [], runs: [], open: null, live: {}, reading: false },
  };
}

describe('project list failures', () => {
  it.each([false, true])('keeps a retry available for an empty failed project list, archived: %s', async archived => {
    const state = await projectFailure(archived);
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    const tree = elements(Sidebar({ state }));
    const failure = tree.find(node => node.props['data-testid'] === (archived ? 'archived-projects-error' : 'sidebar-projects-error'));
    expect(failure).toBeDefined();
    expect(failure?.props.children).toContain('ECHO is unavailable right now. Try again.');
    const retry = elements(failure).find(node => node.type === 'button');
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

describe('New project', () => {
  /** Signed in with no projects at all: the list read, nothing in it, nothing failed. */
  async function noProjects(): Promise<State> {
    const { getState } = await import('../../src/renderer/store.js');
    return {
      ...getState(), route: { page: 'home' },
      status: { client_version: 'test', signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } },
      projects: { items: [], next: null, loading: false },
      home: { seq: 1, loading: false, meetings: true, reviews: [], runs: [], open: null, live: {}, reading: false },
    };
  }

  it('is the Projects header\'s "+", there even with no projects, and no longer a row of its own', async () => {
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    const tree = elements(Sidebar({ state: await noProjects() }));
    const header = tree.find(node => node.props['data-testid'] === 'sidebar-projects-header');
    expect(header).toBeDefined();
    expect(text(header)).toBe('Projects');
    const plus = elements(header).find(node => node.props['data-testid'] === 'sidebar-new-project');
    expect(plus?.type).toBe('button');
    expect(plus?.props['aria-label']).toBe('New project');
    expect(plus?.props.title).toBe('New project');
    (plus?.props.onClick as () => void)();
    expect(openNewProject).toHaveBeenCalledExactlyOnceWith();
    // The top block keeps Home, Capture, Mine and Follow-ups only.
    const rows = tree.filter(node => typeof node.props.class === 'string' && node.props.class.split(' ').includes('side-row'));
    expect(rows.map(node => node.props['data-testid'])).toEqual(['sidebar-home', 'sidebar-capture', 'sidebar-mine', 'sidebar-follow-ups', 'sidebar-tools']);
  });

  it('is not offered while signed out', async () => {
    const { getState } = await import('../../src/renderer/store.js');
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    const tree = elements(Sidebar({ state: { ...getState(), status: { client_version: 'test', signed_in: false, account: null } } }));
    expect(tree.some(node => node.props['data-testid'] === 'sidebar-projects-header' || node.props['data-testid'] === 'sidebar-new-project')).toBe(false);
  });
});

describe('your follow-ups (F9)', () => {
  /** The store's first state, signed in, with no projects at all, Home read, on `route`. */
  async function signedIn(route: State['route']): Promise<State> {
    const { getState } = await import('../../src/renderer/store.js');
    return {
      ...getState(), route,
      status: { client_version: 'test', signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } },
      home: { seq: 1, loading: false, meetings: true, reviews: [], runs: [], open: null, live: {}, reading: false },
    };
  }

  it('are in the sidebar under Mine, current on their own page, Home then not', async () => {
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    const rows = (state: State) => elements(Sidebar({ state })).filter(node => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('sidebar-'));
    const shown = rows(await signedIn({ page: 'follow-ups' }));
    const order = shown.map(node => node.props['data-testid']);
    expect(order.indexOf('sidebar-follow-ups')).toBe(order.indexOf('sidebar-mine') + 1);
    expect(shown.find(node => node.props['data-testid'] === 'sidebar-follow-ups')?.props['aria-current']).toBe('page');
    expect(shown.find(node => node.props['data-testid'] === 'sidebar-home')?.props['aria-current']).toBeUndefined();
    const home = rows(await signedIn({ page: 'home' }));
    expect(home.find(node => node.props['data-testid'] === 'sidebar-follow-ups')?.props['aria-current']).toBeUndefined();
  });
});

const RELEASE = 'clean-v1-release-b';
const HELD = { code: 'update_held', retryable: true };

/** The update row over the store's first state, with this row and anything else set. */
async function updateRow(update: UpdateState, extra: Partial<State> = {}) {
  const { getState } = await import('../../src/renderer/store.js');
  const { UpdateRow } = await import('../../src/renderer/screens/sidebar.js');
  const shown = UpdateRow({ state: { ...getState(), update, ...extra } });
  const tree = elements(shown);
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
    expect(elements(row).some(node => node.props.class === 'asking')).toBe(update.state === 'installing');
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
