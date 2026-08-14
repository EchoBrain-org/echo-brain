import { Buffer } from 'node:buffer';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS,
  ORGANIZATION_READABLE_SEARCH_CONTRACT_ID,
  RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS,
  validateOrganizationReadableSearchRequest,
  validateOrganizationReadableSearchResponse,
} from '@echo-brain/organization-api';
import type {
  OrganizationReadableSearchRequestV1,
  OrganizationReadableSearchResponseV1,
} from '@echo-brain/organization-api';
import {
  ReadableSearchAuthorizationFence,
  readableSearchFenceFailureClassification,
} from './readable-search-authorization-fence.js';
import type { ReadableSearchAuthorizationFenceLease } from './readable-search-authorization-fence.js';
import type {
  ReadableSearchQueryAuditEntry,
  ReadableSearchQueryAuditReasonCode,
} from './ports/authority-repository.js';

const MAX_ITEMS = 10;
const POLICY_CONTRACT_ORDER = [
  'organization-member-readable-v1',
  'restricted-reviewer-v1',
] as const;

export type ReadableSearchPolicyId = (typeof POLICY_CONTRACT_ORDER)[number];
export type ReadableSearchItemKind = 'decision' | 'action' | 'rationale';
export type ReadableSearchPreparedStatus = 200 | 401 | 404;

export type ReadableSearchRequestInput = OrganizationReadableSearchRequestV1;

export interface ReadableSearchAuthenticatedRequest {
  readonly request: OrganizationReadableSearchRequestV1;
  readonly request_sha256: Sha256Digest;
}

export interface ReadableSearchPolicyContract {
  readonly policy_id: ReadableSearchPolicyId;
  readonly policy_contract_sha256: Sha256Digest;
}

export interface ReadableSearchGenerationBinding {
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly record_head_position: number;
  readonly record_head_hash: Sha256Digest | null;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly policy_contracts: readonly [
    ReadableSearchPolicyContract,
    ReadableSearchPolicyContract,
  ];
}

export interface ReadableSearchCurrentPerson {
  readonly decision: 'eligible' | 'expired' | 'not_found';
  readonly governed_reason:
    | 'active_member_with_scoped_policy_paths'
    | 'installation_access_expired'
    | 'inactive_or_unbound_organization_membership'
    | 'inactive_or_revoked_installation_enrollment';
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly enrollment_id: string;
  readonly installation_id: string;
  /**
   * Closed authorization-relevant state only. This deliberately excludes the
   * evaluation clock, so the final transaction can distinguish an actual
   * authorization change from the expected passage of time between checks.
   */
  readonly authorization_state_sha256: Sha256Digest;
  /** Timestamped Person snapshot retained for the final decision audit. */
  readonly person_state_sha256: Sha256Digest;
}

export interface ReadableSearchCandidate {
  readonly atom_id: Sha256Digest;
  readonly record_hash: Sha256Digest;
  readonly policy_id: ReadableSearchPolicyId;
}

export interface ReadableSearchFetchedItem extends ReadableSearchCandidate {
  readonly kind: ReadableSearchItemKind;
  readonly text: string;
}

/** Opaque to this application module except for immutable, text-free binding. */
export interface ReadableSearchScope {
  readonly binding: ReadableSearchGenerationBinding;
  readonly scope_binding_sha256: Sha256Digest;
  readonly reviewer_tuple:
    | { readonly principal_id: string; readonly membership_id: string }
    | null;
  /** Final recheck of the exact selected fact headers and closed policy paths. */
  selected_policy_paths_still_match(
    selected: readonly ReadableSearchCandidate[],
  ): boolean;
}

export interface ReadableSearchRetrievalPort {
  openScope(input: {
    readonly authenticated: ReadableSearchAuthenticatedRequest;
    readonly person: ReadableSearchCurrentPerson;
  }): Promise<ReadableSearchScope> | ReadableSearchScope;
  search(
    scope: ReadableSearchScope,
    query: string,
  ): Promise<readonly ReadableSearchCandidate[]> | readonly ReadableSearchCandidate[];
  fetch(
    scope: ReadableSearchScope,
    candidates: readonly ReadableSearchCandidate[],
  ): Promise<readonly ReadableSearchFetchedItem[]> | readonly ReadableSearchFetchedItem[];
  close(scope: ReadableSearchScope): void;
}

/**
 * The Authority composition port owns authentication, current-Person lookup,
 * and the final Authority write transaction. It intentionally hands this
 * service no SQLite transaction or database handle.
 */
export interface ReadableSearchAuthorityStatePort {
  authenticate(
    input: ReadableSearchRequestInput,
  ): Promise<ReadableSearchAuthenticatedRequest> | ReadableSearchAuthenticatedRequest;
  currentPerson(
    request: ReadableSearchAuthenticatedRequest,
  ): Promise<ReadableSearchCurrentPerson> | ReadableSearchCurrentPerson;
  writeAtLinearization<T>(
    authenticated: ReadableSearchAuthenticatedRequest,
    scope: ReadableSearchScope | null,
    selected: readonly ReadableSearchCandidate[],
    operation: (input: {
      readonly person: ReadableSearchCurrentPerson;
      readonly checked_at: string;
      readonly scope_still_admitted: boolean;
      appendQueryAudit(entry: ReadableSearchQueryAuditEntry): void;
    }) => T,
  ): T;
}

export interface PreparedReadableSearchResponse {
  readonly status_code: ReadableSearchPreparedStatus;
  /**
   * Performs the one-shot transport handoff of the exact UTF-8 body committed
   * to the query audit. The private audit buffer is never exposed: JavaScript
   * strings are immutable, so a transport callback cannot alter the body after
   * audit but before `response.end`. Scope and fence cleanup runs exactly once
   * even when transport throws.
   */
  handoff(send: (body: string) => void): void;
}

interface PreparedReadableSearchDraft {
  readonly status_code: ReadableSearchPreparedStatus;
  /** Private audit/transport bytes. Never part of the public response. */
  readonly body: Buffer;
}

export type ReadableSearchErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'unavailable';

export class ReadableSearchError extends Error {
  constructor(
    readonly code: ReadableSearchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReadableSearchError';
  }
}

const DENIAL_BYTES = Object.freeze({
  unauthorized: Buffer.from(
    '{"error":{"code":"unauthorized","message":"authorization failed"}}',
    'utf8',
  ),
  not_found: Buffer.from(
    '{"error":{"code":"not_found","message":"resource was not found"}}',
    'utf8',
  ),
});

export function fixedReadableSearchErrorBytes(
  status: 401 | 404,
): Buffer {
  return status === 401 ? DENIAL_BYTES.unauthorized : DENIAL_BYTES.not_found;
}

function unavailable(message: string, cause?: unknown): never {
  throw new ReadableSearchError('unavailable', message, { cause });
}

function withHandoffRelease(
  prepared: PreparedReadableSearchDraft,
  lease: ReadableSearchAuthorizationFenceLease,
  close: (() => void) | null,
): PreparedReadableSearchResponse {
  let handedOff = false;
  return Object.freeze({
    status_code: prepared.status_code,
    handoff(send: (body: string) => void): void {
      if (handedOff) {
        unavailable('readable-search prepared response was handed off more than once');
      }
      handedOff = true;
      try {
        // The audit retains the private canonical bytes. The public primitive
        // is an immutable UTF-8 string derived once, with no JSON round trip.
        send(prepared.body.toString('utf8'));
      } finally {
        try {
          close?.();
        } finally {
          lease.release();
        }
      }
    },
  });
}

function fixedDenial(person: ReadableSearchCurrentPerson): PreparedReadableSearchDraft {
  if (person.decision === 'eligible') {
    unavailable('cannot prepare a readable-search denial for an eligible person');
  }
  return Object.freeze({
    status_code: person.decision === 'expired' ? 401 : 404,
    body: fixedReadableSearchErrorBytes(person.decision === 'expired' ? 401 : 404),
  });
}

function denialReason(person: ReadableSearchCurrentPerson): ReadableSearchQueryAuditReasonCode {
  if (person.decision === 'eligible') {
    unavailable('an eligible Person has no readable-search denial reason');
  }
  return person.governed_reason;
}

function witness(policy: ReadableSearchPolicyId): string {
  return policy === 'restricted-reviewer-v1'
    ? RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS
    : ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS;
}

function validateBinding(
  binding: ReadableSearchGenerationBinding,
  expected: ReadableSearchContract,
): void {
  if (
    binding.policy_contracts.length !== 2 ||
    binding.policy_contracts[0].policy_id !== POLICY_CONTRACT_ORDER[0] ||
    binding.policy_contracts[1].policy_id !== POLICY_CONTRACT_ORDER[1] ||
    !Number.isSafeInteger(binding.record_head_position) ||
    binding.record_head_position < 0 ||
    (binding.record_head_position === 0) !== (binding.record_head_hash === null)
  ) {
    unavailable('readable-search retrieval binding is invalid');
  }
  if (
    binding.retrieval_contract_sha256 !== expected.retrieval_contract_sha256 ||
    binding.policy_contracts[0].policy_contract_sha256 !==
      expected.policy_contracts[0].policy_contract_sha256 ||
    binding.policy_contracts[1].policy_contract_sha256 !==
      expected.policy_contracts[1].policy_contract_sha256
  ) {
    unavailable('readable-search retrieval binding has different contracts');
  }
}

function validateCandidates(
  candidates: readonly ReadableSearchCandidate[],
  scope: ReadableSearchScope,
  person: ReadableSearchCurrentPerson,
): void {
  if (candidates.length > MAX_ITEMS) {
    unavailable('readable-search candidate count exceeded the closed result bound');
  }
  for (const candidate of candidates) {
    if (!POLICY_CONTRACT_ORDER.includes(candidate.policy_id)) {
      unavailable('readable-search candidate has an unknown policy');
    }
    if (
      candidate.policy_id === 'restricted-reviewer-v1' &&
      (scope.reviewer_tuple === null ||
        scope.reviewer_tuple.principal_id !== person.principal_id ||
        scope.reviewer_tuple.membership_id !== person.membership_id)
    ) {
      unavailable('readable-search reviewer candidate is outside the exact current tuple');
    }
  }
}

function prepareAllow(
  items: readonly ReadableSearchFetchedItem[],
): PreparedReadableSearchDraft {
  if (items.length > MAX_ITEMS) unavailable('readable-search returned too many items');
  const responseItems = items.map((item) => {
    if (
      !POLICY_CONTRACT_ORDER.includes(item.policy_id) ||
      !['decision', 'action', 'rationale'].includes(item.kind) ||
      typeof item.text !== 'string'
    ) {
      unavailable('readable-search fetched item is invalid');
    }
    return {
      kind: item.kind,
      text: item.text,
      policy_id: item.policy_id,
      witness: witness(item.policy_id),
    };
  });
  let response: OrganizationReadableSearchResponseV1;
  try {
    response = validateOrganizationReadableSearchResponse({
      schema_version: 1,
      contract_id: ORGANIZATION_READABLE_SEARCH_CONTRACT_ID,
      items: responseItems,
    });
  } catch (error) {
    unavailable('readable-search canonical response is invalid', error);
  }
  const body = Buffer.from(canonicalJson(response), 'utf8');
  return Object.freeze({ status_code: 200, body });
}

function validateFetchedAlignment(
  candidates: readonly ReadableSearchCandidate[],
  items: readonly ReadableSearchFetchedItem[],
): void {
  if (items.length !== candidates.length) {
    unavailable('readable-search fetched items are not aligned with candidates');
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const item = items[index];
    if (
      candidate === undefined ||
      item === undefined ||
      item.atom_id !== candidate.atom_id ||
      item.record_hash !== candidate.record_hash ||
      item.policy_id !== candidate.policy_id
    ) {
      unavailable('readable-search fetched item does not match its candidate');
    }
  }
}

function samePerson(
  initial: ReadableSearchCurrentPerson,
  final: ReadableSearchCurrentPerson,
): boolean {
  return (
    initial.decision === 'eligible' &&
    final.decision === 'eligible' &&
    initial.principal_id === final.principal_id &&
    initial.membership_id === final.membership_id &&
    initial.enrollment_id === final.enrollment_id &&
    initial.installation_id === final.installation_id &&
    initial.membership_type === final.membership_type &&
    initial.authorization_state_sha256 === final.authorization_state_sha256
  );
}

function queryAuditDetail(input: {
  readonly request: ReadableSearchAuthenticatedRequest;
  readonly person: ReadableSearchCurrentPerson;
  readonly checked_at: string;
  readonly prepared: PreparedReadableSearchDraft;
  readonly scope: ReadableSearchScope | null;
  readonly items: readonly ReadableSearchFetchedItem[];
  readonly contract: ReadableSearchContract;
}): JsonValue {
  const requester = {
    principal_id: input.person.principal_id,
    membership_id: input.person.membership_id,
    membership_type: input.person.membership_type,
    enrollment_id: input.person.enrollment_id,
    installation_id: input.person.installation_id,
  };
  const response_sha256 = sha256Digest(input.prepared.body);
  const policyContracts = (
    input.scope?.binding.policy_contracts ?? input.contract.policy_contracts
  ).map((policy) => ({
    policy_id: policy.policy_id,
    policy_contract_sha256: policy.policy_contract_sha256,
  }));
  if (input.person.decision !== 'eligible') {
    return {
      schema_version: 1,
      kind: 'readable-search-query-decision-audit-detail-v1',
      request_id: input.request.request.request_id,
      request_sha256: input.request.request_sha256,
      requester,
      decision: 'deny',
      reason_code: denialReason(input.person),
      evaluation_complete: true,
      retrieval_contract_sha256:
        input.scope?.binding.retrieval_contract_sha256 ??
        input.contract.retrieval_contract_sha256,
      policy_contracts: policyContracts,
      person_state_sha256: input.person.person_state_sha256,
      evaluated_at: input.checked_at,
      response_sha256,
    };
  }
  if (input.scope === null) unavailable('readable-search allow has no scope');
  return {
    schema_version: 1,
    kind: 'readable-search-query-decision-audit-detail-v1',
    request_id: input.request.request.request_id,
    request_sha256: input.request.request_sha256,
    requester,
    decision: 'allow',
    reason_code: 'active_member_with_scoped_policy_paths',
    evaluation_complete: true,
    retrieval_contract_sha256: input.scope.binding.retrieval_contract_sha256,
    policy_contracts: policyContracts,
    person_state_sha256: input.person.person_state_sha256,
    scope_binding_sha256: input.scope.scope_binding_sha256,
    generation: {
      generation_id: input.scope.binding.generation_id,
      manifest_sha256: input.scope.binding.manifest_sha256,
    },
    record_head: {
      position: input.scope.binding.record_head_position,
      record_hash: input.scope.binding.record_head_hash,
    },
    returned_atom_ids: input.items.map((item) => item.atom_id),
    returned_record_hashes: input.items.map((item) => item.record_hash),
    returned_policy_ids: input.items.map((item) => item.policy_id),
    evaluated_at: input.checked_at,
    response_sha256,
  };
}

/** The fixed retrieval and policy contracts are injected by composition. */
export interface ReadableSearchContract {
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly policy_contracts: readonly [
    ReadableSearchPolicyContract,
    ReadableSearchPolicyContract,
  ];
}

export interface ReadableSearchServiceOptions {
  readonly authority: ReadableSearchAuthorityStatePort;
  readonly retrieval: ReadableSearchRetrievalPort;
  readonly fence: ReadableSearchAuthorizationFence;
  readonly contract: ReadableSearchContract;
  /** Required and positive: final authorization admission may never wait forever. */
  readonly fence_timeout_ms: number;
}

export interface ReadableSearchRequestOptions {
  /** Cancels only queued final-fence admission; no audited response was committed. */
  readonly signal?: AbortSignal;
}

export class ReadableSearchService {
  private readonly options: ReadableSearchServiceOptions;

  constructor(options: ReadableSearchServiceOptions) {
    if (
      !Number.isSafeInteger(options.fence_timeout_ms) ||
      options.fence_timeout_ms <= 0
    ) {
      throw new TypeError('readable-search fence timeout must be a positive safe integer');
    }
    this.options = options;
  }

  async search(
    input: ReadableSearchRequestInput,
    requestOptions: ReadableSearchRequestOptions = {},
  ): Promise<PreparedReadableSearchResponse> {
    let request: OrganizationReadableSearchRequestV1;
    try {
      request = JSON.parse(
        canonicalJson(validateOrganizationReadableSearchRequest(input)),
      ) as OrganizationReadableSearchRequestV1;
    } catch (error) {
      throw new ReadableSearchError(
        'invalid_request',
        'readable-search request is invalid',
        { cause: error },
      );
    }
    let authenticated: ReadableSearchAuthenticatedRequest;
    try {
      authenticated = await this.options.authority.authenticate(request);
    } catch (error) {
      if (error instanceof ReadableSearchError) throw error;
      unavailable('readable-search authentication is unavailable', error);
    }
    let initial: ReadableSearchCurrentPerson;
    try {
      initial = await this.options.authority.currentPerson(authenticated);
    } catch (error) {
      unavailable('readable-search current Person lookup is unavailable', error);
    }
    if (initial.decision !== 'eligible') {
      return await this.finalizeDenial(authenticated, requestOptions.signal);
    }

    let scope: ReadableSearchScope | undefined;
    let candidates: readonly ReadableSearchCandidate[] = [];
    let items: readonly ReadableSearchFetchedItem[] = [];
    let prepared: PreparedReadableSearchDraft;
    try {
      scope = await this.options.retrieval.openScope({ authenticated, person: initial });
      validateBinding(scope.binding, this.options.contract);
      candidates = await this.options.retrieval.search(scope, authenticated.request.query);
      validateCandidates(candidates, scope, initial);
      items = await this.options.retrieval.fetch(scope, candidates);
      validateFetchedAlignment(candidates, items);
      prepared = prepareAllow(items);
    } catch (error) {
      if (scope !== undefined) {
        try {
          this.options.retrieval.close(scope);
        } catch (closeError) {
          unavailable('readable-search retrieval scope close is unavailable', closeError);
        }
        scope = undefined;
      }
      if (error instanceof ReadableSearchError) throw error;
      unavailable('readable-search retrieval is unavailable', error);
    }
    if (scope === undefined || prepared === undefined) {
      return unavailable('readable-search retrieval did not produce a result');
    }
    return await this.finalizeAllow(
      authenticated,
      initial,
      scope,
      candidates,
      items,
      prepared,
      requestOptions.signal,
    );
  }

  private async finalizeDenial(
    authenticated: ReadableSearchAuthenticatedRequest,
    signal?: AbortSignal,
  ): Promise<PreparedReadableSearchResponse> {
    try {
      const lease = await this.options.fence.acquireRead({
        signal,
        timeout_ms: this.options.fence_timeout_ms,
      });
      try {
        const prepared = this.options.authority.writeAtLinearization(authenticated, null, [], (finalized) => {
            if (finalized.person.decision === 'eligible') {
              unavailable('readable-search Person state changed before denial commit');
            }
            const prepared = fixedDenial(finalized.person);
            finalized.appendQueryAudit({
              decision: 'deny',
              reason_code: denialReason(finalized.person),
              detail: queryAuditDetail({
                request: authenticated,
                person: finalized.person,
                checked_at: finalized.checked_at,
                prepared,
                scope: null,
                items: [],
                contract: this.options.contract,
              }),
              response_bytes: prepared.body,
            });
            return prepared;
          });
        return withHandoffRelease(prepared, lease, null);
      } catch (error) {
        lease.release();
        throw error;
      }
    } catch (error) {
      if (error instanceof ReadableSearchError) throw error;
      if (readableSearchFenceFailureClassification(error) === 'unavailable') {
        unavailable('readable-search final fence timed out', error);
      }
      unavailable('readable-search denial audit commit is unavailable', error);
    }
  }

  private async finalizeAllow(
    authenticated: ReadableSearchAuthenticatedRequest,
    initial: ReadableSearchCurrentPerson,
    scope: ReadableSearchScope,
    candidates: readonly ReadableSearchCandidate[],
    items: readonly ReadableSearchFetchedItem[],
    prepared: PreparedReadableSearchDraft,
    signal?: AbortSignal,
  ): Promise<PreparedReadableSearchResponse> {
    let leaseAcquired = false;
    try {
      const lease = await this.options.fence.acquireRead({
        signal,
        timeout_ms: this.options.fence_timeout_ms,
      });
      leaseAcquired = true;
      try {
        const finalizedPrepared = this.options.authority.writeAtLinearization(authenticated, scope, candidates, (finalized) => {
            if (finalized.person.decision !== 'eligible') {
              const denial = fixedDenial(finalized.person);
              finalized.appendQueryAudit({
                decision: 'deny',
                reason_code: denialReason(finalized.person),
                detail: queryAuditDetail({
                  request: authenticated,
                  person: finalized.person,
                  checked_at: finalized.checked_at,
                  prepared: denial,
                  scope: null,
                  items: [],
                  contract: this.options.contract,
                }),
                response_bytes: denial.body,
              });
              return denial;
            }
            if (!samePerson(initial, finalized.person) || !finalized.scope_still_admitted) {
              unavailable('readable-search state changed before final commitment');
            }
            validateCandidates(
              items,
              scope,
              finalized.person,
            );
            finalized.appendQueryAudit({
              decision: 'allow',
              reason_code: 'active_member_with_scoped_policy_paths',
              detail: queryAuditDetail({
                request: authenticated,
                person: finalized.person,
                checked_at: finalized.checked_at,
                prepared,
                scope,
                items,
                contract: this.options.contract,
              }),
              response_bytes: prepared.body,
            });
            return prepared;
          });
        return withHandoffRelease(finalizedPrepared, lease, () =>
          this.options.retrieval.close(scope),
        );
      } catch (error) {
        try {
          this.options.retrieval.close(scope);
        } finally {
          lease.release();
        }
        throw error;
      }
    } catch (error) {
      if (!leaseAcquired) {
        try {
          this.options.retrieval.close(scope);
        } catch (closeError) {
          unavailable('readable-search retrieval scope close is unavailable', closeError);
        }
      }
      if (error instanceof ReadableSearchError) throw error;
      if (readableSearchFenceFailureClassification(error) === 'unavailable') {
        unavailable('readable-search final fence timed out', error);
      }
      unavailable('readable-search final audit commit is unavailable', error);
    }
  }
}
