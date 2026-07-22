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
  verifyOrganizationAccessLeaseRequest,
  type CompletedOrganizationEnrollmentV1,
  type OrganizationAccessLeaseRequestV1,
} from '@echo-brain/organization-api';
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
import type { OrganizationAuthorityClient } from '../../src/product/organization/client/authority-client.js';
import { HttpOrganizationAuthorityClient } from '../../src/product/organization/client/http-organization-authority-client.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import { signWithInstallationKey } from '../../src/product/federation/foundation/installation-signer.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import { CountingInstallationSigner } from './fixtures/federated-records.js';

const NOW = '2026-07-22T00:02:00.000Z';
const REFRESHED_AT = '2026-07-22T00:03:00.000Z';
const MAX_TTL_MS = 5 * 60 * 1000;
const GRANT = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const ACCESS_REQUEST_ID = 'alr_00000000-0000-4000-8000-000000000001';

function fixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix
    .toString()
    .padStart(12, '0')}`;
}

const IDS = {
  authority: fixtureId('oau', 1),
  organization: fixtureId('org', 1),
  principal: fixtureId('prn', 1),
  membership: fixtureId('mem', 1),
  installation: fixtureId('ins', 1),
  enrollment: fixtureId('enr', 1),
};

interface GeneratedSigner {
  descriptor: P256SigningKeyDescriptor;
  sign: CanonicalPayloadSigner;
}

function canonicalSigner(privateKey: KeyObject): CanonicalPayloadSigner {
  return async (bytes) =>
    normalizeP256LowS(
      signMessage('sha256', bytes, {
        key: privateKey,
        dsaEncoding: 'der',
      }),
    );
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
    sign: canonicalSigner(privateKey),
  };
}

function protocolInstallationKey(
  signer: CountingInstallationSigner,
): P256SigningKeyDescriptor {
  return {
    key_id: signer.descriptor.key_id,
    algorithm: signer.descriptor.algorithm,
    public_key_spki_der_base64: signer.descriptor.public_key_spki_der_base64,
  };
}

class TestAuthority {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly pin: ReturnType<typeof organizationAuthorityPinSha256>;
  private readonly signer = generatedSigner();
  private completion: CompletedOrganizationEnrollmentV1 | null = null;
  private request: OrganizationEnrollmentRequestV1 | null = null;

  constructor(keySuffix = 1) {
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      signing_key: this.signer.descriptor,
    };
    if (keySuffix !== 1) {
      this.descriptor = {
        ...this.descriptor,
        authority_id: fixtureId('oau', keySuffix),
        organization_id: fixtureId('org', keySuffix),
      };
    }
    this.pin = organizationAuthorityPinSha256(this.descriptor);
  }

  async complete(
    request: OrganizationEnrollmentRequestV1,
  ): Promise<CompletedOrganizationEnrollmentV1> {
    if (this.completion !== null) {
      if (canonicalJson(request) !== canonicalJson(this.request)) {
        throw new Error('authority received a divergent retry');
      }
      return this.completion;
    }
    const pinned = verifyOrganizationAuthorityPin(this.descriptor, this.pin);
    const receipt = await createOrganizationEnrollmentReceipt(
      {
        enrollment_id: IDS.enrollment,
        membership_type: 'employee',
        enrolled_at: '2026-07-22T00:00:00.000Z',
        request,
      },
      pinned,
      this.signer.sign,
    );
    const accessState = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence: 1,
        evaluated_at: '2026-07-22T00:01:00.000Z',
        status: 'active',
        valid_until: '2026-07-22T00:06:00.000Z',
        maximum_active_ttl_ms: MAX_TTL_MS,
      },
      pinned,
      this.signer.sign,
    );
    this.request = request;
    this.completion = {
      enrollment_receipt: receipt,
      access_state: accessState,
    };
    return this.completion;
  }

  async nextActiveState(
    request: OrganizationEnrollmentRequestV1,
    receipt: OrganizationEnrollmentReceiptV1,
    previousState: OrganizationInstallationAccessStateV1,
  ): Promise<OrganizationInstallationAccessStateV1> {
    const pinned = verifyOrganizationAuthorityPin(this.descriptor, this.pin);
    return createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: previousState,
        access_state_sequence: previousState.access_state_sequence + 1,
        evaluated_at: REFRESHED_AT,
        status: 'active',
        valid_until: '2026-07-22T00:08:00.000Z',
        maximum_active_ttl_ms: MAX_TTL_MS,
      },
      pinned,
      this.signer.sign,
    );
  }
}

interface MutableClock {
  value: string;
  now(): string;
}

function mutableClock(value = NOW): MutableClock {
  return {
    value,
    now() {
      return this.value;
    },
  };
}

const roots: string[] = [];
const stores: SqliteOrganizationStateStore[] = [];

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-local-organization-'));
  roots.push(root);
  return join(root, 'echo-brain.sqlite');
}

function openState(databasePath: string): SqliteOrganizationStateStore {
  const state = new SqliteOrganizationStateStore(databasePath);
  stores.push(state);
  return state;
}

function enrollmentInput(authority: TestAuthority) {
  return {
    authorityDescriptor: authority.descriptor,
    independentlyTrustedAuthorityPin: authority.pin,
    enrollmentGrant: Uint8Array.from(GRANT),
    principalId: IDS.principal,
    membershipId: IDS.membership,
    installationId: IDS.installation,
  };
}

function coordinator(
  state: SqliteOrganizationStateStore,
  authorityClient: OrganizationAuthorityClient,
  installationSigner: CountingInstallationSigner,
  clock: MutableClock,
): LocalOrganizationCoordinator {
  return new LocalOrganizationCoordinator({
    state,
    authorityClient,
    installationSigner,
    maximumActiveLeaseTtlMs: MAX_TTL_MS,
    clock,
    requestIds: {
      nextAccessLeaseRequestId: () => ACCESS_REQUEST_ID,
    },
  });
}

function descriptorClient(
  authority: TestAuthority,
  overrides: Partial<OrganizationAuthorityClient> = {},
): OrganizationAuthorityClient {
  return {
    readAuthorityDescriptor: async () => ({
      authority_descriptor: authority.descriptor,
    }),
    completeEnrollment: async ({ enrollmentRequest }) =>
      authority.complete(enrollmentRequest),
    issueAccessLease: async () => {
      throw new Error('unexpected access refresh');
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local organization coordinator', () => {
  it('persists the exact signed request before the bearer grant reaches the client', async () => {
    const authority = new TestAuthority();
    const databasePath = temporaryDatabase();
    const state = openState(databasePath);
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    let clientCalls = 0;
    const client = descriptorClient(authority, {
      completeEnrollment: async ({ enrollmentGrant, enrollmentRequest }) => {
        clientCalls += 1;
        expect(Buffer.from(enrollmentGrant)).toEqual(GRANT);
        const retained = state.readEnrollment();
        expect(retained).not.toBeNull();
        expect(retained?.receipt).toBeNull();
        expect(canonicalJson(retained?.request)).toBe(
          canonicalJson(enrollmentRequest),
        );
        return authority.complete(enrollmentRequest);
      },
    });

    const decision = await coordinator(
      state,
      client,
      installationSigner,
      mutableClock(),
    ).enroll(enrollmentInput(authority));
    expect(decision.permitted).toBe(true);
    expect(clientCalls).toBe(1);

    const database = new Database(databasePath, { readonly: true });
    const row = database
      .prepare(
        `SELECT request_json, enrollment_grant_sha256
         FROM organization_enrollments`,
      )
      .get() as {
      request_json: string;
      enrollment_grant_sha256: string;
    };
    expect(row.enrollment_grant_sha256).toBe(
      organizationEnrollmentGrantSha256(GRANT),
    );
    expect(row.request_json).not.toContain(GRANT.toString('utf8'));
    expect(row.request_json).not.toContain(GRANT.toString('base64'));
    expect(readFileSync(databasePath).includes(GRANT)).toBe(false);
    database.close();
  });

  it('refuses a mismatched remote descriptor before sending the grant', async () => {
    const authority = new TestAuthority();
    const remote = new TestAuthority(2);
    const state = openState(temporaryDatabase());
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    let grantSends = 0;
    const client = descriptorClient(authority, {
      readAuthorityDescriptor: async () => ({
        authority_descriptor: remote.descriptor,
      }),
      completeEnrollment: async () => {
        grantSends += 1;
        throw new Error('grant must not be sent');
      },
    });

    await expect(
      coordinator(state, client, installationSigner, mutableClock()).enroll(
        enrollmentInput(authority),
      ),
    ).rejects.toThrow(/does not match the independently pinned descriptor/);
    expect(grantSends).toBe(0);
    expect(installationSigner.signCalls).toBe(0);
    expect(state.readEnrollment()).toBeNull();
  });

  it('reopens after a lost response and retries the exact retained request without resigning it', async () => {
    const authority = new TestAuthority();
    const databasePath = temporaryDatabase();
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    const firstState = openState(databasePath);
    let firstRequest: OrganizationEnrollmentRequestV1 | null = null;
    const firstClient = descriptorClient(authority, {
      completeEnrollment: async ({ enrollmentRequest }) => {
        firstRequest = enrollmentRequest;
        await authority.complete(enrollmentRequest);
        throw new Error('simulated response loss');
      },
    });
    await expect(
      coordinator(
        firstState,
        firstClient,
        installationSigner,
        mutableClock(),
      ).enroll(enrollmentInput(authority)),
    ).rejects.toThrow(/simulated response loss/);
    expect(firstState.readEnrollment()?.receipt).toBeNull();
    expect(installationSigner.signCalls).toBe(1);
    firstState.close();

    const reopened = openState(databasePath);
    let retriedRequest: OrganizationEnrollmentRequestV1 | null = null;
    const retryClient = descriptorClient(authority, {
      completeEnrollment: async ({ enrollmentRequest }) => {
        retriedRequest = enrollmentRequest;
        return authority.complete(enrollmentRequest);
      },
    });
    const decision = await coordinator(
      reopened,
      retryClient,
      installationSigner,
      mutableClock(),
    ).enroll(enrollmentInput(authority));
    expect(decision.permitted).toBe(true);
    expect(canonicalJson(retriedRequest)).toBe(canonicalJson(firstRequest));
    expect(installationSigner.signCalls).toBe(1);
  });

  it('verifies the signed refresh command and accepts the signed next lease', async () => {
    const authority = new TestAuthority();
    const state = openState(temporaryDatabase());
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    const clock = mutableClock();
    let refreshRequest: OrganizationAccessLeaseRequestV1 | null = null;
    const client = descriptorClient(authority, {
      issueAccessLease: async (request) => {
        refreshRequest = verifyOrganizationAccessLeaseRequest(
          request,
          protocolInstallationKey(installationSigner),
        );
        const enrollment = state.readEnrollment();
        if (enrollment?.receipt === null || enrollment?.receipt === undefined) {
          throw new Error('enrollment disappeared');
        }
        const previous = state.verifyCurrentAccess({
          now: clock.value,
          maximum_active_ttl_ms: MAX_TTL_MS,
        }).state;
        return {
          access_state: await authority.nextActiveState(
            enrollment.request,
            enrollment.receipt,
            previous,
          ),
        };
      },
    });
    const local = coordinator(state, client, installationSigner, clock);
    await local.enroll(enrollmentInput(authority));
    const previousHash = state.readEnrollment()?.accepted_access_sha256;
    clock.value = REFRESHED_AT;
    const refreshed = await local.refreshAccess();

    expect(refreshed).toMatchObject({
      permitted: true,
      state: { access_state_sequence: 2 },
    });
    expect(refreshRequest).toMatchObject({
      request_id: ACCESS_REQUEST_ID,
      previous_access_state_sha256: previousHash,
      requested_at: REFRESHED_AT,
    });
    expect(state.readEnrollment()?.accepted_access_sequence).toBe(2);
  });

  it('accepts the signed current state carried by an HTTP stale-state 409', async () => {
    const authority = new TestAuthority();
    const state = openState(temporaryDatabase());
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    const clock = mutableClock();
    await coordinator(
      state,
      descriptorClient(authority),
      installationSigner,
      clock,
    ).enroll(enrollmentInput(authority));
    const enrollment = state.readEnrollment();
    if (enrollment?.receipt === null || enrollment?.receipt === undefined) {
      throw new Error('enrollment disappeared');
    }
    const previous = state.verifyCurrentAccess({
      now: clock.value,
      maximum_active_ttl_ms: MAX_TTL_MS,
    }).state;
    const currentState = await authority.nextActiveState(
      enrollment.request,
      enrollment.receipt,
      previous,
    );
    let postedCommand: OrganizationAccessLeaseRequestV1 | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://authority.example/v1/access-leases');
      expect(init?.method).toBe('POST');
      postedCommand = JSON.parse(
        String(init?.body),
      ) as OrganizationAccessLeaseRequestV1;
      return new Response(JSON.stringify({ access_state: currentState }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    };
    const httpClient = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: fetchImpl,
    });
    clock.value = REFRESHED_AT;
    const recovered = await coordinator(
      state,
      httpClient,
      installationSigner,
      clock,
    ).refreshAccess();

    expect(
      verifyOrganizationAccessLeaseRequest(
        postedCommand,
        protocolInstallationKey(installationSigner),
      ),
    ).toEqual(postedCommand);
    expect(recovered).toMatchObject({
      permitted: true,
      state: { access_state_sequence: 2 },
    });
    expect(state.readEnrollment()?.accepted_access_sequence).toBe(2);
  });
});

describe('HTTP organization authority client', () => {
  it('puts the enrollment grant only in the authorization header', async () => {
    const authority = new TestAuthority();
    const installationSigner = new CountingInstallationSigner(IDS.installation);
    const pinned = verifyOrganizationAuthorityPin(
      authority.descriptor,
      authority.pin,
    );
    const signingKey = protocolInstallationKey(installationSigner);
    const request = await createOrganizationEnrollmentRequest(
      {
        enrollment_grant_sha256: organizationEnrollmentGrantSha256(GRANT),
        principal_id: IDS.principal,
        membership_id: IDS.membership,
        installation_id: IDS.installation,
        installation_signing_key: signingKey,
      },
      pinned,
      (bytes) =>
        signWithInstallationKey(
          installationSigner,
          IDS.installation,
          signingKey.key_id,
          bytes,
        ),
    );
    let observed = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      observed = true;
      expect(String(input)).toBe('https://authority.example/v1/enrollments');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(
        `Echo-Enrollment ${GRANT.toString('base64url')}`,
      );
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual({ enrollment_request: request });
      expect(body).not.toContain(GRANT.toString('utf8'));
      expect(body).not.toContain(GRANT.toString('base64url'));
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: fetchImpl,
    });
    await expect(
      client.completeEnrollment({
        enrollmentGrant: Uint8Array.from(GRANT),
        enrollmentRequest: request,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(observed).toBe(true);
  });

  it('stops reading an oversized chunked response before buffering it all', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(40 * 1024));
            controller.enqueue(new Uint8Array(40 * 1024));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: fetchImpl,
    });

    await expect(client.readAuthorityDescriptor()).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });
});
