import { describe, expect, it, vi } from "vitest";
import type {
  ExtractionAttemptKeyV1,
  ExtractionAttemptStoreV1,
} from "../../src/admitted-meeting-processing/extraction-attempt-store-v1.js";
import { LlmDecisionProcessor } from "../../src/llm/llm-decision-processor.js";
import {
  AdmittedMeetingProcessingCycleV1,
  type AdmittedMeetingProcessingAdmissionV1,
  type ApprovalWorkflowStagerV1,
  type AuthorityMeetingProcessingStateV1,
  type FrozenMeetingProcessingCandidateSnapshotV1,
  type HoldExtractionInputV1,
  type MeetingProcessingCandidateSnapshotInputV1,
  type MeetingProcessingCandidateV1,
} from "../../src/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  MeetingProcessingWorkerLifecycleV1,
  type MeetingProcessingWorkerTelemetryEventV1,
} from "../../src/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";
import {
  legacyRestrictedReviewerReviewPolicySnapshotV1,
  reviewInputSha256V1,
  reviewLineageIdV1,
} from "../../src/admitted-meeting-processing/review-lineage-semantics.js";
import {
  AdapterError,
  type AdapterHealth,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type MeetingBatch,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from "../../src/core/index.js";

const fixtureCursor = (cutoff: string) => `fixture-source:v1:live:${cutoff}`;

const CUT_OFF = "2026-08-22T02:03:04.005Z";
const SOURCE = {
  kind: "meeting-source" as const,
  adapter_id: "fixture-source",
  instance_id: "founder-fixture-source",
  version: "2.2.0",
};
const PROCESSOR = {
  kind: "decision-processor" as const,
  adapter_id: "llm",
  instance_id: "founder-llm",
  version: "1.3.0",
};
const REVIEW_POLICY = legacyRestrictedReviewerReviewPolicySnapshotV1;
const fixtureCursorPolicy = {
  source_adapter_id: "fixture-source",
  assert_live_cursor(cursor: string): void {
    if (!cursor.startsWith("fixture-source:v1:") || !cursor.startsWith("fixture-source:v1:live:")) {
      throw new Error(
        "admitted meeting-processing cursor must be a fixture source v1 incremental cursor",
      );
    }
  },
};

const admission = (): AdmittedMeetingProcessingAdmissionV1 => ({
  source: {
    adapter_id: "fixture-source",
    instance_id: SOURCE.instance_id,
    version: SOURCE.version,
    cursor: fixtureCursor(CUT_OFF),
    cutoff_at: CUT_OFF,
  },
  processor: {
    adapter_id: "llm",
    instance_id: PROCESSOR.instance_id,
    version: PROCESSOR.version,
    configuration_sha256: `sha256:${"a".repeat(64)}`,
  },
});

const meeting = (): MeetingDocument => ({
  schema_version: 1,
  id: "meeting-1",
  provenance: {
    source: SOURCE,
    external_id: "fixture-source-note-1",
    canonical_revision: "sha256:note-1",
    observed_at: "2026-08-22T02:04:04.005Z",
    normalizer_version: SOURCE.version,
  },
  capture: { state: "complete", components: [] },
  participants: [],
  content: [
    {
      id: "block-1",
      kind: "note",
      text: "Keep the live source lean.",
    },
  ],
  artifacts: [],
});

const decisions = (value: MeetingDocument): DecisionSet => ({
  schema_version: 1,
  meeting_id: value.id,
  meeting_revision: value.provenance.canonical_revision,
  processor: PROCESSOR,
  generated_at: "2026-08-22T02:05:04.005Z",
  signals: [
    {
      id: "decision-1",
      kind: "decision",
      status: "decided",
      text: "Keep the live source lean.",
      subject: null,
      confidence: 1,
      evidence: [{ meeting_id: value.id, block_id: "block-1" }],
    },
  ],
});

const noSignals = (value: MeetingDocument): DecisionSet => ({
  ...decisions(value),
  signals: [],
});

const healthy = (): AdapterHealth => ({
  status: "healthy",
  checked_at: "2026-08-22T02:05:04.005Z",
});

class FakeState implements AuthorityMeetingProcessingStateV1 {
  readonly advances: Array<{ expected_cursor: string; next_cursor: string }> =
    [];
  readonly candidates: MeetingProcessingCandidateSnapshotInputV1[] = [];
  readonly held = new Map<string, HoldExtractionInputV1>();
  private readonly sourceRevisions = new Map<
    string,
    FrozenMeetingProcessingCandidateSnapshotV1
  >();

  constructor(
    private readonly value: AdmittedMeetingProcessingAdmissionV1,
    private readonly advanceResult:
      "advanced" | "state_drift" | "revoked" = "advanced",
  ) {}

  async readAdmission(): Promise<AdmittedMeetingProcessingAdmissionV1> {
    return this.value;
  }

  async readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return this.sourceRevisions.get(
      `${input.external_id}:${input.canonical_revision}`,
    );
  }

  async readFrozenCandidateForReviewInput(input: {
    readonly review_lineage_id: string;
    readonly review_input_sha256: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined> {
    return [...this.sourceRevisions.values()].find(
      (candidate) =>
        candidate.review_lineage_id === input.review_lineage_id &&
        candidate.review_input_sha256 === input.review_input_sha256,
    );
  }

  async stageCandidate(
    input: MeetingProcessingCandidateSnapshotInputV1,
  ): Promise<MeetingProcessingCandidateV1> {
    this.candidates.push(input);
    const reviewInputSha256 = reviewInputSha256V1({
      meeting: input.meeting,
      processor: input.admission.processor,
    });
    const reusable = [...this.sourceRevisions.values()].find(
      (candidate) =>
        candidate.meeting.provenance.external_id ===
          input.meeting.provenance.external_id &&
        candidate.review_input_sha256 === reviewInputSha256,
    );
    const actionable = input.decisions.signals.length > 0;
    const reviewLineageId = reviewLineageIdV1({
      adapter_id: input.meeting.provenance.source.adapter_id,
      instance_id: input.meeting.provenance.source.instance_id,
      external_id: input.meeting.provenance.external_id,
    });
    const shared = {
      review_input_sha256: reviewInputSha256,
      review_policy_id: input.review_policy.policy_id,
      review_policy_contract_sha256:
        input.review_policy.policy_contract_sha256,
      review_policy_consequence_text:
        input.review_policy.policy_consequence_text,
      review_policy_consequence_sha256:
        input.review_policy.policy_consequence_sha256,
    };
    const fresh = {
      ...shared,
      candidate_id: "cnd_test",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      review_lineage_id: reviewLineageId,
      review_semantic_sha256: `sha256:${"d".repeat(64)}`,
    };
    const candidate: MeetingProcessingCandidateV1 = reusable !== undefined
      ? {
          ...shared,
          candidate_id: "cnd_test_coalesced",
          candidate_semantic_sha256: `sha256:${"e".repeat(64)}`,
          review_lineage_id: reusable.review_lineage_id,
          review_semantic_sha256: reusable.review_semantic_sha256,
          disposition: "coalesced", approval_id: null, stage_command_id: null, state: "coalesced",
        }
      : actionable
      ? { ...fresh, disposition: "actionable", approval_id: "apr_test", stage_command_id: "pas_test", state: "queued" }
      : { ...fresh, disposition: "no_signals", approval_id: null, stage_command_id: null, state: "no_signals" };
    this.sourceRevisions.set(
      `${input.meeting.provenance.external_id}:${input.meeting.provenance.canonical_revision}`,
      { ...candidate, ...input },
    );
    return candidate;
  }

  seedFrozenCandidate(input: FrozenMeetingProcessingCandidateSnapshotV1): void {
    this.sourceRevisions.set(
      `${input.meeting.provenance.external_id}:${input.meeting.provenance.canonical_revision}`,
      input,
    );
  }

  async advanceCursor(input: {
    readonly expected_cursor: string;
    readonly next_cursor: string;
  }): Promise<"advanced" | "state_drift" | "revoked"> {
    this.advances.push(input);
    return this.advanceResult;
  }

  /** Keeps the stored stage while the key and attempt are unchanged, as the Authority does. */
  async holdExtraction(input: HoldExtractionInputV1): Promise<HoldExtractionInputV1["failure_stage"]> {
    const stored = this.held.get(input.key.review_lineage_id);
    const failure_stage = stored !== undefined && JSON.stringify([stored.key, stored.attempt]) === JSON.stringify([input.key, input.attempt])
      ? stored.failure_stage : input.failure_stage;
    this.held.set(input.key.review_lineage_id, { ...input, failure_stage });
    return failure_stage;
  }

  async listHeldExtractions(): Promise<never[]> { return []; }

  async readHeldMeeting(): Promise<never> { throw new Error("held meetings are read from the Authority"); }
  async releaseHeldExtraction(): Promise<void> {}
}

class FailingFrozenReadState extends FakeState {
  override async readFrozenCandidateForSourceRevision(): Promise<never> {
    throw new Error("frozen source revision read failed");
  }
}

class FailingCursorAdvanceState extends FakeState {
  override async advanceCursor(): Promise<never> {
    throw new Error("source cursor advance failed");
  }
}

class RecordingExtractionAttempts implements ExtractionAttemptStoreV1 {
  readonly keys: ExtractionAttemptKeyV1[] = [];
  readonly completed: Parameters<ExtractionAttemptStoreV1["complete"]>[0][] = [];
  private readonly claims = new Map<string, { attempt: number; claim_id: string; reserved_at: string }>();

  reserve(key: ExtractionAttemptKeyV1): ReturnType<ExtractionAttemptStoreV1["reserve"]> {
    this.keys.push(key);
    const id = JSON.stringify(key);
    const previous = this.claims.get(id);
    if (previous !== undefined) {
      const complete = this.completed.find((entry) => entry.claim_id === previous.claim_id);
      return {
        status: "blocked", attempt: previous.attempt,
        outcome: complete?.outcome ?? "pending",
        failure_code: complete?.outcome === "failed" ? complete.failure_code : null, reserved_at: previous.reserved_at,
      };
    }
    const claim = { attempt: 1, claim_id: `claim-${this.claims.size + 1}`, reserved_at: new Date().toISOString() };
    this.claims.set(id, claim);
    return { status: "reserved", attempt: claim.attempt, claim_id: claim.claim_id };
  }

  complete(input: Parameters<ExtractionAttemptStoreV1["complete"]>[0]): void {
    this.completed.push(input);
  }

  inspect(): undefined { return undefined; }
}

function source(batch: MeetingBatch): MeetingSourceAdapter {
  return {
    identity: SOURCE,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    pull: async () => batch,
  };
}

function processor(
  extract: (
    value: MeetingDocument,
    context?: Parameters<DecisionProcessorAdapter["extract"]>[1],
  ) => DecisionSet = decisions,
): DecisionProcessorAdapter {
  return {
    identity: PROCESSOR,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    extract: async (value, context) => extract(value, context),
  };
}

function stager(
  result: Awaited<ReturnType<ApprovalWorkflowStagerV1["stage"]>>,
): ApprovalWorkflowStagerV1 & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    stage: async () => {
      calls += 1;
      return result;
    },
    reconcilePendingDeliveries: async () => {},
    reconcileSuperseded: async () => {},
  };
}

type CycleOptions = ConstructorParameters<typeof AdmittedMeetingProcessingCycleV1>[0];
type DefaultedCycleOption = "source_cursor_policy" | "processor" | "stager";

function liveCycle(
  options: Omit<CycleOptions, DefaultedCycleOption> &
    Partial<Pick<CycleOptions, DefaultedCycleOption>>,
): AdmittedMeetingProcessingCycleV1 {
  return new AdmittedMeetingProcessingCycleV1({
    ...options,
    processor: options.processor ?? processor(),
    stager: options.stager ?? stager({ kind: "staged", stage_id: "never" }),
    source_cursor_policy:
      options.source_cursor_policy ?? fixtureCursorPolicy,
  });
}

/** Frozen-candidate fields shared by every seeded snapshot; callers add the handoff fields. */
function frozenCandidate(
  current: AdmittedMeetingProcessingAdmissionV1,
  value: MeetingDocument,
  frozenDecisions: DecisionSet,
) {
  return {
    candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
    review_lineage_id: "rli_test",
    review_input_sha256: `sha256:${"c".repeat(64)}`,
    review_semantic_sha256: `sha256:${"d".repeat(64)}`,
    review_policy_id: REVIEW_POLICY.policy_id,
    review_policy_contract_sha256: REVIEW_POLICY.policy_contract_sha256,
    review_policy_consequence_text: REVIEW_POLICY.policy_consequence_text,
    review_policy_consequence_sha256: REVIEW_POLICY.policy_consequence_sha256,
    admission: current,
    meeting: value,
    decisions: frozenDecisions,
  };
}

const phases = (events: readonly MeetingProcessingWorkerTelemetryEventV1[]) =>
  events.map((event) =>
    event.kind === "echo-clean-live-worker-phase-v1"
      ? `${event.cycle_phase}:${event.event}`
      : event.event,
  );

describe("admitted meeting-processing cycle", () => {
  it.each(["fixed", "resolved"] as const)("rejects %s on-request policy before admission, analysis or cursor advancement", async (kind) => {
    let admitted = false;
    let extracted = false;
    const state = new FakeState(admission());
    const scope = { organization_id: "org-1", custody_ref: "organization:org-1", access_policy_ref: "meeting-source:fixture", analysis_policy: "on_request" as const };
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: fixtureCursor("2026-08-22T02:05:00.000Z") }),
      source_ingestion: {
        scope: kind === "fixed" ? scope : () => scope,
        store: { admitSourceRevision: async () => { admitted = true; return "admitted"; } },
      },
      processor: processor((value) => { extracted = true; return decisions(value); }),
      state,
    });
    await expect(cycle.runOnce()).rejects.toThrow("automatic meeting processing requires automatic source analysis policy");
    expect(admitted).toBe(false);
    expect(extracted).toBe(false);
    expect(state.advances).toHaveLength(0);
    expect(state.candidates).toHaveLength(0);
  });

  it("durably admits meeting context before analysis and does not lose it when analysis fails", async () => {
    const events: string[] = [];
    const state = new FakeState(admission());
    const observed = meeting();
    const cycle = liveCycle({
      source: source({ meetings: [observed], next_cursor: fixtureCursor("2026-08-22T02:05:00.000Z") }),
      source_ingestion: {
        scope: { organization_id: "org-1", custody_ref: "organization:org-1", access_policy_ref: "meeting-source:fixture", analysis_policy: "automatic" },
        store: { admitSourceRevision: async ({ source: captured }) => {
          expect(captured.item.external_id).toBe(observed.provenance.external_id);
          expect(captured.revision.captured_at).toBe(observed.provenance.observed_at);
          events.push("admitted");
          return "admitted";
        } },
      },
      processor: processor(() => { events.push("analysis"); throw new Error("analysis unavailable"); }),
      state,
    });
    await expect(cycle.runOnce()).rejects.toThrow("analysis unavailable");
    expect(events).toEqual(["admitted", "analysis"]);
    expect(state.advances).toHaveLength(0);
    expect(state.candidates).toHaveLength(0);
  });

  it("does not analyze or advance after common source admission fails", async () => {
    let extracted = false;
    const state = new FakeState(admission());
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: fixtureCursor("2026-08-22T02:05:00.000Z") }),
      source_ingestion: {
        scope: { organization_id: "org-1", custody_ref: "organization:org-1", access_policy_ref: "meeting-source:fixture", analysis_policy: "automatic" },
        store: { admitSourceRevision: async () => { throw new Error("source custody unavailable"); } },
      },
      processor: processor((value) => { extracted = true; return decisions(value); }),
      state,
    });
    await expect(cycle.runOnce()).rejects.toThrow("source custody unavailable");
    expect(extracted).toBe(false);
    expect(state.advances).toHaveLength(0);
  });

  it.each([
    new AdapterError("permanently_rejected", "provider credit unavailable", false),
    new AdapterError("temporarily_unavailable", "provider temporarily unavailable", true),
    new AdapterError("rate_limited", "provider rate limited", true),
    new AdapterError("timeout", "provider timed out", true),
    new Error("provider outcome unknown"),
  ])("parks a failed extraction and moves past it without spending again on an unchanged review input: $message", async (failure) => {
    let calls = 0;
    let recoveredDeliveries = 0;
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    const options = {
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(() => {
        expect(extraction_attempts.keys).toHaveLength(1);
        calls += 1;
        throw failure;
      }),
      state,
      stager: {
        ...stager({ kind: "staged", stage_id: "never" }),
        reconcilePendingDeliveries: async () => { recoveredDeliveries += 1; },
      },
      extraction_attempts,
    };

    const held = { kind: "held", stage: failure instanceof AdapterError ? failure.code : "unknown", cursor_advanced: true };
    await expect(liveCycle(options).runOnce()).resolves.toEqual(held);
    // Redelivered (as after a crash before the advance), it parks again from the ledger and keeps its stage.
    await expect(liveCycle(options).runOnce()).resolves.toEqual(held);
    expect(calls).toBe(1);
    expect(recoveredDeliveries).toBe(2);
    expect(state.advances).toHaveLength(2);
    expect(state.candidates).toHaveLength(0);
    expect(extraction_attempts.completed).toMatchObject([{ outcome: "failed", failure_code: held.stage }]);
  });

  it("closes the attempt and keeps why it could not park when the hold fails", async () => {
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    const holdFailure = new Error("held row unavailable");
    state.holdExtraction = async () => { throw holdFailure; };
    const run = liveCycle({ source: source({ meetings: [meeting()] }), state, extraction_attempts,
      processor: processor(() => { throw new Error("generation failed"); }) }).runOnce();
    await expect(run).rejects.toMatchObject({ message: "generation failed", cause: holdFailure });
    expect(extraction_attempts.completed).toMatchObject([{ outcome: "failed", failure_code: "unknown" }]);
  });

  it("does not regenerate a successful model response rejected by the real grounding validator", async () => {
    let generations = 0;
    const extraction = new LlmDecisionProcessor({
      adapter_id: "llm", instance_id: PROCESSOR.instance_id, settings: { model: "fixture-model" },
    }, {
      client: {
        provider: "fixture",
        verifyModel: async () => undefined,
        generateStructured: async () => {
          generations += 1;
          return { content: JSON.stringify({ signals: [{
            kind: "decision", text: "Keep the live source lean.", status: "decided",
            owner: null, due_at: null, confidence: 1, supports_decision_indexes: [],
            evidence_units: ["T999"],
          }] }), inputTokens: 100, outputTokens: 20, totalTokens: 120, stopReason: "stop" };
        },
      },
      validateProviderConfig: () => [], identityEndpoint: null,
    });
    const options = {
      source: source({ meetings: [meeting()] }), processor: extraction,
      state: new FakeState({ ...admission(), processor: { ...admission().processor, version: extraction.identity.version } }),
      extraction_attempts: new RecordingExtractionAttempts(),
    };
    await expect(liveCycle(options).runOnce()).resolves.toMatchObject({ kind: "held", stage: "evidence_id" });
    await expect(liveCycle(options).runOnce()).resolves.toMatchObject({ kind: "held", stage: "evidence_id" });
    expect(generations).toBe(1);
  });

  it("keys the hold by review input instead of provider revision, observation or cursor", async () => {
    const extraction_attempts = new RecordingExtractionAttempts();
    const admitted = admission();
    const state = new FakeState(admitted);
    let calls = 0;
    const run = (value: MeetingDocument) => liveCycle({
      source: source({ meetings: [value] }), state, extraction_attempts,
      processor: processor(() => { calls += 1; throw new Error("generation failed"); }),
    }).runOnce();
    const held = { kind: "held", stage: "unknown" };
    await expect(run(meeting())).resolves.toMatchObject(held);
    const sameInput = {
      ...meeting(),
      provenance: { ...meeting().provenance, canonical_revision: "sha256:folder-change", observed_at: "2026-08-22T03:00:00.000Z" },
      extensions: { "fixture-source": { folder_membership: [] } },
    };
    await expect(run(sameInput)).resolves.toMatchObject(held);
    Object.assign(admitted.source, { cursor: fixtureCursor("2026-08-22T03:00:00.000Z") });
    await expect(run(sameInput)).resolves.toMatchObject(held);
    expect(calls).toBe(1);
    expect(extraction_attempts.keys[1]).toEqual(extraction_attempts.keys[0]);
    expect(extraction_attempts.keys[2]).toEqual(extraction_attempts.keys[0]);

    await expect(run({ ...sameInput, content: [{ id: "block-1", kind: "note", text: "A changed decision input." }] })).resolves.toMatchObject(held);
    await expect(run({ ...sameInput, time: { actual_start_at: "2026-08-22T01:00:00.000Z" } })).resolves.toMatchObject(held);
    expect(calls).toBe(3);
    expect(extraction_attempts.keys[3]!.review_input_sha256).not.toBe(extraction_attempts.keys[0]!.review_input_sha256);
    expect(extraction_attempts.keys[4]!.review_input_sha256).not.toBe(extraction_attempts.keys[0]!.review_input_sha256);
  });

  it("keeps a successful generation spent if candidate persistence fails", async () => {
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    state.stageCandidate = async () => { throw new Error("candidate persistence unavailable"); };
    let calls = 0;
    const options = {
      source: source({ meetings: [meeting()] }), state, extraction_attempts,
      processor: processor((value) => { calls += 1; return decisions(value); }),
    };
    await expect(liveCycle(options).runOnce()).rejects.toThrow("candidate persistence unavailable");
    await expect(liveCycle(options).runOnce()).resolves.toEqual({ kind: "held", stage: "output_not_saved", cursor_advanced: false });
    expect(calls).toBe(1);
    expect(extraction_attempts.completed).toMatchObject([{ outcome: "succeeded" }]);
    expect(state.advances).toHaveLength(0);
  });

  it("continues frozen candidate delivery and reuses frozen review input without another claim", async () => {
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    let calls = 0;
    const run = (value: MeetingDocument) => liveCycle({
      source: source({ meetings: [value] }), state, extraction_attempts,
      processor: processor((input) => { calls += 1; return decisions(input); }),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
    }).runOnce();
    await expect(run(meeting())).resolves.toMatchObject({ kind: "staged" });
    await expect(run(meeting())).resolves.toMatchObject({ kind: "staged" });
    await expect(run({ ...meeting(), provenance: { ...meeting().provenance, canonical_revision: "sha256:metadata-only" } })).resolves.toMatchObject({ kind: "already_processed" });
    expect(calls).toBe(1);
    expect(extraction_attempts.keys).toHaveLength(1);
  });

  it("treats a fresh pending attempt as in flight, then parks it with its kept stage or as interrupted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const extraction_attempts = new RecordingExtractionAttempts();
      extraction_attempts.complete = () => { throw new Error("attempt completion unavailable"); };
      let calls = 0;
      const options = {
        source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }), state: new FakeState(admission()), extraction_attempts,
        processor: processor(() => { calls += 1; throw new Error("provider outcome unknown"); }),
      };
      await expect(liveCycle(options).runOnce()).rejects.toThrow("attempt completion unavailable");
      // A crash mid-extraction leaves a pending attempt and no held row; within its lease it may still be running elsewhere.
      const crashed = new FakeState(admission());
      await expect(liveCycle({ ...options, state: crashed }).runOnce()).resolves.toEqual({ kind: "in_flight", cursor_advanced: false });
      expect([crashed.held.size, crashed.advances.length]).toEqual([0, 0]);
      vi.setSystemTime(Date.now() + 660_000);
      await expect(liveCycle(options).runOnce()).resolves.toMatchObject({ kind: "held", stage: "unknown" });
      await expect(liveCycle({ ...options, state: crashed }).runOnce()).resolves.toEqual({ kind: "held", stage: "interrupted", cursor_advanced: true });
      expect(calls).toBe(1);
      expect(extraction_attempts.completed).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not park an aborted run; the next poll parks it as cancelled", async () => {
    const controller = new AbortController();
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    const options = {
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }), state, extraction_attempts,
      processor: processor(() => { controller.abort(new Error("worker shutdown")); throw new Error("extraction interrupted"); }),
    };
    await expect(liveCycle(options).runOnce(controller.signal)).rejects.toThrow("extraction interrupted");
    expect(state.held.size).toBe(0);
    expect(state.advances).toHaveLength(0);
    expect(extraction_attempts.completed).toMatchObject([{ outcome: "failed", failure_code: "cancelled" }]);
    await expect(liveCycle(options).runOnce()).resolves.toEqual({ kind: "held", stage: "cancelled", cursor_advanced: true });
  });

  it("closes a failed extraction without opening another paid attempt", async () => {
    let calls = 0;
    const cycle = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor((value) => {
        calls += 1;
        if (calls === 1) throw new Error("provider retry");
        return decisions(value);
      }),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
      extraction_attempts: new RecordingExtractionAttempts(),
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "held", stage: "unknown" });
    await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "held", stage: "unknown" });
    expect(calls).toBe(1);
  });

  it("never re-extracts a frozen no-signal revision", async () => {
    const current = admission();
    const observed = meeting();
    const state = new FakeState(current);
    state.seedFrozenCandidate({
      ...frozenCandidate(current, observed, noSignals(observed)),
      candidate_id: "cnd_frozen",
      disposition: "no_signals",
      approval_id: null,
      stage_command_id: null,
      state: "no_signals",
    });
    for (let index = 0; index < 2; index += 1) {
      const cycle = liveCycle({
        source: source({ meetings: [observed] }),
        processor: processor(() => {
          throw new Error("frozen revision must not invoke extraction");
        }),
        state,
      });
      await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "already_processed" });
    }
    expect(state.candidates).toHaveLength(0);
  });

  it("reports source intake, extraction, and approval staging without meeting data", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const observedMeeting = meeting();
    const cycle = liveCycle({
      source: source({ meetings: [observedMeeting], next_cursor: undefined }),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
    });
    cycle.setWorkerLifecycle(
      new MeetingProcessingWorkerLifecycleV1((event) => events.push(event)),
    );

    await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "staged" });

    expect(
      events
        .filter((event) => event.kind === "echo-clean-live-worker-phase-v1")
        .map((event) => event.cycle_phase),
    ).toEqual([
      "source_intake",
      "source_intake",
      "extraction",
      "extraction",
      "approval_staging",
      "approval_staging",
      "approval_staging",
      "approval_staging",
    ]);
    const encoded = JSON.stringify(events);
    for (const forbidden of [
      observedMeeting.id,
      observedMeeting.provenance.external_id,
      observedMeeting.content[0]!.text,
      "stage-1",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("keeps source-state failures inside the source intake phase", async () => {
    for (const scenario of [
      {
        source: source({ meetings: [meeting()] }),
        state: new FailingFrozenReadState(admission()),
        failure: "frozen source revision read failed",
      },
      {
        source: source({
          meetings: [],
          next_cursor: "fixture-source:v1:next",
        }),
        state: new FailingCursorAdvanceState(admission()),
        failure: "source cursor advance failed",
      },
    ]) {
      const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
      const cycle = liveCycle({
        source: scenario.source,
        state: scenario.state,
      });
      cycle.setWorkerLifecycle(
        new MeetingProcessingWorkerLifecycleV1((event) => events.push(event)),
      );

      await expect(cycle.runOnce()).rejects.toThrow(scenario.failure);
      expect(events).toMatchObject([
        {
          kind: "echo-clean-live-worker-phase-v1",
          event: "started",
          cycle_phase: "source_intake",
        },
        {
          kind: "echo-clean-live-worker-phase-v1",
          event: "failed",
          cycle_phase: "source_intake",
        },
      ]);
    }
  });

  it("reports canonical decision validation failures as extraction failures", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const cycle = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor((value) => ({
        ...decisions(value),
        meeting_id: "wrong-meeting",
      })),
      state: new FakeState(admission()),
    });
    cycle.setWorkerLifecycle(
      new MeetingProcessingWorkerLifecycleV1((event) => events.push(event)),
    );

    await expect(cycle.runOnce()).rejects.toThrow();
    expect(phases(events)).toEqual([
      "source_intake:started",
      "source_intake:succeeded",
      "extraction:started",
      "extraction:failed",
    ]);
  });

  it("does not start the next phase after shutdown is requested", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const controller = new AbortController();
    const state = new FakeState(admission());
    let extracts = 0;
    const cycle = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor((value) => {
        extracts += 1;
        return decisions(value);
      }),
      state,
    });
    cycle.setWorkerLifecycle(
      new MeetingProcessingWorkerLifecycleV1((event) => {
        events.push(event);
        if (
          event.kind === "echo-clean-live-worker-phase-v1" &&
          event.cycle_phase === "source_intake" &&
          event.event === "succeeded"
        ) {
          controller.abort(new Error("worker shutdown"));
        }
      }),
    );

    await expect(cycle.runOnce(controller.signal)).rejects.toThrow(
      "worker shutdown",
    );
    expect(extracts).toBe(0);
    expect(state.candidates).toEqual([]);
    expect(phases(events)).toEqual(["source_intake:started", "source_intake:succeeded"]);
  });

  it("does not advance when the downstream approval target is revoked or drifted", async () => {
    for (const result of [
      { kind: "revoked" } as const,
      { kind: "state_drift" } as const,
    ]) {
      const state = new FakeState(admission());
      const cycle = liveCycle({
        source: source({
          meetings: [meeting()],
          next_cursor: "fixture-source:v1:next",
        }),
        state,
        stager: stager(result),
      });
      await expect(cycle.runOnce()).resolves.toEqual({
        kind: "not_staged",
        reason: result.kind,
        cursor_advanced: false,
      });
      expect(state.advances).toEqual([]);
      expect(state.candidates).toHaveLength(1);
    }
  });

  it("stages before it advances the cursor", async () => {
    const current = admission();
    const state = new FakeState(current);
    const order: string[] = [];
    const downstream: ApprovalWorkflowStagerV1 = {
      stage: async () => {
        // The approval core freezes an import's pending choices before the advance records them (R28).
        order.push(`stage:${state.advances.length}`);
        return { kind: "staged", stage_id: "stage-1" };
      },
      reconcilePendingDeliveries: async () => { order.push(`reconcile:${state.advances.length}`); },
      reconcileSuperseded: async () => {},
    };
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      state,
      stager: downstream,
    });
    await expect(cycle.runOnce()).resolves.toEqual({ kind: "staged", stage_id: "stage-1", cursor_advanced: true });
    expect(order).toEqual(["stage:0", "reconcile:1"]);
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([{ expected_cursor: current.source.cursor, next_cursor: "fixture-source:v1:next" }]);
  });

  it("admits and advances the next meeting before surfacing an older delivery failure", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream: ApprovalWorkflowStagerV1 = {
      stage: async () => ({ kind: "staged", stage_id: "stage-1" }),
      reconcilePendingDeliveries: async () => {
        throw new Error("older Slack delivery failed");
      },
      reconcileSuperseded: async () => {},
    };
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      state,
      stager: downstream,
    });

    await expect(cycle.runOnce()).rejects.toThrow("older Slack delivery failed");
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
  });

  it("advances a durably queued candidate before surfacing its delivery exception", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream: ApprovalWorkflowStagerV1 = {
      stage: async () => {
        throw new Error("Slack transport threw");
      },
      reconcilePendingDeliveries: async () => {},
      reconcileSuperseded: async () => {},
    };
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      state,
      stager: downstream,
    });

    await expect(cycle.runOnce()).rejects.toThrow("Slack transport threw");
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toHaveLength(1);
  });

  it("reports the freeze failure when the advance after it also fails", async () => {
    const state = new FailingCursorAdvanceState(admission());
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      state,
      stager: {
        stage: async () => { throw new Error("proposal freeze refused"); },
        reconcilePendingDeliveries: async () => {},
        reconcileSuperseded: async () => {},
      },
    });

    await expect(cycle.runOnce()).rejects.toThrow("proposal freeze refused");
    expect(state.candidates).toHaveLength(1);
  });

  it("keeps a durable staged item visible when the Authority cursor fence drifts", async () => {
    const state = new FakeState(admission(), "state_drift");
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      state,
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
    });
    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "staged_cursor_not_advanced",
      stage_id: "stage-1",
      reason: "state_drift",
      cursor_advanced: false,
    });
    expect(state.advances).toHaveLength(1);
  });

  it.each([
    ["advanced", { kind: "empty_cursor_advanced", cursor_advanced: true }],
    ["state_drift", { kind: "empty_cursor_not_advanced", reason: "state_drift", cursor_advanced: false }],
    ["revoked", { kind: "empty_cursor_not_advanced", reason: "revoked", cursor_advanced: false }],
  ] as const)("CAS advances an empty fixture source page only when its cursor fence is %s", async (fence, expected) => {
    const current = admission();
    const state = new FakeState(current, fence);
    const cycle = liveCycle({
      source: source({ meetings: [], next_cursor: "fixture-source:v1:next" }),
      state,
    });
    await expect(cycle.runOnce()).resolves.toEqual(expected);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
    expect(state.candidates).toEqual([]);
  });

  it.each([
    ["advanced", { kind: "no_signals_cursor_advanced", cursor_advanced: true }],
    ["state_drift", { kind: "no_signals_cursor_not_advanced", reason: "state_drift", cursor_advanced: false }],
    ["revoked", { kind: "no_signals_cursor_not_advanced", reason: "revoked", cursor_advanced: false }],
  ] as const)("records no-signal revisions without Slack staging, then CAS advances only when the fence is %s", async (fence, expected) => {
    const current = admission();
    const state = new FakeState(current, fence);
    const downstream = stager({ kind: "staged", stage_id: "never" });
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(noSignals),
      state,
      stager: downstream,
    });
    await expect(cycle.runOnce()).resolves.toEqual(expected);
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]!.decisions.signals).toEqual([]);
    expect(downstream.calls).toBe(0);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
  });

  it("reuses extraction and coalesces a same-policy folder-only revision", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "stage-1" });
    let extracts = 0;
    const countingProcessor = processor((value) => {
      extracts += 1;
      const extracted = decisions(value);
      return {
        ...extracted,
        signals: extracted.signals.map((signal) => ({
          ...signal,
          evidence: signal.evidence.map((evidence) => ({
            ...evidence,
            ...(value.content[0]?.started_at === undefined
              ? {}
              : { started_at: value.content[0].started_at }),
            ...(value.content[0]?.ended_at === undefined
              ? {}
              : { ended_at: value.content[0].ended_at }),
          })),
        })),
      };
    });
    const original: MeetingDocument = {
      ...meeting(),
      content: [
        {
          ...meeting().content[0]!,
          started_at: "2026-08-22T02:04:10.000Z",
          ended_at: "2026-08-22T02:04:12.000Z",
        },
      ],
    };
    const first = liveCycle({
      source: source({ meetings: [original] }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(first.runOnce()).resolves.toMatchObject({ kind: "staged" });

    const folderOnly: MeetingDocument = {
      ...original,
      provenance: {
        ...original.provenance,
        canonical_revision: "sha256:folder-only",
      },
      extensions: {
        "fixture-source": {
          folder_membership: [{ id: "folder-notes", name: "notes" }],
        },
      },
      content: [
        {
          ...original.content[0]!,
          id: "block-renumbered",
          started_at: "2026-08-22T02:04:11.000Z",
          ended_at: "2026-08-22T02:04:13.000Z",
        },
      ],
    };
    const second = liveCycle({
      source: source({ meetings: [folderOnly] }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(second.runOnce()).resolves.toEqual({
      kind: "already_processed",
      cursor_advanced: false,
    });
    expect(extracts).toBe(1);
    expect(downstream.calls).toBe(1);
    expect(state.candidates.at(-1)).toMatchObject({
      meeting: folderOnly,
      decisions: {
        meeting_revision: folderOnly.provenance.canonical_revision,
        signals: [
          {
            evidence: [
              {
                meeting_id: folderOnly.id,
                block_id: "block-renumbered",
                started_at: "2026-08-22T02:04:11.000Z",
                ended_at: "2026-08-22T02:04:13.000Z",
              },
            ],
          },
        ],
      },
    });
  });

  it("extracts again when a later revision changes only meeting time", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "stage-1" });
    let extracts = 0;
    const countingProcessor = processor((value) => {
      extracts += 1;
      return decisions(value);
    });
    const original: MeetingDocument = {
      ...meeting(),
      time: {
        actual_start_at: "2026-08-22T16:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
    };
    const first = liveCycle({
      source: source({ meetings: [original] }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(first.runOnce()).resolves.toMatchObject({ kind: "staged" });

    const revised: MeetingDocument = {
      ...original,
      provenance: {
        ...original.provenance,
        canonical_revision: "sha256:time-only-revision",
      },
      time: {
        ...original.time,
        actual_start_at: "2026-08-23T16:00:00.000Z",
      },
    };
    const second = liveCycle({
      source: source({ meetings: [revised] }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(second.runOnce()).resolves.toMatchObject({ kind: "staged" });
    expect(extracts).toBe(2);
  });

  it("retries a queued revision with only its frozen snapshot", async () => {
    const current = admission();
    const state = new FakeState(current);
    const originalMeeting = meeting();
    const originalDecisions = decisions(originalMeeting);
    state.seedFrozenCandidate({
      ...frozenCandidate(current, originalMeeting, originalDecisions),
      candidate_id: "cnd_queued",
      disposition: "actionable",
      approval_id: "apr_queued",
      stage_command_id: "pas_queued",
      state: "queued",
    });
    let extracts = 0;
    let retried: Parameters<ApprovalWorkflowStagerV1["stage"]>[0] | undefined;
    const downstream: ApprovalWorkflowStagerV1 = {
      stage: async (input) => {
        retried = input;
        return { kind: "staged", stage_id: "stage-1" };
      },
      reconcilePendingDeliveries: async () => {},
      reconcileSuperseded: async () => {},
    };
    const changedObservation: MeetingDocument = {
      ...originalMeeting,
      provenance: {
        ...originalMeeting.provenance,
        observed_at: "2026-08-22T02:06:04.005Z",
      },
    };
    const cycle = liveCycle({
      source: source({
        meetings: [changedObservation],
        next_cursor: current.source.cursor,
      }),
      processor: processor((value) => {
        extracts += 1;
        return decisions(value);
      }),
      state,
      stager: downstream,
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "staged",
      stage_id: "stage-1",
      cursor_advanced: false,
    });
    expect(extracts).toBe(0);
    expect(retried).toEqual({
      admission: current,
      candidate: expect.objectContaining({
        state: "queued",
        review_policy_contract_sha256:
          REVIEW_POLICY.policy_contract_sha256,
        review_policy_consequence_text:
          REVIEW_POLICY.policy_consequence_text,
      }),
      meeting: originalMeeting,
      decisions: originalDecisions,
    });
    expect(state.advances).toEqual([]);
  });

  it("reconciles a durably staged candidate after a restart", async () => {
    const current = admission();
    const state = new FakeState(current);
    const originalMeeting = meeting();
    state.seedFrozenCandidate({
      ...frozenCandidate(current, originalMeeting, decisions(originalMeeting)),
      candidate_id: "cnd_staged",
      disposition: "actionable",
      approval_id: "apr_staged",
      stage_command_id: "pas_staged",
      state: "staged",
    });
    let extracts = 0;
    let stages = 0;
    const countingProcessor = processor((value) => {
      extracts += 1;
      return decisions(value);
    });
    const downstream: ApprovalWorkflowStagerV1 = {
      stage: async () => {
        stages += 1;
        return { kind: "staged", stage_id: "stage-1" };
      },
      reconcilePendingDeliveries: async () => {},
      reconcileSuperseded: async () => {},
    };

    const repeated = liveCycle({
      source: source({
        meetings: [
          {
            ...originalMeeting,
            provenance: {
              ...originalMeeting.provenance,
              observed_at: "2026-08-22T02:06:04.005Z",
            },
          },
        ],
        next_cursor: current.source.cursor,
      }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(repeated.runOnce()).resolves.toEqual({
      kind: "already_processed",
      cursor_advanced: false,
    });
    expect(extracts).toBe(0);
    expect(stages).toBe(0);

    const revisedMeeting: MeetingDocument = {
      ...originalMeeting,
      provenance: {
        ...originalMeeting.provenance,
        canonical_revision: "sha256:note-2",
      },
    };
    const revised = liveCycle({
      source: source({
        meetings: [revisedMeeting],
        next_cursor: current.source.cursor,
      }),
      processor: countingProcessor,
      state,
      stager: downstream,
    });
    await expect(revised.runOnce()).resolves.toEqual({
      kind: "staged",
      stage_id: "stage-1",
      cursor_advanced: false,
    });
    expect(extracts).toBe(1);
    expect(stages).toBe(1);
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([]);
  });

  it("does not advance a terminal empty poll, accept historical cursors, or process a page larger than one", async () => {
    const emptyState = new FakeState(admission());
    const empty = liveCycle({
      source: source({ meetings: [] }),
      state: emptyState,
    });
    await expect(empty.runOnce()).resolves.toEqual({
      kind: "empty",
      cursor_advanced: false,
    });
    expect(emptyState.advances).toEqual([]);

    const admitted = admission();
    const historical: AdmittedMeetingProcessingAdmissionV1 = {
      ...admitted,
      source: { ...admitted.source, cursor: "2020-01-01T00:00:00.000Z" },
    };
    const historyCycle = liveCycle({
      source: source({ meetings: [], next_cursor: "fixture-source:v1:next" }),
      state: new FakeState(historical),
    });
    await expect(historyCycle.runOnce()).rejects.toThrow(
      "fixture source v1 incremental cursor",
    );

    const pageCycle = liveCycle({
      source: source({
        meetings: [meeting(), { ...meeting(), id: "meeting-2" }],
      }),
      state: new FakeState(admission()),
    });
    await expect(pageCycle.runOnce()).rejects.toThrow("source batch exceeds the requested pull limit");
  });

  it("accepts a non-fixture source source through its injected boundary", async () => {
    const fixtureSource = {
      ...SOURCE,
      adapter_id: "synthetic-fixture",
      instance_id: "quality-fixtures",
    };
    const fixtureAdmission = {
      ...admission(),
      source: {
        ...admission().source,
        adapter_id: fixtureSource.adapter_id,
        instance_id: fixtureSource.instance_id,
        cursor: "fixture:v1:live:1",
      },
    };
    const fixtureMeeting = {
      ...meeting(),
      provenance: { ...meeting().provenance, source: fixtureSource },
    };
    const fixtureBoundary = {
      source_adapter_id: fixtureSource.adapter_id,
      assert_live_cursor(cursor: string): void {
        if (!cursor.startsWith("fixture:v1:live:")) {
          throw new Error("fixture cursor is not live");
        }
      },
    };
    const fixtureAdapter: MeetingSourceAdapter = {
      ...source({ meetings: [fixtureMeeting] }),
      identity: fixtureSource,
    };
    const cycle = liveCycle({
      source: fixtureAdapter,
      state: new FakeState(fixtureAdmission),
      stager: stager({ kind: "staged", stage_id: "fixture-stage" }),
      source_cursor_policy: fixtureBoundary,
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({
      kind: "staged",
      stage_id: "fixture-stage",
    });
  });

  it("coalesces concurrent requests into the same serialized cycle", async () => {
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pulls = 0;
    const slowSource = source({ meetings: [meeting()] });
    slowSource.pull = async () => {
      pulls += 1;
      await reached;
      return { meetings: [meeting()] };
    };
    const cycle = liveCycle({
      source: slowSource,
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
    });
    const first = cycle.runOnce();
    const second = cycle.runOnce();
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({ kind: "staged" });
    expect(pulls).toBe(1);
  });
});
