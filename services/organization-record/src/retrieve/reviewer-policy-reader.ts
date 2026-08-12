import type Database from 'better-sqlite3';
import type {
  OrganizationRecordLogRow,
  Sha256Digest,
} from '../application/contracts.js';
import {
  MAX_REVIEWER_POLICY_FACTS,
  projectReviewerPolicyFacts,
  readCanonicalRecordEnvelope,
  readReviewerRestrictedEnvelope,
  reviewerFactUnavailable,
  type OrganizationRecordReviewerPolicyFactRow,
  type ReviewerFactAuthorizationReference,
  type ReviewerReleaseItemKind,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';

/**
 * The private reviewer read boundary.
 *
 * Serving exposes one session factory and no raw store. Facts come first and
 * carry no text; content is reachable only through a request-local capability
 * the current-Person resolver mints by binding the complete ordered fact array
 * this same live session returned. A copied object, reconstructed JSON, a
 * different session's facts, a partial or reordered array, a second read, or
 * any post-request use is indeterminate internal state, so it fails as
 * unavailable rather than releasing content.
 */

const SESSION_BRAND: unique symbol = Symbol(
  'echo-organization-record-reviewer-read-session',
);
const BINDING_BRAND: unique symbol = Symbol(
  'echo-organization-record-reviewer-content-binding',
);

export interface ReviewerContentBindingV1 {
  readonly [BINDING_BRAND]: true;
}

export interface ReviewerReadCaller {
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
}

/** One released item, reprojected from its canonical record. */
export interface ReviewerReleasedItem {
  readonly kind: ReviewerReleaseItemKind;
  readonly text: string;
}

export interface ReviewerReadSession {
  readonly [SESSION_BRAND]: true;
  /** Text-free facts fixed to the exact caller tuple, at most ten. */
  readFacts(): readonly OrganizationRecordReviewerPolicyFactRow[];
  /** Metadata-only exact audit references; reads no canonical content. */
  readAuthorizationReferences(): ReviewerAuthorizationSelection;
  /** Binds the complete ordered fact array the resolver proved. */
  bindResolvedFacts(
    facts: readonly OrganizationRecordReviewerPolicyFactRow[],
  ): ReviewerContentBindingV1;
  /** Reads only the canonical rows fixed inside that capability. */
  readBoundCanonicalRecords(
    binding: ReviewerContentBindingV1,
  ): readonly ReviewerReleasedItem[];
  close(): void;
}

type SessionState =
  | 'opened'
  | 'facts-read'
  | 'authorization-references-read'
  | 'bound'
  | 'content-read'
  | 'closed';

interface BindingBody {
  readonly session: object;
  readonly request_sha256: Sha256Digest;
  readonly caller: ReviewerReadCaller;
  readonly facts: readonly OrganizationRecordReviewerPolicyFactRow[];
  spent: boolean;
}

const bindings = new WeakMap<object, BindingBody>();

export interface OpenReviewerReadSessionInput {
  readonly caller: ReviewerReadCaller;
  readonly request_sha256: Sha256Digest;
  readonly limit: number;
  /** The organization this log file is bound to, for the proof recomputation. */
  readonly organization_id: string;
  readonly authority_id: string;
  /** The injected closed reviewer-v2 validator, from Authority composition. */
  readonly reviewer_validator?: ReviewerRestrictedEnvelopeValidator;
}

export interface ReviewerRecordHead {
  readonly position: number;
  readonly record_hash: Sha256Digest | null;
}

export interface ReviewerAuthorizationSelection {
  readonly references: readonly ReviewerFactAuthorizationReference[];
  readonly record_head: ReviewerRecordHead;
}

/**
 * The exact serving query. It names its composite index, is equality-bound to
 * one reviewer principal and membership, orders by the contract's exact
 * ordering, caps at ten, and selects only the eleven text-free columns — it
 * cannot scan another reviewer's facts into the logical candidate set and it
 * cannot read a content column.
 */
const SELECT_REVIEWER_FACTS = `SELECT reviewer_principal_id, reviewer_membership_id, log_position,
          record_hash, atom_order, signal_id_sha256, atom_id,
          semantic_intent_sha256, authorization_audit_event_id,
          authorization_audit_entry_sha256, authorization_proof_sha256
   FROM organization_record_reviewer_policy_fact
   INDEXED BY organization_record_reviewer_policy_fact_by_reviewer
   WHERE reviewer_principal_id = ? AND reviewer_membership_id = ?
   ORDER BY log_position DESC, atom_order ASC
   LIMIT ?`;

export const REVIEWER_FACT_SELECT_SQL = SELECT_REVIEWER_FACTS;

/**
 * Opens one closure-owned, single-use session. The database handle never
 * escapes: everything a caller can reach is fixed to this exact caller tuple.
 */
export function openReviewerReadSession(
  database: Database.Database,
  input: OpenReviewerReadSessionInput,
): ReviewerReadSession {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_REVIEWER_POLICY_FACTS
  ) {
    reviewerFactUnavailable('reviewer read session limit is out of contract');
  }
  const identity = Object.freeze({});
  const caller = Object.freeze({ ...input.caller });
  const requestSha256 = input.request_sha256;
  const organizationId = input.organization_id;
  const authorityId = input.authority_id;
  const limit = input.limit;
  const reviewerValidator = input.reviewer_validator;
  let state: SessionState = 'opened';
  let issued: readonly OrganizationRecordReviewerPolicyFactRow[] = [];

  function transition(expected: SessionState, next: SessionState): void {
    if (state !== expected) {
      reviewerFactUnavailable(
        `reviewer read session cannot move from ${state} to ${next}`,
      );
    }
    state = next;
  }

  const session: ReviewerReadSession = {
    [SESSION_BRAND]: true,

    readFacts() {
      transition('opened', 'facts-read');
      const rows = database
        .prepare(SELECT_REVIEWER_FACTS)
        .all(
          caller.reviewer_principal_id,
          caller.reviewer_membership_id,
          limit,
        ) as OrganizationRecordReviewerPolicyFactRow[];
      issued = Object.freeze(rows.map((fact) => Object.freeze({ ...fact })));
      return issued;
    },

    readAuthorizationReferences() {
      transition('facts-read', 'authorization-references-read');
      const references: ReviewerFactAuthorizationReference[] = [];
      const positions = new Map<
        number,
        OrganizationRecordReviewerPolicyFactRow
      >();
      for (const fact of issued) {
        const first = positions.get(fact.log_position);
        if (first === undefined) {
          positions.set(fact.log_position, fact);
          continue;
        }
        if (
          first.record_hash !== fact.record_hash ||
          first.reviewer_principal_id !== fact.reviewer_principal_id ||
          first.reviewer_membership_id !== fact.reviewer_membership_id ||
          first.semantic_intent_sha256 !== fact.semantic_intent_sha256 ||
          first.authorization_audit_event_id !==
            fact.authorization_audit_event_id ||
          first.authorization_audit_entry_sha256 !==
            fact.authorization_audit_entry_sha256 ||
          first.authorization_proof_sha256 !== fact.authorization_proof_sha256
        ) {
          reviewerFactUnavailable(
            'reviewer facts for one record disagree on authorization metadata',
          );
        }
      }
      for (const [position, fact] of positions) {
        const row = database
          .prepare(
            `SELECT position, envelope_id, installation_id, idempotency_key,
                    envelope_sha256, record_hash
             FROM organization_record_log
             WHERE position = ? AND record_hash = ?`,
          )
          .get(position, fact.record_hash) as
          | {
              position: number;
              envelope_id: string;
              installation_id: string;
              idempotency_key: string;
              envelope_sha256: Sha256Digest;
              record_hash: Sha256Digest;
            }
          | undefined;
        if (row === undefined) {
          reviewerFactUnavailable(
            'reviewer fact references no exact metadata-only record row',
          );
        }
        references.push(
          Object.freeze({
            log_position: row.position,
            record_hash: row.record_hash,
            organization_id: organizationId,
            authority_id: authorityId,
            envelope_id: row.envelope_id,
            idempotency_key: row.idempotency_key,
            installation_id: row.installation_id,
            canonical_envelope_sha256: row.envelope_sha256,
            reviewer_principal_id: fact.reviewer_principal_id,
            reviewer_membership_id: fact.reviewer_membership_id,
            semantic_intent_sha256: fact.semantic_intent_sha256,
            authorization_audit_event_id:
              fact.authorization_audit_event_id,
            authorization_audit_entry_sha256:
              fact.authorization_audit_entry_sha256,
            authorization_proof_sha256: fact.authorization_proof_sha256,
          }),
        );
      }
      const head = database
        .prepare(
          `SELECT position, record_hash
           FROM organization_record_log
           ORDER BY position DESC LIMIT 1`,
        )
        .get() as { position: number; record_hash: Sha256Digest } | undefined;
      return Object.freeze({
        references: Object.freeze(references),
        record_head: Object.freeze(
          head ?? { position: 0, record_hash: null },
        ),
      });
    },

    bindResolvedFacts(facts) {
      transition('authorization-references-read', 'bound');
      if (
        !Array.isArray(facts) ||
        facts.length !== issued.length ||
        facts.some((fact, index) => fact !== issued[index])
      ) {
        // Only the complete ordered array this live session returned may be
        // bound. A partial, reordered, copied, or reconstructed array is not
        // the same object graph and cannot reach content.
        reviewerFactUnavailable(
          'reviewer content binding must quote this session ordered facts exactly',
        );
      }
      const token = Object.freeze({});
      bindings.set(token, {
        session: identity,
        request_sha256: requestSha256,
        caller,
        facts: issued,
        spent: false,
      });
      return token as ReviewerContentBindingV1;
    },

    readBoundCanonicalRecords(binding) {
      transition('bound', 'content-read');
      if (typeof binding !== 'object' || binding === null) {
        reviewerFactUnavailable('reviewer content binding is not a live binding');
      }
      const body = bindings.get(binding as unknown as object);
      if (
        body === undefined ||
        body.session !== identity ||
        body.request_sha256 !== requestSha256 ||
        body.caller.reviewer_principal_id !== caller.reviewer_principal_id ||
        body.caller.reviewer_membership_id !== caller.reviewer_membership_id
      ) {
        reviewerFactUnavailable(
          'reviewer content binding was issued by another session or request',
        );
      }
      if (body.spent) {
        reviewerFactUnavailable('reviewer content binding was already consumed');
      }
      body.spent = true;
      return readBoundItems(database, body.facts, caller, {
        organization_id: organizationId,
        reviewer_validator: reviewerValidator,
      });
    },

    close() {
      state = 'closed';
    },
  };
  return Object.freeze(session);
}

/**
 * Loads only the referenced canonical rows and reruns the fixed projector in
 * memory. Every selected fact must match exactly; any mismatch denies the
 * whole request rather than omitting one item.
 */
export interface ReviewerReprojectionBinding {
  readonly organization_id: string;
  readonly reviewer_validator: ReviewerRestrictedEnvelopeValidator | undefined;
}

function readBoundItems(
  database: Database.Database,
  facts: readonly OrganizationRecordReviewerPolicyFactRow[],
  caller: ReviewerReadCaller,
  binding: ReviewerReprojectionBinding,
): readonly ReviewerReleasedItem[] {
  const items: ReviewerReleasedItem[] = [];
  const byPosition = new Map<number, OrganizationRecordLogRow>();
  for (const fact of facts) {
    if (
      fact.reviewer_principal_id !== caller.reviewer_principal_id ||
      fact.reviewer_membership_id !== caller.reviewer_membership_id
    ) {
      reviewerFactUnavailable('reviewer fact belongs to another reviewer');
    }
    let row = byPosition.get(fact.log_position);
    if (row === undefined) {
      const loaded = database
        .prepare(
          `SELECT position, envelope_id, event_type, installation_id,
                  idempotency_key, canonical_envelope, envelope_sha256,
                  receipt_payload, previous_record_hash, record_hash, recorded_at
           FROM organization_record_log
           WHERE position = ? AND record_hash = ?`,
        )
        .get(fact.log_position, fact.record_hash) as
        | OrganizationRecordLogRow
        | undefined;
      if (loaded === undefined) {
        reviewerFactUnavailable(
          'reviewer fact references no exact canonical record',
        );
      }
      row = loaded;
      byPosition.set(fact.log_position, loaded);
    }
    items.push(reprojectedItem(row, fact, binding));
  }
  return Object.freeze(items);
}

/**
 * Reproves one fact against its canonical record and returns the projected
 * item. This is the whole fact trust model: a fact is an address hint, and
 * nothing it asserts is believed until the canonical envelope reproduces it.
 */
export function reprojectedItem(
  row: OrganizationRecordLogRow,
  fact: OrganizationRecordReviewerPolicyFactRow,
  binding: ReviewerReprojectionBinding,
): ReviewerReleasedItem {
  // Canonical bytes and their digest come first, then the closed validator,
  // then the independently derived proof. Only after all three agree with the
  // stored fact does this function look at a released item at all, so no text
  // is reachable before the proof and the request-local binding.
  let envelope: ReturnType<typeof readReviewerRestrictedEnvelope>;
  let projected: ReturnType<typeof projectReviewerPolicyFacts>;
  try {
    envelope = readReviewerRestrictedEnvelope(
      readCanonicalRecordEnvelope(row),
      binding.reviewer_validator as ReviewerRestrictedEnvelopeValidator,
    );
    projected = projectReviewerPolicyFacts({
      envelope,
      log_position: row.position,
      record_hash: row.record_hash,
      organization_id: binding.organization_id,
      canonical_envelope_sha256: row.envelope_sha256,
    });
  } catch (error) {
    // Incoherent stored state is never a caller error on the read path: it
    // releases nothing and stays retryable.
    reviewerFactUnavailable(
      `reviewer fact canonical record is unusable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const expected = projected[fact.atom_order];
  if (
    expected === undefined ||
    expected.reviewer_principal_id !== fact.reviewer_principal_id ||
    expected.reviewer_membership_id !== fact.reviewer_membership_id ||
    expected.log_position !== fact.log_position ||
    expected.record_hash !== fact.record_hash ||
    expected.atom_order !== fact.atom_order ||
    expected.signal_id_sha256 !== fact.signal_id_sha256 ||
    expected.atom_id !== fact.atom_id ||
    expected.semantic_intent_sha256 !== fact.semantic_intent_sha256 ||
    expected.authorization_audit_event_id !==
      fact.authorization_audit_event_id ||
    expected.authorization_audit_entry_sha256 !==
      fact.authorization_audit_entry_sha256 ||
    // The recomputed proof digest, compared rather than consumed. A stored
    // digest is never handed back to the projector as its own expectation.
    expected.authorization_proof_sha256 !== fact.authorization_proof_sha256
  ) {
    reviewerFactUnavailable(
      'reviewer fact does not reproject from its canonical record',
    );
  }
  const signal = envelope.signals[fact.atom_order];
  if (signal === undefined) {
    reviewerFactUnavailable('reviewer fact has no canonical released item');
  }
  return Object.freeze({ kind: signal.kind, text: signal.text });
}
