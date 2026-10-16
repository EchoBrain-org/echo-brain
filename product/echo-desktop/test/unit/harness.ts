// Shared by the store's unit tests: the Authority's answers as the host hands
// them to the renderer, with its real ordering and cursors, and a way to hold
// one reply back while later ones land.
import { vi } from 'vitest';
import type { ProjectSummary } from '../../src/shared/protocol.js';

export const ok = (value: unknown) => ({ ok: true, value });
export const fail = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false, failure: { code, retryable: false, ...extra } });
/** Enough turns of the microtask queue for a released reply to settle through the store. */
export const flush = async (turns = 30) => { for (let i = 0; i < turns; i += 1) await Promise.resolve(); };

export const ACCOUNT = { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } as const;

export const PROJECT_PAGE = 10;

/** A project, newest first by day: `project(1, 30)` was made on the 30th, `project(2, 29)` the day before. */
export function project(n: number, day: number, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: `prj_${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Project ${n}`, role: 'lead',
    created_at: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`, status: 'active', ...extra,
  };
}

/** `count` projects, Project 1 the newest, one a day. */
export function numbered(count: number): ProjectSummary[] {
  return Array.from({ length: count }, (_, index) => project(index + 1, 30 - index));
}

/** The Authority's order: created_at DESC, then project_id ASC. */
export function ordered(rows: readonly ProjectSummary[]): ProjectSummary[] {
  return [...rows].sort((a, b) => a.created_at === b.created_at ? (a.project_id < b.project_id ? -1 : 1) : (a.created_at < b.created_at ? 1 : -1));
}

/**
 * One page as `projects list-v2` returns it: a keyset cursor names the last
 * row's position and is never looked up, so a row that left the list does not
 * move the next page.
 */
export function keysetPage(rows: readonly ProjectSummary[], cursor: unknown): { items: ProjectSummary[]; next_cursor: string | null } {
  const sorted = ordered(rows);
  const [at, id] = typeof cursor === 'string' ? cursor.split('|') : [];
  const remaining = at ? sorted.filter(row => row.created_at < at || (row.created_at === at && row.project_id > id!)) : sorted;
  const items = remaining.slice(0, PROJECT_PAGE).map(row => ({ ...row }));
  return { items, next_cursor: remaining.length > PROJECT_PAGE ? `${items.at(-1)!.created_at}|${items.at(-1)!.project_id}` : null };
}

/** Replies held back by method: the next call of that method waits until `release` is called. */
export class Held {
  private readonly pending = new Map<string, Promise<unknown>[]>();
  hold(method: string): (value: unknown) => void {
    let release!: (value: unknown) => void;
    const reply = new Promise(resolve => { release = resolve; });
    this.pending.set(method, [...(this.pending.get(method) ?? []), reply]);
    return release;
  }
  take(method: string): Promise<unknown> | undefined { return this.pending.get(method)?.shift(); }
}

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * Moves of the change check's areas a test makes by hand: each bump moves
 * that area's fingerprint. The projects fingerprint also follows the lists,
 * so a project list changed elsewhere moves it by itself.
 */
export const moved = { projects: 0, follow_ups: 0, reviews: 0 };

/** A fingerprint as the Authority writes one: `sha256:` and 64 hex digits, here made from any text. */
export function digest(text: string): string {
  let hash = 0;
  for (const character of text) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `sha256:${hash.toString(16).padStart(8, '0').repeat(8)}`;
}

/** The change check, as `changes.read` answers it, for these lists and the moves made so far. */
export function changesFor(lists: { active: ProjectSummary[]; archived: ProjectSummary[] }, seconds = 60) {
  return ok({
    kind: 'echo-person-changes-v1', check_again_after_seconds: seconds,
    areas: { projects: digest(JSON.stringify([lists, moved.projects])), follow_ups: digest(`f${moved.follow_ups}`), reviews: digest(`r${moved.reviews}`) },
  });
}

/**
 * An rpc for the store: held replies first, then the test's own handlers,
 * then what every page needs to open quietly. Anything else is a test error.
 */
export function rpcFor(held: Held, handlers: Record<string, Handler>, lists: () => { active: ProjectSummary[]; archived: ProjectSummary[] }) {
  Object.assign(moved, { projects: 0, follow_ups: 0, reviews: 0 });
  return async (method: string, params: Record<string, unknown>) => {
    const pending = held.take(method);
    if (pending) return pending;
    const handler = handlers[method];
    if (handler) return handler(params);
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: ACCOUNT });
      case 'app.setUnresolved': return ok(null);
      case 'account.tools': return ok({ tools: [] });
      case 'projects.list': return ok(keysetPage(params.status === 'archived' ? lists().archived : lists().active, params.cursor));
      case 'projects.members': case 'people.directory': case 'projects.directory': return ok({ items: [], next_cursor: null });
      case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
      case 'projects.jiraRead': case 'projects.confluenceRead': return ok({ project_id: params.project_id, revision: null, mapping: null });
      case 'search.run': return ok({ items: [] });
      case 'ask.cancel': case 'notice.show': case 'log.changes': return ok(null);
      case 'changes.read': return changesFor(lists());
      case 'runs': return fail('unavailable', { retryable: true });
    }
    throw new Error(`Unexpected request: ${method}`);
  };
}

/** Fresh store module, signed in, with its first lists loaded. */
export async function startStore() {
  const store = await import('../../src/renderer/store.js');
  await store.refreshStatus();
  await flush();
  return store;
}

export function stubWindow(): void {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
}

export const names = (rows: readonly { name: string }[]) => rows.map(row => row.name);

/** The store's window, as main tells it where the window stands. */
interface Windowed {
  getState(): { concealed: boolean };
  windowState(next: { onScreen: boolean; front: boolean }): Promise<void> | null;
}

/** Another app comes in front: the page is covered. */
export function cover(store: Windowed): void { store.windowState({ onScreen: true, front: false }); }

/** ECHO is back in front, from another app: it came back. Answers the return's reads. */
export function uncover(store: Windowed): Promise<void> { return store.windowState({ onScreen: true, front: true }) ?? Promise.resolve(); }

/** The window is closed to the tray, minimized, or covered by other windows: ECHO in front or not, as it was. */
export function hide(store: Windowed): void { store.windowState({ onScreen: false, front: !store.getState().concealed }); }

/** The window is on screen again (restored, or uncovered by other windows): ECHO in front or not, as it was. */
export function unhide(store: Windowed): Promise<void> {
  return store.windowState({ onScreen: true, front: !store.getState().concealed }) ?? Promise.resolve();
}

/** The window comes forward (the tray, a shortcut, a notification): from off screen, on screen and in front. Answers the return's reads. */
export function show(store: Windowed): Promise<void> {
  hide(store);
  return uncover(store);
}

/** The machine wakes from sleep. */
export async function wake(): Promise<void> { (await import('../../src/renderer/freshness.js')).woke(); }
