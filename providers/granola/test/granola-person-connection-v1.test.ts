import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaPersonConnectionV1 } from '../src/granola-person-connection-v1.js';
import { GRANOLA_PERSON_PROVIDER_V1 } from '../src/granola-mcp-v1.js';

const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'member-fixture' };
const workspace = '00000000-0000-4000-8000-000000000001';
describe('Granola verified account and folder access', () => {
  it.each(['account', 'workspace', 'incomplete', 'plan'] as const)('invalidates a read when %s changes', async change => {
    const db = new Database(':memory:');
    try {
      let changed = false, tags: Readonly<Record<string, string>> = {};
      const store = new PersonConnectionStoreV1(db, GRANOLA_PERSON_PROVIDER_V1);
      const service = createGranolaPersonConnectionV1({ store,
        authenticate: () => ({ ...person, authorization_sha256: canonicalSha256(person) }),
        nango: { connect: async value => { tags = value; return { link: 'https://connect.nango.dev/fixture' }; },
          find: async () => 'reference', connection: async () => ({ tags, access_token: 'fixture-only' }), disconnect: async () => {} },
        fetch: vi.fn(async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          if (changed && change === 'plan' && request.params.name === 'list_meetings') return new Response('', { status: 403 });
          const value = request.params.name === 'get_account_info' ? {
            email: changed && change === 'account' ? 'other@example.test' : 'fixture@example.test',
            active_workspace: { id: changed && change === 'workspace' ? '00000000-0000-4000-8000-000000000002' : workspace, display_name: 'ECHO' },
            mcp_note_access: { scopes: ['personal', 'public'] },
          } : request.params.name === 'list_meeting_folders' ? { count: 1, folders: [{ id: workspace, title: 'ECHO', description: null, note_count: changed && change === 'incomplete' ? 1 : 0 }] }
            : { count: 0, total_in_range: 0, meetings: [] };
          return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
        }),
      });
      const consent = await service.connect({ access_token: 'session' });
      expect(await service.status({ access_token: 'session', attempt: consent.attempt })).toMatchObject({ status: 'complete' });
      const first = await service.open(person, () => {});
      const reconnect = await service.connect({ access_token: 'session' });
      expect(await service.status({ access_token: 'session', attempt: reconnect.attempt })).toMatchObject({ status: 'complete' });
      const current = await service.open(person, () => {});
      expect(current.identity).toEqual(first.identity);
      expect(() => first.current()).toThrow();
      changed = true;
      await expect(current.folder(workspace)).rejects.toThrow();
      if (change === 'account' || change === 'workspace') {
        expect(store.current(person)?.active).toBe(false);
        expect(() => current.current()).toThrow();
      }
    } finally { db.close(); }
  });
});
