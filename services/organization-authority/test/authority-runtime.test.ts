import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
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
import { createOrganizationAccessLeaseRequest } from '@echo-brain/organization-api';
import { OrganizationAuthorityApplication } from '../src/application/organization-authority.js';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  EnrollmentGrantGenerator,
  OrganizationAuthoritySigner,
} from '../src/application/ports/runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { StaleAccessStateError } from '../src/domain/errors.js';

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

class UniqueGrants implements EnrollmentGrantGenerator {
  private nextValue = 1;

  generate(): Uint8Array {
    const result = new Uint8Array(32);
    result[0] = this.nextValue;
    this.nextValue += 1;
    return result;
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
    grants: new UniqueGrants(),
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
  const issued = application.issueEnrollmentGrant(
    membership.membership_id,
    3600,
  );
  const installation = testKey();
  const installationId = federationId('ins');
  const pinned = verifyOrganizationAuthorityPin(
    application.descriptor(),
    application.authorityPinSha256(),
  );
  const request = await createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(
        issued.enrollment_grant,
      ),
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
    enrollment_grant: issued.enrollment_grant,
    enrollment_request: request,
  });
  return {
    installation,
    installationId,
    grant: issued.enrollment_grant,
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

function closeFixture(
  fixture: Awaited<ReturnType<typeof createEnrolledFixture>>,
): void {
  fixture.application.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

describe('single-organization authority runtime', () => {
  it('enrolls idempotently, advances signed leases, rejects stale heads, and revokes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-authority-test-'));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, 'authority.sqlite');
    const clock = new FakeClock(Date.parse('2026-07-22T12:00:00.000Z'));
    const { application } = await createApplication(databasePath, clock);
    try {
      const membership = application.provisionMembership({
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

      const retryAfterAdvance = await application.completeEnrollment({
        enrollment_grant: enrolled.grant,
        enrollment_request: enrolled.request,
      });
      expect(canonicalJson(retryAfterAdvance)).toBe(
        canonicalJson(enrolled.result),
      );

      clock.advance(6 * 60 * 1000);
      const exactReplay = await application.issueAccessLease(access);
      expect(canonicalJson(exactReplay)).toBe(canonicalJson(refreshed));

      const stale = await createOrganizationAccessLeaseRequest(
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
      await expect(application.issueAccessLease(stale)).rejects.toBeInstanceOf(
        StaleAccessStateError,
      );

      const revoked = await application.revokeInstallation(
        enrolled.installationId,
        'Device retired',
      );
      expect(revoked.status).toBe('revoked');
      expect(revoked.revocation_reason).toBe('installation_revoked');
      expect(revoked.access_state_sequence).toBe(3);

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
        const tables = database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'authority_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>;
        expect(tables).toHaveLength(8);
        const grantRows = database
          .prepare('SELECT * FROM authority_enrollment_grants')
          .all();
        expect(JSON.stringify(grantRows)).not.toContain(
          Buffer.from(enrolled.grant).toString('base64url'),
        );
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
          display_name: 'Clock Regression',
          membership_type: 'employee',
        }),
      ).toThrow('clock regressed');
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
