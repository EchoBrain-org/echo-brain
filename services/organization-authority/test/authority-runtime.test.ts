import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  createSignedDocumentWithKey,
  federationId,
  normalizeP256LowS,
  p256KeyId,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationEnrollmentRequest,
  organizationAuthorityPinSha256,
  organizationEnrollmentGrantSha256,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentRequestV1,
  OrganizationMembershipTypeV1,
} from '@echo-brain/organization-protocol';
import {
  createOrganizationAccessLeaseRequest,
  createOrganizationAccessLeaseRequestV2,
  createOrganizationPermissionCheckRequest,
  createOrganizationRecentDecisionsRequest,
  createOrganizationReviewerRecentDecisionsRequest,
  createOrganizationSlackLinkBeginRequest,
  MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
} from '@echo-brain/organization-api';
import type {
  OrganizationPermissionCheckRequestV1,
  OrganizationRecentDecisionsRequestV1,
  OrganizationReviewerRecentDecisionsRequestV1,
} from '@echo-brain/organization-api';
import { OrganizationAuthorityApplication } from '../src/application/organization-authority.js';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  OrganizationAuthoritySigner,
} from '../src/application/ports/runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  AuthorityOperationError,
  StaleAccessStateError,
} from '../src/domain/errors.js';
import { OrganizationRecentDecisionsError } from '../src/application/recent-decisions.js';
import type {
  OrganizationRecentDecisionsPilotActivation,
  OrganizationRecentDecisionsProjectedRecord,
} from '../src/application/recent-decisions.js';

class FakeClock implements AuthorityClock {
  constructor(private current: number) {}

  now(): string {
    return new Date(this.current).toISOString();
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  regress(milliseconds: number): void {
    this.current -= milliseconds;
  }
}

class RandomIdentifiers implements AuthorityIdentifierGenerator {
  next(prefix: 'prn' | 'mem' | 'enr'): string {
    return federationId(prefix);
  }
}

interface TestKey {
  descriptor: P256SigningKeyDescriptor;
  privateKey: KeyObject;
}

function testKey(): TestKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicBytes.toString('base64'),
    },
    privateKey: pair.privateKey,
  };
}

function sign(key: TestKey, bytes: Buffer): Buffer {
  return normalizeP256LowS(
    signMessage('sha256', bytes, {
      key: key.privateKey,
      dsaEncoding: 'der',
    }),
  );
}

class MemoryAuthoritySigner implements OrganizationAuthoritySigner {
  readonly descriptor: OrganizationAuthorityDescriptorV1;

  constructor(private readonly key: TestKey) {
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: federationId('oau'),
      organization_id: federationId('org'),
      signing_key: key.descriptor,
    };
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    return JSON.parse(
      canonicalJson(this.descriptor),
    ) as OrganizationAuthorityDescriptorV1;
  }

  async sign(message: Buffer, expectedKeyId: Sha256Digest): Promise<Buffer> {
    if (expectedKeyId !== this.key.descriptor.key_id) {
      throw new Error('wrong test authority key');
    }
    return sign(this.key, message);
  }
}

async function createApplication(
  databasePath: string,
  clock: FakeClock,
  configuredSigner?: MemoryAuthoritySigner,
): Promise<{
  application: OrganizationAuthorityApplication;
  repository: SqliteOrganizationAuthorityRepository;
  signer: MemoryAuthoritySigner;
}> {
  const signer = configuredSigner ?? new MemoryAuthoritySigner(testKey());
  const repository = new SqliteOrganizationAuthorityRepository(databasePath);
  const application = await OrganizationAuthorityApplication.create({
    repository,
    signer,
    clock,
    identifiers: new RandomIdentifiers(),
    independently_trusted_authority_pin: organizationAuthorityPinSha256(
      signer.descriptor,
    ),
    organization_display_name: 'Example Company',
    active_lease_ttl_ms: 5 * 60 * 1000,
    access_request_maximum_age_ms: 5 * 60 * 1000,
  });
  return { application, repository, signer };
}

async function enroll(
  application: OrganizationAuthorityApplication,
  membership: ReturnType<
    OrganizationAuthorityApplication['provisionMembership']
  >,
  clock: FakeClock,
): Promise<{
  installation: TestKey;
  installationId: string;
  grant: Uint8Array;
  request: OrganizationEnrollmentRequestV1;
  result: Awaited<
    ReturnType<OrganizationAuthorityApplication['completeEnrollment']>
  >;
}> {
  const grant = Uint8Array.from(randomBytes(32));
  const grantSha256 = organizationEnrollmentGrantSha256(grant);
  const issued = application.issueEnrollmentGrant(membership.membership_id, {
    command_id: `adm_${randomUUID()}`,
    enrollment_grant_sha256: grantSha256,
    lifetime_seconds: 3600,
  });
  expect(issued.enrollment_grant_sha256).toBe(grantSha256);
  const installation = testKey();
  const installationId = federationId('ins');
  const pinned = verifyOrganizationAuthorityPin(
    application.descriptor(),
    application.authorityPinSha256(),
  );
  const request = await createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: grantSha256,
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      installation_id: installationId,
      installation_signing_key: installation.descriptor,
    },
    pinned,
    async (bytes) => sign(installation, bytes),
  );
  clock.advance(1);
  const result = await application.completeEnrollment({
    enrollment_grant: grant,
    enrollment_request: request,
  });
  return {
    installation,
    installationId,
    grant,
    request,
    result,
  };
}

async function createEnrolledFixture(at: string) {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-tamper-'));
  chmodSync(directory, 0o700);
  const databasePath = join(directory, 'authority.sqlite');
  const clock = new FakeClock(Date.parse(at));
  const { application, repository, signer } = await createApplication(
    databasePath,
    clock,
  );
  const membership = application.provisionMembership({
    command_id: `adm_${randomUUID()}`,
    display_name: 'Tamper Test Employee',
    membership_type: 'employee',
  });
  const enrolled = await enroll(application, membership, clock);
  return {
    application,
    clock,
    databasePath,
    directory,
    enrolled,
    repository,
    signer,
  };
}

async function permissionCheckRequest(
  fixture: Awaited<ReturnType<typeof createEnrolledFixture>>,
  overrides: Partial<{
    enrollment_id: string;
    requested_at: string;
    request_id: string;
  }> = {},
): Promise<OrganizationPermissionCheckRequestV1> {
  const receipt = fixture.enrolled.result.enrollment_receipt;
  return createOrganizationPermissionCheckRequest(
    {
      request_id: overrides.request_id ?? `pcr_${randomUUID()}`,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: overrides.enrollment_id ?? receipt.enrollment_id,
      installation_id: fixture.enrolled.installationId,
      installation_signing_key: fixture.enrolled.installation.descriptor,
      provider: 'slack',
      provider_issuer: 'https://slack.com',
      provider_tenant_kind: 'workspace',
      provider_tenant_id: 'T12345678',
      provider_enterprise_id: null,
      provider_connection_subject_id: 'U12345679',
      provider_connection_bot_id: 'B12345678',
      provider_connection_app_id: 'A12345678',
      provider_subject_kind: 'human_user',
      provider_subject_id: 'U12345678',
      adapter_kind: 'approval-surface',
      adapter_id: 'slack-reactions',
      adapter_instance_id: 'primary',
      adapter_version: '1.0.0',
      action: 'approve',
      approval_id: 'f'.repeat(64),
      channel_id: 'C12345678',
      message_ts: '1721678400.123456',
      reaction_name: 'white_check_mark',
      requested_at: overrides.requested_at ?? fixture.clock.now(),
    },
    async (bytes) => sign(fixture.enrolled.installation, bytes),
  );
}

interface RecentDecisionsFixtureView {
  readonly clock: FakeClock;
  readonly enrolled: Awaited<ReturnType<typeof enroll>>;
}

async function recentDecisionsRequest(
  fixture: RecentDecisionsFixtureView,
  requestedAt = fixture.clock.now(),
): Promise<OrganizationRecentDecisionsRequestV1> {
  const receipt = fixture.enrolled.result.enrollment_receipt;
  return createOrganizationRecentDecisionsRequest(
    {
      request_id: `rdr_${randomUUID()}`,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: receipt.enrollment_id,
      installation_id: fixture.enrolled.installationId,
      installation_signing_key: fixture.enrolled.installation.descriptor,
      requested_at: requestedAt,
    },
    async (bytes) => sign(fixture.enrolled.installation, bytes),
  );
}

async function reviewerRecentDecisionsRequest(
  fixture: RecentDecisionsFixtureView,
  requestedAt = fixture.clock.now(),
): Promise<OrganizationReviewerRecentDecisionsRequestV1> {
  const receipt = fixture.enrolled.result.enrollment_receipt;
  return createOrganizationReviewerRecentDecisionsRequest(
    {
      request_id: `rrd_${randomUUID()}`,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: receipt.enrollment_id,
      installation_id: fixture.enrolled.installationId,
      installation_signing_key: fixture.enrolled.installation.descriptor,
      requested_at: requestedAt,
    },
    async (bytes) => sign(fixture.enrolled.installation, bytes),
  );
}

function recentDecisionsActivation(
  fixture: RecentDecisionsFixtureView,
  membershipIds: readonly [string, string] = [
    fixture.enrolled.request.membership_id,
    federationId('mem'),
  ],
): OrganizationRecentDecisionsPilotActivation {
  const sorted = [...membershipIds].sort() as [string, string];
  return {
    organization_id: fixture.enrolled.result.enrollment_receipt.organization_id,
    policy_id: 'pilot-member-readable-v1',
    marker_sha256: canonicalSha256({
      command: 'permission-pilot',
      effective_after_position: 41,
      effective_after_record_hash: canonicalSha256({ record: 41 }),
    }),
    audience_notice_sha256: canonicalSha256({ notice: 'two people' }),
    membership_ids: sorted,
  };
}

function recentProjectedRecord(
  position = 1,
): OrganizationRecentDecisionsProjectedRecord {
  const recordHash = canonicalSha256({ record: position });
  return {
    log_position: position,
    record_hash: recordHash,
    atoms: [
      {
        atom_id: canonicalSha256({ atom: position }),
        record_hash: recordHash,
        kind: 'decision',
        text: 'Ship the two-person retrieval pilot.',
      },
    ],
  };
}

async function slackLinkBeginRequest(
  fixture: Awaited<ReturnType<typeof createEnrolledFixture>>,
) {
  const receipt = fixture.enrolled.result.enrollment_receipt;
  return createOrganizationSlackLinkBeginRequest(
    {
      request_id: `slb_${randomUUID()}`,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: receipt.enrollment_id,
      installation_id: fixture.enrolled.installationId,
      installation_signing_key: fixture.enrolled.installation.descriptor,
      challenge_code_sha256: canonicalSha256('Slack-link-challenge'),
      requested_at: fixture.clock.now(),
    },
    async (bytes) => sign(fixture.enrolled.installation, bytes),
  );
}

function closeFixture(
  fixture: Awaited<ReturnType<typeof createEnrolledFixture>>,
): void {
  fixture.application.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

describe('single-organization authority runtime', () => {
  it('samples a linearized write timestamp only after holding the writer lock', async () => {
    const fixture = await createEnrolledFixture('2026-08-02T19:55:00.000Z');
    try {
      fixture.clock.advance(1);
      let sampleCount = 0;
      const committedAt = fixture.repository.writeAtLinearization(
        () => {
          sampleCount += 1;
          const competitor = new Database(fixture.databasePath);
          try {
            competitor.pragma('busy_timeout = 0');
            expect(() => competitor.exec('BEGIN IMMEDIATE')).toThrow(
              /database is locked/,
            );
          } finally {
            competitor.close();
          }
          return fixture.clock.now();
        },
        (transaction, observedAt) => {
          expect(transaction.metadata().last_observed_at).toBe(observedAt);
          return observedAt;
        },
      );

      expect(committedAt).toBe(fixture.clock.now());
      expect(sampleCount).toBe(1);
      expect(
        fixture.repository.read(
          (transaction) => transaction.metadata().last_observed_at,
        ),
      ).toBe(committedAt);
    } finally {
      closeFixture(fixture);
    }
  });

  it('replays exact admin commands and rejects divergent command reuse', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-admin-'));
    chmodSync(directory, 0o700);
    const clock = new FakeClock(Date.parse('2026-07-22T11:00:00.000Z'));
    const { application } = await createApplication(
      join(directory, 'authority.sqlite'),
      clock,
    );
    try {
      const membershipCommandId = `adm_${randomUUID()}`;
      const membershipInput = {
        command_id: membershipCommandId,
        display_name: 'Retry Safe Employee',
        membership_type: 'employee' as const,
      };
      const membership = application.provisionMembership(membershipInput);
      expect(application.provisionMembership(membershipInput)).toEqual(
        membership,
      );
      expect(() =>
        application.provisionMembership({
          ...membershipInput,
          display_name: 'Different Employee',
        }),
      ).toThrow(/command ID was reused/);

      const grantBytes = Uint8Array.from(randomBytes(32));
      const grantDigest = organizationEnrollmentGrantSha256(grantBytes);
      const grantCommandId = `adm_${randomUUID()}`;
      const grantInput = {
        command_id: grantCommandId,
        enrollment_grant_sha256: grantDigest,
        lifetime_seconds: 3600,
      };
      const issued = application.issueEnrollmentGrant(
        membership.membership_id,
        grantInput,
      );
      expect(
        application.issueEnrollmentGrant(membership.membership_id, grantInput),
      ).toEqual(issued);
      expect(issued.enrollment_grant_sha256).toBe(grantDigest);
      expect(() =>
        application.issueEnrollmentGrant(membership.membership_id, {
          ...grantInput,
          lifetime_seconds: 7200,
        }),
      ).toThrow(/command ID was reused/);
      expect(() =>
        application.issueEnrollmentGrant(membership.membership_id, {
          ...grantInput,
          command_id: `adm_${randomUUID()}`,
        }),
      ).toThrow(/digest is already registered/);

      expect(application.adminOverview().counts).toMatchObject({
        memberships: 1,
        active_memberships: 1,
        enrollment_grants: 1,
        pending_enrollment_grants: 1,
        audit_entries: 2,
      });
      expect(application.listMemberships({ limit: 1 }).items).toHaveLength(1);
      expect(application.listEnrollmentGrants({ limit: 1 }).items).toEqual([
        expect.objectContaining({
          enrollment_grant_sha256: grantDigest,
          status: 'pending',
        }),
      ]);
      expect(application.listAudit({ limit: 10 }).items).toHaveLength(2);

      clock.advance(1);
      const revoked = await application.revokeMembership(
        membership.membership_id,
        'Retry result must remain immutable',
      );
      expect(application.listMemberships({ limit: 1 }).items).toEqual([
        expect.objectContaining({
          membership_id: membership.membership_id,
          status: 'revoked',
          revoked_at: revoked.membership.revoked_at,
        }),
      ]);
      expect(application.provisionMembership(membershipInput)).toEqual(
        membership,
      );
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a correctly signed access lease command with an extra field at the application boundary', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:30:00.000Z');
    try {
      fixture.clock.advance(1);
      const command = await createSignedDocumentWithKey(
        {
          schema_version: 1 as const,
          kind: 'echo-organization-access-lease-request' as const,
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_key_id: fixture.enrolled.installation.descriptor.key_id,
          previous_access_state_sha256: canonicalSha256(
            fixture.enrolled.result.access_state,
          ),
          requested_at: fixture.clock.now(),
          unexpected_field: 'signed but not allowed',
        },
        fixture.enrolled.installation.descriptor.key_id,
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );

      await expect(
        fixture.application.issueAccessLease(command),
      ).rejects.toThrow(
        'organization API: access lease request has an unexpected shape',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('reopens 30-minute V2 history while V1 issuance stays at five minutes', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:35:00.000Z');
    try {
      fixture.clock.advance(1);
      const v2RequestedAt = fixture.clock.now();
      const v2 = await createOrganizationAccessLeaseRequestV2(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            fixture.enrolled.result.access_state,
          ),
          requested_active_lease_ttl_ms:
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
          requested_at: v2RequestedAt,
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const longLease = await fixture.application.issueAccessLease(v2);
      if (longLease.status !== 'active') {
        throw new Error('V2 renewal unexpectedly returned revoked access');
      }
      expect(
        Date.parse(longLease.valid_until) - Date.parse(v2RequestedAt),
      ).toBe(MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS);
      expect(
        fixture.repository.read(
          (transaction) =>
            transaction.accessLeaseRequestByDigest(canonicalSha256(v2))
              ?.request,
        ),
      ).toEqual(v2);

      fixture.application.close();
      const reopened = await createApplication(
        fixture.databasePath,
        fixture.clock,
        fixture.signer,
      );
      fixture.application = reopened.application;
      fixture.repository = reopened.repository;
      expect(
        fixture.repository.read(
          (transaction) =>
            transaction.currentAccessState(
              fixture.enrolled.result.enrollment_receipt.enrollment_id,
            )?.state,
        ),
      ).toEqual(longLease);

      fixture.clock.advance(1);
      const v1RequestedAt = fixture.clock.now();
      const v1 = await createOrganizationAccessLeaseRequest(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(longLease),
          requested_at: v1RequestedAt,
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const configuredLease = await fixture.application.issueAccessLease(v1);
      if (configuredLease.status !== 'active') {
        throw new Error('V1 renewal unexpectedly returned revoked access');
      }
      expect(
        Date.parse(configuredLease.valid_until) - Date.parse(v1RequestedAt),
      ).toBe(5 * 60 * 1000);
    } finally {
      closeFixture(fixture);
    }
  });

  it('rejects an out-of-range V2 lease before any Authority state is written', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:37:00.000Z');
    try {
      fixture.clock.advance(1);
      const command = await createSignedDocumentWithKey(
        {
          schema_version: 2 as const,
          kind: 'echo-organization-access-lease-request' as const,
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_key_id: fixture.enrolled.installation.descriptor.key_id,
          previous_access_state_sha256: canonicalSha256(
            fixture.enrolled.result.access_state,
          ),
          requested_active_lease_ttl_ms:
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS + 1,
          requested_at: fixture.clock.now(),
        },
        fixture.enrolled.installation.descriptor.key_id,
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const before = fixture.application.adminOverview().counts;

      await expect(
        fixture.application.issueAccessLease(command),
      ).rejects.toThrow(
        'access lease request requested_active_lease_ttl_ms must be an integer',
      );

      expect(fixture.application.adminOverview().counts).toEqual(before);
      expect(
        fixture.repository.read(
          (transaction) =>
            transaction.currentAccessState(
              fixture.enrolled.result.enrollment_receipt.enrollment_id,
            )?.state.access_state_sequence,
        ),
      ).toBe(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it('authenticates permission checks and reports current caller and target state', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:40:00.000Z');
    try {
      const target = fixture.application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Approval Target',
        membership_type: 'employee',
      });
      const request = await permissionCheckRequest(fixture);
      const active = fixture.application.checkPermissionSubject(request, {
        principal_id: target.principal_id,
        membership_id: target.membership_id,
      });
      expect(active).toMatchObject({
        provider_event_sha256: request.provider_event_sha256,
        enrollment_id: fixture.enrolled.result.enrollment_receipt.enrollment_id,
        installation_id: fixture.enrolled.installationId,
        installation_key_id: fixture.enrolled.installation.descriptor.key_id,
        installation_principal_id:
          fixture.enrolled.result.enrollment_receipt.principal_id,
        installation_membership_id:
          fixture.enrolled.result.enrollment_receipt.membership_id,
        installation_active: true,
        target_principal_id: target.principal_id,
        target_membership_id: target.membership_id,
        target_active: true,
      });
      expect(active.request_sha256).toBe(canonicalSha256(request));

      fixture.clock.advance(1);
      await fixture.application.revokeMembership(
        target.membership_id,
        'Target access ended',
      );
      expect(
        fixture.application.checkPermissionSubject(request, {
          principal_id: target.principal_id,
          membership_id: target.membership_id,
        }),
      ).toMatchObject({
        installation_active: true,
        target_active: false,
      });

      fixture.clock.advance(1);
      await fixture.application.revokeInstallation(
        fixture.enrolled.installationId,
        'Caller installation retired',
      );
      expect(
        fixture.application.checkPermissionSubject(request, null),
      ).toMatchObject({
        installation_active: false,
        target_principal_id: null,
        target_membership_id: null,
        target_active: null,
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it('applies central installation revocation immediately while a 30-minute lease remains unexpired', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:42:00.000Z');
    try {
      fixture.clock.advance(1);
      const receipt = fixture.enrolled.result.enrollment_receipt;
      const longRequest = await createOrganizationAccessLeaseRequestV2(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: receipt.authority_id,
          authority_key_id: receipt.authority_key_id,
          organization_id: receipt.organization_id,
          enrollment_id: receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            fixture.enrolled.result.access_state,
          ),
          requested_active_lease_ttl_ms:
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
          requested_at: fixture.clock.now(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const longLease = await fixture.application.issueAccessLease(longRequest);
      if (longLease.status !== 'active') {
        throw new Error('30-minute lease unexpectedly returned revoked access');
      }
      expect(
        Date.parse(longLease.valid_until) - Date.parse(longLease.evaluated_at),
      ).toBe(MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS);

      const permission = await permissionCheckRequest(fixture);
      expect(
        fixture.application.checkPermissionSubject(permission, null),
      ).toMatchObject({ installation_active: true });

      fixture.clock.advance(1);
      await fixture.application.revokeInstallation(
        fixture.enrolled.installationId,
        'Caller installation retired',
      );
      expect(Date.parse(longLease.valid_until)).toBeGreaterThan(
        Date.parse(fixture.clock.now()),
      );
      expect(
        fixture.application.checkPermissionSubject(permission, null),
      ).toMatchObject({ installation_active: false });
    } finally {
      closeFixture(fixture);
    }
  });

  it('derives employee Slack-link identity only from the signed active enrollment', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:45:00.000Z');
    try {
      const request = await slackLinkBeginRequest(fixture);
      expect(
        fixture.application.integrationInstallationContext(
          request,
          'Slack identity link begin request',
        ),
      ).toMatchObject({
        request_sha256: canonicalSha256(request),
        authority_id: request.authority_id,
        organization_id: request.organization_id,
        enrollment_id: request.enrollment_id,
        principal_id: fixture.enrolled.result.enrollment_receipt.principal_id,
        membership_id: fixture.enrolled.result.enrollment_receipt.membership_id,
        installation_id: request.installation_id,
        installation_key_id: request.installation_key_id,
      });

      fixture.clock.advance(1);
      await fixture.application.revokeInstallation(
        fixture.enrolled.installationId,
        'employee machine retired',
      );
      expect(() =>
        fixture.application.integrationInstallationContext(
          request,
          'Slack identity link begin request',
        ),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'unauthorized',
        }),
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('rejects unknown, forged, stale, and expired permission-check callers', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:50:00.000Z');
    try {
      const unknownEnrollment = await permissionCheckRequest(fixture, {
        enrollment_id: federationId('enr'),
      });
      expect(() =>
        fixture.application.checkPermissionSubject(unknownEnrollment, null),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'unauthorized',
        }),
      );

      const request = await permissionCheckRequest(fixture);
      const forged = {
        ...request,
        requested_at: '2026-07-22T11:50:01.000Z',
      };
      expect(() =>
        fixture.application.checkPermissionSubject(forged, null),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'unauthorized',
        }),
      );
      expect(() =>
        fixture.application.checkPermissionSubject(request, {
          principal_id: 'prn_invalid',
          membership_id: 'mem_invalid',
        }),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'invalid_request',
        }),
      );

      fixture.clock.advance(5 * 60 * 1000);
      const freshAfterExpiry = await permissionCheckRequest(fixture);
      expect(
        fixture.application.checkPermissionSubject(freshAfterExpiry, null),
      ).toMatchObject({
        installation_active: false,
        evaluated_at: fixture.clock.now(),
      });

      const freshIntegrationRequest = await slackLinkBeginRequest(fixture);
      expect(() =>
        fixture.application.integrationInstallationContext(
          freshIntegrationRequest,
          'Slack identity link begin request',
        ),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'unauthorized',
        }),
      );

      fixture.clock.advance(1);
      expect(() =>
        fixture.application.checkPermissionSubject(request, null),
      ).toThrow(
        expect.objectContaining<Partial<AuthorityOperationError>>({
          code: 'unauthorized',
        }),
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('audits the exact recent-decisions bytes after the final person recheck', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:55:00.000Z');
    try {
      const request = await recentDecisionsRequest(fixture);
      const activation = recentDecisionsActivation(fixture);
      const prepared = fixture.application.serveRecentDecisions(
        request,
        activation,
        () => [recentProjectedRecord()],
      );
      expect(prepared.status_code).toBe(200);
      expect(JSON.parse(prepared.body.toString('utf8'))).toMatchObject({
        policy_id: 'pilot-member-readable-v1',
        items: [
          {
            kind: 'decision',
            text: 'Ship the two-person retrieval pilot.',
          },
        ],
      });
      const allowedAudit = fixture.application.listAudit({ limit: 1 })
        .items[0]!;
      expect(allowedAudit).toMatchObject({
        actor_kind: 'installation',
        action: 'permission_pilot.recent_decisions_decided',
        subject_id: fixture.enrolled.installationId,
        detail: {
          operation: 'recent_decisions',
          decision: 'allow',
          governed_reason: 'active_bound_pilot_membership',
          request_sha256: canonicalSha256(request),
          response_sha256: sha256Digest(prepared.body),
          policy_marker_sha256: activation.marker_sha256,
          audience_notice_sha256: activation.audience_notice_sha256,
          returned_items: prepared.item_references,
          pilot_person_state: {
            membership_id: fixture.enrolled.request.membership_id,
            principal_id: fixture.enrolled.request.principal_id,
            membership_status: 'active',
            enrollment_status: 'active',
            installation_id: fixture.enrolled.installationId,
            access_status: 'active',
          },
        },
      });

      const auditDetail = allowedAudit.detail as Record<string, unknown>;
      expect(auditDetail).not.toHaveProperty('text');
      expect(auditDetail.pilot_person_state_sha256).toBe(
        canonicalSha256(auditDetail.pilot_person_state),
      );

      const empty = fixture.application.serveRecentDecisions(
        request,
        activation,
        () => [],
      );
      expect(empty.status_code).toBe(200);
      expect(JSON.parse(empty.body.toString('utf8'))).toMatchObject({
        items: [],
      });
      expect(
        fixture.application.listAudit({ limit: 1 }).items[0]!.detail,
      ).toMatchObject({
        decision: 'allow',
        response_sha256: sha256Digest(empty.body),
        returned_items: [],
      });

      const deniedAfterConcurrentExpiry =
        fixture.application.serveRecentDecisions(request, activation, () => {
          fixture.clock.advance(5 * 60 * 1000 + 1);
          return [recentProjectedRecord()];
        });
      expect(deniedAfterConcurrentExpiry.status_code).toBe(401);
      expect(deniedAfterConcurrentExpiry.body.toString('utf8')).toBe(
        '{"error":{"code":"unauthorized","message":"authorization failed"}}',
      );
      const deniedAudit = fixture.application.listAudit({ limit: 1 }).items[0]!;
      expect(deniedAudit.detail).toMatchObject({
        decision: 'deny',
        governed_reason: 'installation_access_expired',
        response_sha256: sha256Digest(deniedAfterConcurrentExpiry.body),
      });
      expect(deniedAudit.detail).not.toHaveProperty('returned_items');
    } finally {
      closeFixture(fixture);
    }
  });

  it('audits opaque denials before source selection for unbound and expired callers', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:57:00.000Z');
    try {
      let sourceReads = 0;
      const unboundRequest = await recentDecisionsRequest(fixture);
      const unbound = fixture.application.serveRecentDecisions(
        unboundRequest,
        recentDecisionsActivation(fixture, [
          federationId('mem'),
          federationId('mem'),
        ]),
        () => {
          sourceReads += 1;
          return [recentProjectedRecord()];
        },
      );
      expect(unbound.status_code).toBe(404);
      expect(sourceReads).toBe(0);
      expect(
        fixture.application.listAudit({ limit: 1 }).items[0]!.detail,
      ).toMatchObject({
        decision: 'deny',
        governed_reason: 'inactive_or_unbound_pilot_membership',
      });

      fixture.clock.advance(5 * 60 * 1000 + 1);
      const expiredRequest = await recentDecisionsRequest(fixture);
      const expired = fixture.application.serveRecentDecisions(
        expiredRequest,
        recentDecisionsActivation(fixture),
        () => {
          sourceReads += 1;
          return [recentProjectedRecord()];
        },
      );
      expect(expired.status_code).toBe(401);
      expect(sourceReads).toBe(0);
      expect(
        fixture.application.listAudit({ limit: 1 }).items[0]!.detail,
      ).toMatchObject({
        decision: 'deny',
        governed_reason: 'installation_access_expired',
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it('keeps the other bound member eligible when one bound membership is revoked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-pilot-pair-'));
    chmodSync(directory, 0o700);
    const clock = new FakeClock(Date.parse('2026-07-22T11:58:00.000Z'));
    const { application } = await createApplication(
      join(directory, 'authority.sqlite'),
      clock,
    );
    try {
      const membershipA = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Pilot Member A',
        membership_type: 'employee',
      });
      const membershipB = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Pilot Member B',
        membership_type: 'employee',
      });
      const membershipC = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Unbound Member',
        membership_type: 'employee',
      });
      const memberA = {
        clock,
        enrolled: await enroll(application, membershipA, clock),
      };
      const memberB = {
        clock,
        enrolled: await enroll(application, membershipB, clock),
      };
      const memberC = {
        clock,
        enrolled: await enroll(application, membershipC, clock),
      };
      const activation = recentDecisionsActivation(memberA, [
        membershipA.membership_id,
        membershipB.membership_id,
      ]);
      let sourceReads = 0;
      const load = (): readonly OrganizationRecentDecisionsProjectedRecord[] => {
        sourceReads += 1;
        return [recentProjectedRecord()];
      };

      expect(
        application.serveRecentDecisions(
          await recentDecisionsRequest(memberA),
          activation,
          load,
        ).status_code,
      ).toBe(200);
      expect(
        application.serveRecentDecisions(
          await recentDecisionsRequest(memberB),
          activation,
          load,
        ).status_code,
      ).toBe(200);
      expect(
        application.serveRecentDecisions(
          await recentDecisionsRequest(memberC),
          activation,
          load,
        ).status_code,
      ).toBe(404);
      expect(sourceReads).toBe(2);

      await application.revokeMembership(
        membershipA.membership_id,
        'Permission-pilot revocation test',
      );
      expect(
        application.serveRecentDecisions(
          await recentDecisionsRequest(memberA),
          activation,
          load,
        ).status_code,
      ).toBe(404);
      expect(
        application.serveRecentDecisions(
          await recentDecisionsRequest(memberB),
          activation,
          load,
        ).status_code,
      ).toBe(200);
      expect(sourceReads).toBe(3);
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns unauthenticated recent-decisions failures before audit or source access', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:59:00.000Z');
    try {
      const request = await recentDecisionsRequest(fixture);
      const activation = recentDecisionsActivation(fixture);
      const initialAuditCount =
        fixture.application.adminOverview().counts.audit_entries;
      let sourceReads = 0;
      expect(() =>
        fixture.application.serveRecentDecisions(
          { ...request, requested_at: '2026-07-22T11:59:01.000Z' },
          activation,
          () => {
            sourceReads += 1;
            return [];
          },
        ),
      ).toThrow(
        expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
          code: 'unauthorized',
        }),
      );
      fixture.clock.advance(5 * 60 * 1000 + 1);
      expect(() =>
        fixture.application.serveRecentDecisions(request, activation, () => {
          sourceReads += 1;
          return [];
        }),
      ).toThrow(
        expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
          code: 'unauthorized',
        }),
      );
      expect(sourceReads).toBe(0);
      expect(fixture.application.adminOverview().counts.audit_entries).toBe(
        initialAuditCount,
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('turns an audit write outage into unavailable without releasing content', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T11:59:30.000Z');
    try {
      const request = await recentDecisionsRequest(fixture);
      const initialAuditCount = fixture.application.adminOverview().counts
        .audit_entries;
      const write = vi
        .spyOn(fixture.repository, 'writeAtLinearization')
        .mockImplementation(() => {
          throw new Error('simulated authority audit store outage');
        });
      expect(() =>
        fixture.application.serveRecentDecisions(
          request,
          recentDecisionsActivation(fixture),
          () => [recentProjectedRecord()],
        ),
      ).toThrow(
        expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
          code: 'unavailable',
        }),
      );
      write.mockRestore();
      expect(fixture.application.adminOverview().counts.audit_entries).toBe(
        initialAuditCount,
      );
    } finally {
      vi.restoreAllMocks();
      closeFixture(fixture);
    }
  });

  it('recovers an expired Authority lease from its known immediate predecessor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-test-'));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, 'authority.sqlite');
    const clock = new FakeClock(Date.parse('2026-07-22T12:00:00.000Z'));
    const { application, repository } = await createApplication(
      databasePath,
      clock,
    );
    try {
      const membership = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Employee One',
        membership_type: 'employee',
      });
      const enrolled = await enroll(application, membership, clock);
      const retry = await application.completeEnrollment({
        enrollment_grant: enrolled.grant,
        enrollment_request: enrolled.request,
      });
      expect(canonicalJson(retry)).toBe(canonicalJson(enrolled.result));

      clock.advance(1);
      const access = await createOrganizationAccessLeaseRequest(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: enrolled.result.enrollment_receipt.authority_id,
          authority_key_id: enrolled.result.enrollment_receipt.authority_key_id,
          organization_id: enrolled.result.enrollment_receipt.organization_id,
          enrollment_id: enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: enrolled.installationId,
          installation_signing_key: enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            enrolled.result.access_state,
          ),
          requested_at: clock.now(),
        },
        async (bytes) => sign(enrolled.installation, bytes),
      );
      const refreshed = await application.issueAccessLease(access);
      expect(refreshed.access_state_sequence).toBe(2);
      const storedAccessRequest = repository.read((transaction) =>
        transaction.accessLeaseRequestByDigest(canonicalSha256(access)),
      );
      expect(storedAccessRequest?.request).toEqual(access);

      const retryAfterAdvance = await application.completeEnrollment({
        enrollment_grant: enrolled.grant,
        enrollment_request: enrolled.request,
      });
      expect(canonicalJson(retryAfterAdvance)).toBe(
        canonicalJson(enrolled.result),
      );

      clock.advance(60 * 1000);
      const liveStale = await createOrganizationAccessLeaseRequest(
        {
          ...access,
          request_id: `alr_${randomUUID()}`,
          installation_signing_key: enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            enrolled.result.access_state,
          ),
          requested_at: clock.now(),
        },
        async (bytes) => sign(enrolled.installation, bytes),
      );
      await expect(
        application.issueAccessLease(liveStale),
      ).rejects.toBeInstanceOf(StaleAccessStateError);

      clock.advance(4 * 60 * 1000 + 1);
      let heldRequestCurrent:
        InstanceType<typeof StaleAccessStateError>['currentState'] | undefined;
      try {
        await application.issueAccessLease(liveStale);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleAccessStateError);
        heldRequestCurrent = (error as StaleAccessStateError).currentState;
      }
      expect(heldRequestCurrent?.access_state_sequence).toBe(2);
      expect(
        repository.read(
          (transaction) =>
            transaction.currentAccessState(
              enrolled.result.enrollment_receipt.enrollment_id,
            )?.state.access_state_sequence,
        ),
      ).toBe(2);

      clock.advance(1);
      const exactReplay = await application.issueAccessLease(access);
      expect(canonicalJson(exactReplay)).toBe(canonicalJson(refreshed));

      const expiredStale = await createOrganizationAccessLeaseRequest(
        {
          ...access,
          request_id: `alr_${randomUUID()}`,
          installation_signing_key: enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            enrolled.result.access_state,
          ),
          requested_at: clock.now(),
        },
        async (bytes) => sign(enrolled.installation, bytes),
      );
      let recovered:
        InstanceType<typeof StaleAccessStateError>['currentState'] | undefined;
      try {
        await application.issueAccessLease(expiredStale);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleAccessStateError);
        recovered = (error as StaleAccessStateError).currentState;
      }
      if (recovered === undefined) {
        throw new Error(
          'expired stale-head recovery did not return a conflict',
        );
      }
      expect(recovered).toMatchObject({
        status: 'active',
        access_state_sequence: 3,
      });
      const retryCurrents = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await application.issueAccessLease(expiredStale);
        } catch (error) {
          expect(error).toBeInstanceOf(StaleAccessStateError);
          retryCurrents.push((error as StaleAccessStateError).currentState);
        }
      }
      expect(retryCurrents).toHaveLength(2);
      expect(
        retryCurrents.every(
          (current) => canonicalJson(current) === canonicalJson(recovered),
        ),
      ).toBe(true);
      expect(
        repository.read(
          (transaction) =>
            transaction.currentAccessState(
              enrolled.result.enrollment_receipt.enrollment_id,
            )?.state.access_state_sequence,
        ),
      ).toBe(3);
      const storedRecoveryRequest = repository.read((transaction) =>
        transaction.accessLeaseRequestByDigest(canonicalSha256(expiredStale)),
      );
      expect(storedRecoveryRequest).toBeUndefined();

      clock.advance(6 * 60 * 1000);
      const oldAncestorRequest = await createOrganizationAccessLeaseRequest(
        {
          ...access,
          request_id: `alr_${randomUUID()}`,
          installation_signing_key: enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            enrolled.result.access_state,
          ),
          requested_at: clock.now(),
        },
        async (bytes) => sign(enrolled.installation, bytes),
      );
      let oldAncestorCurrent:
        InstanceType<typeof StaleAccessStateError>['currentState'] | undefined;
      try {
        await application.issueAccessLease(oldAncestorRequest);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleAccessStateError);
        oldAncestorCurrent = (error as StaleAccessStateError).currentState;
      }
      expect(oldAncestorCurrent).toMatchObject({
        status: 'active',
        access_state_sequence: 3,
      });
      expect(
        repository.read((transaction) =>
          transaction.accessLeaseRequestByDigest(
            canonicalSha256(oldAncestorRequest),
          ),
        ),
      ).toBeUndefined();
      expect(
        repository.read(
          (transaction) =>
            transaction.currentAccessState(
              enrolled.result.enrollment_receipt.enrollment_id,
            )?.state.access_state_sequence,
        ),
      ).toBe(3);

      const revoked = await application.revokeInstallation(
        enrolled.installationId,
        'Device retired',
      );
      expect(revoked.status).toBe('revoked');
      expect(revoked.revocation_reason).toBe('installation_revoked');
      expect(revoked.access_state_sequence).toBe(4);

      const afterRevocation = await createOrganizationAccessLeaseRequest(
        {
          ...access,
          request_id: `alr_${randomUUID()}`,
          installation_signing_key: enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(refreshed),
          requested_at: clock.now(),
        },
        async (bytes) => sign(enrolled.installation, bytes),
      );
      expect(
        canonicalJson(await application.issueAccessLease(afterRevocation)),
      ).toBe(canonicalJson(revoked));

      const database = new Database(databasePath, { readonly: true });
      try {
        const grantRows = database
          .prepare('SELECT * FROM authority_enrollment_grants')
          .all();
        expect(JSON.stringify(grantRows)).not.toContain(
          Buffer.from(enrolled.grant).toString('base64url'),
        );
        const accessRequestRow = database
          .prepare(
            `SELECT request_json FROM authority_access_lease_requests
             WHERE request_sha256 = ?`,
          )
          .get(canonicalSha256(access)) as { request_json: string };
        expect(accessRequestRow.request_json).toBe(canonicalJson(access));
        const accessAuditRow = database
          .prepare(
            `SELECT detail_json FROM authority_audit_log
             WHERE action = 'access_lease.issued' AND subject_id = ?`,
          )
          .get(enrolled.installationId) as { detail_json: string };
        expect(accessAuditRow.detail_json).toBe(
          canonicalJson({
            access_state_sequence: refreshed.access_state_sequence,
            request_id: access.request_id,
          }),
        );
        const recoveryAuditRows = database
          .prepare(
            `SELECT detail_json FROM authority_audit_log
             WHERE action = 'access_lease.recovered'
               AND subject_id = ?
             ORDER BY audit_sequence`,
          )
          .all(enrolled.installationId) as Array<{ detail_json: string }>;
        expect(recoveryAuditRows.map((row) => row.detail_json)).toEqual([
          canonicalJson({
            access_state_sequence: recovered.access_state_sequence,
            named_access_state_sha256: canonicalSha256(
              enrolled.result.access_state,
            ),
            recovered_access_state_sequence: refreshed.access_state_sequence,
            request_id: expiredStale.request_id,
            request_sha256: canonicalSha256(expiredStale),
          }),
        ]);
        expect(
          (
            database
              .prepare('SELECT COUNT(*) AS count FROM authority_audit_log')
              .get() as { count: number }
          ).count,
        ).toBeGreaterThanOrEqual(5);
      } finally {
        database.close();
      }

      clock.regress(60 * 60 * 1000);
      expect(() =>
        application.provisionMembership({
          command_id: `adm_${randomUUID()}`,
          display_name: 'Clock Regression',
          membership_type: 'employee',
        }),
      ).toThrow('clock regressed');
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown and cross-enrollment stale-head recovery requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-test-'));
    chmodSync(directory, 0o700);
    const clock = new FakeClock(Date.parse('2026-07-22T12:30:00.000Z'));
    const { application } = await createApplication(
      join(directory, 'authority.sqlite'),
      clock,
    );
    try {
      const firstMembership = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Employee One',
        membership_type: 'employee',
      });
      const secondMembership = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Employee Two',
        membership_type: 'employee',
      });
      const first = await enroll(application, firstMembership, clock);
      const second = await enroll(application, secondMembership, clock);
      clock.advance(6 * 60 * 1000);

      const requestWithPrevious = (previousAccessStateSha256: Sha256Digest) =>
        createOrganizationAccessLeaseRequest(
          {
            request_id: `alr_${randomUUID()}`,
            authority_id: second.result.enrollment_receipt.authority_id,
            authority_key_id: second.result.enrollment_receipt.authority_key_id,
            organization_id: second.result.enrollment_receipt.organization_id,
            enrollment_id: second.result.enrollment_receipt.enrollment_id,
            installation_id: second.installationId,
            installation_signing_key: second.installation.descriptor,
            previous_access_state_sha256: previousAccessStateSha256,
            requested_at: clock.now(),
          },
          async (bytes) => sign(second.installation, bytes),
        );

      const unknown = await requestWithPrevious(
        canonicalSha256({ unknown_access_state: true }),
      );
      await expect(application.issueAccessLease(unknown)).rejects.toMatchObject(
        { code: 'unauthorized' },
      );

      const crossEnrollment = await requestWithPrevious(
        canonicalSha256(first.result.access_state),
      );
      await expect(
        application.issueAccessLease(crossEnrollment),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs a stranded installation the one-head recovery cannot reach', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-test-'));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, 'authority.sqlite');
    const clock = new FakeClock(Date.parse('2026-07-22T15:00:00.000Z'));
    const { application, repository } = await createApplication(
      databasePath,
      clock,
    );
    try {
      const membership = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Stranded Employee',
        membership_type: 'employee',
      });
      const enrolled = await enroll(application, membership, clock);
      const enrollmentId = enrolled.result.enrollment_receipt.enrollment_id;
      const local = enrolled.result.access_state;
      expect(local.access_state_sequence).toBe(1);
      const leaseRequest = async (previous: Sha256Digest) =>
        createOrganizationAccessLeaseRequest(
          {
            request_id: `alr_${randomUUID()}`,
            authority_id: enrolled.result.enrollment_receipt.authority_id,
            authority_key_id:
              enrolled.result.enrollment_receipt.authority_key_id,
            organization_id: enrolled.result.enrollment_receipt.organization_id,
            enrollment_id: enrollmentId,
            installation_id: enrolled.installationId,
            installation_signing_key: enrolled.installation.descriptor,
            previous_access_state_sha256: previous,
            requested_at: clock.now(),
          },
          async (bytes) => sign(enrolled.installation, bytes),
        );
      // The current head an installation is handed back when its own freshly
      // signed refresh is refused as stale.
      const refusedRefresh = async (previous: Sha256Digest) => {
        try {
          await application.issueAccessLease(await leaseRequest(previous));
        } catch (error) {
          expect(error).toBeInstanceOf(StaleAccessStateError);
          return (error as StaleAccessStateError).currentState;
        }
        throw new Error('stale access lease request was not refused');
      };
      const currentSequence = () =>
        repository.read(
          (transaction) =>
            transaction.currentAccessState(enrollmentId)?.state
              .access_state_sequence,
        );
      const recover = (reported: number) =>
        application.recoverInstallationAccess(enrolled.installationId, {
          local_access_state_sequence: reported,
          reason: 'Missed issued heads through lost lease responses',
        });

      // Two Authority heads the installation never saw: the stranded local
      // state is now two behind, which is one further than the automatic
      // recovery is allowed to reach.
      clock.advance(1);
      const second = await application.issueAccessLease(
        await leaseRequest(canonicalSha256(local)),
      );
      clock.advance(1);
      const head = await application.issueAccessLease(
        await leaseRequest(canonicalSha256(second)),
      );
      expect(head.access_state_sequence).toBe(3);

      // The head is expired and older than the request window, which is
      // exactly when the automatic recovery would take one skipped head. It
      // still refuses this two-head gap, and appends nothing.
      clock.advance(6 * 60 * 1000);
      expect(
        (await refusedRefresh(canonicalSha256(local))).access_state_sequence,
      ).toBe(3);
      expect(currentSequence()).toBe(3);

      await expect(recover(2)).rejects.toMatchObject({
        code: 'conflict',
        message:
          'reported local access state is within automatic recovery range',
      });
      expect(currentSequence()).toBe(3);

      const recovered = await recover(1);
      expect(recovered).toEqual({
        installation_id: enrolled.installationId,
        changed: true,
        local_access_state_sequence: 1,
        access_state_sequence: 4,
        valid_until: new Date(
          Date.parse(clock.now()) + 5 * 60 * 1000,
        ).toISOString(),
      });

      // An immediate retry finds the repaired head still live and returns it
      // without appending a second one.
      expect(await recover(1)).toEqual({ ...recovered, changed: false });

      const stored = repository.read((transaction) => ({
        chain: [1, 2, 3, 4].map(
          (sequence) => transaction.accessState(enrollmentId, sequence)?.state,
        ),
        beyond: transaction.accessState(enrollmentId, 5),
      }));
      expect(stored.beyond).toBeUndefined();
      // History is appended to, never rewritten: every earlier head is still
      // exactly the document its holder already has.
      expect(canonicalJson(stored.chain[0])).toBe(canonicalJson(local));
      expect(canonicalJson(stored.chain[1])).toBe(canonicalJson(second));
      expect(canonicalJson(stored.chain[2])).toBe(canonicalJson(head));
      expect(stored.chain[3]).toMatchObject({
        status: 'active',
        access_state_sequence: 4,
        installation_id: enrolled.installationId,
      });

      // The stranded installation still holds only its own old head, and that
      // is how it collects the repaired one: its next ordinary refresh is
      // refused with the repaired head, and appends nothing further.
      expect(await refusedRefresh(canonicalSha256(local))).toEqual(
        stored.chain[3],
      );
      expect(currentSequence()).toBe(4);

      const database = new Database(databasePath, { readonly: true });
      try {
        const auditRows = database
          .prepare(
            `SELECT actor_kind, detail_json FROM authority_audit_log
             WHERE action = 'installation.access_recovered' AND subject_id = ?
             ORDER BY audit_sequence`,
          )
          .all(enrolled.installationId) as Array<{
          actor_kind: string;
          detail_json: string;
        }>;
        expect(auditRows).toEqual([
          {
            actor_kind: 'admin',
            detail_json: canonicalJson({
              access_state_sequence: 4,
              local_access_state_sequence: 1,
              reason: 'Missed issued heads through lost lease responses',
              recovered_access_state_sequence: 3,
            }),
          },
        ]);
      } finally {
        database.close();
      }

      // A revoked subject is never brought back.
      await application.revokeInstallation(
        enrolled.installationId,
        'Device retired',
      );
      await expect(recover(1)).rejects.toMatchObject({
        code: 'conflict',
        message: 'installation enrollment is not active',
      });
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('revokes every active installation with one membership transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-test-'));
    chmodSync(directory, 0o700);
    const clock = new FakeClock(Date.parse('2026-07-22T13:00:00.000Z'));
    const { application } = await createApplication(
      join(directory, 'authority.sqlite'),
      clock,
    );
    try {
      const membership = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Employee Two',
        membership_type: 'employee' as OrganizationMembershipTypeV1,
      });
      const first = await enroll(application, membership, clock);
      const second = await enroll(application, membership, clock);
      clock.advance(1);
      const result = await application.revokeMembership(
        membership.membership_id,
        'Employment ended',
      );
      expect(result.membership.status).toBe('revoked');
      expect(
        result.installations.map((item) => item.installation_id).sort(),
      ).toEqual([first.installationId, second.installationId].sort());
      expect(
        result.installations.every(
          (item) =>
            item.access_state.status === 'revoked' &&
            item.access_state.revocation_reason === 'membership_revoked',
        ),
      ).toBe(true);
      expect(
        canonicalJson(
          await application.revokeMembership(
            membership.membership_id,
            'Employment ended',
          ),
        ),
      ).toBe(canonicalJson(result));
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when an enrollment request signature is corrupted before retry', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T14:00:00.000Z');
    try {
      const tamperedRequest = {
        ...fixture.enrolled.request,
        integrity: {
          ...fixture.enrolled.request.integrity,
          signature_base64:
            fixture.enrolled.result.enrollment_receipt.integrity
              .signature_base64,
        },
      };
      const database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_enrollments
             SET request_json = ?, request_sha256 = ?
             WHERE enrollment_id = ?`,
          )
          .run(
            canonicalJson(tamperedRequest),
            canonicalSha256(tamperedRequest),
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          );
      } finally {
        database.close();
      }
      fixture.application.close();
      fixture.application = (
        await createApplication(
          fixture.databasePath,
          fixture.clock,
          fixture.signer,
        )
      ).application;

      await expect(
        fixture.application.completeEnrollment({
          enrollment_grant: fixture.enrolled.grant,
          enrollment_request: fixture.enrolled.request,
        }),
      ).rejects.toThrow(
        'authority database invariant: enrollment request failed verification',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('fails closed when a persisted receipt signature is corrupted and rehashed', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T15:00:00.000Z');
    try {
      const receipt = fixture.enrolled.result.enrollment_receipt;
      const tamperedReceipt = {
        ...receipt,
        integrity: {
          ...receipt.integrity,
          signature_base64: fixture.enrolled.request.integrity.signature_base64,
        },
      };
      const database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_enrollments
             SET receipt_json = ?, receipt_sha256 = ?
             WHERE enrollment_id = ?`,
          )
          .run(
            canonicalJson(tamperedReceipt),
            canonicalSha256(tamperedReceipt),
            receipt.enrollment_id,
          );
      } finally {
        database.close();
      }

      await expect(
        fixture.application.completeEnrollment({
          enrollment_grant: fixture.enrolled.grant,
          enrollment_request: fixture.enrolled.request,
        }),
      ).rejects.toThrow(
        'authority database invariant: enrollment receipt failed verification',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('fails closed when an access-state signature is corrupted and rehashed', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T16:00:00.000Z');
    try {
      const state = fixture.enrolled.result.access_state;
      const tamperedState = {
        ...state,
        integrity: {
          ...state.integrity,
          signature_base64: fixture.enrolled.request.integrity.signature_base64,
        },
      };
      const database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_access_states
             SET state_json = ?, state_sha256 = ?
             WHERE enrollment_id = ? AND access_state_sequence = 1`,
          )
          .run(
            canonicalJson(tamperedState),
            canonicalSha256(tamperedState),
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          );
      } finally {
        database.close();
      }

      await expect(
        fixture.application.completeEnrollment({
          enrollment_grant: fixture.enrolled.grant,
          enrollment_request: fixture.enrolled.request,
        }),
      ).rejects.toThrow(
        'authority database invariant: access state sequence 1 failed verification',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('recomputes stored hashes and rejects row-to-document coordinate drift', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T16:15:00.000Z');
    try {
      const enrollmentId =
        fixture.enrolled.result.enrollment_receipt.enrollment_id;
      const originalStateSha256 = canonicalSha256(
        fixture.enrolled.result.access_state,
      );
      const unrelatedSha256 = canonicalSha256(
        fixture.enrolled.result.enrollment_receipt,
      );
      let database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_access_states SET state_sha256 = ?
             WHERE enrollment_id = ? AND access_state_sequence = 1`,
          )
          .run(unrelatedSha256, enrollmentId);
      } finally {
        database.close();
      }
      await expect(
        fixture.application.completeEnrollment({
          enrollment_grant: fixture.enrolled.grant,
          enrollment_request: fixture.enrolled.request,
        }),
      ).rejects.toThrow(
        'authority database invariant: access state digest differs from document',
      );

      database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_access_states SET state_sha256 = ?
             WHERE enrollment_id = ? AND access_state_sequence = 1`,
          )
          .run(originalStateSha256, enrollmentId);
        database
          .prepare(
            `UPDATE authority_enrollments SET enrolled_at = ?
             WHERE enrollment_id = ?`,
          )
          .run('2026-07-22T16:15:00.002Z', enrollmentId);
      } finally {
        database.close();
      }
      await expect(
        fixture.application.completeEnrollment({
          enrollment_grant: fixture.enrolled.grant,
          enrollment_request: fixture.enrolled.request,
        }),
      ).rejects.toThrow(
        'authority database invariant: enrollment columns differ from authenticated documents',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('fails closed when a persisted access request is forged and rehashed', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T16:30:00.000Z');
    try {
      fixture.clock.advance(1);
      const command = await createOrganizationAccessLeaseRequest(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: canonicalSha256(
            fixture.enrolled.result.access_state,
          ),
          requested_at: fixture.clock.now(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      await fixture.application.issueAccessLease(command);
      const forgedCommand = {
        ...command,
        integrity: {
          ...command.integrity,
          signature_base64:
            fixture.enrolled.result.enrollment_receipt.integrity
              .signature_base64,
        },
      };
      const forgedSha256 = canonicalSha256(forgedCommand);
      const database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_access_lease_requests
             SET request_json = ?, request_sha256 = ?
             WHERE request_id = ?`,
          )
          .run(canonicalJson(forgedCommand), forgedSha256, command.request_id);
      } finally {
        database.close();
      }

      expect(() =>
        fixture.repository.read((transaction) =>
          transaction.accessLeaseRequestByDigest(forgedSha256),
        ),
      ).toThrow(
        'authority database invariant: access lease request failed verification',
      );
      await expect(
        fixture.application.issueAccessLease(forgedCommand),
      ).rejects.toThrow('access lease request authentication failed');
    } finally {
      closeFixture(fixture);
    }
  });

  it('binds persisted active results to the V1 hard limit and signed V2 TTL bound', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T16:40:00.000Z');
    try {
      fixture.clock.advance(1);
      const receipt = fixture.enrolled.result.enrollment_receipt;
      const initialStateSha256 = canonicalSha256(
        fixture.enrolled.result.access_state,
      );
      const longRequest = await createOrganizationAccessLeaseRequestV2(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: receipt.authority_id,
          authority_key_id: receipt.authority_key_id,
          organization_id: receipt.organization_id,
          enrollment_id: receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: initialStateSha256,
          requested_active_lease_ttl_ms:
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
          requested_at: fixture.clock.now(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const longResult = await fixture.application.issueAccessLease(longRequest);
      if (longResult.status !== 'active') {
        throw new Error('30-minute lease unexpectedly returned revoked access');
      }
      expect(
        Date.parse(longResult.valid_until) - Date.parse(longResult.evaluated_at),
      ).toBe(MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS);

      const commonReplacement = {
        authority_id: receipt.authority_id,
        authority_key_id: receipt.authority_key_id,
        organization_id: receipt.organization_id,
        enrollment_id: receipt.enrollment_id,
        installation_id: fixture.enrolled.installationId,
        installation_signing_key: fixture.enrolled.installation.descriptor,
        previous_access_state_sha256: initialStateSha256,
        requested_at: fixture.clock.now(),
      };
      const legacyRequest = await createOrganizationAccessLeaseRequest(
        {
          ...commonReplacement,
          request_id: `alr_${randomUUID()}`,
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const shortV2Request = await createOrganizationAccessLeaseRequestV2(
        {
          ...commonReplacement,
          request_id: `alr_${randomUUID()}`,
          requested_active_lease_ttl_ms: 60_000,
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const replaceStoredRequest = (
        previousRequestSha256: Sha256Digest,
        replacement: typeof legacyRequest | typeof shortV2Request,
      ) => {
        const database = new Database(fixture.databasePath);
        try {
          database
            .prepare(
              `UPDATE authority_access_lease_requests
               SET request_sha256 = ?, request_id = ?, request_json = ?
               WHERE request_sha256 = ?`,
            )
            .run(
              canonicalSha256(replacement),
              replacement.request_id,
              canonicalJson(replacement),
              previousRequestSha256,
            );
        } finally {
          database.close();
        }
      };

      replaceStoredRequest(canonicalSha256(longRequest), legacyRequest);
      expect(() =>
        fixture.repository.read((transaction) =>
          transaction.accessLeaseRequestByDigest(
            canonicalSha256(legacyRequest),
          ),
        ),
      ).toThrow(
        'authority database invariant: access request active result exceeds its versioned TTL bound',
      );

      replaceStoredRequest(canonicalSha256(legacyRequest), shortV2Request);
      expect(() =>
        fixture.repository.read((transaction) =>
          transaction.accessLeaseRequestByDigest(
            canonicalSha256(shortV2Request),
          ),
        ),
      ).toThrow(
        'authority database invariant: access request active result exceeds its versioned TTL bound',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('audits the exact reviewer response before release and rechecks Person state at commit', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T16:55:00.000Z');
    try {
      const request = await reviewerRecentDecisionsRequest(fixture);
      let sourceReads = 0;
      const recordHash = canonicalSha256({ reviewer: 'record' });
      const atomId = canonicalSha256({ reviewer: 'atom' });
      const prepared = fixture.application.serveReviewerRecentDecisions(
        request,
        (caller) => {
          sourceReads += 1;
          expect(caller).toMatchObject({
            reviewer_principal_id: fixture.enrolled.request.principal_id,
            reviewer_membership_id: fixture.enrolled.request.membership_id,
          });
          return {
            items: [
              {
                kind: 'decision',
                text: 'Ship the exact reviewer read.',
                atom_id: atomId,
                record_hash: recordHash,
              },
            ],
            record_head: { position: 1, record_hash: recordHash },
          };
        },
      );
      expect(prepared.status_code).toBe(200);
      expect(prepared.body.toString('utf8')).toBe(
        canonicalJson({
          items: [
            { kind: 'decision', text: 'Ship the exact reviewer read.' },
          ],
          policy_id: 'restricted-reviewer-v1',
          schema_version: 1,
          witness:
            'Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active.',
        }),
      );
      expect(sourceReads).toBe(1);

      const database = new Database(fixture.databasePath, { readonly: true });
      try {
        const audit = database
          .prepare(
            `SELECT decision, reason_code, detail_json
             FROM authority_query_decision_audit
             ORDER BY audit_sequence DESC LIMIT 1`,
          )
          .get() as {
          decision: string;
          reason_code: string;
          detail_json: string;
        };
        expect(audit).toMatchObject({
          decision: 'allow',
          reason_code: 'active_exact_reviewer_membership',
        });
        const detail = JSON.parse(audit.detail_json) as Record<string, unknown>;
        expect(detail['response_sha256']).toBe(sha256Digest(prepared.body));
        expect(detail['returned_atom_ids']).toEqual([atomId]);
        expect(fixture.application.adminOverview().counts.audit_entries).toBeGreaterThan(0);
        expect(
          fixture.application
            .listAudit({ limit: 100 })
            .items.some((entry) => entry.action.includes('reviewer_query')),
        ).toBe(false);
      } finally {
        database.close();
      }

      const next = await reviewerRecentDecisionsRequest(fixture);
      const denied = fixture.application.serveReviewerRecentDecisions(
        next,
        () => {
          fixture.clock.advance(5 * 60 * 1000 + 1);
          return {
            items: [],
            record_head: { position: 1, record_hash: recordHash },
          };
        },
      );
      expect(denied.status_code).toBe(401);
      expect(denied.body.toString('utf8')).toBe(
        '{"error":{"code":"unauthorized","message":"authorization failed"}}',
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it('fails closed when an access-request row is rebound to another valid state', async () => {
    const fixture = await createEnrolledFixture('2026-07-22T17:00:00.000Z');
    try {
      fixture.clock.advance(1);
      const initialStateSha256 = canonicalSha256(
        fixture.enrolled.result.access_state,
      );
      const command = await createOrganizationAccessLeaseRequest(
        {
          request_id: `alr_${randomUUID()}`,
          authority_id: fixture.enrolled.result.enrollment_receipt.authority_id,
          authority_key_id:
            fixture.enrolled.result.enrollment_receipt.authority_key_id,
          organization_id:
            fixture.enrolled.result.enrollment_receipt.organization_id,
          enrollment_id:
            fixture.enrolled.result.enrollment_receipt.enrollment_id,
          installation_id: fixture.enrolled.installationId,
          installation_signing_key: fixture.enrolled.installation.descriptor,
          previous_access_state_sha256: initialStateSha256,
          requested_at: fixture.clock.now(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      const refreshed = await fixture.application.issueAccessLease(command);
      const database = new Database(fixture.databasePath);
      try {
        database
          .prepare(
            `UPDATE authority_access_lease_requests
             SET previous_access_state_sha256 = ?
             WHERE request_sha256 = ?`,
          )
          .run(canonicalSha256(refreshed), canonicalSha256(command));
      } finally {
        database.close();
      }

      await expect(
        fixture.application.issueAccessLease(command),
      ).rejects.toThrow(
        'authority database invariant: access request columns or coordinates differ from authenticated document',
      );
    } finally {
      closeFixture(fixture);
    }
  });
});
