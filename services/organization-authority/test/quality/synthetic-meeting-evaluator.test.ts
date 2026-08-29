import { describe, expect, it, vi } from "vitest";
import {
  createLeanAnswerComposition,
  type Layer4StructuredGenerationInput,
} from "../../src/answer-composition/lean-answer-composition.js";
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  DecisionExtractionContext,
  DecisionProcessorAdapter,
  DecisionSet,
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
import { SyntheticFixtureLayer4BatchReadPortV1 } from "../../src/quality/synthetic-layer4-fixture-port-v1.js";

const fixtureAnswerer = {
  generate: async (input: Layer4StructuredGenerationInput) =>
    input.user_prompt.includes("Only me")
      ? { status: "answered" as const, answer: "Only me.", citations: ["a1"] }
      : { status: "answered" as const, answer: "Organization members can read records.", citations: ["a1"] },
};

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
      provider: "openrouter",
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

  it("releases the owner-only atom only to the owner before Layer 4 composition", async () => {
    const atoms = syntheticMeetingQualityCorpusV1.layer4_atoms;
    const ownerPort = new SyntheticFixtureLayer4BatchReadPortV1({ principal_id: "owner", atoms });
    const memberPort = new SyntheticFixtureLayer4BatchReadPortV1({ principal_id: "member", atoms });
    const owner = await ownerPort.retrieve({ queries: ["approval visibility"] });
    const member = await memberPort.retrieve({ queries: ["approval visibility"] });

    expect(owner.released_atoms.map((atom) => atom.text)).toEqual([atoms[0]?.text]);
    expect(member.released_atoms).toEqual([]);
    expect(JSON.stringify(member)).not.toContain("Only me");
  });

  it("keeps owner-only atom text out of a member Layer 4 answer prompt", async () => {
    const layer3 = new SyntheticFixtureLayer4BatchReadPortV1({
      principal_id: "member",
      atoms: syntheticMeetingQualityCorpusV1.layer4_atoms,
    });
    let answerInput: Layer4StructuredGenerationInput | undefined;
    const answer = createLeanAnswerComposition({
      planner: { generate: async () => ({ queries: [] }) },
      answerer: {
        generate: vi.fn(async (input: Layer4StructuredGenerationInput) => {
          answerInput = input;
          return { status: "answered", answer: "Team records can be shared with organization members.", citations: ["a1"] };
        }),
      },
      layer3,
      audit: { append: () => undefined },
      provider: "openrouter",
      planner_model: "fixture/eval",
      answer_model: "fixture/eval",
    });

    const result = await answer.answer({ question: "Under the Team policy, who can read records?" });

    expect(answerInput?.user_prompt).toContain("Records approved with the Team policy");
    expect(answerInput?.user_prompt).not.toContain("Only me");
    expect(result.citations).toHaveLength(1);
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
      provider: "openrouter",
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
      provider: "openrouter" as const,
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
});
