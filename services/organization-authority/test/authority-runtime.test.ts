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
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  createSignedDocumentWithKey,
  federationId,
  normalizeP256LowS,
  p256KeyId,
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
  createOrganizationInternalLiveDirectiveRequest,
  createOrganizationInternalLiveUpdateReceipt,
  createOrganizationPermissionCheckRequest,
  createOrganizationSlackLinkBeginRequest,
  organizationInternalLiveManifestSha256,
} from '@echo-brain/organization-api';
import type { OrganizationPermissionCheckRequestV1 } from '@echo-brain/organization-api';
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

function internalLiveReleaseApproval(
  releaseVersion: string,
  sourceCharacter: string,
  artifactCharacter: string,
) {
  const releaseTag = `internal-v${releaseVersion}`;
  const manifest = {
    schema_version: 1 as const,
    kind: 'echo-internal-live-release' as const,
    channel: 'internal-live' as const,
    release_version: releaseVersion,
    release_tag: releaseTag,
    source: {
      sha: sourceCharacter.repeat(40),
      kind: 'materialized-commit' as const,
    },
    artifact: {
      package: 'echo-brain' as const,
      filename: `echo-brain-${releaseVersion}.tgz`,
      download_url: `https://github.com/EchoBrain-org/echo-brain/releases/download/${releaseTag}/echo-brain-${releaseVersion}.tgz`,
      size_bytes: 1234,
      sha256: artifactCharacter.repeat(64),
    },
    compatibility: {
      os: 'darwin' as const,
      arch: 'arm64' as const,
      node: '22.22.1',
      npm: '10.9.4',
    },
    build: {
      repository: 'EchoBrain-org/echo-brain',
      workflow: 'internal-live-release.yml' as const,
      run_id: '123456789',
      run_attempt: 1,
    },
  };
  return {
    schema_version: 1 as const,
    kind: 'echo-internal-live-release-approval-request' as const,
    command_id: `adm_${randomUUID()}`,
    manifest_url: `https://github.com/EchoBrain-org/echo-brain/releases/download/${releaseTag}/internal-live-release-manifest.v1.json`,
    manifest_sha256: organizationInternalLiveManifestSha256(manifest),
    manifest,
  };
}

describe('single-organization authority runtime', () => {
  it('approves one immutable internal-live pointer and records signed redacted rollout receipts', async () => {
    const fixture = await createEnrolledFixture('2026-08-02T20:00:00.000Z');
    try {
      const approval = internalLiveReleaseApproval(
        '0.1.0-internal.1',
        'a',
        'b',
      );
      const { manifest } = approval;
      expect(fixture.application.internalLiveRolloutStatus()).toMatchObject({
        channel: 'internal-live',
        approved_release: null,
        installations: [
          {
            installation_id: fixture.enrolled.installationId,
            rollout_state: 'no_release',
            receipt: null,
          },
        ],
      });
      const approvalForVersion = (
        releaseVersion: string,
        sourceCharacter: string,
        artifactCharacter: string,
      ) =>
        internalLiveReleaseApproval(
          releaseVersion,
          sourceCharacter,
          artifactCharacter,
        );
      fixture.clock.advance(1);
      const approved = fixture.application.approveInternalLiveRelease(approval);
      expect(approved).toMatchObject({
        kind: 'echo-internal-live-update-directive',
        channel: 'internal-live',
        directive_sequence: 1,
        manifest_url: approval.manifest_url,
        manifest_sha256: approval.manifest_sha256,
      });
      expect(fixture.application.approveInternalLiveRelease(approval)).toEqual(
        approved,
      );
      expect(() =>
        fixture.application.approveInternalLiveRelease({
          ...approval,
          manifest_url: approval.manifest_url.replace(
            'internal-live-release-manifest',
            'different',
          ),
        }),
      ).toThrow();
      for (const candidate of [
        approvalForVersion('0.1.0-internal.0', 'c', 'd'),
        approvalForVersion('0.1.0-internal.1', 'd', 'e'),
      ]) {
        expect(() =>
          fixture.application.approveInternalLiveRelease(candidate),
        ).toThrow(/version must increase monotonically/);
      }

      fixture.clock.advance(1);
      const directiveRequest =
        await createOrganizationInternalLiveDirectiveRequest(
          {
            request_id: `udr_${randomUUID()}`,
            authority_id:
              fixture.enrolled.result.enrollment_receipt.authority_id,
            authority_key_id:
              fixture.enrolled.result.enrollment_receipt.authority_key_id,
            organization_id:
              fixture.enrolled.result.enrollment_receipt.organization_id,
            enrollment_id:
              fixture.enrolled.result.enrollment_receipt.enrollment_id,
            installation_id: fixture.enrolled.installationId,
            installation_signing_key: fixture.enrolled.installation.descriptor,
            requested_at: fixture.clock.now(),
          },
          async (bytes) => sign(fixture.enrolled.installation, bytes),
        );
      expect(
        fixture.application.fetchInternalLiveDirective(directiveRequest),
      ).toMatchObject({
        directive_sequence: 1,
        manifest_sha256: approval.manifest_sha256,
      });

      const higherApproval = approvalForVersion(
        '0.1.0-internal.2',
        'e',
        'f',
      );
      const rolledBackReceipt =
        await createOrganizationInternalLiveUpdateReceipt(
          {
            authority_id:
              fixture.enrolled.result.enrollment_receipt.authority_id,
            authority_key_id:
              fixture.enrolled.result.enrollment_receipt.authority_key_id,
            organization_id:
              fixture.enrolled.result.enrollment_receipt.organization_id,
            enrollment_id:
              fixture.enrolled.result.enrollment_receipt.enrollment_id,
            installation_id: fixture.enrolled.installationId,
            installation_signing_key:
              fixture.enrolled.installation.descriptor,
            transaction_id: `upd_${randomUUID()}`,
            directive_sequence: 1,
            release_version: manifest.release_version,
            manifest_sha256: approval.manifest_sha256,
            artifact_sha256: manifest.artifact.sha256,
            source_sha: manifest.source.sha,
            outcome: 'rolled_back',
            doctor: { ok: true, passed: 10, total: 10 },
            failure: { phase: 'doctor', code: 'doctor_failed' },
            finished_at: fixture.clock.now(),
          },
          async (bytes) => sign(fixture.enrolled.installation, bytes),
        );
      fixture.application.recordInternalLiveUpdateReceipt(rolledBackReceipt);
      expect(() =>
        fixture.application.approveInternalLiveRelease(higherApproval),
      ).toThrow(/not healthy on every active installation/);

      const secondMembership = fixture.application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Second Rollout Employee',
        membership_type: 'employee',
      });
      const secondEnrolled = await enroll(
        fixture.application,
        secondMembership,
        fixture.clock,
      );

      const transactionId = `upd_${randomUUID()}`;
      fixture.clock.advance(1);
      const receiptPayload = {
        authority_id:
          fixture.enrolled.result.enrollment_receipt.authority_id,
        authority_key_id:
          fixture.enrolled.result.enrollment_receipt.authority_key_id,
        organization_id:
          fixture.enrolled.result.enrollment_receipt.organization_id,
        enrollment_id:
          fixture.enrolled.result.enrollment_receipt.enrollment_id,
        installation_id: fixture.enrolled.installationId,
        installation_signing_key: fixture.enrolled.installation.descriptor,
        transaction_id: transactionId,
        directive_sequence: 1,
        release_version: manifest.release_version,
        manifest_sha256: approval.manifest_sha256,
        artifact_sha256: manifest.artifact.sha256,
        source_sha: manifest.source.sha,
        outcome: 'healthy' as const,
        doctor: { ok: true, passed: 11, total: 11 },
        failure: null,
        finished_at: fixture.clock.now(),
      };
      const receipt = await createOrganizationInternalLiveUpdateReceipt(
        receiptPayload,
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      fixture.clock.advance(5 * 60 * 1000 + 1);
      expect(() =>
        fixture.application.recordInternalLiveUpdateReceipt(receipt),
      ).not.toThrow();
      const resignedReceipt = await createOrganizationInternalLiveUpdateReceipt(
        receiptPayload,
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      expect(() =>
        fixture.application.recordInternalLiveUpdateReceipt(resignedReceipt),
      ).not.toThrow();
      expect(() =>
        fixture.application.approveInternalLiveRelease(higherApproval),
      ).toThrow(/not healthy on every active installation/);
      const divergentReceipt = await createOrganizationInternalLiveUpdateReceipt(
        {
          ...receiptPayload,
          outcome: 'failed',
          doctor: null,
          failure: { phase: 'doctor', code: 'doctor_failed' },
          finished_at: fixture.clock.now(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      expect(() =>
        fixture.application.recordInternalLiveUpdateReceipt(divergentReceipt),
      ).toThrow(/transaction ID was reused/);
      const futureReceipt = await createOrganizationInternalLiveUpdateReceipt(
        {
          ...receiptPayload,
          transaction_id: `upd_${randomUUID()}`,
          finished_at: new Date(
            Date.parse(fixture.clock.now()) + 1,
          ).toISOString(),
        },
        async (bytes) => sign(fixture.enrolled.installation, bytes),
      );
      expect(() =>
        fixture.application.recordInternalLiveUpdateReceipt(futureReceipt),
      ).toThrow(/finished_at cannot be in the future/);
      const secondReceipt = await createOrganizationInternalLiveUpdateReceipt(
        {
          ...receiptPayload,
          enrollment_id:
            secondEnrolled.result.enrollment_receipt.enrollment_id,
          installation_id: secondEnrolled.installationId,
          installation_signing_key: secondEnrolled.installation.descriptor,
          transaction_id: `upd_${randomUUID()}`,
          finished_at: fixture.clock.now(),
        },
        async (bytes) => sign(secondEnrolled.installation, bytes),
      );
      fixture.application.recordInternalLiveUpdateReceipt(secondReceipt);
      const rolloutStatus = fixture.application.internalLiveRolloutStatus();
      expect(rolloutStatus).toMatchObject({
        approved_release: {
          directive_sequence: 1,
          release_version: manifest.release_version,
        },
      });
      expect(rolloutStatus.installations).toHaveLength(2);
      expect(
        rolloutStatus.installations.every(
          (installation) => installation.rollout_state === 'healthy',
        ),
      ).toBe(true);
      expect(
        rolloutStatus.installations.find(
          (installation) =>
            installation.installation_id === fixture.enrolled.installationId,
        ),
      ).toMatchObject({
        receipt: {
          release_version: manifest.release_version,
          doctor: { ok: true, passed: 11, total: 11 },
        },
      });
      const higher =
        fixture.application.approveInternalLiveRelease(higherApproval);
      expect(higher.directive_sequence).toBe(2);

      const database = new Database(fixture.databasePath, { readonly: true });
      try {
        const rows = database
          .prepare(
            `SELECT receipt_json FROM authority_internal_live_update_receipts`,
          )
          .all() as Array<{ receipt_json: string }>;
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.receipt_json).not.toMatch(
            /path|command|config|credential|meeting|transcript|log/i,
          );
        }
      } finally {
        database.close();
      }
    } finally {
      closeFixture(fixture);
    }
  });

  it('allows a strictly newer release to replace a pre-rollout approval', async () => {
    const fixture = await createEnrolledFixture('2026-08-02T21:00:00.000Z');
    try {
      const first = internalLiveReleaseApproval(
        '0.1.0-internal.1',
        'a',
        'b',
      );
      const second = internalLiveReleaseApproval(
        '0.1.0-internal.2',
        'c',
        'd',
      );

      expect(
        fixture.application.approveInternalLiveRelease(first),
      ).toMatchObject({
        directive_sequence: 1,
        manifest_sha256: first.manifest_sha256,
      });
      expect(
        fixture.application.approveInternalLiveRelease(second),
      ).toMatchObject({
        directive_sequence: 2,
        manifest_sha256: second.manifest_sha256,
      });
      expect(fixture.application.internalLiveRolloutStatus()).toMatchObject({
        approved_release: {
          directive_sequence: 2,
          release_version: '0.1.0-internal.2',
        },
        installations: [
          {
            installation_id: fixture.enrolled.installationId,
            rollout_state: 'pending',
            receipt: null,
          },
        ],
      });

      const older = internalLiveReleaseApproval(
        '0.1.0-internal.1',
        'e',
        'f',
      );
      expect(() =>
        fixture.application.approveInternalLiveRelease(older),
      ).toThrow(/version must increase monotonically/);
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
        enrollment_id:
          fixture.enrolled.result.enrollment_receipt.enrollment_id,
        installation_id: fixture.enrolled.installationId,
        installation_key_id:
          fixture.enrolled.installation.descriptor.key_id,
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
        principal_id:
          fixture.enrolled.result.enrollment_receipt.principal_id,
        membership_id:
          fixture.enrolled.result.enrollment_receipt.membership_id,
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

  it('rejects unknown, forged, and stale permission-check authentication', async () => {
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

      fixture.clock.advance(5 * 60 * 1000 + 1);
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
        | InstanceType<typeof StaleAccessStateError>['currentState']
        | undefined;
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
        | InstanceType<typeof StaleAccessStateError>['currentState']
        | undefined;
      try {
        await application.issueAccessLease(expiredStale);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleAccessStateError);
        recovered = (error as StaleAccessStateError).currentState;
      }
      if (recovered === undefined) {
        throw new Error('expired stale-head recovery did not return a conflict');
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
        transaction.accessLeaseRequestByDigest(
          canonicalSha256(expiredStale),
        ),
      );
      expect(storedRecoveryRequest).toBeUndefined();

      clock.advance(6 * 60 * 1000);
      const oldAncestorRequest =
        await createOrganizationAccessLeaseRequest(
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
        | InstanceType<typeof StaleAccessStateError>['currentState']
        | undefined;
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
            authority_key_id:
              second.result.enrollment_receipt.authority_key_id,
            organization_id:
              second.result.enrollment_receipt.organization_id,
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
