import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSlackBrowserIdentityProvider } from '../src/adapters/oidc/slack-browser-identity-provider.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const clientId = '123.456';
const redirectUri = 'https://authority.example/v2/person/external-identities/slack/browser/callback';
const state = 's'.repeat(43);
const nonce = 'n'.repeat(43);
const verifier = 'v'.repeat(43);
const workspace = 'T123';

function setup(overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://slack.com', sub: 'U123', aud: clientId,
    iat: now, exp: now + 300, nonce,
    'https://slack.com/team_id': workspace, 'https://slack.com/user_id': 'U123',
    ...overrides };
  const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}`;
  const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), invalidSignature ? otherKeys.privateKey : keys.privateKey).toString('base64url')}`;
  const provider = createSlackBrowserIdentityProvider({
    client_id: clientId, client_secret: 'test-client-secret', redirect_uri: redirectUri,
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: new URLSearchParams(options?.body as string) });
      if (String(url) === 'https://slack.com/openid/connect/keys') {
        return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      }
      if (String(url) === 'https://slack.com/api/openid.connect.token') {
        return Response.json({ ok: true, access_token: 'test-access-token', token_type: 'Bearer', id_token: token });
      }
      throw new Error('unexpected endpoint');
    },
  });
  const input = { body: new URLSearchParams({ state, code: 'test-authorization-code' }),
    expectedState: state, expectedNonce: nonce, workspace_id: workspace, code_verifier: verifier };
  return { provider, input, calls };
}

describe('Slack browser identity provider', () => {
  it('uses the fixed Slack authorize endpoint with workspace, nonce and S256 PKCE', async () => {
    const { provider, calls } = setup();
    const url = new URL(provider.authorizationUrl({ state, nonce, workspace_id: workspace, code_verifier: verifier }));
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: clientId, redirect_uri: redirectUri,
      scope: 'openid profile', response_type: 'code', response_mode: 'form_post', team: workspace, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('verifies Slack signature and returns only identity plus a proof digest', async () => {
    const { provider, input, calls } = setup();
    const identity = await provider.verifyCallback(input);
    expect(identity).toEqual({ team_id: workspace, user_id: 'U123', verification_evidence_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(calls.map(call => call.url)).toContain('https://slack.com/openid/connect/keys');
    const request = calls.find(call => call.url.endsWith('/openid.connect.token'))!;
    expect(request.body.get('code_verifier')).toBe(verifier);
    expect(request.body.get('redirect_uri')).toBe(redirectUri);
    expect(request.body.get('client_secret')).toBe('test-client-secret');
  });

  it.each([
    ['workspace', { 'https://slack.com/team_id': 'TOTHER' }],
    ['missing workspace', { 'https://slack.com/team_id': null }],
    ['invalid user', { 'https://slack.com/user_id': 'B123' }],
    ['nonce', { nonce: 'wrong' }],
    ['audience', { aud: 'other-client' }],
    ['issuer', { iss: 'https://attacker.example' }],
    ['expiry', { exp: 1 }],
    ['future issued-at', { iat: Math.floor(Date.now() / 1000) + 300 }],
  ])('rejects a mismatched %s with a safe error', async (_name, claims) => {
    const { provider, input } = setup(claims);
    await expect(provider.verifyCallback(input)).rejects.toThrow(/^Slack identity verification failed$/);
  });

  it('rejects invalid signatures', async () => {
    const { provider, input } = setup({}, true);
    await expect(provider.verifyCallback(input)).rejects.toThrow(/^Slack identity verification failed$/);
  });

  it.each(['wrong-state', 'duplicate-state', 'duplicate-code'])('rejects %s before contacting Slack', async (variant) => {
    const { provider, input, calls } = setup();
    if (variant === 'wrong-state') input.body.set('state', 'wrong');
    else input.body.append(variant === 'duplicate-state' ? 'state' : 'code', 'other');
    await expect(provider.verifyCallback(input)).rejects.toThrow(/^Slack identity verification failed$/);
    expect(calls).toHaveLength(0);
  });

  it('does not expose a provider error description or authorization code', async () => {
    const { provider, input, calls } = setup();
    input.body.delete('code'); input.body.set('error', 'access_denied');
    input.body.set('error_description', 'sensitive-provider-detail');
    await expect(provider.verifyCallback(input)).rejects.toThrow(/^Slack identity verification failed$/);
    expect(calls).toHaveLength(0);
  });

  it.each(['http://authority.example/callback', 'https://user:secret@authority.example/callback',
    'https://authority.example/callback?token=secret', 'https://authority.example/callback#fragment'])('rejects unsafe callback configuration %s', redirect_uri => {
    expect(() => createSlackBrowserIdentityProvider({ client_id: clientId, client_secret: 'test', redirect_uri })).toThrow();
  });
});
