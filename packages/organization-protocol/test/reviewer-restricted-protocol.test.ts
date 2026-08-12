import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { P256SigningKeyDescriptor } from "@echo-brain/federation-protocol";
import {
  MAX_REVIEWER_CARD_TITLE_SCALARS,
  MAX_REVIEWER_ITEM_TEXT_SCALARS,
  MAX_REVIEWER_RELEASE_ITEMS,
  OrganizationProtocolValidationError,
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_POLICY_ID,
  RESTRICTED_REVIEWER_RECORD_SURFACE,
  createOrganizationRecordReviewerApprovalEnvelope,
  organizationAuthorityPinSha256,
  organizationRecordReviewerIntent,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
  reviewerSignalIdSha256,
  validateOrganizationRecordEnvelope,
  validateOrganizationRecordReviewerApprovalEnvelope,
  validateReviewerReleaseDraft,
  verifyOrganizationAuthorityPin,
} from "../src/index.js";
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordReviewerApprovalEnvelopeV2,
} from "../src/index.js";

const APPROVAL_ID = "a".repeat(64);
const MEETING_ID = "meeting-2026-08-11";
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "enr_00000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "ins_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
const BINDING_ID = "bnd_00000000-0000-4000-8000-000000000001";
const GRANT_ID = "pgr_00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "pcr_00000000-0000-4000-8000-000000000001";
const AUDIT_EVENT_ID = "aud_00000000-0000-4000-8000-000000000001";
const ENVELOPE_ID = "rec_00000000-0000-4000-8000-000000000001";
const EVALUATED_AT = "2026-08-11T12:00:00.000Z";

const digestOf = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

function signingKey(): {
  descriptor: P256SigningKeyDescriptor;
  sign(bytes: Buffer): Promise<Buffer>;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKey)) throw new Error("test key export failed");
  return {
    descriptor: {
      key_id: p256KeyId(publicKey),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicKey.toString("base64"),
    },
    async sign(bytes: Buffer): Promise<Buffer> {
      return normalizeP256LowS(
        signMessage("sha256", bytes, {
          key: pair.privateKey,
          dsaEncoding: "der",
        }),
      );
    },
  };
}

const evidenceSpan = { meeting_id: MEETING_ID, block_id: "block-1" };

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "brief-1",
    meeting: {
      id: MEETING_ID,
      title: "Pricing review",
      participants: [{ id: "participant-1" }],
    },
    decisions: [
      {
        id: "signal-decision-1",
        kind: "decision",
        text: "Ship the reviewer pilot on the eleventh.",
        subject: null,
        confidence: null,
        evidence: [evidenceSpan],
        status: "decided",
      },
    ],
    actions: [
      {
        id: "signal-action-1",
        kind: "action",
        text: "Draft the reviewer runbook.",
        subject: null,
        confidence: null,
        evidence: [evidenceSpan],
        owner: null,
        due_at: null,
      },
    ],
    rationales: [
      {
        id: "signal-rationale-1",
        kind: "rationale",
        text: "The reviewer path is the only proved read.",
        subject: null,
        confidence: null,
        evidence: [evidenceSpan],
        supports_signal_ids: ["signal-decision-1"],
      },
    ],
    provenance: {
      meeting_revision: "revision-1",
      processor: {
        kind: "decision-processor",
        adapter_id: "structured-text",
        instance_id: "default",
        version: "1.0.0",
      },
      generated_at: "2026-08-11T11:00:00.000Z",
    },
    ...overrides,
  };
}

function approvalPayload(
  briefValue: Record<string, unknown> = brief(),
): OrganizationRecordApprovalPayloadV1 {
  return {
    brief: briefValue,
    source: {
      adapter_id: "granola",
      instance_id: "default",
      external_id: "external-1",
    },
    alternatives: [],
    links: null,
    reviewed_at: EVALUATED_AT,
    surface: RESTRICTED_REVIEWER_RECORD_SURFACE,
  } as unknown as OrganizationRecordApprovalPayloadV1;
}

describe("reviewer release draft", () => {
  it("projects decisions, then actions, then rationales in payload order", () => {
    const draft = projectReviewerReleaseDraft({
      approval_id: APPROVAL_ID,
      brief: brief(),
    });
    expect(draft.schema_version).toBe(1);
    expect(draft.kind).toBe("reviewer-release-draft-v1");
    expect(draft.approval_id).toBe(APPROVAL_ID);
    expect(draft.card_title).toBe("Pricing review");
    expect(draft.items.map((item) => item.kind)).toEqual([
      "decision",
      "action",
      "rationale",
    ]);
    expect(draft.items[0]?.signal_id_sha256).toBe(
      sha256Digest("signal-decision-1"),
    );
    expect(reviewerSignalIdSha256("signal-decision-1")).toBe(
      sha256Digest("signal-decision-1"),
    );
    expect(reviewerReleaseDraftSha256(draft)).toBe(canonicalSha256(draft));
  });

  it("falls back to the meeting id when the meeting has no title", () => {
    const untitled = brief({
      meeting: { id: MEETING_ID, participants: [] },
    });
    expect(
      projectReviewerReleaseDraft({ approval_id: APPROVAL_ID, brief: untitled })
        .card_title,
    ).toBe(MEETING_ID);
  });

  it("refuses a package that cannot render as the complete closed card", () => {
    const overLongTitle = brief({
      meeting: {
        id: MEETING_ID,
        title: "t".repeat(MAX_REVIEWER_CARD_TITLE_SCALARS + 1),
        participants: [],
      },
    });
    expect(() =>
      projectReviewerReleaseDraft({
        approval_id: APPROVAL_ID,
        brief: overLongTitle,
      }),
    ).toThrow(OrganizationProtocolValidationError);

    const eleven = brief({
      decisions: Array.from({ length: 11 }, (_unused, index) => ({
        id: `signal-decision-${index}`,
        kind: "decision",
        text: `Decision ${index}.`,
        subject: null,
        confidence: null,
        evidence: [evidenceSpan],
        status: "decided",
      })),
      actions: [],
      rationales: [],
    });
    expect(() =>
      projectReviewerReleaseDraft({ approval_id: APPROVAL_ID, brief: eleven }),
    ).toThrow(`must release 1 to ${MAX_REVIEWER_RELEASE_ITEMS} signals`);

    const emptyBrief = brief({ decisions: [], actions: [], rationales: [] });
    expect(() =>
      projectReviewerReleaseDraft({
        approval_id: APPROVAL_ID,
        brief: emptyBrief,
      }),
    ).toThrow(OrganizationProtocolValidationError);
  });

  it("rejects non-presentable titles, item text, and signal ids", () => {
    for (const mutation of [
      { meeting: { id: MEETING_ID, title: "two\nlines", participants: [] } },
      {
        decisions: [
          {
            id: "signal-decision-1",
            kind: "decision",
            text: " untrimmed ",
            subject: null,
            confidence: null,
            evidence: [evidenceSpan],
            status: "decided",
          },
        ],
        actions: [],
        rationales: [],
      },
      {
        decisions: [
          {
            id: "signal-decision-1",
            kind: "decision",
            text: "x".repeat(MAX_REVIEWER_ITEM_TEXT_SCALARS + 1),
            subject: null,
            confidence: null,
            evidence: [evidenceSpan],
            status: "decided",
          },
        ],
        actions: [],
        rationales: [],
      },
      {
        decisions: [
          {
            // The escape, not a literal NUL byte: the runtime value is the
            // same, but the source stays text a reviewer can read and a tool
            // can diff.
            id: "signal\u0000id",
            kind: "decision",
            text: "Fine.",
            subject: null,
            confidence: null,
            evidence: [evidenceSpan],
            status: "decided",
          },
        ],
        actions: [],
        rationales: [],
      },
    ]) {
      expect(() =>
        projectReviewerReleaseDraft({
          approval_id: APPROVAL_ID,
          brief: brief(mutation),
        }),
      ).toThrow(OrganizationProtocolValidationError);
    }
  });

  it("rejects duplicate raw signal ids and duplicate digests", () => {
    const duplicated = brief({
      actions: [
        {
          id: "signal-decision-1",
          kind: "action",
          text: "Duplicate identity.",
          subject: null,
          confidence: null,
          evidence: [evidenceSpan],
          owner: null,
          due_at: null,
        },
      ],
      rationales: [],
    });
    expect(() =>
      projectReviewerReleaseDraft({
        approval_id: APPROVAL_ID,
        brief: duplicated,
      }),
    ).toThrow("source signal ids must be unique");

    const draft = projectReviewerReleaseDraft({
      approval_id: APPROVAL_ID,
      brief: brief(),
    });
    expect(() =>
      validateReviewerReleaseDraft({
        ...draft,
        items: [draft.items[0], draft.items[0]],
      }),
    ).toThrow("signal digests must be unique");
  });

  it("rejects extra, missing, and unknown draft keys", () => {
    const draft = projectReviewerReleaseDraft({
      approval_id: APPROVAL_ID,
      brief: brief(),
    });
    expect(() =>
      validateReviewerReleaseDraft({ ...draft, extra: true }),
    ).toThrow("has an unexpected shape");
    expect(() =>
      validateReviewerReleaseDraft({
        ...draft,
        items: [{ ...draft.items[0], extra: true }],
      }),
    ).toThrow("has an unexpected shape");
    expect(() =>
      validateReviewerReleaseDraft({ ...draft, kind: "other" }),
    ).toThrow("kind is unsupported");
  });
});

describe("reviewer approval presentation", () => {
  const draft = projectReviewerReleaseDraft({
    approval_id: APPROVAL_ID,
    brief: brief(),
  });
  const presentation = reviewerApprovalPresentation({
    draft,
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
  });

  it("renders the complete closed card with no truncation or hidden item", () => {
    expect(presentation.transport).toEqual({
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(presentation.blocks).toHaveLength(draft.items.length + 3);
    expect(presentation.blocks[0]).toEqual({
      type: "header",
      block_id: `echo-approval-${APPROVAL_ID}-title-v1`,
      text: { type: "plain_text", text: "Pricing review", emoji: false },
    });
    draft.items.forEach((item, index) => {
      expect(presentation.blocks[index + 1]).toEqual({
        type: "section",
        block_id: `echo-approval-${APPROVAL_ID}-item-${index}-${item.signal_id_sha256.slice(
          "sha256:".length,
        )}-v1`,
        text: {
          type: "plain_text",
          text: `${item.kind}: ${item.text}`,
          emoji: false,
        },
      });
    });
    expect(presentation.blocks.at(-2)).toEqual({
      type: "section",
      block_id: `echo-approval-${APPROVAL_ID}-reviewer-policy-v1`,
      text: {
        type: "plain_text",
        text: RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
        emoji: false,
      },
    });
    expect(presentation.blocks.at(-1)).toEqual({
      type: "context",
      block_id: `echo-approval-${APPROVAL_ID}-reaction-v1`,
      elements: [
        {
          type: "mrkdwn",
          text: "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
          verbatim: false,
        },
      ],
    });
  });

  it("joins the accessibility fallback with LF and no trailing newline", () => {
    expect(presentation.text).toBe(
      [
        "Decision brief awaiting approval.",
        "Title: Pricing review",
        "decision: Ship the reviewer pilot on the eleventh.",
        "action: Draft the reviewer runbook.",
        "rationale: The reviewer path is the only proved read.",
        RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
        "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread before reacting.",
      ].join("\n"),
    );
    expect(presentation.text.endsWith("\n")).toBe(false);
    expect(reviewerApprovalPresentationSha256(presentation)).toBe(
      canonicalSha256(presentation),
    );
  });

  it("requires a distinct, well-formed reaction pair", () => {
    for (const pair of [
      { approve_reaction: "same", reject_reaction: "same" },
      { approve_reaction: "Upper", reject_reaction: "x" },
      { approve_reaction: "", reject_reaction: "x" },
      { approve_reaction: "a".repeat(65), reject_reaction: "x" },
    ]) {
      expect(() =>
        reviewerApprovalPresentation({ draft, ...pair }),
      ).toThrow(OrganizationProtocolValidationError);
    }
  });
});

describe("reviewer envelope v2", () => {
  const authority = signingKey();
  const installation = signingKey();
  const descriptor: OrganizationAuthorityDescriptorV1 = {
    schema_version: 1,
    kind: "echo-organization-authority",
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    signing_key: authority.descriptor,
  };
  const pinnedAuthority = verifyOrganizationAuthorityPin(
    descriptor,
    organizationAuthorityPinSha256(descriptor),
  );
  const draft = projectReviewerReleaseDraft({
    approval_id: APPROVAL_ID,
    brief: brief(),
  });
  const semanticSha256 = digestOf("1");

  function reviewer(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      reviewed_by: "Reviewer One",
      authorization: {
        schema_version: 2,
        kind: "echo-organization-authorization-evidence",
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        enrollment_id: ENROLLMENT_ID,
        installation_id: INSTALLATION_ID,
        request_id: REQUEST_ID,
        approval_id: APPROVAL_ID,
        action: "approve",
        request_sha256: digestOf("2"),
        provider_event_sha256: digestOf("3"),
        allowed: true,
        reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
        principal_id: PRINCIPAL_ID,
        membership_id: MEMBERSHIP_ID,
        adapter_binding_id: BINDING_ID,
        permission_grant_id: GRANT_ID,
        evaluated_at: EVALUATED_AT,
        authorization_audit_event_id: AUDIT_EVENT_ID,
        authorization_audit_entry_sha256: digestOf("4"),
        reviewer_release_draft_sha256: reviewerReleaseDraftSha256(draft),
        approval_presentation_sha256: digestOf("5"),
        semantic_intent_sha256: semanticSha256,
        message_presentation_sha256: digestOf("6"),
        ...overrides,
      },
    };
  }

  async function buildValid(): Promise<OrganizationRecordReviewerApprovalEnvelopeV2> {
    return createOrganizationRecordReviewerApprovalEnvelope(
      {
        envelope_id: ENVELOPE_ID,
        idempotency_key: APPROVAL_ID,
        payload: approvalPayload(),
        reviewer: reviewer() as never,
        intent: organizationRecordReviewerIntent(semanticSha256),
        submitter: {
          installation_id: INSTALLATION_ID,
          submitted_at: "2026-08-11T12:00:01.000Z",
        },
        installation_signing_key: installation.descriptor,
      },
      pinnedAuthority,
      installation.sign,
    );
  }

  it("signs, validates, and dispatches one reviewer approval", async () => {
    const envelope = await buildValid();
    expect(envelope.schema_version).toBe(2);
    expect(envelope.event_type).toBe("approval");
    expect(envelope.intent).toEqual({
      schema_version: 1,
      visibility: "restricted",
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      provenance: {
        kind: "approval-surface-confirmation-v1",
        semantic_intent_sha256: semanticSha256,
      },
    });
    const dispatched = validateOrganizationRecordEnvelope(envelope);
    expect(dispatched.schema_version).toBe(2);
    expect(validateOrganizationRecordReviewerApprovalEnvelope(envelope)).toEqual(
      envelope,
    );
  });

  it("halts unknown kinds and versions instead of falling back", async () => {
    const envelope = await buildValid();
    expect(() =>
      validateOrganizationRecordEnvelope({ ...envelope, schema_version: 3 }),
    ).toThrow("schema_version is unsupported");
    expect(() =>
      validateOrganizationRecordEnvelope({
        ...envelope,
        kind: "echo-other-envelope",
      }),
    ).toThrow("kind is unsupported");
    expect(() =>
      validateOrganizationRecordEnvelope({
        ...envelope,
        event_type: "rejection",
      }),
    ).toThrow("schema version 2 admits approval only");
  });

  it("rejects hidden properties instead of admitting an apparently closed envelope", async () => {
    const envelope = await buildValid();
    const withHiddenField = { ...envelope } as Record<string, unknown>;
    Object.defineProperty(withHiddenField, "hidden_content", {
      value: "must never be ignored",
      enumerable: false,
    });

    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope(withHiddenField),
    ).toThrow("must contain only enumerable data properties");
  });

  it("binds payload, intent, reviewer, and action time to the authority proof", async () => {
    const envelope = await buildValid();
    const withPayload = (
      patch: Record<string, unknown>,
    ): Record<string, unknown> => ({
      ...envelope,
      payload: { ...envelope.payload, ...patch },
    });
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope(
        withPayload({ surface: "slack-reactions" }),
      ),
    ).toThrow(`payload surface must be ${RESTRICTED_REVIEWER_RECORD_SURFACE}`);
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope(
        withPayload({ reviewed_at: "2026-08-11T12:00:05.000Z" }),
      ),
    ).toThrow("reviewed_at must be the authority evaluation time");
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope({
        ...envelope,
        submitter: {
          installation_id: INSTALLATION_ID,
          submitted_at: "2026-08-11T11:59:59.000Z",
        },
      }),
    ).toThrow("submitted_at precedes the approval");
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope({
        ...envelope,
        intent: organizationRecordReviewerIntent(digestOf("9")),
      }),
    ).toThrow("does not quote the authorized semantic intent");

    const otherBrief = brief({
      decisions: [
        {
          id: "signal-decision-1",
          kind: "decision",
          text: "A different decision.",
          subject: null,
          confidence: null,
          evidence: [evidenceSpan],
          status: "decided",
        },
      ],
    });
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope({
        ...envelope,
        payload: { ...approvalPayload(otherBrief) },
      }),
    ).toThrow("does not reproduce the approved release draft");
  });

  it("requires the closed reviewer reason and rejects it in schema v1", async () => {
    const envelope = await buildValid();
    expect(() =>
      validateOrganizationRecordReviewerApprovalEnvelope({
        ...envelope,
        reviewer: {
          ...envelope.reviewer,
          authorization: {
            ...envelope.reviewer.authorization,
            reason_code: "active_membership_and_direct_grant",
          },
        },
      }),
    ).toThrow("reason_code is unsupported");

    expect(() =>
      validateOrganizationRecordEnvelope({
        schema_version: 1,
        kind: "echo-organization-record-envelope",
        event_type: "approval",
        envelope_id: ENVELOPE_ID,
        idempotency_key: APPROVAL_ID,
        payload: approvalPayload(),
        reviewer: {
          principal_id: PRINCIPAL_ID,
          membership_id: MEMBERSHIP_ID,
          reviewed_by: "Reviewer One",
          authorization: {
            schema_version: 1,
            kind: "echo-organization-authorization-evidence",
            authority_id: AUTHORITY_ID,
            organization_id: ORGANIZATION_ID,
            enrollment_id: ENROLLMENT_ID,
            installation_id: INSTALLATION_ID,
            request_id: REQUEST_ID,
            approval_id: APPROVAL_ID,
            action: "approve",
            request_sha256: digestOf("2"),
            provider_event_sha256: digestOf("3"),
            allowed: true,
            reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
            principal_id: PRINCIPAL_ID,
            membership_id: MEMBERSHIP_ID,
            adapter_binding_id: BINDING_ID,
            permission_grant_id: GRANT_ID,
            evaluated_at: EVALUATED_AT,
          },
        },
        intent: { restricted: true, reconsider_after: null },
        submitter: {
          installation_id: INSTALLATION_ID,
          submitted_at: "2026-08-11T12:00:01.000Z",
        },
        integrity: envelope.integrity,
      }),
    ).toThrow(`${RESTRICTED_REVIEWER_ALLOW_REASON_CODE} requires schema version 2`);
  });
});
