import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  PrivateApprovalFinalizationConflictError,
  PrivateApprovalFinalizationDeniedError,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type DurablePrivateApprovalTerminalV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import { describe, expect, it } from "vitest";
import {
  PrivateSlackApprovalTerminalCoordinatorV1,
  type PrivateSlackApprovalTerminalAuthorityV1,
  type PrivateSlackApprovalTerminalFrozenCandidateV1,
} from "../../../../../src/composition/providers/slack/private-approval/private-slack-approval-terminal-coordinator-v1.js";

const digest = (value: string) => canonicalSha256({ value });
const APPROVAL_ID = "approval_private";
const CANDIDATE_ID = "candidate_private";

function terminal(
  outcome: "approved" | "rejected",
): DurablePrivateApprovalTerminalV1 {
  const approved = outcome === "approved";
  const approver = { principal_id: "principal_private", membership_id: "membership_private" };
  return {
    outcome,
    signed_action_receipt_sha256: digest("signed-action"),
    resolution: {
      schema_version: 1,
      kind: "echo-private-approval-resolution-v1",
      command_id: `command-${outcome}`,
      approval_id: APPROVAL_ID,
      organization_id: "organization_private",
      candidate_sha256: digest("candidate"),
      frozen_card_sha256: digest("card"),
      approved_snapshot_sha256: digest("snapshot"),
      final_approver: approver,
      current_slack_identity_link: {
        provider: "slack",
        external_identity_link_id: "link_private",
        external_identity_link_contract_sha256: digest("link"),
        provider_subject_id: "UOWNER",
      },
      authorization_proof_sha256: digest("proof"),
      action: approved ? "approve" : "reject",
      comment: null,
      canonical_record_policy: approved
        ? {
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
            policy_contract_sha256:
              RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
            policy_consequence_sha256:
              RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
            restricted_reader: approver,
          }
        : null,
    },
    audit: {
      schema_version: 1,
      kind: "echo-private-approval-terminal-audit-v1",
      audit_event_id: `audit-${outcome}`,
      audit_sequence: 1,
      approval_id: APPROVAL_ID,
      resolution_sha256: digest("resolution"),
      outcome,
      predecessor_entry_sha256: null,
      occurred_at: "2026-08-28T00:00:00.000Z",
    },
  } as DurablePrivateApprovalTerminalV1;
}

function frozen(): PrivateSlackApprovalTerminalFrozenCandidateV1 {
  return {
    candidate_id: CANDIDATE_ID,
    authority_id: "authority_private",
    organization_id: "organization_private",
    state_lineage_id: "lineage_private",
    approval_id: APPROVAL_ID,
    candidate_sha256: digest("candidate"),
    frozen_card_sha256: digest("card"),
    approved_snapshot: {},
    approved_snapshot_sha256: digest("snapshot"),
    source_provenance: {},
    processor_provenance: {},
  } as PrivateSlackApprovalTerminalFrozenCandidateV1;
}

function authorityHarness(value: DurablePrivateApprovalTerminalV1): {
  readonly authority: PrivateSlackApprovalTerminalAuthorityV1;
  readonly records: Array<Record<string, unknown>>;
  readonly marks: string[];
} {
  let stored: any;
  const records: Array<Record<string, unknown>> = [];
  const marks: string[] = [];
  return {
    authority: {
      readFrozenCandidateForApproval: () => frozen(),
      readTerminal: () => stored,
      recordTerminal: (input) => {
        records.push(input as unknown as Record<string, unknown>);
        stored = {
          approval_id: APPROVAL_ID,
          candidate_id: CANDIDATE_ID,
          outcome: value.outcome,
          resolution: value.resolution,
          resolution_sha256: digest("resolution"),
          v4_receipt: input.v4_receipt ?? null,
          v4_receipt_sha256: input.v4_receipt === undefined ? null : digest("receipt"),
          card_render_state: "unrendered",
          card_rendered_at: null,
          recorded_at: "2026-08-28T00:00:00.000Z",
        };
        return stored;
      },
      readForPresentation: () => ({
        assignment: { dm_channel: { channel_id: "DPRIVATE" } },
        provider_message_ts: "1.000001",
        source_outbox_state: "superseded",
      } as any),
      markTerminalCardRendered: (approvalId) => {
        marks.push(approvalId);
        stored = { ...stored, card_render_state: "rendered" };
        return stored;
      },
    },
    records,
    marks,
  };
}

describe("private Slack approval terminal coordinator v1", () => {
  it("durably consumes finalization denials and competing terminal clicks", async () => {
    const denied: Array<readonly [string, string]> = [];
    const queued = [
      { receipt: { provider_action_key_sha256: digest("denied") } },
      { receipt: { provider_action_key_sha256: digest("conflict") } },
    ] as any;
    const result = terminal("approved");
    const harness = authorityHarness(result);
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => queued,
        listTerminals: () => [],
        finalize: async (key) => {
          if (key === digest("denied")) {
            // The wording intentionally looks like authorization while the
            // typed CP disposition says state drift.
            throw new PrivateApprovalFinalizationDeniedError(
              "state_drift",
              "authorization cannot be revalidated",
            );
          }
          throw new PrivateApprovalFinalizationConflictError();
        },
        recordDenied: (key, reason) => denied.push([key, reason]),
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("unreachable"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
    });

    await coordinator.observeAndFinalizePendingApprovals(new AbortController().signal);
    expect(denied).toEqual([
      [digest("denied"), "state_drift"],
      [digest("conflict"), "state_drift"],
    ]);
  });

  it("appends only an approved terminal, records it, and renders the DM idempotently", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const appends: unknown[] = [];
    const renders: unknown[] = [];
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listTerminals: () => [value],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: {
        appendApproved: async (input: unknown, candidate: unknown) => {
          appends.push({ input, candidate });
          return { receipt: { body: {}, receipt_sha256: digest("receipt"), signing_key_descriptor: {}, signature: "signature" } };
        },
      } as never,
      poster: {
        renderTerminal: async (input) => {
          renders.push(input);
          return { kind: "done" };
        },
      },
    });

    await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
    await coordinator.recoverV4Appends(new AbortController().signal);
    expect(appends).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({ candidate_id: CANDIDATE_ID });
    expect(harness.records[0]?.v4_receipt).not.toBeNull();
    expect(renders).toEqual([
      expect.objectContaining({
        outcome: "approved",
        policy_label: "Only me",
        dm_channel_id: "DPRIVATE",
      }),
    ]);
    expect(harness.marks).toEqual([APPROVAL_ID]);
  });

  it("records a rejected terminal after supersession without calling V4 and retries an uncertain card update", async () => {
    const value = terminal("rejected");
    const harness = authorityHarness(value);
    let renderCalls = 0;
    let appendCalls = 0;
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listTerminals: () => [value],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: {
        appendApproved: async () => {
          appendCalls += 1;
          throw new Error("reject must never append");
        },
      } as never,
      poster: {
        renderTerminal: async () => {
          renderCalls += 1;
          return renderCalls === 1 ? { kind: "uncertain" as const } : { kind: "done" as const };
        },
      },
    });

    await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
    await coordinator.recoverV4Appends(new AbortController().signal);
    expect(appendCalls).toBe(0);
    expect(harness.records[0]?.v4_receipt).toBeUndefined();
    expect(renderCalls).toBe(2);
    expect(harness.marks).toEqual([APPROVAL_ID]);
  });
});
