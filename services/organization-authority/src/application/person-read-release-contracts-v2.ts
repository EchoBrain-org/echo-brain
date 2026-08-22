import { Buffer } from "node:buffer";
import {
  canonicalJsonBytes,
  canonicalSha256,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { JsonValue, Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PersonReadContractV2Error,
  personCallerBindingSha256V2,
  validatePersonCallerBindingV2,
  validatePersonRequestCommitmentV2,
} from "./person-read-contracts-v2.js";
import type {
  PersonCallerBindingV2,
  PersonRequestCommitmentV2,
} from "./person-read-contracts-v2.js";
import {
  personScopeBindingSha256V2,
  validatePersonScopeBindingV2,
} from "./person-read-scope-contracts-v2.js";
import type {
  PersonScopeBindingV2,
  PersonScopePolicyIdV2,
} from "./person-read-scope-contracts-v2.js";

/**
 * Private D6-2B release commitments.
 *
 * The caller supplies exact serialized response bytes and a result witness that
 * a future live finalizer has already re-proved. This module snapshots and
 * hashes the bytes, revalidates the complete D6-1 and D6-2A bodies, and checks
 * only the witness's closed structure and its policy/scope joins. It does not
 * fetch or prove records, content, provenance, Authority state, or ownership;
 * nor does it own a final fence, audit, persistence, transport, or release.
 */

export const PERSON_RELEASE_BINDING_KIND =
  "echo-person-release-binding-v2" as const;

export type PersonReleaseResultKindV2 = "retrieval" | "authority_state";

export interface PersonRetrievalReleaseItemV2 {
  readonly atom_id: Sha256Digest;
  readonly record_hash: Sha256Digest;
  readonly policy_id: PersonScopePolicyIdV2;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

interface PersonReleaseBindingCommonV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_RELEASE_BINDING_KIND;
  readonly caller_binding_sha256: Sha256Digest;
  readonly scope_binding_sha256: Sha256Digest;
  readonly serialized_response_sha256: Sha256Digest;
  readonly result_kind: PersonReleaseResultKindV2;
}

export interface RetrievalPersonReleaseBindingV2 extends PersonReleaseBindingCommonV2 {
  readonly result_kind: "retrieval";
  readonly returned_items: readonly PersonRetrievalReleaseItemV2[];
}

export interface AuthorityStatePersonReleaseBindingV2 extends PersonReleaseBindingCommonV2 {
  readonly result_kind: "authority_state";
}

export type PersonReleaseBindingV2 =
  RetrievalPersonReleaseBindingV2 | AuthorityStatePersonReleaseBindingV2;

/**
 * Structurally closed evidence supplied only after a future application layer
 * has re-proved the opaque result bindings against its protected source.
 */
export interface ReprovedRetrievalPersonReleaseResultV2 {
  readonly result_kind: "retrieval";
  readonly returned_items: readonly PersonRetrievalReleaseItemV2[];
}

export interface ReprovedAuthorityStatePersonReleaseResultV2 {
  readonly result_kind: "authority_state";
}

export type ReprovedPersonReleaseResultV2 =
  | ReprovedRetrievalPersonReleaseResultV2
  | ReprovedAuthorityStatePersonReleaseResultV2;

export interface PersonReleaseBindingV2Context {
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly scope: PersonScopeBindingV2;
  readonly serialized_response_bytes: Uint8Array;
  readonly result: ReprovedPersonReleaseResultV2;
}

export type BuildPersonReleaseBindingV2Input = PersonReleaseBindingV2Context;

/** Closure-owned response bytes. Every observation receives a fresh copy. */
export interface PersonSerializedResponseSnapshotV2 {
  readonly copyBytes: () => Uint8Array;
}

export interface BuiltPersonReleaseBindingV2 {
  readonly body: PersonReleaseBindingV2;
  readonly release_binding_sha256: Sha256Digest;
  readonly response_snapshot: PersonSerializedResponseSnapshotV2;
}

type UnknownRecord = Record<string, unknown>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_PERSON_RELEASE_CANONICAL_BYTES = 16 * 1024;
const MAX_RETRIEVAL_ITEMS = 10;
const CONTEXT_KEYS = [
  "request",
  "caller",
  "scope",
  "serialized_response_bytes",
  "result",
] as const;
const COMMON_RELEASE_KEYS = [
  "schema_version",
  "kind",
  "caller_binding_sha256",
  "scope_binding_sha256",
  "serialized_response_sha256",
  "result_kind",
] as const;
const RETRIEVAL_RELEASE_KEYS = [
  ...COMMON_RELEASE_KEYS,
  "returned_items",
] as const;
const RETRIEVAL_RESULT_KEYS = ["result_kind", "returned_items"] as const;
const AUTHORITY_STATE_RESULT_KEYS = ["result_kind"] as const;
const RETRIEVAL_ITEM_KEYS = [
  "atom_id",
  "record_hash",
  "policy_id",
  "content_binding_sha256",
  "provenance_binding_sha256",
] as const;
const ORGANIZATION_MEMBER_POLICY_ID =
  "organization-member-readable-person-v2" as const;
const RESTRICTED_REVIEWER_POLICY_ID = "restricted-reviewer-person-v2" as const;

function invalid(label: string, detail: string): never {
  throw new PersonReadContractV2Error(label + " " + detail);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(label, "must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid(label, "field " + key + " must be an enumerable data property");
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(label, "has an unexpected shape");
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
    invalid(label, "must be a plain array");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(label, "must not contain symbol keys");
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes("length")) {
    invalid(label, "must be a dense plain array");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid(label, "must contain only enumerable data properties");
    }
  }
  return value;
}

function discriminant(value: unknown, key: string, label: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be a plain object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    invalid(label + " " + key, "must be an enumerable data property");
  }
  return descriptor.value;
}

function expectLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) invalid(label, "must be " + String(expected));
}

function expectDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    invalid(label, "must be a lowercase SHA-256 digest");
  }
}

function freezeCanonicalDocument<T extends object>(value: T, label: string): T {
  let canonicalByteLength: number;
  try {
    canonicalByteLength = canonicalJsonBytes(value).byteLength;
  } catch {
    invalid(label, "must be an I-JSON document");
  }
  if (canonicalByteLength > MAX_PERSON_RELEASE_CANONICAL_BYTES) {
    invalid(label, "exceeds its canonical byte bound");
  }
  return Object.freeze(value) as T;
}

function snapshotResponse(
  value: unknown,
  label: string,
): {
  readonly sha256: Sha256Digest;
  readonly snapshot: PersonSerializedResponseSnapshotV2;
} {
  if (!(value instanceof Uint8Array)) {
    invalid(label, "must be exact serialized bytes");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Uint8Array.prototype &&
    !(Buffer.isBuffer(value) && prototype === Buffer.prototype)
  ) {
    invalid(label, "must be a plain byte view");
  }
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).some(
      (name) => !/^(?:0|[1-9][0-9]*)$/.test(name),
    )
  ) {
    invalid(label, "must not contain additional byte-view properties");
  }
  let retained: Buffer;
  try {
    retained = Buffer.from(value);
  } catch {
    invalid(label, "could not be snapshotted");
  }
  const snapshot = Object.freeze({
    copyBytes: (): Uint8Array => Uint8Array.from(retained),
  });
  return Object.freeze({
    sha256: sha256Digest(retained),
    snapshot,
  });
}

function validatedPolicyId(
  value: unknown,
  label: string,
): PersonScopePolicyIdV2 {
  if (
    value !== ORGANIZATION_MEMBER_POLICY_ID &&
    value !== RESTRICTED_REVIEWER_POLICY_ID
  ) {
    invalid(label, "is unsupported");
  }
  return value;
}

function validatedRetrievalItem(
  value: unknown,
  label: string,
): PersonRetrievalReleaseItemV2 {
  const record = exactRecord(value, RETRIEVAL_ITEM_KEYS, label);
  expectDigest(record.atom_id, label + " atom_id");
  expectDigest(record.record_hash, label + " record_hash");
  const policyId = validatedPolicyId(record.policy_id, label + " policy_id");
  expectDigest(
    record.content_binding_sha256,
    label + " content_binding_sha256",
  );
  expectDigest(
    record.provenance_binding_sha256,
    label + " provenance_binding_sha256",
  );
  return Object.freeze({
    atom_id: record.atom_id,
    record_hash: record.record_hash,
    policy_id: policyId,
    content_binding_sha256: record.content_binding_sha256,
    provenance_binding_sha256: record.provenance_binding_sha256,
  });
}

function validatedReturnedItems(
  value: unknown,
  scope: PersonScopeBindingV2,
  label: string,
): readonly PersonRetrievalReleaseItemV2[] {
  if (scope.scope_kind === "authority_state") {
    invalid(label, "requires a retrieval scope");
  }
  const values = exactDensePlainArray(value, label);
  if (values.length > MAX_RETRIEVAL_ITEMS) {
    invalid(label, "must contain at most ten items");
  }
  const admittedPolicies =
    scope.scope_kind === "reviewer_log"
      ? new Set<PersonScopePolicyIdV2>([RESTRICTED_REVIEWER_POLICY_ID])
      : new Set<PersonScopePolicyIdV2>(
          scope.admitted_segments.map((segment) => segment.policy_id),
        );
  const items = values.map((item, index) => {
    const validated = validatedRetrievalItem(
      item,
      label + "[" + String(index) + "]",
    );
    if (!admittedPolicies.has(validated.policy_id)) {
      invalid(
        label + "[" + String(index) + "] policy_id",
        "was not admitted by the scope",
      );
    }
    return validated;
  });
  return Object.freeze(items);
}

function sameReturnedItems(
  left: readonly PersonRetrievalReleaseItemV2[],
  right: readonly PersonRetrievalReleaseItemV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.atom_id === right[index]?.atom_id &&
        item.record_hash === right[index]?.record_hash &&
        item.policy_id === right[index]?.policy_id &&
        item.content_binding_sha256 === right[index]?.content_binding_sha256 &&
        item.provenance_binding_sha256 ===
          right[index]?.provenance_binding_sha256,
    )
  );
}

function validatedResult(
  value: unknown,
  scope: PersonScopeBindingV2,
  label: string,
): ReprovedPersonReleaseResultV2 {
  const resultKind = discriminant(value, "result_kind", label);
  if (resultKind === "retrieval") {
    if (scope.scope_kind === "authority_state") {
      invalid(label, "retrieval result requires a retrieval scope");
    }
    const record = exactRecord(value, RETRIEVAL_RESULT_KEYS, label);
    return Object.freeze({
      result_kind: "retrieval",
      returned_items: validatedReturnedItems(
        record.returned_items,
        scope,
        label + " returned_items",
      ),
    });
  }
  if (resultKind === "authority_state") {
    if (
      scope.scope_kind !== "authority_state" ||
      scope.operation !== "list_member_exclusions"
    ) {
      invalid(label, "authority_state result requires list_member_exclusions");
    }
    exactRecord(value, AUTHORITY_STATE_RESULT_KEYS, label);
    return Object.freeze({ result_kind: "authority_state" });
  }
  invalid(label + " result_kind", "is unsupported");
}

interface ValidatedContext {
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly scope: PersonScopeBindingV2;
  readonly caller_binding_sha256: Sha256Digest;
  readonly scope_binding_sha256: Sha256Digest;
  readonly serialized_response_sha256: Sha256Digest;
  readonly response_snapshot: PersonSerializedResponseSnapshotV2;
  readonly result: ReprovedPersonReleaseResultV2;
}

function validatedContext(value: unknown): ValidatedContext {
  const context = exactRecord(value, CONTEXT_KEYS, "Person release context v2");

  // Snapshot and hash before inspecting the separately injected witness. The
  // release commitment never retains caller-owned response storage.
  const serializedResponse = snapshotResponse(
    context.serialized_response_bytes,
    "Person release context v2 serialized_response_bytes",
  );
  const request = validatePersonRequestCommitmentV2(context.request);
  const caller = validatePersonCallerBindingV2(context.caller);
  const scope = validatePersonScopeBindingV2(context.scope, {
    request,
    caller,
  });
  if (
    scope.scope_kind === "authority_state" &&
    scope.operation === "change_member_exclusion"
  ) {
    invalid(
      "Person release context v2",
      "change_member_exclusion has no release binding",
    );
  }
  const result = validatedResult(
    context.result,
    scope,
    "Person release context v2 result",
  );
  return Object.freeze({
    request,
    caller,
    scope,
    caller_binding_sha256: personCallerBindingSha256V2(caller),
    scope_binding_sha256: personScopeBindingSha256V2(scope, {
      request,
      caller,
    }),
    serialized_response_sha256: serializedResponse.sha256,
    response_snapshot: serializedResponse.snapshot,
    result,
  });
}

function validateCommonReleaseFields(
  record: UnknownRecord,
  context: ValidatedContext,
  label: string,
): void {
  expectLiteral(record.schema_version, 2, label + " schema_version");
  expectLiteral(record.kind, PERSON_RELEASE_BINDING_KIND, label + " kind");
  expectLiteral(
    record.caller_binding_sha256,
    context.caller_binding_sha256,
    label + " caller_binding_sha256",
  );
  expectLiteral(
    record.scope_binding_sha256,
    context.scope_binding_sha256,
    label + " scope_binding_sha256",
  );
  expectLiteral(
    record.serialized_response_sha256,
    context.serialized_response_sha256,
    label + " serialized_response_sha256",
  );
  expectLiteral(
    record.result_kind,
    context.result.result_kind,
    label + " result_kind",
  );
}

export function validatePersonReleaseBindingV2(
  value: unknown,
  contextValue: PersonReleaseBindingV2Context,
): PersonReleaseBindingV2 {
  const label = "Person release binding v2";
  const context = validatedContext(contextValue);
  const resultKind = discriminant(value, "result_kind", label);

  if (resultKind === "retrieval") {
    if (context.result.result_kind !== "retrieval") {
      invalid(label, "retrieval result does not match its witness");
    }
    const record = exactRecord(value, RETRIEVAL_RELEASE_KEYS, label);
    validateCommonReleaseFields(record, context, label);
    const returnedItems = validatedReturnedItems(
      record.returned_items,
      context.scope,
      label + " returned_items",
    );
    if (!sameReturnedItems(returnedItems, context.result.returned_items)) {
      invalid(label + " returned_items", "do not match the re-proved witness");
    }
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_RELEASE_BINDING_KIND,
        caller_binding_sha256: context.caller_binding_sha256,
        scope_binding_sha256: context.scope_binding_sha256,
        serialized_response_sha256: context.serialized_response_sha256,
        result_kind: "retrieval",
        returned_items: returnedItems,
      },
      label,
    );
  }

  if (resultKind === "authority_state") {
    if (context.result.result_kind !== "authority_state") {
      invalid(label, "authority_state result does not match its witness");
    }
    const record = exactRecord(value, COMMON_RELEASE_KEYS, label);
    validateCommonReleaseFields(record, context, label);
    return freezeCanonicalDocument(
      {
        schema_version: 2,
        kind: PERSON_RELEASE_BINDING_KIND,
        caller_binding_sha256: context.caller_binding_sha256,
        scope_binding_sha256: context.scope_binding_sha256,
        serialized_response_sha256: context.serialized_response_sha256,
        result_kind: "authority_state",
      },
      label,
    );
  }

  invalid(label + " result_kind", "is unsupported");
}

export function personReleaseBindingSha256V2(
  value: unknown,
  context: PersonReleaseBindingV2Context,
): Sha256Digest {
  return canonicalSha256(
    validatePersonReleaseBindingV2(value, context) as unknown as JsonValue,
  );
}

export function buildPersonReleaseBindingV2(
  value: BuildPersonReleaseBindingV2Input,
): BuiltPersonReleaseBindingV2 {
  const context = validatedContext(value);
  const common = {
    schema_version: 2 as const,
    kind: PERSON_RELEASE_BINDING_KIND,
    caller_binding_sha256: context.caller_binding_sha256,
    scope_binding_sha256: context.scope_binding_sha256,
    serialized_response_sha256: context.serialized_response_sha256,
    result_kind: context.result.result_kind,
  };
  const body = freezeCanonicalDocument(
    context.result.result_kind === "retrieval"
      ? {
          ...common,
          result_kind: "retrieval" as const,
          returned_items: context.result.returned_items,
        }
      : {
          ...common,
          result_kind: "authority_state" as const,
        },
    "Person release binding v2",
  );
  return Object.freeze({
    body,
    release_binding_sha256: canonicalSha256(body as unknown as JsonValue),
    response_snapshot: context.response_snapshot,
  });
}
