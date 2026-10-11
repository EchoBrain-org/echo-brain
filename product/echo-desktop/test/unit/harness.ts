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
 * An rpc for the store: held replies first, then the test's own handlers,
 * then what every page needs to open quietly. Anything else is a test error.
 */
export function rpcFor(held: Held, handlers: Record<string, Handler>, lists: () => { active: ProjectSummary[]; archived: ProjectSummary[] }) {
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
