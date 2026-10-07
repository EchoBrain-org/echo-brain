import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { createCoherentWorktreeSnapshot } from '../../../tests/fixtures/coherent-worktree.js';
import type { BegunPersonOidcLogin, IssuedPersonSession } from '../src/application/person-identity-sessions.js';
import { PersonIdentitySessionApplication } from '../src/application/person-identity-sessions.js';
import { SqlitePersonSessionRepository } from '../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { NodePersonSessionCrypto } from '../src/adapters/security/node-person-session-crypto.js';
import { SystemAuthorityClock } from '../src/adapters/system/system-authority-clock.js';
import type { PersonSessionOidcAuthorizationProvider } from '../src/composition/lazy-person-session-oidc-provider.js';
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from '../src/composition/organization-authority-composition-root.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../src/composition/person-onboarding-service.js';

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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

class TestPersonOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private attempt: BegunPersonOidcLogin | undefined;
  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.attempt = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }
  async redeemAuthorizationCode() {
    if (this.attempt === undefined) throw new Error('OIDC begin was not called');
    return { kind: 'verified' as const, token: { issuer: OIDC.issuer, subject: 'founder-subject', audience: OIDC.client_id, nonce: this.attempt.nonce,
      issued_at: Math.floor(Date.now() / 1_000), claims: { email: 'founder@example.com', email_verified: true } } };
  }
}

/** A bootstrapped organization whose owner completed browser login; no meeting source of any kind exists. */
async function sourceFreeService() {
  const parent = root();
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(parent, 'state'), organization_display_name: 'Founder Organization', owner_display_name: 'Founder',
    created_at: '2026-08-22T11:00:00.000Z', creating_artifact_revision: 'organization-authority-runtime-test',
  });
  const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  const pkce = readPrivateAuthorityPersonSessionPkceKey(credentials.pkce_sealing_key_reference);
  const invitationPath = join(parent, 'founder.invitation.json');
  issuePersonOnboardingInvitation({ state_directory: initialized.state_directory, oidc: OIDC, pkce_sealing_key: pkce,
    membership_id: initialized.owner_membership_id, expected_email: 'founder@example.com', authority_url: 'https://authority.example', output_path: invitationPath });
  const invitation = JSON.parse(readFileSync(invitationPath, 'utf8')) as { login_grant: string };
  const authority = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  let owner_session: IssuedPersonSession;
  try {
    const provider = new TestPersonOidcProvider();
    const crypto = new NodePersonSessionCrypto(pkce);
    const sessions = new PersonIdentitySessionApplication(new SqlitePersonSessionRepository(authority), OIDC,
      { clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider });
    const begun = sessions.beginOidcLogin({ kind: 'identity_bootstrap', login_grant: invitation.login_grant });
    provider.buildAuthorizationUrl(begun);
    owner_session = await sessions.completeOidcLogin({ state: begun.state, authorization_code: 'founder-code' });
  } finally { authority.close(); }
  const llm = join(parent, 'llm.key');
  writeFileSync(llm, 'llm-private-credential-material-000000', { mode: 0o600 });
  chmodSync(llm, 0o600);
  const config: OrganizationAuthorityServiceConfig = {
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
    oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
    slack_nango: SLACK_NANGO, openrouter_credential_file: llm, worker_interval_ms: 60_000,
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

it('refuses non-V12 Authority state without touching the record log or integrations, then resumes stopped V12 sessions', async () => {
  const fixture = await sourceFreeService();
  const state = fixture.initialized.state_directory;
  const path = join(state, 'authority.sqlite');
  let runtime = await openOrganizationAuthorityService(fixture.config);
  await runtime.close();
  const current = new Database(path, { readonly: true });
  expect((current.prepare('SELECT count(*) FROM authority_person_session_families').pluck().get() as number)).toBeGreaterThan(0);
  expect(current.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
  // A current runtime must never accept older state as active state: relabel a
  // copy of the live V12 file as V11 and exercise the strict V12 pre-open gate.
  const olderPath = join(root(), 'v11.sqlite'); current.exec(`VACUUM INTO '${olderPath}'`); current.close();
  const older = new Database(olderPath);
  const manifest = older.prepare('SELECT manifest_json FROM echo_state_lineage_manifest').pluck().get() as string;
  const relabeled = { ...JSON.parse(manifest), database_schema_version: 11, schema_sha256: canonicalSha256({ retired_authority_schema: 11 }) };
  older.prepare('UPDATE echo_state_lineage_manifest SET manifest_json = ?, manifest_sha256 = ?').run(canonicalJson(relabeled), canonicalSha256(relabeled));
  older.pragma('user_version = 11'); older.close();
  const recordPath = join(state, 'record-log.sqlite'); const recordBefore = readFileSync(recordPath);
  const controlPath = join(state, 'integrations.sqlite'); const controlBefore = readFileSync(controlPath);
  const preservedCurrentPath = join(root(), 'v12.sqlite');
  renameSync(path, preservedCurrentPath);
  try {
    renameSync(olderPath, path); chmodSync(path, 0o600);
    await expect(openOrganizationAuthorityService({ ...fixture.config, port: await availablePort() })).rejects.toThrow('schema version is not exactly 12');
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
