import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaPersonConnectionV1, createGranolaProjectMappingStoreV1 } from '../src/granola-person-connection-v1.js';
import { GRANOLA_PERSON_PROVIDER_V1 } from '../src/granola-mcp-v1.js';
import { granolaWatchWindowV1 } from '../src/granola-watch-source-v1.js';

const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'member-fixture' };
const workspace = '00000000-0000-4000-8000-000000000001';
const folder = '00000000-0000-4000-8000-0000000000f1';
const window = { mode: 'folder', folder, from_date: '2026-10-17', to_date: '2026-10-25' } as const;
/** A connected person's session whose Granola answers through `answer`, with every call recorded. */
async function connected(db: Database.Database, answer: (name: string, args: Record<string, unknown>) => unknown, project?: { role: 'lead' | 'member'; revision: number; denied?: boolean }, who = person) {
  const person = who;
  let tags: Readonly<Record<string, string>> = {};
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const store = new PersonConnectionStoreV1(db, GRANOLA_PERSON_PROVIDER_V1);
  const service = createGranolaPersonConnectionV1({ store,
    ...(project === undefined ? {} : { project_mappings: createGranolaProjectMappingStoreV1(db),
      authorize_project: () => {
        if (project.denied === true) GRANOLA_PERSON_PROVIDER_V1.failure('unauthorized');
        return { role: project.role, authorization_sha256: canonicalSha256(project) };
      } }),
    authenticate: () => ({ ...person, authorization_sha256: canonicalSha256(person) }),
    nango: { connect: async value => { tags = value; return { link: 'https://connect.nango.dev/fixture' }; },
      find: async () => `reference-${who.principal_id}`, connection: async () => ({ tags, access_token: 'fixture-only' }), disconnect: async () => {} },
    fetch: vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.params);
      const value = answer(request.params.name, request.params.arguments);
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
  it('maps folders independently of watches and fences reads on mapping, project grant and connection changes', async () => {
    const db = new Database(':memory:');
    try {
      const project = { role: 'lead' as 'lead' | 'member', revision: 1 }, project_id = 'prj_11111111-1111-4111-8111-111111111111';
      const { service, store, calls } = await connected(db, name => name === 'get_account_info' ? account() : name === 'list_meeting_folders' ? folders : empty, project);
      const input = { access_token: 'session', request: { schema_version: 1, project_id } };
      expect(service.projectRead(input).mapping).toBeNull();
      const audit = { record: async () => canonicalSha256({ receipt: 1 }) };
      expect(await service.source({ access_token: 'session', project_id, audit })).toBeUndefined();
      const command = { schema_version: 1, project_id, expected_revision: null, request_id: '11111111-1111-4111-8111-111111111112', folder_ids: [folder] };
      const saved = await service.projectSet({ access_token: 'session', request: command });
      expect(saved.mapping).toEqual({ cloud_id: workspace, folder_ids: [folder] });
      expect(await service.projectSet({ access_token: 'session', request: command })).toEqual(saved);
      expect(calls.filter(call => call.name === 'list_meetings')).toEqual([]);
      const source = await service.source({ access_token: 'session', project_id, audit });
      expect(source).toBeDefined(); source!.assertCurrent();
      project.revision++;
      expect(() => source!.assertCurrent()).toThrow();
      const current = await service.source({ access_token: 'session', project_id, audit });
      await service.projectSet({ access_token: 'session', request: { ...command, request_id: '11111111-1111-4111-8111-111111111113', expected_revision: saved.revision, folder_ids: null } });
      expect(() => current!.assertCurrent()).toThrow();
      project.role = 'member';
      expect(service.projectRead(input).mapping).toBeNull();
      await expect(service.projectSet({ access_token: 'session', request: command })).rejects.toMatchObject({ code: 'unauthorized' });
      const global = await service.source({ access_token: 'session', audit });
      store.revoke(person);
      expect(() => global!.assertCurrent()).toThrow();
      expect(await service.source({ access_token: 'session', audit })).toBeUndefined();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      expect(tables.some(table => /source_contents|approval|candidate|meeting_sources/.test(table.name))).toBe(false);
    } finally { db.close(); }
  });
  it('gives a project member connected to another Granola workspace no Granola source, and reads nothing', async () => {
    const db = new Database(':memory:');
    try {
      const project_id = 'prj_11111111-1111-4111-8111-111111111111', other = '00000000-0000-4000-8000-000000000002';
      const lead = await connected(db, name => name === 'get_account_info' ? account() : name === 'list_meeting_folders' ? folders : empty, { role: 'lead', revision: 1 });
      await lead.service.projectSet({ access_token: 'session', request: { schema_version: 1, project_id, expected_revision: null, request_id: '11111111-1111-4111-8111-111111111112', folder_ids: [folder] } });
      const grant = { role: 'member' as 'lead' | 'member', revision: 1, denied: false };
      const member = await connected(db, name => name === 'get_account_info' ? account('member@example.test', other) : name === 'list_meeting_folders' ? folders : empty,
        grant, { ...person, principal_id: 'person-member', membership_id: 'member-member' });
      const audit = { record: async () => canonicalSha256({ receipt: 1 }) };
      member.calls.length = 0;
      expect(await member.service.source({ access_token: 'session', project_id, audit })).toBeUndefined();
      expect(member.calls).toEqual([]);
      // Without a grant on the project, the member is still refused.
      grant.denied = true;
      await expect(member.service.source({ access_token: 'session', project_id, audit })).rejects.toMatchObject({ code: 'unauthorized' });
      // The lead, in the mapped workspace, still reads it.
      expect(await lead.service.source({ access_token: 'session', project_id, audit })).toBeDefined();
    } finally { db.close(); }
  });
  it('checks cited meetings ten per Granola call, leaving out missing meetings and ids that are not Granola ids', async () => {
    const db = new Database(':memory:');
    try {
      const cited = Array.from({ length: 25 }, (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
      const missing = new Set([cited[3], cited[17]]);
      let broken: string | undefined;
      const row = (meeting: string) => `<meeting id="${meeting}" title="Standup" date="Oct 20, 2026 9:00 AM PDT" updated_at="${meeting === broken ? 'yesterday' : '2026-10-20T09:31:00.000-07:00'}" url="https://notes.granola.ai/d/${meeting}"><known_participants>Pat</known_participants></meeting>`;
      const { service, calls } = await connected(db, (name, args) => {
        if (name === 'get_account_info') return account();
        if (name !== 'get_meetings') return empty;
        const found = (args.meeting_ids as string[]).filter(meeting => !missing.has(meeting));
        return `<meetings_data count="${found.length}">${found.map(row).join('')}</meetings_data>`;
      });
      calls.length = 0;
      const versions = await service.pageVersions({ access_token: 'session', page_ids: [...cited, 'not-a-granola-id'] });
      expect(calls.filter(call => call.name === 'get_meetings')).toHaveLength(3);
      expect([...versions.keys()]).toEqual(cited.filter(meeting => !missing.has(meeting)));
      expect(new Set(versions.values())).toEqual(new Set(['2026-10-20T09:31:00.000-07:00']));
      // A meeting Granola answers unusably fails its batch's answer; that batch is read one by one and hides only it.
      broken = cited[12]; calls.length = 0;
      const again = await service.pageVersions({ access_token: 'session', page_ids: cited });
      expect(calls.filter(call => call.name === 'get_meetings')).toHaveLength(13);
      expect([...again.keys()]).toEqual(cited.filter(meeting => !missing.has(meeting) && meeting !== broken));
    } finally { db.close(); }
  });
  it('rejects folders outside the lead’s provider access and refuses stale saves before provider I/O', async () => {
    const db = new Database(':memory:');
    try {
      const { service, calls } = await connected(db, name => name === 'get_account_info' ? account() : folders, { role: 'lead', revision: 1 });
      const request = { schema_version: 1, project_id: 'prj_11111111-1111-4111-8111-111111111111', request_id: '11111111-1111-4111-8111-111111111112', expected_revision: null, folder_ids: ['00000000-0000-4000-8000-0000000000f2'] };
      await expect(service.projectSet({ access_token: 'session', request })).rejects.toMatchObject({ code: 'unauthorized' });
      const before = calls.length;
      await expect(service.projectSet({ access_token: 'session', request: { ...request, expected_revision: '11111111-1111-4111-8111-111111111113' } })).rejects.toMatchObject({ code: 'conflict' });
      expect(calls).toHaveLength(before);
    } finally { db.close(); }
  });
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
      if (change === 'full') await expect(current.window(window)).rejects.toMatchObject({ code: 'quota_exceeded', message: 'Granola lists more than 200 meetings to watch' });
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
      const listed = { time_range: 'custom', from_date: '1970-01-01', to_date: tomorrow, limit: 50, max_participants: 50 };
      expect(calls.filter(call => call.name !== 'get_account_info')).toEqual([
        { name: 'list_meetings', arguments: { ...listed, involvement: { captured_by_me: true } } },
        { name: 'list_meeting_folders', arguments: { limit: 100, offset: 0 } },
        { name: 'list_meetings', arguments: { ...listed, folder_id: folder } },
      ]);
      await expect(session.recent('00000000-0000-4000-8000-0000000000f2')).rejects.toMatchObject({ code: 'not_found' });
      await expect(session.window({ ...window, mode: 'mine' })).rejects.toMatchObject({ code: 'invalid_request' });
    } finally { db.close(); }
  });
  it('checks a watch at Save with the listing its worker uses: a listed folder and a window of at most 200 meetings', async () => {
    const db = new Database(':memory:');
    try {
      let full = false;
      const { service, calls } = await connected(db, name => name === 'get_account_info' ? account() : name === 'list_meeting_folders' ? folders
        : full ? '<meetings_data count="0"></meetings_data><pagination has_more="false" total_count="201" />' : empty);
      const session = await service.open(person, () => {});
      calls.length = 0;
      await session.watchable({ watch: 'mine', folder_id: null });
      await session.watchable({ watch: 'folder', folder_id: folder });
      const days = { time_range: 'custom', ...granolaWatchWindowV1(Date.now()), limit: 200, max_participants: 50 };
      expect(calls.filter(call => call.name !== 'get_account_info')).toEqual([
        { name: 'list_meetings', arguments: { ...days, involvement: { captured_by_me: true } } },
        { name: 'list_meeting_folders', arguments: { limit: 100, offset: 0 } },
        { name: 'list_meetings', arguments: { ...days, folder_id: folder } },
      ]);
      await expect(session.watchable({ watch: 'folder', folder_id: '00000000-0000-4000-8000-0000000000f2' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(session.watchable({ watch: 'off', folder_id: null })).rejects.toMatchObject({ code: 'invalid_request' });
      full = true;
      await expect(session.watchable({ watch: 'mine', folder_id: null })).rejects.toMatchObject({ code: 'quota_exceeded' });
    } finally { db.close(); }
  });
});
