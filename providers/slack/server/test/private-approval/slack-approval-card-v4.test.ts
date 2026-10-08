import { describe, expect, it } from "vitest";
import {
  buildClosedApprovalCardV4,
  buildSlackApprovalCardV4,
  slackApprovalOwnerActionIdV4,
} from "../../src/private-approval/slack-approval-card-v4.js";

const review = {
  schema_version: 1 as const,
  approval_id: "apr_test",
  meeting_title: "Roadmap",
  decision_groups: [],
  ungrouped_actions: [
    { text: "Send draft", evidence_reference: "Transcript block one" },
  ],
};

describe("Slack approval card V4", () => {
  it("offers only project-or-person audience, safe suggested projects, and snapshot-bound actions", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: "apr_test",
      snapshot_sha256: `sha256:${"a".repeat(64)}`,
      review,
      projects: [
        { project_id: "prj_a", name: "Alpha" },
        { project_id: "prj_b", name: "Beta" },
      ],
      suggested_project_ids: ["prj_b"],
      owners: [{ signal_id: "act_1", action: "Send draft", proposed: "Ada" }],
    });
    const encoded = JSON.stringify(card);
    expect(encoded).toContain("Only me");
    expect(encoded).toContain("Projects");
    expect(encoded).not.toContain("Team");
    expect(encoded).not.toContain("Note for the record");
    expect(encoded).toContain(
      '"initial_options":[{"text":{"type":"plain_text","text":"Beta"',
    );
    expect(encoded).toContain('\\"snapshot_sha256\\":\\"sha256:');
    const audience = (
      card.blocks.find((block) =>
        (block as { block_id?: string }).block_id?.endsWith("-audience"),
      ) as { element: { initial_option: { value: string } } }
    ).element;
    expect(audience.initial_option.value).toBe("projects");
  });
  it("keeps Only me selected when there are no suggested projects", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: "apr_test",
      snapshot_sha256: `sha256:${"a".repeat(64)}`,
      review,
      projects: [{ project_id: "prj_a", name: "Alpha" }],
      suggested_project_ids: [],
      owners: [],
    });
    const audience = (
      card.blocks.find((block) =>
        (block as { block_id?: string }).block_id?.endsWith("-audience"),
      ) as { element: { initial_option: { value: string } } }
    ).element;
    expect(audience.initial_option.value).toBe("only-me");
  });
  it("uses the exact closed-card outcome language", () => {
    expect(
      buildClosedApprovalCardV4({
        title: "Roadmap",
        outcome: "approved",
        surface: "desktop",
        audience_label: "Only me",
      }).text,
    ).toContain("Approved in the ECHO desktop");
    expect(
      buildClosedApprovalCardV4({
        title: "Roadmap",
        outcome: "rejected",
        surface: "slack",
      }).text,
    ).toContain("Rejected in Slack");
    expect(
      buildClosedApprovalCardV4({ title: "Roadmap", outcome: "superseded" })
        .text,
    ).toContain("Replaced by a newer version of this meeting");
  });
  it("bounds a valid Authority project name to Slack option text limits", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: "apr_test",
      snapshot_sha256: `sha256:${"a".repeat(64)}`,
      review,
      projects: [{ project_id: "prj_a", name: "A".repeat(200) }],
      suggested_project_ids: [],
      owners: [],
    });
    const option = (
      card.blocks.find((block) =>
        (block as { block_id?: string }).block_id?.endsWith("-projects"),
      ) as { element: { options: readonly { text: { text: string } }[] } }
    ).element.options[0]!;
    expect(option.text.text).toHaveLength(75);
  });
  it("binds each owner input to its signal id instead of its display index", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: "apr_test",
      snapshot_sha256: `sha256:${"a".repeat(64)}`,
      review,
      projects: [],
      suggested_project_ids: [],
      owners: [
        { signal_id: "act_alpha", action: "Send draft", proposed: "Ada" },
        { signal_id: "act_beta", action: "Review draft", proposed: "Lin" },
      ],
    });
    const ids = card.blocks.flatMap((block) => {
      const action = (block as { element?: { action_id?: string } }).element
        ?.action_id;
      return action === undefined ? [] : [action];
    });
    expect(ids).toContain(
      slackApprovalOwnerActionIdV4("apr_test", "act_alpha"),
    );
    expect(ids).toContain(slackApprovalOwnerActionIdV4("apr_test", "act_beta"));
    expect(JSON.stringify(card)).not.toContain("owner-input-0");
  });
});
