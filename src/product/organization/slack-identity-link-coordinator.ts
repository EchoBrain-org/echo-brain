import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationSlackLinkBeginRequest,
  createOrganizationSlackLinkCompleteRequest,
  organizationSlackLinkChallengeCodeSha256,
  validateOrganizationSlackLinkBeginResponse,
  validateOrganizationSlackLinkResult,
  type OrganizationSlackLinkBeginResponseV1,
  type OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import type { InstallationSigner } from '../machine/security/installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import type {
  OrganizationStateStore,
  StoredOrganizationEnrollment,
} from './state/organization-state-store.js';

export interface OrganizationSlackIdentityLinkCoordinatorOptions {
  state: OrganizationStateStore;
  authorityClient: OrganizationAuthorityClient;
  installationSigner: InstallationSigner;
  now: () => string;
  nextBeginRequestId?: () => string;
  nextCompleteRequestId?: () => string;
}

export interface CompleteOrganizationSlackIdentityLinkInput {
  challenge_attempt_id: string;
  challenge_message_ts: string;
  challenge_code: string;
  expected_provider_subject_id: string;
  adapter_instance_id: string;
  adapter_version: string;
}

interface EnrolledInstallation {
  enrollment: StoredOrganizationEnrollment & {
    receipt: NonNullable<StoredOrganizationEnrollment['receipt']>;
  };
  signingKey: P256SigningKeyDescriptor;
}

function protocolSigningKey(
  descriptor: Awaited<ReturnType<InstallationSigner['inspect']>>,
  installationId: string,
): P256SigningKeyDescriptor {
  if (descriptor === null) {
    throw new Error('organization installation signing key is unavailable');
  }
  verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      'organization installation signer belongs to another installation',
    );
  }
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
  };
}

export class OrganizationSlackIdentityLinkCoordinator {
  private readonly now: () => string;
  private readonly nextBeginRequestId: () => string;
  private readonly nextCompleteRequestId: () => string;

  constructor(
    private readonly options: OrganizationSlackIdentityLinkCoordinatorOptions,
  ) {
    this.now = options.now;
    this.nextBeginRequestId =
      options.nextBeginRequestId ?? (() => `slb_${randomUUID()}`);
    this.nextCompleteRequestId =
      options.nextCompleteRequestId ?? (() => `slc_${randomUUID()}`);
  }

  private async enrolledInstallation(): Promise<EnrolledInstallation> {
    const enrollment = this.options.state.readEnrollment();
    if (
      enrollment === null ||
      enrollment.receipt === null ||
      enrollment.accepted_access_sequence < 1
    ) {
      throw new Error(
        'organization enrollment is unavailable for Slack linking',
      );
    }
    const signingKey = protocolSigningKey(
      await this.options.installationSigner.inspect(
        enrollment.request.installation_id,
      ),
      enrollment.request.installation_id,
    );
    if (
      canonicalJson(signingKey) !==
      canonicalJson(enrollment.request.installation_signing_key)
    ) {
      throw new Error(
        'organization installation signer no longer matches the enrollment',
      );
    }
    return {
      enrollment: enrollment as EnrolledInstallation['enrollment'],
      signingKey,
    };
  }

  async begin(
    challengeCode: string,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkBeginResponseV1> {
    const { enrollment, signingKey } = await this.enrolledInstallation();
    const identity = enrollment.request;
    const request = await createOrganizationSlackLinkBeginRequest(
      {
        request_id: this.nextBeginRequestId(),
        authority_id: identity.authority_id,
        authority_key_id: identity.authority_key_id,
        organization_id: identity.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: identity.installation_id,
        installation_signing_key: signingKey,
        challenge_code_sha256:
          organizationSlackLinkChallengeCodeSha256(challengeCode),
        requested_at: this.now(),
      },
      (bytes) =>
        signWithInstallationKey(
          this.options.installationSigner,
          identity.installation_id,
          signingKey.key_id,
          bytes,
        ),
    );
    return validateOrganizationSlackLinkBeginResponse(
      await this.options.authorityClient.beginSlackLink(request, signal),
    );
  }

  async complete(
    input: CompleteOrganizationSlackIdentityLinkInput,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkResultV1> {
    const { enrollment, signingKey } = await this.enrolledInstallation();
    const identity = enrollment.request;
    const request = await createOrganizationSlackLinkCompleteRequest(
      {
        request_id: this.nextCompleteRequestId(),
        authority_id: identity.authority_id,
        authority_key_id: identity.authority_key_id,
        organization_id: identity.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: identity.installation_id,
        installation_signing_key: signingKey,
        challenge_attempt_id: input.challenge_attempt_id,
        challenge_message_ts: input.challenge_message_ts,
        challenge_code: input.challenge_code,
        expected_provider_subject_id: input.expected_provider_subject_id,
        adapter_id: 'slack-reactions',
        adapter_instance_id: input.adapter_instance_id,
        adapter_version: input.adapter_version,
        requested_at: this.now(),
      },
      (bytes) =>
        signWithInstallationKey(
          this.options.installationSigner,
          identity.installation_id,
          signingKey.key_id,
          bytes,
        ),
    );
    const result = validateOrganizationSlackLinkResult(
      await this.options.authorityClient.completeSlackLink(request, signal),
    );
    if (
      result.provider_subject_id !== input.expected_provider_subject_id
    ) {
      throw new Error(
        'organization authority linked a different Slack reviewer than this installation expects',
      );
    }
    return result;
  }
}
