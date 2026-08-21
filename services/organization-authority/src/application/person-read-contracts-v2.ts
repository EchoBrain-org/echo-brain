import {
  canonicalJsonBytes,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';

/**
 * Private D6-1 request and caller commitments.
 *
 * This module owns no transport, authentication, persistence, scope, release,
 * audit, retention, or export behavior. The live V2 Person DTOs remain
 * transitional until the fresh-lineage D6 audit baseline can remove their
 * caller-supplied subject atomically. A future composition adapter may pass a
 * reduced current-bearer authorization view here only after the bearer has
 * been resolved against current Person, session, OIDC, and membership state.
 */

export const PERSON_REQUEST_COMMITMENT_KIND =
  'echo-person-request-commitment-v2' as const;
export const PERSON_CALLER_BINDING_KIND =
  'echo-person-caller-binding-v2' as const;

export type PersonRequestOperationV2 =
  | 'reviewer_recent_decisions'
  | 'readable_search'
  | 'list_member_exclusions'
  | 'change_member_exclusion';

export type PersonMembershipTypeV2 = 'employee' | 'owner';

export interface PersonMemberExclusionSourceSelectorV2 {
  readonly scope: 'source';
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
}

export interface PersonMemberExclusionMeetingSelectorV2 {
  readonly scope: 'meeting';
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
  readonly external_id: string;
}

export type PersonMemberExclusionSelectorV2 =
  | PersonMemberExclusionSourceSelectorV2
  | PersonMemberExclusionMeetingSelectorV2;

export interface ReviewerRecentDecisionsPersonRequestCommitmentV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_REQUEST_COMMITMENT_KIND;
  readonly operation: 'reviewer_recent_decisions';
  readonly input: Record<string, never>;
}

export interface ReadableSearchPersonRequestCommitmentV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_REQUEST_COMMITMENT_KIND;
  readonly operation: 'readable_search';
  readonly input: {
    readonly query: string;
  };
}

export interface ListMemberExclusionsPersonRequestCommitmentV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_REQUEST_COMMITMENT_KIND;
  readonly operation: 'list_member_exclusions';
  readonly input: {
    readonly source_adapter_id: string;
    readonly source_instance_id: string;
  };
}

export interface ChangeMemberExclusionPersonRequestCommitmentV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_REQUEST_COMMITMENT_KIND;
  readonly operation: 'change_member_exclusion';
  readonly input: {
    readonly excluded: boolean;
    readonly selector: PersonMemberExclusionSelectorV2;
  };
}

export type PersonRequestCommitmentV2 =
  | ReviewerRecentDecisionsPersonRequestCommitmentV2
  | ReadableSearchPersonRequestCommitmentV2
  | ListMemberExclusionsPersonRequestCommitmentV2
  | ChangeMemberExclusionPersonRequestCommitmentV2;

export interface PersonCallerBindingV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_CALLER_BINDING_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipTypeV2;
  readonly identity_binding_id: string;
  readonly session_family_id: string;
  readonly access_credential_sha256: Sha256Digest;
  readonly person_state_sha256: Sha256Digest;
  readonly session_state_sha256: Sha256Digest;
}

export interface BuildPersonCallerBindingV2Input {
  /** Server configuration plus the future fresh-state lineage manifest. */
  readonly boundary: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  };
  /** Reduced view derived only from the current bearer authorization. */
  readonly current_caller: {
    readonly organization_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: PersonMembershipTypeV2;
    readonly identity_binding_id: string;
    readonly session_family_id: string;
    readonly access_credential_sha256: Sha256Digest;
    readonly person_state_sha256: Sha256Digest;
    readonly session_state_sha256: Sha256Digest;
  };
}

export class PersonReadContractV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonReadContractV2Error';
  }
}

type UnknownRecord = Record<string, unknown>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FEDERATION_UUID =
  /^[a-z]{3}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PERSON_COMMITMENT_CANONICAL_BYTES = 16 * 1024;
const REQUEST_KEYS = ['schema_version', 'kind', 'operation', 'input'] as const;
const BUILD_REQUEST_KEYS = ['operation', 'input'] as const;
const QUERY_INPUT_KEYS = ['query'] as const;
const SOURCE_INPUT_KEYS = ['source_adapter_id', 'source_instance_id'] as const;
const CHANGE_INPUT_KEYS = ['excluded', 'selector'] as const;
const SOURCE_SELECTOR_KEYS = [
  'scope',
  'source_adapter_id',
  'source_instance_id',
] as const;
const MEETING_SELECTOR_KEYS = [...SOURCE_SELECTOR_KEYS, 'external_id'] as const;
const CALLER_BINDING_KEYS = [
  'schema_version',
  'kind',
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'principal_id',
  'membership_id',
  'membership_type',
  'identity_binding_id',
  'session_family_id',
  'access_credential_sha256',
  'person_state_sha256',
  'session_state_sha256',
] as const;
const CALLER_BOUNDARY_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
] as const;
const CURRENT_CALLER_KEYS = [
  'organization_id',
  'principal_id',
  'membership_id',
  'membership_type',
  'identity_binding_id',
  'session_family_id',
  'access_credential_sha256',
  'person_state_sha256',
  'session_state_sha256',
] as const;
const BUILD_CALLER_KEYS = ['boundary', 'current_caller'] as const;

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

function expectFederationId(
  value: unknown,
  prefix: 'mem' | 'oau' | 'oib' | 'org' | 'prn' | 'psf',
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !FEDERATION_UUID.test(value) ||
    !value.startsWith(prefix + '_')
  ) {
    invalid(label, 'must be a canonical ' + prefix + ' identifier');
  }
}

function expectUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        invalid(label, 'must contain only Unicode scalar values');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(label, 'must contain only Unicode scalar values');
    }
  }
}

function expectBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(label, 'must be bounded canonical text');
  }
  expectUnicodeScalarString(value, label);
}

function expectOpaqueExternalId(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0')
  ) {
    invalid(label, 'must be a bounded non-NUL opaque identifier');
  }
  expectUnicodeScalarString(value, label);
}

function expectMembershipType(
  value: unknown,
  label: string,
): asserts value is PersonMembershipTypeV2 {
  if (value !== 'employee' && value !== 'owner') {
    invalid(label, 'must be employee or owner');
  }
}

function freezeCanonicalDocument<T extends object>(value: T, label: string): T {
  let canonicalByteLength: number;
  try {
    canonicalByteLength = canonicalJsonBytes(value).byteLength;
  } catch {
    invalid(label, 'must be an I-JSON document');
  }
  if (canonicalByteLength > MAX_PERSON_COMMITMENT_CANONICAL_BYTES) {
    invalid(label, 'exceeds its canonical byte bound');
  }
  return Object.freeze(value) as T;
}

/** Exact retained readable-search query grammar shared with main. */
function validatedReadableSearchQuery(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.trim() !== value ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    [...value].length > 240
  ) {
    invalid(label, 'is invalid');
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        invalid(label, 'is invalid');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(label, 'is invalid');
    }
  }
  const terms = new Set<string>();
  for (const run of value.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase().normalize('NFC');
    if (canonicalJsonBytes(term).byteLength - 2 > 64) {
      invalid(label, 'contains an overlong analyzer term');
    }
    terms.add(term);
  }
  if (terms.size === 0 || terms.size > 16) {
    invalid(label, 'must produce from one through sixteen unique terms');
  }
  return value;
}

function validatedSelector(
  value: unknown,
  label: string,
): PersonMemberExclusionSelectorV2 {
  const initial = exactRecord(
    value,
    value !== null &&
      typeof value === 'object' &&
      Object.getOwnPropertyDescriptor(value, 'scope')?.value === 'meeting'
      ? MEETING_SELECTOR_KEYS
      : SOURCE_SELECTOR_KEYS,
    label,
  );
  if (initial.scope !== 'source' && initial.scope !== 'meeting') {
    invalid(label + ' scope', 'is unsupported');
  }
  expectBoundedText(
    initial.source_adapter_id,
    label + ' source_adapter_id',
    128,
  );
  expectBoundedText(
    initial.source_instance_id,
    label + ' source_instance_id',
    128,
  );
  if (initial.scope === 'meeting') {
    expectOpaqueExternalId(initial.external_id, label + ' external_id');
    return Object.freeze({
      scope: 'meeting',
      source_adapter_id: initial.source_adapter_id,
      source_instance_id: initial.source_instance_id,
      external_id: initial.external_id,
    });
  }
  return Object.freeze({
    scope: 'source',
    source_adapter_id: initial.source_adapter_id,
    source_instance_id: initial.source_instance_id,
  });
}

export function validatePersonRequestCommitmentV2(
  value: unknown,
): PersonRequestCommitmentV2 {
  const label = 'Person request commitment v2';
  const record = exactRecord(value, REQUEST_KEYS, label);
  expectLiteral(record.schema_version, 2, label + ' schema_version');
  expectLiteral(record.kind, PERSON_REQUEST_COMMITMENT_KIND, label + ' kind');

  if (record.operation === 'reviewer_recent_decisions') {
    exactRecord(record.input, [], label + ' input');
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'reviewer_recent_decisions',
        input: Object.freeze({}),
      },
      label,
    );
  }
  if (record.operation === 'readable_search') {
    const input = exactRecord(record.input, QUERY_INPUT_KEYS, label + ' input');
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'readable_search',
        input: Object.freeze({
          query: validatedReadableSearchQuery(
            input.query,
            label + ' input query',
          ),
        }),
      },
      label,
    );
  }
  if (record.operation === 'list_member_exclusions') {
    const input = exactRecord(
      record.input,
      SOURCE_INPUT_KEYS,
      label + ' input',
    );
    expectBoundedText(
      input.source_adapter_id,
      label + ' input source_adapter_id',
      128,
    );
    expectBoundedText(
      input.source_instance_id,
      label + ' input source_instance_id',
      128,
    );
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'list_member_exclusions',
        input: Object.freeze({
          source_adapter_id: input.source_adapter_id,
          source_instance_id: input.source_instance_id,
        }),
      },
      label,
    );
  }
  if (record.operation === 'change_member_exclusion') {
    const input = exactRecord(
      record.input,
      CHANGE_INPUT_KEYS,
      label + ' input',
    );
    if (typeof input.excluded !== 'boolean') {
      invalid(label + ' input excluded', 'must be boolean');
    }
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'change_member_exclusion',
        input: Object.freeze({
          excluded: input.excluded,
          selector: validatedSelector(
            input.selector,
            label + ' input selector',
          ),
        }),
      },
      label,
    );
  }
  invalid(label + ' operation', 'is unsupported');
}

export function buildPersonRequestCommitmentV2(input: {
  readonly operation: PersonRequestOperationV2;
  readonly input: unknown;
}): PersonRequestCommitmentV2 {
  const record = exactRecord(
    input,
    BUILD_REQUEST_KEYS,
    'Person request commitment v2 build input',
  );
  return validatePersonRequestCommitmentV2({
    schema_version: 2,
    kind: PERSON_REQUEST_COMMITMENT_KIND,
    operation: record.operation,
    input: record.input,
  });
}

export function personRequestCommitmentSha256V2(value: unknown): Sha256Digest {
  return canonicalSha256(
    validatePersonRequestCommitmentV2(value) as unknown as JsonValue,
  );
}

export function validatePersonCallerBindingV2(
  value: unknown,
): PersonCallerBindingV2 {
  const label = 'Person caller binding v2';
  const record = exactRecord(value, CALLER_BINDING_KEYS, label);
  expectLiteral(record.schema_version, 2, label + ' schema_version');
  expectLiteral(record.kind, PERSON_CALLER_BINDING_KIND, label + ' kind');
  expectFederationId(record.authority_id, 'oau', label + ' authority_id');
  expectFederationId(record.organization_id, 'org', label + ' organization_id');
  expectBoundedText(record.state_lineage_id, label + ' state_lineage_id', 128);
  expectFederationId(record.principal_id, 'prn', label + ' principal_id');
  expectFederationId(record.membership_id, 'mem', label + ' membership_id');
  expectMembershipType(record.membership_type, label + ' membership_type');
  expectFederationId(
    record.identity_binding_id,
    'oib',
    label + ' identity_binding_id',
  );
  expectFederationId(
    record.session_family_id,
    'psf',
    label + ' session_family_id',
  );
  expectDigest(
    record.access_credential_sha256,
    label + ' access_credential_sha256',
  );
  expectDigest(record.person_state_sha256, label + ' person_state_sha256');
  expectDigest(record.session_state_sha256, label + ' session_state_sha256');
  return freezeCanonicalDocument(
    {
      schema_version: 2,
      kind: PERSON_CALLER_BINDING_KIND,
      authority_id: record.authority_id,
      organization_id: record.organization_id,
      state_lineage_id: record.state_lineage_id,
      principal_id: record.principal_id,
      membership_id: record.membership_id,
      membership_type: record.membership_type,
      identity_binding_id: record.identity_binding_id,
      session_family_id: record.session_family_id,
      access_credential_sha256: record.access_credential_sha256,
      person_state_sha256: record.person_state_sha256,
      session_state_sha256: record.session_state_sha256,
    },
    label,
  );
}

export function buildPersonCallerBindingV2(
  value: BuildPersonCallerBindingV2Input,
): PersonCallerBindingV2 {
  const label = 'Person caller binding v2 build input';
  const input = exactRecord(value, BUILD_CALLER_KEYS, label);
  const boundary = exactRecord(
    input.boundary,
    CALLER_BOUNDARY_KEYS,
    label + ' boundary',
  );
  const caller = exactRecord(
    input.current_caller,
    CURRENT_CALLER_KEYS,
    label + ' current_caller',
  );
  expectFederationId(boundary.authority_id, 'oau', label + ' authority_id');
  expectFederationId(
    boundary.organization_id,
    'org',
    label + ' organization_id',
  );
  expectBoundedText(
    boundary.state_lineage_id,
    label + ' state_lineage_id',
    128,
  );
  expectFederationId(
    caller.organization_id,
    'org',
    label + ' caller organization_id',
  );
  if (caller.organization_id !== boundary.organization_id) {
    invalid(label, 'current caller belongs to another organization');
  }
  return validatePersonCallerBindingV2({
    schema_version: 2,
    kind: PERSON_CALLER_BINDING_KIND,
    authority_id: boundary.authority_id,
    organization_id: boundary.organization_id,
    state_lineage_id: boundary.state_lineage_id,
    principal_id: caller.principal_id,
    membership_id: caller.membership_id,
    membership_type: caller.membership_type,
    identity_binding_id: caller.identity_binding_id,
    session_family_id: caller.session_family_id,
    access_credential_sha256: caller.access_credential_sha256,
    person_state_sha256: caller.person_state_sha256,
    session_state_sha256: caller.session_state_sha256,
  });
}

export function personCallerBindingSha256V2(value: unknown): Sha256Digest {
  return canonicalSha256(
    validatePersonCallerBindingV2(value) as unknown as JsonValue,
  );
}
