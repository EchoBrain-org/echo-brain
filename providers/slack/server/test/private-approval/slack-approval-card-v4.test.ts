import { describe, expect, it } from "vitest";
import {
  buildClosedApprovalCardV4,
  buildSlackApprovalCardV4,
  slackApprovalActionIdV4,
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
const card = (destination: readonly string[], owners: Parameters<typeof buildSlackApprovalCardV4>[0]["owners"] = []) =>
  buildSlackApprovalCardV4({ approval_id: "apr_test", snapshot_sha256: `sha256:${"a".repeat(64)}`, review, destination, owners });
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
});
