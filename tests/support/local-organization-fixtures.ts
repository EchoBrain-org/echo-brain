import { Buffer } from 'node:buffer';
import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationAccessLeaseRequest,
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
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/machine/security/installation-signer.js';

export const NOW = '2026-07-22T00:02:00.000Z';
export const REFRESHED_AT = '2026-07-22T00:03:00.000Z';
export const MAX_TTL_MS = 5 * 60 * 1000;
export const GRANT = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
export const ACCESS_REQUEST_ID = 'alr_00000000-0000-4000-8000-000000000001';

export function fixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix
    .toString()
    .padStart(12, '0')}`;
}

export const ORGANIZATION_IDS = {
  authority: fixtureId('oau', 1),
  organization: fixtureId('org', 1),
  principal: fixtureId('prn', 1),
  membership: fixtureId('mem', 1),
  installation: fixtureId('ins', 1),
  enrollment: fixtureId('enr', 1),
} as const;

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

export class TestInstallationSigner implements InstallationSigner {
  readonly descriptor: InstallationKeyDescriptor;
  signCalls = 0;
  private readonly privateKey: KeyObject;

  constructor(installationId = ORGANIZATION_IDS.installation) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    if (!Buffer.isBuffer(publicKeyDer)) {
      throw new Error('unexpected installation key export');
    }
    this.privateKey = privateKey;
    this.descriptor = {
      installation_id: installationId,
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    };
  }

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    if (installationId !== this.descriptor.installation_id) {
      throw new Error('test signer installation mismatch');
    }
    return structuredClone(this.descriptor);
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return installationId === this.descriptor.installation_id
      ? structuredClone(this.descriptor)
      : null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    if (
      installationId !== this.descriptor.installation_id ||
      expectedKeyId !== this.descriptor.key_id
    ) {
      throw new Error('test signer key mismatch');
    }
    this.signCalls += 1;
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

export function protocolInstallationKey(
  signer: TestInstallationSigner,
): P256SigningKeyDescriptor {
  return {
    key_id: signer.descriptor.key_id,
    algorithm: signer.descriptor.algorithm,
    public_key_spki_der_base64: signer.descriptor.public_key_spki_der_base64,
  };
}

export class TestAuthority {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly pin: ReturnType<typeof organizationAuthorityPinSha256>;
  private readonly signer = generatedSigner();
  private completion: CompletedOrganizationEnrollmentV1 | null = null;
  private request: OrganizationEnrollmentRequestV1 | null = null;

  constructor(keySuffix = 1) {
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id:
        keySuffix === 1
          ? ORGANIZATION_IDS.authority
          : fixtureId('oau', keySuffix),
      organization_id:
        keySuffix === 1
          ? ORGANIZATION_IDS.organization
          : fixtureId('org', keySuffix),
      signing_key: this.signer.descriptor,
    };
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
        enrollment_id: ORGANIZATION_IDS.enrollment,
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

export async function signedEnrollmentRequest(
  authority: TestAuthority,
  installationSigner: TestInstallationSigner,
): Promise<OrganizationEnrollmentRequestV1> {
  const pinned = verifyOrganizationAuthorityPin(
    authority.descriptor,
    authority.pin,
  );
  const signingKey = protocolInstallationKey(installationSigner);
  return createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(GRANT),
      principal_id: ORGANIZATION_IDS.principal,
      membership_id: ORGANIZATION_IDS.membership,
      installation_id: ORGANIZATION_IDS.installation,
      installation_signing_key: signingKey,
    },
    pinned,
    (bytes) =>
      installationSigner.sign(
        ORGANIZATION_IDS.installation,
        bytes,
        signingKey.key_id,
      ),
  );
}

export async function signedAccessLeaseRequest(
  authority: TestAuthority,
  installationSigner: TestInstallationSigner,
): Promise<OrganizationAccessLeaseRequestV1> {
  const signingKey = protocolInstallationKey(installationSigner);
  return createOrganizationAccessLeaseRequest(
    {
      request_id: ACCESS_REQUEST_ID,
      authority_id: authority.descriptor.authority_id,
      authority_key_id: authority.descriptor.signing_key.key_id,
      organization_id: authority.descriptor.organization_id,
      enrollment_id: ORGANIZATION_IDS.enrollment,
      installation_id: ORGANIZATION_IDS.installation,
      installation_signing_key: signingKey,
      previous_access_state_sha256: authority.pin,
      requested_at: NOW,
    },
    (bytes) =>
      installationSigner.sign(
        ORGANIZATION_IDS.installation,
        bytes,
        signingKey.key_id,
      ),
  );
}

export interface MutableClock {
  value: string;
  now(): string;
}

export function mutableClock(value = NOW): MutableClock {
  return {
    value,
    now() {
      return this.value;
    },
  };
}

export function enrollmentInput(authority: TestAuthority) {
  return {
    authorityDescriptor: authority.descriptor,
    independentlyTrustedAuthorityPin: authority.pin,
    enrollmentGrant: Uint8Array.from(GRANT),
    principalId: ORGANIZATION_IDS.principal,
    membershipId: ORGANIZATION_IDS.membership,
    installationId: ORGANIZATION_IDS.installation,
  };
}

export function descriptorClient(
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
