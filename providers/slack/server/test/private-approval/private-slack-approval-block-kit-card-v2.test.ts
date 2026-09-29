import { describe, expect, it } from "vitest";
import {
  buildPrivateSlackApprovalBlockKitCardV2,
  buildPrivateSlackApprovalBlockKitCardV3,
  canonicalPrivateSlackApprovalOwnerV3,
  privateSlackApprovalBlockKitActionIdV2,
  privateSlackApprovalBlockKitOwnerActionIdV3,
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

  it("V3 adds one editable owner field per proposal, starting at the proposal, and V3 button commitments", () => {
    const { schema_version: _version, ...rest } = INPUT;
    const card = buildPrivateSlackApprovalBlockKitCardV3({
      ...rest, schema_version: 3,
      ungrouped_actions: [{ text: "Send the revised quote", evidence_reference: "Transcript block b1" }, { text: "Book the venue", evidence_reference: "Transcript block b2" }],
      owner_proposals: [{ action_index: 1, action_text: "Book the venue", owner: "Priya Shah" }],
    });
    expect(card).toMatchObject({ schema_version: 3, kind: "echo-private-approval-block-kit-card-v3" });
    const field = card.blocks.find((block) => (block as { readonly block_id?: string }).block_id?.endsWith("-owner-1-v2")) as { readonly optional: boolean; readonly label: { readonly text: string }; readonly element: Record<string, unknown> };
    expect(field.optional).toBe(true);
    expect(field.label.text).toBe("Owner · Book the venue");
    expect(field.element).toMatchObject({ type: "plain_text_input", action_id: privateSlackApprovalBlockKitOwnerActionIdV3(INPUT, 1), initial_value: "Priya Shah", max_length: 120 });
    expect(privateSlackApprovalBlockKitOwnerActionIdV3(INPUT, 1)).toMatch(/^echo-private-approval-v2-[0-9a-f]{32}-owner-1-v3$/);
    const ids = card.blocks.map((block) => (block as { readonly block_id?: string }).block_id ?? "");
    expect(ids.findIndex((id) => id.endsWith("-owner-1-v2"))).toBeLessThan(ids.findIndex((id) => id.endsWith("-policy-v2")));
    const actions = control(card as never, "actions") as { readonly elements: readonly { readonly value: string }[] };
    expect(actions.elements.map((element) => element.value)).toEqual([JSON.stringify({ schema_version: 3, approval_id: INPUT.approval_id }), JSON.stringify({ schema_version: 3, approval_id: INPUT.approval_id })]);
    expect(card.text).toContain('Owner of "Book the venue": Priya Shah');
  });

  it("V3 refuses an empty, unordered or uncanonical proposal list", () => {
    const { schema_version: _version, ...rest } = INPUT;
    const v3 = (owner_proposals: never) => buildPrivateSlackApprovalBlockKitCardV3({ ...rest, schema_version: 3, owner_proposals });
    expect(() => v3([] as never)).toThrow("1 to 40");
    expect(() => v3([{ action_index: 2, action_text: "A", owner: "X" }, { action_index: 1, action_text: "B", owner: "Y" }] as never)).toThrow("ordered");
    expect(() => v3([{ action_index: 0, action_text: "A", owner: " X" }] as never)).toThrow("owner is invalid");
    expect(() => v3([{ action_index: 0, action_text: "A", owner: "X", extra: 1 }] as never)).toThrow("unexpected fields");
  });

  it("canonicalizes an entered owner to one trimmed line, and refuses a long or control-bearing one", () => {
    expect(canonicalPrivateSlackApprovalOwnerV3("  Priya   Shah \n")).toBe("Priya Shah");
    expect(canonicalPrivateSlackApprovalOwnerV3("   ")).toBeNull();
    expect(() => canonicalPrivateSlackApprovalOwnerV3("x".repeat(121))).toThrow();
    expect(() => canonicalPrivateSlackApprovalOwnerV3("Priya\u200bShah")).toThrow();
  });
});
