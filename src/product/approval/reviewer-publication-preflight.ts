import type { SlackApprovalPresentationContract } from './decision-node.js';

/**
 * The local lifecycle preflight for the reviewer publication mode.
 *
 * It is pure: the caller supplies the unresolved-slot listing, the mode it is
 * about to start under, and the configuration it is about to use. Every
 * refusal is a startup refusal, not a runtime downgrade -- reviewer V1 never
 * reinterprets an already-posted card under a mode or a binding it was not
 * published with.
 */

export type ReviewerPublicationMode =
  | 'ordinary-v1'
  | 'pilot-member-readable-v1'
  | 'restricted-reviewer-v1';

export interface UnresolvedApprovalPresentationSlot {
  readonly approval_id: string;
  readonly contract: SlackApprovalPresentationContract | null;
}

export interface ReviewerPublicationConfiguration {
  readonly mode: ReviewerPublicationMode;
  readonly adapter_id: string;
  readonly adapter_instance_id: string;
  readonly adapter_version: string;
  readonly channel_id: string;
  readonly reviewer_slack_user_id: string;
  readonly reviewer_name: string;
  readonly credential_ref: string;
  /**
   * `canonicalSha256({schema_version:1,
   * kind:'slack-credential-fingerprint-v1', token})` over the credential this
   * start would resolve, or `null` when it cannot be resolved. A null
   * fingerprint cannot prove the value did not rotate, so it refuses.
   */
  readonly credential_fingerprint_sha256: string | null;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  /** True when pilot presentation configuration is also present. */
  readonly permission_pilot_presentation_enabled: boolean;
}

export interface ReviewerPublicationPreflightResult {
  readonly ok: boolean;
  readonly refusals: readonly string[];
}

/**
 * The rotation fields a frozen card pins. Provider workspace, bot, and app
 * rotation is refused through these: a new provider configuration requires a
 * new immutable secret reference and a new `adapter_instance_id`, so changing
 * either while a reviewer card is unresolved is refused here, and the old
 * credential reference and value stay usable until its cards drain.
 */
const FROZEN_ROTATION_FIELDS = [
  'adapter_id',
  'adapter_instance_id',
  'adapter_version',
  'channel_id',
  'reviewer_slack_user_id',
  'reviewer_name',
  'credential_ref',
  'approve_reaction',
  'reject_reaction',
] as const;

export function reviewerPublicationPreflight(
  configuration: ReviewerPublicationConfiguration,
  unresolved: readonly UnresolvedApprovalPresentationSlot[],
): ReviewerPublicationPreflightResult {
  const refusals: string[] = [];

  if (
    configuration.mode === 'restricted-reviewer-v1' &&
    configuration.permission_pilot_presentation_enabled
  ) {
    refusals.push(
      'restricted-reviewer-v1 and the permission pilot presentation are mutually exclusive',
    );
  }

  const reviewerSlots = unresolved.filter(
    (slot) => slot.contract !== null,
  ) as readonly (UnresolvedApprovalPresentationSlot & {
    contract: SlackApprovalPresentationContract;
  })[];

  if (configuration.mode === 'restricted-reviewer-v1') {
    // Enabling reviewer mode refuses startup if any unresolved Authority-marked
    // card was published without the reviewer contract. Those ordinary or pilot
    // cards must be resolved or rejected under their original configuration
    // first; no migration guesses a mode from current configuration.
    for (const slot of unresolved) {
      if (slot.contract === null) {
        refusals.push(
          `decision ${slot.approval_id} is unresolved and was published without a reviewer presentation contract`,
        );
      }
    }
  }

  // While any reviewer contract is unresolved, an in-place rotation of the
  // frozen adapter identity, channel, reviewer, credential reference, credential
  // value, or reaction pair is refused. A frozen card fails closed rather than
  // being reinterpreted under the new pair.
  for (const slot of reviewerSlots) {
    if (configuration.mode !== 'restricted-reviewer-v1') {
      refusals.push(
        `decision ${slot.approval_id} holds an unresolved reviewer presentation contract and cannot start under ${configuration.mode}`,
      );
      continue;
    }
    for (const field of FROZEN_ROTATION_FIELDS) {
      if (slot.contract[field] !== configuration[field]) {
        refusals.push(
          `decision ${slot.approval_id} froze ${field} and it was rotated in place before that card resolved`,
        );
      }
    }
    if (
      configuration.credential_fingerprint_sha256 === null ||
      configuration.credential_fingerprint_sha256 !==
        slot.contract.credential_fingerprint_sha256
    ) {
      refusals.push(
        `decision ${slot.approval_id} froze its credential value and it was rotated in place before that card resolved`,
      );
    }
  }

  return Object.freeze({
    ok: refusals.length === 0,
    refusals: Object.freeze([...new Set(refusals)]),
  });
}

/** Throws the aggregated refusal, so an unsafe start cannot proceed. */
export function assertReviewerPublicationPreflight(
  configuration: ReviewerPublicationConfiguration,
  unresolved: readonly UnresolvedApprovalPresentationSlot[],
): void {
  const result = reviewerPublicationPreflight(configuration, unresolved);
  if (result.ok) return;
  throw new Error(
    `Slack reviewer publication preflight refused this start: ${result.refusals.join(
      '; ',
    )}`,
  );
}
