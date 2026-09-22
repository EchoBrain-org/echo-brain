import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../../tests/support/telemetry-fixture-vocabulary-v1.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateSlackApprovalTerminalCoordinatorV1 } from "../../../../providers/slack/server/src/private-approval/private-slack-approval-terminal-coordinator-v1.js";
import { openMeetingApprovalJourneyStateV1 } from "../../src/composition/meeting-approval-journey-state-v1.js";
import { openMeetingApprovalJourneyTelemetryV1 } from "../../src/composition/meeting-approval-journey-telemetry-v1.js";

const APPROVAL_ID = "approval-terminal-recovery";

describe("private Slack terminal journey recovery", () => {
  it("keeps completed search publication terminal across repeated worker recovery and append passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-terminal-coordinator-journey-"));
    const state = openMeetingApprovalJourneyStateV1(join(root, "journey.sqlite"), {
      create_uuid: () => "9f18f3d8-c333-4b0a-8000-000000000001",
    });
    try {
      const journey = state.beginOrResumeSource({
        source_identity: "source-terminal-recovery-private-sentinel",
        source_revision: "revision-terminal-recovery-private-sentinel",
      });
      state.bindCandidate(
        journey.journey_id,
        "candidate-terminal-recovery-private-sentinel",
        APPROVAL_ID,
      );
      const failures: unknown[] = [];
      const telemetry = openMeetingApprovalJourneyTelemetryV1(
        {
          vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1,
          state_directory: root,
          observer: () => undefined,
          on_observation_failure: (failure) => failures.push(failure),
          release_sha: "c".repeat(40),
          build_number: 42,
          extraction_provider: "openrouter",
          extraction_model: "deepseek/deepseek-v3.2",
        },
        {
          state,
          now: () => "2026-09-22T19:24:23.000Z",
          now_ms: () => 100,
        },
      );
      const resolution = {
        approval_id: APPROVAL_ID,
        canonical_record_policy: {
          policy_id: "organization-member-readable-person-v2",
        },
      };
      const approvedTerminal = { outcome: "approved", resolution } as never;
      let receipt: any;
      let appends = 0;
      const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
        control_plane: {
          listQueued: () => [], listDenied: () => [], listTerminals: () => [approvedTerminal],
          finalize: async () => approvedTerminal, recordDenied: () => undefined,
        },
        authority: {
          readFrozenCandidateForApproval: () => ({
            candidate_id: "candidate-terminal-recovery-private-sentinel",
            approval_id: APPROVAL_ID,
          }),
          readTerminal: () => receipt,
          recordTerminal: (input: { readonly v4_receipt?: unknown }) => {
            receipt = {
              approval_id: APPROVAL_ID,
              outcome: "approved",
              resolution,
              v4_receipt: input.v4_receipt ?? null,
              card_render_state: "unrendered",
            };
            return receipt;
          },
          readForPresentation: () => ({
            assignment: { dm_channel: { channel_id: "DPRIVATE" } },
            provider_message_ts: "1.000001",
            source_outbox_state: "superseded",
          }),
          markTerminalCardRendered: () => {
            if (receipt === undefined) return undefined;
            receipt = { ...receipt, card_render_state: "rendered" };
            return receipt;
          },
        } as never,
        record_writer: {
          appendApproved: async () => {
            appends += 1;
            return { receipt: { body: {}, receipt_sha256: "sha256:receipt", signing_key_descriptor: {}, signature: "signature" } };
          },
        } as never,
        poster: { renderTerminal: async () => ({ kind: "done" as const }) },
        journey_telemetry: telemetry,
      });

      await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
      const attempts = telemetry.beginAwaitingSearch();
      expect(attempts).toHaveLength(1);
      telemetry.completeAwaitingSearch(attempts, "published");
      expect(state.listApprovedRecordsAwaitingSearch()).toEqual([]);

      await coordinator.recoverV4Appends(new AbortController().signal);
      await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
      await coordinator.recoverV4Appends(new AbortController().signal);
      await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);

      expect(appends).toBe(1);
      expect(state.listApprovedRecordsAwaitingSearch()).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
