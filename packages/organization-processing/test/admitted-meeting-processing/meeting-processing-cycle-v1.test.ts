import { describe, expect, it } from "vitest";
import type {
  ExtractionAttemptKeyV1,
  ExtractionAttemptStoreV1,
} from "../../src/admitted-meeting-processing/extraction-attempt-store-v1.js";
import { LlmDecisionProcessor } from "../../src/llm/llm-decision-processor.js";
import type {
  MeetingApprovalJourneyClockV1,
  MeetingApprovalJourneyRefV1,
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyStageV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../../src/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";
import {
  AdmittedMeetingProcessingCycleV1,
  type AdmittedMeetingProcessingAdmissionV1,
  type ApprovalWorkflowStagerV1,
  type AuthorityMeetingProcessingStateV1,
  type FrozenMeetingProcessingCandidateSnapshotV1,
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
const DURABLE_STAGED_AT = "2026-08-22T02:05:04.005Z";
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
    const reviewPolicyFields = {
      review_policy_id: input.review_policy.policy_id,
      review_policy_contract_sha256:
        input.review_policy.policy_contract_sha256,
      review_policy_consequence_text:
        input.review_policy.policy_consequence_text,
      review_policy_consequence_sha256:
        input.review_policy.policy_consequence_sha256,
    };
    const candidate: MeetingProcessingCandidateV1 = reusable !== undefined
      ? {
          ...reviewPolicyFields,
          candidate_id: "cnd_test_coalesced",
          candidate_semantic_sha256: `sha256:${"e".repeat(64)}`,
          review_lineage_id: reusable.review_lineage_id,
          review_input_sha256: reviewInputSha256,
          review_semantic_sha256: reusable.review_semantic_sha256,
          disposition: "coalesced",
          approval_id: null,
          stage_command_id: null,
          state: "coalesced",
        }
      : actionable
      ? {
          ...reviewPolicyFields,
          candidate_id: "cnd_test",
          candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
          review_lineage_id: reviewLineageId,
          review_input_sha256: reviewInputSha256,
          review_semantic_sha256: `sha256:${"d".repeat(64)}`,
          disposition: "actionable",
          approval_id: "apr_test",
          stage_command_id: "pas_test",
          state: "queued",
        }
      : {
          ...reviewPolicyFields,
          candidate_id: "cnd_test",
          candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
          review_lineage_id: reviewLineageId,
          review_input_sha256: reviewInputSha256,
          review_semantic_sha256: `sha256:${"d".repeat(64)}`,
          disposition: "no_signals",
          approval_id: null,
          stage_command_id: null,
          state: "no_signals",
        };
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
  private readonly claims = new Map<string, { attempt: number; claim_id: string }>();

  reserve(key: ExtractionAttemptKeyV1): ReturnType<ExtractionAttemptStoreV1["reserve"]> {
    this.keys.push(key);
    const id = JSON.stringify(key);
    const previous = this.claims.get(id);
    if (previous !== undefined) {
      const complete = this.completed.find((entry) => entry.claim_id === previous.claim_id);
      return {
        status: "blocked", attempt: previous.attempt,
        outcome: complete?.outcome ?? "pending",
        failure_code: complete?.outcome === "failed" ? complete.failure_code : null,
      };
    }
    const claim = { attempt: 1, claim_id: `claim-${this.claims.size + 1}` };
    this.claims.set(id, claim);
    return { status: "reserved", ...claim };
  }

  complete(input: Parameters<ExtractionAttemptStoreV1["complete"]>[0]): void {
    this.completed.push(input);
  }
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

class FakeJourneyTelemetry implements MeetingApprovalJourneyTelemetryPortV1 {
  readonly events: string[] = [];
  readonly bindings: Array<{ candidate_id: string; approval_id: string | null }> = [];
  readonly usages: Array<{ provider_latency_ms: number; had_observation: boolean }> = [];
  readonly cardStaged: Array<{
    readonly approval_id: string;
    readonly observed_at: string | undefined;
  }> = [];
  private readonly terminalStages = new Set<string>();
  private readonly journeysBySource = new Map<string, string>();
  private nextAttempt = 0;
  throwEveryCall = false;

  private call(): void {
    if (this.throwEveryCall) throw new Error("telemetry must be fail-open");
  }

  private sourceKey(input: {
    readonly source_adapter_id: string;
    readonly source_instance_id: string;
    readonly external_id: string;
    readonly canonical_revision: string;
  }): string {
    return `${input.source_adapter_id}:${input.source_instance_id}:${input.external_id}:${input.canonical_revision}`;
  }

  private terminalKey(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): string {
    return `${journey.journey_id}:${stage}`;
  }

  private attempt(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): MeetingApprovalJourneyStageAttemptV1 {
    return {
      journey_id: journey.journey_id,
      stage,
      attempt: ++this.nextAttempt,
      started: this.captureClock(),
    };
  }

  captureClock(): MeetingApprovalJourneyClockV1 {
    this.call();
    return { observed_at: "2026-08-22T02:03:00.000Z", monotonic_ms: 1 };
  }

  beginOrResumeSource(input: {
    readonly source_adapter_id: string;
    readonly source_instance_id: string;
    readonly external_id: string;
    readonly canonical_revision: string;
  }): MeetingApprovalJourneyStageAttemptV1 {
    this.call();
    const key = this.sourceKey(input);
    const journey_id = this.journeysBySource.get(key) ?? `journey-${this.journeysBySource.size + 1}`;
    this.journeysBySource.set(key, journey_id);
    const attempt = this.attempt({ journey_id }, "meeting_source_intake");
    this.events.push("meeting_source_intake:started");
    return attempt;
  }

  bindCandidate(
    _journey: MeetingApprovalJourneyRefV1,
    input: { readonly candidate_id: string; readonly approval_id: string | null },
  ): void {
    this.call();
    this.bindings.push(input);
  }

  readForApproval(): MeetingApprovalJourneyRefV1 | null {
    this.call();
    return null;
  }

  beginStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): MeetingApprovalJourneyStageAttemptV1 {
    this.call();
    const attempt = this.attempt(journey, stage);
    this.events.push(`${stage}:started`);
    return attempt;
  }

  beginStageForApproval(): MeetingApprovalJourneyStageAttemptV1 | null {
    this.call();
    return null;
  }

  succeedStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    input?: { readonly outcome?: string },
  ): void {
    this.call();
    if (attempt === null) return;
    this.events.push(`${attempt.stage}:succeeded${input?.outcome === undefined ? "" : `:${input.outcome}`}`);
    this.terminalStages.add(this.terminalKey(attempt, attempt.stage));
  }

  failStage(attempt: MeetingApprovalJourneyStageAttemptV1 | null): void {
    this.call();
    if (attempt === null) return;
    this.events.push(`${attempt.stage}:failed`);
  }

  skipStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): void {
    this.call();
    this.events.push(`${stage}:skipped`);
    this.terminalStages.add(this.terminalKey(journey, stage));
  }

  skipStageForApproval(): void {
    this.call();
  }

  hasTerminalStage(): boolean {
    this.call();
    return false;
  }

  hasTerminalJourneyStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): boolean {
    this.call();
    return this.terminalStages.has(this.terminalKey(journey, stage));
  }

  succeedExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    observation: { readonly provider_latency_ms: number } | null,
    fallback_provider_latency_ms: number,
  ): void {
    this.call();
    this.usages.push({
      provider_latency_ms: fallback_provider_latency_ms,
      had_observation: observation !== null,
    });
    this.succeedStage(attempt);
  }

  failExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    _error: unknown,
    observation: { readonly provider_latency_ms: number } | null,
    fallback_provider_latency_ms: number,
  ): void {
    this.call();
    this.usages.push({
      provider_latency_ms: fallback_provider_latency_ms,
      had_observation: observation !== null,
    });
    this.failStage(attempt);
  }

  markCardStaged(approvalId: string, observedAt?: string): void {
    this.call();
    this.cardStaged.push({ approval_id: approvalId, observed_at: observedAt });
  }
  queueAgeMs(): number | null { this.call(); return null; }
  markAwaitingSearch(): void { this.call(); }
  beginAwaitingSearch(): readonly MeetingApprovalJourneyStageAttemptV1[] { this.call(); return []; }
  completeAwaitingSearch(): void { this.call(); }
  failAwaitingSearch(): void { this.call(); }
  close(): void { this.call(); }
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

function liveCycle(
  options: Omit<
    ConstructorParameters<typeof AdmittedMeetingProcessingCycleV1>[0],
    "source_cursor_policy"
  > &
    Partial<Pick<ConstructorParameters<typeof AdmittedMeetingProcessingCycleV1>[0], "source_cursor_policy">>,
): AdmittedMeetingProcessingCycleV1 {
  return new AdmittedMeetingProcessingCycleV1({
    ...options,
    source_cursor_policy:
      options.source_cursor_policy ?? fixtureCursorPolicy,
  });
}

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
      stager: stager({ kind: "staged", stage_id: "never" }),
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
      stager: stager({ kind: "staged", stage_id: "never" }),
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
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    await expect(cycle.runOnce()).rejects.toThrow("source custody unavailable");
    expect(extracted).toBe(false);
    expect(state.advances).toHaveLength(0);
  });

  it("correlates the actionable source, extraction, and durable candidate stages", async () => {
    const telemetry = new FakeJourneyTelemetry();
    const observed = meeting();
    const cycle = liveCycle({
      source: source({ meetings: [observed] }),
      processor: processor((value, context) => {
        context?.on_generation?.({
          outcome: "succeeded",
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 23,
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          cached_input_tokens: null,
          reasoning_tokens: null,
          finish_reason: "stop",
        });
        return decisions(value);
      }),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
      journey_telemetry: telemetry,
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "staged" });

    expect(telemetry.events).toEqual([
      "meeting_source_intake:started",
      "meeting_source_intake:succeeded",
      "meeting_extraction:started",
      "meeting_extraction:succeeded",
      "meeting_candidate_persist:started",
      "meeting_candidate_persist:succeeded:actionable",
    ]);
    expect(telemetry.bindings).toEqual([
      { candidate_id: "cnd_test", approval_id: "apr_test" },
    ]);
    expect(telemetry.usages).toEqual([
      expect.objectContaining({ had_observation: true }),
    ]);
  });

  it.each([
    new AdapterError("permanently_rejected", "provider credit unavailable", false),
    new AdapterError("temporarily_unavailable", "provider temporarily unavailable", true),
    new AdapterError("rate_limited", "provider rate limited", true),
    new AdapterError("timeout", "provider timed out", true),
    new AdapterError("temporarily_unavailable", "LLM output contained invalid or unsupported signal grounding at stage: evidence_quote", true),
    new Error("provider outcome unknown"),
  ])("holds a failed extraction instead of spending again on an unchanged review input: $message", async (failure) => {
    let calls = 0;
    let recoveredDeliveries = 0;
    const extraction_attempts = new RecordingExtractionAttempts();
    const state = new FakeState(admission());
    const options = {
      source: source({ meetings: [meeting()] }),
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

    await expect(liveCycle(options).runOnce()).rejects.toThrow(failure);
    const recoveredBeforeHold = recoveredDeliveries;
    await expect(liveCycle(options).runOnce()).rejects.toMatchObject({
      code: "permanently_rejected", message: "extraction_on_hold", retryable: false,
    });
    expect(calls).toBe(1);
    expect(recoveredDeliveries).toBe(recoveredBeforeHold + 1);
    expect(state.advances).toHaveLength(0);
    expect(state.candidates).toHaveLength(0);
    expect(extraction_attempts.completed).toMatchObject([{
      outcome: "failed", failure_code: failure instanceof AdapterError ? failure.code : "unknown",
    }]);
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
            evidence: [{ evidence_id: "e1", quote: "This quote does not occur in the source." }],
          }] }), inputTokens: 100, outputTokens: 20, totalTokens: 120, stopReason: "stop" };
        },
      },
      validateProviderConfig: () => [], identityEndpoint: null,
    });
    const options = {
      source: source({ meetings: [meeting()] }), processor: extraction,
      state: new FakeState({ ...admission(), processor: { ...admission().processor, version: extraction.identity.version } }),
      stager: stager({ kind: "staged", stage_id: "never" }),
      extraction_attempts: new RecordingExtractionAttempts(),
    };
    await expect(liveCycle(options).runOnce()).rejects.toThrow("grounding at stage: evidence_quote");
    await expect(liveCycle(options).runOnce()).rejects.toThrow("extraction_on_hold");
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
      stager: stager({ kind: "staged", stage_id: "never" }),
    }).runOnce();
    await expect(run(meeting())).rejects.toThrow("generation failed");
    const sameInput = {
      ...meeting(),
      provenance: { ...meeting().provenance, canonical_revision: "sha256:folder-change", observed_at: "2026-08-22T03:00:00.000Z" },
      extensions: { "fixture-source": { folder_membership: [] } },
    };
    await expect(run(sameInput)).rejects.toThrow("extraction_on_hold");
    Object.assign(admitted.source, { cursor: fixtureCursor("2026-08-22T03:00:00.000Z") });
    await expect(run(sameInput)).rejects.toThrow("extraction_on_hold");
    expect(calls).toBe(1);
    expect(extraction_attempts.keys[1]).toEqual(extraction_attempts.keys[0]);
    expect(extraction_attempts.keys[2]).toEqual(extraction_attempts.keys[0]);

    await expect(run({ ...sameInput, content: [{ id: "block-1", kind: "note", text: "A changed decision input." }] })).rejects.toThrow("generation failed");
    await expect(run({ ...sameInput, time: { actual_start_at: "2026-08-22T01:00:00.000Z" } })).rejects.toThrow("generation failed");
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
      stager: stager({ kind: "staged", stage_id: "never" }),
    };
    await expect(liveCycle(options).runOnce()).rejects.toThrow("candidate persistence unavailable");
    await expect(liveCycle(options).runOnce()).rejects.toThrow("extraction_on_hold");
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

  it("keeps an unfinished reservation on hold when completion persistence fails", async () => {
    const extraction_attempts = new RecordingExtractionAttempts();
    extraction_attempts.complete = () => { throw new Error("attempt completion unavailable"); };
    let calls = 0;
    const options = {
      source: source({ meetings: [meeting()] }), state: new FakeState(admission()), extraction_attempts,
      processor: processor(() => { calls += 1; throw new Error("provider outcome unknown"); }),
      stager: stager({ kind: "staged", stage_id: "never" }),
    };
    await expect(liveCycle(options).runOnce()).rejects.toThrow("attempt completion unavailable");
    await expect(liveCycle(options).runOnce()).rejects.toThrow("extraction_on_hold");
    expect(calls).toBe(1);
    expect(extraction_attempts.completed).toHaveLength(0);
  });

  it("closes a failed extraction without opening another paid attempt in the same journey", async () => {
    const telemetry = new FakeJourneyTelemetry();
    let calls = 0;
    const cycle = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor((value, context) => {
        context?.on_generation?.({
          outcome: calls === 0 ? "failed" : "succeeded",
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 9,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          cached_input_tokens: null,
          reasoning_tokens: null,
          finish_reason: calls === 0 ? "error" : "stop",
        });
        calls += 1;
        if (calls === 1) throw new Error("provider retry");
        return decisions(value);
      }),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
      journey_telemetry: telemetry,
      extraction_attempts: new RecordingExtractionAttempts(),
    });

    await expect(cycle.runOnce()).rejects.toThrow("provider retry");
    await expect(cycle.runOnce()).rejects.toThrow("extraction_on_hold");

    expect(telemetry.events.filter((event) => event.startsWith("meeting_extraction:"))).toEqual([
      "meeting_extraction:started",
      "meeting_extraction:failed",
    ]);
    expect(calls).toBe(1);
    expect(telemetry.events.filter((event) => event === "meeting_source_intake:started")).toHaveLength(2);
  });

  it("marks reused extraction and no-signal downstream work skipped", async () => {
    const telemetry = new FakeJourneyTelemetry();
    const state = new FakeState(admission());
    const first = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor(),
      state,
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
      journey_telemetry: telemetry,
    });
    await expect(first.runOnce()).resolves.toMatchObject({ kind: "staged" });

    const reused: MeetingDocument = {
      ...meeting(),
      provenance: { ...meeting().provenance, canonical_revision: "sha256:folder-only" },
      extensions: { "fixture-source": { folder_membership: [] } },
    };
    const second = liveCycle({
      source: source({ meetings: [reused] }),
      processor: processor(() => {
        throw new Error("reused extraction must not invoke the processor");
      }),
      state,
      stager: stager({ kind: "staged", stage_id: "never" }),
      journey_telemetry: telemetry,
    });
    await expect(second.runOnce()).resolves.toMatchObject({ kind: "already_processed" });
    expect(telemetry.events).toContain("meeting_extraction:skipped");
    expect(telemetry.events).toContain("meeting_candidate_persist:succeeded:coalesced");

    const noSignalsTelemetry = new FakeJourneyTelemetry();
    const noSignal = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor(noSignals),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "never" }),
      journey_telemetry: noSignalsTelemetry,
    });
    await expect(noSignal.runOnce()).resolves.toMatchObject({ kind: "no_signals" });
    expect(noSignalsTelemetry.events.filter((event) => event.endsWith(":skipped"))).toEqual([
      "meeting_approval_staging:skipped",
      "meeting_approval_action_verify:skipped",
      "meeting_approval_action_queue:skipped",
      "meeting_terminal_persist:skipped",
      "meeting_record_append:skipped",
      "meeting_search_publication:skipped",
    ]);
  });

  it("reconciles frozen candidate persistence from its durable no-signal disposition", async () => {
    const telemetry = new FakeJourneyTelemetry();
    const current = admission();
    const observed = meeting();
    const state = new FakeState(current);
    state.seedFrozenCandidate({
      candidate_id: "cnd_frozen",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      review_lineage_id: "rli_test",
      review_input_sha256: `sha256:${"c".repeat(64)}`,
      review_semantic_sha256: `sha256:${"d".repeat(64)}`,
      review_policy_id: REVIEW_POLICY.policy_id,
      review_policy_contract_sha256: REVIEW_POLICY.policy_contract_sha256,
      review_policy_consequence_text: REVIEW_POLICY.policy_consequence_text,
      review_policy_consequence_sha256: REVIEW_POLICY.policy_consequence_sha256,
      disposition: "no_signals",
      approval_id: null,
      stage_command_id: null,
      state: "no_signals",
      admission: current,
      meeting: observed,
      decisions: noSignals(observed),
    });
    for (let index = 0; index < 2; index += 1) {
      const cycle = liveCycle({
        source: source({ meetings: [observed] }),
        processor: processor(() => {
          throw new Error("frozen revision must not invoke extraction");
        }),
        state,
        stager: stager({ kind: "staged", stage_id: "never" }),
        journey_telemetry: telemetry,
      });
      await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "already_processed" });
    }
    expect(telemetry.events.filter((event) => event === "meeting_extraction:skipped")).toHaveLength(1);
    expect(telemetry.events.filter((event) => event === "meeting_candidate_persist:succeeded:no_signals")).toHaveLength(1);
    expect(telemetry.events).not.toContain("meeting_candidate_persist:skipped");
  });

  it("keeps processing fail-open when journey telemetry throws", async () => {
    const telemetry = new FakeJourneyTelemetry();
    telemetry.throwEveryCall = true;
    const cycle = liveCycle({
      source: source({ meetings: [meeting()] }),
      processor: processor(),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "stage-1" }),
      journey_telemetry: telemetry,
    });

    await expect(cycle.runOnce()).resolves.toMatchObject({ kind: "staged" });
  });

  it("reports source intake, extraction, and approval staging without meeting data", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const observedMeeting = meeting();
    const cycle = liveCycle({
      source: source({ meetings: [observedMeeting], next_cursor: undefined }),
      processor: processor(),
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
        processor: processor(),
        state: scenario.state,
        stager: stager({ kind: "staged", stage_id: "never" }),
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
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    cycle.setWorkerLifecycle(
      new MeetingProcessingWorkerLifecycleV1((event) => events.push(event)),
    );

    await expect(cycle.runOnce()).rejects.toThrow();
    expect(
      events.map((event) =>
        event.kind === "echo-clean-live-worker-phase-v1"
          ? `${event.cycle_phase}:${event.event}`
          : event.event,
      ),
    ).toEqual([
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
      stager: stager({ kind: "staged", stage_id: "never" }),
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
    expect(
      events.map((event) =>
        event.kind === "echo-clean-live-worker-phase-v1"
          ? `${event.cycle_phase}:${event.event}`
          : event.event,
      ),
    ).toEqual(["source_intake:started", "source_intake:succeeded"]);
  });

  it("polls one admitted post-cutoff fixture source cursor, stages durably, then advances", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "stage-1" });
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
      state,
      stager: downstream,
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "staged",
      stage_id: "stage-1",
      cursor_advanced: true,
    });
    expect(downstream.calls).toBe(1);
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
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
        processor: processor(),
        state,
        stager: stager(result),
      });
      await expect(cycle.runOnce()).resolves.toEqual({
        kind: "not_staged",
        reason: result.kind,
        cursor_advanced: false,
      });
      expect(state.advances).toEqual([]);
    }
  });

  it("advances after a durable approval delivery remains pending", async () => {
    const current = admission();
    const state = new FakeState(current);
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
      state,
      stager: stager({ kind: "delivery_pending" }),
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "delivery_pending",
      cursor_advanced: true,
    });
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
  });

  it("advances after a deterministic approval package is durably quarantined", async () => {
    const current = admission();
    const state = new FakeState(current);
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
      state,
      stager: stager({
        kind: "quarantined",
        reason_code: "approval_package_unrepresentable",
      }),
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "quarantined",
      reason_code: "approval_package_unrepresentable",
      cursor_advanced: true,
    });
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
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
      processor: processor(),
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
      processor: processor(),
      state,
      stager: downstream,
    });

    await expect(cycle.runOnce()).rejects.toThrow("Slack transport threw");
    expect(state.candidates).toHaveLength(1);
    expect(state.advances).toHaveLength(1);
  });

  it("keeps a pending delivery durable when its source cursor fence drifts", async () => {
    const state = new FakeState(admission(), "state_drift");
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
      state,
      stager: stager({ kind: "delivery_pending" }),
    });

    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "delivery_pending_cursor_not_advanced",
      reason: "state_drift",
      cursor_advanced: false,
    });
    expect(state.advances).toHaveLength(1);
  });

  it("keeps a durable staged item visible when the Authority cursor fence drifts", async () => {
    const state = new FakeState(admission(), "state_drift");
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
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

  it("CAS advances an empty fixture source page with a distinct next cursor", async () => {
    const current = admission();
    const emptyState = new FakeState(current);
    const empty = liveCycle({
      source: source({ meetings: [], next_cursor: "fixture-source:v1:next" }),
      processor: processor(),
      state: emptyState,
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    await expect(empty.runOnce()).resolves.toEqual({
      kind: "empty_cursor_advanced",
      cursor_advanced: true,
    });
    expect(emptyState.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "fixture-source:v1:next",
      },
    ]);
  });

  it("never advances an empty page when its cursor fence drifts or is revoked", async () => {
    for (const result of ["state_drift", "revoked"] as const) {
      const state = new FakeState(admission(), result);
      const cycle = liveCycle({
        source: source({ meetings: [], next_cursor: "fixture-source:v1:next" }),
        processor: processor(),
        state,
        stager: stager({ kind: "staged", stage_id: "never" }),
      });
      await expect(cycle.runOnce()).resolves.toEqual({
        kind: "empty_cursor_not_advanced",
        reason: result,
        cursor_advanced: false,
      });
      expect(state.advances).toHaveLength(1);
      expect(state.candidates).toEqual([]);
    }
  });

  it("records no-signal revisions without Slack staging, then CAS advances", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "never" });
    const cycle = liveCycle({
      source: source({ meetings: [meeting()], next_cursor: "fixture-source:v1:next" }),
      processor: processor(noSignals),
      state,
      stager: downstream,
    });
    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "no_signals_cursor_advanced",
      cursor_advanced: true,
    });
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

  it("retries queued, posting, and posted revisions with only their frozen snapshots", async () => {
    for (const stateName of ["queued", "posting", "posted"] as const) {
      const current = admission();
      const state = new FakeState(current);
      const originalMeeting = meeting();
      const originalDecisions = decisions(originalMeeting);
      state.seedFrozenCandidate({
        candidate_id: `cnd_${stateName}`,
        candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
        review_lineage_id: "rli_test",
        review_input_sha256: `sha256:${"c".repeat(64)}`,
        review_semantic_sha256: `sha256:${"d".repeat(64)}`,
        review_policy_id: REVIEW_POLICY.policy_id,
        review_policy_contract_sha256:
          REVIEW_POLICY.policy_contract_sha256,
        review_policy_consequence_text:
          REVIEW_POLICY.policy_consequence_text,
        review_policy_consequence_sha256:
          REVIEW_POLICY.policy_consequence_sha256,
        disposition: "actionable",
        approval_id: `apr_${stateName}`,
        stage_command_id: `pas_${stateName}`,
        state: stateName,
        admission: current,
        meeting: originalMeeting,
        decisions: originalDecisions,
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
          state: stateName,
          review_policy_contract_sha256:
            REVIEW_POLICY.policy_contract_sha256,
          review_policy_consequence_text:
            REVIEW_POLICY.policy_consequence_text,
        }),
        meeting: originalMeeting,
        decisions: originalDecisions,
      });
      expect(state.advances).toEqual([]);
    }
  });

  it("reconciles a durably staged candidate and wait clock after a restart", async () => {
    const current = admission();
    const state = new FakeState(current);
    const originalMeeting = meeting();
    state.seedFrozenCandidate({
      candidate_id: "cnd_staged",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      review_lineage_id: "rli_test",
      review_input_sha256: `sha256:${"c".repeat(64)}`,
      review_semantic_sha256: `sha256:${"d".repeat(64)}`,
      review_policy_id: REVIEW_POLICY.policy_id,
      review_policy_contract_sha256: REVIEW_POLICY.policy_contract_sha256,
      review_policy_consequence_text: REVIEW_POLICY.policy_consequence_text,
      review_policy_consequence_sha256:
        REVIEW_POLICY.policy_consequence_sha256,
      disposition: "actionable",
      approval_id: "apr_staged",
      stage_command_id: "pas_staged",
      state: "staged",
      durable_staged_at: DURABLE_STAGED_AT,
      admission: current,
      meeting: originalMeeting,
      decisions: decisions(originalMeeting),
    });
    let extracts = 0;
    let stages = 0;
    const telemetry = new FakeJourneyTelemetry();
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
      journey_telemetry: telemetry,
    });
    await expect(repeated.runOnce()).resolves.toEqual({
      kind: "already_processed",
      cursor_advanced: false,
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      "meeting_candidate_persist:succeeded:actionable",
      "meeting_approval_staging:succeeded:staged",
    ]));
    expect(telemetry.cardStaged).toEqual([
      { approval_id: "apr_staged", observed_at: DURABLE_STAGED_AT },
    ]);

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

  it("does not invent a restart-time wait anchor without a durable staged timestamp", async () => {
    const current = admission();
    const state = new FakeState(current);
    const originalMeeting = meeting();
    state.seedFrozenCandidate({
      candidate_id: "cnd_staged-without-anchor",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      review_lineage_id: "rli_test",
      review_input_sha256: `sha256:${"c".repeat(64)}`,
      review_semantic_sha256: `sha256:${"d".repeat(64)}`,
      review_policy_id: REVIEW_POLICY.policy_id,
      review_policy_contract_sha256: REVIEW_POLICY.policy_contract_sha256,
      review_policy_consequence_text: REVIEW_POLICY.policy_consequence_text,
      review_policy_consequence_sha256:
        REVIEW_POLICY.policy_consequence_sha256,
      disposition: "actionable",
      approval_id: "apr_staged-without-anchor",
      stage_command_id: "pas_staged-without-anchor",
      state: "staged",
      durable_staged_at: null,
      admission: current,
      meeting: originalMeeting,
      decisions: decisions(originalMeeting),
    });
    const telemetry = new FakeJourneyTelemetry();
    const downstream = stager({ kind: "staged", stage_id: "unused" });
    const repeated = liveCycle({
      source: source({
        meetings: [originalMeeting],
        next_cursor: current.source.cursor,
      }),
      processor: processor(),
      state,
      stager: downstream,
      journey_telemetry: telemetry,
    });

    await expect(repeated.runOnce()).resolves.toEqual({
      kind: "already_processed",
      cursor_advanced: false,
    });
    expect(downstream.calls).toBe(0);
    expect(telemetry.cardStaged).toEqual([]);
  });

  it("does not advance no-signal meetings when the Authority cursor fence drifts or is revoked", async () => {
    for (const result of ["state_drift", "revoked"] as const) {
      const state = new FakeState(admission(), result);
      const downstream = stager({ kind: "staged", stage_id: "never" });
      const cycle = liveCycle({
        source: source({
          meetings: [meeting()],
          next_cursor: "fixture-source:v1:next",
        }),
        processor: processor(noSignals),
        state,
        stager: downstream,
      });
      await expect(cycle.runOnce()).resolves.toEqual({
        kind: "no_signals_cursor_not_advanced",
        reason: result,
        cursor_advanced: false,
      });
      expect(state.candidates).toHaveLength(1);
      expect(state.candidates[0]!.decisions.signals).toEqual([]);
      expect(downstream.calls).toBe(0);
      expect(state.advances).toHaveLength(1);
    }
  });

  it("does not advance a terminal empty poll, accept historical cursors, or process a page larger than one", async () => {
    const emptyState = new FakeState(admission());
    const empty = liveCycle({
      source: source({ meetings: [] }),
      processor: processor(),
      state: emptyState,
      stager: stager({ kind: "staged", stage_id: "never" }),
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
      processor: processor(),
      state: new FakeState(historical),
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    await expect(historyCycle.runOnce()).rejects.toThrow(
      "fixture source v1 incremental cursor",
    );

    const pageCycle = liveCycle({
      source: source({
        meetings: [meeting(), { ...meeting(), id: "meeting-2" }],
      }),
      processor: processor(),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "never" }),
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
      processor: processor(),
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
      processor: processor(),
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
