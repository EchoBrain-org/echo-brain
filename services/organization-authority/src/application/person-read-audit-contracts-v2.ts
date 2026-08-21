import { Buffer } from "node:buffer";
import {
  assertUtcMillisecondTimestamp,
  canonicalJsonBytes,
  canonicalSha256,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { JsonValue, Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PersonReadContractV2Error,
  personCallerBindingSha256V2,
  personRequestCommitmentSha256V2,
  validatePersonCallerBindingV2,
  validatePersonRequestCommitmentV2,
} from "./person-read-contracts-v2.js";
import type {
  PersonCallerBindingV2,
  PersonRequestCommitmentV2,
  PersonRequestOperationV2,
} from "./person-read-contracts-v2.js";
import { buildPersonReleaseBindingV2 } from "./person-read-release-contracts-v2.js";
import type {
  PersonReleaseBindingV2Context,
  PersonSerializedResponseSnapshotV2,
} from "./person-read-release-contracts-v2.js";
import {
  personScopeBindingSha256V2,
  validatePersonScopeBindingV2,
} from "./person-read-scope-contracts-v2.js";
import type { PersonScopeBindingV2 } from "./person-read-scope-contracts-v2.js";

/**
 * Private D6-3 decision-audit and retention-control commitments.
 *
 * This module is deliberately unwired and is not exported from the Authority
 * package. It freezes the two append-once `{body, row_sha256}` rows and the
 * joins between them and the earlier checkpoints: every digest stored in a row
 * is recomputed here from the complete D6-1 request and caller bodies, the
 * D6-2A scope body, the D6-2B release evidence, or the exact denial bytes,
 * never trusted from its caller. It owns no SQL, persistence, transaction,
 * deletion, scheduler, final fence, route, transport, or live audit behavior,
 * and it does not freeze the unsupported-export capability.
 */

export const PERSON_READ_DECISION_AUDIT_KIND =
  "echo-person-read-decision-audit-v2" as const;
export const AUDIT_EXPIRY_CONTROL_KIND = "echo-audit-expiry-control-v1" as const;

export type PersonReadAuditDecisionV2 = "allow" | "deny";

export type PersonReadAuditReasonCodeV2 =
  | "authorized"
  | "unauthenticated"
  | "caller_context_invalid"
  | "operation_forbidden"
  | "scope_not_admitted"
  | "current_state_changed"
  | "protected_data_unavailable";

export type PersonReadAuditContextKindV2 =
  | "no_current_caller"
  | "caller_only"
  | "scoped";

export type PersonReadAuditOutcomeKindV2 =
  | "deny"
  | "retrieval_release"
  | "authority_state_release"
  | "authority_state_mutation";

export interface NoCurrentCallerPersonReadAuditContextBodyV2 {
  readonly kind: "no_current_caller";
}

export interface CallerOnlyPersonReadAuditContextBodyV2 {
  readonly kind: "caller_only";
  readonly caller_binding_sha256: Sha256Digest;
}

export interface ScopedPersonReadAuditContextBodyV2 {
  readonly kind: "scoped";
  readonly caller_binding_sha256: Sha256Digest;
  readonly scope_binding_sha256: Sha256Digest;
}

export type PersonReadAuditContextBodyV2 =
  | NoCurrentCallerPersonReadAuditContextBodyV2
  | CallerOnlyPersonReadAuditContextBodyV2
  | ScopedPersonReadAuditContextBodyV2;

/**
 * A deny binds the digest of the exact denial bytes supplied to this module,
 * recomputed from a snapshot of those bytes and never trusted from a caller,
 * and nothing else: no release binding, returned item, count, path, segment,
 * resource or source identifier, or policy-specific reason. This checkpoint
 * does not prove the bytes belong to the fixed opaque denial family; that
 * every deny writes the same fixed bytes stays a final-fence and live-parity
 * obligation, as D6-2B's re-proved result witness does.
 */
export interface DenyPersonReadAuditOutcomeV2 {
  readonly kind: "deny";
  readonly response_sha256: Sha256Digest;
}

export interface RetrievalReleasePersonReadAuditOutcomeV2 {
  readonly kind: "retrieval_release";
  readonly release_binding_sha256: Sha256Digest;
  readonly response_sha256: Sha256Digest;
}

export interface AuthorityStateReleasePersonReadAuditOutcomeV2 {
  readonly kind: "authority_state_release";
  readonly release_binding_sha256: Sha256Digest;
  readonly response_sha256: Sha256Digest;
}

export interface AuthorityStateMutationPersonReadAuditOutcomeV2 {
  readonly kind: "authority_state_mutation";
}

export type PersonReadAuditOutcomeV2 =
  | DenyPersonReadAuditOutcomeV2
  | RetrievalReleasePersonReadAuditOutcomeV2
  | AuthorityStateReleasePersonReadAuditOutcomeV2
  | AuthorityStateMutationPersonReadAuditOutcomeV2;

export interface PersonReadDecisionAuditBodyV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_READ_DECISION_AUDIT_KIND;
  readonly audit_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly operation: PersonRequestOperationV2;
  readonly request_sha256: Sha256Digest;
  readonly context: PersonReadAuditContextBodyV2;
  readonly decision: PersonReadAuditDecisionV2;
  readonly reason_code: PersonReadAuditReasonCodeV2;
  readonly outcome: PersonReadAuditOutcomeV2;
  readonly evaluated_at: string;
  readonly retain_until: string;
}

export interface PersonReadDecisionAuditRowV2 {
  readonly body: PersonReadDecisionAuditBodyV2;
  readonly row_sha256: Sha256Digest;
}

/** Server configuration plus the future fresh-state lineage manifest. */
export interface PersonReadAuditBoundaryV2 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface DenyPersonReadAuditEvidenceV2 {
  readonly kind: "deny";
  readonly denial_response_bytes: Uint8Array;
}

export interface ReleasePersonReadAuditEvidenceV2 {
  readonly kind: "release";
  readonly release: PersonReleaseBindingV2Context;
}

export interface MutationPersonReadAuditEvidenceV2 {
  readonly kind: "authority_state_mutation";
}

export type PersonReadAuditOutcomeEvidenceV2 =
  | DenyPersonReadAuditEvidenceV2
  | ReleasePersonReadAuditEvidenceV2
  | MutationPersonReadAuditEvidenceV2;

export interface NoCurrentCallerPersonReadAuditContextV2 {
  readonly stage: "no_current_caller";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly denial_response_bytes: Uint8Array;
}

export interface CallerOnlyPersonReadAuditContextV2 {
  readonly stage: "caller_only";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly denial_response_bytes: Uint8Array;
}

export interface ScopedPersonReadAuditContextV2 {
  readonly stage: "scoped";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly caller: PersonCallerBindingV2;
  readonly scope: PersonScopeBindingV2;
  readonly outcome: PersonReadAuditOutcomeEvidenceV2;
}

export type PersonReadDecisionAuditContextV2 =
  | NoCurrentCallerPersonReadAuditContextV2
  | CallerOnlyPersonReadAuditContextV2
  | ScopedPersonReadAuditContextV2;

export interface BuildPersonReadDecisionAuditRowV2Input {
  readonly audit_id: string;
  readonly decision: PersonReadAuditDecisionV2;
  readonly reason_code: PersonReadAuditReasonCodeV2;
  readonly evaluated_at: string;
  readonly context: PersonReadDecisionAuditContextV2;
}

export interface BuiltPersonReadDecisionAuditRowV2 {
  readonly row: PersonReadDecisionAuditRowV2;
  /** Present for every row that binds response bytes; null for a mutation. */
  readonly response_snapshot: PersonSerializedResponseSnapshotV2 | null;
}

export interface AuditExpiryControlBodyV1 {
  readonly schema_version: 1;
  readonly kind: typeof AUDIT_EXPIRY_CONTROL_KIND;
  readonly control_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly cutoff: string;
  readonly retention_days: 30;
  readonly expired_row_sha256s: readonly Sha256Digest[];
  readonly occurred_at: string;
}

export interface AuditExpiryControlRowV1 {
  readonly body: AuditExpiryControlBodyV1;
  readonly row_sha256: Sha256Digest;
}

export interface BuildAuditExpiryControlRowV1Input {
  readonly control_id: string;
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly expired_row_sha256s: readonly Sha256Digest[];
  readonly occurred_at: string;
}

type UnknownRecord = Record<string, unknown>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FEDERATION_UUID =
  /^[a-z]{3}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETENTION_DAYS = 30;
const RETENTION_MILLISECONDS = RETENTION_DAYS * 86_400 * 1000;
const MAX_EXPIRED_ROWS = 500;
const MAX_PERSON_AUDIT_CANONICAL_BYTES = 16 * 1024;
/**
 * The expiry control body cannot share the 16 KiB audit-row bound. Its 500
 * quoted digests are 500 x 73 = 36,500 bytes, its 499 element commas and two
 * brackets add 501, and its member name and colon add 22, so that one member is
 * 37,023 bytes. The nine remaining members are together at most 726 bytes:
 * schema_version 18, kind 37, control_id 55, authority_id 57,
 * organization_id 60, state_lineage_id 405 (a 128-unit lineage identifier is
 * at most 384 UTF-8 bytes), cutoff 35, occurred_at 40, and retention_days 19.
 * The braces and nine separators add 11, so the widest legal body is 37,760
 * bytes. 48 KiB bounds that with headroom and is an explicit per-document
 * exemption, never a raise of the audit-row bound.
 */
const MAX_AUDIT_EXPIRY_CONTROL_CANONICAL_BYTES = 48 * 1024;

const AUDIT_BODY_KEYS = [
  "schema_version",
  "kind",
  "audit_id",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "operation",
  "request_sha256",
  "context",
  "decision",
  "reason_code",
  "outcome",
  "evaluated_at",
  "retain_until",
] as const;
const ROW_KEYS = ["body", "row_sha256"] as const;
const BOUNDARY_KEYS = [
  "authority_id",
  "organization_id",
  "state_lineage_id",
] as const;
const NO_CALLER_CONTEXT_KEYS = [
  "stage",
  "boundary",
  "request",
  "denial_response_bytes",
] as const;
const CALLER_ONLY_CONTEXT_KEYS = [
  ...NO_CALLER_CONTEXT_KEYS,
  "caller",
] as const;
const SCOPED_CONTEXT_KEYS = [
  "stage",
  "boundary",
  "request",
  "caller",
  "scope",
  "outcome",
] as const;
const DENY_EVIDENCE_KEYS = ["kind", "denial_response_bytes"] as const;
const RELEASE_EVIDENCE_KEYS = ["kind", "release"] as const;
const MUTATION_EVIDENCE_KEYS = ["kind"] as const;
const RELEASE_CONTEXT_KEYS = [
  "request",
  "caller",
  "scope",
  "serialized_response_bytes",
  "result",
] as const;
const NO_CALLER_CONTEXT_BODY_KEYS = ["kind"] as const;
const CALLER_ONLY_CONTEXT_BODY_KEYS = ["kind", "caller_binding_sha256"] as const;
const SCOPED_CONTEXT_BODY_KEYS = [
  ...CALLER_ONLY_CONTEXT_BODY_KEYS,
  "scope_binding_sha256",
] as const;
const DENY_OUTCOME_KEYS = ["kind", "response_sha256"] as const;
const RELEASE_OUTCOME_KEYS = [
  "kind",
  "release_binding_sha256",
  "response_sha256",
] as const;
const MUTATION_OUTCOME_KEYS = ["kind"] as const;
const BUILD_AUDIT_ROW_KEYS = [
  "audit_id",
  "decision",
  "reason_code",
  "evaluated_at",
  "context",
] as const;
const EXPIRY_BODY_KEYS = [
  "schema_version",
  "kind",
  "control_id",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "cutoff",
  "retention_days",
  "expired_row_sha256s",
  "occurred_at",
] as const;
const BUILD_EXPIRY_ROW_KEYS = [
  "control_id",
  "boundary",
  "expired_row_sha256s",
  "occurred_at",
] as const;

const REASON_CODE_STAGE: Readonly<
  Record<PersonReadAuditReasonCodeV2, PersonReadAuditContextKindV2>
> = Object.freeze({
  authorized: "scoped",
  unauthenticated: "no_current_caller",
  caller_context_invalid: "no_current_caller",
  operation_forbidden: "caller_only",
  scope_not_admitted: "caller_only",
  current_state_changed: "scoped",
  protected_data_unavailable: "scoped",
});

const ALLOW_OUTCOME_KIND: Readonly<
  Record<PersonRequestOperationV2, PersonReadAuditOutcomeKindV2>
> = Object.freeze({
  reviewer_recent_decisions: "retrieval_release",
  readable_search: "retrieval_release",
  list_member_exclusions: "authority_state_release",
  change_member_exclusion: "authority_state_mutation",
});

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

function expectFederationId(
  value: unknown,
  prefix: "aec" | "oau" | "org" | "pra",
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !FEDERATION_UUID.test(value) ||
    !value.startsWith(prefix + "_")
  ) {
    invalid(label, "must be a canonical " + prefix + " identifier");
  }
}

function expectUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        invalid(label, "must contain only Unicode scalar values");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(label, "must contain only Unicode scalar values");
    }
  }
}

function expectBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(label, "must be bounded canonical text");
  }
  expectUnicodeScalarString(value, label);
}

/** Exact RFC-3339 UTC millisecond grammar shared with every protocol row. */
function expectTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    invalid(label, "must be a UTC millisecond timestamp");
  }
  try {
    assertUtcMillisecondTimestamp(value, label);
  } catch {
    invalid(label, "must be a UTC millisecond timestamp");
  }
}

function retentionExpiry(evaluatedAt: string, label: string): string {
  const expiry = Date.parse(evaluatedAt) + RETENTION_MILLISECONDS;
  if (!Number.isSafeInteger(expiry) || Math.abs(expiry) > 8.64e15) {
    invalid(label, "has no representable retention expiry");
  }
  const expiresAt = new Date(expiry).toISOString();
  expectTimestamp(expiresAt, label + " retention expiry");
  return expiresAt;
}

/**
 * `maximumBytes` is an explicit per-document exemption, never a global raise:
 * every audit row keeps the shared 16 KiB commitment bound.
 */
function freezeCanonicalDocument<T extends object>(
  value: T,
  label: string,
  maximumBytes: number,
): T {
  let canonicalByteLength: number;
  try {
    canonicalByteLength = canonicalJsonBytes(value).byteLength;
  } catch {
    invalid(label, "must be an I-JSON document");
  }
  if (canonicalByteLength > maximumBytes) {
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

interface ValidatedDenyOutcomeEvidence {
  readonly kind: "deny";
  readonly response_sha256: Sha256Digest;
  readonly response_snapshot: PersonSerializedResponseSnapshotV2;
}

interface ValidatedReleaseOutcomeEvidence {
  readonly kind: "retrieval_release" | "authority_state_release";
  readonly release_binding_sha256: Sha256Digest;
  readonly response_sha256: Sha256Digest;
  readonly response_snapshot: PersonSerializedResponseSnapshotV2;
}

interface ValidatedMutationOutcomeEvidence {
  readonly kind: "authority_state_mutation";
}

type ValidatedOutcomeEvidence =
  | ValidatedDenyOutcomeEvidence
  | ValidatedReleaseOutcomeEvidence
  | ValidatedMutationOutcomeEvidence;

interface ValidatedNoCurrentCallerAuditContext {
  readonly stage: "no_current_caller";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly request_sha256: Sha256Digest;
  readonly outcome: ValidatedDenyOutcomeEvidence;
}

interface ValidatedCallerOnlyAuditContext {
  readonly stage: "caller_only";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly request_sha256: Sha256Digest;
  readonly caller_binding_sha256: Sha256Digest;
  readonly outcome: ValidatedDenyOutcomeEvidence;
}

interface ValidatedScopedAuditContext {
  readonly stage: "scoped";
  readonly boundary: PersonReadAuditBoundaryV2;
  readonly request: PersonRequestCommitmentV2;
  readonly request_sha256: Sha256Digest;
  readonly caller_binding_sha256: Sha256Digest;
  readonly scope_binding_sha256: Sha256Digest;
  readonly outcome: ValidatedOutcomeEvidence;
}

type ValidatedAuditContext =
  | ValidatedNoCurrentCallerAuditContext
  | ValidatedCallerOnlyAuditContext
  | ValidatedScopedAuditContext;

function validatedBoundary(
  value: unknown,
  label: string,
): PersonReadAuditBoundaryV2 {
  const record = exactRecord(value, BOUNDARY_KEYS, label);
  expectFederationId(record.authority_id, "oau", label + " authority_id");
  expectFederationId(record.organization_id, "org", label + " organization_id");
  expectBoundedText(record.state_lineage_id, label + " state_lineage_id", 128);
  return Object.freeze({
    authority_id: record.authority_id,
    organization_id: record.organization_id,
    state_lineage_id: record.state_lineage_id,
  });
}

function joinCallerIdentity(
  caller: PersonCallerBindingV2,
  boundary: PersonReadAuditBoundaryV2,
  label: string,
): void {
  if (
    caller.authority_id !== boundary.authority_id ||
    caller.organization_id !== boundary.organization_id ||
    caller.state_lineage_id !== boundary.state_lineage_id
  ) {
    invalid(label, "does not match the current caller binding identity");
  }
}

function validatedDenyEvidence(
  value: unknown,
  label: string,
): ValidatedDenyOutcomeEvidence {
  const denial = snapshotResponse(value, label);
  return Object.freeze({
    kind: "deny" as const,
    response_sha256: denial.sha256,
    response_snapshot: denial.snapshot,
  });
}

function validatedReleaseEvidence(
  value: unknown,
  commitments: {
    readonly request_sha256: Sha256Digest;
    readonly caller_binding_sha256: Sha256Digest;
    readonly scope_binding_sha256: Sha256Digest;
  },
  label: string,
): ValidatedReleaseOutcomeEvidence {
  const release = exactRecord(value, RELEASE_CONTEXT_KEYS, label);
  const built = buildPersonReleaseBindingV2(
    release as unknown as PersonReleaseBindingV2Context,
  );
  if (personRequestCommitmentSha256V2(release.request) !== commitments.request_sha256) {
    invalid(label + " request", "does not match the audited request commitment");
  }
  if (built.body.caller_binding_sha256 !== commitments.caller_binding_sha256) {
    invalid(
      label + " caller_binding_sha256",
      "does not match the audited caller binding",
    );
  }
  if (built.body.scope_binding_sha256 !== commitments.scope_binding_sha256) {
    invalid(
      label + " scope_binding_sha256",
      "does not match the audited scope binding",
    );
  }
  return Object.freeze({
    kind:
      built.body.result_kind === "retrieval"
        ? ("retrieval_release" as const)
        : ("authority_state_release" as const),
    release_binding_sha256: built.release_binding_sha256,
    response_sha256: built.body.serialized_response_sha256,
    response_snapshot: built.response_snapshot,
  });
}

function validatedScopedDenialEvidence(
  value: unknown,
  label: string,
): ValidatedDenyOutcomeEvidence {
  const record = exactRecord(value, DENY_EVIDENCE_KEYS, label);
  return validatedDenyEvidence(
    record.denial_response_bytes,
    label + " denial_response_bytes",
  );
}

/** The deny kind is snapshotted by its caller before any other inspection. */
function validatedScopedEvidence(
  value: unknown,
  kind: unknown,
  commitments: {
    readonly request_sha256: Sha256Digest;
    readonly caller_binding_sha256: Sha256Digest;
    readonly scope_binding_sha256: Sha256Digest;
  },
  operation: PersonRequestOperationV2,
  label: string,
): ValidatedReleaseOutcomeEvidence | ValidatedMutationOutcomeEvidence {
  if (kind === "release") {
    const record = exactRecord(value, RELEASE_EVIDENCE_KEYS, label);
    return validatedReleaseEvidence(
      record.release,
      commitments,
      label + " release",
    );
  }
  if (kind === "authority_state_mutation") {
    exactRecord(value, MUTATION_EVIDENCE_KEYS, label);
    if (operation !== "change_member_exclusion") {
      invalid(label, "authority_state_mutation requires change_member_exclusion");
    }
    return Object.freeze({ kind: "authority_state_mutation" as const });
  }
  invalid(label + " kind", "is unsupported");
}

function validatedAuditContext(value: unknown): ValidatedAuditContext {
  const label = "Person read audit context v2";
  const stage = discriminant(value, "stage", label);

  if (stage === "no_current_caller") {
    const context = exactRecord(value, NO_CALLER_CONTEXT_KEYS, label);
    // Snapshot and hash the opaque denial bytes before inspecting anything the
    // caller may still own. The audit row never retains caller-owned storage.
    const outcome = validatedDenyEvidence(
      context.denial_response_bytes,
      label + " denial_response_bytes",
    );
    const boundary = validatedBoundary(context.boundary, label + " boundary");
    const request = validatePersonRequestCommitmentV2(context.request);
    return Object.freeze({
      stage: "no_current_caller" as const,
      boundary,
      request,
      request_sha256: personRequestCommitmentSha256V2(request),
      outcome,
    });
  }

  if (stage === "caller_only") {
    const context = exactRecord(value, CALLER_ONLY_CONTEXT_KEYS, label);
    const outcome = validatedDenyEvidence(
      context.denial_response_bytes,
      label + " denial_response_bytes",
    );
    const boundary = validatedBoundary(context.boundary, label + " boundary");
    const request = validatePersonRequestCommitmentV2(context.request);
    const caller = validatePersonCallerBindingV2(context.caller);
    joinCallerIdentity(caller, boundary, label + " boundary");
    return Object.freeze({
      stage: "caller_only" as const,
      boundary,
      request,
      request_sha256: personRequestCommitmentSha256V2(request),
      caller_binding_sha256: personCallerBindingSha256V2(caller),
      outcome,
    });
  }

  if (stage === "scoped") {
    const context = exactRecord(value, SCOPED_CONTEXT_KEYS, label);
    // A scoped denial needs no commitment, so its bytes are snapshotted and
    // hashed before any other supplied evidence is inspected, exactly as the
    // two caller-less stages do. Release and mutation evidence must wait for
    // the commitments they are joined against.
    const outcomeLabel = label + " outcome";
    const outcomeKind = discriminant(context.outcome, "kind", outcomeLabel);
    const denial =
      outcomeKind === "deny"
        ? validatedScopedDenialEvidence(context.outcome, outcomeLabel)
        : null;
    const boundary = validatedBoundary(context.boundary, label + " boundary");
    const request = validatePersonRequestCommitmentV2(context.request);
    const caller = validatePersonCallerBindingV2(context.caller);
    joinCallerIdentity(caller, boundary, label + " boundary");
    const scope = validatePersonScopeBindingV2(context.scope, {
      request,
      caller,
    });
    const commitments = {
      request_sha256: personRequestCommitmentSha256V2(request),
      caller_binding_sha256: personCallerBindingSha256V2(caller),
      scope_binding_sha256: personScopeBindingSha256V2(scope, {
        request,
        caller,
      }),
    };
    return Object.freeze({
      stage: "scoped" as const,
      boundary,
      request,
      request_sha256: commitments.request_sha256,
      caller_binding_sha256: commitments.caller_binding_sha256,
      scope_binding_sha256: commitments.scope_binding_sha256,
      outcome:
        denial ??
        validatedScopedEvidence(
          context.outcome,
          outcomeKind,
          commitments,
          request.operation,
          outcomeLabel,
        ),
    });
  }

  invalid(label + " stage", "is unsupported");
}

function validatedDecision(
  value: unknown,
  label: string,
): PersonReadAuditDecisionV2 {
  if (value !== "allow" && value !== "deny") {
    invalid(label, "must be allow or deny");
  }
  return value;
}

function validatedReasonCode(
  value: unknown,
  label: string,
): PersonReadAuditReasonCodeV2 {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(REASON_CODE_STAGE, value)
  ) {
    invalid(label, "is unsupported");
  }
  return value as PersonReadAuditReasonCodeV2;
}

function validatedAuditContextBody(
  value: unknown,
  context: ValidatedAuditContext,
  label: string,
): PersonReadAuditContextBodyV2 {
  const kind = discriminant(value, "kind", label);
  if (kind !== "no_current_caller" && kind !== "caller_only" && kind !== "scoped") {
    invalid(label + " kind", "is unsupported");
  }
  if (kind !== context.stage) {
    invalid(label + " kind", "does not match the supplied evidence stage");
  }
  if (context.stage === "no_current_caller") {
    exactRecord(value, NO_CALLER_CONTEXT_BODY_KEYS, label);
    return Object.freeze({ kind: "no_current_caller" as const });
  }
  if (context.stage === "caller_only") {
    const record = exactRecord(value, CALLER_ONLY_CONTEXT_BODY_KEYS, label);
    expectLiteral(
      record.caller_binding_sha256,
      context.caller_binding_sha256,
      label + " caller_binding_sha256",
    );
    return Object.freeze({
      kind: "caller_only" as const,
      caller_binding_sha256: context.caller_binding_sha256,
    });
  }
  const record = exactRecord(value, SCOPED_CONTEXT_BODY_KEYS, label);
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
  return Object.freeze({
    kind: "scoped" as const,
    caller_binding_sha256: context.caller_binding_sha256,
    scope_binding_sha256: context.scope_binding_sha256,
  });
}

function validatedAuditOutcomeBody(
  value: unknown,
  evidence: ValidatedOutcomeEvidence,
  decision: PersonReadAuditDecisionV2,
  operation: PersonRequestOperationV2,
  label: string,
): PersonReadAuditOutcomeV2 {
  const kind = discriminant(value, "kind", label);
  if (kind !== evidence.kind) {
    invalid(label + " kind", "does not match the supplied outcome evidence");
  }
  if (evidence.kind === "deny") {
    if (decision !== "deny") {
      invalid(label, "deny outcome requires a deny decision");
    }
    const record = exactRecord(value, DENY_OUTCOME_KEYS, label);
    expectLiteral(
      record.response_sha256,
      evidence.response_sha256,
      label + " response_sha256",
    );
    return Object.freeze({
      kind: "deny" as const,
      response_sha256: evidence.response_sha256,
    });
  }
  if (decision !== "allow") {
    invalid(label, "release and mutation outcomes require an allow decision");
  }
  if (ALLOW_OUTCOME_KIND[operation] !== evidence.kind) {
    invalid(label + " kind", "is not the allow outcome for " + operation);
  }
  if (evidence.kind === "authority_state_mutation") {
    exactRecord(value, MUTATION_OUTCOME_KEYS, label);
    return Object.freeze({ kind: "authority_state_mutation" as const });
  }
  const record = exactRecord(value, RELEASE_OUTCOME_KEYS, label);
  expectLiteral(
    record.release_binding_sha256,
    evidence.release_binding_sha256,
    label + " release_binding_sha256",
  );
  expectLiteral(
    record.response_sha256,
    evidence.response_sha256,
    label + " response_sha256",
  );
  return Object.freeze(
    evidence.kind === "retrieval_release"
      ? {
          kind: "retrieval_release" as const,
          release_binding_sha256: evidence.release_binding_sha256,
          response_sha256: evidence.response_sha256,
        }
      : {
          kind: "authority_state_release" as const,
          release_binding_sha256: evidence.release_binding_sha256,
          response_sha256: evidence.response_sha256,
        },
  );
}

function validatedAuditBody(
  value: unknown,
  context: ValidatedAuditContext,
): PersonReadDecisionAuditBodyV2 {
  const label = "Person read decision audit v2";
  const record = exactRecord(value, AUDIT_BODY_KEYS, label);
  expectLiteral(record.schema_version, 2, label + " schema_version");
  expectLiteral(record.kind, PERSON_READ_DECISION_AUDIT_KIND, label + " kind");
  expectFederationId(record.audit_id, "pra", label + " audit_id");
  expectLiteral(
    record.authority_id,
    context.boundary.authority_id,
    label + " authority_id",
  );
  expectLiteral(
    record.organization_id,
    context.boundary.organization_id,
    label + " organization_id",
  );
  expectLiteral(
    record.state_lineage_id,
    context.boundary.state_lineage_id,
    label + " state_lineage_id",
  );
  expectLiteral(
    record.operation,
    context.request.operation,
    label + " operation",
  );
  expectLiteral(
    record.request_sha256,
    context.request_sha256,
    label + " request_sha256",
  );
  const auditContext = validatedAuditContextBody(
    record.context,
    context,
    label + " context",
  );
  const decision = validatedDecision(record.decision, label + " decision");
  const reasonCode = validatedReasonCode(
    record.reason_code,
    label + " reason_code",
  );
  if ((reasonCode === "authorized") !== (decision === "allow")) {
    invalid(label + " reason_code", "does not match its decision");
  }
  if (REASON_CODE_STAGE[reasonCode] !== auditContext.kind) {
    invalid(
      label + " reason_code",
      "requires the " + REASON_CODE_STAGE[reasonCode] + " context stage",
    );
  }
  const outcome = validatedAuditOutcomeBody(
    record.outcome,
    context.outcome,
    decision,
    context.request.operation,
    label + " outcome",
  );
  expectTimestamp(record.evaluated_at, label + " evaluated_at");
  expectTimestamp(record.retain_until, label + " retain_until");
  expectLiteral(
    record.retain_until,
    retentionExpiry(record.evaluated_at, label + " evaluated_at"),
    label + " retain_until",
  );
  return freezeCanonicalDocument(
    {
      schema_version: 2,
      kind: PERSON_READ_DECISION_AUDIT_KIND,
      audit_id: record.audit_id,
      authority_id: context.boundary.authority_id,
      organization_id: context.boundary.organization_id,
      state_lineage_id: context.boundary.state_lineage_id,
      operation: context.request.operation,
      request_sha256: context.request_sha256,
      context: auditContext,
      decision,
      reason_code: reasonCode,
      outcome,
      evaluated_at: record.evaluated_at,
      retain_until: record.retain_until,
    },
    label,
    MAX_PERSON_AUDIT_CANONICAL_BYTES,
  );
}

export function validatePersonReadDecisionAuditBodyV2(
  value: unknown,
  contextValue: PersonReadDecisionAuditContextV2,
): PersonReadDecisionAuditBodyV2 {
  return validatedAuditBody(value, validatedAuditContext(contextValue));
}

export function personReadDecisionAuditBodySha256V2(
  value: unknown,
  context: PersonReadDecisionAuditContextV2,
): Sha256Digest {
  return canonicalSha256(
    validatePersonReadDecisionAuditBodyV2(value, context) as unknown as JsonValue,
  );
}

export function validatePersonReadDecisionAuditRowV2(
  value: unknown,
  context: PersonReadDecisionAuditContextV2,
): PersonReadDecisionAuditRowV2 {
  const label = "Person read decision audit row v2";
  const wrapper = exactRecord(value, ROW_KEYS, label);
  const body = validatePersonReadDecisionAuditBodyV2(wrapper.body, context);
  expectDigest(wrapper.row_sha256, label + " row_sha256");
  const rowSha256 = canonicalSha256(body as unknown as JsonValue);
  if (wrapper.row_sha256 !== rowSha256) {
    invalid(label + " row_sha256", "does not match its body");
  }
  return Object.freeze({ body, row_sha256: rowSha256 });
}

function auditContextBodyOf(
  context: ValidatedAuditContext,
): PersonReadAuditContextBodyV2 {
  if (context.stage === "no_current_caller") {
    return { kind: "no_current_caller" };
  }
  if (context.stage === "caller_only") {
    return {
      kind: "caller_only",
      caller_binding_sha256: context.caller_binding_sha256,
    };
  }
  return {
    kind: "scoped",
    caller_binding_sha256: context.caller_binding_sha256,
    scope_binding_sha256: context.scope_binding_sha256,
  };
}

function auditOutcomeBodyOf(
  evidence: ValidatedOutcomeEvidence,
): PersonReadAuditOutcomeV2 {
  if (evidence.kind === "deny") {
    return { kind: "deny", response_sha256: evidence.response_sha256 };
  }
  if (evidence.kind === "authority_state_mutation") {
    return { kind: "authority_state_mutation" };
  }
  return evidence.kind === "retrieval_release"
    ? {
        kind: "retrieval_release",
        release_binding_sha256: evidence.release_binding_sha256,
        response_sha256: evidence.response_sha256,
      }
    : {
        kind: "authority_state_release",
        release_binding_sha256: evidence.release_binding_sha256,
        response_sha256: evidence.response_sha256,
      };
}

export function buildPersonReadDecisionAuditRowV2(
  value: BuildPersonReadDecisionAuditRowV2Input,
): BuiltPersonReadDecisionAuditRowV2 {
  const label = "Person read decision audit row v2 build input";
  const input = exactRecord(value, BUILD_AUDIT_ROW_KEYS, label);
  const context = validatedAuditContext(input.context);
  expectFederationId(input.audit_id, "pra", label + " audit_id");
  expectTimestamp(input.evaluated_at, label + " evaluated_at");
  const body = validatedAuditBody(
    {
      schema_version: 2,
      kind: PERSON_READ_DECISION_AUDIT_KIND,
      audit_id: input.audit_id,
      authority_id: context.boundary.authority_id,
      organization_id: context.boundary.organization_id,
      state_lineage_id: context.boundary.state_lineage_id,
      operation: context.request.operation,
      request_sha256: context.request_sha256,
      context: auditContextBodyOf(context),
      decision: input.decision,
      reason_code: input.reason_code,
      outcome: auditOutcomeBodyOf(context.outcome),
      evaluated_at: input.evaluated_at,
      retain_until: retentionExpiry(
        input.evaluated_at,
        label + " evaluated_at",
      ),
    },
    context,
  );
  return Object.freeze({
    row: Object.freeze({
      body,
      row_sha256: canonicalSha256(body as unknown as JsonValue),
    }),
    response_snapshot:
      context.outcome.kind === "authority_state_mutation"
        ? null
        : context.outcome.response_snapshot,
  });
}

function validatedExpiredRowDigests(
  value: unknown,
  label: string,
): readonly Sha256Digest[] {
  const values = exactDensePlainArray(value, label);
  if (values.length === 0 || values.length > MAX_EXPIRED_ROWS) {
    invalid(label, "must contain from one through five hundred row digests");
  }
  const digests = values.map((digest, index) => {
    expectDigest(digest, label + "[" + String(index) + "]");
    return digest;
  });
  for (let index = 1; index < digests.length; index += 1) {
    if (digests[index - 1]! >= digests[index]!) {
      invalid(label, "must be strictly ascending and unique");
    }
  }
  return Object.freeze(digests);
}

export function validateAuditExpiryControlBodyV1(
  value: unknown,
): AuditExpiryControlBodyV1 {
  const label = "Audit expiry control v1";
  const record = exactRecord(value, EXPIRY_BODY_KEYS, label);
  expectLiteral(record.schema_version, 1, label + " schema_version");
  expectLiteral(record.kind, AUDIT_EXPIRY_CONTROL_KIND, label + " kind");
  expectFederationId(record.control_id, "aec", label + " control_id");
  expectFederationId(record.authority_id, "oau", label + " authority_id");
  expectFederationId(record.organization_id, "org", label + " organization_id");
  expectBoundedText(record.state_lineage_id, label + " state_lineage_id", 128);
  expectTimestamp(record.occurred_at, label + " occurred_at");
  expectTimestamp(record.cutoff, label + " cutoff");
  expectLiteral(record.cutoff, record.occurred_at, label + " cutoff");
  expectLiteral(record.retention_days, RETENTION_DAYS, label + " retention_days");
  const expiredRows = validatedExpiredRowDigests(
    record.expired_row_sha256s,
    label + " expired_row_sha256s",
  );
  return freezeCanonicalDocument(
    {
      schema_version: 1,
      kind: AUDIT_EXPIRY_CONTROL_KIND,
      control_id: record.control_id,
      authority_id: record.authority_id,
      organization_id: record.organization_id,
      state_lineage_id: record.state_lineage_id,
      cutoff: record.occurred_at,
      retention_days: RETENTION_DAYS,
      expired_row_sha256s: expiredRows,
      occurred_at: record.occurred_at,
    },
    label,
    MAX_AUDIT_EXPIRY_CONTROL_CANONICAL_BYTES,
  );
}

export function auditExpiryControlBodySha256V1(value: unknown): Sha256Digest {
  return canonicalSha256(
    validateAuditExpiryControlBodyV1(value) as unknown as JsonValue,
  );
}

export function validateAuditExpiryControlRowV1(
  value: unknown,
): AuditExpiryControlRowV1 {
  const label = "Audit expiry control row v1";
  const wrapper = exactRecord(value, ROW_KEYS, label);
  const body = validateAuditExpiryControlBodyV1(wrapper.body);
  expectDigest(wrapper.row_sha256, label + " row_sha256");
  const rowSha256 = canonicalSha256(body as unknown as JsonValue);
  if (wrapper.row_sha256 !== rowSha256) {
    invalid(label + " row_sha256", "does not match its body");
  }
  return Object.freeze({ body, row_sha256: rowSha256 });
}

export function buildAuditExpiryControlRowV1(
  value: BuildAuditExpiryControlRowV1Input,
): AuditExpiryControlRowV1 {
  const label = "Audit expiry control row v1 build input";
  const input = exactRecord(value, BUILD_EXPIRY_ROW_KEYS, label);
  const boundary = validatedBoundary(input.boundary, label + " boundary");
  const body = validateAuditExpiryControlBodyV1({
    schema_version: 1,
    kind: AUDIT_EXPIRY_CONTROL_KIND,
    control_id: input.control_id,
    authority_id: boundary.authority_id,
    organization_id: boundary.organization_id,
    state_lineage_id: boundary.state_lineage_id,
    cutoff: input.occurred_at,
    retention_days: RETENTION_DAYS,
    expired_row_sha256s: input.expired_row_sha256s,
    occurred_at: input.occurred_at,
  });
  return Object.freeze({
    body,
    row_sha256: canonicalSha256(body as unknown as JsonValue),
  });
}
