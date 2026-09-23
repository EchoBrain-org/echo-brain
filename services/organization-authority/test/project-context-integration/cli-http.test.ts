import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonUpdateReceiptV2, ProjectCreateReceiptV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { runPersonClientCli } from '../../../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../../../src/product/person-client/session-store.js';
import { createProjectContextApplicationV1 } from '../../src/application/project-context-application-v1.js';
import { createOrganizationAuthorityHttpServer } from '../../src/presentation/organization-authority-http-server.js';
import { createPersonUpdateProcessingV1 } from '../../src/composition/person-update-processing-v1.js';
import { SqlitePersonUpdateInboxV1 } from '../../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { SqlitePersonUpdateEnrichmentWorkV2 } from '../../src/adapters/persistence/sqlite/person-update-enrichment-work-v2.js';
import { authorization, PROJECT_CONTEXT_NOW } from '../fixtures/project-context-sqlite.js';
import { SyntheticProjectHarness, PEOPLE } from './synthetic-harness.js';

type Person = keyof typeof PEOPLE;
let h: SyntheticProjectHarness;
let server: Server;
let origin: string;
const homes = new Map<Person, string>();
const labels = new Map<string, Person>();
const requests: string[] = [];

async function start(supported = true) {
  const app = createProjectContextApplicationV1({ repository: h.repository, authenticate: value => {
    const person = labels.get(value);
    if (!person) throw new AuthorityOperationError('unauthorized', 'request failed');
    return authorization(PEOPLE[person]);
  } });
  server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never,
    expected_issuer: 'https://issuer.example', ...(supported ? { project_context: app } : {}),
  });
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
  return ['updates', 'submit', '--request-id', requestId, '--title', 'Synthetic PC06', '--file', file, '--visibility', audience, '--project-id', project,
    ...(audienceProject ? ['--audience-project-id', audienceProject] : [])];
}

describe('PC-06 real CLI -> loopback HTTP -> application -> V9, fixture authentication/model', () => {
  it('preserves disjoint project visibility, private/team audience and cross-project coordinates', async () => {
    const alpha = await create('Synthetic Alpha'); const beta = await create('Synthetic Beta');
    await member(alpha, 'bob'); await member(beta, 'carol');
    expect((await ok('bob', ['projects', 'list'])).items.map((item: { project_id: string }) => item.project_id)).toEqual([alpha]);
    const privateNote = await ok<PersonUpdateReceiptV2>('alice', uploadArgv(alpha, 'only-me'));
    const team = await ok<PersonUpdateReceiptV2>('alice', uploadArgv(alpha, 'team'));
    const cross = await ok<PersonUpdateReceiptV2>('alice', uploadArgv(beta, 'project', alpha));
    expect(cross).toMatchObject({ project_id: beta, audience: { kind: 'project', project_id: alpha } });
    expect((await ok('bob', ['projects', 'feed', '--project-id', alpha])).items.map((item: { context_id: string }) => item.context_id)).toEqual([team.context_id]);
    expect((await ok('carol', ['projects', 'search', '--project-id', beta, '--query', 'meridian'])).items).toEqual([]);
    expect(await ok('bob', ['updates', 'read', '--context-id', cross.context_id])).toMatchObject({ text: 'PC06 original meridian.\n', audience: cross.audience });
    expect(await ok('dana', ['updates', 'read', '--context-id', team.context_id])).not.toHaveProperty('project_id');
    for (const [person, context] of [['bob', privateNote.context_id], ['carol', cross.context_id]] as const) {
      const result = await cli(person, ['updates', 'read', '--context-id', context]);
      expect(result.code).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ code: 'not_found', status: 404 });
    }
    const cursor = (await ok('alice', ['projects', 'feed', '--project-id', alpha, '--limit', '1'])).next_cursor;
    const misuse = await cli('alice', ['projects', 'feed', '--project-id', beta, '--limit', '1', '--cursor', cursor]);
    expect(JSON.parse(misuse.stderr)).toMatchObject({ code: 'invalid_request' });
    const wrongProject = await cli('alice', ['projects', 'read-context', '--project-id', alpha, '--context-id', cross.context_id]);
    expect(JSON.parse(wrongProject.stderr)).toMatchObject({ code: 'not_found' });
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
    const status = await ok('alice', ['updates', 'status', '--request-id', requestId]);
    const replay = await ok<PersonUpdateReceiptV2>('alice', argv);
    expect(replay).toMatchObject({ context_id: status.context_id, project_id: beta, audience: { kind: 'project', project_id: alpha } });
    const conflict = await cli('alice', argv.map(value => value === 'Synthetic PC06' ? 'Changed title' : value));
    expect(JSON.parse(conflict.stderr)).toMatchObject({ code: 'conflict', mutation_outcome: 'not_submitted', request_id: requestId });
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2').get()).toEqual({ n: 1 });
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_update_work_v2').get()).toEqual({ n: 1 });
  });

  it.each(['success', 'failure', 'revocation'] as const)('keeps original CLI read/search available across real worker %s', async outcome => {
    const alpha = await create('Synthetic Alpha'); await member(alpha, 'bob', 'lead');
    const receipt = await ok<PersonUpdateReceiptV2>('alice', uploadArgv(alpha, 'project', alpha));
    const original = await ok('bob', ['updates', 'read', '--context-id', receipt.context_id]);
    expect((await ok('alice', ['updates', 'status', '--request-id', receipt.request_id])).metadata).toBe('pending');
    let now = PROJECT_CONTEXT_NOW;
    let verifiedHandoffs = 0;
    const generate = vi.fn(async () => {
      expect(await ok('bob', ['updates', 'read', '--context-id', receipt.context_id])).toEqual(original);
      expect((await ok('bob', ['projects', 'search', '--project-id', alpha, '--query', 'meridian'])).items).toHaveLength(1);
      verifiedHandoffs++;
      if (outcome === 'failure') throw new Error('synthetic provider failure');
      if (outcome === 'revocation') await ok('bob', ['projects', 'member-remove', '--request-id', h.requestId(), '--project-id', alpha, '--membership-id', PEOPLE.alice.membership_id]);
      return { search_hints: 'zenith' };
    });
    const worker = createPersonUpdateProcessingV1(new SqlitePersonUpdateInboxV1(h.database, () => now), {
      structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 1000 },
    }, new SqlitePersonUpdateEnrichmentWorkV2(h.database, h.eligibility, () => now));
    for (let attempt = 0; attempt < (outcome === 'failure' ? 5 : 1); attempt++) {
      await worker.runOnce(new AbortController().signal);
      now = new Date(Date.parse(now) + 60_000).toISOString();
    }
    expect((await ok('alice', ['updates', 'status', '--request-id', receipt.request_id])).metadata).toBe(outcome === 'success' ? 'ready' : 'unavailable');
    expect(await ok('bob', ['updates', 'read', '--context-id', receipt.context_id])).toEqual(original);
    expect((await ok('bob', ['projects', 'search', '--project-id', alpha, '--query', 'meridian'])).items).toHaveLength(1);
    expect((await ok('bob', ['projects', 'search', '--project-id', alpha, '--query', 'zenith'])).items).toHaveLength(outcome === 'success' ? 1 : 0);
    expect(generate).toHaveBeenCalledTimes(outcome === 'failure' ? 5 : 1);
    expect(verifiedHandoffs).toBe(outcome === 'failure' ? 5 : 1);
  });

  it('returns explicit unsupported-route failures without falling back to V1 or team sharing', async () => {
    const alpha = await create('Synthetic Alpha');
    await stop(); await start(false);
    const list = await cli('alice', ['projects', 'list']);
    expect(JSON.parse(list.stderr)).toMatchObject({ action: 'projects-list', code: 'not_found', status: 404 });
    const read = await cli('alice', ['projects', 'read', '--project-id', alpha]);
    expect(JSON.parse(read.stderr)).toMatchObject({ action: 'projects-read', code: 'not_found', status: 404 });
    requests.length = 0;
    const submit = await cli('alice', uploadArgv(alpha, 'project', alpha));
    expect(submit.stdout).toBe('');
    expect(JSON.parse(submit.stderr)).toMatchObject({ code: 'not_found', mutation_outcome: 'not_submitted' });
    expect(requests).toEqual(['POST /v2/person/updates']);
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2').get()).toEqual({ n: 0 });
  });

  it.skipIf(process.platform !== 'darwin')('drives native ProjectSession and UploadClient through real CLI subprocesses and HTTP', async () => {
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const binary = join(h.root, 'native-proof');
    execFileSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-warnings-as-errors',
      '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-framework', 'AppKit',
      '-module-cache-path', join(h.root, 'modules'),
      ...['ui-support', 'account', 'projects', 'uploads'].map(name => join(repo, `product/echo-overlay/${name}.swift`)),
      join(repo, 'tests/fixtures/project-context-integration/native-cli-proof.swift'), '-o', binary,
    ], { stdio: 'pipe', timeout: 120_000 });
    const s = h.seed();
    const run = async (person: Person, mode: string) => {
      const script = join(h.root, `${mode}.mjs`);
      const executable = join(h.root, `${mode}-cli`);
      writeFileSync(script, `import { runPersonClientCli } from ${JSON.stringify(pathToFileURL(join(repo, 'src/product/person-client/dist/composition.js')).href)};
const args = process.argv.slice(2); if (args[0] === 'person') args.shift();
process.exitCode = await runPersonClientCli(args, { home_directory: ${JSON.stringify(homes.get(person))}, now: () => ${JSON.stringify(PROJECT_CONTEXT_NOW)},
fetch: (input, init) => { const url = new URL(String(input)); if (url.origin !== 'https://authority.example') throw new Error('unexpected origin'); return fetch(${JSON.stringify(origin)} + url.pathname + url.search, init); } });
`);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
      const child = spawn(binary, [executable, mode, s.alpha, s.beta, s.cross.context_id], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
      try { const [code] = await once(child, 'close'); expect(code, stderr).toBe(0); expect(stdout).toContain(`passed ${mode}`); }
      finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); }
    };
    await run('alice', 'alice'); await run('carol', 'carol');
    await stop(); await start(false); await run('alice', 'unsupported');
  });
});
