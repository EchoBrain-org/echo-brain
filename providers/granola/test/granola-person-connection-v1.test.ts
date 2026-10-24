import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaPersonConnectionV1 } from '../src/granola-person-connection-v1.js';
import { GRANOLA_PERSON_PROVIDER_V1 } from '../src/granola-mcp-v1.js';

const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'member-fixture' };
const workspace = '00000000-0000-4000-8000-000000000001';
const folder = '00000000-0000-4000-8000-0000000000f1';
const window = { mode: 'folder', folder, from_date: '2026-10-17', to_date: '2026-10-25' } as const;
/** A connected person's session whose Granola answers through `answer`, with every call recorded. */
async function connected(db: Database.Database, answer: (name: string) => unknown) {
  let tags: Readonly<Record<string, string>> = {};
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const store = new PersonConnectionStoreV1(db, GRANOLA_PERSON_PROVIDER_V1);
  const service = createGranolaPersonConnectionV1({ store,
    authenticate: () => ({ ...person, authorization_sha256: canonicalSha256(person) }),
    nango: { connect: async value => { tags = value; return { link: 'https://connect.nango.dev/fixture' }; },
      find: async () => 'reference', connection: async () => ({ tags, access_token: 'fixture-only' }), disconnect: async () => {} },
    fetch: vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.params);
      const value = answer(request.params.name);
      if (value instanceof Response) return value;
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } });
    }),
  });
  const consent = await service.connect({ access_token: 'session' });
  expect(await service.status({ access_token: 'session', attempt: consent.attempt })).toMatchObject({ status: 'complete' });
  return { service, store, calls };
}
const account = (email = 'fixture@example.test', id = workspace) => ({ email, active_workspace: { id, display_name: 'ECHO' }, mcp_note_access: { scopes: ['personal', 'public'] } });
const folders = { count: 1, folders: [{ id: folder, title: 'ECHO', description: null, note_count: 300 }] };
const empty = { count: 0, total_in_range: 0, meetings: [] };

describe('Granola verified account and meeting listings', () => {
  it.each(['account', 'workspace', 'plan', 'full'] as const)('invalidates a read when %s changes', async change => {
    const db = new Database(':memory:');
    try {
      let changed = false;
      const { service, store } = await connected(db, name => {
        if (changed && change === 'plan' && name === 'list_meetings') return new Response('', { status: 403 });
        if (name === 'get_account_info') return account(changed && change === 'account' ? 'other@example.test' : undefined, changed && change === 'workspace' ? '00000000-0000-4000-8000-000000000002' : workspace);
        if (name === 'list_meeting_folders') return folders;
        return changed && change === 'full' ? '<meetings_data count="0"></meetings_data><pagination has_more="false" total_count="201" />' : empty;
      });
      const first = await service.open(person, () => {});
      const reconnect = await service.connect({ access_token: 'session' });
      expect(await service.status({ access_token: 'session', attempt: reconnect.attempt })).toMatchObject({ status: 'complete' });
      const current = await service.open(person, () => {});
      expect(current.identity).toEqual(first.identity);
      expect(() => first.current()).toThrow();
      // A folder of any size can be watched: the window, not the folder, is bounded.
      expect(await current.window(window)).toEqual([]);
      changed = true;
      await expect(current.window(window)).rejects.toThrow();
      if (change === 'full') await expect(current.window(window)).rejects.toMatchObject({ code: 'unavailable', message: 'Granola lists more than 200 meetings to watch' });
      if (change === 'account' || change === 'workspace') {
        expect(store.current(person)?.active).toBe(false);
        expect(() => current.current()).toThrow();
      }
    } finally { db.close(); }
  });
  it('browses the newest 50 meetings the person captured, or a listed folder\'s', async () => {
    const db = new Database(':memory:');
    try {
      const { service, calls } = await connected(db, name => name === 'get_account_info' ? account() : name === 'list_meeting_folders' ? folders : empty);
      const session = await service.open(person, () => {});
      calls.length = 0;
      expect(await session.recent(null)).toEqual([]);
      expect(await session.recent(folder)).toEqual([]);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const listed = { time_range: 'custom', from_date: '1970-01-01', to_date: tomorrow, limit: 50 };
      expect(calls.filter(call => call.name !== 'get_account_info')).toEqual([
        { name: 'list_meetings', arguments: { ...listed, involvement: { captured_by_me: true } } },
        { name: 'list_meeting_folders', arguments: { limit: 100, offset: 0 } },
        { name: 'list_meetings', arguments: { ...listed, folder_id: folder } },
      ]);
      await expect(session.recent('00000000-0000-4000-8000-0000000000f2')).rejects.toMatchObject({ code: 'not_found' });
      await expect(session.window({ ...window, mode: 'mine' })).rejects.toMatchObject({ code: 'invalid_request' });
    } finally { db.close(); }
  });
});
