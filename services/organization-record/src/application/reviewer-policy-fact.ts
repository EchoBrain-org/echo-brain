import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { JsonObject, JsonValue, Sha256Digest } from './contracts.js';
import { derivedAtomIdentity } from './atom-identity.js';

/**
 * The reviewer fact plane, in pure application terms.
 *
 * This module owns the structural view of a reviewer-v2 envelope, the exact
 * `(kind, schema_version)` dispatch in front of it, the fixed projection from
 * that view to its ordered facts, and the one durable eligibility-proof
 * derivation. It is deliberately free of SQLite and of any import edge to the
 * protocol package.
 *
 * It deliberately does **not** validate a durable reviewer-v2 document. The
 * closed v2 validator is
 * `validateOrganizationRecordReviewerApprovalEnvelope` in
 * `packages/organization-protocol`; Authority composition adapts it and injects
 * it here as `ReviewerRestrictedEnvelopeValidator`. A second, partial,
 * hand-written copy of that contract in this workspace would be a second
 * durable truth, and the whole point of the port is that there is only one.
 */

export const RESTRICTED_REVIEWER_POLICY_ID = 'restricted-reviewer-v1' as const;

export const RESTRICTED_REVIEWER_ALLOW_REASON_CODE =
  'active_reviewer_restricted_notice_v1' as const;

export const REVIEWER_ELIGIBILITY_PROOF_KIND =
  'echo-reviewer-restricted-eligibility-proof' as const;

/** The exact dispatch pair. Nothing else selects the reviewer family. */
export const RESTRICTED_REVIEWER_ENVELOPE_KIND =
  'echo-organization-record-envelope' as const;
export const RESTRICTED_REVIEWER_ENVELOPE_SCHEMA_VERSION = 2 as const;

export const MAX_REVIEWER_POLICY_FACTS = 10;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/**
 * Prefix-shaped, exactly as the SQL checks are. The durable UUID form belongs
 * to `packages/organization-protocol`, and this workspace keeps a minimum
 * structural view rather than a second, divergent identity contract.
 */
const PRINCIPAL_ID = /^prn_[\w.-]{1,128}$/;
const MEMBERSHIP_ID = /^mem_[\w.-]{1,128}$/;
const AUDIT_EVENT_ID = /^aud_[\w.-]{1,128}$/;
const ORGANIZATION_ID = /^org_[\w.-]{1,128}$/;
const AUTHORITY_ID = /^oau_[\w.-]{1,128}$/;
const ENVELOPE_ID = /^rec_[\w.-]{1,128}$/;
const INSTALLATION_ID = /^ins_[\w.-]{1,128}$/;
const REQUEST_ID = /^pcr_[\w.-]{1,128}$/;
const BINDING_ID = /^bnd_[\w.-]{1,128}$/;
const GRANT_ID = /^pgr_[\w.-]{1,128}$/;
const RELEASE_ITEM_KINDS = ['decision', 'action', 'rationale'] as const;

export type ReviewerReleaseItemKind = (typeof RELEASE_ITEM_KINDS)[number];

/** One committed reviewer fact, exactly as stored. Eleven text-free columns. */
export interface OrganizationRecordReviewerPolicyFactRow {
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

/**
 * Text-free metadata sufficient for Authority to re-read one exact immutable
 * authorization row and recompute the durable eligibility proof before the
 * record session can be bound to content.
 */
export interface ReviewerFactAuditExpectation {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly organization_id: string;
  readonly authority_id: string;
  readonly envelope_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly approval_id: string;
  readonly request_id: string;
  readonly request_sha256: Sha256Digest;
  readonly provider_event_sha256: Sha256Digest;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly reviewer_release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly evaluated_at: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
}

export interface ReviewerFactAuthorizationReference {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly organization_id: string;
  readonly authority_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

/**
 * The durable eligibility-proof preimage. The private append-attempt token and
 * the output `authorization_proof_sha256` are both absent from it: the digest
 * is an integrity binding that any later start can recompute, while the token
 * exists only as object identity inside one unexported `WeakMap`.
 */
export interface ReviewerRestrictedEligibilityProofPreimage {
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly reviewer_release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
}

export class ReviewerPolicyFactError extends Error {
  readonly terminal: boolean;

  constructor(message: string, terminal: boolean) {
    super(message);
    this.name = 'ReviewerPolicyFactError';
    this.terminal = terminal;
  }
}

/** Proved evidence mismatch: terminal invalid input, never a retry. */
export function reviewerFactInvalid(message: string): never {
  throw new ReviewerPolicyFactError(message, true);
}

/** Missing, indeterminate, or unavailable state: retryable. */
export function reviewerFactUnavailable(message: string): never {
  throw new ReviewerPolicyFactError(message, false);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reviewerFactInvalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function digestField(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    reviewerFactInvalid(`${label} must be a canonical sha256 digest`);
  }
  return value as Sha256Digest;
}

function patternField(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    reviewerFactInvalid(`${label} is invalid`);
  }
  return value;
}

/**
 * `canonicalSha256` of the exact-key durable preimage. Changing one member,
 * one key name, or one value moves this digest, and the fact row that quotes
 * it stops matching its own record.
 */
export function reviewerRestrictedEligibilityProofSha256(
  preimage: ReviewerRestrictedEligibilityProofPreimage,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: REVIEWER_ELIGIBILITY_PROOF_KIND,
    organization_id: preimage.organization_id,
    envelope_id: preimage.envelope_id,
    idempotency_key: preimage.idempotency_key,
    installation_id: preimage.installation_id,
    canonical_envelope_sha256: preimage.canonical_envelope_sha256,
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    reviewer_principal_id: preimage.reviewer_principal_id,
    reviewer_membership_id: preimage.reviewer_membership_id,
    reviewer_release_draft_sha256: preimage.reviewer_release_draft_sha256,
    approval_presentation_sha256: preimage.approval_presentation_sha256,
    semantic_intent_sha256: preimage.semantic_intent_sha256,
    message_presentation_sha256: preimage.message_presentation_sha256,
    authorization_audit_event_id: preimage.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      preimage.authorization_audit_entry_sha256,
    evaluated_at: preimage.evaluated_at,
  });
}

export function validateReviewerEligibilityProofPreimage(
  value: ReviewerRestrictedEligibilityProofPreimage,
): ReviewerRestrictedEligibilityProofPreimage {
  return Object.freeze({
    organization_id: patternField(
      value.organization_id,
      ORGANIZATION_ID,
      'reviewer eligibility organization_id',
    ),
    envelope_id: patternField(
      value.envelope_id,
      ENVELOPE_ID,
      'reviewer eligibility envelope_id',
    ),
    idempotency_key: patternField(
      value.idempotency_key,
      /^[0-9a-f]{64}$/,
      'reviewer eligibility idempotency_key',
    ),
    installation_id: patternField(
      value.installation_id,
      INSTALLATION_ID,
      'reviewer eligibility installation_id',
    ),
    canonical_envelope_sha256: digestField(
      value.canonical_envelope_sha256,
      'reviewer eligibility canonical_envelope_sha256',
    ),
    reviewer_principal_id: patternField(
      value.reviewer_principal_id,
      PRINCIPAL_ID,
      'reviewer eligibility reviewer_principal_id',
    ),
    reviewer_membership_id: patternField(
      value.reviewer_membership_id,
      MEMBERSHIP_ID,
      'reviewer eligibility reviewer_membership_id',
    ),
    reviewer_release_draft_sha256: digestField(
      value.reviewer_release_draft_sha256,
      'reviewer eligibility reviewer_release_draft_sha256',
    ),
    approval_presentation_sha256: digestField(
      value.approval_presentation_sha256,
      'reviewer eligibility approval_presentation_sha256',
    ),
    semantic_intent_sha256: digestField(
      value.semantic_intent_sha256,
      'reviewer eligibility semantic_intent_sha256',
    ),
    message_presentation_sha256: digestField(
      value.message_presentation_sha256,
      'reviewer eligibility message_presentation_sha256',
    ),
    authorization_audit_event_id: patternField(
      value.authorization_audit_event_id,
      AUDIT_EVENT_ID,
      'reviewer eligibility authorization_audit_event_id',
    ),
    authorization_audit_entry_sha256: digestField(
      value.authorization_audit_entry_sha256,
      'reviewer eligibility authorization_audit_entry_sha256',
    ),
    evaluated_at: patternField(
      value.evaluated_at,
      TIMESTAMP,
      'reviewer eligibility evaluated_at',
    ),
  });
}

export interface DerivedReviewerRestrictedEligibilityProof {
  readonly preimage: ReviewerRestrictedEligibilityProofPreimage;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface DeriveReviewerRestrictedEligibilityProofInput {
  /** The organization this log file is bound to, never a document field alone. */
  readonly organization_id: string;
  /** SHA-256 of the exact canonical envelope bytes the record hash commits. */
  readonly canonical_envelope_sha256: Sha256Digest;
  readonly envelope: ReviewerRestrictedEnvelopeView;
}

/**
 * The one owned preimage/digest derivation path.
 *
 * Append, the schema-v2 duplicate reproof, startup admission, and the
 * selected-row read all reach the durable `authorization_proof_sha256` through
 * exactly this function, and all of them build it from the canonical envelope
 * and the store's own organization binding. A stored fact digest is never an
 * input: it is only ever compared against what this returns, so a forged proof
 * that is perfectly consistent across every fact of a record still fails.
 */
export function deriveReviewerRestrictedEligibilityProof(
  input: DeriveReviewerRestrictedEligibilityProofInput,
): DerivedReviewerRestrictedEligibilityProof {
  const { envelope } = input;
  if (envelope.organization_id !== input.organization_id) {
    reviewerFactInvalid(
      'reviewer envelope organization does not match this record log',
    );
  }
  const preimage = validateReviewerEligibilityProofPreimage({
    organization_id: input.organization_id,
    envelope_id: envelope.envelope_id,
    idempotency_key: envelope.idempotency_key,
    installation_id: envelope.installation_id,
    canonical_envelope_sha256: digestField(
      input.canonical_envelope_sha256,
      'reviewer eligibility canonical_envelope_sha256',
    ),
    reviewer_principal_id: envelope.reviewer_principal_id,
    reviewer_membership_id: envelope.reviewer_membership_id,
    reviewer_release_draft_sha256: envelope.reviewer_release_draft_sha256,
    approval_presentation_sha256: envelope.approval_presentation_sha256,
    semantic_intent_sha256: envelope.semantic_intent_sha256,
    message_presentation_sha256: envelope.message_presentation_sha256,
    authorization_audit_event_id: envelope.authorization_audit_event_id,
    authorization_audit_entry_sha256: envelope.authorization_audit_entry_sha256,
    evaluated_at: envelope.evaluated_at,
  });
  return Object.freeze({
    preimage,
    authorization_proof_sha256:
      reviewerRestrictedEligibilityProofSha256(preimage),
  });
}

/** The reviewer-v2 fields this workspace reads, structurally. */
export interface ReviewerRestrictedEnvelopeView {
  readonly schema_version: 2;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly approval_id: string;
  readonly request_id: string;
  readonly request_sha256: Sha256Digest;
  readonly provider_event_sha256: Sha256Digest;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly reviewer_release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
  /** Released signals in exact canonical draft order. */
  readonly signals: readonly {
    readonly id: string;
    readonly kind: ReviewerReleaseItemKind;
    readonly text: string;
  }[];
}

/**
 * The injected closed reviewer-v2 validator.
 *
 * Synchronous and pure by contract: it reads one already-canonical envelope
 * document and returns this workspace's structural view, or throws. Authority
 * composition supplies the real implementation, which is the protocol
 * package's `validateOrganizationRecordReviewerApprovalEnvelope` bound to this
 * organization and authority. Nothing in this workspace may substitute a
 * looser reading of a durable v2 document for it.
 */
export type ReviewerRestrictedEnvelopeValidator = (
  envelope: JsonObject,
) => ReviewerRestrictedEnvelopeView;

/**
 * The exact `(kind, schema_version)` classification, read from the envelope
 * document itself and from nothing else. It is deliberately the *only* field
 * pair this workspace interprets before the closed validator runs: a v1,
 * rejection, or unknown document never reaches the reviewer path, and a v2
 * document never escapes it.
 */
export function isReviewerRestrictedEnvelopeDocument(
  envelope: unknown,
): boolean {
  return (
    typeof envelope === 'object' &&
    envelope !== null &&
    !Array.isArray(envelope) &&
    (envelope as Record<string, unknown>)['kind'] ===
      RESTRICTED_REVIEWER_ENVELOPE_KIND &&
    (envelope as Record<string, unknown>)['schema_version'] ===
      RESTRICTED_REVIEWER_ENVELOPE_SCHEMA_VERSION
  );
}

function releaseSignals(value: unknown): ReviewerRestrictedEnvelopeView['signals'] {
  if (!Array.isArray(value)) {
    reviewerFactInvalid('reviewer envelope view signals must be an array');
  }
  const collected = (value as unknown[]).map((entry) => {
    const signal = record(entry, 'reviewer envelope view signal');
    const kind = signal['kind'];
    if (
      typeof signal['id'] !== 'string' ||
      signal['id'].length === 0 ||
      typeof kind !== 'string' ||
      !(RELEASE_ITEM_KINDS as readonly string[]).includes(kind) ||
      typeof signal['text'] !== 'string' ||
      signal['text'].length === 0
    ) {
      reviewerFactInvalid('reviewer envelope view signal is invalid');
    }
    return Object.freeze({
      id: signal['id'],
      kind: kind as ReviewerReleaseItemKind,
      text: signal['text'],
    });
  });
  if (collected.length < 1 || collected.length > MAX_REVIEWER_POLICY_FACTS) {
    reviewerFactInvalid(
      `reviewer envelope must release 1 to ${MAX_REVIEWER_POLICY_FACTS} signals`,
    );
  }
  const ids = new Set(collected.map((signal) => signal.id));
  if (ids.size !== collected.length) {
    reviewerFactInvalid('reviewer envelope signal ids must be unique');
  }
  return Object.freeze(collected);
}

/**
 * Normalizes and freezes what the injected validator returned.
 *
 * This is not a second envelope contract: it never looks at the durable
 * document. It proves that the *port's own output* is the closed shape this
 * workspace stores and compares, so an adapter that drifted, widened a field,
 * or returned a partially-built object fails closed here instead of writing a
 * fact nobody can reproject.
 */
export function assertReviewerRestrictedEnvelopeView(
  value: unknown,
): ReviewerRestrictedEnvelopeView {
  const view = record(value, 'reviewer envelope view');
  if (view['schema_version'] !== RESTRICTED_REVIEWER_ENVELOPE_SCHEMA_VERSION) {
    reviewerFactInvalid('reviewer envelope view is not schema version 2');
  }
  return Object.freeze({
    schema_version: 2,
    authority_id: patternField(
      view['authority_id'],
      AUTHORITY_ID,
      'reviewer envelope authority_id',
    ),
    organization_id: patternField(
      view['organization_id'],
      ORGANIZATION_ID,
      'reviewer envelope organization_id',
    ),
    envelope_id: patternField(
      view['envelope_id'],
      ENVELOPE_ID,
      'reviewer envelope envelope_id',
    ),
    idempotency_key: patternField(
      view['idempotency_key'],
      /^[0-9a-f]{64}$/,
      'reviewer envelope idempotency_key',
    ),
    installation_id: patternField(
      view['installation_id'],
      INSTALLATION_ID,
      'reviewer envelope submitter installation_id',
    ),
    reviewer_principal_id: patternField(
      view['reviewer_principal_id'],
      PRINCIPAL_ID,
      'reviewer envelope reviewer principal_id',
    ),
    reviewer_membership_id: patternField(
      view['reviewer_membership_id'],
      MEMBERSHIP_ID,
      'reviewer envelope reviewer membership_id',
    ),
    approval_id: patternField(
      view['approval_id'],
      /^[0-9a-f]{64}$/,
      'reviewer envelope approval_id',
    ),
    request_id: patternField(
      view['request_id'],
      REQUEST_ID,
      'reviewer envelope request_id',
    ),
    request_sha256: digestField(
      view['request_sha256'],
      'reviewer envelope request_sha256',
    ),
    provider_event_sha256: digestField(
      view['provider_event_sha256'],
      'reviewer envelope provider_event_sha256',
    ),
    adapter_binding_id: patternField(
      view['adapter_binding_id'],
      BINDING_ID,
      'reviewer envelope adapter_binding_id',
    ),
    permission_grant_id: patternField(
      view['permission_grant_id'],
      GRANT_ID,
      'reviewer envelope permission_grant_id',
    ),
    semantic_intent_sha256: digestField(
      view['semantic_intent_sha256'],
      'reviewer envelope semantic_intent_sha256',
    ),
    reviewer_release_draft_sha256: digestField(
      view['reviewer_release_draft_sha256'],
      'reviewer envelope reviewer_release_draft_sha256',
    ),
    approval_presentation_sha256: digestField(
      view['approval_presentation_sha256'],
      'reviewer envelope approval_presentation_sha256',
    ),
    message_presentation_sha256: digestField(
      view['message_presentation_sha256'],
      'reviewer envelope message_presentation_sha256',
    ),
    authorization_audit_event_id: patternField(
      view['authorization_audit_event_id'],
      AUDIT_EVENT_ID,
      'reviewer envelope authorization_audit_event_id',
    ),
    authorization_audit_entry_sha256: digestField(
      view['authorization_audit_entry_sha256'],
      'reviewer envelope authorization_audit_entry_sha256',
    ),
    evaluated_at: patternField(
      view['evaluated_at'],
      TIMESTAMP,
      'reviewer envelope evaluated_at',
    ),
    signals: releaseSignals(view['signals']),
  });
}

/**
 * Dispatch, then delegate, then normalize.
 *
 * The exact `(kind, schema_version)` pair selects the reviewer family before
 * any other field is interpreted; the injected closed validator then decides
 * whether the document is a valid reviewer-v2 approval. A malformed frame, a
 * cross-version field set, a rejection, a wrong organization or authority, and
 * a missing, extra, or altered field all fail closed here, because they all
 * make the injected validator throw.
 */
export function readReviewerRestrictedEnvelope(
  envelope: JsonObject,
  validate: ReviewerRestrictedEnvelopeValidator,
): ReviewerRestrictedEnvelopeView {
  if (!isReviewerRestrictedEnvelopeDocument(envelope)) {
    reviewerFactInvalid('reviewer envelope kind or schema version is unsupported');
  }
  if (typeof validate !== 'function') {
    // No validator, no reviewer path. Legacy append and derive stay live; the
    // reviewer slice simply is not admitted in this composition.
    reviewerFactUnavailable(
      'reviewer-v2 handling requires the injected closed reviewer validator',
    );
  }
  let validated: unknown;
  try {
    validated = validate(envelope);
  } catch (error) {
    reviewerFactInvalid(
      `reviewer envelope failed closed reviewer-v2 validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return assertReviewerRestrictedEnvelopeView(validated);
}

/** The minimum stored-row view the canonical-bytes check reads. */
export interface CanonicalRecordEnvelopeBytes {
  readonly canonical_envelope: string;
  readonly envelope_sha256: Sha256Digest;
}

/**
 * Re-derives one stored record's canonical envelope document.
 *
 * Neither admission nor the selected-row read takes a row's own
 * `canonical_envelope`/`envelope_sha256` pair on trust: the bytes must be
 * their own RFC 8785 canonicalization, and they must hash to the stored digest
 * that the record hash commits. Tampered bytes or a tampered digest fail here,
 * before any envelope field, proof, or released item is read.
 */
export function readCanonicalRecordEnvelope(
  row: CanonicalRecordEnvelopeBytes,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_envelope) as unknown;
  } catch {
    reviewerFactInvalid('stored canonical envelope is not parseable');
  }
  const document = record(parsed, 'stored canonical envelope');
  if (canonicalJson(document as JsonObject) !== row.canonical_envelope) {
    reviewerFactInvalid('stored envelope bytes are not their canonical form');
  }
  if (sha256Digest(row.canonical_envelope) !== row.envelope_sha256) {
    reviewerFactInvalid('stored envelope bytes do not bind their digest');
  }
  return document as JsonObject;
}

/** The lowercase sha256 of the exact UTF-8 bytes of one raw signal id. */
export function reviewerSignalIdSha256(signalId: string): Sha256Digest {
  return sha256Digest(signalId);
}

export interface ProjectReviewerPolicyFactsInput {
  readonly envelope: ReviewerRestrictedEnvelopeView;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly organization_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
}

/**
 * The fixed pure projector from one reviewer-v2 envelope to its complete
 * ordered fact set. Ingest, the atomic append, the startup integrity verifier,
 * and the selected-row reprojection all call exactly this function, so a fact
 * that any one of them accepts is a fact all of them derive identically.
 *
 * `authorization_proof_sha256` is derived here, never accepted here. There is
 * no parameter a caller could use to hand a stored digest back to the
 * projector as its own expected output.
 */
export function projectReviewerPolicyFacts(
  input: ProjectReviewerPolicyFactsInput,
): readonly OrganizationRecordReviewerPolicyFactRow[] {
  const { envelope } = input;
  const { authorization_proof_sha256: authorizationProofSha256 } =
    deriveReviewerRestrictedEligibilityProof({
      organization_id: input.organization_id,
      canonical_envelope_sha256: input.canonical_envelope_sha256,
      envelope,
    });
  const rows = envelope.signals.map((signal, index) => ({
    reviewer_principal_id: envelope.reviewer_principal_id,
    reviewer_membership_id: envelope.reviewer_membership_id,
    log_position: input.log_position,
    record_hash: input.record_hash,
    atom_order: index,
    signal_id_sha256: reviewerSignalIdSha256(signal.id),
    atom_id: derivedAtomIdentity(input.record_hash, signal.id),
    semantic_intent_sha256: envelope.semantic_intent_sha256,
    authorization_audit_event_id: envelope.authorization_audit_event_id,
    authorization_audit_entry_sha256: envelope.authorization_audit_entry_sha256,
    authorization_proof_sha256: authorizationProofSha256,
  }));
  const signalDigests = new Set(rows.map((row) => row.signal_id_sha256));
  const atomIds = new Set(rows.map((row) => row.atom_id));
  if (signalDigests.size !== rows.length || atomIds.size !== rows.length) {
    reviewerFactInvalid('reviewer fact identities must be unique within a record');
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/** Canonical equality over the complete ordered fact set. */
export function reviewerPolicyFactSetSha256(
  rows: readonly OrganizationRecordReviewerPolicyFactRow[],
): Sha256Digest {
  return canonicalSha256(rows as unknown as JsonValue);
}
