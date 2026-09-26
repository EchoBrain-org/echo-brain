import { describe, expect, it } from "vitest";
import {
  buildPrivateSlackApprovalBlockKitCardV2,
  privateSlackApprovalBlockKitActionIdV2,
} from "../../src/private-approval/private-slack-approval-block-kit-card-v2.js";

const INPUT = {
  schema_version: 2 as const,
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
  meeting_title: "Weekly product review",
  decision_groups: [],
  eligible_projects: [
    { project_id: "prj_11111111-1111-4111-8111-111111111111", project_membership_id: "pgm_11111111-1111-4111-8111-111111111111", name: "Apollo" },
    { project_id: "prj_22222222-2222-4222-8222-222222222222", project_membership_id: "pgm_22222222-2222-4222-8222-222222222222", name: "Beacon" },
  ],
};

function control(card: ReturnType<typeof buildPrivateSlackApprovalBlockKitCardV2>, suffix: string) {
  return card.blocks.find((block) => (block as { readonly block_id?: string }).block_id?.endsWith(`-${suffix}-v2`));
}

describe("private approval Block Kit card v2", () => {
  it("freezes Projects choices and leaves transcript sharing unchecked", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV2(INPUT);
    const policy = control(card, "policy") as { readonly element: { readonly options: readonly { readonly value: string }[] } };
    const projects = control(card, "projects") as { readonly element: { readonly type: string; readonly options: readonly { readonly value: string; readonly text: { readonly text: string } }[]; readonly initial_options?: unknown } };
    const transcript = control(card, "share-transcript") as { readonly element: { readonly type: string; readonly options: readonly { readonly value: string }[]; readonly initial_options?: unknown } };
    expect(policy.element.options.map((item) => item.value)).toEqual([
      "restricted-reviewer-person-v2",
      "organization-member-readable-person-v2",
      "project-members-readable-person-v1",
    ]);
    expect(projects.element).toMatchObject({ type: "multi_static_select", options: [
      { value: INPUT.eligible_projects[0].project_id, text: { text: "Apollo" } },
      { value: INPUT.eligible_projects[1].project_id, text: { text: "Beacon" } },
    ] });
    expect(projects.element.initial_options).toBeUndefined();
    expect(transcript.element).toMatchObject({ type: "checkboxes", options: [{ value: "share-transcript-v1" }] });
    expect(transcript.element.initial_options).toBeUndefined();
    expect(card.text).toContain("Transcript sharing is off by default.");
  });

  it("uses V2-only deterministic control IDs and V2 button commitments", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV2(INPUT);
    const actions = control(card, "actions") as { readonly elements: readonly { readonly action_id: string; readonly value: string }[] };
    expect(privateSlackApprovalBlockKitActionIdV2(INPUT, "projects")).toMatch(/^echo-private-approval-v2-[0-9a-f]{32}-projects-v2$/);
    expect(actions.elements).toEqual([
      expect.objectContaining({ action_id: privateSlackApprovalBlockKitActionIdV2(INPUT, "approve"), value: JSON.stringify({ schema_version: 2, approval_id: INPUT.approval_id }) }),
      expect.objectContaining({ action_id: privateSlackApprovalBlockKitActionIdV2(INPUT, "reject"), value: JSON.stringify({ schema_version: 2, approval_id: INPUT.approval_id }) }),
    ]);
  });

  it("rejects unsorted or duplicate frozen eligible projects", () => {
    expect(() => buildPrivateSlackApprovalBlockKitCardV2({ ...INPUT, eligible_projects: [...INPUT.eligible_projects].reverse() })).toThrow("canonically ordered");
    expect(() => buildPrivateSlackApprovalBlockKitCardV2({ ...INPUT, eligible_projects: [INPUT.eligible_projects[0], INPUT.eligible_projects[0]] })).toThrow("canonically ordered");
  });

  it("does not emit an invalid empty static selector", () => {
    const card = buildPrivateSlackApprovalBlockKitCardV2({
      ...INPUT,
      eligible_projects: [],
    });
    const policy = control(card, "policy") as { readonly element: { readonly options: readonly { readonly value: string }[] } };
    expect(policy.element.options.map((item) => item.value)).not.toContain(
      "project-members-readable-person-v1",
    );
    expect(control(card, "projects")).toBeUndefined();
    expect(control(card, "projects-unavailable")).toBeDefined();
  });

  it("bounds Slack option labels while retaining the full frozen project name", () => {
    const name = "A".repeat(200);
    const card = buildPrivateSlackApprovalBlockKitCardV2({
      ...INPUT,
      eligible_projects: [{ ...INPUT.eligible_projects[0], name }],
    });
    const projects = control(card, "projects") as { readonly element: { readonly options: readonly { readonly text: { readonly text: string } }[]; readonly max_selected_items: number } };
    expect(projects.element.options[0]!.text.text.length).toBeLessThanOrEqual(75);
    expect(projects.element.options[0]!.text.text).toContain("11111111");
    expect(projects.element.max_selected_items).toBe(20);
  });
});
