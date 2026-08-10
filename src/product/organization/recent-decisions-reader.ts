import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationRecentDecisionsRequest,
  validateOrganizationRecentDecisionsResponse,
  type OrganizationRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';
import type { InstallationSigner } from '../machine/security/installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import type { OrganizationStateStore } from './state/organization-state-store.js';

export interface OrganizationRecentDecisionsReaderOptions {
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
 * Performs one fresh signed permission-pilot read without retaining content.
 * The Authority is the authorization boundary; local state supplies only the
 * enrolled installation identity needed to authenticate the request.
 */
export class OrganizationRecentDecisionsReader {
  private readonly nextRequestId: () => string;

  constructor(
    private readonly options: OrganizationRecentDecisionsReaderOptions,
  ) {
    this.nextRequestId = options.nextRequestId ?? (() => `rdr_${randomUUID()}`);
  }

  async read(
    signal?: AbortSignal,
  ): Promise<OrganizationRecentDecisionsResponseV1> {
    const enrollment = this.options.state.readEnrollment();
    if (
      enrollment === null ||
      enrollment.receipt === null ||
      enrollment.accepted_access_sequence < 1
    ) {
      throw new Error(
        'organization enrollment is unavailable for recent decisions',
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
    const request = await createOrganizationRecentDecisionsRequest(
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
    return validateOrganizationRecentDecisionsResponse(
      await this.options.authorityClient.readRecentDecisions(request, signal),
    );
  }
}
