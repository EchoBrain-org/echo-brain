import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { createCoherentWorktreeSnapshot } from '../../../tests/fixtures/coherent-worktree.js';
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from '../src/composition/organization-authority-composition-root.js';
import { port as availablePort, ownerGenesis, signInInProcess, syntheticOidcProvider } from './fixtures/owner-session.js';

/** The deployable service with no organization meeting source: meetings enter only through personal sources. */
const OIDC = {
  issuer: 'https://issuer.example', client_id: 'founder-client', redirect_uri: 'https://authority.example/v2/session/oidc/callback',
  tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'],
};
/** Never read: no Slack call is made by these tests. */
const SLACK_NANGO = Object.freeze({ secret_key: 'nango-secret-key-not-used-000000', integration_key: 'slack' });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'echo-authority-source-free-'));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

/** A bootstrapped organization whose owner completed browser login; no meeting source of any kind exists. */
async function sourceFreeService() {
  const parent = root();
  const owner = ownerGenesis({ root: parent, oidc: OIDC, email: 'founder@example.com', authority_url: 'https://authority.example', revision: 'organization-authority-runtime-test' });
  const { initialized, credentials } = owner;
  const owner_session = await signInInProcess(owner, OIDC, syntheticOidcProvider(OIDC, () => 'founder@example.com'));
  const llm = join(parent, 'llm.key');
  writeFileSync(llm, 'llm-private-credential-material-000000', { mode: 0o600 });
  chmodSync(llm, 0o600);
  const config: OrganizationAuthorityServiceConfig = {
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
    oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
    nango: SLACK_NANGO, openrouter_credential_file: llm, worker_interval_ms: 60_000,
  };
  return { parent, initialized, config, owner_session };
}

it('runs submit/status from the exact packed Person CLI without an admitted meeting source', async () => {
  const parent = root();
  const repository = createCoherentWorktreeSnapshot(resolve(import.meta.dirname, '../../..'), parent);
  const run = (command: string, args: string[], cwd = repository) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, result.stderr || result.stdout).toBe(0); return result.stdout;
  };
  run('git', ['add', '.']);
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Person artifact fixture']);
  const artifact = (JSON.parse(run(process.execPath, ['tools/pack-person-client.mjs', parent])) as { artifact_path: string }).artifact_path;
  const listing = run('tar', ['-tzf', artifact]);
  expect(listing).not.toMatch(/node_modules\/(?:@echo-brain\/(?:organization-processing|organization-authority(?:-kernel)?)|better-sqlite3)\//);
  const install = join(parent, 'installed'); mkdirSync(install);
  run('tar', ['-xzf', artifact, '-C', install]);
  const cli = await import(pathToFileURL(join(install, 'package/dist/index.js')).href) as typeof import('../../../src/product/person-client/index.js');
  const fixture = await sourceFreeService();
  const runtime = await openOrganizationAuthorityService(fixture.config);
  const home = join(parent, 'person-home'); mkdirSync(home);
  try {
    const origin = `http://127.0.0.1:${runtime.address.port}`;
    await new cli.PersonClient({ home_directory: home, allow_insecure_loopback: true }).installSession(origin, fixture.owner_session);
    const path = join(home, 'update.txt'); writeFileSync(path, 'We agreed to ship the release.\n');
    const requestId = randomUUID(); let output = ''; let errors = '';
    const dependencies = { home_directory: home, allow_insecure_loopback: true, stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { errors += value; } } };
    expect(await cli.runPersonClientCli(['updates', 'submit-v3', '--request-id', requestId, '--title', 'Release', '--file', path], dependencies), errors).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ kind: 'echo-person-update-receipt-v3', state: 'received', request_id: requestId }); output = '';
    expect(await cli.runPersonClientCli(['updates', 'status-v3', '--request-id', requestId], dependencies), errors).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ kind: 'echo-person-update-status-v3', status: 'stored', request_id: requestId });
    expect(output).not.toContain('We agreed'); output = '';
    expect(await cli.runPersonClientCli(['updates', 'search-v3', '--query', 'release'], dependencies), errors).toBe(0);
    const found = JSON.parse(output).results[0]; expect(found.title).toBe('Release'); output = '';
    expect(await cli.runPersonClientCli(['open', '--ref', `note:${found.context_id}`], dependencies), errors).toBe(0);
    expect(JSON.parse(output).result.text).toBe('We agreed to ship the release.\n'); expect(errors).toBe('');
  } finally { await runtime.close(); }
});

it('refuses non-V16 Authority state without touching the record log or integrations, then resumes stopped V16 sessions', async () => {
  const fixture = await sourceFreeService();
  const state = fixture.initialized.state_directory;
  const path = join(state, 'authority.sqlite');
  let runtime = await openOrganizationAuthorityService(fixture.config);
  await runtime.close();
  const current = new Database(path, { readonly: true });
  expect((current.prepare('SELECT count(*) FROM authority_person_session_families').pluck().get() as number)).toBeGreaterThan(0);
  expect(current.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
  // A current runtime must never accept older state as active state: relabel a
  // copy of the live V16 file as V15 and exercise the strict V16 pre-open gate.
  const olderPath = join(root(), 'v15.sqlite'); current.exec(`VACUUM INTO '${olderPath}'`); current.close();
  const older = new Database(olderPath);
  const manifest = older.prepare('SELECT manifest_json FROM echo_state_lineage_manifest').pluck().get() as string;
  const relabeled = { ...JSON.parse(manifest), database_schema_version: 15, schema_sha256: canonicalSha256({ retired_authority_schema: 15 }) };
  older.prepare('UPDATE echo_state_lineage_manifest SET manifest_json = ?, manifest_sha256 = ?').run(canonicalJson(relabeled), canonicalSha256(relabeled));
  older.pragma('user_version = 15'); older.close();
  const recordPath = join(state, 'record-log.sqlite'); const recordBefore = readFileSync(recordPath);
  const controlPath = join(state, 'integrations.sqlite'); const controlBefore = readFileSync(controlPath);
  const preservedCurrentPath = join(root(), 'v16.sqlite');
  renameSync(path, preservedCurrentPath);
  try {
    renameSync(olderPath, path); chmodSync(path, 0o600);
    await expect(openOrganizationAuthorityService({ ...fixture.config, port: await availablePort() })).rejects.toThrow('schema version is not exactly 16');
  } finally {
    if (existsSync(path)) renameSync(path, olderPath);
    renameSync(preservedCurrentPath, path); chmodSync(path, 0o600);
  }
  expect(readFileSync(recordPath)).toEqual(recordBefore); expect(readFileSync(controlPath)).toEqual(controlBefore);
  runtime = await openOrganizationAuthorityService({ ...fixture.config, port: await availablePort() });
  try {
    await runtime.drain(AbortSignal.timeout(5000));
    const records = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/person/records`, { headers: { authorization: `Bearer ${fixture.owner_session.access_token}` } });
    expect(records.status).toBe(200); expect(await records.json()).toMatchObject({ records: [] });
  } finally { await runtime.close(); }
});
