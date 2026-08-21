import {
  canonicalJsonBytes,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PersonReadContractV2Error,
  personCallerBindingSha256V2,
  personRequestCommitmentSha256V2,
  validatePersonCallerBindingV2,
  validatePersonRequestCommitmentV2,
} from './person-read-contracts-v2.js';
import type {
  PersonCallerBindingV2,
  PersonRequestCommitmentV2,
  PersonRequestOperationV2,
} from './person-read-contracts-v2.js';

/**
 * Private D6-2A scope commitments.
 *
 * This module is deliberately unwired and is not exported from the Authority
 * package. It freezes only closed structural bodies and their canonical
 * digests. Every digest supplied by a future scope resolver is treated as an
 * opaque reference: this checkpoint does not materialize or reprove policy,
 * retrieval, generation, segment, record-head, source-activation, ownership,
 * or exclusion-state preimages. It owns no release, audit, persistence, SQL,
 * transport, authorization, handle-opening, or live runtime behavior.
 */

export const PERSON_SCOPE_BINDING_KIND =
  'echo-person-scope-binding-v2' as const;

const ORGANIZATION_MEMBER_POLICY_ID =
  'organization-member-readable-person-v2' as const;
const RESTRICTED_REVIEWER_POLICY_ID = 'restricted-reviewer-person-v2' as const;
const ORGANIZATION_MEMBER_POLICY_CONTRACT_SHA256 =
  'sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3' as const;
const RESTRICTED_REVIEWER_POLICY_CONTRACT_SHA256 =
  'sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043' as const;

export type PersonScopeKindV2 =
  'reviewer_log' | 'readable_search' | 'authority_state';

export type PersonScopePolicyIdV2 =
  typeof ORGANIZATION_MEMBER_POLICY_ID | typeof RESTRICTED_REVIEWER_POLICY_ID;

export interface PersonScopePolicyContractV2 {
  readonly policy_id: PersonScopePolicyIdV2;
  readonly policy_schema_version: 2;
  readonly policy_contract_sha256: Sha256Digest;
}

export interface PersonScopeRecordHeadV2 {
  readonly position: number;
  readonly record_hash: Sha256Digest | null;
}

export interface PersonScopeGenerationV2 {
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
}

export interface PersonScopeAdmittedSegmentV2 {
  readonly policy_id: PersonScopePolicyIdV2;
  readonly segment_id: Sha256Digest;
  readonly segment_manifest_sha256: Sha256Digest;
}

interface PersonScopeBindingCommonV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_SCOPE_BINDING_KIND;
  readonly scope_kind: PersonScopeKindV2;
  readonly caller_binding_sha256: Sha256Digest;
  readonly operation: PersonRequestOperationV2;
  readonly request_sha256: Sha256Digest;
}

export interface ReviewerLogPersonScopeBindingV2 extends PersonScopeBindingCommonV2 {
  readonly scope_kind: 'reviewer_log';
  readonly operation: 'reviewer_recent_decisions';
  readonly policy_contracts: readonly PersonScopePolicyContractV2[];
  readonly record_head: PersonScopeRecordHeadV2;
}

export interface ReadableSearchPersonScopeBindingV2 extends PersonScopeBindingCommonV2 {
  readonly scope_kind: 'readable_search';
  readonly operation: 'readable_search';
  readonly policy_contracts: readonly PersonScopePolicyContractV2[];
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly generation: PersonScopeGenerationV2;
  readonly record_head: PersonScopeRecordHeadV2;
  readonly admitted_segments: readonly PersonScopeAdmittedSegmentV2[];
}

export interface AuthorityStatePersonScopeBindingV2 extends PersonScopeBindingCommonV2 {
  readonly scope_kind: 'authority_state';
  readonly operation: 'list_member_exclusions' | 'change_member_exclusion';
  readonly source_activation_binding_sha256: Sha256Digest;
  readonly owned_resource_sha256: Sha256Digest;
  readonly exclusion_state_sha256: Sha256Digest;
}

export type PersonScopeBindingV2 =
  | ReviewerLogPersonScopeBindingV2
  | ReadableSearchPersonScopeBindingV2
  | AuthorityStatePersonScopeBindingV2;

export interface BuildReviewerLogPersonScopeV2 {
  readonly scope_kind: 'reviewer_log';
  readonly record_head: PersonScopeRecordHeadV2;
}

export interface BuildReadableSearchPersonScopeV2 {
  readonly scope_kind: 'readable_search';
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly generation: PersonScopeGenerationV2;
  readonly record_head: PersonScopeRecordHeadV2;
  readonly admitted_segments: readonly PersonScopeAdmittedSegmentV2[];
}

export interface BuildAuthorityStatePersonScopeV2 {
  readonly scope_kind: 'authority_state';
  readonly source_activation_binding_sha256: Sha256Digest;
  readonly owned_resource_sha256: Sha256Digest;
  readonly exclusion_state_sha256: Sha256Digest;
}

export type BuildPersonScopeV2 =
  | BuildReviewerLogPersonScopeV2
  | BuildReadableSearchPersonScopeV2
  | BuildAuthorityStatePersonScopeV2;

export interface BuildPersonScopeBindingV2Input {
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly scope: BuildPersonScopeV2;
}

export interface PersonScopeBindingV2Context {
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
}

export interface BuiltPersonScopeBindingV2 {
  readonly body: PersonScopeBindingV2;
  readonly scope_binding_sha256: Sha256Digest;
}

type UnknownRecord = Record<string, unknown>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_PERSON_SCOPE_CANONICAL_BYTES = 16 * 1024;
const CONTEXT_KEYS = ['request', 'caller'] as const;
const BUILD_KEYS = ['request', 'caller', 'scope'] as const;
const COMMON_SCOPE_KEYS = [
  'schema_version',
  'kind',
  'scope_kind',
  'caller_binding_sha256',
  'operation',
  'request_sha256',
] as const;
const REVIEWER_SCOPE_KEYS = [
  ...COMMON_SCOPE_KEYS,
  'policy_contracts',
  'record_head',
] as const;
const READABLE_SCOPE_KEYS = [
  ...COMMON_SCOPE_KEYS,
  'policy_contracts',
  'retrieval_contract_sha256',
  'generation',
  'record_head',
  'admitted_segments',
] as const;
const AUTHORITY_SCOPE_KEYS = [
  ...COMMON_SCOPE_KEYS,
  'source_activation_binding_sha256',
  'owned_resource_sha256',
  'exclusion_state_sha256',
] as const;
const BUILD_REVIEWER_SCOPE_KEYS = ['scope_kind', 'record_head'] as const;
const BUILD_READABLE_SCOPE_KEYS = [
  'scope_kind',
  'retrieval_contract_sha256',
  'generation',
  'record_head',
  'admitted_segments',
] as const;
const BUILD_AUTHORITY_SCOPE_KEYS = [
  'scope_kind',
  'source_activation_binding_sha256',
  'owned_resource_sha256',
  'exclusion_state_sha256',
] as const;
const POLICY_KEYS = [
  'policy_id',
  'policy_schema_version',
  'policy_contract_sha256',
] as const;
const RECORD_HEAD_KEYS = ['position', 'record_hash'] as const;
const GENERATION_KEYS = ['generation_id', 'manifest_sha256'] as const;
const ADMITTED_SEGMENT_KEYS = [
  'policy_id',
  'segment_id',
  'segment_manifest_sha256',
] as const;

const MEMBER_POLICY_CONTRACT = Object.freeze({
  policy_id: ORGANIZATION_MEMBER_POLICY_ID,
  policy_schema_version: 2 as const,
  policy_contract_sha256: ORGANIZATION_MEMBER_POLICY_CONTRACT_SHA256,
});
const REVIEWER_POLICY_CONTRACT = Object.freeze({
  policy_id: RESTRICTED_REVIEWER_POLICY_ID,
  policy_schema_version: 2 as const,
  policy_contract_sha256: RESTRICTED_REVIEWER_POLICY_CONTRACT_SHA256,
});
const REVIEWER_POLICY_CONTRACTS = Object.freeze([
  REVIEWER_POLICY_CONTRACT,
] as const);
const READABLE_POLICY_CONTRACTS = Object.freeze([
  MEMBER_POLICY_CONTRACT,
  REVIEWER_POLICY_CONTRACT,
] as const);

function invalid(label: string, detail: string): never {
  throw new PersonReadContractV2Error(label + ' ' + detail);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(label, 'must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, 'must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(label, 'must not contain symbol keys');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !('value' in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid(label, 'field ' + key + ' must be an enumerable data property');
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(label, 'has an unexpected shape');
  }
  return value as UnknownRecord;
}

function exactDensePlainArray(
  value: unknown,
  label: string,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    invalid(label, 'must be a plain array');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(label, 'must not contain symbol keys');
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes('length')) {
    invalid(label, 'must be a dense plain array');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid(label, 'must contain only enumerable data properties');
    }
  }
  return value;
}

function discriminant(value: unknown, key: string, label: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(label, 'must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !('value' in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    invalid(label + ' ' + key, 'must be an enumerable data property');
  }
  return descriptor.value;
}

function expectLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) invalid(label, 'must be ' + String(expected));
}

function expectDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    invalid(label, 'must be a lowercase SHA-256 digest');
  }
}

function freezeCanonicalDocument<T extends object>(value: T, label: string): T {
  let canonicalByteLength: number;
  try {
    canonicalByteLength = canonicalJsonBytes(value).byteLength;
  } catch {
    invalid(label, 'must be an I-JSON document');
  }
  if (canonicalByteLength > MAX_PERSON_SCOPE_CANONICAL_BYTES) {
    invalid(label, 'exceeds its canonical byte bound');
  }
  return Object.freeze(value) as T;
}

function validatedRecordHead(
  value: unknown,
  label: string,
): PersonScopeRecordHeadV2 {
  const record = exactRecord(value, RECORD_HEAD_KEYS, label);
  if (
    !Number.isSafeInteger(record.position) ||
    (record.position as number) < 0
  ) {
    invalid(label + ' position', 'must be a non-negative safe integer');
  }
  const position = record.position as number;
  if (position === 0) {
    if (record.record_hash !== null) {
      invalid(label + ' record_hash', 'must be null at the zero head');
    }
    return Object.freeze({ position: 0, record_hash: null });
  }
  expectDigest(record.record_hash, label + ' record_hash');
  return Object.freeze({
    position,
    record_hash: record.record_hash,
  });
}

function validatedGeneration(
  value: unknown,
  label: string,
): PersonScopeGenerationV2 {
  const record = exactRecord(value, GENERATION_KEYS, label);
  expectDigest(record.generation_id, label + ' generation_id');
  expectDigest(record.manifest_sha256, label + ' manifest_sha256');
  return Object.freeze({
    generation_id: record.generation_id,
    manifest_sha256: record.manifest_sha256,
  });
}

function validatePolicyContract(
  value: unknown,
  expected: PersonScopePolicyContractV2,
  label: string,
): void {
  const record = exactRecord(value, POLICY_KEYS, label);
  expectLiteral(record.policy_id, expected.policy_id, label + ' policy_id');
  expectLiteral(
    record.policy_schema_version,
    2,
    label + ' policy_schema_version',
  );
  expectLiteral(
    record.policy_contract_sha256,
    expected.policy_contract_sha256,
    label + ' policy_contract_sha256',
  );
}

function validatedPolicyContracts(
  value: unknown,
  scopeKind: 'reviewer_log' | 'readable_search',
  label: string,
): readonly PersonScopePolicyContractV2[] {
  const contracts = exactDensePlainArray(value, label);
  const expected =
    scopeKind === 'reviewer_log'
      ? REVIEWER_POLICY_CONTRACTS
      : READABLE_POLICY_CONTRACTS;
  if (contracts.length !== expected.length) {
    invalid(label, 'must contain the exact ordered policy contracts');
  }
  for (let index = 0; index < expected.length; index += 1) {
    validatePolicyContract(
      contracts[index],
      expected[index]!,
      label + '[' + String(index) + ']',
    );
  }
  return expected;
}

function validatedAdmittedSegment(
  value: unknown,
  expectedPolicyId: PersonScopePolicyIdV2,
  label: string,
): PersonScopeAdmittedSegmentV2 {
  const record = exactRecord(value, ADMITTED_SEGMENT_KEYS, label);
  expectLiteral(record.policy_id, expectedPolicyId, label + ' policy_id');
  expectDigest(record.segment_id, label + ' segment_id');
  expectDigest(
    record.segment_manifest_sha256,
    label + ' segment_manifest_sha256',
  );
  return Object.freeze({
    policy_id: expectedPolicyId,
    segment_id: record.segment_id,
    segment_manifest_sha256: record.segment_manifest_sha256,
  });
}

function validatedAdmittedSegments(
  value: unknown,
  label: string,
): readonly PersonScopeAdmittedSegmentV2[] {
  const segments = exactDensePlainArray(value, label);
  if (segments.length !== 1 && segments.length !== 2) {
    invalid(
      label,
      'must contain the member segment and optional reviewer segment',
    );
  }
  const member = validatedAdmittedSegment(
    segments[0],
    ORGANIZATION_MEMBER_POLICY_ID,
    label + '[0]',
  );
  if (segments.length === 1) {
    return Object.freeze([member]);
  }
  const reviewer = validatedAdmittedSegment(
    segments[1],
    RESTRICTED_REVIEWER_POLICY_ID,
    label + '[1]',
  );
  if (reviewer.segment_id === member.segment_id) {
    invalid(label, 'must not repeat a segment_id');
  }
  return Object.freeze([member, reviewer]);
}

function validatedContext(value: unknown): {
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly request_sha256: Sha256Digest;
  readonly caller_binding_sha256: Sha256Digest;
} {
  const context = exactRecord(value, CONTEXT_KEYS, 'Person scope context v2');
  const request = validatePersonRequestCommitmentV2(context.request);
  const caller = validatePersonCallerBindingV2(context.caller);
  return {
    request,
    caller,
    request_sha256: personRequestCommitmentSha256V2(request),
    caller_binding_sha256: personCallerBindingSha256V2(caller),
  };
}

function validateCommonScopeFields(
  record: UnknownRecord,
  expectedScopeKind: PersonScopeKindV2,
  context: ReturnType<typeof validatedContext>,
  label: string,
): void {
  expectLiteral(record.schema_version, 2, label + ' schema_version');
  expectLiteral(record.kind, PERSON_SCOPE_BINDING_KIND, label + ' kind');
  expectLiteral(record.scope_kind, expectedScopeKind, label + ' scope_kind');
  expectLiteral(
    record.caller_binding_sha256,
    context.caller_binding_sha256,
    label + ' caller_binding_sha256',
  );
  expectLiteral(
    record.operation,
    context.request.operation,
    label + ' operation',
  );
  expectLiteral(
    record.request_sha256,
    context.request_sha256,
    label + ' request_sha256',
  );
}

export function validatePersonScopeBindingV2(
  value: unknown,
  contextValue: PersonScopeBindingV2Context,
): PersonScopeBindingV2 {
  const label = 'Person scope binding v2';
  const context = validatedContext(contextValue);
  const scopeKind = discriminant(value, 'scope_kind', label);

  if (scopeKind === 'reviewer_log') {
    const record = exactRecord(value, REVIEWER_SCOPE_KEYS, label);
    validateCommonScopeFields(record, scopeKind, context, label);
    if (context.request.operation !== 'reviewer_recent_decisions') {
      invalid(label, 'reviewer_log requires reviewer_recent_decisions');
    }
    const policyContracts = validatedPolicyContracts(
      record.policy_contracts,
      scopeKind,
      label + ' policy_contracts',
    );
    const recordHead = validatedRecordHead(
      record.record_head,
      label + ' record_head',
    );
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_SCOPE_BINDING_KIND,
        scope_kind: 'reviewer_log',
        caller_binding_sha256: context.caller_binding_sha256,
        operation: 'reviewer_recent_decisions',
        request_sha256: context.request_sha256,
        policy_contracts: policyContracts,
        record_head: recordHead,
      },
      label,
    );
  }

  if (scopeKind === 'readable_search') {
    const record = exactRecord(value, READABLE_SCOPE_KEYS, label);
    validateCommonScopeFields(record, scopeKind, context, label);
    if (context.request.operation !== 'readable_search') {
      invalid(label, 'readable_search requires readable_search');
    }
    const policyContracts = validatedPolicyContracts(
      record.policy_contracts,
      scopeKind,
      label + ' policy_contracts',
    );
    expectDigest(
      record.retrieval_contract_sha256,
      label + ' retrieval_contract_sha256',
    );
    const generation = validatedGeneration(
      record.generation,
      label + ' generation',
    );
    const recordHead = validatedRecordHead(
      record.record_head,
      label + ' record_head',
    );
    const admittedSegments = validatedAdmittedSegments(
      record.admitted_segments,
      label + ' admitted_segments',
    );
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_SCOPE_BINDING_KIND,
        scope_kind: 'readable_search',
        caller_binding_sha256: context.caller_binding_sha256,
        operation: 'readable_search',
        request_sha256: context.request_sha256,
        policy_contracts: policyContracts,
        retrieval_contract_sha256: record.retrieval_contract_sha256,
        generation,
        record_head: recordHead,
        admitted_segments: admittedSegments,
      },
      label,
    );
  }

  if (scopeKind === 'authority_state') {
    const record = exactRecord(value, AUTHORITY_SCOPE_KEYS, label);
    validateCommonScopeFields(record, scopeKind, context, label);
    if (
      context.request.operation !== 'list_member_exclusions' &&
      context.request.operation !== 'change_member_exclusion'
    ) {
      invalid(label, 'authority_state requires a member-exclusion operation');
    }
    expectDigest(
      record.source_activation_binding_sha256,
      label + ' source_activation_binding_sha256',
    );
    expectDigest(
      record.owned_resource_sha256,
      label + ' owned_resource_sha256',
    );
    expectDigest(
      record.exclusion_state_sha256,
      label + ' exclusion_state_sha256',
    );
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_SCOPE_BINDING_KIND,
        scope_kind: 'authority_state',
        caller_binding_sha256: context.caller_binding_sha256,
        operation: context.request.operation,
        request_sha256: context.request_sha256,
        source_activation_binding_sha256:
          record.source_activation_binding_sha256,
        owned_resource_sha256: record.owned_resource_sha256,
        exclusion_state_sha256: record.exclusion_state_sha256,
      },
      label,
    );
  }

  invalid(label + ' scope_kind', 'is unsupported');
}

export function personScopeBindingSha256V2(
  value: unknown,
  context: PersonScopeBindingV2Context,
): Sha256Digest {
  return canonicalSha256(
    validatePersonScopeBindingV2(value, context) as unknown as JsonValue,
  );
}

function scopeKeys(scopeKind: unknown): readonly string[] {
  if (scopeKind === 'reviewer_log') return BUILD_REVIEWER_SCOPE_KEYS;
  if (scopeKind === 'readable_search') return BUILD_READABLE_SCOPE_KEYS;
  if (scopeKind === 'authority_state') return BUILD_AUTHORITY_SCOPE_KEYS;
  invalid(
    'Person scope binding v2 build input scope scope_kind',
    'is unsupported',
  );
}

export function buildPersonScopeBindingV2(
  value: BuildPersonScopeBindingV2Input,
): BuiltPersonScopeBindingV2 {
  const label = 'Person scope binding v2 build input';
  const input = exactRecord(value, BUILD_KEYS, label);
  const request = validatePersonRequestCommitmentV2(input.request);
  const caller = validatePersonCallerBindingV2(input.caller);
  const scopeKind = discriminant(input.scope, 'scope_kind', label + ' scope');
  const scope = exactRecord(
    input.scope,
    scopeKeys(scopeKind),
    label + ' scope',
  );
  const context = { request, caller };
  const common = {
    schema_version: 2 as const,
    kind: PERSON_SCOPE_BINDING_KIND,
    scope_kind: scopeKind,
    caller_binding_sha256: personCallerBindingSha256V2(caller),
    operation: request.operation,
    request_sha256: personRequestCommitmentSha256V2(request),
  };

  let candidate: unknown;
  if (scopeKind === 'reviewer_log') {
    candidate = {
      ...common,
      scope_kind: 'reviewer_log',
      policy_contracts: REVIEWER_POLICY_CONTRACTS,
      record_head: scope.record_head,
    };
  } else if (scopeKind === 'readable_search') {
    candidate = {
      ...common,
      scope_kind: 'readable_search',
      policy_contracts: READABLE_POLICY_CONTRACTS,
      retrieval_contract_sha256: scope.retrieval_contract_sha256,
      generation: scope.generation,
      record_head: scope.record_head,
      admitted_segments: scope.admitted_segments,
    };
  } else {
    candidate = {
      ...common,
      scope_kind: 'authority_state',
      source_activation_binding_sha256: scope.source_activation_binding_sha256,
      owned_resource_sha256: scope.owned_resource_sha256,
      exclusion_state_sha256: scope.exclusion_state_sha256,
    };
  }

  const body = validatePersonScopeBindingV2(candidate, context);
  return Object.freeze({
    body,
    scope_binding_sha256: personScopeBindingSha256V2(body, context),
  });
}
