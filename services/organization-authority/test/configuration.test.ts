import { describe, expect, it } from 'vitest';
import {
  assertPersistentAuthorityDatabasePath,
  loadAuthorityServeConfig,
} from '../src/composition/config.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';

const BASE_ENVIRONMENT: NodeJS.ProcessEnv = {
  ECHO_ORGANIZATION_AUTHORITY_ALLOW_DEVELOPMENT_FILE_SIGNER: 'true',
  ECHO_ORGANIZATION_AUTHORITY_ID: 'oau_00000000-0000-4000-8000-000000000001',
  ECHO_ORGANIZATION_ID: 'org_00000000-0000-4000-8000-000000000001',
  ECHO_ORGANIZATION_AUTHORITY_DEVELOPMENT_KEY_DIRECTORY: '/tmp/keys',
  ECHO_ORGANIZATION_AUTHORITY_PIN_SHA256: `sha256:${'1'.repeat(64)}`,
  ECHO_ORGANIZATION_DISPLAY_NAME: 'Example Company',
  ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH: '/tmp/authority.sqlite',
  ECHO_ORGANIZATION_AUTHORITY_ADMIN_TOKEN:
    'test-admin-token-with-at-least-32-bytes',
  ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN:
    'test-proxy-token-with-at-least-32-bytes',
};

describe('authority serve configuration', () => {
  it('requires the trusted TLS-terminator identity contract', () => {
    const environment = { ...BASE_ENVIRONMENT };
    delete environment.ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN;
    expect(() => loadAuthorityServeConfig(environment)).toThrow(
      'ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN is required',
    );
  });

  it('rejects direct production composition without a proxy token', async () => {
    const config = loadAuthorityServeConfig(BASE_ENVIRONMENT);
    delete (config as unknown as Record<string, unknown>).trusted_proxy_token;
    await expect(startOrganizationAuthority(config)).rejects.toThrow(
      'trusted proxy token must be',
    );
  });

  it('requires distinct administrator and trusted-proxy tokens', async () => {
    expect(() =>
      loadAuthorityServeConfig({
        ...BASE_ENVIRONMENT,
        ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN:
          BASE_ENVIRONMENT.ECHO_ORGANIZATION_AUTHORITY_ADMIN_TOKEN,
      }),
    ).toThrow('must be distinct credentials');

    const config = loadAuthorityServeConfig(BASE_ENVIRONMENT);
    config.trusted_proxy_token = config.admin_token;
    await expect(startOrganizationAuthority(config)).rejects.toThrow(
      'must be distinct credentials',
    );
  });

  it('rejects an in-memory database for the serving process', () => {
    expect(() => assertPersistentAuthorityDatabasePath(':memory:')).toThrow(
      'must use persistent storage when serving',
    );
    expect(() =>
      loadAuthorityServeConfig({
        ...BASE_ENVIRONMENT,
        ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH: ':memory:',
      }),
    ).toThrow('must use persistent storage when serving');
  });

  it('rejects direct production composition with an in-memory database', async () => {
    const config = loadAuthorityServeConfig(BASE_ENVIRONMENT);
    config.database_path = ':memory:';
    await expect(startOrganizationAuthority(config)).rejects.toThrow(
      'must use persistent storage when serving',
    );
  });

  it('loads the explicit proxy token and persistent database path', () => {
    const config = loadAuthorityServeConfig(BASE_ENVIRONMENT);
    expect(config.trusted_proxy_token).toBe(
      BASE_ENVIRONMENT.ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN,
    );
    expect(config.database_path).toBe(
      BASE_ENVIRONMENT.ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH,
    );
  });
});
