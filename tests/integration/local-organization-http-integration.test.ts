import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  validateOrganizationEnrollmentInvitation,
} from '@echo-brain/organization-api';
import {
  canonicalJson,
  canonicalSha256,
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
import { initializeOrganizationControlDatabase } from '../../services/organization-control-plane/src/index.js';
import {
  OrganizationRecordDerivedStore,
  OrganizationRecordLogStore,
} from '../../services/organization-record/src/append.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../../services/organization-authority/src/adapters/security/development-file-authority-signer.js';
import { SqliteOrganizationAuthorityRepository } from '../../services/organization-authority/src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAdminApiClient } from '../../services/organization-authority/src/adapters/http/organization-admin-api-client.js';
import {
  prepareOrganizationInvitation,
  recordOrganizationInvitationIssued,
} from '../../services/organization-authority/src/adapters/files/private-organization-invitation.js';
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
  headers.set(
    TRUSTED_PROXY_AUTHORIZATION_HEADER,
    `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
  );
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
    const integrationsDatabasePath = join(directory, 'integrations.sqlite');
    const recordLogDatabasePath = join(directory, 'record-log.sqlite');
    const recordDerivedDatabasePath = join(directory, 'record-derived.sqlite');
    const authorityRepository = new SqliteOrganizationAuthorityRepository(
      authorityDatabasePath,
    );
    try {
      authorityRepository.initialize({
        descriptor: authorityDescriptor,
        authority_pin_sha256: authorityPin,
        organization_display_name: 'Example Company',
        initialized_at: new Date().toISOString(),
      });
    } finally {
      authorityRepository.close();
    }
    const integrationsCreatedAt = new Date().toISOString();
    const integrationsIdentity = initializeOrganizationControlDatabase(
      integrationsDatabasePath,
      {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      authority_descriptor_sha256: authorityPin,
        created_at: integrationsCreatedAt,
      },
    );
    const integrationsMarker = {
      schema_version: 1,
      kind: 'echo-organization-authority-integrations-installation-marker',
      control_plane_id: integrationsIdentity.control_plane_id,
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      authority_descriptor_sha256: authorityPin,
      integrations_database_path: integrationsDatabasePath,
      database_created_at: integrationsIdentity.created_at,
      installed_at: integrationsCreatedAt,
    } as const;
    writeFileSync(
      join(directory, 'authority-integrations-installation.v1.json'),
      `${canonicalJson(integrationsMarker)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const anchorDatabase = new Database(authorityDatabasePath);
    try {
      anchorDatabase
        .prepare(
          `UPDATE authority_metadata
           SET integrations_control_plane_id = ?,
               integrations_marker_sha256 = ?,
               integrations_installed_at = ?
           WHERE singleton = 1`,
        )
        .run(
          integrationsIdentity.control_plane_id,
          canonicalSha256(integrationsMarker),
          integrationsCreatedAt,
        );
    } finally {
      anchorDatabase.close();
    }
    OrganizationRecordLogStore.open(recordLogDatabasePath, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
    }).close();
    OrganizationRecordDerivedStore.open(recordDerivedDatabasePath, {
      organization_id: ORGANIZATION_ID,
    }).close();
    // Serve refuses an unanchored record store, so a hand-built state
    // directory publishes the same marker-and-anchor pair initialization does.
    const recordMarker = {
      schema_version: 1,
      kind: 'echo-organization-authority-record-installation-marker',
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      record_log_database_path: recordLogDatabasePath,
      record_derived_database_path: recordDerivedDatabasePath,
      installed_at: integrationsCreatedAt,
    } as const;
    writeFileSync(
      join(directory, 'authority-record-installation.v1.json'),
      `${canonicalJson(recordMarker)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const recordAnchorDatabase = new Database(authorityDatabasePath);
    try {
      recordAnchorDatabase
        .prepare(
          `UPDATE authority_metadata
           SET record_marker_sha256 = ?, record_installed_at = ?
           WHERE singleton = 1`,
        )
        .run(canonicalSha256(recordMarker), integrationsCreatedAt);
    } finally {
      recordAnchorDatabase.close();
    }
    const runtime = await startOrganizationAuthority({
      state_directory: directory,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      key_directory: keyDirectory,
      organization_display_name: 'Example Company',
      authority_pin_sha256: authorityPin,
      database_path: authorityDatabasePath,
      integrations_database_path: integrationsDatabasePath,
      record_log_database_path: recordLogDatabasePath,
      record_derived_database_path: recordDerivedDatabasePath,
      admin_token: ADMIN_TOKEN,
      trusted_proxy_token: PROXY_TOKEN,
      host: '127.0.0.1',
      port: 0,
      active_lease_ttl_ms: 60_000,
      access_request_maximum_age_ms: 60_000,
    });
    const origin = `http://127.0.0.1:${runtime.address.port}/`;
    const admin = new OrganizationAdminApiClient({
      base_url: origin,
      admin_token: ADMIN_TOKEN,
      trusted_proxy_token: PROXY_TOKEN,
      client_identity: PROXY_CLIENT_ID,
    });
    const state = new SqliteOrganizationStateStore(
      join(directory, 'installation.sqlite'),
    );
    try {
      const consoleLogin = await proxyFetch(new URL('/admin/login', origin));
      expect(consoleLogin.status).toBe(200);
      expect(consoleLogin.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(await consoleLogin.text()).toContain('Organization authority');
      expect(await admin.overview()).toMatchObject({
        counts: {
          memberships: 0,
          installations: 0,
          enrollment_grants: 0,
        },
      });
      const wrongCursor = Buffer.from(
        '{"kind":"audit","value":1}',
        'utf8',
      ).toString('base64url');
      await expect(
        admin.listMemberships({ cursor: wrongCursor }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      const membership = objectRecord(
        await admin.provisionMembership({
          command_id: `adm_${randomUUID()}`,
          display_name: 'Employee One',
          membership_type: 'employee',
        }),
      );
      const membershipId = String(membership.membership_id);
      const invitationDirectory = join(directory, 'invitations');
      mkdirSync(invitationDirectory, { mode: 0o700 });
      const invitationPath = join(invitationDirectory, 'employee-one.json');
      const preparedInvitation = prepareOrganizationInvitation({
        output_path: invitationPath,
        authority_base_url: new URL(origin).origin,
        authority_id: AUTHORITY_ID,
        authority_pin_sha256: authorityPin,
        organization_id: ORGANIZATION_ID,
        membership_id: membershipId,
        lifetime_seconds: 3600,
      });
      const grant = objectRecord(
        await admin.registerEnrollmentGrant(membershipId, {
          command_id: preparedInvitation.envelope.command_id,
          enrollment_grant_sha256:
            preparedInvitation.envelope.enrollment_grant_sha256,
          lifetime_seconds: preparedInvitation.envelope.lifetime_seconds,
        }),
      );
      recordOrganizationInvitationIssued(preparedInvitation, grant);
      const invitation = validateOrganizationEnrollmentInvitation(
        JSON.parse(readFileSync(invitationPath, 'utf8')) as unknown,
      );
      expect(invitation).toMatchObject({
        status: 'issued',
        authority_pin_verification: 'independent_pin_required',
        membership_id: membershipId,
      });
      if (invitation.issued === null) {
        throw new Error('issued invitation did not contain its registration');
      }
      const enrollmentGrant = Buffer.from(
        invitation.enrollment_grant_base64url,
        'base64url',
      );
      await expect(admin.listMemberships()).resolves.toMatchObject({
        items: [{ membership_id: membershipId, status: 'active' }],
      });
      await expect(admin.listEnrollmentGrants()).resolves.toMatchObject({
        items: [{ membership_id: membershipId, status: 'pending' }],
      });
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
      expect(grant.enrollment_grant_sha256).toBe(
        invitation.enrollment_grant_sha256,
      );
      const enrolled = await coordinator.enroll({
        authorityBaseUrl: new URL(origin).origin,
        authorityDescriptor,
        independentlyTrustedAuthorityPin: authorityPin,
        enrollmentGrant,
        principalId: invitation.issued.principal_id,
        membershipId: invitation.membership_id,
        installationId: INSTALLATION_ID,
      });
      expect(enrolled.permitted).toBe(true);
      expect(state.readEnrollment()?.accepted_access_sequence).toBe(1);
      await expect(admin.overview()).resolves.toMatchObject({
        counts: {
          memberships: 1,
          installations: 1,
          enrollment_grants: 1,
          consumed_enrollment_grants: 1,
        },
      });
      await expect(admin.listInstallations()).resolves.toMatchObject({
        items: [
          {
            membership_id: membershipId,
            installation_id: INSTALLATION_ID,
            status: 'active',
          },
        ],
      });

      const refreshed = await coordinator.refreshAccess();
      expect(refreshed.permitted).toBe(true);
      expect(refreshed.state.access_state_sequence).toBe(2);

      await admin.revokeInstallation(INSTALLATION_ID, {
        reason: 'Device retired',
      });
      const revoked = await coordinator.refreshAccess();
      expect(revoked.permitted).toBe(false);
      expect(revoked.state.status).toBe('revoked');
      expect(revoked.state.access_state_sequence).toBe(3);
      expect(coordinator.currentAccess().permitted).toBe(false);
      await expect(admin.listInstallations()).resolves.toMatchObject({
        items: [
          {
            installation_id: INSTALLATION_ID,
            status: 'revoked',
            current_access_status: 'revoked',
          },
        ],
      });
      const audit = await admin.listAudit();
      expect(audit.items.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          'membership.provisioned',
          'enrollment_grant.issued',
          'installation.enrolled',
          'installation.revoked',
        ]),
      );
    } finally {
      state.close();
      await runtime.close();
    }
  });
});
