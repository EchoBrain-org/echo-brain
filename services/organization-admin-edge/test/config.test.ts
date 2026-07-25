import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ADMIN_EDGE_CONFIG_KIND,
  readOrganizationAdminEdgeRuntimeConfig,
  resolveOrganizationAdminEdgeServeConfig,
  validateOrganizationAdminEdgeRuntimeConfig,
  type OrganizationAdminEdgeRuntimeConfigV1,
} from '../src/config.js';
import { organizationAdminClientCertificateIdentity } from '../src/edge.js';
import { createTestPki, type TestPki } from './support/pki.js';

const PROXY_TOKEN = 'edge-test-proxy-token-000000000000000000000001';

let pki: TestPki;
let proxyTokenPath: string;
let allowedPin: `sha256:${string}`;
let fileSequence = 0;

function fileReference(path: string): string {
  return `file:${path}`;
}

function validConfig(): OrganizationAdminEdgeRuntimeConfigV1 {
  return {
    schema_version: 1,
    kind: ORGANIZATION_ADMIN_EDGE_CONFIG_KIND,
    listener: { host: '127.0.0.1', port: 8443 },
    public_origin: 'https://admin.edge.test:8443',
    employee_authority_base_url: 'https://authority.edge.test',
    authority_origin: 'http://127.0.0.1:39479',
    tls: {
      certificate_chain_ref: fileReference(pki.server.certificate_path),
      private_key_ref: fileReference(pki.server.private_key_path),
      client_ca_bundle_ref: fileReference(pki.ca_certificate_path),
    },
    trusted_proxy_token_ref: fileReference(proxyTokenPath),
    allowed_admin_client_spki_sha256: [allowedPin],
  };
}

function writeConfig(value: unknown, mode = 0o600): string {
  fileSequence += 1;
  const path = join(pki.directory, `edge-${String(fileSequence)}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode,
  });
  return realpathSync(path);
}

beforeAll(() => {
  pki = createTestPki();
  proxyTokenPath = join(pki.directory, 'trusted-proxy-token');
  writeFileSync(proxyTokenPath, PROXY_TOKEN, {
    encoding: 'ascii',
    mode: 0o600,
  });
  proxyTokenPath = realpathSync(proxyTokenPath);
  allowedPin = organizationAdminClientCertificateIdentity(
    new X509Certificate(pki.admin_one.certificate),
  ).pin;
});

afterAll(() => pki.cleanup());

describe('organization administrator edge runtime config', () => {
  it('reads an exact private config and resolves bounded private material', () => {
    const configPath = writeConfig(validConfig());
    const config = readOrganizationAdminEdgeRuntimeConfig(configPath);
    expect(config).toEqual(validConfig());

    const resolved = resolveOrganizationAdminEdgeServeConfig(config);
    expect(resolved).toMatchObject({
      listener: { host: '127.0.0.1', port: 8443 },
      public_origin: 'https://admin.edge.test:8443',
      employee_authority_base_url: 'https://authority.edge.test',
      authority_origin: 'http://127.0.0.1:39479',
      trusted_proxy_token: PROXY_TOKEN,
    });
    expect(resolved.tls.certificate_chain).toEqual(pki.server.certificate);
    expect(resolved.tls.private_key).toEqual(pki.server.private_key);
    expect(resolved.tls.client_ca_bundle).toEqual(pki.ca_certificate);
    expect(resolved.allowed_admin_client_spki_sha256).toEqual(
      new Set([allowedPin]),
    );
  });

  it('rejects noncanonical public and nonloopback authority origins', () => {
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        public_origin: 'https://admin.edge.test:8443/',
      }),
    ).toThrow('canonical bare HTTPS origin');
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        authority_origin: 'http://192.0.2.1:39479',
      }),
    ).toThrow('bare loopback HTTP origin');
  });

  it('requires one bounded canonical bare HTTPS employee authority URL', () => {
    const missing = {
      ...validConfig(),
    } as unknown as Record<string, unknown>;
    delete missing.employee_authority_base_url;
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig(missing),
    ).toThrow('unexpected shape');

    for (const employeeAuthorityBaseUrl of [
      'http://authority.edge.test',
      'https://operator@authority.edge.test',
      'https://authority.edge.test/path',
      'https://authority.edge.test?query=value',
      'https://authority.edge.test#fragment',
    ]) {
      expect(() =>
        validateOrganizationAdminEdgeRuntimeConfig({
          ...validConfig(),
          employee_authority_base_url: employeeAuthorityBaseUrl,
        }),
      ).toThrow('canonical bare HTTPS origin');
    }
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        employee_authority_base_url: `https://${'a'.repeat(2050)}.test`,
      }),
    ).toThrow('bounded string');
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        employee_authority_base_url: validConfig().public_origin,
      }),
    ).toThrow('must be distinct');
  });

  it('rejects unexpected fields and noncanonical or duplicate client pins', () => {
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        surprise: true,
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        allowed_admin_client_spki_sha256: ['sha256:ABC'],
      }),
    ).toThrow('canonical SHA-256');
    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        allowed_admin_client_spki_sha256: [allowedPin, allowedPin],
      }),
    ).toThrow('must be unique');
  });

  it('rejects a config or referenced TLS file that is not current-user 0600', () => {
    const publicConfig = writeConfig(validConfig(), 0o644);
    expect(() => readOrganizationAdminEdgeRuntimeConfig(publicConfig)).toThrow(
      'current-user 0600',
    );

    const privateConfig = readOrganizationAdminEdgeRuntimeConfig(
      writeConfig(validConfig()),
    );
    chmodSync(pki.server.certificate_path, 0o644);
    try {
      expect(() =>
        resolveOrganizationAdminEdgeServeConfig(privateConfig),
      ).toThrow('current-user 0600');
    } finally {
      chmodSync(pki.server.certificate_path, 0o600);
    }
  });

  it('rejects symlinked credentials and credentials reused as TLS material', () => {
    const linkPath = join(pki.directory, 'proxy-token-link');
    symlinkSync(proxyTokenPath, linkPath);
    const symlinked = readOrganizationAdminEdgeRuntimeConfig(
      writeConfig({
        ...validConfig(),
        trusted_proxy_token_ref: fileReference(linkPath),
      }),
    );
    expect(() => resolveOrganizationAdminEdgeServeConfig(symlinked)).toThrow(
      'canonical regular file',
    );

    expect(() =>
      validateOrganizationAdminEdgeRuntimeConfig({
        ...validConfig(),
        trusted_proxy_token_ref: fileReference(pki.server.private_key_path),
      }),
    ).toThrow('distinct from TLS material');
  });

  it('rejects distinct paths that hard-link the same private file inode', () => {
    const hardLinkPath = join(pki.directory, 'hard-linked-client-ca.pem');
    linkSync(pki.server.certificate_path, hardLinkPath);
    const config = readOrganizationAdminEdgeRuntimeConfig(
      writeConfig({
        ...validConfig(),
        tls: {
          ...validConfig().tls,
          client_ca_bundle_ref: fileReference(hardLinkPath),
        },
      }),
    );
    expect(() => resolveOrganizationAdminEdgeServeConfig(config)).toThrow(
      'must be distinct files',
    );
  });

  it('rejects a proxy token containing whitespace or a trailing newline', () => {
    const invalidTokenPath = join(pki.directory, 'invalid-proxy-token');
    writeFileSync(
      invalidTokenPath,
      `${'x'.repeat(32)}\n`,
      { encoding: 'ascii', mode: 0o600 },
    );
    const config = readOrganizationAdminEdgeRuntimeConfig(
      writeConfig({
        ...validConfig(),
        trusted_proxy_token_ref: fileReference(
          realpathSync(invalidTokenPath),
        ),
      }),
    );
    expect(() => resolveOrganizationAdminEdgeServeConfig(config)).toThrow(
      'visible ASCII',
    );
  });
});
