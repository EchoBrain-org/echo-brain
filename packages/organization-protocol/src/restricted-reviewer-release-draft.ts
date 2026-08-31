import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  MAX_RESTRICTED_REVIEWER_CARD_TITLE_SCALARS,
  MAX_RESTRICTED_REVIEWER_ITEM_TEXT_SCALARS,
  MAX_RESTRICTED_REVIEWER_RELEASE_ITEMS,
  assertRestrictedReviewerApprovalId,
  assertRestrictedReviewerItemKind,
  assertRestrictedReviewerPresentableText,
  assertRestrictedReviewerSignalId,
  type RestrictedReviewerReleaseItemKindV1,
} from "./restricted-reviewer-slack-reaction-approval-policy.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertLiteral,
  canonicalSnapshot,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const RESTRICTED_REVIEWER_RELEASE_DRAFT_KIND =
  "reviewer-release-draft-v1";

export interface RestrictedReviewerReleaseDraftItemV1 {
  signal_id_sha256: Sha256Digest;
  kind: RestrictedReviewerReleaseItemKindV1;
  text: string;
}

/**
 * The complete package a restricted reviewer is asked to approve, reprojected
 * identically by the publisher, the renderer, the action authorizer,
 * Authority's published-card reconstruction, the envelope builder, and ingest.
 * It carries no meeting id, participant, evidence, subject, confidence, or raw
 * signal identity.
 */
export interface RestrictedReviewerReleaseDraftV1 {
  schema_version: 1;
  kind: typeof RESTRICTED_REVIEWER_RELEASE_DRAFT_KIND;
  approval_id: string;
  card_title: string;
  items: readonly RestrictedReviewerReleaseDraftItemV1[];
}

/** The lowercase SHA-256 digest of the exact UTF-8 bytes of a raw signal id. */
export function restrictedReviewerSignalIdSha256(
  signalId: string,
): Sha256Digest {
  assertRestrictedReviewerSignalId(
    signalId,
    "reviewer release draft signal id",
  );
  return sha256Digest(signalId);
}

export function restrictedReviewerReleaseDraftSha256(
  draft: RestrictedReviewerReleaseDraftV1,
): Sha256Digest {
  return canonicalSha256(draft);
}

function assertDraftItems(
  value: unknown,
  label: string,
): readonly RestrictedReviewerReleaseDraftItemV1[] {
  if (!Array.isArray(value)) {
    organizationProtocolValidationFailure(`${label} must be an array`);
  }
  const items = value as unknown[];
  if (
    items.length < 1 ||
    items.length > MAX_RESTRICTED_REVIEWER_RELEASE_ITEMS
  ) {
    organizationProtocolValidationFailure(
      `${label} must contain 1 to ${MAX_RESTRICTED_REVIEWER_RELEASE_ITEMS} items`,
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
    assertRestrictedReviewerItemKind(item.kind, `${label}[${index}].kind`);
    assertRestrictedReviewerPresentableText(
      item.text,
      `${label}[${index}].text`,
      MAX_RESTRICTED_REVIEWER_ITEM_TEXT_SCALARS,
    );
    return item as unknown as RestrictedReviewerReleaseDraftItemV1;
  });
}

const DRAFT_LABEL = "reviewer release draft";

export function validateRestrictedReviewerReleaseDraft(
  value: unknown,
): RestrictedReviewerReleaseDraftV1 {
  const draft = asRecord(canonicalSnapshot(value, DRAFT_LABEL), DRAFT_LABEL);
  assertExactKeys(
    draft,
    ["schema_version", "kind", "approval_id", "card_title", "items"],
    DRAFT_LABEL,
  );
  assertLiteral(draft.schema_version, 1, `${DRAFT_LABEL} schema_version`);
  assertLiteral(
    draft.kind,
    RESTRICTED_REVIEWER_RELEASE_DRAFT_KIND,
    `${DRAFT_LABEL} kind`,
  );
  assertRestrictedReviewerApprovalId(
    draft.approval_id,
    `${DRAFT_LABEL} approval_id`,
  );
  assertRestrictedReviewerPresentableText(
    draft.card_title,
    `${DRAFT_LABEL} card_title`,
    MAX_RESTRICTED_REVIEWER_CARD_TITLE_SCALARS,
  );
  assertDraftItems(draft.items, `${DRAFT_LABEL} items`);
  return draft as unknown as RestrictedReviewerReleaseDraftV1;
}

/**
 * The structural view of the approved brief this projection reads. The full
 * shape is validated by the payload validator; only these fields participate
 * in the released package.
 */
export interface RestrictedReviewerReleaseDraftSourceSignalV1 {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface RestrictedReviewerReleaseDraftSourceBriefV1 {
  readonly meeting: { readonly id: string; readonly title?: string | undefined };
  readonly decisions: readonly RestrictedReviewerReleaseDraftSourceSignalV1[];
  readonly actions: readonly RestrictedReviewerReleaseDraftSourceSignalV1[];
  readonly rationales: readonly RestrictedReviewerReleaseDraftSourceSignalV1[];
}

export interface ProjectRestrictedReviewerReleaseDraftInput {
  readonly approval_id: string;
  readonly brief: RestrictedReviewerReleaseDraftSourceBriefV1 | unknown;
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
export function projectRestrictedReviewerReleaseDraft(
  input: ProjectRestrictedReviewerReleaseDraftInput,
): RestrictedReviewerReleaseDraftV1 {
  assertRestrictedReviewerApprovalId(
    input.approval_id,
    `${DRAFT_LABEL} approval_id`,
  );
  const brief = asRecord(input.brief, `${DRAFT_LABEL} source brief`);
  const meeting = asRecord(brief.meeting, `${DRAFT_LABEL} source meeting`);
  const title = meeting.title ?? meeting.id;
  assertRestrictedReviewerPresentableText(
    title,
    `${DRAFT_LABEL} card_title`,
    MAX_RESTRICTED_REVIEWER_CARD_TITLE_SCALARS,
  );

  const sources = collectSourceSignals(brief);
  if (
    sources.length < 1 ||
    sources.length > MAX_RESTRICTED_REVIEWER_RELEASE_ITEMS
  ) {
    organizationProtocolValidationFailure(
      `${DRAFT_LABEL} must release 1 to ${MAX_RESTRICTED_REVIEWER_RELEASE_ITEMS} signals`,
    );
  }
  const rawIds = new Set<string>();
  const items = sources.map(({ signal, label }) => {
    assertRestrictedReviewerSignalId(signal.id, `${label}.id`);
    if (rawIds.has(signal.id as string)) {
      organizationProtocolValidationFailure(
        `${DRAFT_LABEL} source signal ids must be unique`,
      );
    }
    rawIds.add(signal.id as string);
    assertRestrictedReviewerItemKind(signal.kind, `${label}.kind`);
    assertRestrictedReviewerPresentableText(
      signal.text,
      `${label}.text`,
      MAX_RESTRICTED_REVIEWER_ITEM_TEXT_SCALARS,
    );
    return {
      signal_id_sha256: sha256Digest(signal.id as string),
      kind: signal.kind as RestrictedReviewerReleaseItemKindV1,
      text: signal.text as string,
    };
  });

  return validateRestrictedReviewerReleaseDraft({
    schema_version: 1,
    kind: RESTRICTED_REVIEWER_RELEASE_DRAFT_KIND,
    approval_id: input.approval_id,
    card_title: title as string,
    items,
  });
}
