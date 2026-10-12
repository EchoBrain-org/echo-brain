import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import type { PersonSessionOidcConfiguration } from '@echo-brain/organization-authority-kernel/application/ports/person-session-dependencies';
import { SqlitePersonSessionRepository } from '../../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { NodePersonSessionCrypto } from '../../src/adapters/security/node-person-session-crypto.js';
import { SystemAuthorityClock } from '../../src/adapters/system/system-authority-clock.js';
import { PersonIdentitySessionApplication, type BegunPersonOidcLogin, type IssuedPersonSession } from '../../src/application/person-identity-sessions.js';
import { bootstrapOrganizationAuthorityState } from '../../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../../src/composition/person-onboarding-service.js';

/** A loopback port that was free a moment ago. */
export async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = (server.address() as { port: number }).port;
  const closed = once(server, 'close');
  server.close();
  await closed;
  return result;
}

/** An OIDC provider that verifies `email()` for the last begun login; `state()` is that login's state. */
export function syntheticOidcProvider(oidc: { readonly issuer: string; readonly client_id: string }, email: () => string) {
  let attempt: BegunPersonOidcLogin | undefined;
  return {
    buildAuthorizationUrl(value: BegunPersonOidcLogin) {
      attempt = value;
      return `${oidc.issuer}/authorize?state=${encodeURIComponent(value.state)}`;
    },
    async redeemAuthorizationCode() {
      if (attempt === undefined) throw new Error('OIDC begin was not called');
      return { kind: 'verified' as const, token: {
        issuer: oidc.issuer, subject: `fixture-${email()}`, audience: oidc.client_id, nonce: attempt.nonce,
        issued_at: Math.floor(Date.now() / 1000), claims: { email: email(), email_verified: true },
      } };
    },
    state: () => attempt?.state ?? '',
  };
}

type SyntheticOidcProvider = ReturnType<typeof syntheticOidcProvider>;

/** Bootstraps fresh state under `root`, creates session credentials and invites the owner as `email`. */
export function ownerGenesis(input: { readonly root: string; readonly oidc: PersonSessionOidcConfiguration; readonly email: string; readonly authority_url: string; readonly revision: string }) {
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(input.root, 'state'), organization_display_name: 'Fixture Organization', owner_display_name: 'Fixture Owner',
    created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: input.revision,
  });
  const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  const pkce = readPrivateAuthorityPersonSessionPkceKey(credentials.pkce_sealing_key_reference);
  const invitation_path = join(input.root, 'invitation.json');
  issuePersonOnboardingInvitation({ state_directory: initialized.state_directory, oidc: input.oidc, pkce_sealing_key: pkce,
    membership_id: initialized.owner_membership_id, expected_email: input.email, authority_url: input.authority_url, output_path: invitation_path });
  const { login_grant } = JSON.parse(readFileSync(invitation_path, 'utf8')) as { login_grant: string };
  return { initialized, credentials, pkce, invitation_path, login_grant };
}

/** Signs in with `login_grant` as a browser would over HTTP and returns the sealed access token. */
export async function signInHttp(origin: string, provider: SyntheticOidcProvider, login_grant: string, code = 'synthetic'): Promise<string> {
  const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'identity_bootstrap', login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }),
  });
  expect(begun.status).toBe(201);
  const callback = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(provider.state())}&code=${code}`)).text();
  return (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(callback)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
}

/** Signs the genesis owner in through the session application, before any server runs. */
export async function signInInProcess(owner: ReturnType<typeof ownerGenesis>, oidc: PersonSessionOidcConfiguration, provider: SyntheticOidcProvider): Promise<IssuedPersonSession> {
  const authority = openAuthorityDatabase(join(owner.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  try {
    const crypto = new NodePersonSessionCrypto(owner.pkce);
    const sessions = new PersonIdentitySessionApplication(new SqlitePersonSessionRepository(authority), oidc,
      { clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider });
    const begun = sessions.beginOidcLogin({ kind: 'identity_bootstrap', login_grant: owner.login_grant });
    provider.buildAuthorizationUrl(begun);
    return await sessions.completeOidcLogin({ state: begun.state, authorization_code: 'synthetic' });
  } finally { authority.close(); }
}
