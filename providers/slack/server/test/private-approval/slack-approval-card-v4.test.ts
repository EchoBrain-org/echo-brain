import { describe, expect, it } from "vitest";
import {
  buildClosedApprovalCardV4,
  buildSlackApprovalCardV4,
  slackApprovalActionIdV4,
  slackApprovalDestinationSha256V4,
  slackApprovalDestinationV4,
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
const PROJECT_A = "prj_00000000-0000-4000-8000-0000000000a1", PROJECT_B = "prj_00000000-0000-4000-8000-0000000000b1";
const card = (destination: readonly string[], owners: Parameters<typeof buildSlackApprovalCardV4>[0]["owners"] = [], destination_sha256 = slackApprovalDestinationSha256V4([PROJECT_A])) =>
  buildSlackApprovalCardV4({ approval_id: "apr_test", snapshot_sha256: `sha256:${"a".repeat(64)}`, review, destination, destination_sha256, owners });
const controls = (built: ReturnType<typeof card>) => built.blocks.flatMap((block) => {
  const element = (block as { element?: { type: string; action_id?: string } }).element;
  const elements = (block as { elements?: readonly { type: string; action_id?: string }[] }).elements ?? [];
  return [...(element === undefined ? [] : [element]), ...elements.filter((entry) => entry.action_id !== undefined)];
});

describe("Slack approval card V4", () => {
  it("says where every item goes in one line, and offers only owner inputs, Approve and Reject", () => {
    const built = card(["THERM", "ECHO"], [{ signal_id: "act_1", action: "Send draft", proposed: "Ada" }]);
    const destination = built.blocks.find((block) => (block as { block_id?: string }).block_id?.endsWith("-destination")) as { text: { text: string } };
    expect(destination.text.text).toBe("Goes to: THERM, ECHO");
    expect(controls(built).map((control) => control.type)).toEqual(["plain_text_input", "button", "button"]);
    expect(controls(built).map((control) => control.action_id)).toEqual([
      slackApprovalOwnerActionIdV4("apr_test", "act_1"), slackApprovalActionIdV4("apr_test", "approve"), slackApprovalActionIdV4("apr_test", "reject"),
    ]);
    const encoded = JSON.stringify(built);
    for (const gone of ["static_select", "multi_static_select", "checkboxes", "Share transcript", "Who should be able to read", "Projects to share with", "Team"]) {
      expect(encoded).not.toContain(gone);
    }
    expect(encoded).toContain("Approve meeting");
    expect(encoded).toContain("Reject");
    expect(encoded).toContain('\\"snapshot_sha256\\":\\"sha256:');
    expect(encoded).toContain("To choose per item, open the ECHO desktop app.");
  });
  it("binds both buttons to the destination the card shows, as a digest of its sorted project ids", () => {
    const shown = slackApprovalDestinationSha256V4([PROJECT_B, PROJECT_A]);
    const values = controls(card(["THERM", "ECHO"], [], shown)).filter((control) => control.type === "button")
      .map((control) => JSON.parse((control as { value?: string }).value!) as Record<string, unknown>);
    expect(values).toEqual([0, 1].map(() => ({ schema_version: 3, approval_id: "apr_test", snapshot_sha256: `sha256:${"a".repeat(64)}`, destination_sha256: shown })));
    // Order-free, and every other set (one project fewer, one more, the reviewer alone) has its own digest.
    expect(shown).toBe(slackApprovalDestinationSha256V4([PROJECT_A, PROJECT_B]));
    expect(shown).toMatch(/^sha256:[0-9a-f]{64}$/);
    const others = [[PROJECT_A], [PROJECT_B], [], [PROJECT_A, PROJECT_B, "prj_00000000-0000-4000-8000-0000000000c1"]].map(slackApprovalDestinationSha256V4);
    expect(new Set([shown, ...others]).size).toBe(5);
  });
  it("sends every item to the reviewer alone when nothing is suggested", () => {
    const built = card([]);
    expect(JSON.stringify(built.blocks)).toContain("Goes to: Only you");
    expect(slackApprovalDestinationV4([])).toBe("Only you");
    expect(built.text).toContain("Goes to: Only you");
  });
  it("tells the notification and assistive text that choosing per item happens in the desktop app", () => {
    const built = card(["THERM"]);
    expect(built.text).toContain("Goes to: THERM");
    expect(built.text).toContain("Approve sends every decision and action there; choose per item in the ECHO desktop app.");
    expect(built.text).not.toMatch(/Transcript sharing|Visibility/);
    expect(built.transport).toEqual({ mrkdwn: false, unfurl_links: false, unfurl_media: false });
  });
  it("keeps a long destination within a Slack section", () => {
    const built = card(Array.from({ length: 20 }, (_, index) => `${"P".repeat(200)}${index}`));
    const destination = built.blocks.find((block) => (block as { block_id?: string }).block_id?.endsWith("-destination")) as { text: { text: string } };
    expect(destination.text.text.length).toBeLessThanOrEqual(3_000);
    expect(destination.text.text.endsWith("…")).toBe(true);
    expect(() => card(Array.from({ length: 21 }, (_, index) => `P${index}`))).toThrow("Slack limits");
  });
  it("uses the exact closed-card outcome language and names each destination", () => {
    const approved = buildClosedApprovalCardV4({ title: "Roadmap", outcome: "approved", surface: "desktop", destinations: ["THERM", "THERM + ECHO", "Only you"] });
    expect(approved.text).toBe("Approved in the ECHO desktop\nSent to: THERM · THERM + ECHO · Only you");
    expect(buildClosedApprovalCardV4({ title: "Roadmap", outcome: "approved", surface: "slack", destinations: ["Only you"] }).text).toBe("Approved in Slack\nSent to: Only you");
    expect(buildClosedApprovalCardV4({ title: "Roadmap", outcome: "rejected", surface: "slack" }).text).toBe("Rejected in Slack");
    expect(buildClosedApprovalCardV4({ title: "Roadmap", outcome: "superseded" }).text).toContain("Replaced by a newer version of this meeting");
  });
  it("binds each owner input to its signal id instead of its display index", () => {
    const built = card([], [
      { signal_id: "act_alpha", action: "Send draft", proposed: "Ada" },
      { signal_id: "act_beta", action: "Review draft", proposed: "Lin" },
    ]);
    const ids = controls(built).map((control) => control.action_id);
    expect(ids).toContain(slackApprovalOwnerActionIdV4("apr_test", "act_alpha"));
    expect(ids).toContain(slackApprovalOwnerActionIdV4("apr_test", "act_beta"));
    expect(JSON.stringify(built)).not.toContain("owner-input-0");
  });
  it("shows the owners that fit Slack's 50 blocks and says how many more the desktop app has", () => {
    const owners = Array.from({ length: 120 }, (_, index) => ({ signal_id: `act_${index}`, action: `Action ${index}`, proposed: "Ada" }));
    const built = card(["THERM"], owners);
    expect(built.blocks.length).toBe(50);
    const inputs = controls(built).filter((control) => control.type === "plain_text_input");
    const more = built.blocks.find((block) => (block as { block_id?: string }).block_id?.endsWith("-more-owners")) as { elements: { text: string }[] };
    expect(more.elements[0]!.text).toBe(`${120 - inputs.length} more actions have a proposed owner. Set them in the ECHO desktop app.`);
    expect(inputs.map((input) => input.action_id)).toEqual(owners.slice(0, inputs.length).map((owner) => slackApprovalOwnerActionIdV4("apr_test", owner.signal_id)));
    expect(built.text).toContain(`${120 - inputs.length} more actions have a proposed owner.`);
    // Every owner that fits is shown, and no note when all fit.
    expect(JSON.stringify(card(["THERM"], owners.slice(0, 10)))).not.toContain("more actions have a proposed owner");
  });
  it("holds an owner input to Slack's own 3,000 characters, and leaves a longer owner to the desktop app", () => {
    const built = card(["THERM"], [
      { signal_id: "act_long", action: "A".repeat(5_000), proposed: "R".repeat(3_000) },
      { signal_id: "act_over", action: "Send draft", proposed: "R".repeat(3_001) },
    ]);
    const inputs = built.blocks.filter((block) => (block as { type?: string }).type === "input") as unknown as
      { label: { text: string }; element: { action_id: string; initial_value: string; max_length: number } }[];
    expect(inputs.map((input) => input.element.action_id)).toEqual([slackApprovalOwnerActionIdV4("apr_test", "act_long")]);
    expect(inputs[0]!.element).toMatchObject({ initial_value: "R".repeat(3_000), max_length: 3_000 });
    expect(inputs[0]!.label.text.length).toBeLessThanOrEqual(2_000);
    expect(inputs[0]!.label.text.endsWith("…")).toBe(true);
    expect(built.text).toContain("1 more action has a proposed owner. Set it in the ECHO desktop app.");
  });
});
