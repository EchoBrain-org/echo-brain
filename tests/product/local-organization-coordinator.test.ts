import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  verifyOrganizationAccessLeaseRequest,
  type OrganizationAccessLeaseRequestV1,
} from '@echo-brain/organization-api';
import {
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationInstallationAccessState,
  type OrganizationEnrollmentReceiptV1,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessDecisionV1,
  type OrganizationInstallationAccessStateV1,
  type PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityClient } from '../../src/product/organization/client/authority-client.js';
import { OrganizationAuthorityConflictError } from '../../src/product/organization/client/authority-client.js';
import { organizationApprovalResolutionRequiresAuthority } from '../../src/product/organization/approval-action-authorizer.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import type {
  OrganizationAccessVerificationPolicy,
  OrganizationStateStore,
  StoredOrganizationEnrollment,
} from '../../src/product/organization/state/organization-state-store.js';
import {
  ACCESS_REQUEST_ID,
  descriptorClient,
  enrollmentInput,
  GRANT,
  MAX_TTL_MS,
  mutableClock,
  ORGANIZATION_IDS,
  protocolInstallationKey,
  REFRESHED_AT,
  TestAuthority,
  TestInstallationSigner,
  type MutableClock,
} from '../support/local-organization-fixtures.js';

/**
 * Protocol-faithful state-port fake for coordinator orchestration tests.
 *
 * Persistence, SQLite transactions, corruption handling, and trusted-clock
 * high-watermarks belong to organization-state-store.test.ts. This fake keeps
 * only the behavior promised by OrganizationStateStore that the coordinator
 * needs in order to orchestrate enrollment and refresh.
 */
class MemoryOrganizationStateStore implements OrganizationStateStore {
  private pinnedAuthority: PinnedOrganizationAuthority | null = null;
  private authorityBaseUrl: string | null = null;
  private authorityCaPem: string | null = null;
  private request: OrganizationEnrollmentRequestV1 | null = null;
  private receipt: OrganizationEnrollmentReceiptV1 | null = null;
  private acceptedState: OrganizationInstallationAccessStateV1 | null = null;
  private trustedTimeHighWatermark: string | null = null;

  pinAuthority(
    descriptor: unknown,
    independentlyTrustedPin: unknown,
  ): PinnedOrganizationAuthority {
    const verified = verifyOrganizationAuthorityPin(
      descriptor,
      independentlyTrustedPin,
    );
    if (
      this.pinnedAuthority !== null &&
      this.pinnedAuthority.authority_pin_sha256 !==
        verified.authority_pin_sha256
    ) {
      throw new Error('organization authority pin conflicts with local state');
    }
    this.pinnedAuthority = verified;
    return verified;
  }

  readPinnedAuthority(): PinnedOrganizationAuthority | null {
    return this.pinnedAuthority;
  }

  saveAuthorityConnection(input: {
    authority_id: string;
    organization_id: string;
    authority_base_url: string;
    authority_ca_pem?: string | null;
  }) {
    this.requirePinnedAuthority();
    if (
      this.authorityBaseUrl !== null &&
      this.authorityBaseUrl !== input.authority_base_url
    ) {
      throw new Error('organization authority origin conflicts with state');
    }
    this.authorityBaseUrl = input.authority_base_url;
    this.authorityCaPem = input.authority_ca_pem ?? null;
    return {
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      authority_base_url: input.authority_base_url,
      authority_ca_pem: this.authorityCaPem,
      configured_at: '2026-07-22T00:00:00.000Z',
    };
  }

  readAuthorityConnection() {
    if (this.pinnedAuthority === null || this.authorityBaseUrl === null) {
      return null;
    }
    return {
      authority_id: ORGANIZATION_IDS.authority,
      organization_id: ORGANIZATION_IDS.organization,
      authority_base_url: this.authorityBaseUrl,
      authority_ca_pem: this.authorityCaPem,
      configured_at: '2026-07-22T00:00:00.000Z',
    };
  }

  rebindAuthorityConnection(input: {
    authority_id: string;
    organization_id: string;
    authority_base_url: string;
    authority_ca_pem?: string | null;
  }) {
    this.requirePinnedAuthority();
    this.authorityBaseUrl = input.authority_base_url;
    this.authorityCaPem = input.authority_ca_pem ?? null;
    return {
      ...input,
      authority_ca_pem: this.authorityCaPem,
      configured_at: '2026-07-22T00:00:00.000Z',
    };
  }

  saveEnrollmentRequest(
    requestValue: unknown,
  ): OrganizationEnrollmentRequestV1 {
    const pinned = this.requirePinnedAuthority();
    const request = verifyOrganizationEnrollmentRequest(requestValue, pinned);
    if (
      this.request !== null &&
      canonicalJson(this.request) !== canonicalJson(request)
    ) {
      throw new Error('organization enrollment request conflicts with state');
    }
    this.request = structuredClone(request);
    return structuredClone(request);
  }

  saveEnrollmentReceipt(
    receiptValue: unknown,
  ): OrganizationEnrollmentReceiptV1 {
    const pinned = this.requirePinnedAuthority();
    const request = this.requireRequest();
    const receipt = verifyOrganizationEnrollmentReceipt(
      receiptValue,
      pinned,
      request,
    );
    if (
      this.receipt !== null &&
      canonicalJson(this.receipt) !== canonicalJson(receipt)
    ) {
      throw new Error('organization enrollment receipt conflicts with state');
    }
    this.receipt = structuredClone(receipt);
    return structuredClone(receipt);
  }

  readEnrollment(): StoredOrganizationEnrollment | null {
    if (this.request === null) return null;
    return {
      request: structuredClone(this.request),
      receipt: this.receipt === null ? null : structuredClone(this.receipt),
      accepted_access_sequence: this.acceptedState?.access_state_sequence ?? 0,
      accepted_access_sha256:
        this.acceptedState === null
          ? null
          : canonicalSha256(this.acceptedState),
      trusted_time_high_watermark: this.trustedTimeHighWatermark,
    };
  }

  abandonPendingEnrollment(): boolean {
    if (this.request === null || this.receipt !== null) return false;
    this.request = null;
    return true;
  }

  acceptAccessState(
    stateValue: unknown,
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1 {
    const decision = verifyOrganizationInstallationAccessState({
      state: stateValue,
      pinned_authority: this.requirePinnedAuthority(),
      enrollment_request: this.requireRequest(),
      enrollment_receipt: this.requireReceipt(),
      now: policy.now,
      maximum_active_ttl_ms: policy.maximum_active_ttl_ms,
      ...(policy.allowed_clock_skew_ms === undefined
        ? {}
        : { allowed_clock_skew_ms: policy.allowed_clock_skew_ms }),
      previous_state: this.acceptedState,
    });
    this.acceptedState = structuredClone(decision.state);
    this.trustedTimeHighWatermark = policy.now;
    return structuredClone(decision);
  }

  verifyCurrentAccess(
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1 {
    const state = this.acceptedState;
    if (state === null) {
      throw new Error('verified organization access state is unavailable');
    }
    return verifyOrganizationInstallationAccessState({
      state,
      pinned_authority: this.requirePinnedAuthority(),
      enrollment_request: this.requireRequest(),
      enrollment_receipt: this.requireReceipt(),
      now: policy.now,
      maximum_active_ttl_ms: policy.maximum_active_ttl_ms,
      ...(policy.allowed_clock_skew_ms === undefined
        ? {}
        : { allowed_clock_skew_ms: policy.allowed_clock_skew_ms }),
      previous_state: state,
    });
  }

  close(): void {}

  private requirePinnedAuthority(): PinnedOrganizationAuthority {
    if (this.pinnedAuthority === null) {
      throw new Error('organization authority is not pinned');
    }
    return this.pinnedAuthority;
  }

  private requireRequest(): OrganizationEnrollmentRequestV1 {
    if (this.request === null) {
      throw new Error('organization enrollment request is unavailable');
    }
    return this.request;
  }

  private requireReceipt(): OrganizationEnrollmentReceiptV1 {
    if (this.receipt === null) {
      throw new Error('organization enrollment receipt is unavailable');
    }
    return this.receipt;
  }
}

function coordinator(
  state: OrganizationStateStore,
  authorityClient: OrganizationAuthorityClient,
  installationSigner: TestInstallationSigner,
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

describe('local organization coordinator', () => {
  it('saves the exact signed request before handing the bearer grant to the client', async () => {
    const authority = new TestAuthority();
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
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
  });

  it('keeps approval centrally governed when enrollment completion response is lost', async () => {
    const authority = new TestAuthority();
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
    const client = descriptorClient(authority, {
      completeEnrollment: async ({ enrollmentRequest }) => {
        await authority.complete(enrollmentRequest);
        throw new Error('simulated response loss after Authority commit');
      },
    });

    await expect(
      coordinator(state, client, installationSigner, mutableClock()).enroll(
        enrollmentInput(authority),
      ),
    ).rejects.toThrow('simulated response loss');
    expect(state.readEnrollment()).toMatchObject({ receipt: null });
    expect(
      organizationApprovalResolutionRequiresAuthority(state),
    ).toBe(true);
  });

  it('refuses a mismatched remote descriptor before signing or sending the grant', async () => {
    const authority = new TestAuthority();
    const remote = new TestAuthority(2);
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
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

  it('validates a non-HTTP completion before committing trust state', async () => {
    const authority = new TestAuthority();
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
    const client = descriptorClient(authority, {
      completeEnrollment: async ({ enrollmentRequest }) => ({
        ...(await authority.complete(enrollmentRequest)),
        extra: true,
      }),
    });

    await expect(
      coordinator(state, client, installationSigner, mutableClock()).enroll(
        enrollmentInput(authority),
      ),
    ).rejects.toThrow('completed enrollment response has an unexpected shape');
    expect(state.readEnrollment()?.receipt).toBeNull();
  });

  it('verifies the signed refresh command and accepts the signed next lease', async () => {
    const authority = new TestAuthority();
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
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

  it('accepts a validated current state carried by a stale-state conflict', async () => {
    const authority = new TestAuthority();
    const state = new MemoryOrganizationStateStore();
    const installationSigner = new TestInstallationSigner();
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
    const conflictClient = descriptorClient(authority, {
      issueAccessLease: async (command) => {
        postedCommand = command;
        throw new OrganizationAuthorityConflictError({
          access_state: currentState,
        });
      },
    });
    clock.value = REFRESHED_AT;

    const recovered = await coordinator(
      state,
      conflictClient,
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
    expect(postedCommand).toMatchObject({
      installation_id: ORGANIZATION_IDS.installation,
    });
  });
});
