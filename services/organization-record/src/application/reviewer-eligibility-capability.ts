import type { Sha256Digest } from './contracts.js';
import {
  RESTRICTED_REVIEWER_POLICY_ID,
  reviewerFactUnavailable,
  reviewerRestrictedEligibilityProofSha256,
  validateReviewerEligibilityProofPreimage,
  type ReviewerRestrictedEligibilityProofPreimage,
} from './reviewer-policy-fact.js';

/**
 * The Authority-issued, single-use reviewer eligibility capability.
 *
 * A fact may only be written when the append coordinator has already proved,
 * against the immutable integration-audit row, that this exact reviewer
 * approved this exact envelope. That proof is carried here as an unforgeable
 * runtime object rather than as data, because data can be copied, replayed,
 * reconstructed from JSON, or handed to another append. The capability body
 * lives only in an unexported `WeakMap` keyed by an opaque token object, so:
 *
 * - it is not constructible outside this module,
 * - it is not serializable into anything that survives a round trip,
 * - it is not an envelope field, a public receipt, or an exported DTO, and
 * - a structurally identical impostor carries no binding at all.
 *
 * The private append-attempt token is object identity. It is never persisted;
 * only the recomputable `authorization_proof_sha256` reaches the fact row.
 */

const CAPABILITY_BRAND: unique symbol = Symbol(
  'echo-organization-record-reviewer-eligibility-capability',
);

/**
 * Opaque to every consumer. The brand is a declaration-only phantom: nothing
 * outside this module can produce a value that the private `WeakMap` knows.
 */
export interface ReviewerRestrictedEligibilityCapabilityV1 {
  readonly [CAPABILITY_BRAND]: true;
}

/** The exact envelope identity a consume attempt must present. */
export interface ReviewerEligibilityCapabilityExpectation {
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
}

export interface ConsumedReviewerEligibilityCapability {
  readonly preimage: ReviewerRestrictedEligibilityProofPreimage;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly policy_id: typeof RESTRICTED_REVIEWER_POLICY_ID;
}

interface CapabilityBinding {
  readonly preimage: ReviewerRestrictedEligibilityProofPreimage;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly channel: object;
  spent: boolean;
}

export interface ReviewerEligibilityCapabilityChannel {
  /**
   * Validates the exact durable preimage, computes the proof digest, creates a
   * fresh private append-attempt token, and returns an opaque capability.
   */
  issue(
    preimage: ReviewerRestrictedEligibilityProofPreimage,
  ): ReviewerRestrictedEligibilityCapabilityV1;
  /**
   * Marks the capability spent *before* any comparison, then returns its
   * binding and recomputed durable proof. A copied, structural, wrong-channel,
   * reused, or mismatched capability fails retryably: an indeterminate
   * capability must never append a record, and must never be mistaken for a
   * proved evidence mismatch.
   */
  consume(
    capability: ReviewerRestrictedEligibilityCapabilityV1,
    expected: ReviewerEligibilityCapabilityExpectation,
  ): ConsumedReviewerEligibilityCapability;
}

/**
 * What an append presents to write reviewer facts: the live capability and the
 * exact channel that minted it. Neither survives serialization, so this can
 * only be produced inside the process that performed the audit lookup.
 */
export interface ReviewerPolicyFactAppendInput {
  readonly capability: ReviewerRestrictedEligibilityCapabilityV1;
  readonly channel: ReviewerEligibilityCapabilityChannel;
}

/**
 * One issuer and consumer sharing one unexported `WeakMap`. Two channels never
 * honor each other's capabilities, which is what makes a capability minted for
 * one append attempt useless to any other.
 */
export function createReviewerEligibilityCapabilityChannel(): ReviewerEligibilityCapabilityChannel {
  const bindings = new WeakMap<object, CapabilityBinding>();
  const channel = Object.freeze({});

  return Object.freeze({
    issue(
      preimage: ReviewerRestrictedEligibilityProofPreimage,
    ): ReviewerRestrictedEligibilityCapabilityV1 {
      const validated = validateReviewerEligibilityProofPreimage(preimage);
      const token = Object.freeze({});
      bindings.set(token, {
        preimage: validated,
        authorization_proof_sha256:
          reviewerRestrictedEligibilityProofSha256(validated),
        channel,
        spent: false,
      });
      return token as ReviewerRestrictedEligibilityCapabilityV1;
    },

    consume(
      capability: ReviewerRestrictedEligibilityCapabilityV1,
      expected: ReviewerEligibilityCapabilityExpectation,
    ): ConsumedReviewerEligibilityCapability {
      if (typeof capability !== 'object' || capability === null) {
        reviewerFactUnavailable(
          'reviewer eligibility capability is not a live capability',
        );
      }
      const binding = bindings.get(capability as unknown as object);
      if (binding === undefined || binding.channel !== channel) {
        // A structural impostor, a JSON round trip, or another channel's
        // capability all land here and carry no binding to compare.
        reviewerFactUnavailable(
          'reviewer eligibility capability is forged or belongs to another channel',
        );
      }
      // Spend first: a comparison that throws must still burn the capability,
      // so a rejected attempt can never be retried with the same object.
      if (binding.spent) {
        reviewerFactUnavailable(
          'reviewer eligibility capability was already consumed',
        );
      }
      binding.spent = true;

      const { preimage } = binding;
      if (
        preimage.organization_id !== expected.organization_id ||
        preimage.envelope_id !== expected.envelope_id ||
        preimage.idempotency_key !== expected.idempotency_key ||
        preimage.installation_id !== expected.installation_id ||
        preimage.canonical_envelope_sha256 !== expected.canonical_envelope_sha256
      ) {
        reviewerFactUnavailable(
          'reviewer eligibility capability was minted for another append attempt',
        );
      }
      // Recomputed, never read back from the binding as a shortcut.
      const recomputed = reviewerRestrictedEligibilityProofSha256(preimage);
      if (recomputed !== binding.authorization_proof_sha256) {
        reviewerFactUnavailable(
          'reviewer eligibility capability proof digest is indeterminate',
        );
      }
      return Object.freeze({
        preimage,
        authorization_proof_sha256: recomputed,
        policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      });
    },
  });
}
