import { describe, expect, it } from "vitest";
import type { compileDecisionBrief } from "@echo-brain/organization-processing/core/processing/brief";
import { buildPrivateSlackApprovalCardFromBriefV1, frozenReviewV1 } from "../../src/private-approval/slack-approval-card-input-v1.js";

type Brief = ReturnType<typeof compileDecisionBrief>;
const EVIDENCE = [{ meeting_id: "meeting-1", block_id: "transcript-1" }];
const PROJECT = { project_id: "prj_11111111-1111-4111-8111-111111111111", project_membership_id: "pgm_11111111-1111-4111-8111-111111111111", name: "Launch" };

function action(index: number, owner: string | null) {
  return { id: `action-${index}`, kind: "action" as const, text: `Send the launch plan ${index + 1}`, subject: null, confidence: null, owner, due_at: null, evidence: EVIDENCE };
}

function brief(overrides: Partial<Pick<Brief, "decisions" | "actions" | "rationales">> = {}): Brief {
  return {
    schema_version: 1,
    id: "brf_1",
    meeting: { id: "meeting-1", title: "Launch review", participants: [] },
    decisions: [{ id: "decision-0", kind: "decision", text: "Ship the beta", subject: null, confidence: null, status: "decided", evidence: EVIDENCE }],
    actions: [action(0, null)],
    rationales: [
      { id: "rationale-0", kind: "rationale", text: "Customers asked for it", subject: null, confidence: null, supports_signal_ids: ["decision-0"], evidence: EVIDENCE },
      { id: "rationale-1", kind: "rationale", text: "The team has capacity", subject: null, confidence: null, supports_signal_ids: [], evidence: EVIDENCE },
    ],
    provenance: {
      meeting_revision: "revision-1",
      processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "llm-1", version: "1" },
      generated_at: "2026-10-07T00:00:00.000Z",
    },
    ...overrides,
  };
}

const card = (value: Brief, meeting_title: unknown = "Launch review") =>
  buildPrivateSlackApprovalCardFromBriefV1({ approval_id: "apr_00000000-0000-4000-8000-000000000001", meeting_title, brief: value, eligible_projects: [PROJECT] });

describe("private Slack approval card input V1", () => {
  it("groups each decision with its rationales, then the actions and unsupported rationales", () => {
    expect(frozenReviewV1(brief())).toEqual({
      decision_groups: [{
        id: "decision-group-1",
        decision: { text: "Ship the beta", evidence_reference: "Transcript block transcript-1", status: "decided" },
        rationales: [{ text: "Customers asked for it", evidence_reference: "Transcript block transcript-1" }],
      }],
      ungrouped_actions: [{ text: "Send the launch plan 1", evidence_reference: "Transcript block transcript-1" }],
      ungrouped_rationales: [{ text: "The team has capacity", evidence_reference: "Transcript block transcript-1" }],
    });
    expect(frozenReviewV1(brief({ actions: [], rationales: [] }))).toEqual({
      decision_groups: [expect.objectContaining({ id: "decision-group-1", rationales: [] })],
    });
  });

  it("has no review when any item cannot be shown exactly", () => {
    expect(frozenReviewV1(brief({ actions: [{ ...action(0, null), text: " padded " }] }))).toBeUndefined();
    expect(frozenReviewV1(brief({ actions: [{ ...action(0, null), evidence: [] }] }))).toBeUndefined();
    expect(card(brief({ actions: [{ ...action(0, null), evidence: [] }] }))).toBeUndefined();
  });

  it("offers a proposed owner on a V3 card", () => {
    const built = card(brief({ actions: [action(0, "Participant")] }));
    expect(built).toMatchObject({ schema_version: 3, kind: "echo-private-approval-block-kit-card-v3" });
    const field = built!.blocks.find((block) => typeof block.block_id === "string" && block.block_id.endsWith("-owner-0-v2"));
    expect(field?.element).toMatchObject({ type: "plain_text_input", initial_value: "Participant" });
  });

  it("builds the V2 card when nothing proposes an owner, and when owner fields would not fit", () => {
    expect(card(brief())).toMatchObject({ schema_version: 2, kind: "echo-private-approval-block-kit-card-v2" });
    expect(card(brief({ actions: Array.from({ length: 41 }, (_, index) => action(index, "Participant")) }))).toMatchObject({ schema_version: 2 });
  });

  it("titles an untitled meeting and keeps the title on one bounded line", () => {
    expect(card(brief(), "   ")?.text).toContain("Meeting: Meeting approval");
    const long = card(brief(), `Launch\n\treview ${"x".repeat(200)}`)!.text;
    expect(long).toContain(`Meeting: Launch review ${"x".repeat(150 - "Launch review ".length)}\n`);
    expect(long).not.toContain("x".repeat(150 - "Launch review ".length + 1));
  });
});
