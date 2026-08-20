import {
  validateOrganizationPersonRecentDecisionsRequest,
  validateOrganizationPersonReviewerRecentDecisionsRequest,
} from '@echo-brain/organization-api';
import type {
  OrganizationPersonRecentDecisionsRequestV2,
  OrganizationPersonReviewerRecentDecisionsRequestV2,
} from '@echo-brain/organization-api';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import {
  canonicalPersonReadRequestSha256,
  personReadAuthenticatedEvidence,
  type PersonReadCallerBindingInput,
} from './person-read-caller-binding.js';
import { PersonReadUnauthorizedError } from './person-identity-sessions.js';
import type {
  PersonAccessAuthorization,
  PersonReadAuthorizationPort,
  PersonReadFinalDecision,
  PersonReadStartDenyDecision,
} from './person-identity-sessions.js';
import type {
  AuthorityWriteTransaction,
  PersonReadOperation,
} from './ports/authority-repository.js';
import {
  fixedRecentDecisionsErrorBytes,
  prepareAllowedRecentDecisionsResponse,
  OrganizationRecentDecisionsError,
  validateRecentDecisionsPilotActivation,
  type OrganizationRecentDecisionsPilotActivation,
  type OrganizationRecentDecisionsProjectedRecord,
  type PreparedOrganizationRecentDecisionsResponse,
} from './recent-decisions.js';
import {
  prepareReviewerRecentDecisionsResponse,
  preparedReviewerDenial,
  type PreparedReviewerRecentDecisionsResponse,
  type ReviewerResolvedItem,
} from './reviewer-recent-decisions.js';

export class PersonReadRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PersonReadRequestError';
  }
}

export interface PersonRecentDecisionsSource {
  load(): readonly OrganizationRecentDecisionsProjectedRecord[];
}

export interface PersonReviewerRecentDecisionsSource {
  load(input: {
    readonly request_sha256: `sha256:${string}`;
    readonly reviewer_principal_id: string;
    readonly reviewer_membership_id: string;
  }): {
    readonly items: readonly ReviewerResolvedItem[];
  };
}

export interface CreatePersonReadRecentDecisionsApplicationOptions {
  readonly descriptor: Pick<
    OrganizationAuthorityDescriptorV1,
    'authority_id' | 'organization_id'
  >;
  readonly authorization: PersonReadAuthorizationPort;
  readonly recent_decisions?: {
    readonly activation: OrganizationRecentDecisionsPilotActivation;
    readonly source: PersonRecentDecisionsSource;
  };
  readonly reviewer_recent_decisions: PersonReviewerRecentDecisionsSource;
}

export interface PersonRecentDecisionsApplication {
  recentDecisions(input: {
    readonly request: unknown;
    readonly access_token: string;
  }): PreparedOrganizationRecentDecisionsResponse;
  reviewerRecentDecisions(input: {
    readonly request: unknown;
    readonly access_token: string;
  }): PreparedReviewerRecentDecisionsResponse;
}

type ValidatedPersonReadRequest =
  | OrganizationPersonRecentDecisionsRequestV2
  | OrganizationPersonReviewerRecentDecisionsRequestV2;

function requestError(error: unknown): PersonReadRequestError {
  return new PersonReadRequestError('Person read request is invalid', {
    cause: error,
  });
}

function isPersonUnauthorized(error: unknown): boolean {
  return error instanceof PersonReadUnauthorizedError;
}

function assertRequestAuthority(
  request: OrganizationPersonRecentDecisionsRequestV2,
  descriptor: CreatePersonReadRecentDecisionsApplicationOptions['descriptor'],
): void {
  if (
    request.authority_id !== descriptor.authority_id ||
    request.organization_id !== descriptor.organization_id
  ) {
    throw new PersonReadRequestError(
      'Person read request belongs to another authority or organization',
    );
  }
}

function callerBinding(
  request: ValidatedPersonReadRequest,
  operation: PersonReadOperation,
  descriptor: CreatePersonReadRecentDecisionsApplicationOptions['descriptor'],
): PersonReadCallerBindingInput {
  return {
    authority_id: descriptor.authority_id,
    organization_id: descriptor.organization_id,
    subject_principal_id: request.subject_principal_id,
    operation,
    request_sha256: canonicalPersonReadRequestSha256(request),
  };
}

function auditStartDeny(
  transaction: AuthorityWriteTransaction,
  operation: PersonReadOperation,
  binding: PersonReadCallerBindingInput,
  responseBytes: Uint8Array,
  decision: PersonReadStartDenyDecision,
): void {
  const common = {
    operation,
    request_sha256: binding.request_sha256,
    response_bytes: responseBytes,
    asserted_subject_principal_id: binding.subject_principal_id,
  } as const;
  if (decision.authorization === null) {
    transaction.appendPersonReadDecisionAudit({
      ...common,
      decision: 'deny',
      reason_code: 'person_or_session_inactive',
      authenticated: null,
    });
    return;
  }
  transaction.appendPersonReadDecisionAudit({
    ...common,
    decision: 'deny',
    reason_code: 'caller_subject_mismatch',
    authenticated: personReadAuthenticatedEvidence(
      decision.authorization,
      binding,
    ),
  });
}

function auditFinal(
  transaction: AuthorityWriteTransaction,
  operation: PersonReadOperation,
  binding: PersonReadCallerBindingInput,
  responseBytes: Uint8Array,
  admission: PersonAccessAuthorization,
  decision: PersonReadFinalDecision,
  override?: 'operation_not_permitted',
): void {
  const authorization =
    decision.decision === 'allow' ? decision.authorization : admission;
  const authenticated = personReadAuthenticatedEvidence(
    authorization,
    binding,
  );
  const common = {
    operation,
    request_sha256: binding.request_sha256,
    response_bytes: responseBytes,
    asserted_subject_principal_id: binding.subject_principal_id,
    authenticated,
  } as const;
  if (decision.decision === 'allow') {
    if (override === 'operation_not_permitted') {
      transaction.appendPersonReadDecisionAudit({
        ...common,
        decision: 'deny',
        reason_code: 'operation_not_permitted',
      });
      return;
    }
    transaction.appendPersonReadDecisionAudit({
      ...common,
      decision: 'allow',
      reason_code: 'active_person_session',
    });
    return;
  }
  transaction.appendPersonReadDecisionAudit({
    ...common,
    decision: 'deny',
    reason_code: decision.reason_code,
  });
}

/**
 * Minimum V2 Person-facing pair. It deliberately shares only the V1 response
 * builders and record sources; V1 request authentication remains untouched.
 */
export function createPersonReadRecentDecisionsApplication(
  options: CreatePersonReadRecentDecisionsApplicationOptions,
): PersonRecentDecisionsApplication {
  const { authorization } = options;

  return {
    recentDecisions(input) {
      const recentDecisions = options.recent_decisions;
      if (recentDecisions === undefined) {
        throw new OrganizationRecentDecisionsError(
          'unavailable',
          'recent decisions permission pilot is unavailable',
        );
      }
      const activation = validateRecentDecisionsPilotActivation(
        recentDecisions.activation,
      );
      if (activation.organization_id !== options.descriptor.organization_id) {
        throw new OrganizationRecentDecisionsError(
          'unavailable',
          'permission pilot activation belongs to another organization',
        );
      }
      let request: OrganizationPersonRecentDecisionsRequestV2;
      try {
        request = validateOrganizationPersonRecentDecisionsRequest(input.request);
      } catch (error) {
        throw requestError(error);
      }
      assertRequestAuthority(request, options.descriptor);
      const binding = callerBinding(
        request,
        'recent_decisions',
        options.descriptor,
      );
      const unauthorized = (): PreparedOrganizationRecentDecisionsResponse => ({
        status_code: 401,
        body: fixedRecentDecisionsErrorBytes(401),
        item_references: [],
      });
      let admission;
      try {
        admission = authorization.admitSelfRead({
          access_token: input.access_token,
          subject_principal_id: request.subject_principal_id,
          commitStartDeny: (decision, transaction) =>
            auditStartDeny(
              transaction,
              'recent_decisions',
              binding,
              unauthorized().body,
              decision,
            ),
        });
      } catch (error) {
        if (isPersonUnauthorized(error)) return unauthorized();
        throw error;
      }
      const permitted = activation.membership_ids.includes(
        admission.membership_id,
      );
      const prepared = permitted
        ? prepareAllowedRecentDecisionsResponse(recentDecisions.source.load())
        : {
            status_code: 404 as const,
            body: fixedRecentDecisionsErrorBytes(404),
            item_references: [],
          };
      try {
        return authorization.finalizeSelfRead({
          admission,
          subject_principal_id: request.subject_principal_id,
          commit: (decision, transaction) => {
            const result = decision.decision === 'allow' && permitted
              ? prepared
              : decision.decision === 'allow'
                ? ({
                    status_code: 404 as const,
                    body: fixedRecentDecisionsErrorBytes(404),
                    item_references: [],
                  })
                : unauthorized();
            auditFinal(
              transaction,
              'recent_decisions',
              binding,
              result.body,
              admission,
              decision,
              !permitted && decision.decision === 'allow'
                ? 'operation_not_permitted'
                : undefined,
            );
            return result;
          },
        });
      } catch (error) {
        if (isPersonUnauthorized(error)) return unauthorized();
        throw error;
      }
    },

    reviewerRecentDecisions(input) {
      let request: OrganizationPersonReviewerRecentDecisionsRequestV2;
      try {
        request = validateOrganizationPersonReviewerRecentDecisionsRequest(
          input.request,
        );
      } catch (error) {
        throw requestError(error);
      }
      const binding = callerBinding(
        request,
        'reviewer_recent_decisions',
        options.descriptor,
      );
      const unauthorized = (): PreparedReviewerRecentDecisionsResponse =>
        preparedReviewerDenial(401);
      let admission;
      try {
        admission = authorization.admitSelfRead({
          access_token: input.access_token,
          subject_principal_id: request.subject_principal_id,
          commitStartDeny: (decision, transaction) =>
            auditStartDeny(
              transaction,
              'reviewer_recent_decisions',
              binding,
              unauthorized().body,
              decision,
            ),
        });
      } catch (error) {
        if (isPersonUnauthorized(error)) return unauthorized();
        throw error;
      }
      const selected = options.reviewer_recent_decisions.load({
        request_sha256: binding.request_sha256,
        reviewer_principal_id: admission.principal_id,
        reviewer_membership_id: admission.membership_id,
      });
      const prepared = prepareReviewerRecentDecisionsResponse(selected.items);
      try {
        return authorization.finalizeSelfRead({
          admission,
          subject_principal_id: request.subject_principal_id,
          commit: (decision, transaction) => {
            const result = decision.decision === 'allow' ? prepared : unauthorized();
            auditFinal(
              transaction,
              'reviewer_recent_decisions',
              binding,
              result.body,
              admission,
              decision,
            );
            return result;
          },
        });
      } catch (error) {
        if (isPersonUnauthorized(error)) return unauthorized();
        throw error;
      }
    },
  };
}
