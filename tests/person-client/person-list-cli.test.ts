import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

const now = '2026-09-29T20:01:00.000Z';
const projectId = 'prj_11111111-1111-4111-8111-111111111111';
const otherProject = 'prj_44444444-4444-4444-8444-444444444444';
const record = 'c'.repeat(64);
const NOTE = `note:ctx_${'a'.repeat(64)}`;
const DOCUMENT = `document:doc_${'b'.repeat(64)}`;
const MEETING = `meeting:sha256:${record}`;
const TRANSCRIPT = `transcript:sha256:${record}`;
const CURSOR = 'AnR3-page_2';
const homes: string[] = [];

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function setup(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-list-cli-')));
  homes.push(home);
  new PersonSessionStore(home).install('https://authority.example', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: 'Maya Chen', membership_type: 'employee',
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43),
    access_expires_at: '2026-09-29T20:11:00.000Z',
    refresh_expires_at: '2026-10-06T20:00:00.000Z', hard_reauthentication_at: '2026-10-06T20:00:00.000Z',
  });
  return home;
}

function json(value: unknown, status = 200): Response {
  return new Response(canonicalJson(value), { status, headers: { 'content-type': 'application/json' } });
}

/** Insignificant JSON whitespace pads a valid body to an exact wire size. */
function padded(value: unknown, bytes: number): Response {
  const text = canonicalJson(value);
  return new Response(text + ' '.repeat(bytes - Buffer.byteLength(text)), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function run(argv: readonly string[], fetch: typeof globalThis.fetch, home = setup()) {
  let stdout = ''; let stderr = '';
  const code = await runPersonClientCli(argv, { home_directory: home, now: () => now, fetch,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  return { code, stdout, stderr, home };
}

function oneLine(stdout: string): unknown {
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stdout.split('\n')).toHaveLength(2);
  return JSON.parse(stdout);
}

const project = { project_id: projectId, name: 'Apollo', role: 'member', status: 'active' } as const;
const noteRow = { ref: NOTE, kind: 'note', title: 'Pricing notes', added_at: '2026-09-21T21:30:00.000Z', visibility: 'only_me', projects: [] };
const meetingRow = { ref: MEETING, kind: 'meeting', title: 'Pricing review', added_at: '2026-09-21T18:00:00.000Z', visibility: 'team', projects: [{ project_id: projectId, name: 'Apollo' }], meeting_date: '2026-09-21' };
const globalHeader = { me: { display_name: 'Maya Chen', membership_type: 'employee' }, connected: [{ tool: 'slack', status: 'linked' }], projects: [project], projects_more: false };

function page(scope: unknown, header: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { schema_version: 1, kind: 'echo-person-list-v1', scope, ...header, items: [noteRow, meetingRow], next_cursor: null, ...extra };
}

function meetingOpen(extra: Record<string, unknown> = {}) {
  return { schema_version: 1, kind: 'echo-person-open-v1', ref: MEETING, item: meetingRow,
    atoms: [{ kind: 'decision', text: 'Annual plans first.', status: 'decided' }], next_cursor: null, ...extra };
}
const meetingDetail = { all_day: false, participants: ['Ari', 'Maya Chen'], participants_more: false, approved_by: 'Ari' };

/** Answers every list or open call with one response and records what was sent. */
function network(response: () => Response) {
  const sent: { path: string; method: string | undefined; authorization: string | null; body: string }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    sent.push({ path: new URL(String(url)).pathname, method: init?.method, authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
    return response();
  });
  return { fetch, sent };
}

describe('person list CLI', () => {
  it('sends the exact canonical list body for each scope and prints one JSON line', async () => {
    const cases: readonly [string[], Record<string, unknown>, unknown][] = [
      [['list'], { schema_version: 1 }, page({ kind: 'global' }, globalHeader, { next_cursor: CURSOR })],
      [['list', '--project', projectId], { schema_version: 1, project_id: projectId }, page({ kind: 'project', project_id: projectId }, { project })],
      [['list', '--mine'], { schema_version: 1, mine: true }, page({ kind: 'mine' }, {}, { notice: 'meetings_unavailable', next_cursor: CURSOR })],
      [['list', '--cursor', CURSOR], { schema_version: 1, cursor: CURSOR }, page({ kind: 'global' })],
      [['list', '--mine', '--cursor', CURSOR], { schema_version: 1, mine: true, cursor: CURSOR }, page({ kind: 'mine' })],
      [['list', '--project', projectId, '--cursor', CURSOR], { schema_version: 1, cursor: CURSOR, project_id: projectId }, page({ kind: 'project', project_id: projectId })],
    ];
    for (const [argv, body, response] of cases) {
      const { fetch, sent } = network(() => json(response));
      const result = await run(argv, fetch);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(sent).toEqual([{ path: '/v1/person/list', method: 'POST', authorization: `Bearer ${'A'.repeat(43)}`, body: canonicalJson(body) }]);
      expect(oneLine(result.stdout)).toEqual({ ok: true, result: response });
    }
  });

  it('refuses a scope pair or an unsupported list flag before the network', async () => {
    const cases = [
      ['list', '--project', projectId, '--mine'],
      ['ask', '--question', 'What did I decide?', '--project', projectId, '--mine'],
      ['list', '--kind', 'note'],
      ['list', '--limit', '10'],
      ['list', '--query', 'pricing'],
      ['list', '--since', '2026-09-01'],
      ['list', '--ref', NOTE],
      ['list', '--project', 'Apollo'],
      ['list', '--cursor', 'not a cursor'],
      ['list', '--cursor', 'A'.repeat(513)],
      ['list', 'extra'],
    ];
    for (const argv of cases) {
      const { fetch } = network(() => { throw new Error('network must not be used'); });
      const result = await run(argv, fetch);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
      expect(fetch).not.toHaveBeenCalled();
    }
    const combined = await run(['list', '--project', projectId, '--mine'], vi.fn<typeof globalThis.fetch>());
    expect(JSON.parse(combined.stderr)).toEqual({ ok: false, error: '--project and --mine cannot be combined with `echo-brain person list`' });
  });

  it('rejects list pages whose scope or header does not belong to the request', async () => {
    const cases: readonly [string[], unknown][] = [
      [['list', '--mine'], page({ kind: 'global' })],
      [['list'], page({ kind: 'mine' })],
      [['list', '--project', projectId], page({ kind: 'project', project_id: otherProject }, { project: { ...project, project_id: otherProject } })],
      [['list', '--cursor', CURSOR], page({ kind: 'global' }, globalHeader)],
      [['list', '--project', projectId, '--cursor', CURSOR], page({ kind: 'project', project_id: projectId }, { project })],
      [['list'], page({ kind: 'global' })],
      [['list', '--project', projectId], page({ kind: 'project', project_id: projectId })],
      [['list', '--mine'], page({ kind: 'mine' }, globalHeader)],
    ];
    for (const [argv, response] of cases) {
      const result = await run(argv, network(() => json(response)).fetch);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, action: 'list', code: 'invalid_response', status: 200 });
    }
  });

  it('reports a project-scope 401 without signing out', async () => {
    const result = await run(['list', '--project', projectId], network(() => json({ error: { code: 'unauthorized', message: 'request failed' } }, 401)).fetch);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, action: 'list', error: 'Person Authority rejected the request', code: 'unauthorized', status: 401 });
    expect(new PersonSessionStore(result.home).read().session.membership_id).toBe('mem_00000000-0000-4000-8000-000000000001');
  });

  it('accepts a 300 KiB list page and refuses one past the 320 KiB bound', async () => {
    const response = page({ kind: 'global' }, globalHeader);
    const accepted = await run(['list'], network(() => padded(response, 300 * 1024)).fetch);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(oneLine(accepted.stdout)).toEqual({ ok: true, result: response });
    const refused = await run(['list'], network(() => padded(response, 320 * 1024 + 1)).fetch);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ ok: false, action: 'list', code: 'response_too_large' });
  });
});

describe('person open CLI', () => {
  it('sends the exact canonical open body and prints one JSON line', async () => {
    const cases: readonly [string[], Record<string, unknown>, unknown][] = [
      [['open', '--ref', NOTE], { schema_version: 1, ref: NOTE },
        { schema_version: 1, kind: 'echo-person-open-v1', ref: NOTE, item: noteRow, text: 'Annual plans first.\n', next_cursor: null }],
      [['open', '--ref', MEETING], { schema_version: 1, ref: MEETING }, meetingOpen({ meeting: meetingDetail, transcript_ref: TRANSCRIPT, next_cursor: CURSOR })],
      [['open', '--ref', MEETING, '--cursor', CURSOR], { schema_version: 1, ref: MEETING, cursor: CURSOR }, meetingOpen()],
      [['open', '--ref', TRANSCRIPT, '--cursor', CURSOR], { schema_version: 1, ref: TRANSCRIPT, cursor: CURSOR },
        { schema_version: 1, kind: 'echo-person-open-v1', ref: TRANSCRIPT, text: 'Ari: annual first.', next_cursor: null }],
    ];
    for (const [argv, body, response] of cases) {
      const { fetch, sent } = network(() => json(response));
      const result = await run(argv, fetch);
      expect(result.code, result.stderr).toBe(0);
      expect(sent).toEqual([{ path: '/v1/person/open', method: 'POST', authorization: `Bearer ${'A'.repeat(43)}`, body: canonicalJson(body) }]);
      expect(oneLine(result.stdout)).toEqual({ ok: true, result: response });
    }
  });

  it('opens a full 8 KiB note, whose escaped text passes the old 16 KiB note bound', async () => {
    const response = { schema_version: 1, kind: 'echo-person-open-v1', ref: NOTE, item: noteRow, text: '\t'.repeat(8191) + 'x', next_cursor: null };
    expect(Buffer.byteLength(canonicalJson(response))).toBeGreaterThan(16384);
    const result = await run(['open', '--ref', NOTE], network(() => json(response)).fetch);
    expect(result.code, result.stderr).toBe(0);
    expect(oneLine(result.stdout)).toEqual({ ok: true, result: response });
  });

  it('refuses a missing or malformed ref or cursor before the network', async () => {
    const cases = [
      ['open'],
      ['open', '--cursor', CURSOR],
      ['open', '--ref', `note:ctx_${'A'.repeat(64)}`],
      ['open', '--ref', `meeting:${record}`],
      ['open', '--ref', `record:sha256:${record}`],
      ['open', '--ref', `sha256:${record}`],
      ['open', '--ref', DOCUMENT, '--cursor', 'bad cursor'],
      ['open', '--ref', DOCUMENT, '--cursor', 'A'.repeat(513)],
      ['open', '--ref', NOTE, '--cursor', CURSOR],
      ['open', '--ref', NOTE, '--project', projectId],
      ['open', '--ref', NOTE, '--mine'],
    ];
    for (const argv of cases) {
      const { fetch } = network(() => { throw new Error('network must not be used'); });
      const result = await run(argv, fetch);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects an open response for another ref or with meeting detail on the wrong page', async () => {
    const cases: readonly [string[], unknown][] = [
      [['open', '--ref', MEETING], meetingOpen({ ref: `meeting:sha256:${'d'.repeat(64)}`, item: { ...meetingRow, ref: `meeting:sha256:${'d'.repeat(64)}` }, meeting: meetingDetail })],
      [['open', '--ref', NOTE], { schema_version: 1, kind: 'echo-person-open-v1', ref: `note:ctx_${'e'.repeat(64)}`, item: { ...noteRow, ref: `note:ctx_${'e'.repeat(64)}` }, text: 'Other.', next_cursor: null }],
      [['open', '--ref', MEETING, '--cursor', CURSOR], meetingOpen({ meeting: meetingDetail })],
      [['open', '--ref', MEETING], meetingOpen()],
    ];
    for (const [argv, response] of cases) {
      const result = await run(argv, network(() => json(response)).fetch);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, action: 'open', code: 'invalid_response', status: 200 });
    }
  });

  it('reports not_found exactly and refuses a response past the 64 KiB open bound', async () => {
    const missing = await run(['open', '--ref', DOCUMENT], network(() => json({ error: { code: 'not_found', message: 'request failed' } }, 404)).fetch);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(JSON.parse(missing.stderr)).toEqual({ ok: false, action: 'open', error: 'Person Authority rejected the request', code: 'not_found', status: 404 });
    const transcript = { schema_version: 1, kind: 'echo-person-open-v1', ref: TRANSCRIPT, text: 'Ari: annual first.', next_cursor: null };
    const large = await run(['open', '--ref', TRANSCRIPT], network(() => padded(transcript, 70 * 1024)).fetch);
    expect(large.code).toBe(1);
    expect(large.stdout).toBe('');
    expect(JSON.parse(large.stderr)).toMatchObject({ ok: false, action: 'open', code: 'response_too_large' });
  });
});

describe('person ask --mine', () => {
  const citation = {
    citation: { kind: 'approved_record', atom_id: `sha256:${'f'.repeat(64)}`, record_sha256: `sha256:${record}`, policy_id: 'organization-member-readable-person-v2' },
    kind: 'decision', label: 'Pricing review', visibility: 'team', ref: MEETING,
  };
  function answer(scope: unknown) {
    return { schema_version: 4, kind: 'echo-clean-person-answer-v4', scope, outcome: 'answered', citations: [citation],
      parts: [{ question: 'Question', status: 'answered', statements: [{ text: 'Annual plans first.', citation_indexes: [0], private: false }] }] };
  }

  it('sends mine and returns citations that carry refs', async () => {
    const { fetch, sent } = network(() => json(answer({ kind: 'mine' })));
    const result = await run(['ask', '--question', 'What did I decide?', '--mine'], fetch);
    expect(result.code, result.stderr).toBe(0);
    expect(sent.map(({ path, body }) => ({ path, body }))).toEqual([{ path: '/v3/person/ask', body: canonicalJson({ schema_version: 3, question: 'What did I decide?', mine: true }) }]);
    expect(oneLine(result.stdout)).toEqual({ ok: true, result: answer({ kind: 'mine' }) });
  });

  it('fails when the Authority answers under another scope', async () => {
    const result = await run(['ask', '--question', 'What did I decide?', '--mine'], network(() => json(answer({ kind: 'global' }))).fetch);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response', status: 200 });
  });
});
