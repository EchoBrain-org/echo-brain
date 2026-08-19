import { Buffer } from 'node:buffer';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVELOPMENT_AUTHORITY_KEY_FILENAME } from '../src/adapters/security/development-file-authority-signer.js';
import { authorityRuntimeFingerprint } from '../src/adapters/runtime/runtime-fingerprint.js';
import type { AuthorityServeConfig } from '../src/composition/config.js';
import type { AuthorityRuntimeConfigV1 } from '../src/composition/operator-config.js';
import {
  AUTHORITY_PERSON_SESSION_OIDC_CLIENT_SECRET_FILENAME,
  AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME,
  AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME,
  readAuthorityPersonSessionRuntimeOverlay,
} from '../src/composition/person-session-runtime-config.js';

const temporaryRoots: string[] = [];

function fixture(): {
  root: string;
  config: AuthorityRuntimeConfigV1;
  overlayPath: string;
  keyPath: string;
  clientSecretPath: string;
} {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-person-session-config-')),
  );
  temporaryRoots.push(root);
  const stateDirectory = join(root, 'state');
  const credentialDirectory = join(stateDirectory, 'credentials');
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  const overlayPath = join(
    stateDirectory,
    AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME,
  );
  const keyPath = join(
    credentialDirectory,
    AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME,
  );
  const clientSecretPath = join(
    credentialDirectory,
    AUTHORITY_PERSON_SESSION_OIDC_CLIENT_SECRET_FILENAME,
  );
  const config: AuthorityRuntimeConfigV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-config',
    state_dir: stateDirectory,
    organization: {
      organization_id: 'org_11111111-1111-4111-8111-111111111111',
      display_name: 'Example Company',
    },
    authority: {
      authority_id: 'oau_22222222-2222-4222-8222-222222222222',
      authority_pin_sha256: `sha256:${'a'.repeat(64)}`,
    },
    signer: {
      adapter_id: 'development-file',
      key_directory: join(stateDirectory, 'keys'),
    },
    database_path: join(stateDirectory, 'authority.sqlite'),
    listener: { host: '127.0.0.1', port: 39479 },
    credentials: {
      admin_token_ref: `file:${join(credentialDirectory, 'admin-token')}`,
      trusted_proxy_token_ref: `file:${join(
        credentialDirectory,
        'trusted-proxy-token',
      )}`,
    },
    access: {
      active_lease_ttl_ms: 60_000,
      request_maximum_age_ms: 60_000,
    },
  };
  return { root, config, overlayPath, keyPath, clientSecretPath };
}

function overlay(
  config: AuthorityRuntimeConfigV1,
  keyPath: string,
  clientAuthentication: Record<string, unknown> = { method: 'none' },
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-person-session-runtime-overlay',
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    oidc: {
      issuer: 'https://issuer.example/tenant',
      client_id: 'echo-person-client',
      redirect_uri:
        'https://authority.example/v2/session/oidc/callback',
      tenant: { kind: 'issuer' },
      id_token_algorithms: ['RS256'],
      client_authentication: clientAuthentication,
    },
    pkce_sealing_key_ref: `file:${keyPath}`,
  };
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function writePrivateCredential(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function fingerprintBase(
  config: AuthorityRuntimeConfigV1,
): AuthorityServeConfig {
  const keyDirectory = join(config.state_dir, 'keys');
  mkdirSync(keyDirectory, { mode: 0o700 });
  writeFileSync(
    join(keyDirectory, DEVELOPMENT_AUTHORITY_KEY_FILENAME),
    'development-signing-key',
  );
  for (const filename of [
    'authority.sqlite',
    'integrations.sqlite',
    'record-log.sqlite',
    'record-derived.sqlite',
  ]) {
    writeFileSync(join(config.state_dir, filename), filename);
  }
  writePrivateJson(
    join(config.state_dir, 'authority-integrations-installation.v1.json'),
    { installed: true },
  );
  return {
    state_directory: config.state_dir,
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    key_directory: keyDirectory,
    organization_display_name: config.organization.display_name,
    authority_pin_sha256: config.authority.authority_pin_sha256,
    database_path: config.database_path,
    integrations_database_path: join(
      config.state_dir,
      'integrations.sqlite',
    ),
    record_log_database_path: join(config.state_dir, 'record-log.sqlite'),
    record_derived_database_path: join(
      config.state_dir,
      'record-derived.sqlite',
    ),
    admin_token: 'a'.repeat(43),
    trusted_proxy_token: 'b'.repeat(43),
    host: config.listener.host,
    port: config.listener.port,
    active_lease_ttl_ms: config.access.active_lease_ttl_ms,
    access_request_maximum_age_ms: config.access.request_maximum_age_ms,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Person-session runtime overlay', () => {
  it('is opt-in and leaves an Authority without the fixed overlay unchanged', () => {
    const { config } = fixture();
    expect(readAuthorityPersonSessionRuntimeOverlay(config)).toBeUndefined();
  });

  it('resolves the closed public-client configuration and exact PKCE key', () => {
    const { config, overlayPath, keyPath } = fixture();
    const key = Buffer.from(Array.from({ length: 32 }, (_value, index) => index));
    writePrivateCredential(keyPath, key.toString('base64url'));
    writePrivateJson(overlayPath, overlay(config, keyPath));

    const resolved = readAuthorityPersonSessionRuntimeOverlay(config);
    expect(resolved).toMatchObject({
      overlay_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      oidc_configuration: {
        issuer: 'https://issuer.example/tenant',
        client_id: 'echo-person-client',
        redirect_uri:
          'https://authority.example/v2/session/oidc/callback',
        tenant: { kind: 'issuer' },
        id_token_algorithms: ['RS256'],
      },
      client_authentication: { method: 'none' },
    });
    expect(Buffer.from(resolved!.pkce_sealing_key)).toEqual(key);
  });

  it('accepts a canonical root issuer without adding a trailing slash', () => {
    const { config, overlayPath, keyPath } = fixture();
    writePrivateCredential(keyPath, Buffer.alloc(32, 6).toString('base64url'));
    const googleOverlay = overlay(config, keyPath);
    (googleOverlay.oidc as Record<string, unknown>).issuer =
      'https://accounts.google.com';
    writePrivateJson(overlayPath, googleOverlay);

    expect(
      readAuthorityPersonSessionRuntimeOverlay(config)?.oidc_configuration
        .issuer,
    ).toBe('https://accounts.google.com');
  });

  it('reads client_secret_basic only from its fixed private file', () => {
    const { config, overlayPath, keyPath, clientSecretPath } = fixture();
    writePrivateCredential(keyPath, Buffer.alloc(32, 7).toString('base64url'));
    writePrivateCredential(clientSecretPath, 'provider-secret');
    writePrivateJson(
      overlayPath,
      overlay(config, keyPath, {
        method: 'client_secret_basic',
        client_secret_ref: `file:${clientSecretPath}`,
      }),
    );

    expect(
      readAuthorityPersonSessionRuntimeOverlay(config)?.client_authentication,
    ).toEqual({
      method: 'client_secret_basic',
      client_secret: 'provider-secret',
    });
  });

  it('fails closed on another Authority, unknown fields, and nonfixed refs', () => {
    const { config, overlayPath, keyPath } = fixture();
    writePrivateCredential(keyPath, Buffer.alloc(32, 1).toString('base64url'));

    for (const candidate of [
      { ...overlay(config, keyPath), authority_id: 'oau_other' },
      { ...overlay(config, keyPath), extra: true },
      {
        ...overlay(config, keyPath),
        pkce_sealing_key_ref: `file:${join(config.state_dir, 'other-key')}`,
      },
    ]) {
      writePrivateJson(overlayPath, candidate);
      expect(() => readAuthorityPersonSessionRuntimeOverlay(config)).toThrow();
    }
  });

  it('rejects public or linked files and noncanonical key material', () => {
    const { config, overlayPath, keyPath } = fixture();
    writePrivateCredential(keyPath, Buffer.alloc(31, 1).toString('base64url'));
    writePrivateJson(overlayPath, overlay(config, keyPath));
    expect(() => readAuthorityPersonSessionRuntimeOverlay(config)).toThrow(
      'authority credential',
    );

    writePrivateCredential(keyPath, Buffer.alloc(32, 1).toString('base64url'));
    chmodSync(keyPath, 0o644);
    expect(() => readAuthorityPersonSessionRuntimeOverlay(config)).toThrow(
      'authority credential',
    );

    rmSync(overlayPath);
    const target = join(config.state_dir, 'overlay-target.json');
    writePrivateJson(target, overlay(config, keyPath));
    symlinkSync(target, overlayPath);
    expect(() => readAuthorityPersonSessionRuntimeOverlay(config)).toThrow(
      'Person-session runtime overlay',
    );
  });

  it('never includes raw provider secrets in validation failures', () => {
    const { config, overlayPath, keyPath, clientSecretPath } = fixture();
    const secret = 'raw-provider-secret-do-not-reflect';
    writePrivateCredential(keyPath, Buffer.alloc(32, 3).toString('base64url'));
    writePrivateCredential(clientSecretPath, secret);
    writePrivateJson(
      overlayPath,
      overlay(config, keyPath, {
        method: 'client_secret_basic',
        client_secret_ref: 'file:/wrong/path',
      }),
    );
    let message = '';
    try {
      readAuthorityPersonSessionRuntimeOverlay(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).not.toContain('/wrong/path');
  });

  it('binds only enabled Person configuration and secret digests into runtime identity', () => {
    const { config, overlayPath, keyPath, clientSecretPath } = fixture();
    const base = fingerprintBase(config);
    const absent = authorityRuntimeFingerprint(base);

    writePrivateCredential(keyPath, Buffer.alloc(32, 4).toString('base64url'));
    writePrivateCredential(clientSecretPath, 'first-provider-secret');
    writePrivateJson(
      overlayPath,
      overlay(config, keyPath, {
        method: 'client_secret_basic',
        client_secret_ref: `file:${clientSecretPath}`,
      }),
    );
    expect(authorityRuntimeFingerprint(base)).toBe(absent);

    const first = readAuthorityPersonSessionRuntimeOverlay(config)!;
    const firstFingerprint = authorityRuntimeFingerprint({
      ...base,
      person_session_runtime_v1: first,
    });
    expect(firstFingerprint).not.toBe(absent);

    writePrivateCredential(keyPath, Buffer.alloc(32, 5).toString('base64url'));
    const changedKey = readAuthorityPersonSessionRuntimeOverlay(config)!;
    const changedKeyFingerprint = authorityRuntimeFingerprint({
      ...base,
      person_session_runtime_v1: changedKey,
    });
    expect(changedKeyFingerprint).not.toBe(firstFingerprint);

    writePrivateCredential(clientSecretPath, 'second-provider-secret');
    const changedSecret = readAuthorityPersonSessionRuntimeOverlay(config)!;
    expect(
      authorityRuntimeFingerprint({
        ...base,
        person_session_runtime_v1: changedSecret,
      }),
    ).not.toBe(changedKeyFingerprint);
  });
});
