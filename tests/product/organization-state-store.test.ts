import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationEnrollmentReceipt,
  createOrganizationEnrollmentRequest,
  createOrganizationInstallationAccessState,
  organizationAuthorityPinSha256,
  organizationEnrollmentGrantSha256,
  verifyOrganizationAuthorityPin,
  type CanonicalPayloadSigner,
  type OrganizationAuthorityDescriptorV1,
  type OrganizationEnrollmentReceiptV1,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessStateV1,
} from '@echo-brain/organization-protocol';
import {
  OrganizationClockRollbackError,
  OrganizationStateConflictError,
  OrganizationStateCorruptionError,
  SqliteOrganizationStateStore,
  type OrganizationAccessVerificationPolicy,
} from '../../src/product/organization/state/sqlite-organization-state-store.js';

const MAX_TTL_MS = 5 * 60 * 1000;
const ENROLLED_AT = '2026-07-22T00:00:00.000Z';
const EVALUATED_ONE = '2026-07-22T00:01:00.000Z';
const EVALUATED_TWO = '2026-07-22T00:02:00.000Z';
const EVALUATED_THREE = '2026-07-22T00:03:00.000Z';

function fixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix
    .toString()
    .padStart(12, '0')}`;
}

interface GeneratedSigner {
  descriptor: P256SigningKeyDescriptor;
  sign: CanonicalPayloadSigner;
}

function generatedSigner(): GeneratedSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(publicKeyDer)) throw new Error('unexpected key export');
  return {
    descriptor: {
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
    },
    sign: signer(privateKey),
  };
}

function signer(privateKey: KeyObject): CanonicalPayloadSigner {
  return async (bytes) =>
    normalizeP256LowS(
      signMessage('sha256', bytes, {
        key: privateKey,
        dsaEncoding: 'der',
      }),
    );
}

interface OnboardingChain {
  authority: OrganizationAuthorityDescriptorV1;
  authorityPin: string;
  grant: Buffer;
  request: OrganizationEnrollmentRequestV1;
  receipt: OrganizationEnrollmentReceiptV1;
  alternateReceipt: OrganizationEnrollmentReceiptV1;
  activeOne: OrganizationInstallationAccessStateV1;
  divergentActiveOne: OrganizationInstallationAccessStateV1;
  activeTwo: OrganizationInstallationAccessStateV1;
  activeThree: OrganizationInstallationAccessStateV1;
  divergentActiveThree: OrganizationInstallationAccessStateV1;
  revokedTwo: OrganizationInstallationAccessStateV1;
}

async function onboardingChain(): Promise<OnboardingChain> {
  const authoritySigner = generatedSigner();
  const installationSigner = generatedSigner();
  const authority: OrganizationAuthorityDescriptorV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: fixtureId('oau', 1),
    organization_id: fixtureId('org', 1),
    signing_key: authoritySigner.descriptor,
  };
  const authorityPin = organizationAuthorityPinSha256(authority);
  const pinned = verifyOrganizationAuthorityPin(authority, authorityPin);
  const grant = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  const request = await createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(grant),
      principal_id: fixtureId('prn', 1),
      membership_id: fixtureId('mem', 1),
      installation_id: fixtureId('ins', 1),
      installation_signing_key: installationSigner.descriptor,
    },
    pinned,
    installationSigner.sign,
  );
  const receipt = await createOrganizationEnrollmentReceipt(
    {
      enrollment_id: fixtureId('enr', 1),
      membership_type: 'employee',
      enrolled_at: ENROLLED_AT,
      request,
    },
    pinned,
    authoritySigner.sign,
  );
  const alternateReceipt = await createOrganizationEnrollmentReceipt(
    {
      enrollment_id: fixtureId('enr', 2),
      membership_type: 'employee',
      enrolled_at: ENROLLED_AT,
      request,
    },
    pinned,
    authoritySigner.sign,
  );
  const activeOne = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: null,
      access_state_sequence: 1,
      evaluated_at: EVALUATED_ONE,
      status: 'active',
      valid_until: '2026-07-22T00:06:00.000Z',
      maximum_active_ttl_ms: MAX_TTL_MS,
    },
    pinned,
    authoritySigner.sign,
  );
  const divergentActiveOne = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: null,
      access_state_sequence: 1,
      evaluated_at: EVALUATED_ONE,
      status: 'active',
      valid_until: '2026-07-22T00:05:30.000Z',
      maximum_active_ttl_ms: MAX_TTL_MS,
    },
    pinned,
    authoritySigner.sign,
  );
  const activeTwo = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: activeOne,
      access_state_sequence: 2,
      evaluated_at: EVALUATED_TWO,
      status: 'active',
      valid_until: '2026-07-22T00:07:00.000Z',
      maximum_active_ttl_ms: MAX_TTL_MS,
    },
    pinned,
    authoritySigner.sign,
  );
  const activeThree = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: activeTwo,
      access_state_sequence: 3,
      evaluated_at: EVALUATED_THREE,
      status: 'active',
      valid_until: '2026-07-22T00:08:00.000Z',
      maximum_active_ttl_ms: MAX_TTL_MS,
    },
    pinned,
    authoritySigner.sign,
  );
  const divergentActiveThree = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: activeTwo,
      access_state_sequence: 3,
      evaluated_at: '2026-07-22T00:03:30.000Z',
      status: 'active',
      valid_until: '2026-07-22T00:08:30.000Z',
      maximum_active_ttl_ms: MAX_TTL_MS,
    },
    pinned,
    authoritySigner.sign,
  );
  const revokedTwo = await createOrganizationInstallationAccessState(
    {
      request,
      receipt,
      previous_state: activeOne,
      access_state_sequence: 2,
      evaluated_at: EVALUATED_TWO,
      status: 'revoked',
      revocation_reason: 'installation_revoked',
    },
    pinned,
    authoritySigner.sign,
  );
  return {
    authority,
    authorityPin,
    grant,
    request,
    receipt,
    alternateReceipt,
    activeOne,
    divergentActiveOne,
    activeTwo,
    activeThree,
    divergentActiveThree,
    revokedTwo,
  };
}

function policy(
  now: string,
  allowedClockSkew = 0,
): OrganizationAccessVerificationPolicy {
  return {
    now,
    maximum_active_ttl_ms: MAX_TTL_MS,
    allowed_clock_skew_ms: allowedClockSkew,
  };
}

const temporaryRoots: string[] = [];
const stores: SqliteOrganizationStateStore[] = [];

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-organization-state-'));
  temporaryRoots.push(root);
  return join(root, 'echo-brain.sqlite');
}

function openStore(databasePath: string): SqliteOrganizationStateStore {
  const store = new SqliteOrganizationStateStore(databasePath);
  stores.push(store);
  return store;
}

function seedEnrollment(
  store: SqliteOrganizationStateStore,
  chain: OnboardingChain,
): void {
  store.pinAuthority(chain.authority, chain.authorityPin);
  store.saveEnrollmentRequest(chain.request);
  store.saveEnrollmentReceipt(chain.receipt);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SQLite organization installation state', () => {
  it('pins exact authority bytes write-once and reconstructs trust after restart', async () => {
    const chain = await onboardingChain();
    const databasePath = temporaryDatabase();
    const store = openStore(databasePath);
    const first = store.pinAuthority(chain.authority, chain.authorityPin);
    const retry = store.pinAuthority(chain.authority, chain.authorityPin);
    expect(retry.authority_pin_sha256).toBe(first.authority_pin_sha256);
    store.close();

    const reopened = openStore(databasePath);
    expect(reopened.readPinnedAuthority()?.authority_pin_sha256).toBe(
      chain.authorityPin,
    );
    const otherSigner = generatedSigner();
    const otherAuthority = {
      ...chain.authority,
      signing_key: otherSigner.descriptor,
    };
    expect(() =>
      reopened.pinAuthority(
        otherAuthority,
        organizationAuthorityPinSha256(otherAuthority),
      ),
    ).toThrow(OrganizationStateConflictError);
    reopened.close();

    const database = new Database(databasePath);
    database.exec('DROP TRIGGER organization_authority_pins_are_write_once');
    database
      .prepare(`UPDATE organization_authority_pins SET descriptor_json = '{}'`)
      .run();
    database.close();
    const corrupted = openStore(databasePath);
    expect(() => corrupted.readPinnedAuthority()).toThrow(
      OrganizationStateCorruptionError,
    );
  });

  it('retains one exact request before receipt without storing the raw grant', async () => {
    const chain = await onboardingChain();
    const databasePath = temporaryDatabase();
    const store = openStore(databasePath);
    store.pinAuthority(chain.authority, chain.authorityPin);
    expect(store.saveEnrollmentRequest(chain.request)).toEqual(chain.request);
    expect(store.saveEnrollmentRequest(chain.request)).toEqual(chain.request);

    const database = new Database(databasePath, { readonly: true });
    const pending = database
      .prepare(
        `SELECT status, enrollment_grant_sha256, request_json
         FROM organization_enrollments`,
      )
      .get() as {
      status: string;
      enrollment_grant_sha256: string;
      request_json: string;
    };
    expect(pending).toEqual({
      status: 'pending',
      enrollment_grant_sha256: chain.request.enrollment_grant_sha256,
      request_json: canonicalJson(chain.request),
    });
    expect(pending.request_json).not.toContain(chain.grant.toString('utf8'));
    expect(pending.request_json).not.toContain(chain.grant.toString('base64'));
    expect(readFileSync(databasePath).includes(chain.grant)).toBe(false);
    database.close();

    expect(store.saveEnrollmentReceipt(chain.receipt)).toEqual(chain.receipt);
    expect(store.saveEnrollmentReceipt(chain.receipt)).toEqual(chain.receipt);
    expect(() => store.saveEnrollmentReceipt(chain.alternateReceipt)).toThrow(
      OrganizationStateConflictError,
    );
    expect(store.readEnrollment()).toMatchObject({
      request: chain.request,
      receipt: chain.receipt,
      accepted_access_sequence: 0,
      accepted_access_sha256: null,
      trusted_time_high_watermark: null,
    });
  });

  it('accepts exact retries and monotonic jumps but rejects rollback and divergent sequence reuse', async () => {
    const chain = await onboardingChain();
    const store = openStore(temporaryDatabase());
    seedEnrollment(store, chain);

    expect(
      store.acceptAccessState(
        chain.activeOne,
        policy('2026-07-22T00:02:00.000Z'),
      ).permitted,
    ).toBe(true);
    expect(
      store.acceptAccessState(
        chain.activeOne,
        policy('2026-07-22T00:02:30.000Z'),
      ).permitted,
    ).toBe(true);
    expect(() =>
      store.acceptAccessState(
        chain.divergentActiveOne,
        policy('2026-07-22T00:02:40.000Z'),
      ),
    ).toThrow(/sequence was reused divergently/);
    expect(
      store.acceptAccessState(
        chain.activeThree,
        policy('2026-07-22T00:03:30.000Z'),
      ).state.access_state_sequence,
    ).toBe(3);
    expect(() =>
      store.acceptAccessState(
        chain.divergentActiveThree,
        policy('2026-07-22T00:04:00.000Z'),
      ),
    ).toThrow(/sequence was reused divergently/);
    expect(() =>
      store.acceptAccessState(
        chain.activeOne,
        policy('2026-07-22T00:04:30.000Z'),
      ),
    ).toThrow(/sequence rolled back/);
    expect(store.readEnrollment()?.accepted_access_sequence).toBe(3);
  });

  it('makes revocation terminal while preserving its signed high-watermark', async () => {
    const chain = await onboardingChain();
    const store = openStore(temporaryDatabase());
    seedEnrollment(store, chain);
    store.acceptAccessState(
      chain.activeOne,
      policy('2026-07-22T00:01:30.000Z'),
    );
    const revoked = store.acceptAccessState(
      chain.revokedTwo,
      policy('2026-07-22T00:02:30.000Z'),
    );
    expect(revoked).toMatchObject({
      permitted: false,
      state: { status: 'revoked', access_state_sequence: 2 },
    });
    expect(() =>
      store.acceptAccessState(
        chain.activeThree,
        policy('2026-07-22T00:04:00.000Z'),
      ),
    ).toThrow(/revoked organization access state is terminal/);
    expect(
      store.verifyCurrentAccess(policy('2026-07-22T00:04:30.000Z')),
    ).toMatchObject({ permitted: false, state: { status: 'revoked' } });
    expect(store.readEnrollment()?.accepted_access_sequence).toBe(2);
  });

  it('persists trusted authority time and cannot resurrect an expired lease through clock rollback', async () => {
    const chain = await onboardingChain();
    const databasePath = temporaryDatabase();
    const store = openStore(databasePath);
    seedEnrollment(store, chain);
    expect(
      store.acceptAccessState(
        chain.activeOne,
        policy('2026-07-22T00:00:59.900Z', 100),
      ).permitted,
    ).toBe(true);
    expect(store.readEnrollment()?.trusted_time_high_watermark).toBe(
      EVALUATED_ONE,
    );
    expect(
      store.verifyCurrentAccess(policy('2026-07-22T00:05:00.000Z')).permitted,
    ).toBe(true);
    expect(() =>
      store.verifyCurrentAccess(policy('2026-07-22T00:04:59.999Z')),
    ).toThrow(OrganizationClockRollbackError);
    expect(() =>
      store.verifyCurrentAccess(policy('2026-07-22T00:07:00.000Z')),
    ).toThrow(/lease has expired/);

    const database = new Database(databasePath, { readonly: true });
    expect(
      database
        .prepare(
          `SELECT e.trusted_time_high_watermark AS enrollment_time,
                  a.trusted_time_high_watermark AS access_time
           FROM organization_enrollments e
           JOIN organization_access_high_watermarks a USING (request_sha256)`,
        )
        .get(),
    ).toEqual({
      enrollment_time: '2026-07-22T00:07:00.000Z',
      access_time: '2026-07-22T00:07:00.000Z',
    });
    database.close();
    expect(() =>
      store.verifyCurrentAccess(policy('2026-07-22T00:05:30.000Z')),
    ).toThrow(OrganizationClockRollbackError);
  });

  it('fails closed when the retained access document is missing', async () => {
    const chain = await onboardingChain();
    const databasePath = temporaryDatabase();
    const store = openStore(databasePath);
    seedEnrollment(store, chain);
    store.acceptAccessState(
      chain.activeOne,
      policy('2026-07-22T00:02:00.000Z'),
    );
    store.close();

    const database = new Database(databasePath);
    database.exec(
      'DROP TRIGGER organization_access_high_watermark_cannot_be_deleted',
    );
    database.prepare('DELETE FROM organization_access_high_watermarks').run();
    database.close();
    const reopened = openStore(databasePath);
    expect(() =>
      reopened.verifyCurrentAccess(policy('2026-07-22T00:03:00.000Z')),
    ).toThrow(OrganizationStateCorruptionError);
    expect(() =>
      reopened.acceptAccessState(
        chain.activeThree,
        policy('2026-07-22T00:03:30.000Z'),
      ),
    ).toThrow(OrganizationStateCorruptionError);
  });

  it('rolls back the access row when the atomic pointer update fails', async () => {
    const chain = await onboardingChain();
    const databasePath = temporaryDatabase();
    const store = openStore(databasePath);
    seedEnrollment(store, chain);
    store.acceptAccessState(
      chain.activeOne,
      policy('2026-07-22T00:02:00.000Z'),
    );

    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER test_reject_access_pointer
      BEFORE UPDATE OF accepted_access_sequence ON organization_enrollments
      WHEN NEW.accepted_access_sequence > OLD.accepted_access_sequence
      BEGIN
        SELECT RAISE(ABORT, 'injected pointer failure');
      END
    `);
    expect(() =>
      store.acceptAccessState(
        chain.activeThree,
        policy('2026-07-22T00:03:30.000Z'),
      ),
    ).toThrow(/injected pointer failure/);
    expect(
      database
        .prepare(
          `SELECT access_state_sequence FROM organization_access_high_watermarks`,
        )
        .get(),
    ).toEqual({ access_state_sequence: 1 });
    expect(
      database
        .prepare(
          `SELECT accepted_access_sequence FROM organization_enrollments`,
        )
        .get(),
    ).toEqual({ accepted_access_sequence: 1 });
    database.close();
  });
});
