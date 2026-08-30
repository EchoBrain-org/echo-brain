import { Buffer } from 'node:buffer';
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Digest } from '@echo-brain/federation-protocol';
import {
  OpenIdClientPersonSessionProvider,
  type OpenIdClientAuthentication,
  type OpenIdClientPersonSessionProviderOptions,
} from '../src/adapters/oidc/openid-client-person-session-provider.js';
import type { BegunPersonOidcLogin } from '../src/application/person-identity-sessions.js';
import type { FrozenPersonSessionOidcConfiguration } from '../src/application/ports/person-session-dependencies.js';

const ISSUER = 'https://identity.example.test/';
const AUTHORIZATION_ENDPOINT = `${ISSUER}authorize`;
const TOKEN_ENDPOINT = `${ISSUER}token`;
const JWKS_ENDPOINT = `${ISSUER}jwks`;
const CLIENT_ID = 'echo-person-client';
const CLIENT_SECRET = 'test-only-client-secret';
const REDIRECT_URI =
  'https://authority.example.test/v2/session/oidc/callback';
const AUTHORIZATION_CODE = 'one-use-authorization-code';
const PKCE_VERIFIER = 'A'.repeat(43);
const STATE = 'B'.repeat(43);
const NONCE = 'C'.repeat(43);
const CODE_CHALLENGE = 'D'.repeat(43);
const KEY_ID = 'test-rs256-key';
const VERIFIED_EMAIL = 'person@echobrain.org';

const CONFIGURATION = {
  issuer: ISSUER,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  tenant: {
    kind: 'claim' as const,
    claim_name: 'tenant_id',
    claim_value: 'echo-example-company',
  },
  id_token_algorithms: ['RS256'] as const,
};

const FROZEN_CONFIGURATION: FrozenPersonSessionOidcConfiguration = {
  ...CONFIGURATION,
  tenant_constraint_sha256: sha256Digest(
    Buffer.from('test tenant constraint', 'utf8'),
  ),
  oidc_configuration_sha256: sha256Digest(
    Buffer.from('test OIDC configuration', 'utf8'),
  ),
};

const BEGUN_ATTEMPT: BegunPersonOidcLogin = {
  login_attempt_id: 'ola_00000000-0000-4000-8000-000000000001',
  issuer: ISSUER,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: STATE,
  nonce: NONCE,
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: 'S256',
  response_type: 'code',
  scope: 'openid email',
  created_at: '2026-08-18T00:00:00.000Z',
  expires_at: '2026-08-18T00:10:00.000Z',
};

type ProviderFetch = NonNullable<
  OpenIdClientPersonSessionProviderOptions['fetch']
>;

type TokenMode =
  | 'valid'
  | 'missing_access_token'
  | 'missing_id_token'
  | 'missing_issued_at'
  | 'tampered_signature'
  | 'invalid_nonce_claim'
  | 'transport_failure';

interface RecordedTokenRequest {
  method: string;
  authorization: string | null;
  body: URLSearchParams;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class OfflineOidcIssuer {
  readonly publicJwk: JsonWebKey & {
    alg: 'RS256';
    kid: string;
    use: 'sig';
  };
  readonly fetch: ProviderFetch;
  readonly requests: string[] = [];
  readonly tokenRequests: RecordedTokenRequest[] = [];
  mode: TokenMode = 'valid';

  private readonly privateKey: KeyObject;

  constructor() {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = keys.privateKey;
    this.publicJwk = {
      ...keys.publicKey.export({ format: 'jwk' }),
      alg: 'RS256',
      kid: KEY_ID,
      use: 'sig',
    };
    this.fetch = async (url, options) => {
      this.requests.push(url);
      if (url === `${ISSUER}.well-known/openid-configuration`) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          jwks_uri: JWKS_ENDPOINT,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: [
            'none',
            'client_secret_basic',
            'client_secret_post',
          ],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === TOKEN_ENDPOINT) {
        if (!(options.body instanceof URLSearchParams)) {
          throw new Error('token request body was not form encoded');
        }
        this.tokenRequests.push({
          method: options.method,
          authorization: new Headers(options.headers).get('authorization'),
          body: new URLSearchParams(options.body),
        });
        if (this.mode === 'transport_failure') {
          throw new Error('ambiguous token transport failure');
        }
        if (this.mode === 'missing_access_token') {
          return jsonResponse({ token_type: 'Bearer' });
        }
        if (this.mode === 'missing_id_token') {
          return jsonResponse({
            access_token: 'upstream-access-token',
            token_type: 'Bearer',
          });
        }
        const now = Math.floor(Date.now() / 1000);
        const issuedAt = this.mode === 'missing_issued_at' ? undefined : now;
        let idToken = this.signIdToken({
          iss: ISSUER,
          sub: 'opaque-provider-subject',
          aud: CLIENT_ID,
          ...(issuedAt === undefined ? {} : { iat: issuedAt }),
          exp: now + 300,
          nonce: this.mode === 'invalid_nonce_claim' ? 42 : NONCE,
          tenant_id: CONFIGURATION.tenant.claim_value,
          email: VERIFIED_EMAIL,
          email_verified: true,
        });
        if (this.mode === 'tampered_signature') {
          const parts = idToken.split('.');
          const signature = parts[2] ?? '';
          parts[2] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
          idToken = parts.join('.');
        }
        return jsonResponse({
          access_token: 'upstream-access-token',
          refresh_token: 'upstream-refresh-token',
          token_type: 'Bearer',
          id_token: idToken,
        });
      }
      if (url === JWKS_ENDPOINT) {
        return jsonResponse({ keys: [this.publicJwk] });
      }
      throw new Error(`unexpected OIDC URL: ${url}`);
    };
  }

  private signIdToken(claims: Readonly<Record<string, unknown>>): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' }),
      'utf8',
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
      'base64url',
    );
    const signingInput = `${header}.${payload}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(signingInput, 'ascii'),
      this.privateKey,
    ).toString('base64url');
    return `${signingInput}.${signature}`;
  }
}

async function discover(
  issuer: OfflineOidcIssuer,
  clientAuthentication: OpenIdClientAuthentication = {
    method: 'client_secret_basic',
    client_secret: CLIENT_SECRET,
  },
): Promise<OpenIdClientPersonSessionProvider> {
  return OpenIdClientPersonSessionProvider.discover({
    configuration: CONFIGURATION,
    client_authentication: clientAuthentication,
    fetch: issuer.fetch,
  });
}

async function redeem(
  provider: OpenIdClientPersonSessionProvider,
  configuration = FROZEN_CONFIGURATION,
) {
  return provider.redeemAuthorizationCode({
    configuration,
    authorization_code: AUTHORIZATION_CODE,
    pkce_verifier: PKCE_VERIFIER,
  });
}

describe('OpenIdClientPersonSessionProvider', () => {
  it('rejects provider-specific discovery issuer exceptions', async () => {
    const configuredIssuer =
      'https://example.b2clogin.com/example.onmicrosoft.com/policy/v2.0/';
    await expect(
      OpenIdClientPersonSessionProvider.discover({
        configuration: {
          ...CONFIGURATION,
          issuer: configuredIssuer,
        },
        client_authentication: { method: 'none' },
        fetch: async () =>
          jsonResponse({
            issuer: 'https://different-issuer.example.test/',
            authorization_endpoint: AUTHORIZATION_ENDPOINT,
            token_endpoint: TOKEN_ENDPOINT,
            jwks_uri: JWKS_ENDPOINT,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
          }),
      }),
    ).rejects.toThrow(
      'Person-session OIDC discovery issuer differs from configured issuer',
    );
  });

  it('discovers once, builds an exact authorization URL, and returns only verified claims', async () => {
    const issuer = new OfflineOidcIssuer();
    const provider = await discover(issuer);

    const authorizationUrl = new URL(
      provider.buildAuthorizationUrl(BEGUN_ATTEMPT),
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      AUTHORIZATION_ENDPOINT,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email',
      state: STATE,
      nonce: NONCE,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    const result = await redeem(provider);
    expect(result).toMatchObject({
      kind: 'verified',
      token: {
        issuer: ISSUER,
        subject: 'opaque-provider-subject',
        audience: CLIENT_ID,
        nonce: NONCE,
        issued_at: expect.any(Number),
        claims: {
          tenant_id: CONFIGURATION.tenant.claim_value,
          email: VERIFIED_EMAIL,
          email_verified: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('upstream-access-token');
    expect(JSON.stringify(result)).not.toContain('upstream-refresh-token');

    expect(issuer.requests[0]).toBe(
      `${ISSUER}.well-known/openid-configuration`,
    );
    expect(issuer.requests).toContain(JWKS_ENDPOINT);
    expect(issuer.tokenRequests).toHaveLength(1);
    const request = issuer.tokenRequests[0]!;
    expect(request.method).toBe('POST');
    expect(request.authorization).toBe(
      `Basic ${Buffer.from(
        `${CLIENT_ID.replaceAll('-', '%2D')}:${CLIENT_SECRET.replaceAll('-', '%2D')}`,
        'utf8',
      ).toString('base64')}`,
    );
    expect(Object.fromEntries(request.body)).toMatchObject({
      grant_type: 'authorization_code',
      code: AUTHORIZATION_CODE,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
    });
  });

  it('uses public-client authentication without a client credential', async () => {
    const issuer = new OfflineOidcIssuer();
    const provider = await discover(issuer, { method: 'none' });

    await expect(redeem(provider)).resolves.toMatchObject({
      kind: 'verified',
    });
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.tokenRequests[0]?.authorization).toBeNull();
    expect(issuer.tokenRequests[0]?.body.get('client_id')).toBe(CLIENT_ID);
  });

  it('uses client_secret_post without an authorization header', async () => {
    const issuer = new OfflineOidcIssuer();
    const provider = await discover(issuer, {
      method: 'client_secret_post',
      client_secret: CLIENT_SECRET,
    });

    await expect(redeem(provider)).resolves.toMatchObject({
      kind: 'verified',
    });
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.tokenRequests[0]?.authorization).toBeNull();
    expect(Object.fromEntries(issuer.tokenRequests[0]!.body)).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: AUTHORIZATION_CODE,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
    });
  });

  it.each<{
    mode: TokenMode;
    diagnosticStage: 'redemption' | 'response' | 'verification';
  }>([
    { mode: 'missing_access_token', diagnosticStage: 'response' },
    { mode: 'missing_id_token', diagnosticStage: 'verification' },
    { mode: 'missing_issued_at', diagnosticStage: 'response' },
    { mode: 'tampered_signature', diagnosticStage: 'response' },
    { mode: 'invalid_nonce_claim', diagnosticStage: 'verification' },
    { mode: 'transport_failure', diagnosticStage: 'redemption' },
  ])('maps $mode to a secret-free terminal stage', async ({ mode, diagnosticStage }) => {
    const issuer = new OfflineOidcIssuer();
    issuer.mode = mode;
    const provider = await discover(issuer);

    await expect(redeem(provider)).resolves.toEqual({
      kind: 'terminal_failure',
      diagnostic_stage: diagnosticStage,
    });
    expect(issuer.tokenRequests).toHaveLength(1);
  });

  it('rejects a multi-algorithm deployment before discovery', async () => {
    const issuer = new OfflineOidcIssuer();
    await expect(
      OpenIdClientPersonSessionProvider.discover({
        configuration: {
          ...CONFIGURATION,
          id_token_algorithms: ['RS256', 'ES256'],
        },
        client_authentication: { method: 'none' },
        fetch: issuer.fetch,
      }),
    ).rejects.toThrow(
      'Person-session OIDC requires exactly one ID-token algorithm',
    );
    expect(issuer.requests).toHaveLength(0);
  });

  it('terminalizes a mismatched frozen configuration without contacting the token endpoint', async () => {
    const issuer = new OfflineOidcIssuer();
    const provider = await discover(issuer);

    await expect(
      redeem(provider, {
        ...FROZEN_CONFIGURATION,
        client_id: 'another-client',
      }),
    ).resolves.toEqual({
      kind: 'terminal_failure',
      diagnostic_stage: 'configuration',
    });
    expect(issuer.tokenRequests).toHaveLength(0);
  });
});
