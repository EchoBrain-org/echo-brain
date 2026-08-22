import { describe, expect, it } from "vitest";
import {
  type AdapterHealth,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type MeetingBatch,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from "../../../src/processing/core/index.js";
import { createGranolaLiveOnlyCursor } from "../../../src/processing/adapters/meeting-sources/granola/index.js";
import {
  CleanLiveOnlySourceCycleV1,
  type CleanApprovalStagerV1,
  type CleanLiveCandidateSnapshotInputV1,
  type CleanLiveCandidateV1,
  type CleanFrozenCandidateSnapshotV1,
  type CleanGranolaSourceAdmissionV1,
  type CleanLiveOnlySourceStateV1,
} from "../../../src/processing/clean-v1/live-only-source-cycle.js";

const CUT_OFF = "2026-08-22T02:03:04.005Z";
const SOURCE = {
  kind: "meeting-source" as const,
  adapter_id: "granola",
  instance_id: "founder-granola",
  version: "2.2.0",
};
const PROCESSOR = {
  kind: "decision-processor" as const,
  adapter_id: "llm",
  instance_id: "founder-llm",
  version: "1.3.0",
};

const admission = (): CleanGranolaSourceAdmissionV1 => ({
  source: {
    adapter_id: "granola",
    instance_id: SOURCE.instance_id,
    version: SOURCE.version,
    cursor: createGranolaLiveOnlyCursor(CUT_OFF),
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
    external_id: "granola-note-1",
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

class FakeState implements CleanLiveOnlySourceStateV1 {
  readonly advances: Array<{ expected_cursor: string; next_cursor: string }> =
    [];
  readonly candidates: CleanLiveCandidateSnapshotInputV1[] = [];
  private readonly sourceRevisions = new Map<
    string,
    CleanFrozenCandidateSnapshotV1
  >();

  constructor(
    private readonly value: CleanGranolaSourceAdmissionV1,
    private readonly advanceResult:
      "advanced" | "state_drift" | "revoked" = "advanced",
  ) {}

  async readAdmission(): Promise<CleanGranolaSourceAdmissionV1> {
    return this.value;
  }

  async readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<CleanFrozenCandidateSnapshotV1 | undefined> {
    return this.sourceRevisions.get(
      `${input.external_id}:${input.canonical_revision}`,
    );
  }

  async stageCandidate(
    input: CleanLiveCandidateSnapshotInputV1,
  ): Promise<CleanLiveCandidateV1> {
    this.candidates.push(input);
    const candidate = {
      candidate_id: "cnd_test",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      approval_id: "apr_test",
      stage_command_id: "pas_test",
      state: "queued",
    } as const;
    this.sourceRevisions.set(
      `${input.meeting.provenance.external_id}:${input.meeting.provenance.canonical_revision}`,
      { ...candidate, ...input },
    );
    return candidate;
  }

  seedFrozenCandidate(input: CleanFrozenCandidateSnapshotV1): void {
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

function source(batch: MeetingBatch): MeetingSourceAdapter {
  return {
    identity: SOURCE,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    pull: async () => batch,
  };
}

function processor(
  extract: (value: MeetingDocument) => DecisionSet = decisions,
): DecisionProcessorAdapter {
  return {
    identity: PROCESSOR,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    extract: async (value) => extract(value),
  };
}

function stager(
  result: Awaited<ReturnType<CleanApprovalStagerV1["stage"]>>,
): CleanApprovalStagerV1 & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    stage: async () => {
      calls += 1;
      return result;
    },
  };
}

describe("clean live-only source cycle", () => {
  it("polls one admitted live-only Granola cursor, stages durably, then advances", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "stage-1" });
    const cycle = new CleanLiveOnlySourceCycleV1({
      source: source({ meetings: [meeting()], next_cursor: "granola:v1:next" }),
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
        next_cursor: "granola:v1:next",
      },
    ]);
  });

  it("does not advance when the downstream approval target is revoked or drifted", async () => {
    for (const result of [
      { kind: "revoked" } as const,
      { kind: "state_drift" } as const,
    ]) {
      const state = new FakeState(admission());
      const cycle = new CleanLiveOnlySourceCycleV1({
        source: source({
          meetings: [meeting()],
          next_cursor: "granola:v1:next",
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

  it("keeps a durable staged item visible when the Authority cursor fence drifts", async () => {
    const state = new FakeState(admission(), "state_drift");
    const cycle = new CleanLiveOnlySourceCycleV1({
      source: source({ meetings: [meeting()], next_cursor: "granola:v1:next" }),
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

  it("CAS advances an empty Granola page with a distinct next cursor", async () => {
    const current = admission();
    const emptyState = new FakeState(current);
    const empty = new CleanLiveOnlySourceCycleV1({
      source: source({ meetings: [], next_cursor: "granola:v1:next" }),
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
        next_cursor: "granola:v1:next",
      },
    ]);
  });

  it("never advances an empty page when its cursor fence drifts or is revoked", async () => {
    for (const result of ["state_drift", "revoked"] as const) {
      const state = new FakeState(admission(), result);
      const cycle = new CleanLiveOnlySourceCycleV1({
        source: source({ meetings: [], next_cursor: "granola:v1:next" }),
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

  it("skips candidate and Slack staging for no-signal meetings, then CAS advances", async () => {
    const current = admission();
    const state = new FakeState(current);
    const downstream = stager({ kind: "staged", stage_id: "never" });
    const cycle = new CleanLiveOnlySourceCycleV1({
      source: source({ meetings: [meeting()], next_cursor: "granola:v1:next" }),
      processor: processor(noSignals),
      state,
      stager: downstream,
    });
    await expect(cycle.runOnce()).resolves.toEqual({
      kind: "no_signals_cursor_advanced",
      cursor_advanced: true,
    });
    expect(state.candidates).toEqual([]);
    expect(downstream.calls).toBe(0);
    expect(state.advances).toEqual([
      {
        expected_cursor: current.source.cursor,
        next_cursor: "granola:v1:next",
      },
    ]);
  });

  it("retries queued and posted revisions with only their frozen snapshots", async () => {
    for (const stateName of ["queued", "posted"] as const) {
      const current = admission();
      const state = new FakeState(current);
      const originalMeeting = meeting();
      const originalDecisions = decisions(originalMeeting);
      state.seedFrozenCandidate({
        candidate_id: `cnd_${stateName}`,
        candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
        approval_id: `apr_${stateName}`,
        stage_command_id: `pas_${stateName}`,
        state: stateName,
        admission: current,
        meeting: originalMeeting,
        decisions: originalDecisions,
      });
      let extracts = 0;
      let retried: Parameters<CleanApprovalStagerV1["stage"]>[0] | undefined;
      const downstream: CleanApprovalStagerV1 = {
        stage: async (input) => {
          retried = input;
          return { kind: "staged", stage_id: "stage-1" };
        },
      };
      const changedObservation: MeetingDocument = {
        ...originalMeeting,
        provenance: {
          ...originalMeeting.provenance,
          observed_at: "2026-08-22T02:06:04.005Z",
        },
      };
      const cycle = new CleanLiveOnlySourceCycleV1({
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
        candidate: expect.objectContaining({ state: stateName }),
        meeting: originalMeeting,
        decisions: originalDecisions,
      });
      expect(state.advances).toEqual([]);
    }
  });

  it("skips staged revisions before extraction and processes a changed revision", async () => {
    const current = admission();
    const state = new FakeState(current);
    const originalMeeting = meeting();
    state.seedFrozenCandidate({
      candidate_id: "cnd_staged",
      candidate_semantic_sha256: `sha256:${"b".repeat(64)}`,
      approval_id: "apr_staged",
      stage_command_id: "pas_staged",
      state: "staged",
      admission: current,
      meeting: originalMeeting,
      decisions: decisions(originalMeeting),
    });
    let extracts = 0;
    let stages = 0;
    const countingProcessor = processor((value) => {
      extracts += 1;
      return decisions(value);
    });
    const downstream: CleanApprovalStagerV1 = {
      stage: async () => {
        stages += 1;
        return { kind: "staged", stage_id: "stage-1" };
      },
    };

    const repeated = new CleanLiveOnlySourceCycleV1({
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

    const revisedMeeting: MeetingDocument = {
      ...originalMeeting,
      provenance: {
        ...originalMeeting.provenance,
        canonical_revision: "sha256:note-2",
      },
    };
    const revised = new CleanLiveOnlySourceCycleV1({
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

  it("does not advance no-signal meetings when the Authority cursor fence drifts or is revoked", async () => {
    for (const result of ["state_drift", "revoked"] as const) {
      const state = new FakeState(admission(), result);
      const downstream = stager({ kind: "staged", stage_id: "never" });
      const cycle = new CleanLiveOnlySourceCycleV1({
        source: source({
          meetings: [meeting()],
          next_cursor: "granola:v1:next",
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
      expect(state.candidates).toEqual([]);
      expect(downstream.calls).toBe(0);
      expect(state.advances).toHaveLength(1);
    }
  });

  it("does not advance a terminal empty poll, accept historical cursors, or process a page larger than one", async () => {
    const emptyState = new FakeState(admission());
    const empty = new CleanLiveOnlySourceCycleV1({
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
    const historical: CleanGranolaSourceAdmissionV1 = {
      ...admitted,
      source: { ...admitted.source, cursor: "2020-01-01T00:00:00.000Z" },
    };
    const historyCycle = new CleanLiveOnlySourceCycleV1({
      source: source({ meetings: [], next_cursor: "granola:v1:next" }),
      processor: processor(),
      state: new FakeState(historical),
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    await expect(historyCycle.runOnce()).rejects.toThrow(
      "live-only Granola state",
    );

    const pageCycle = new CleanLiveOnlySourceCycleV1({
      source: source({
        meetings: [meeting(), { ...meeting(), id: "meeting-2" }],
      }),
      processor: processor(),
      state: new FakeState(admission()),
      stager: stager({ kind: "staged", stage_id: "never" }),
    });
    await expect(pageCycle.runOnce()).rejects.toThrow("at most one meeting");
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
    const cycle = new CleanLiveOnlySourceCycleV1({
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
