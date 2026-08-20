import {
  validateOrganizationPersonMemberExclusionChangeRequest,
  type OrganizationPersonMemberExclusionChangeRequestV2,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../domain/errors.js';
import type { PersonAuthenticatedWritePort } from './person-identity-sessions.js';
import { ReadableSearchAuthorizationFence } from './readable-search-authorization-fence.js';

export interface PersonMemberExclusionServiceOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authentication: PersonAuthenticatedWritePort;
  readonly authorization_fence: ReadableSearchAuthorizationFence;
}

function unauthorized(): AuthorityOperationError {
  return new AuthorityOperationError(
    'unauthorized',
    'member exclusion authorization failed',
  );
}

/**
 * Session-authenticated desired-state valve. It exposes no list/read surface:
 * the caller names one exact source or meeting and receives only idempotent
 * success after the durable state has changed (or already matched).
 */
export class PersonMemberExclusionService {
  constructor(private readonly options: PersonMemberExclusionServiceOptions) {}

  async change(
    input: unknown,
    accessToken: string,
  ): Promise<void> {
    let request: OrganizationPersonMemberExclusionChangeRequestV2;
    try {
      request = validateOrganizationPersonMemberExclusionChangeRequest(input);
    } catch {
      throw new AuthorityOperationError(
        'invalid_request',
        'Person member exclusion request is invalid',
      );
    }
    if (
      request.authority_id !== this.options.authority_id ||
      request.organization_id !== this.options.organization_id
    ) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Person member exclusion request targets another authority',
      );
    }

    await this.options.authorization_fence.withWrite(async () => {
      this.options.authentication.withAuthenticatedWrite({
        access_token: accessToken,
        commit: (authorization, transaction) => {
          if (
            authorization.organization_id !== request.organization_id ||
            authorization.principal_id !== request.subject_principal_id
          ) {
            throw unauthorized();
          }
          const available = transaction.setMemberExclusionForOwner(
            {
              organization_id: authorization.organization_id,
              principal_id: authorization.principal_id,
              membership_id: authorization.membership_id,
              membership_type: authorization.membership_type,
              source_adapter_id: request.selector.source_adapter_id,
              source_instance_id: request.selector.source_instance_id,
            },
            request.selector,
            request.excluded,
          );
          if (!available) {
            // Source absence and cross-owner binding are intentionally opaque.
            throw unauthorized();
          }
        },
      });
    });
  }
}
