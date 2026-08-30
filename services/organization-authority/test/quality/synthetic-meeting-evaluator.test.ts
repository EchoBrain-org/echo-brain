import { describe, expect, it, vi } from "vitest";
import {
  createRetrievalGroundedAnswerComposition,
  type StructuredGenerationInput,
} from "../../src/answer-composition/retrieval-grounded-answer-composition.js";
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  DecisionExtractionContext,
  DecisionProcessorAdapter,
  DecisionSet,
  MeetingSourceAdapter,
  MeetingDocument,
} from "../../src/processing/core/index.js";
import {
  evaluateSyntheticMeetingQualityV1,
  phaseOneSyntheticExtractionExpectationsV1,
} from "../../src/quality/synthetic-meeting-quality-evaluator-v1.js";
import {
  loadSyntheticReplayMeetingsV1,
  SyntheticMeetingSourceAdapterV1,
  syntheticMeetingQualityDocumentsV1,
  syntheticMeetingSourceIdentityV1,
  syntheticMeetingQualityCorpusV1,
} from "../../src/quality/synthetic-meeting-fixture-v1.js";
import { SyntheticFixtureReleasedRetrievalPortV1 } from "../../src/quality/synthetic-answer-composition-fixture-port-v1.js";

const fixtureAnswerer = {
  generate: async (input: StructuredGenerationInput) =>
    input.user_prompt.includes("Only me")
      ? { status: "answered" as const, answer: "Only me.", citations: ["a1"] }
      : { status: "answered" as const, answer: "Organization members can read records.", citations: ["a1"] },
};

function syntheticSourceWithPull(
  pull: MeetingSourceAdapter["pull"],
): MeetingSourceAdapter {
  return {
    identity: syntheticMeetingSourceIdentityV1,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({
      status: "healthy",
      checked_at: "2026-08-29T00:00:00.000Z",
    }),
    pull,
  };
}

function evaluatorDependencies(processor: DecisionProcessorAdapter) {
  return {
    processor,
    planner: { generate: async () => ({ queries: [] }) },
    answerer: fixtureAnswerer,
    generation_adapter_id: "fixture-model-adapter",
    planner_model: "fixture/eval",
    answer_model: "fixture/eval",
  };
}

class ExpectedSignalProcessor implements DecisionProcessorAdapter {
  readonly identity = {
    kind: "decision-processor" as const,
    adapter_id: "synthetic-eval-processor-v1",
    instance_id: "quality",
    version: "1.0.0",
  };
  readonly inputs: MeetingDocument[] = [];

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    return config.adapter_id.length > 0
      ? { ok: true, errors: [] }
      : { ok: false, errors: ["adapter_id is required"] };
  }

  async healthCheck(): Promise<AdapterHealth> {
    return { status: "healthy", checked_at: "2026-08-29T00:00:00.000Z" };
  }

  async extract(
    meeting: MeetingDocument,
    _context: DecisionExtractionContext,
  ): Promise<DecisionSet> {
    this.inputs.push(meeting);
    const fixture = syntheticMeetingQualityCorpusV1.fixtures.find((item) => item.id === meeting.id);
    if (fixture === undefined) throw new Error("unknown synthetic fixture");
    return {
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: this.identity,
      generated_at: "2026-08-29T00:00:00.000Z",
      signals: fixture.expected_signals.map((expected, index) => {
        const firstBlock = meeting.content[0];
        if (firstBlock === undefined) throw new Error("synthetic meeting has no evidence blocks");
        const evidence = [{ meeting_id: meeting.id, block_id: firstBlock.id }];
        if (expected.kind === "decision") {
          return { id: `decision-${index}`, ...expected, confidence: 1, status: "decided" as const, evidence };
        }
        if (expected.kind === "action") {
          return { id: `action-${index}`, ...expected, confidence: 1, owner: "Avery", due_at: null, evidence };
        }
        return { id: `rationale-${index}`, ...expected, confidence: 1, supports_signal_ids: [], evidence };
      }),
    };
  }
}

describe("synthetic meeting quality support", () => {
  it("delivers canonical non-provider meeting documents to the extraction adapter", async () => {
    const source = new SyntheticMeetingSourceAdapterV1(
      syntheticMeetingQualityDocumentsV1(),
    );
    const processor = new ExpectedSignalProcessor();

    const evaluation = await evaluateSyntheticMeetingQualityV1({
      source,
      processor,
      planner: { generate: async () => ({ queries: [] }) },
      answerer: fixtureAnswerer,
      generation_adapter_id: "fixture-model-adapter",
      planner_model: "fixture/eval",
      answer_model: "fixture/eval",
    });

    expect(evaluation.extraction).toMatchObject({ missing_count: 0, unexpected_count: 0 });
    expect(processor.inputs).toHaveLength(2);
    expect(processor.inputs[0]).toMatchObject({
      schema_version: 1,
      provenance: {
        source: { adapter_id: "synthetic-source" },
        normalizer_version: "synthetic-fixture-normalizer-v1",
      },
      context: { calendar: { organizer_participant_id: "owner" } },
    });
    expect(processor.inputs[0]?.extensions).toBeUndefined();
    expect(processor.inputs[0]?.content.map((block) => block.id)).toEqual([
      "note-decision",
      "note-action",
      "note-rationale",
    ]);
  });

  it("uses deterministic adapter-scoped opaque cursors without provider I/O", async () => {
    const source = new SyntheticMeetingSourceAdapterV1(
      syntheticMeetingQualityDocumentsV1(),
    );
    const first = await source.pull({ limit: 1 });
    const second = await source.pull({ cursor: first.next_cursor, limit: 1 });

    expect(first.meetings.map((meeting) => meeting.id)).toEqual(["synthetic-owner-approval-v1"]);
    expect(second.meetings.map((meeting) => meeting.id)).toEqual(["synthetic-proposal-only-v1"]);
    await expect(source.pull({ cursor: "other-source:v1:unexpected" })).rejects.toThrow(/unsupported format/);
  });

  it("releases the owner-only atom only to the owner before answer composition", async () => {
    const atoms = syntheticMeetingQualityCorpusV1.layer4_atoms;
    const ownerPort = new SyntheticFixtureReleasedRetrievalPortV1({ principal_id: "owner", atoms });
    const memberPort = new SyntheticFixtureReleasedRetrievalPortV1({ principal_id: "member", atoms });
    const owner = await ownerPort.retrieve({ queries: ["approval visibility"] });
    const member = await memberPort.retrieve({ queries: ["approval visibility"] });

    expect(owner.released_atoms.map((atom) => atom.text)).toEqual([atoms[0]?.text]);
    expect(member.released_atoms).toEqual([]);
    expect(JSON.stringify(member)).not.toContain("Only me");
  });

  it("keeps owner-only atom text out of a member answer prompt", async () => {
    const releasedRetrieval = new SyntheticFixtureReleasedRetrievalPortV1({
      principal_id: "member",
      atoms: syntheticMeetingQualityCorpusV1.layer4_atoms,
    });
    let answerInput: StructuredGenerationInput | undefined;
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: async () => ({ queries: [] }) },
      answerer: {
        generate: vi.fn(async (input: StructuredGenerationInput) => {
          answerInput = input;
          return { status: "answered", answer: "Team records can be shared with organization members.", citations: ["a1"] };
        }),
      },
      released_retrieval: releasedRetrieval,
      audit: { append: () => undefined },
      generation_adapter_id: "fixture-model-adapter",
      planner_model: "fixture/eval",
      answer_model: "fixture/eval",
    });

    const result = await answer.answer({ question: "Under the Team policy, who can read records?" });

    expect(answerInput?.user_prompt).toContain("Records approved with the Team policy");
    expect(answerInput?.user_prompt).not.toContain("Only me");
    expect(result.citations).toHaveLength(1);
  });

  it("fails the synthetic evaluation when an answer repeats withheld fixture text", async () => {
    const result = await evaluateSyntheticMeetingQualityV1({
      ...evaluatorDependencies(new ExpectedSignalProcessor()),
      answerer: {
        generate: async () => ({
          status: "answered" as const,
          answer: "Organization members can read records. Approval cards default to Only me until the meeting owner chooses a wider policy.",
          citations: ["a1"],
        }),
      },
    });

    const memberCase = result.layer4.cases.find(
      (qualityCase) => qualityCase.case_id === "member-can-answer-team-policy",
    );
    expect(memberCase).toMatchObject({
      withheld_text_released: false,
      withheld_text_detected_in: ["composed_answer"],
    });
    expect(result.layer4).toMatchObject({
      withheld_text_release_count: 0,
      withheld_text_detection_count: 1,
    });
    expect(result.passed).toBe(false);
  });

  it("runs the existing Phase 1 replay corpus without provider I/O and emits a machine-readable aggregate", async () => {
    const meetings = await loadSyntheticReplayMeetingsV1(
      new URL("../../../../tests/product/fixtures/phase1-synthetic-replay-corpus.v1.json", import.meta.url).pathname,
    );
    const expected = new Map(
      phaseOneSyntheticExtractionExpectationsV1.map((item) => [item.meeting_id, item.expected_signals]),
    );
    const processor: DecisionProcessorAdapter = {
      identity: { kind: "decision-processor", adapter_id: "synthetic-replay-processor", instance_id: "test", version: "1" },
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({ status: "healthy", checked_at: "2026-08-29T00:00:00.000Z" }),
      extract: async (meeting) => ({
        schema_version: 1,
        meeting_id: meeting.id,
        meeting_revision: meeting.provenance.canonical_revision,
        processor: { kind: "decision-processor", adapter_id: "synthetic-replay-processor", instance_id: "test", version: "1" },
        generated_at: "2026-08-29T00:00:00.000Z",
        signals: (expected.get(meeting.id) ?? []).map((item, index) => {
          const base = {
            id: `${meeting.id}-${index}`,
            confidence: 1,
            evidence: [
              { meeting_id: meeting.id, block_id: meeting.content[0]!.id },
            ],
          };
          if (item.kind === "decision") {
            return { ...base, ...item, status: "decided" as const };
          }
          if (item.kind === "action") {
            return { ...base, ...item, owner: null, due_at: null };
          }
          return { ...base, ...item, supports_signal_ids: [] };
        }),
      }),
    };
    const result = await evaluateSyntheticMeetingQualityV1({
      source: new SyntheticMeetingSourceAdapterV1(meetings),
      processor,
      extraction_expectations: phaseOneSyntheticExtractionExpectationsV1,
      planner: { generate: async () => ({ queries: [] }) },
      answerer: {
        generate: async (input) =>
          input.user_prompt.includes("Approval cards default to Only me")
            ? { status: "answered", answer: "Only me.", citations: ["a1"] }
            : { status: "answered", answer: "Organization members can read records.", citations: ["a1"] },
      },
      generation_adapter_id: "fixture-model-adapter",
      planner_model: "fixture/eval",
      answer_model: "fixture/eval",
    });

    expect(result).toMatchObject({
      kind: "echo-synthetic-meeting-quality-evaluation-v1",
      source_adapter_id: "synthetic-source",
      extraction: {
        processed_meeting_count: meetings.length,
        scored_meeting_count: meetings.length,
        missing_count: 0,
      },
    });
    expect(result.passed).toBe(true);
    expect(new SyntheticMeetingSourceAdapterV1(meetings).identity).toEqual(
      syntheticMeetingSourceIdentityV1,
    );
  });

  it("fails closed when an extraction expectation is duplicate or unsupported", async () => {
    const base = {
      processor: new ExpectedSignalProcessor(),
      planner: { generate: async () => ({ queries: [] }) },
      answerer: { generate: async () => ({ status: "answered", answer: "fixture", citations: ["a1"] }) },
      generation_adapter_id: "fixture-model-adapter",
      planner_model: "fixture/eval",
      answer_model: "fixture/eval",
    };
    const duplicate = {
      meeting_id: "synthetic-owner-approval-v1",
      expected_signals: [],
    };
    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...base,
        extraction_expectations: [duplicate, duplicate],
      }),
    ).rejects.toThrow(/invalid or duplicated/);
    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...base,
        extraction_expectations: [{ meeting_id: "absent", expected_signals: [] }],
      }),
    ).rejects.toThrow(/no explicit extraction expectation/);
  });

  it.each([
    [
      "an extra top-level field",
      (corpus: Record<string, unknown>) => { corpus.unexpected = true; },
      /invalid top-level shape/,
    ],
    [
      "duplicate atom ids",
      (corpus: Record<string, unknown>) => {
        const atoms = corpus.layer4_atoms as Array<Record<string, unknown>>;
        atoms[1]!.id = atoms[0]!.id;
      },
      /atom ids/,
    ],
    [
      "an unresolved citation",
      (corpus: Record<string, unknown>) => {
        (corpus.layer4_cases as Array<Record<string, unknown>>)[0]!
          .required_citation_atom_ids = ["missing-atom"];
      },
      /does not resolve exactly once: missing-atom/,
    ],
    [
      "a withheld citation expectation",
      (corpus: Record<string, unknown>) => {
        const qualityCase = (corpus.layer4_cases as Array<Record<string, unknown>>)[1]!;
        qualityCase.required_citation_atom_ids = ["owner-only-approval-default"];
      },
      /invalid withheld citation expectations/,
    ],
    [
      "a malformed fixture before any adapter runs",
      (corpus: Record<string, unknown>) => {
        (corpus.fixtures as Array<Record<string, unknown>>)[0] = { id: "still-unique" };
      },
      /synthetic fixture has an invalid shape/,
    ],
  ])("rejects %s before synthetic evaluation", async (_label, mutate, expected) => {
    const corpus = structuredClone(syntheticMeetingQualityCorpusV1) as unknown as Record<string, unknown>;
    mutate(corpus);
    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...evaluatorDependencies(new ExpectedSignalProcessor()),
        corpus: corpus as unknown as typeof syntheticMeetingQualityCorpusV1,
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects a malformed source batch cursor before extraction scoring", async () => {
    const source = syntheticSourceWithPull(async () => ({
      meetings: syntheticMeetingQualityDocumentsV1().slice(0, 1),
      next_cursor: "",
    }));

    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...evaluatorDependencies(new ExpectedSignalProcessor()),
        source,
      }),
    ).rejects.toThrow(/meeting_batch.next_cursor must be a non-empty string/);
  });

  it("rejects source documents with provenance from another adapter", async () => {
    const meeting = syntheticMeetingQualityDocumentsV1()[0]!;
    const source = syntheticSourceWithPull(async () => ({
      meetings: [
        {
          ...meeting,
          provenance: {
            ...meeting.provenance,
            source: { ...meeting.provenance.source, adapter_id: "other-source" },
          },
        },
      ],
    }));

    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...evaluatorDependencies(new ExpectedSignalProcessor()),
        source,
      }),
    ).rejects.toThrow(/meeting provenance does not match the meeting-source adapter instance/);
  });

  it("rejects decision sets with provenance from another processor", async () => {
    const expected = new ExpectedSignalProcessor();
    const processor: DecisionProcessorAdapter = {
      identity: expected.identity,
      validateConfig: expected.validateConfig.bind(expected),
      healthCheck: expected.healthCheck.bind(expected),
      async extract(meeting, context) {
        const decisions = await expected.extract(meeting, context);
        return {
          ...decisions,
          processor: { ...decisions.processor, adapter_id: "other-processor" },
        };
      },
    };

    await expect(
      evaluateSyntheticMeetingQualityV1({
        ...evaluatorDependencies(processor),
        source: new SyntheticMeetingSourceAdapterV1(
          syntheticMeetingQualityDocumentsV1().slice(0, 1),
        ),
      }),
    ).rejects.toThrow(/decision processor result identity does not match the configured adapter/);
  });
});
