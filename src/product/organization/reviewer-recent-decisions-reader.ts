import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationReviewerRecentDecisionsRequest,
  validateOrganizationReviewerRecentDecisionsResponse,
  type OrganizationReviewerRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';
import type { InstallationSigner } from '../machine/security/installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import type { OrganizationStateStore } from './state/organization-state-store.js';

export interface OrganizationReviewerRecentDecisionsReaderOptions {
  state: OrganizationStateStore;
  authorityClient: OrganizationAuthorityClient;
  installationSigner: InstallationSigner;
  now: () => string;
  nextRequestId?: () => string;
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

/**
 * Performs one fresh signed restricted-reviewer read. Returned decision text
 * remains request-local memory: the reader never writes a response, fact
 * binding, cursor, or reviewer authorization decision to product state.
 */
export class OrganizationReviewerRecentDecisionsReader {
  private readonly nextRequestId: () => string;

  constructor(
    private readonly options: OrganizationReviewerRecentDecisionsReaderOptions,
  ) {
    this.nextRequestId = options.nextRequestId ?? (() => `rrd_${randomUUID()}`);
  }

  async read(
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerRecentDecisionsResponseV1> {
    const enrollment = this.options.state.readEnrollment();
    if (
      enrollment === null ||
      enrollment.receipt === null ||
      enrollment.accepted_access_sequence < 1
    ) {
      throw new Error(
        'organization enrollment is unavailable for reviewer recent decisions',
      );
    }
    const identity = enrollment.request;
    const signingKey = protocolSigningKey(
      await this.options.installationSigner.inspect(identity.installation_id),
      identity.installation_id,
    );
    if (
      canonicalJson(signingKey) !==
      canonicalJson(identity.installation_signing_key)
    ) {
      throw new Error(
        'organization installation signer no longer matches the enrollment',
      );
    }
    const request = await createOrganizationReviewerRecentDecisionsRequest(
      {
        request_id: this.nextRequestId(),
        authority_id: identity.authority_id,
        authority_key_id: identity.authority_key_id,
        organization_id: identity.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: identity.installation_id,
        installation_signing_key: signingKey,
        requested_at: this.options.now(),
      },
      (bytes) =>
        signWithInstallationKey(
          this.options.installationSigner,
          identity.installation_id,
          signingKey.key_id,
          bytes,
        ),
    );
    return validateOrganizationReviewerRecentDecisionsResponse(
      await this.options.authorityClient.readReviewerRecentDecisions(
        request,
        signal,
      ),
    );
  }
}
