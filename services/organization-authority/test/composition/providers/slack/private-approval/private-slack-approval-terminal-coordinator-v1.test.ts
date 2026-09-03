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
import type {
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../../../../../src/processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";

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

function telemetryHarness(): {
  readonly telemetry: MeetingApprovalJourneyTelemetryPortV1;
  readonly events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  const terminalStages = new Set<string>();
  let attempt = 0;
  const key = (approvalId: string, stage: string) => `${approvalId}:${stage}`;
  const telemetry = {
    hasTerminalStage: (approvalId: string, stage: string) =>
      terminalStages.has(key(approvalId, stage)),
    beginStageForApproval: (approvalId: string, stage: string) => {
      attempt += 1;
      const value = {
        journey_id: "9f18f3d8-c333-4b0a-8000-000000000001",
        stage,
        attempt,
        started: { observed_at: "2026-08-28T00:00:00.000Z", monotonic_ms: 0 },
      } as MeetingApprovalJourneyStageAttemptV1;
      events.push({ kind: "begin", approvalId, stage, attempt: value });
      return value;
    },
    succeedStage: (
      value: MeetingApprovalJourneyStageAttemptV1 | null,
      input?: { readonly outcome?: string },
    ) => {
      if (value !== null) terminalStages.add(key(APPROVAL_ID, value.stage));
      events.push({ kind: "succeed", stage: value?.stage, outcome: input?.outcome });
    },
    failStage: (value: MeetingApprovalJourneyStageAttemptV1 | null) => {
      events.push({ kind: "fail", stage: value?.stage });
    },
    skipStageForApproval: (approvalId: string, stage: string) => {
      terminalStages.add(key(approvalId, stage));
      events.push({ kind: "skip", approvalId, stage });
    },
    markAwaitingSearch: (approvalId: string) => {
      events.push({ kind: "awaiting", approvalId });
    },
  } as unknown as MeetingApprovalJourneyTelemetryPortV1;
  return { telemetry, events };
}

function throwingTelemetry(): MeetingApprovalJourneyTelemetryPortV1 {
  return new Proxy({} as MeetingApprovalJourneyTelemetryPortV1, {
    get() {
      return () => {
        throw new Error("telemetry unavailable");
      };
    },
  });
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
    const journey = telemetryHarness();
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => queued,
        listDenied: () => [],
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
      journey_telemetry: journey.telemetry,
    });

    await coordinator.observeAndFinalizePendingApprovals(new AbortController().signal);
    expect(denied).toEqual([
      [digest("denied"), "state_drift"],
      [digest("conflict"), "state_drift"],
    ]);
    expect(journey.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "denied" }),
        expect.objectContaining({ kind: "skip", stage: "meeting_record_append" }),
        expect.objectContaining({ kind: "skip", stage: "meeting_search_publication" }),
      ]),
    );
  });

  it("observes a finalized queued action with its durable terminal outcome", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const journey = telemetryHarness();
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [{ receipt: { approval_id: APPROVAL_ID, provider_action_key_sha256: digest("approved") } }] as any,
        listDenied: () => [],
        listTerminals: () => [],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("unreachable"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: journey.telemetry,
    });

    await coordinator.observeAndFinalizePendingApprovals(new AbortController().signal);
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "begin", stage: "meeting_approval_action_queue" }),
      expect.objectContaining({ kind: "succeed", stage: "meeting_approval_action_queue" }),
      expect.objectContaining({ kind: "begin", stage: "meeting_terminal_persist" }),
      expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "approved" }),
    ]));
  });

  it("reconciles a durably queued action before terminal finalization after restart", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const journey = telemetryHarness();
    let queueWasObservedBeforeFinalize = false;
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [{ receipt: { approval_id: APPROVAL_ID, provider_action_key_sha256: digest("queued-after-restart") } }] as any,
        listDenied: () => [],
        listTerminals: () => [],
        finalize: async () => {
          queueWasObservedBeforeFinalize = journey.events.some(
            (event) => event.kind === "succeed" && event.stage === "meeting_approval_action_queue",
          );
          return value;
        },
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("unreachable"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: journey.telemetry,
    });

    await coordinator.observeAndFinalizePendingApprovals(new AbortController().signal);
    expect(queueWasObservedBeforeFinalize).toBe(true);
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "succeed", stage: "meeting_approval_action_queue" }),
      expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "approved" }),
    ]));
  });

  it("reconciles a durably denied receipt after restart without finalizing it again", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const journey = telemetryHarness();
    let finalizations = 0;
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => [{ approval_id: APPROVAL_ID }],
        listTerminals: () => [],
        finalize: async () => {
          finalizations += 1;
          return value;
        },
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("denied must not append"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: journey.telemetry,
    });

    await coordinator.recoverV4Appends(new AbortController().signal);
    expect(finalizations).toBe(0);
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "succeed", stage: "meeting_approval_action_queue" }),
      expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "denied" }),
      expect.objectContaining({ kind: "skip", stage: "meeting_record_append" }),
      expect.objectContaining({ kind: "skip", stage: "meeting_search_publication" }),
    ]));
    const queueSuccess = journey.events.findIndex(
      (event) => event.kind === "succeed" && event.stage === "meeting_approval_action_queue",
    );
    const deniedSuccess = journey.events.findIndex(
      (event) => event.kind === "succeed" && event.stage === "meeting_terminal_persist" && event.outcome === "denied",
    );
    const firstDownstreamSkip = journey.events.findIndex(
      (event) => event.kind === "skip",
    );
    expect(queueSuccess).toBeGreaterThanOrEqual(0);
    expect(deniedSuccess).toBeGreaterThan(queueSuccess);
    expect(firstDownstreamSkip).toBeGreaterThan(deniedSuccess);
  });

  it("keeps denied-receipt recovery staging-only and fail-open", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    let readsWithoutTelemetry = 0;
    const withoutTelemetry = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => {
          readsWithoutTelemetry += 1;
          throw new Error("denied feed must not be read without telemetry");
        },
        listTerminals: () => [],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("unreachable"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
    });
    await expect(
      withoutTelemetry.recoverV4Appends(new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(readsWithoutTelemetry).toBe(0);

    let readsWithTelemetry = 0;
    const withTelemetry = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => {
          readsWithTelemetry += 1;
          throw new Error("denied telemetry feed unavailable");
        },
        listTerminals: () => [],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: { appendApproved: async () => { throw new Error("unreachable"); } } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: telemetryHarness().telemetry,
    });
    await expect(
      withTelemetry.recoverV4Appends(new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(readsWithTelemetry).toBe(1);

    const aborted = new AbortController();
    aborted.abort(new Error("recovery cancelled"));
    await expect(withTelemetry.recoverV4Appends(aborted.signal)).rejects.toThrow(
      "recovery cancelled",
    );
    expect(readsWithTelemetry).toBe(1);
  });

  it("appends only an approved terminal, records it, and renders the DM idempotently", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const appends: unknown[] = [];
    const renders: unknown[] = [];
    const journey = telemetryHarness();
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => [],
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
      journey_telemetry: journey.telemetry,
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
    expect(journey.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "approved" }),
        expect.objectContaining({ kind: "succeed", stage: "meeting_record_append" }),
        expect.objectContaining({ kind: "awaiting", approvalId: APPROVAL_ID }),
      ]),
    );
    expect(
      journey.events.some(
        (event) =>
          (event.kind === "succeed" && event.outcome === "denied") ||
          (event.kind === "skip" &&
            (event.stage === "meeting_record_append" ||
              event.stage === "meeting_search_publication")),
      ),
    ).toBe(false);
  });

  it("records a rejected terminal after supersession without calling V4 and retries an uncertain card update", async () => {
    const value = terminal("rejected");
    const harness = authorityHarness(value);
    let renderCalls = 0;
    let appendCalls = 0;
    const journey = telemetryHarness();
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => [],
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
      journey_telemetry: journey.telemetry,
    });

    await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
    await coordinator.recoverV4Appends(new AbortController().signal);
    expect(appendCalls).toBe(0);
    expect(harness.records[0]?.v4_receipt).toBeUndefined();
    expect(renderCalls).toBe(2);
    expect(harness.marks).toEqual([APPROVAL_ID]);
    expect(journey.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skip", stage: "meeting_record_append" }),
        expect.objectContaining({ kind: "skip", stage: "meeting_search_publication" }),
      ]),
    );
  });

  it("closes an append failure, retries it, and only then marks search awaiting", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    const journey = telemetryHarness();
    let calls = 0;
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [],
        listDenied: () => [],
        listTerminals: () => [value],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: {
        appendApproved: async () => {
          calls += 1;
          if (calls === 1) throw new Error("temporary V4 failure");
          return { receipt: { body: {}, receipt_sha256: digest("receipt"), signing_key_descriptor: {}, signature: "signature" } };
        },
      } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: journey.telemetry,
    });

    await expect(coordinator.appendFinalizedApprovalsToV4(new AbortController().signal)).rejects.toThrow("temporary V4 failure");
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "fail", stage: "meeting_record_append" }),
    ]));
    expect(journey.events.some((event) => event.kind === "awaiting")).toBe(false);

    await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(calls).toBe(2);
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "succeed", stage: "meeting_record_append" }),
      expect.objectContaining({ kind: "awaiting", approvalId: APPROVAL_ID }),
    ]));
  });

  it("recovers a pre-existing approved Authority receipt without appending again", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    let appends = 0;
    const write = {
      appendApproved: async () => {
        appends += 1;
        return { receipt: { body: {}, receipt_sha256: digest("receipt"), signing_key_descriptor: {}, signature: "signature" } };
      },
    } as never;
    const withoutTelemetry = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: { listQueued: () => [], listDenied: () => [], listTerminals: () => [value], finalize: async () => value, recordDenied: () => undefined },
      authority: harness.authority,
      record_writer: write,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
    });
    await withoutTelemetry.appendFinalizedApprovalsToV4(new AbortController().signal);

    const journey = telemetryHarness();
    let awaitingAttempts = 0;
    const telemetry = new Proxy(journey.telemetry, {
      get(target, property, receiver) {
        if (property !== "markAwaitingSearch") {
          return Reflect.get(target, property, receiver);
        }
        return (approvalId: string): void => {
          awaitingAttempts += 1;
          if (awaitingAttempts === 1) throw new Error("sidecar marker unavailable");
          target.markAwaitingSearch(approvalId);
        };
      },
    });
    const recovered = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: { listQueued: () => [], listDenied: () => [], listTerminals: () => [value], finalize: async () => value, recordDenied: () => undefined },
      authority: harness.authority,
      record_writer: write,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: telemetry,
    });
    await recovered.recoverV4Appends(new AbortController().signal);
    await recovered.recoverV4Appends(new AbortController().signal);
    expect(appends).toBe(1);
    expect(awaitingAttempts).toBe(2);
    expect(
      journey.events.filter(
        (event) => event.kind === "begin" && event.stage === "meeting_record_append",
      ),
    ).toHaveLength(1);
    expect(journey.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "succeed", stage: "meeting_terminal_persist", outcome: "approved" }),
      expect.objectContaining({ kind: "succeed", stage: "meeting_record_append" }),
      expect.objectContaining({ kind: "awaiting", approvalId: APPROVAL_ID }),
    ]));
  });

  it("does not let throwing telemetry change finalization or append behavior", async () => {
    const value = terminal("approved");
    const harness = authorityHarness(value);
    let appends = 0;
    const coordinator = new PrivateSlackApprovalTerminalCoordinatorV1({
      control_plane: {
        listQueued: () => [{ receipt: { approval_id: APPROVAL_ID, provider_action_key_sha256: digest("approved") } }] as any,
        listDenied: () => [],
        listTerminals: () => [value],
        finalize: async () => value,
        recordDenied: () => undefined,
      },
      authority: harness.authority,
      record_writer: {
        appendApproved: async () => {
          appends += 1;
          return { receipt: { body: {}, receipt_sha256: digest("receipt"), signing_key_descriptor: {}, signature: "signature" } };
        },
      } as never,
      poster: { renderTerminal: async () => ({ kind: "done" as const }) },
      journey_telemetry: throwingTelemetry(),
    });

    await coordinator.observeAndFinalizePendingApprovals(new AbortController().signal);
    await coordinator.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(appends).toBe(1);
    expect(harness.records).toHaveLength(1);
  });
});
