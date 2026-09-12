import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@echo-brain/federation-protocol";
import { projectPrivateSlackBlockApprovalApproverV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import { openOrganizationAuthorityRuntime } from "../src/composition/organization-authority-runtime.js";
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from "../src/composition/organization-authority-composition-root.js";

vi.mock("../src/composition/organization-authority-runtime.js", () => ({ openOrganizationAuthorityRuntime: vi.fn() }));

// Only provider selection runs; the mocked runtime performs no credential or persistence reads.
const config = {
  state_directory: "/unused", granola_credential_file: "/unused", granola_owner_email_file: "/unused",
  openrouter_credential_file: "/unused", slack_signing_secret_file: "/unused", slack_connection_id: "connection",
  slack_identity_link_channel_id: "C123ABC",
} as OrganizationAuthorityServiceConfig;

describe("Authority retained approver composition", () => {
  it("keeps the historical signed Slack fixture readable when another protocol is injected", async () => {
    const { envelope } = JSON.parse(readFileSync(new URL("../../../providers/slack/server/test/organization-protocol/fixtures/pre-codec-slack-v4.json", import.meta.url), "utf8")) as { envelope: JsonObject };
    const historical = projectPrivateSlackBlockApprovalApproverV1(envelope);
    expect(historical).toBeDefined();
    const alternate = { ...historical!, approval_id: "alternate" };
    await openOrganizationAuthorityService(config, { api: { record_approver: value => value.protocol === "alternate" ? alternate : undefined } });
    const project = vi.mocked(openOrganizationAuthorityRuntime).mock.lastCall?.[1]?.api?.record_approver;
    expect(project).toBeDefined();
    expect(project!(envelope)).toEqual(historical);
    expect(project!({ protocol: "alternate" })).toEqual(alternate);
    expect(project!({ protocol: "unknown" })).toBeUndefined();
  });
});
