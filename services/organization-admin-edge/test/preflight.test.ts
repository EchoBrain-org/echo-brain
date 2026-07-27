import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrganizationAdminEdgeServeConfig } from '../src/config.js';
import {
  OrganizationAdminEdgePreflightError,
  organizationAdminClientCertificateIdentity,
  preflightOrganizationAdminEdgeServeConfig,
  type OrganizationAdminEdgePreflightFailure,
} from '../src/edge.js';
import {
  createTestPki,
  createTestServerPurposeCertificates,
  type TestPki,
  type TestServerPurposeCertificates,
} from '../../../tests/support/organization-admin-edge-pki.js';

const PROXY_TOKEN = 'edge-test-proxy-token-000000000000000000000001';

let pki: TestPki;
let purposeCertificates: TestServerPurposeCertificates;
let currentTime: Date;
let adminPin: `sha256:${string}`;

function serveConfig(
  overrides: Partial<OrganizationAdminEdgeServeConfig> = {},
): OrganizationAdminEdgeServeConfig {
  return {
    listener: { host: '127.0.0.1', port: 8443 },
    public_origin: 'https://admin.edge.test:8443',
    employee_authority_base_url: 'https://authority.edge.test',
    authority_origin: 'http://127.0.0.1:39479',
    tls: {
      certificate_chain: pki.server.certificate,
      private_key: pki.server.private_key,
      client_ca_bundle: pki.ca_certificate,
    },
    trusted_proxy_token: PROXY_TOKEN,
    allowed_admin_client_spki_sha256: new Set([adminPin]),
    ...overrides,
  };
}

function preflightFailure(
  run: () => unknown,
): OrganizationAdminEdgePreflightError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OrganizationAdminEdgePreflightError);
    return error as OrganizationAdminEdgePreflightError;
  }
  throw new Error('expected administrator edge preflight to fail');
}

function expectPreflightFailure(
  run: () => unknown,
  failedCheck: OrganizationAdminEdgePreflightFailure,
): void {
  expect(preflightFailure(run).failed_check).toBe(failedCheck);
}

beforeAll(() => {
  pki = createTestPki();
  purposeCertificates = createTestServerPurposeCertificates(pki);
  const serverCertificate = new X509Certificate(pki.server.certificate);
  const clientCaCertificate = new X509Certificate(pki.ca_certificate);
  const lowerBound = Math.max(
    serverCertificate.validFromDate.getTime(),
    clientCaCertificate.validFromDate.getTime(),
  );
  const upperBound = Math.min(
    serverCertificate.validToDate.getTime(),
    clientCaCertificate.validToDate.getTime(),
  );
  currentTime = new Date(
    lowerBound + Math.floor((upperBound - lowerBound) / 2),
  );
  adminPin = organizationAdminClientCertificateIdentity(
    new X509Certificate(pki.admin_one.certificate),
  ).pin;
});

afterAll(() => pki.cleanup());

describe('organization administrator edge no-bind preflight', () => {
  it('validates current TLS material and returns only deployment metadata', () => {
    const serverCertificate = new X509Certificate(pki.server.certificate);
    const result = preflightOrganizationAdminEdgeServeConfig(serveConfig(), {
      now: currentTime,
    });

    expect(result).toEqual({
      listener: { host: '127.0.0.1', port: 8443 },
      public_origin: 'https://admin.edge.test:8443',
      employee_authority_base_url: 'https://authority.edge.test',
      authority_origin: 'http://127.0.0.1:39479',
      allowed_admin_client_count: 1,
      checked_at: currentTime.toISOString(),
      server_certificate_not_before:
        serverCertificate.validFromDate.toISOString(),
      server_certificate_not_after: serverCertificate.validToDate.toISOString(),
      client_ca_certificate_count: 1,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PROXY_TOKEN);
    expect(serialized).not.toContain(adminPin);
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');

    const twoCaResult = preflightOrganizationAdminEdgeServeConfig(
      serveConfig({
        tls: {
          certificate_chain: pki.server.certificate,
          private_key: pki.server.private_key,
          client_ca_bundle: Buffer.concat([
            pki.ca_certificate,
            Buffer.from('\n', 'utf8'),
            pki.ca_certificate,
          ]),
        },
      }),
      { now: currentTime },
    );
    expect(twoCaResult.client_ca_certificate_count).toBe(2);
  });

  it('rejects a server certificate outside its validity window', () => {
    const certificate = new X509Certificate(pki.server.certificate);
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(serveConfig(), {
          now: new Date(certificate.validFromDate.getTime() - 1_000),
        }),
      'server_certificate_not_yet_valid',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(serveConfig(), {
          now: new Date(certificate.validToDate.getTime()),
        }),
      'server_certificate_expired',
    );
  });

  it('rejects a wrong hostname and a mismatched server private key', () => {
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            public_origin: 'https://wrong.edge.test:8443',
          }),
          { now: currentTime },
        ),
      'server_certificate_hostname',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: pki.server.certificate,
              private_key: pki.admin_one.private_key,
              client_ca_bundle: pki.ca_certificate,
            },
          }),
          { now: currentTime },
        ),
      'server_private_key_mismatch',
    );
  });

  it('rejects server certificates that cannot serve TLS', () => {
    for (const certificate of [
      purposeCertificates.ca_server,
      purposeCertificates.client_auth_only,
    ]) {
      expectPreflightFailure(
        () =>
          preflightOrganizationAdminEdgeServeConfig(
            serveConfig({
              tls: {
                certificate_chain: certificate.certificate,
                private_key: certificate.private_key,
                client_ca_bundle: pki.ca_certificate,
              },
            }),
            { now: currentTime },
          ),
        'server_certificate_purpose',
      );
    }
  });

  it('rejects malformed server material and a non-CA client trust anchor', () => {
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: Buffer.from('not a certificate', 'utf8'),
              private_key: pki.server.private_key,
              client_ca_bundle: pki.ca_certificate,
            },
          }),
          { now: currentTime },
        ),
      'server_certificate_parse',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: pki.server.certificate,
              private_key: Buffer.from('not a private key', 'utf8'),
              client_ca_bundle: pki.ca_certificate,
            },
          }),
          { now: currentTime },
        ),
      'server_private_key_parse',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: pki.server.certificate,
              private_key: pki.server.private_key,
              client_ca_bundle: pki.server.certificate,
            },
          }),
          { now: currentTime },
      ),
      'client_ca_or_tls_context',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: pki.server.certificate,
              private_key: pki.server.private_key,
              client_ca_bundle: Buffer.concat([
                pki.ca_certificate,
                Buffer.from('not a PEM certificate', 'utf8'),
              ]),
            },
          }),
          { now: currentTime },
        ),
      'client_ca_or_tls_context',
    );
    expectPreflightFailure(
      () =>
        preflightOrganizationAdminEdgeServeConfig(
          serveConfig({
            tls: {
              certificate_chain: pki.server.certificate,
              private_key: pki.server.private_key,
              client_ca_bundle: purposeCertificates.ca_server.certificate,
            },
          }),
          { now: currentTime },
        ),
      'client_ca_or_tls_context',
    );
  });
});
