import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
} from '@echo-brain/organization-protocol';

/**
 * The one local reviewer card renderer.
 *
 * The Slack adapter imports no protocol package, so the composition root
 * injects this. Both digests are produced by the same deterministic projection
 * the envelope builder, Authority's live-card reconstruction, and ingest use,
 * which is what lets a post retry, a poll, and an action request all agree on
 * the exact bytes the reviewer saw.
 */
export interface ReviewerPresentationRendering {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
  readonly reviewer_release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
}

export interface ReviewerPresentationRenderInput {
  readonly approvalId: string;
  readonly brief: unknown;
  readonly approveReaction: string;
  readonly rejectReaction: string;
}

export function renderReviewerApprovalPresentation(
  input: ReviewerPresentationRenderInput,
): ReviewerPresentationRendering {
  const draft = projectReviewerReleaseDraft({
    approval_id: input.approvalId,
    brief: input.brief,
  });
  const presentation = reviewerApprovalPresentation({
    draft,
    approve_reaction: input.approveReaction,
    reject_reaction: input.rejectReaction,
  });
  return Object.freeze({
    text: presentation.text,
    blocks: presentation.blocks as unknown as readonly Record<
      string,
      unknown
    >[],
    reviewer_release_draft_sha256: reviewerReleaseDraftSha256(draft),
    approval_presentation_sha256:
      reviewerApprovalPresentationSha256(presentation),
  });
}

/**
 * Detects an in-place secret rotation without persisting the token. The
 * fingerprint is local-only and never leaves this machine.
 */
export function reviewerCredentialFingerprintSha256(token: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Slack reviewer credential value is unavailable');
  }
  return canonicalSha256({
    schema_version: 1,
    kind: 'slack-credential-fingerprint-v1',
    token,
  });
}

/** The port shape the Slack approval surface declares structurally. */
export const reviewerApprovalPresentationRenderer = Object.freeze({
  render: renderReviewerApprovalPresentation,
  credentialFingerprint: reviewerCredentialFingerprintSha256,
});
