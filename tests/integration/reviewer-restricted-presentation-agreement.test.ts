import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_POLICY_ID,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
} from '@echo-brain/organization-protocol';
import {
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT as CONTROL_PLANE_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_POLICY_ID as CONTROL_PLANE_POLICY_ID,
} from '@echo-brain/organization-control-plane';
import { reconstructReviewerCard } from '../../services/organization-control-plane/src/adapters/slack/reviewer-card-grammar.js';
import {
  renderReviewerApprovalPresentation,
  reviewerCredentialFingerprintSha256,
} from '../../src/product/organization/record/adapters/reviewer-presentation-renderer.js';

/**
 * The member renders the card from the protocol package; the Authority
 * reconstructs it from the live Slack message with the control plane's own
 * independent implementation. Neither imports the other, so this suite is the
 * only thing that keeps the two byte-identical -- and `INV-12` depends on it:
 * a package is authorized only when the human-visible consequence and the
 * complete release draft hash the same on both sides.
 */

const APPROVAL_ID = 'c'.repeat(64);
const MEETING_ID = 'meeting-reviewer-agreement';

const evidence = { meeting_id: MEETING_ID, block_id: 'block-1' };

function brief(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'brief-1',
    meeting: {
      id: MEETING_ID,
      title: 'Reviewer agreement review',
      participants: [],
    },
    decisions: [
      {
        id: 'signal-decision-1',
        kind: 'decision',
        text: 'Adopt restricted-reviewer-v1 for the pilot package.',
        subject: null,
        confidence: null,
        evidence: [evidence],
        status: 'decided',
      },
    ],
    actions: [
      {
        id: 'signal-action-1',
        kind: 'action',
        text: 'Publish the reviewer runbook before the founder-live gate.',
        subject: null,
        confidence: null,
        evidence: [evidence],
        owner: null,
        due_at: null,
      },
    ],
    rationales: [
      {
        id: 'signal-rationale-1',
        kind: 'rationale',
        text: 'Self-retrieval is the only proved read in V1.',
        subject: null,
        confidence: null,
        evidence: [evidence],
        supports_signal_ids: ['signal-decision-1'],
      },
    ],
    provenance: {
      meeting_revision: 'revision-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: '2026-08-11T11:00:00.000Z',
    },
  };
}

describe('reviewer presentation agreement', () => {
  const draft = projectReviewerReleaseDraft({
    approval_id: APPROVAL_ID,
    brief: brief(),
  });
  const presentation = reviewerApprovalPresentation({
    draft,
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
  });

  it('pins the policy identifier and consequence across both packages', () => {
    expect(CONTROL_PLANE_POLICY_ID).toBe(RESTRICTED_REVIEWER_POLICY_ID);
    expect(CONTROL_PLANE_CONSEQUENCE_TEXT).toBe(
      RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
    );
  });

  it('reconstructs the rendered card to the same two digests', () => {
    const reconstructed = reconstructReviewerCard({
      approval_id: APPROVAL_ID,
      blocks: presentation.blocks as readonly unknown[],
      fallback_text: presentation.text,
    });
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.approve_reaction).toBe(
      presentation.approve_reaction,
    );
    expect(reconstructed?.reject_reaction).toBe(presentation.reject_reaction);
    expect(reconstructed?.reviewer_release_draft_sha256).toBe(
      reviewerReleaseDraftSha256(draft),
    );
    expect(reconstructed?.approval_presentation_sha256).toBe(
      reviewerApprovalPresentationSha256(presentation),
    );
  });

  it('refuses a card whose item text, order, or consequence changed', () => {
    const mutations: readonly (readonly unknown[])[] = [
      // One item's text edited after publication.
      presentation.blocks.map((block, index) =>
        index === 1
          ? {
              ...block,
              text: {
                type: 'plain_text',
                text: 'decision: Adopt something else entirely.',
                emoji: false,
              },
            }
          : block,
      ),
      // Two items transposed.
      [
        presentation.blocks[0],
        presentation.blocks[2],
        presentation.blocks[1],
        ...presentation.blocks.slice(3),
      ],
      // The consequence sentence weakened.
      presentation.blocks.map((block, index) =>
        index === presentation.blocks.length - 2
          ? {
              ...block,
              text: {
                type: 'plain_text',
                text: 'Approving records this package.',
                emoji: false,
              },
            }
          : block,
      ),
    ];
    for (const [index, blocks] of mutations.entries()) {
      const reconstructed = reconstructReviewerCard({
        approval_id: APPROVAL_ID,
        blocks,
        fallback_text: presentation.text,
      });
      expect(reconstructed, `mutation ${index}`).toBeNull();
    }
  });

  it('renders through the production renderer and fingerprints the credential exactly', () => {
    const rendered = renderReviewerApprovalPresentation({
      approvalId: APPROVAL_ID,
      brief: brief(),
      approveReaction: 'white_check_mark',
      rejectReaction: 'x',
    });
    expect(rendered.text).toBe(presentation.text);
    expect(rendered.reviewer_release_draft_sha256).toBe(
      reviewerReleaseDraftSha256(draft),
    );
    expect(rendered.approval_presentation_sha256).toBe(
      reviewerApprovalPresentationSha256(presentation),
    );
    expect(
      reconstructReviewerCard({
        approval_id: APPROVAL_ID,
        blocks: rendered.blocks,
        fallback_text: rendered.text,
      })?.approval_presentation_sha256,
    ).toBe(rendered.approval_presentation_sha256);

    // The fingerprint is exactly the contract's preimage, and the token never
    // appears in its output.
    expect(reviewerCredentialFingerprintSha256('xoxb-secret')).toBe(
      canonicalSha256({
        schema_version: 1,
        kind: 'slack-credential-fingerprint-v1',
        token: 'xoxb-secret',
      }),
    );
    expect(() => reviewerCredentialFingerprintSha256('')).toThrow(
      /credential value is unavailable/,
    );
  });

  it('refuses a card presented under another approval identity', () => {
    expect(
      reconstructReviewerCard({
        approval_id: 'd'.repeat(64),
        blocks: presentation.blocks as readonly unknown[],
        fallback_text: presentation.text,
      }),
    ).toBeNull();
  });
});
