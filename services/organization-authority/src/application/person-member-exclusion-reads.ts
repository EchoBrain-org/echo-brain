import { Buffer } from 'node:buffer';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  canonicalOrganizationMemberExclusionListResponseBytes,
  validateOrganizationAdminMemberExclusionBreakGlassReadRequest,
  validateOrganizationPersonMemberExclusionListRequest,
} from '@echo-brain/organization-api';
import type {
  OrganizationAdminMemberExclusionBreakGlassReadRequestV2,
  OrganizationMemberExclusionListResponseV2,
  OrganizationPersonMemberExclusionListRequestV2,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../domain/errors.js';
import {
  canonicalPersonReadRequestSha256,
  personReadAuthenticatedEvidence,
  type PersonReadCallerBindingInput,
} from './person-read-caller-binding.js';
import {
  PersonReadUnauthorizedError,
  type PersonAccessAuthorization,
  type PersonReadAuthorizationPort,
  type PersonReadFinalDecision,
  type PersonReadStartDenyDecision,
} from './person-identity-sessions.js';
import type {
  AuthorityPersonMembershipBinding,
  AuthorityWriteTransaction,
  MemberExclusionOwnerSource,
  OrganizationAuthorityRepository,
  StoredMemberExclusionSelector,
} from './ports/authority-repository.js';
import {
  ReadableSearchAuthorizationFence,
  readableSearchFenceFailureClassification,
} from './readable-search-authorization-fence.js';

const PERSON_DENIAL_BYTES = Buffer.from(
  '{"error":{"code":"unauthorized","message":"authorization failed"}}',
  'utf8',
);
const ADMIN_TARGET_UNAVAILABLE_BYTES = Buffer.from(
  '{"error":{"code":"not_found","message":"break-glass target was not found"}}',
  'utf8',
);

export interface PreparedMemberExclusionReadResponse {
  readonly status_code: 200 | 401 | 404;
  handoff(send: (body: string) => void): void;
}

export interface PersonMemberExclusionReadServiceOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authorization: PersonReadAuthorizationPort;
  readonly repository: OrganizationAuthorityRepository;
  readonly authorization_fence: ReadableSearchAuthorizationFence;
  readonly fence_timeout_ms: number;
  readonly now: () => string;
}

type Finalized =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny' };

function prepared(
  statusCode: 200 | 401 | 404,
  body: Buffer,
  lease?: { release(): void },
): PreparedMemberExclusionReadResponse {
  let handedOff = false;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    lease?.release();
  };
  return Object.freeze({
    status_code: statusCode,
    handoff(send: (response: string) => void): void {
      if (handedOff) {
        throw new AuthorityOperationError(
          'unavailable',
          'member exclusion response was handed off more than once',
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

function personBinding(
  request: OrganizationPersonMemberExclusionListRequestV2,
  requestSha256: Sha256Digest,
): PersonReadCallerBindingInput {
  return {
    authority_id: request.authority_id,
    organization_id: request.organization_id,
    subject_principal_id: request.subject_principal_id,
    operation: 'member_exclusions',
    request_sha256: requestSha256,
  };
}

function source(
  authorization: AuthorityPersonMembershipBinding,
  request: Pick<
    OrganizationPersonMemberExclusionListRequestV2,
    'source_adapter_id' | 'source_instance_id'
  >,
): MemberExclusionOwnerSource {
  return {
    organization_id: authorization.organization_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    membership_type: authorization.membership_type,
    source_adapter_id: request.source_adapter_id,
    source_instance_id: request.source_instance_id,
  };
}

function responseBytes(
  options: Pick<
    PersonMemberExclusionReadServiceOptions,
    'authority_id' | 'organization_id'
  >,
  authorization: AuthorityPersonMembershipBinding,
  request: Pick<
    OrganizationPersonMemberExclusionListRequestV2,
    'source_adapter_id' | 'source_instance_id'
  >,
  exclusions: readonly StoredMemberExclusionSelector[],
): Buffer {
  const response: OrganizationMemberExclusionListResponseV2 = {
    schema_version: 2,
    kind: 'echo-organization-member-exclusion-list-response',
    authority_id: options.authority_id,
    organization_id: options.organization_id,
    subject_principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    source_adapter_id: request.source_adapter_id,
    source_instance_id: request.source_instance_id,
    exclusions,
  };
  return Buffer.from(
    canonicalOrganizationMemberExclusionListResponseBytes(response),
  );
}

function appendStartDenyAudit(
  transaction: AuthorityWriteTransaction,
  request: OrganizationPersonMemberExclusionListRequestV2,
  requestSha256: Sha256Digest,
  binding: PersonReadCallerBindingInput,
  decision: PersonReadStartDenyDecision,
): void {
  if (decision.authorization === null) {
    transaction.appendMemberExclusionReadAudit({
      actor_kind: 'person',
      request_sha256: requestSha256,
      response_bytes: PERSON_DENIAL_BYTES,
      result_count: 0,
      asserted_subject_principal_id: request.subject_principal_id,
      decision: 'deny',
      reason_code: 'person_or_session_inactive',
      authenticated: null,
    });
    return;
  }
  transaction.appendMemberExclusionReadAudit({
    actor_kind: 'person',
    request_sha256: requestSha256,
    response_bytes: PERSON_DENIAL_BYTES,
    result_count: 0,
    asserted_subject_principal_id: request.subject_principal_id,
    decision: 'deny',
    reason_code: 'caller_subject_mismatch',
    authenticated: personReadAuthenticatedEvidence(
      decision.authorization,
      binding,
    ),
  });
}

function appendFinalDenyAudit(
  transaction: AuthorityWriteTransaction,
  request: OrganizationPersonMemberExclusionListRequestV2,
  requestSha256: Sha256Digest,
  binding: PersonReadCallerBindingInput,
  admission: PersonAccessAuthorization,
  decision: PersonReadFinalDecision,
  override?: 'operation_not_permitted',
): void {
  transaction.appendMemberExclusionReadAudit({
    actor_kind: 'person',
    request_sha256: requestSha256,
    response_bytes: PERSON_DENIAL_BYTES,
    result_count: 0,
    asserted_subject_principal_id: request.subject_principal_id,
    decision: 'deny',
    reason_code:
      override ??
      (decision.decision === 'deny'
        ? decision.reason_code
        : 'operation_not_permitted'),
    authenticated: personReadAuthenticatedEvidence(admission, binding),
  });
}

function assertRequestAuthority(
  request: { readonly authority_id: string; readonly organization_id: string },
  options: Pick<
    PersonMemberExclusionReadServiceOptions,
    'authority_id' | 'organization_id'
  >,
): void {
  if (
    request.authority_id !== options.authority_id ||
    request.organization_id !== options.organization_id
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'member exclusion read targets another authority',
    );
  }
}

export class PersonMemberExclusionReadService {
  constructor(private readonly options: PersonMemberExclusionReadServiceOptions) {
    if (
      !Number.isSafeInteger(options.fence_timeout_ms) ||
      options.fence_timeout_ms <= 0
    ) {
      throw new TypeError(
        'member exclusion read fence timeout must be a positive safe integer',
      );
    }
  }

  async listOwn(
    input: unknown,
    accessToken: string,
  ): Promise<PreparedMemberExclusionReadResponse> {
    let request: OrganizationPersonMemberExclusionListRequestV2;
    try {
      request = validateOrganizationPersonMemberExclusionListRequest(input);
    } catch {
      throw new AuthorityOperationError(
        'invalid_request',
        'Person member exclusion list request is invalid',
      );
    }
    assertRequestAuthority(request, this.options);
    const requestSha256 = canonicalPersonReadRequestSha256(request);
    const binding = personBinding(request, requestSha256);
    let admission: PersonAccessAuthorization;
    try {
      admission = this.options.authorization.admitSelfRead({
        access_token: accessToken,
        subject_principal_id: request.subject_principal_id,
        commitStartDeny: (decision, transaction) =>
          appendStartDenyAudit(
            transaction,
            request,
            requestSha256,
            binding,
            decision,
          ),
      });
    } catch (error) {
      if (error instanceof PersonReadUnauthorizedError) {
        return prepared(401, PERSON_DENIAL_BYTES);
      }
      throw error;
    }

    const selected = this.options.repository.read((transaction) =>
      transaction.memberExclusionsForOwnerSource(source(admission, request)),
    );
    if (selected === undefined) {
      try {
        this.options.authorization.finalizeSelfRead({
          admission,
          subject_principal_id: request.subject_principal_id,
          commit: (decision, transaction): Finalized => {
            appendFinalDenyAudit(
              transaction,
              request,
              requestSha256,
              binding,
              admission,
              decision,
              decision.decision === 'allow'
                ? 'operation_not_permitted'
                : undefined,
            );
            return { kind: 'deny' };
          },
        });
      } catch (error) {
        if (!(error instanceof PersonReadUnauthorizedError)) throw error;
      }
      return prepared(401, PERSON_DENIAL_BYTES);
    }

    const selectedBytes = responseBytes(
      this.options,
      admission,
      request,
      selected,
    );
    let lease: { release(): void } | undefined;
    try {
      lease = await this.options.authorization_fence.acquireRead({
        timeout_ms: this.options.fence_timeout_ms,
      });
      const finalized = this.options.authorization.finalizeSelfRead({
        admission,
        subject_principal_id: request.subject_principal_id,
        commit: (decision, transaction): Finalized => {
          if (decision.decision === 'deny') {
            appendFinalDenyAudit(
              transaction,
              request,
              requestSha256,
              binding,
              admission,
              decision,
            );
            return { kind: 'deny' };
          }
          const finalExclusions = transaction.memberExclusionsForOwnerSource(
            source(decision.authorization, request),
          );
          if (finalExclusions === undefined) {
            appendFinalDenyAudit(
              transaction,
              request,
              requestSha256,
              binding,
              admission,
              decision,
              'operation_not_permitted',
            );
            return { kind: 'deny' };
          }
          const finalBytes = responseBytes(
            this.options,
            decision.authorization,
            request,
            finalExclusions,
          );
          if (!finalBytes.equals(selectedBytes)) {
            throw new AuthorityOperationError(
              'unavailable',
              'member exclusion state changed before final commitment',
            );
          }
          transaction.appendMemberExclusionReadAudit({
            actor_kind: 'person',
            request_sha256: requestSha256,
            response_bytes: selectedBytes,
            result_count: finalExclusions.length,
            asserted_subject_principal_id: request.subject_principal_id,
            decision: 'allow',
            reason_code: 'active_person_session',
            authenticated: personReadAuthenticatedEvidence(
              decision.authorization,
              binding,
            ),
          });
          return { kind: 'allow' };
        },
      });
      if (finalized.kind === 'deny') {
        lease.release();
        lease = undefined;
        return prepared(401, PERSON_DENIAL_BYTES);
      }
      const heldLease = lease;
      lease = undefined;
      return prepared(200, selectedBytes, heldLease);
    } catch (error) {
      lease?.release();
      if (error instanceof PersonReadUnauthorizedError) {
        return prepared(401, PERSON_DENIAL_BYTES);
      }
      if (readableSearchFenceFailureClassification(error) === 'unavailable') {
        throw new AuthorityOperationError(
          'unavailable',
          'member exclusion read fence timed out',
        );
      }
      throw error;
    }
  }

  async breakGlass(
    input: unknown,
    actorBindingSha256: Sha256Digest,
  ): Promise<PreparedMemberExclusionReadResponse> {
    let request: OrganizationAdminMemberExclusionBreakGlassReadRequestV2;
    try {
      request =
        validateOrganizationAdminMemberExclusionBreakGlassReadRequest(input);
    } catch {
      throw new AuthorityOperationError(
        'invalid_request',
        'admin member exclusion break-glass request is invalid',
      );
    }
    assertRequestAuthority(request, this.options);
    if (!/^sha256:[0-9a-f]{64}$/.test(actorBindingSha256)) {
      throw new TypeError('admin break-glass actor binding is invalid');
    }
    const requestSha256 = canonicalPersonReadRequestSha256(request);
    let lease: { release(): void } | undefined;
    try {
      lease = await this.options.authorization_fence.acquireRead({
        timeout_ms: this.options.fence_timeout_ms,
      });
      const committed = this.options.repository.writeAtLinearization(
        this.options.now,
        (transaction) => {
          const membership = transaction.membership(request.target_membership_id);
          const targetSource: MemberExclusionOwnerSource | undefined =
            membership?.status === 'active' &&
            membership.organization_id === request.organization_id &&
            membership.principal_id === request.target_principal_id
              ? {
                  organization_id: membership.organization_id,
                  principal_id: membership.principal_id,
                  membership_id: membership.membership_id,
                  membership_type: membership.membership_type,
                  source_adapter_id: request.source_adapter_id,
                  source_instance_id: request.source_instance_id,
                }
              : undefined;
          const exclusions =
            targetSource === undefined
              ? undefined
              : transaction.memberExclusionsForOwnerSource(targetSource);
          if (exclusions === undefined || membership === undefined) {
            transaction.appendMemberExclusionReadAudit({
              actor_kind: 'admin_break_glass',
              actor_binding_sha256: actorBindingSha256,
              request_sha256: requestSha256,
              response_bytes: ADMIN_TARGET_UNAVAILABLE_BYTES,
              result_count: 0,
              decision: 'deny',
              reason_code: 'break_glass_target_unavailable',
            });
            return {
              status_code: 404 as const,
              response_bytes: ADMIN_TARGET_UNAVAILABLE_BYTES,
            };
          }
          const bytes = responseBytes(
            this.options,
            {
              organization_id: membership.organization_id,
              principal_id: membership.principal_id,
              membership_id: membership.membership_id,
              membership_type: membership.membership_type,
            },
            request,
            exclusions,
          );
          transaction.appendMemberExclusionReadAudit({
            actor_kind: 'admin_break_glass',
            actor_binding_sha256: actorBindingSha256,
            request_sha256: requestSha256,
            response_bytes: bytes,
            result_count: exclusions.length,
            decision: 'allow',
            reason_code: 'break_glass_authorized',
          });
          return { status_code: 200 as const, response_bytes: bytes };
        },
      );
      if (committed.status_code === 404) {
        lease.release();
        lease = undefined;
        return prepared(404, committed.response_bytes);
      }
      const heldLease = lease;
      lease = undefined;
      return prepared(200, committed.response_bytes, heldLease);
    } catch (error) {
      lease?.release();
      if (readableSearchFenceFailureClassification(error) === 'unavailable') {
        throw new AuthorityOperationError(
          'unavailable',
          'member exclusion break-glass fence timed out',
        );
      }
      throw error;
    }
  }
}
