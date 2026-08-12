import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  MAX_REVIEWER_CARD_TITLE_SCALARS,
  MAX_REVIEWER_ITEM_TEXT_SCALARS,
  MAX_REVIEWER_RELEASE_ITEMS,
  assertReviewerApprovalId,
  assertReviewerItemKind,
  assertReviewerPresentableText,
  assertReviewerSignalId,
  type ReviewerReleaseItemKindV1,
} from "./reviewer-restricted-policy.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertLiteral,
  canonicalSnapshot,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const REVIEWER_RELEASE_DRAFT_KIND = "reviewer-release-draft-v1";

export interface ReviewerReleaseDraftItemV1 {
  signal_id_sha256: Sha256Digest;
  kind: ReviewerReleaseItemKindV1;
  text: string;
}

/**
 * The complete package a reviewer is asked to approve, reprojected identically
 * by the publisher, the renderer, the action authorizer, Authority's live-card
 * reconstruction, the envelope builder, and ingest. It carries no meeting id,
 * participant, evidence, subject, confidence, or raw signal identity.
 */
export interface ReviewerReleaseDraftV1 {
  schema_version: 1;
  kind: typeof REVIEWER_RELEASE_DRAFT_KIND;
  approval_id: string;
  card_title: string;
  items: readonly ReviewerReleaseDraftItemV1[];
}

/** The lowercase SHA-256 digest of the exact UTF-8 bytes of a raw signal id. */
export function reviewerSignalIdSha256(signalId: string): Sha256Digest {
  assertReviewerSignalId(signalId, "reviewer release draft signal id");
  return sha256Digest(signalId);
}

export function reviewerReleaseDraftSha256(
  draft: ReviewerReleaseDraftV1,
): Sha256Digest {
  return canonicalSha256(draft);
}

function assertDraftItems(
  value: unknown,
  label: string,
): readonly ReviewerReleaseDraftItemV1[] {
  if (!Array.isArray(value)) {
    organizationProtocolValidationFailure(`${label} must be an array`);
  }
  const items = value as unknown[];
  if (items.length < 1 || items.length > MAX_REVIEWER_RELEASE_ITEMS) {
    organizationProtocolValidationFailure(
      `${label} must contain 1 to ${MAX_REVIEWER_RELEASE_ITEMS} items`,
    );
  }
  const digests = new Set<string>();
  return items.map((entry, index) => {
    const item = asRecord(entry, `${label}[${index}]`);
    assertExactKeys(
      item,
      ["signal_id_sha256", "kind", "text"],
      `${label}[${index}]`,
    );
    assertDigest(item.signal_id_sha256, `${label}[${index}].signal_id_sha256`);
    if (digests.has(item.signal_id_sha256 as string)) {
      organizationProtocolValidationFailure(
        `${label} signal digests must be unique`,
      );
    }
    digests.add(item.signal_id_sha256 as string);
    assertReviewerItemKind(item.kind, `${label}[${index}].kind`);
    assertReviewerPresentableText(
      item.text,
      `${label}[${index}].text`,
      MAX_REVIEWER_ITEM_TEXT_SCALARS,
    );
    return item as unknown as ReviewerReleaseDraftItemV1;
  });
}

const DRAFT_LABEL = "reviewer release draft";

export function validateReviewerReleaseDraft(
  value: unknown,
): ReviewerReleaseDraftV1 {
  const draft = asRecord(canonicalSnapshot(value, DRAFT_LABEL), DRAFT_LABEL);
  assertExactKeys(
    draft,
    ["schema_version", "kind", "approval_id", "card_title", "items"],
    DRAFT_LABEL,
  );
  assertLiteral(draft.schema_version, 1, `${DRAFT_LABEL} schema_version`);
  assertLiteral(draft.kind, REVIEWER_RELEASE_DRAFT_KIND, `${DRAFT_LABEL} kind`);
  assertReviewerApprovalId(draft.approval_id, `${DRAFT_LABEL} approval_id`);
  assertReviewerPresentableText(
    draft.card_title,
    `${DRAFT_LABEL} card_title`,
    MAX_REVIEWER_CARD_TITLE_SCALARS,
  );
  assertDraftItems(draft.items, `${DRAFT_LABEL} items`);
  return draft as unknown as ReviewerReleaseDraftV1;
}

/**
 * The structural view of the approved brief this projection reads. The full
 * shape is validated by the payload validator; only these fields participate
 * in the released package.
 */
export interface ReviewerReleaseDraftSourceSignalV1 {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface ReviewerReleaseDraftSourceBriefV1 {
  readonly meeting: { readonly id: string; readonly title?: string | undefined };
  readonly decisions: readonly ReviewerReleaseDraftSourceSignalV1[];
  readonly actions: readonly ReviewerReleaseDraftSourceSignalV1[];
  readonly rationales: readonly ReviewerReleaseDraftSourceSignalV1[];
}

export interface ProjectReviewerReleaseDraftInput {
  readonly approval_id: string;
  readonly brief: ReviewerReleaseDraftSourceBriefV1 | unknown;
}

function collectSourceSignals(
  brief: Record<string, unknown>,
): { signal: Record<string, unknown>; label: string }[] {
  const collected: { signal: Record<string, unknown>; label: string }[] = [];
  for (const collection of ["decisions", "actions", "rationales"] as const) {
    const value = brief[collection];
    if (!Array.isArray(value)) {
      organizationProtocolValidationFailure(
        `${DRAFT_LABEL} source ${collection} must be an array`,
      );
    }
    (value as unknown[]).forEach((entry, index) => {
      collected.push({
        signal: asRecord(entry, `${DRAFT_LABEL} source ${collection}[${index}]`),
        label: `${DRAFT_LABEL} source ${collection}[${index}]`,
      });
    });
  }
  return collected;
}

/**
 * The sole projection from an approved brief to the released package. Draft
 * order is exactly the canonical projector order: decisions in payload order,
 * then actions in payload order, then rationales in payload order.
 *
 * A brief that cannot produce a complete closed card -- more than ten released
 * signals, an over-long or non-presentable title or item, a duplicate raw
 * signal id, or a signal-digest collision -- is not eligible for reviewer V1
 * and fails here rather than being truncated, summarized, or elided.
 */
export function projectReviewerReleaseDraft(
  input: ProjectReviewerReleaseDraftInput,
): ReviewerReleaseDraftV1 {
  assertReviewerApprovalId(input.approval_id, `${DRAFT_LABEL} approval_id`);
  const brief = asRecord(input.brief, `${DRAFT_LABEL} source brief`);
  const meeting = asRecord(brief.meeting, `${DRAFT_LABEL} source meeting`);
  const title = meeting.title ?? meeting.id;
  assertReviewerPresentableText(
    title,
    `${DRAFT_LABEL} card_title`,
    MAX_REVIEWER_CARD_TITLE_SCALARS,
  );

  const sources = collectSourceSignals(brief);
  if (sources.length < 1 || sources.length > MAX_REVIEWER_RELEASE_ITEMS) {
    organizationProtocolValidationFailure(
      `${DRAFT_LABEL} must release 1 to ${MAX_REVIEWER_RELEASE_ITEMS} signals`,
    );
  }
  const rawIds = new Set<string>();
  const items = sources.map(({ signal, label }) => {
    assertReviewerSignalId(signal.id, `${label}.id`);
    if (rawIds.has(signal.id as string)) {
      organizationProtocolValidationFailure(
        `${DRAFT_LABEL} source signal ids must be unique`,
      );
    }
    rawIds.add(signal.id as string);
    assertReviewerItemKind(signal.kind, `${label}.kind`);
    assertReviewerPresentableText(
      signal.text,
      `${label}.text`,
      MAX_REVIEWER_ITEM_TEXT_SCALARS,
    );
    return {
      signal_id_sha256: sha256Digest(signal.id as string),
      kind: signal.kind as ReviewerReleaseItemKindV1,
      text: signal.text as string,
    };
  });

  return validateReviewerReleaseDraft({
    schema_version: 1,
    kind: REVIEWER_RELEASE_DRAFT_KIND,
    approval_id: input.approval_id,
    card_title: title as string,
    items,
  });
}
