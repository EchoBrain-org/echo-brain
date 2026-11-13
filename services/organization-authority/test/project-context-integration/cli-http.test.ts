import { once } from 'node:events';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonUpdateReceiptV3, ProjectCreateReceiptV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { runPersonClientCli } from '../../../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../../../src/product/person-client/session-store.js';
import { SqlitePersonOriginalItemsV1 } from '../../src/adapters/persistence/sqlite/person-original-items-v1.js';
import { createProjectContextApplicationV1 } from '../../src/application/project-context-application-v1.js';
import { createOrganizationAuthorityHttpServer } from '../../src/presentation/organization-authority-http-server.js';
import { authorization, PROJECT_CONTEXT_NOW, revokeMembership } from '../fixtures/project-context-sqlite.js';
import { authorityHttpServerOptions } from '../fixtures/authority-http-server.js';
import { SyntheticProjectHarness, PEOPLE } from './synthetic-harness.js';

type Person = keyof typeof PEOPLE;
let h: SyntheticProjectHarness;
let server: Server;
let origin: string;
const homes = new Map<Person, string>();
const labels = new Map<string, Person>();
const requests: string[] = [];

/** Unsupported, the project routes answer not_found, as an Authority without them does. */
async function start(supported = true) {
  const app = createProjectContextApplicationV1({ repository: h.repository, authenticate: value => {
    const person = labels.get(value);
    if (!person) throw new AuthorityOperationError('unauthorized', 'request failed');
    return authorization(PEOPLE[person]);
  } });
  const notFound = () => { throw new AuthorityOperationError('not_found', 'request failed'); };
  server = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({
    project_context: supported ? app : { listProjectsV2: notFound, readProjectV2: notFound, submitUploadV3: notFound } as never,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback address');
  origin = `http://127.0.0.1:${address.port}`;
}

async function stop() {
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections();
    await closed;
  }
}

beforeEach(async () => {
  h = new SyntheticProjectHarness();
  for (const [index, person] of (Object.keys(PEOPLE) as Person[]).entries()) {
    const home = join(realpathSync(h.root), person);
    mkdirSync(home, { mode: 0o700 });
    homes.set(person, home);
    const access = String.fromCharCode(65 + index).repeat(43);
    labels.set(access, person);
    new PersonSessionStore(home).install('https://authority.example', 'oau_00000000-0000-4000-8000-000000000006', {
      ...PEOPLE[person], display_name: person,
      identity_binding_id: 'oib_00000000-0000-4000-8000-000000000006',
      session_family_id: 'psf_00000000-0000-4000-8000-000000000006',
      access_token: access, refresh_token: 'Z'.repeat(43),
      access_expires_at: '2026-09-21T23:01:00.000Z',
      refresh_expires_at: '2026-09-28T22:01:00.000Z',
      hard_reauthentication_at: '2026-09-28T22:01:00.000Z',
    });
  }
  await start();
});
afterEach(async () => { await stop(); h.close(); homes.clear(); labels.clear(); requests.length = 0; });

// Only the HTTPS origin is mapped to loopback. Request parsing, HTTP dispatch,
// application, SQLite, response decoding and CLI JSON/error handling are real.
const loopback: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://authority.example');
  requests.push(`${init?.method} ${url.pathname}`);
  return fetch(`${origin}${url.pathname}${url.search}`, init);
};
async function cli(person: Person, argv: string[], network = loopback) {
  let stdout = ''; let stderr = '';
  const code = await runPersonClientCli(argv, {
    home_directory: homes.get(person)!, now: () => PROJECT_CONTEXT_NOW, fetch: network,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
  });
  return { code, stdout, stderr };
}
async function ok<T = Record<string, any>>(person: Person, argv: string[]): Promise<T> {
  const result = await cli(person, argv);
  expect(result.stderr).toBe(''); expect(result.code).toBe(0);
  expect(result.stdout.endsWith('\n')).toBe(true);
  return JSON.parse(result.stdout) as T;
}
async function create(name: string) {
  return (await ok<ProjectCreateReceiptV1>('alice', ['projects', 'create', '--request-id', h.requestId(), '--name', name])).project_id;
}
async function member(project: string, person: Person, role = 'member') {
  await ok('alice', ['projects', 'member-set', '--request-id', h.requestId(), '--project-id', project, '--membership-id', PEOPLE[person].membership_id, '--role', role]);
}
function uploadArgv(project: string, audience: string, audienceProject?: string) {
  const requestId = h.requestId();
  const file = join(realpathSync(h.root), `${requestId}.txt`);
  writeFileSync(file, 'PC06 original meridian.\n', { mode: 0o600 });
  return ['updates', 'submit-v3', '--request-id', requestId, '--title', 'Synthetic PC06', '--file', file, '--audience', audience,
    '--association-project-ids-json', JSON.stringify([project]), ...(audienceProject ? ['--audience-project-id', audienceProject] : [])];
}
/** Whether `person` may open the note now, as `person open --ref note:<id>` and Ask read it. */
function readable(person: Person, contextId: string): boolean {
  const items = new SqlitePersonOriginalItemsV1(h.database, { authenticateAccess: () => authorization(PEOPLE[person]) }, PEOPLE[person].organization_id);
  try { items.open({ access_token: 'fixture', ref: { kind: 'note', id: contextId as `ctx_${string}` } }); return true; } catch { return false; }
}

describe('PC-06 real CLI -> loopback HTTP -> application -> V16, fixture authentication/model', () => {
  it('preserves disjoint project visibility, private/team audience and cross-project coordinates', async () => {
    const alpha = await create('Synthetic Alpha'); const beta = await create('Synthetic Beta');
    await member(alpha, 'bob'); await member(beta, 'carol');
    expect((await ok('bob', ['projects', 'list-v2'])).items.map((item: { project_id: string }) => item.project_id)).toEqual([alpha]);
    const privateNote = await ok<PersonUpdateReceiptV3>('alice', uploadArgv(alpha, 'only-me'));
    const team = await ok<PersonUpdateReceiptV3>('alice', uploadArgv(alpha, 'team'));
    const cross = await ok<PersonUpdateReceiptV3>('alice', uploadArgv(beta, 'project', alpha));
    expect(cross).toMatchObject({ association_project_ids: [beta], audience: { kind: 'project', project_id: alpha } });
    // Bob reads the cross-project note through its audience, never the private one; Carol and Dana read only Team.
    expect([privateNote, team, cross].map(note => readable('bob', note.context_id))).toEqual([false, true, true]);
    for (const person of ['carol', 'dana'] as const) expect([privateNote, team, cross].map(note => readable(person, note.context_id))).toEqual([false, true, false]);
    const cursor = (await ok('alice', ['projects', 'members', '--project-id', alpha, '--limit', '1'])).next_cursor;
    expect(cursor).toEqual(expect.any(String));
    const misuse = await cli('alice', ['projects', 'members', '--project-id', beta, '--limit', '1', '--cursor', cursor]);
    expect(JSON.parse(misuse.stderr)).toMatchObject({ code: 'invalid_request' });
    const before = requests.length;
    const ask = await cli('alice', ['projects', 'ask', '--project-id', alpha, '--question', 'meridian']);
    expect(ask.code).not.toBe(0); expect(requests).toHaveLength(before);
    expect(requests.every(request => !/\/ask|\/records|\/approval|\/v1\/person\/updates/.test(request))).toBe(true);
  });

  it('keeps unknown upload outcome and exact replay coordinates after HTTP reply loss and server/database restart', async () => {
    const alpha = await create('Synthetic Alpha'); const beta = await create('Synthetic Beta');
    const argv = uploadArgv(beta, 'project', alpha);
    const network: typeof fetch = async (input, init) => {
      const response = await loopback(input, init);
      expect(response.status).toBe(202);
      await response.arrayBuffer();
      throw new Error('synthetic reply lost after real HTTP commit');
    };
    const failed = await cli('alice', argv, network);
    expect(failed.code).toBe(1); expect(failed.stdout).toBe('');
    const requestId = argv[argv.indexOf('--request-id') + 1]!;
    expect(JSON.parse(failed.stderr)).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: requestId });
    await stop(); h.restart(); await start();
    const status = await ok('alice', ['updates', 'status-v3', '--request-id', requestId]);
    const replay = await ok<PersonUpdateReceiptV3>('alice', argv);
    expect(replay).toMatchObject({ context_id: status.context_id, association_project_ids: [beta], audience: { kind: 'project', project_id: alpha } });
    const conflict = await cli('alice', argv.map(value => value === 'Synthetic PC06' ? 'Changed title' : value));
    expect(JSON.parse(conflict.stderr)).toMatchObject({ code: 'conflict', mutation_outcome: 'not_submitted', request_id: requestId });
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2').get()).toEqual({ n: 1 });
  });

  it('keeps an original readable to its project through the CLI with no model, also after its uploader leaves its project and organization', async () => {
    const alpha = await create('Synthetic Alpha'); await member(alpha, 'bob', 'lead');
    const receipt = await ok<PersonUpdateReceiptV3>('alice', uploadArgv(alpha, 'project', alpha));
    expect(readable('bob', receipt.context_id)).toBe(true);
    // No search metadata is made: the status says ready at once.
    expect((await ok('alice', ['updates', 'status-v3', '--request-id', receipt.request_id])).metadata).toBe('ready');
    await ok('bob', ['projects', 'member-remove', '--request-id', h.requestId(), '--project-id', alpha, '--membership-id', PEOPLE.alice.membership_id]);
    // Alice has left the note's project, so her status is the saved-only proof with no metadata (ADR-0023); Bob still reads it.
    expect(await ok('alice', ['updates', 'status-v3', '--request-id', receipt.request_id])).toMatchObject({ kind: 'echo-person-update-saved-v3', context_id: receipt.context_id });
    expect(readable('bob', receipt.context_id)).toBe(true);
    // Alice leaves the organization as well: Bob still reads it.
    revokeMembership(h.database, PEOPLE.alice);
    expect(readable('bob', receipt.context_id)).toBe(true);
  });

  it('returns explicit unsupported-route failures without falling back to V1 or team sharing', async () => {
    const alpha = await create('Synthetic Alpha');
    await stop(); await start(false);
    const list = await cli('alice', ['projects', 'list-v2']);
    expect(JSON.parse(list.stderr)).toMatchObject({ action: 'projects-list-v2', code: 'not_found', status: 404 });
    const read = await cli('alice', ['projects', 'read-v2', '--project-id', alpha]);
    expect(JSON.parse(read.stderr)).toMatchObject({ action: 'projects-read-v2', code: 'not_found', status: 404 });
    requests.length = 0;
    const submit = await cli('alice', uploadArgv(alpha, 'project', alpha));
    expect(submit.stdout).toBe('');
    expect(JSON.parse(submit.stderr)).toMatchObject({ code: 'not_found', mutation_outcome: 'not_submitted' });
    expect(requests).toEqual(['POST /v3/person/updates']);
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2').get()).toEqual({ n: 0 });
  });
});
