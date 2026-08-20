import { Buffer } from 'node:buffer';
import { validateOrganizationPersonReadableSearchRequest } from '@echo-brain/organization-api';
import type { OrganizationPersonReadableSearchRequestV2 } from '@echo-brain/organization-api';
import type {
  PersonReadAuthorizationPort,
  PersonAccessAuthorization,
  PersonReadAdmission,
} from './person-identity-sessions.js';
import { PersonReadUnauthorizedError } from './person-identity-sessions.js';
import {
  canonicalPersonReadRequestSha256,
  personReadCallerBindingSha256,
  personReadAuthenticatedEvidence,
} from './person-read-caller-binding.js';
import type { PersonReadCallerBindingInput } from './person-read-caller-binding.js';
import type { PersonReadDecisionAuditEntry } from './ports/authority-repository.js';
import {
  canonicalReadableSearchAllowResponse,
  fixedReadableSearchErrorBytes,
  ReadableSearchError,
  validateReadableSearchBinding,
  validateReadableSearchCandidates,
  validateReadableSearchFetchedAlignment,
} from './readable-search.js';
import {
  ReadableSearchAuthorizationFence,
  readableSearchFenceFailureClassification,
} from './readable-search-authorization-fence.js';
import type {
  PreparedReadableSearchResponse,
  ReadableSearchContract,
  ReadableSearchRequestOptions,
  ReadableSearchRetrievalPort,
  ReadableSearchScope,
} from './readable-search.js';

export interface PersonReadableSearchServiceOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authorization: PersonReadAuthorizationPort;
  readonly retrieval: ReadableSearchRetrievalPort;
  readonly fence: ReadableSearchAuthorizationFence;
  readonly contract: ReadableSearchContract;
  readonly fence_timeout_ms: number;
}

type Finalized =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny' };

const DENIAL_BYTES = fixedReadableSearchErrorBytes(401);

function callerBinding(
  request: OrganizationPersonReadableSearchRequestV2,
  requestSha256: `sha256:${string}`,
  boundary: Pick<
    PersonReadableSearchServiceOptions,
    'authority_id' | 'organization_id'
  >,
): PersonReadCallerBindingInput {
  return Object.freeze({
    authority_id: boundary.authority_id,
    organization_id: boundary.organization_id,
    subject_principal_id: request.subject_principal_id,
    operation: 'readable_search',
    request_sha256: requestSha256,
  });
}

function appendAudit(
  append: (entry: PersonReadDecisionAuditEntry) => unknown,
  input: {
    readonly request: OrganizationPersonReadableSearchRequestV2;
    readonly request_sha256: `sha256:${string}`;
    readonly caller_binding: PersonReadCallerBindingInput;
    readonly response_bytes: Buffer;
    readonly decision: 'allow' | 'deny';
    readonly reason_code: PersonReadDecisionAuditEntry['reason_code'];
    readonly authorization: PersonAccessAuthorization | null;
    readonly final_scope_binding_sha256?: `sha256:${string}`;
  },
): void {
  const stageOne = input.authorization === null
    ? null
    : personReadAuthenticatedEvidence(input.authorization, input.caller_binding);
  const authenticated = stageOne === null || input.final_scope_binding_sha256 === undefined
    ? stageOne
    : { ...stageOne, caller_binding_sha256: input.final_scope_binding_sha256 };
  append({
    operation: 'readable_search',
    request_sha256: input.request_sha256,
    response_bytes: input.response_bytes,
    asserted_subject_principal_id: input.request.subject_principal_id,
    decision: input.decision,
    reason_code: input.reason_code,
    authenticated,
  } as PersonReadDecisionAuditEntry);
}

function preparedWithRelease(
  body: Buffer,
  scope: ReadableSearchScope,
  lease: { release(): void },
  close: (scope: ReadableSearchScope) => void,
): PreparedReadableSearchResponse {
  let handedOff = false;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      close(scope);
    } finally {
      lease.release();
    }
  };
  return Object.freeze({
    status_code: 200,
    handoff(send: (response: string) => void): void {
      if (handedOff) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search prepared response was handed off more than once',
        );
      }
      handedOff = true;
      try {
        send(body.toString('utf8'));
      } finally {
        release();
      }
    },
  });
}

function preparedDenial(): PreparedReadableSearchResponse {
  let handedOff = false;
  return Object.freeze({
    status_code: 401,
    handoff(send: (response: string) => void): void {
      if (handedOff) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search prepared response was handed off more than once',
        );
      }
      handedOff = true;
      send(DENIAL_BYTES.toString('utf8'));
    },
  });
}

function isPersonSessionUnauthorized(error: unknown): boolean {
  return error instanceof PersonReadUnauthorizedError;
}

/** Lean V2 session-bound wrapper around the already canonical V1 retrieval. */
export class PersonReadableSearchService {
  constructor(private readonly options: PersonReadableSearchServiceOptions) {
    if (!Number.isSafeInteger(options.fence_timeout_ms) || options.fence_timeout_ms <= 0) {
      throw new TypeError('readable-search fence timeout must be a positive safe integer');
    }
  }

  async search(
    input: unknown,
    accessToken: string,
    requestOptions: ReadableSearchRequestOptions = {},
  ): Promise<PreparedReadableSearchResponse> {
    let request: OrganizationPersonReadableSearchRequestV2;
    try {
      request = validateOrganizationPersonReadableSearchRequest(input);
    } catch (cause) {
      throw new ReadableSearchError('invalid_request', 'Person readable-search request is invalid', { cause });
    }
    // The validated V2 document is canonicalized before its session binding
    // and durable decision audit are derived.
    const requestSha256 = canonicalPersonReadRequestSha256(request);
    const binding = callerBinding(request, requestSha256, this.options);
    let admission: PersonReadAdmission;
    try {
      admission = this.options.authorization.admitSelfRead({
        access_token: accessToken,
        subject_principal_id: request.subject_principal_id,
        commitStartDeny: (decision, transaction) => {
          appendAudit(
            (entry) => transaction.appendPersonReadDecisionAudit(entry),
            {
              request,
              request_sha256: requestSha256,
              caller_binding: binding,
              response_bytes: DENIAL_BYTES,
              decision: 'deny',
              reason_code: decision.reason_code,
              authorization: decision.authorization,
            },
          );
        },
      });
    } catch (error) {
      if (isPersonSessionUnauthorized(error)) return preparedDenial();
      throw error;
    }

    let scope: ReadableSearchScope | undefined;
    let closed = false;
    const close = (): void => {
      if (scope === undefined || closed) return;
      closed = true;
      this.options.retrieval.close(scope);
    };
    let lease: { release(): void } | undefined;
    const releaseResources = (): void => {
      try {
        close();
      } finally {
        if (lease !== undefined) {
          const acquired = lease;
          lease = undefined;
          acquired.release();
        }
      }
    };
    try {
      scope = await this.options.retrieval.openScope({
        kind: 'person-v2',
        request_sha256: requestSha256,
        principal_id: admission.principal_id,
        membership_id: admission.membership_id,
        membership_type: admission.membership_type,
        person_state_sha256: admission.person_state_sha256,
        caller_binding_sha256: personReadCallerBindingSha256(binding, admission),
      });
      validateReadableSearchBinding(scope.binding, this.options.contract);
      const candidates = await this.options.retrieval.search(scope, request.query);
      validateReadableSearchCandidates(candidates, scope, admission);
      const items = await this.options.retrieval.fetch(scope, candidates);
      validateReadableSearchFetchedAlignment(candidates, items);
      const response = canonicalReadableSearchAllowResponse(items);
      lease = await this.options.fence.acquireRead({
        signal: requestOptions.signal,
        timeout_ms: this.options.fence_timeout_ms,
      });
      let finalized: Finalized;
      try {
        finalized = this.options.authorization.finalizeSelfRead({
          admission,
          subject_principal_id: request.subject_principal_id,
          commit: (decision, transaction): Finalized => {
            if (decision.decision === 'deny') {
              appendAudit(
                (entry) => transaction.appendPersonReadDecisionAudit(entry),
                {
                  request, request_sha256: requestSha256, caller_binding: binding,
                  response_bytes: DENIAL_BYTES, decision: 'deny',
                  reason_code: decision.reason_code, authorization: admission,
                  final_scope_binding_sha256: scope!.scope_binding_sha256,
                },
              );
              return { kind: 'deny' };
            }
            if (
              !this.options.retrieval.finalStateStillMatches(
                scope!,
                transaction,
                candidates,
              )
            ) {
              throw new ReadableSearchError(
                'unavailable',
                'readable-search retrieval state changed before final commitment',
              );
            }
            validateReadableSearchCandidates(candidates, scope!, decision.authorization);
            appendAudit(
              (entry) => transaction.appendPersonReadDecisionAudit(entry),
              {
                request, request_sha256: requestSha256, caller_binding: binding,
                response_bytes: response.response_bytes, decision: 'allow',
                reason_code: 'active_person_session', authorization: decision.authorization,
                final_scope_binding_sha256: scope!.scope_binding_sha256,
              },
            );
            return { kind: 'allow' };
          },
        });
      } catch (error) {
        releaseResources();
        if (isPersonSessionUnauthorized(error)) return preparedDenial();
        throw error;
      }
      if (finalized.kind === 'deny') {
        releaseResources();
        return preparedDenial();
      }
      const finalScope = scope;
      return preparedWithRelease(response.response_bytes, finalScope, lease, () => close());
    } catch (error) {
      releaseResources();
      if (readableSearchFenceFailureClassification(error) === 'unavailable') {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search final fence timed out',
          { cause: error },
        );
      }
      throw error;
    }
  }
}
