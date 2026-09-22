import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { bootstrapOrganizationAuthorityState } from '../../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../../src/composition/person-onboarding-service.js';
import { startOrganizationAuthorityApiRuntime } from '../../src/composition/organization-authority-api-runtime.js';
import { PersonIdentitySessionApplication, type BegunPersonOidcLogin } from '../../src/application/person-identity-sessions.js';
import type { PersonSessionOidcAuthorizationProvider } from '../../src/composition/lazy-person-session-oidc-provider.js';
import { NodePersonSessionCrypto } from '../../src/adapters/security/node-person-session-crypto.js';
import { SqlitePersonSessionRepository } from '../../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { SystemAuthorityClock } from '../../src/adapters/system/system-authority-clock.js';
import { PersonSessionStore } from '../../../../src/product/person-client/session-store.js';
import { runPersonClientCli } from '../../../../src/product/person-client/composition.js';

const oidc = {
  issuer: 'https://issuer.example', client_id: 'pc06-client',
  redirect_uri: 'https://authority.example/v2/session/oidc/callback',
  tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'],
};
class SyntheticOidcProvider implements PersonSessionOidcAuthorizationProvider {
  attempt?: BegunPersonOidcLogin;
  buildAuthorizationUrl(attempt: BegunPersonOidcLogin) {
    this.attempt = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }
  async redeemAuthorizationCode() {
    if (!this.attempt) throw new Error('missing synthetic OIDC begin');
    return { kind: 'verified' as const, token: {
      issuer: oidc.issuer, subject: 'pc06-owner', audience: oidc.client_id,
      nonce: this.attempt.nonce, issued_at: Math.floor(Date.now() / 1000),
      claims: { email: 'owner@example.test', email_verified: true },
    } };
  }
}
async function port() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('no fixture port');
  const closed = once(socket, 'close'); socket.close(); await closed;
  return address.port;
}

it('uses default API composition and real Person session checks through CLI, including restart and revoked-session denial', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc06-real-runtime-')));
  chmodSync(root, 0o700);
  let runtime: Awaited<ReturnType<typeof startOrganizationAuthorityApiRuntime>> | undefined;
  try {
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(root, 'state'), organization_display_name: 'Synthetic PC06',
      owner_display_name: 'Synthetic Owner', created_at: new Date(Date.now() - 1000).toISOString(),
      creating_artifact_revision: 'pc06-disposable-runtime-test',
    });
    const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
    const key = readPrivateAuthorityPersonSessionPkceKey(credentials.pkce_sealing_key_reference);
    const invitationPath = join(root, 'synthetic-invitation.json');
    issuePersonOnboardingInvitation({ state_directory: initialized.state_directory, oidc, pkce_sealing_key: key,
      membership_id: initialized.owner_membership_id, expected_email: 'owner@example.test',
      authority_url: 'https://authority.example', output_path: invitationPath });
    const provider = new SyntheticOidcProvider();
    const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    let session;
    try {
      const crypto = new NodePersonSessionCrypto(key);
      const sessions = new PersonIdentitySessionApplication(new SqlitePersonSessionRepository(database), oidc, {
        clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider,
      });
      const begun = sessions.beginOidcLogin({ kind: 'identity_bootstrap', login_grant: JSON.parse(readFileSync(invitationPath, 'utf8')).login_grant });
      provider.buildAuthorizationUrl(begun);
      session = await sessions.completeOidcLogin({ state: begun.state, authorization_code: 'synthetic-code' });
    } finally { database.close(); }
    const config = { state_directory: initialized.state_directory, host: '127.0.0.1' as const, port: await port(),
      authority_url: 'https://authority.example', oidc, client_authentication: { method: 'none' as const }, pkce_sealing_key: key };
    // No project_context injection: this must exercise PC-03's real factory.
    runtime = await startOrganizationAuthorityApiRuntime(config, { oidc_provider: provider });
    const home = join(root, 'person'); mkdirSync(home, { mode: 0o700 });
    new PersonSessionStore(home).install('https://authority.example', initialized.authority_id, session);
    const cli = async (argv: string[]) => {
      let stdout = ''; let stderr = '';
      const code = await runPersonClientCli(argv, { home_directory: home,
        fetch: (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe('https://authority.example');
          return fetch(`http://127.0.0.1:${runtime!.address.port}${url.pathname}${url.search}`, init);
        }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      });
      return { code, stdout, stderr };
    };
    const created = await cli(['projects', 'create', '--request-id', randomUUID(), '--name', 'Synthetic Alpha']);
    expect(created.stderr).toBe(''); expect(created.code).toBe(0);
    const project = JSON.parse(created.stdout).project_id as string;
    const file = join(root, 'original.txt'); writeFileSync(file, 'PC06 original meridian.\n', { mode: 0o600 });
    const requestId = randomUUID();
    const submitted = await cli(['updates', 'submit', '--request-id', requestId, '--title', 'Synthetic original', '--file', file,
      '--visibility', 'project', '--audience-project-id', project, '--project-id', project]);
    expect(submitted.stderr).toBe(''); expect(submitted.code).toBe(0);
    const receipt = JSON.parse(submitted.stdout);
    await runtime.close();
    runtime = await startOrganizationAuthorityApiRuntime({ ...config, port: await port() }, { oidc_provider: provider });
    const read = await cli(['projects', 'read-context', '--project-id', project, '--context-id', receipt.context_id]);
    expect(read.stderr).toBe(''); expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ text: 'PC06 original meridian.\n', audience: { kind: 'project', project_id: project } });
    const status = await cli(['updates', 'status', '--request-id', requestId]);
    expect(status.code).toBe(0); expect(JSON.parse(status.stdout)).toMatchObject({ context_id: receipt.context_id, metadata: 'pending' });
    const logout = await cli(['logout']); expect(logout.code).toBe(0);
    const denied = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/person/projects/${project}`, { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
