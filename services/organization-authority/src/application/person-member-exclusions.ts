import {
  validateOrganizationPersonMemberExclusionChangeRequest,
  type OrganizationPersonMemberExclusionChangeRequestV2,
  type OrganizationPersonMemberExclusionSelectorV2,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../domain/errors.js';
import type { PersonAccessAuthorization } from './person-identity-sessions.js';
import { ReadableSearchAuthorizationFence } from './readable-search-authorization-fence.js';

export interface PersonMemberExclusionAuthenticationPort {
  authenticateAccess(input: {
    readonly access_token: string;
  }): PersonAccessAuthorization;
}

export interface PersonMemberExclusionMutation {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly selector: OrganizationPersonMemberExclusionSelectorV2;
  readonly excluded: boolean;
}

export interface PersonMemberExclusionMutationPort {
  change(input: PersonMemberExclusionMutation): Promise<void>;
}

/** The exact source is absent, inactive, or belongs to another member. */
export class PersonMemberExclusionSourceDeniedError extends Error {
  constructor() {
    super('member exclusion source is unavailable');
    this.name = 'PersonMemberExclusionSourceDeniedError';
  }
}

export interface PersonMemberExclusionServiceOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authentication: PersonMemberExclusionAuthenticationPort;
  readonly mutations: PersonMemberExclusionMutationPort;
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
      const authorization = this.options.authentication.authenticateAccess({
        access_token: accessToken,
      });
      if (
        authorization.organization_id !== request.organization_id ||
        authorization.principal_id !== request.subject_principal_id
      ) {
        throw unauthorized();
      }
      try {
        await this.options.mutations.change({
          organization_id: authorization.organization_id,
          principal_id: authorization.principal_id,
          membership_id: authorization.membership_id,
          membership_type: authorization.membership_type,
          selector: request.selector,
          excluded: request.excluded,
        });
      } catch (error) {
        if (error instanceof PersonMemberExclusionSourceDeniedError) {
          throw unauthorized();
        }
        throw error;
      }
    });
  }
}
