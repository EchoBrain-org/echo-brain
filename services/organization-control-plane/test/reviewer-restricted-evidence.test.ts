import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openAndMigrateOrganizationControlDatabase } from "../src/persistence/open-database.js";
import { OrganizationIntegrationsRepository } from "../src/persistence/organization-integrations-repository.js";
import {
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_POLICY_ID,
  reviewerMessagePresentationPreimage,
  reviewerRestrictedAuditDetail,
  reviewerRestrictedSemanticPreimage,
} from "../src/application/reviewer-restricted-policy.js";
import { reconstructReviewerCard } from "../src/adapters/slack/reviewer-card-grammar.js";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";
import type {
  ReviewerAuthorizationEvidenceExpectation,
  RecordReviewerPermissionDecisionInput,
} from "../src/application/contracts.js";

const NOW = "2026-08-11T12:00:00.000Z";
const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "ins_77777777-7777-4777-8777-777777777777";
const PRINCIPAL_ID = "prn_33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "mem_44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "pcr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDENTITY_LINK_ID = "idm_88888888-8888-4888-8888-888888888888";
const CONNECTION_ID = "con_99999999-9999-4999-8999-999999999999";
const ADAPTER_BINDING_ID = "bnd_55555555-5555-4555-8555-555555555555";
const PERMISSION_GRANT_ID = "pgr_66666666-6666-4666-8666-666666666666";
const APPROVAL_ID = "f".repeat(64);
const SIGNAL_DIGEST_HEX = "a".repeat(64);

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function openRepository(): {
  repository: OrganizationIntegrationsRepository;
  database: Database.Database;
} {
  const database = openAndMigrateOrganizationControlDatabase(":memory:");
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, digest("authority"), NOW);
  return {
    repository: new OrganizationIntegrationsRepository(database, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
    }),
    database,
  };
}

const CARD_TITLE = "Pricing review";
const ITEM_TEXT = "Ship the reviewer pilot on the eleventh.";

function reviewerBlocks(): unknown[] {
  return [
    {
      type: "header",
      block_id: `echo-approval-${APPROVAL_ID}-title-v1`,
      text: { type: "plain_text", text: CARD_TITLE, emoji: false },
    },
    {
      type: "section",
      block_id: `echo-approval-${APPROVAL_ID}-item-0-${SIGNAL_DIGEST_HEX}-v1`,
      text: {
        type: "plain_text",
        text: `decision: ${ITEM_TEXT}`,
        emoji: false,
      },
    },
    {
      type: "section",
      block_id: `echo-approval-${APPROVAL_ID}-reviewer-policy-v1`,
      text: {
        type: "plain_text",
        text: RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
        emoji: false,
      },
    },
    {
      type: "context",
      block_id: `echo-approval-${APPROVAL_ID}-reaction-v1`,
      elements: [
        {
          type: "mrkdwn",
          text: "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
          verbatim: false,
        },
      ],
    },
  ];
}

const FALLBACK_TEXT = [
  "Decision brief awaiting approval.",
  `Title: ${CARD_TITLE}`,
  `decision: ${ITEM_TEXT}`,
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread before reacting.",
].join("\n");

describe("reviewer card grammar", () => {
  it("reconstructs both digests from the exact closed card", () => {
    const reconstructed = reconstructReviewerCard({
      approval_id: APPROVAL_ID,
      blocks: reviewerBlocks(),
      fallback_text: FALLBACK_TEXT,
    });
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.approve_reaction).toBe("white_check_mark");
    expect(reconstructed?.reject_reaction).toBe("x");
    expect(reconstructed?.reviewer_release_draft_sha256).toBe(
      canonicalSha256({
        schema_version: 1,
        kind: "reviewer-release-draft-v1",
        approval_id: APPROVAL_ID,
        card_title: CARD_TITLE,
        items: [
          {
            signal_id_sha256: `sha256:${SIGNAL_DIGEST_HEX}`,
            kind: "decision",
            text: ITEM_TEXT,
          },
        ],
      }),
    );
  });

  it("accepts Slack's deterministic stored fallback without changing either digest", () => {
    const logical = reconstructReviewerCard({
      approval_id: APPROVAL_ID,
      blocks: reviewerBlocks(),
      fallback_text: FALLBACK_TEXT,
    });
    const stored = reconstructReviewerCard({
      approval_id: APPROVAL_ID,
      blocks: reviewerBlocks(),
      fallback_text: FALLBACK_TEXT.replace(/\n/g, " "),
    });

    expect(stored).toEqual(logical);
  });

  it("refuses every malformed, edited, or mixed-namespace card", () => {
    const cases: { blocks: unknown[]; fallback?: string }[] = [
      // Missing the consequence block.
      { blocks: reviewerBlocks().filter((_v, index) => index !== 2) },
      // Truncated fallback that omits an item.
      {
        blocks: reviewerBlocks(),
        fallback: FALLBACK_TEXT.replace(`decision: ${ITEM_TEXT}\n`, ""),
      },
      // Only one ASCII space per logical newline is an accepted Slack form.
      {
        blocks: reviewerBlocks(),
        fallback: FALLBACK_TEXT.replace(/\n/g, "  "),
      },
      // A pilot audience block spliced into the reviewer namespace.
      {
        blocks: [
          ...reviewerBlocks(),
          {
            type: "section",
            block_id: `echo-approval-${APPROVAL_ID}-audience-v1`,
            text: { type: "plain_text", text: "Anyone may read", emoji: false },
          },
        ],
      },
      // An extra field on a closed block.
      {
        blocks: reviewerBlocks().map((block, index) =>
          index === 1 ? { ...(block as object), accessory: {} } : block,
        ),
      },
      // Wrong item ordinal.
      {
        blocks: reviewerBlocks().map((block, index) =>
          index === 1
            ? {
                ...(block as Record<string, unknown>),
                block_id: `echo-approval-${APPROVAL_ID}-item-1-${SIGNAL_DIGEST_HEX}-v1`,
              }
            : block,
        ),
      },
      // Emoji rendering enabled.
      {
        blocks: reviewerBlocks().map((block, index) =>
          index === 0
            ? {
                ...(block as Record<string, unknown>),
                text: { type: "plain_text", text: CARD_TITLE, emoji: true },
              }
            : block,
        ),
      },
      // Identical reaction names.
      {
        blocks: reviewerBlocks().map((block, index) =>
          index === 3
            ? {
                ...(block as Record<string, unknown>),
                elements: [
                  {
                    type: "mrkdwn",
                    text: "React :x: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
                    verbatim: false,
                  },
                ],
              }
            : block,
        ),
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      expect(
        reconstructReviewerCard({
          approval_id: APPROVAL_ID,
          blocks: testCase.blocks,
          fallback_text: testCase.fallback ?? FALLBACK_TEXT,
        }),
        `case ${index}`,
      ).toBeNull();
    }
  });
});

describe("reviewer card reaction-pair parsing", () => {
  it("reads both frozen reaction names from the closed live card", () => {
    const reconstructed = reconstructReviewerCard({
      approval_id: APPROVAL_ID,
      blocks: reviewerBlocks(),
      fallback_text: FALLBACK_TEXT,
    });
    // The schema-v1 rejection path uses exactly this pair: the live reject
    // reaction is the selected one and the live approve reaction is the
    // verifier's opposite. Neither comes from current local configuration.
    expect(reconstructed?.approve_reaction).toBe("white_check_mark");
    expect(reconstructed?.reject_reaction).toBe("x");
  });

  it("returns nothing for an ordinary card so the landed path is unchanged", () => {
    const ordinary = [
      {
        type: "header",
        block_id: `echo-approval-${APPROVAL_ID}-0`,
        text: { type: "plain_text", text: "Planning", emoji: true },
      },
      {
        type: "context",
        block_id: `echo-approval-${APPROVAL_ID}-1`,
        elements: [
          {
            type: "mrkdwn",
            text: "React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.",
            verbatim: false,
          },
        ],
      },
    ];
    expect(
      reconstructReviewerCard({
        approval_id: APPROVAL_ID,
        blocks: ordinary,
        fallback_text: "Decision brief awaiting approval: Planning",
      }),
    ).toBeNull();
  });
});

describe("reviewer authorization evidence lookup", () => {
  const releaseDraftSha256 = digest("release-draft");
  const presentationSha256 = digest("approval-presentation");
  const providerEventSha256 = digest("provider-event");
  const requestSha256 = digest("request");

  const semanticSha256 = canonicalSha256(
    reviewerRestrictedSemanticPreimage({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      approval_id: APPROVAL_ID,
      reviewer_principal_id: PRINCIPAL_ID,
      reviewer_membership_id: MEMBERSHIP_ID,
      reviewer_release_draft_sha256: releaseDraftSha256,
      approval_presentation_sha256: presentationSha256,
      evaluated_at: NOW,
    }),
  );
  const messageSha256 = canonicalSha256(
    reviewerMessagePresentationPreimage({
      provider_event_sha256: providerEventSha256,
      approval_presentation_sha256: presentationSha256,
      team_id: "T012ABCDEF",
      enterprise_id: null,
      bot_user_id: "U012BOTUSER",
      bot_id: "B012BOTID",
      app_id: "A012APPID",
      actor_user_id: "U012REVIEWER",
      channel_id: "C012CHANNEL",
      message_ts: "1754900000.000100",
      reaction_name: "white_check_mark",
    }),
  );

  function decisionInput(): RecordReviewerPermissionDecisionInput {
    return {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      request_id: REQUEST_ID,
      request_sha256: requestSha256,
      provider_event_sha256: providerEventSha256,
      approval_id: APPROVAL_ID,
      installation_id: INSTALLATION_ID,
      reviewer_principal_id: PRINCIPAL_ID,
      reviewer_membership_id: MEMBERSHIP_ID,
      identity_link_id: IDENTITY_LINK_ID,
      connection_id: CONNECTION_ID,
      adapter_binding_id: ADAPTER_BINDING_ID,
      permission_grant_id: PERMISSION_GRANT_ID,
      evaluated_at: NOW,
      authority_evidence_sha256: digest("authority-status"),
      detail: reviewerRestrictedAuditDetail({
        authority_id: AUTHORITY_ID,
        request_sha256: requestSha256,
        provider_event_sha256: providerEventSha256,
        principal_id: PRINCIPAL_ID,
        team_id: "T012ABCDEF",
        enterprise_id: null,
        bot_user_id: "U012BOTUSER",
        bot_id: "B012BOTID",
        app_id: "A012APPID",
        actor_user_id: "U012REVIEWER",
        adapter_id: "slack-reactions",
        adapter_instance_id: "default",
        adapter_version: "1.0.0",
        channel_id: "C012CHANNEL",
        message_ts: "1754900000.000100",
        reaction_name: "white_check_mark",
        approve_reaction: "white_check_mark",
        reject_reaction: "x",
        reviewer_release_draft_sha256: releaseDraftSha256,
        approval_presentation_sha256: presentationSha256,
        semantic_intent_sha256: semanticSha256,
        message_presentation_sha256: messageSha256,
      }),
    };
  }

  function expectation(
    entrySha256: `sha256:${string}`,
  ): ReviewerAuthorizationEvidenceExpectation {
    return {
      organization_id: ORGANIZATION_ID,
      installation_id: INSTALLATION_ID,
      approval_id: APPROVAL_ID,
      request_id: REQUEST_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      request_sha256: requestSha256,
      provider_event_sha256: providerEventSha256,
      adapter_binding_id: ADAPTER_BINDING_ID,
      permission_grant_id: PERMISSION_GRANT_ID,
      evaluated_at: NOW,
      reviewer_release_draft_sha256: releaseDraftSha256,
      approval_presentation_sha256: presentationSha256,
      semantic_intent_sha256: semanticSha256,
      message_presentation_sha256: messageSha256,
      authorization_audit_entry_sha256: entrySha256,
    };
  }

  it("matches the exact appended row and returns only the closed proof", () => {
    const { repository, database } = openRepository();
    try {
      const recorded = repository.recordReviewerPermissionDecision(
        decisionInput(),
      );
      const match = repository.findAllowedReviewerAuthorizationEvidenceById(
        recorded.authorization_audit_event_id,
        expectation(recorded.authorization_audit_entry_sha256),
      );
      expect(match.status).toBe("matched");
      if (match.status !== "matched") throw new Error("unreachable");
      expect(match.audit_entry_sha256).toBe(
        recorded.authorization_audit_entry_sha256,
      );
      expect(Object.keys(match.proof).sort()).toEqual(
        [
          "policy_id",
          "reviewer_principal_id",
          "reviewer_membership_id",
          "reviewer_release_draft_sha256",
          "approval_presentation_sha256",
          "semantic_intent_sha256",
          "message_presentation_sha256",
          "authorization_audit_event_id",
          "authorization_audit_entry_sha256",
          "evaluated_at",
        ].sort(),
      );
      expect(match.proof.policy_id).toBe(RESTRICTED_REVIEWER_POLICY_ID);
      expect(match.proof.reviewer_principal_id).toBe(PRINCIPAL_ID);
      expect(match.proof.evaluated_at).toBe(NOW);

      const row = database
        .prepare(
          `SELECT reason_code, action, outcome
           FROM organization_integration_audit WHERE audit_event_id = ?`,
        )
        .get(recorded.authorization_audit_event_id) as {
        reason_code: string;
        action: string;
        outcome: string;
      };
      expect(row).toEqual({
        reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
        action: "permission.approve",
        outcome: "allowed",
      });
    } finally {
      repository.close();
    }
  });

  it("denies an unknown id, a changed commitment, and a tampered entry", () => {
    const { repository, database } = openRepository();
    try {
      const recorded = repository.recordReviewerPermissionDecision(
        decisionInput(),
      );
      expect(
        repository.findAllowedReviewerAuthorizationEvidenceById(
          "aud_00000000-0000-4000-8000-00000000dead",
          expectation(recorded.authorization_audit_entry_sha256),
        ).status,
      ).toBe("absent");
      expect(
        repository.findAllowedReviewerAuthorizationEvidenceById(
          recorded.authorization_audit_event_id,
          {
            ...expectation(recorded.authorization_audit_entry_sha256),
            reviewer_release_draft_sha256: digest("other-draft"),
          },
        ).status,
      ).toBe("mismatch");
      expect(
        repository.findAllowedReviewerAuthorizationEvidenceById(
          recorded.authorization_audit_event_id,
          {
            ...expectation(recorded.authorization_audit_entry_sha256),
            authorization_audit_entry_sha256: digest("other-entry"),
          },
        ).status,
      ).toBe("mismatch");
      void database;
    } finally {
      repository.close();
    }
  });

  it("reports corrupt when a stored row does not rehash to its entry", () => {
    const { repository, database } = openRepository();
    try {
      const recorded = repository.recordReviewerPermissionDecision(
        decisionInput(),
      );
      const stored = database
        .prepare(
          `SELECT detail_json, entry_sha256
           FROM organization_integration_audit WHERE audit_event_id = ?`,
        )
        .get(recorded.authorization_audit_event_id) as {
        detail_json: string;
        entry_sha256: string;
      };
      // A second row whose stored entry hash does not cover its own columns is
      // damage in the Authority's own audit store, never a caller mismatch.
      database
        .prepare(
          `INSERT INTO organization_integration_audit (
             audit_sequence, audit_event_id, previous_entry_sha256,
             entry_sha256, organization_id, occurred_at, actor_kind,
             actor_principal_id, actor_membership_id, actor_identity_link_id,
             actor_installation_id, command_id, provider_event_sha256, action,
             subject_kind, subject_id, membership_id, identity_link_id,
             connection_id, adapter_binding_id, permission_grant_id, outcome,
             reason_code, idempotency_key, authority_checked_at,
             authority_evidence_sha256, correlation_id, detail_json,
             detail_sha256
           ) VALUES (
             2, 'aud_00000000-0000-4000-8000-0000000000c0', ?, ?, ?, ?,
             'installation', ?, ?, NULL, ?, 'pce_00000000-0000-4000-8000-0000000000c0',
             ?, 'permission.approve', 'approval', ?, ?, ?, ?, ?, ?, 'allowed',
             ?, 'permission-evaluation:corrupt', ?, ?, ?, ?, ?
           )`,
        )
        .run(
          stored.entry_sha256,
          digest("not-the-real-entry"),
          ORGANIZATION_ID,
          NOW,
          PRINCIPAL_ID,
          MEMBERSHIP_ID,
          INSTALLATION_ID,
          providerEventSha256,
          APPROVAL_ID,
          MEMBERSHIP_ID,
          IDENTITY_LINK_ID,
          CONNECTION_ID,
          ADAPTER_BINDING_ID,
          PERMISSION_GRANT_ID,
          RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
          NOW,
          digest("authority-status"),
          REQUEST_ID,
          stored.detail_json,
          canonicalSha256(JSON.parse(stored.detail_json) as unknown),
        );
      expect(
        repository.findAllowedReviewerAuthorizationEvidenceById(
          "aud_00000000-0000-4000-8000-0000000000c0",
          expectation(digest("not-the-real-entry")),
        ).status,
      ).toBe("corrupt");
    } finally {
      repository.close();
    }
  });
});
