import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationAccessLeaseRequestV2,
  MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
  validateCompletedOrganizationEnrollment,
  validateOrganizationAccessLeaseResponse,
  validateOrganizationAuthorityDescriptorResponse,
  type OrganizationAccessLeaseResponseV1,
} from '@echo-brain/organization-api';
import {
  createOrganizationEnrollmentRequest,
  organizationEnrollmentGrantSha256,
  type OrganizationAuthorityDescriptorV1,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessDecisionV1,
} from '@echo-brain/organization-protocol';
import type { InstallationSigner } from '../../machine/security/installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from '../../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from '../client/authority-client.js';
import { OrganizationAuthorityConflictError } from '../client/authority-client.js';
import type {
  OrganizationAccessVerificationPolicy,
  OrganizationStateStore,
  StoredOrganizationEnrollment,
} from '../state/organization-state-store.js';

export interface LocalOrganizationClock {
  now(): string;
}

export interface LocalOrganizationRequestIds {
  nextAccessLeaseRequestId(): string;
}

export interface LocalOrganizationCoordinatorOptions {
  state: OrganizationStateStore;
  authorityClient: OrganizationAuthorityClient;
  installationSigner: InstallationSigner;
  maximumActiveLeaseTtlMs: number;
  requestedActiveLeaseTtlMs?: number;
  allowedClockSkewMs?: number;
  clock?: LocalOrganizationClock;
  requestIds?: LocalOrganizationRequestIds;
}

export const MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS =
  MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS;
export const DEFAULT_LOCAL_ORGANIZATION_REQUESTED_LEASE_TTL_MS =
  MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS;
/**
 * Product deployments verify Authority-issued timestamps across two machines.
 * Permit routine distributed-clock differences while retaining a narrow,
 * fail-closed boundary well below the protocol's five-minute maximum.
 */
export const DEFAULT_LOCAL_ORGANIZATION_ACCESS_CLOCK_SKEW_MS = 5_000;

export interface EnrollLocalInstallationInput {
  authorityBaseUrl: string;
  authorityCaPem?: string;
  authorityDescriptor: OrganizationAuthorityDescriptorV1;
  independentlyTrustedAuthorityPin: Sha256Digest;
  enrollmentGrant: Uint8Array;
  principalId: string;
  membershipId: string;
  installationId: string;
}

function protocolSigningKey(
  signerDescriptor: Awaited<ReturnType<InstallationSigner['inspect']>>,
  installationId: string,
): P256SigningKeyDescriptor {
  if (signerDescriptor === null) {
    throw new Error('organization installation signing key is unavailable');
  }
  verifyInstallationKeyDescriptor(signerDescriptor);
  if (signerDescriptor.installation_id !== installationId) {
    throw new Error(
      'organization installation signer belongs to another installation',
    );
  }
  return {
    key_id: signerDescriptor.key_id,
    algorithm: signerDescriptor.algorithm,
    public_key_spki_der_base64: signerDescriptor.public_key_spki_der_base64,
  };
}

function assertExistingEnrollmentMatches(
  enrollment: StoredOrganizationEnrollment,
  input: EnrollLocalInstallationInput,
  grantSha256: Sha256Digest,
): void {
  const request = enrollment.request;
  if (
    request.authority_id !== input.authorityDescriptor.authority_id ||
    request.authority_key_id !== input.authorityDescriptor.signing_key.key_id ||
    request.organization_id !== input.authorityDescriptor.organization_id ||
    request.principal_id !== input.principalId ||
    request.membership_id !== input.membershipId ||
    request.installation_id !== input.installationId ||
    request.enrollment_grant_sha256 !== grantSha256
  ) {
    throw new Error(
      'retained organization enrollment does not match the supplied onboarding input',
    );
  }
}

/**
 * Installation-side enrollment and access orchestration.
 *
 * Signed responses are committed and reverified by the state store before a
 * permitted decision can escape this class. Network success alone is never
 * authorization.
 */
export class LocalOrganizationCoordinator {
  private readonly clock: LocalOrganizationClock;
  private readonly requestIds: LocalOrganizationRequestIds;

  constructor(private readonly options: LocalOrganizationCoordinatorOptions) {
    if (
      !Number.isSafeInteger(options.maximumActiveLeaseTtlMs) ||
      options.maximumActiveLeaseTtlMs < 1 ||
      options.maximumActiveLeaseTtlMs >
        MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS
    ) {
      throw new Error(
        `maximum organization access lease TTL must be an integer from 1 through ${MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS}`,
      );
    }
    const requestedActiveLeaseTtlMs =
      options.requestedActiveLeaseTtlMs ?? options.maximumActiveLeaseTtlMs;
    if (
      !Number.isSafeInteger(requestedActiveLeaseTtlMs) ||
      requestedActiveLeaseTtlMs < 1 ||
      requestedActiveLeaseTtlMs > options.maximumActiveLeaseTtlMs
    ) {
      throw new Error(
        'requested organization access lease TTL must be a positive integer no greater than the local verification ceiling',
      );
    }
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.requestIds =
      options.requestIds ??
      ({
        nextAccessLeaseRequestId: () => `alr_${randomUUID()}`,
      } satisfies LocalOrganizationRequestIds);
  }

  private requestedActiveLeaseTtlMs(): number {
    return (
      this.options.requestedActiveLeaseTtlMs ??
      this.options.maximumActiveLeaseTtlMs
    );
  }

  private verificationPolicy(): OrganizationAccessVerificationPolicy {
    return {
      now: this.clock.now(),
      maximum_active_ttl_ms: this.options.maximumActiveLeaseTtlMs,
      allowed_clock_skew_ms:
        this.options.allowedClockSkewMs ??
        DEFAULT_LOCAL_ORGANIZATION_ACCESS_CLOCK_SKEW_MS,
    };
  }

  private async assertRemoteAuthority(
    expected: OrganizationAuthorityDescriptorV1,
  ): Promise<void> {
    const observed = validateOrganizationAuthorityDescriptorResponse(
      await this.options.authorityClient.readAuthorityDescriptor(),
    ).authority_descriptor;
    if (canonicalJson(observed) !== canonicalJson(expected)) {
      throw new Error(
        'organization authority endpoint does not match the independently pinned descriptor',
      );
    }
  }

  private async signerKey(
    installationId: string,
    generate: boolean,
  ): Promise<P256SigningKeyDescriptor> {
    let descriptor =
      await this.options.installationSigner.inspect(installationId);
    if (descriptor === null && generate) {
      descriptor =
        await this.options.installationSigner.generate(installationId);
    }
    return protocolSigningKey(descriptor, installationId);
  }

  private async prepareRequest(
    input: EnrollLocalInstallationInput,
    grantSha256: Sha256Digest,
  ): Promise<OrganizationEnrollmentRequestV1> {
    const retained = this.options.state.readEnrollment();
    if (retained !== null) {
      assertExistingEnrollmentMatches(retained, input, grantSha256);
      const signerKey = await this.signerKey(input.installationId, false);
      if (
        canonicalJson(signerKey) !==
        canonicalJson(retained.request.installation_signing_key)
      ) {
        throw new Error(
          'organization installation signer no longer matches the retained enrollment request',
        );
      }
      return retained.request;
    }

    const signerKey = await this.signerKey(input.installationId, true);
    const pinnedAuthority = this.options.state.readPinnedAuthority();
    if (pinnedAuthority === null) {
      throw new Error(
        'organization authority pin disappeared during enrollment',
      );
    }
    const request = await createOrganizationEnrollmentRequest(
      {
        enrollment_grant_sha256: grantSha256,
        principal_id: input.principalId,
        membership_id: input.membershipId,
        installation_id: input.installationId,
        installation_signing_key: signerKey,
      },
      pinnedAuthority,
      (bytes) =>
        signWithInstallationKey(
          this.options.installationSigner,
          input.installationId,
          signerKey.key_id,
          bytes,
        ),
    );
    // This commit must happen before the bearer grant crosses the transport.
    return this.options.state.saveEnrollmentRequest(request);
  }

  async enroll(
    input: EnrollLocalInstallationInput,
  ): Promise<OrganizationInstallationAccessDecisionV1> {
    this.options.state.pinAuthority(
      input.authorityDescriptor,
      input.independentlyTrustedAuthorityPin,
    );
    const grantSha256 = organizationEnrollmentGrantSha256(
      input.enrollmentGrant,
    );
    const existing = this.options.state.readEnrollment();
    if (existing !== null && existing.accepted_access_sequence > 0) {
      assertExistingEnrollmentMatches(existing, input, grantSha256);
      await this.assertRemoteAuthority(input.authorityDescriptor);
      this.options.state.saveAuthorityConnection({
        authority_id: input.authorityDescriptor.authority_id,
        organization_id: input.authorityDescriptor.organization_id,
        authority_base_url: input.authorityBaseUrl,
        ...(input.authorityCaPem === undefined
          ? {}
          : { authority_ca_pem: input.authorityCaPem }),
      });
      return this.options.state.verifyCurrentAccess(this.verificationPolicy());
    }

    await this.assertRemoteAuthority(input.authorityDescriptor);
    this.options.state.saveAuthorityConnection({
      authority_id: input.authorityDescriptor.authority_id,
      organization_id: input.authorityDescriptor.organization_id,
      authority_base_url: input.authorityBaseUrl,
      ...(input.authorityCaPem === undefined
        ? {}
        : { authority_ca_pem: input.authorityCaPem }),
    });
    const request = await this.prepareRequest(input, grantSha256);
    const response = validateCompletedOrganizationEnrollment(
      await this.options.authorityClient.completeEnrollment({
        enrollmentGrant: Uint8Array.from(input.enrollmentGrant),
        enrollmentRequest: request,
      }),
    );
    this.options.state.saveEnrollmentReceipt(response.enrollment_receipt);
    const policy = this.verificationPolicy();
    if (
      response.access_state.status === 'active' &&
      Date.parse(response.access_state.valid_until) <= Date.parse(policy.now)
    ) {
      // An exact response-loss replay can return the original initial lease
      // after its validity window has closed. The enrollment receipt is the
      // durable append-only fact: record the replayed state as history at its
      // own evaluation instant, then require a fresh lease before reporting
      // access. The trusted-time watermark only moves forward from here.
      this.options.state.acceptAccessState(response.access_state, {
        ...policy,
        now: response.access_state.evaluated_at,
      });
      return await this.refreshAccess();
    }
    return this.options.state.acceptAccessState(response.access_state, policy);
  }

  async refreshAccess(): Promise<OrganizationInstallationAccessDecisionV1> {
    const enrollment = this.options.state.readEnrollment();
    if (
      enrollment === null ||
      enrollment.receipt === null ||
      enrollment.accepted_access_sha256 === null
    ) {
      throw new Error(
        'organization enrollment and access state are unavailable',
      );
    }
    const request = enrollment.request;
    const signerKey = await this.signerKey(request.installation_id, false);
    if (
      canonicalJson(signerKey) !==
      canonicalJson(request.installation_signing_key)
    ) {
      throw new Error(
        'organization installation signer no longer matches the enrollment',
      );
    }
    const requestedActiveLeaseTtlMs = this.requestedActiveLeaseTtlMs();
    const command = await createOrganizationAccessLeaseRequestV2(
      {
        request_id: this.requestIds.nextAccessLeaseRequestId(),
        authority_id: request.authority_id,
        authority_key_id: request.authority_key_id,
        organization_id: request.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: request.installation_id,
        installation_signing_key: signerKey,
        previous_access_state_sha256: enrollment.accepted_access_sha256,
        requested_active_lease_ttl_ms: requestedActiveLeaseTtlMs,
        requested_at: this.clock.now(),
      },
      (bytes) =>
        signWithInstallationKey(
          this.options.installationSigner,
          request.installation_id,
          signerKey.key_id,
          bytes,
        ),
    );

    let response: OrganizationAccessLeaseResponseV1;
    try {
      response = validateOrganizationAccessLeaseResponse(
        await this.options.authorityClient.issueAccessLease(command),
      );
    } catch (error) {
      if (
        !(error instanceof OrganizationAuthorityConflictError) ||
        error.conflict.response === null
      ) {
        throw error;
      }
      response = validateOrganizationAccessLeaseResponse(
        error.conflict.response,
      );
    }
    if (response.access_state.status === 'active') {
      const evaluatedAt = Date.parse(response.access_state.evaluated_at);
      const validUntil = Date.parse(response.access_state.valid_until);
      const receivedActiveLeaseTtlMs = validUntil - evaluatedAt;
      if (receivedActiveLeaseTtlMs > requestedActiveLeaseTtlMs) {
        throw new Error(
          'organization authority active access lease exceeds the requested TTL',
        );
      }
    }
    return this.options.state.acceptAccessState(
      response.access_state,
      this.verificationPolicy(),
    );
  }

  currentAccess(): OrganizationInstallationAccessDecisionV1 {
    return this.options.state.verifyCurrentAccess(this.verificationPolicy());
  }
}
