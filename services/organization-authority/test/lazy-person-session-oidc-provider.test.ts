import { describe, expect, it } from 'vitest';
import type { FrozenPersonSessionOidcConfiguration } from '../src/application/ports/person-session-dependencies.js';
import { LazyPersonSessionOidcProvider } from '../src/composition/lazy-person-session-oidc-provider.js';

const CONFIGURATION: FrozenPersonSessionOidcConfiguration = {
  issuer: 'https://identity.example/tenant',
  client_id: 'echo-person-client',
  redirect_uri: 'https://authority.example/v2/session/oidc/callback',
  tenant: { kind: 'issuer' },
  id_token_algorithms: ['RS256'],
  tenant_constraint_sha256: `sha256:${'a'.repeat(64)}`,
  oidc_configuration_sha256: `sha256:${'b'.repeat(64)}`,
};

describe('lazy Person-session OIDC provider', () => {
  it('stays offline until requested, retries discovery failure, and caches success', async () => {
    let discoveryCalls = 0;
    let redemptionCalls = 0;
    const lazy = new LazyPersonSessionOidcProvider(async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        throw new Error('identity provider is temporarily unavailable');
      }
      return {
        buildAuthorizationUrl: () => 'https://identity.example/authorize',
        redeemAuthorizationCode: async () => {
          redemptionCalls += 1;
          return { kind: 'terminal_failure' } as const;
        },
      };
    });

    expect(discoveryCalls).toBe(0);
    await expect(
      lazy.redeemAuthorizationCode({
        configuration: CONFIGURATION,
        authorization_code: 'authorization-code',
        pkce_verifier: 'v'.repeat(43),
      }),
    ).resolves.toEqual({ kind: 'retryable_before_redemption' });
    expect(discoveryCalls).toBe(1);
    expect(redemptionCalls).toBe(0);

    await expect(
      lazy.redeemAuthorizationCode({
        configuration: CONFIGURATION,
        authorization_code: 'authorization-code',
        pkce_verifier: 'v'.repeat(43),
      }),
    ).resolves.toEqual({ kind: 'terminal_failure' });
    expect(discoveryCalls).toBe(2);
    expect(redemptionCalls).toBe(1);

    await lazy.acquire();
    expect(discoveryCalls).toBe(2);
  });
});
