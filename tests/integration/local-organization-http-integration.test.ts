import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeP256LowS,
  p256KeyId,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/machine/security/installation-signer.js';
import { HttpOrganizationAuthorityClient } from '../../src/product/organization/client/http-organization-authority-client.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../../services/organization-authority/src/adapters/security/development-file-authority-signer.js';
import { SqliteOrganizationAuthorityRepository } from '../../services/organization-authority/src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { startOrganizationAuthority } from '../../services/organization-authority/src/composition/runtime.js';
import {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../../services/organization-authority/src/presentation/trusted-proxy-client-identity.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const PROXY_CLIENT_ID = `cid_${createHash('sha256')
  .update('integration-client')
  .digest('base64url')}`;

const temporaryDirectories: string[] = [];

const proxyFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set(TRUSTED_PROXY_AUTHORIZATION_HEADER, `Echo-Proxy ${PROXY_TOKEN}`);
  headers.set(TRUSTED_PROXY_CLIENT_ID_HEADER, PROXY_CLIENT_ID);
  return fetch(input, { ...init, headers });
};

class MemoryInstallationSigner implements InstallationSigner {
  private readonly privateKey: KeyObject;
  private descriptor: InstallationKeyDescriptor | null = null;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
    this.pendingPublicKey = publicKey;
  }

  private readonly pendingPublicKey: Buffer;

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    if (this.descriptor !== null) return structuredClone(this.descriptor);
    this.descriptor = {
      installation_id: installationId,
      key_id: p256KeyId(this.pendingPublicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: this.pendingPublicKey.toString('base64'),
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    };
    return structuredClone(this.descriptor);
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    if (
      this.descriptor === null ||
      this.descriptor.installation_id !== installationId
    ) {
      return null;
    }
    return structuredClone(this.descriptor);
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    const descriptor = await this.inspect(installationId);
    if (descriptor === null || descriptor.key_id !== expectedKeyId) {
      throw new Error('test installation key mismatch');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

async function adminPost(
  origin: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await proxyFetch(new URL(path, origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`test admin request failed with ${response.status}`);
  }
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('test authority response is not an object');
  }
  return value as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local organization over the central HTTP authority', () => {
  it('enrolls, refreshes, persists permission, and receives terminal revocation', async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-org-http-')),
    );
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const keyDirectory = join(directory, 'keys');
    const signer = DevelopmentFileOrganizationAuthoritySigner.open({
      directory: keyDirectory,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
    });
    const authorityDescriptor = await signer.inspect();
    const authorityPin = organizationAuthorityPinSha256(authorityDescriptor);
    const authorityDatabasePath = join(directory, 'authority.sqlite');
    const authorityRepository = new SqliteOrganizationAuthorityRepository(
      authorityDatabasePath,
    );
    try {
      authorityRepository.initialize({
        descriptor: authorityDescriptor,
        authority_pin_sha256: authorityPin,
        organization_display_name: 'Example Company',
        maximum_active_lease_ttl_ms: 60_000,
        initialized_at: new Date().toISOString(),
      });
    } finally {
      authorityRepository.close();
    }
    const runtime = await startOrganizationAuthority({
      state_directory: directory,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      key_directory: keyDirectory,
      organization_display_name: 'Example Company',
      authority_pin_sha256: authorityPin,
      database_path: authorityDatabasePath,
      admin_token: ADMIN_TOKEN,
      trusted_proxy_token: PROXY_TOKEN,
      host: '127.0.0.1',
      port: 0,
      active_lease_ttl_ms: 60_000,
      access_request_maximum_age_ms: 60_000,
    });
    const origin = `http://127.0.0.1:${runtime.address.port}/`;
    const state = new SqliteOrganizationStateStore(
      join(directory, 'installation.sqlite'),
    );
    try {
      const membership = objectRecord(
        await adminPost(origin, '/v1/admin/memberships', {
          display_name: 'Employee One',
          membership_type: 'employee',
        }),
      );
      const membershipId = String(membership.membership_id);
      const grant = objectRecord(
        await adminPost(
          origin,
          `/v1/admin/memberships/${membershipId}/enrollment-grants`,
          { lifetime_seconds: 3600 },
        ),
      );
      const coordinator = new LocalOrganizationCoordinator({
        state,
        authorityClient: new HttpOrganizationAuthorityClient({
          baseUrl: origin,
          fetch: proxyFetch,
          allowInsecureLoopback: true,
        }),
        installationSigner: new MemoryInstallationSigner(),
        maximumActiveLeaseTtlMs: 60_000,
      });
      const enrollmentGrant = Buffer.from(
        String(grant.enrollment_grant_base64url),
        'base64url',
      );
      const enrolled = await coordinator.enroll({
        authorityDescriptor,
        independentlyTrustedAuthorityPin: authorityPin,
        enrollmentGrant,
        principalId: String(grant.principal_id),
        membershipId,
        installationId: INSTALLATION_ID,
      });
      expect(enrolled.permitted).toBe(true);
      expect(state.readEnrollment()?.accepted_access_sequence).toBe(1);

      const refreshed = await coordinator.refreshAccess();
      expect(refreshed.permitted).toBe(true);
      expect(refreshed.state.access_state_sequence).toBe(2);

      await adminPost(
        origin,
        `/v1/admin/installations/${INSTALLATION_ID}/revocations`,
        { reason: 'Device retired' },
      );
      const revoked = await coordinator.refreshAccess();
      expect(revoked.permitted).toBe(false);
      expect(revoked.state.status).toBe('revoked');
      expect(revoked.state.access_state_sequence).toBe(3);
      expect(coordinator.currentAccess().permitted).toBe(false);
    } finally {
      state.close();
      await runtime.close();
    }
  });
});
