import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AdapterConfig,
  AdapterErrorCode,
  DecisionProcessorAdapter,
  DecisionSet,
  ExtractedSignal,
  MeetingDocument,
} from "../../../../src/processing/core/index.js";
import { AdapterError } from "../../../../src/processing/core/index.js";
import {
  evaluateNorthstarPreSlackExtractionV1,
  runNorthstarPreSlackEvaluatorCommandV1,
} from "../../../../src/composition/providers/synthetic-demo/synthetic-demo-pre-slack-evaluator-v1.js";
import { loadSyntheticDemoMeetingCorpusV1 } from "../../../../src/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";
import {
  fixedOpenRouterDecisionProcessorConfigV1,
  OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
} from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-config-v1.js";

const meetingsDirectory = fileURLToPath(new URL("../../../../../../demo/meetings/", import.meta.url));
const expectationsPath = fileURLToPath(new URL("../../../../../../demo/expectations.json", import.meta.url));
const identity = {
  kind: "decision-processor" as const,
  adapter_id: "synthetic-demo-pre-slack-test",
  instance_id: "synthetic-demo-pre-slack-test",
  version: "1.0.0",
};

interface ExpectedSignal {
  readonly evidence_block_ids: readonly string[];
  readonly plain_language_fact: string;
  readonly required_text_clauses?: readonly (readonly string[])[];
  readonly due_date?: string;
}

interface ExpectedMeeting {
  readonly meeting_id: string;
  readonly required_decisions: readonly ExpectedSignal[];
  readonly required_actions: readonly ExpectedSignal[];
  readonly required_rationales: readonly ExpectedSignal[];
}

interface Oracle {
  readonly meeting_expectations: readonly ExpectedMeeting[];
}

async function fixture(): Promise<{ readonly meetings: readonly MeetingDocument[]; readonly oracle: Oracle }> {
  const [corpus, oracle] = await Promise.all([
    loadSyntheticDemoMeetingCorpusV1(meetingsDirectory),
    readFile(expectationsPath, "utf8").then((value) => JSON.parse(value) as Oracle),
  ]);
  return { meetings: corpus.meetings, oracle };
}

function signal(
  meeting: MeetingDocument,
  kind: ExtractedSignal["kind"],
  expected: ExpectedSignal,
  index: number,
): ExtractedSignal {
  const evidence = expected.evidence_block_ids.map((block_id) => ({ meeting_id: meeting.id, block_id }));
  const base = {
    id: `${meeting.id}:${kind}:${index}`,
    text: expected.plain_language_fact,
    subject: null,
    confidence: 1,
    evidence,
  };
  if (kind === "decision") {
    return {
      ...base,
      kind,
      status: "decided",
    };
  }
  if (kind === "action") {
    return {
      ...base,
      kind,
      owner: null,
      due_at: `${expected.due_date!}T12:00:00.000Z`,
    };
  }
  return { ...base, kind, supports_signal_ids: [] };
}

function processor(
  oracle: Oracle,
  mutate?: (signals: ExtractedSignal[], meeting: MeetingDocument) => void,
): DecisionProcessorAdapter {
  return {
    identity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: "healthy", checked_at: "2026-08-30T00:00:00.000Z" }),
    extract: async (meeting) => {
      const expected = oracle.meeting_expectations.find((item) => item.meeting_id === meeting.id)!;
      const signals = [
        ...expected.required_decisions.map((item, index) => signal(meeting, "decision", item, index)),
        ...expected.required_actions.map((item, index) => signal(meeting, "action", item, index)),
        ...expected.required_rationales.map((item, index) => signal(meeting, "rationale", item, index)),
      ];
      mutate?.(signals, meeting);
      return {
        schema_version: 1,
        meeting_id: meeting.id,
        meeting_revision: meeting.provenance.canonical_revision,
        processor: identity,
        generated_at: "2026-08-30T00:00:00.000Z",
        signals,
      } satisfies DecisionSet;
    },
  };
}

describe("Northstar pre-Slack evaluator", () => {
  it("runs the canonical four-meeting corpus offline without attribution scoring", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle),
    });

    expect(report).toMatchObject({
      kind: "echo-synthetic-demo-pre-slack-evaluation-v1",
      processed_meeting_count: 4,
      passed: true,
      u1_due_dates: [],
      u3_complete_evidence: [],
      u4_status_guards: [],
      u6_required_coverage: [],
    });
    expect("u2_decision_attribution" in report).toBe(false);
    expect("u5_action_owners" in report).toBe(false);
  });

  it("reports the exact pre-Slack defect classes without network access", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals) => {
        const action = signals.find((item) => item.kind === "action") as ExtractedSignal & { kind: "action" };
        action.due_at = "2024-09-04T00:00:00.000Z";
        const decision = signals.find((item) => item.kind === "decision") as ExtractedSignal & { kind: "decision" };
        decision.status = "proposed";
        decision.evidence = decision.evidence.slice(0, 1);
        signals.splice(-1, 1);
      }),
    });

    expect(report.passed).toBe(false);
    expect(report.u1_due_dates.length).toBeGreaterThanOrEqual(1);
    expect(report.u3_complete_evidence.length).toBeGreaterThanOrEqual(1);
    expect(report.u4_status_guards.length).toBeGreaterThanOrEqual(1);
    expect(report.u6_required_coverage.length).toBeGreaterThanOrEqual(1);
  });

  it("catches Leah's relative-date action when extraction leaves its due date empty", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-data-handling-review-2026-08-26") return;
        const leah = signals.find((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === "northstar-data-handling-review:transcript:11"),
        ) as Extract<ExtractedSignal, { kind: "action" }>;
        leah.due_at = null;
      }),
    });

    expect(report.u1_due_dates).toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-data-handling-review-2026-08-26",
      expected_evidence_block_ids: ["northstar-data-handling-review:transcript:11"],
      expected_value: "2026-08-26",
      actual_value: null,
    }));
  });

  it("compares due dates in the meeting timezone across a UTC day boundary", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24") return;
        const jules = signals.find((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === "transcript-11"),
        ) as Extract<ExtractedSignal, { kind: "action" }>;
        jules.due_at = "2026-09-12T06:30:00.000Z";
      }),
    });

    expect(report.passed).toBe(true);
    expect(report.u1_due_dates).toEqual([]);
  });

  it("catches the lost Revenue other-18 clause even when the evidence block is retained", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24") return;
        const maya = signals.find((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === "transcript-10"),
        ) as Extract<ExtractedSignal, { kind: "action" }>;
        maya.text = "Confirm the first 10 locations with Northstar.";
      }),
    });

    expect(report.u3_complete_evidence).toEqual([]);
    expect(report.u6_required_coverage).toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24",
      expected_evidence_block_ids: ["transcript-10"],
      expected_value: "confirm + 10 locations; 18 + commit",
    }));
  });

  it("requires the supporting response with the Data question and Commercial suggestion", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        const firstBlockId = meeting.id === "synthetic-demo-northstar-data-handling-review-2026-08-26"
          ? "northstar-data-handling-review:transcript:6"
          : meeting.id === "synthetic-demo-northstar-commercial-exception-2026-08-29"
            ? "turn-09"
            : undefined;
        if (firstBlockId === undefined) return;
        const paired = signals.find((item) =>
          item.kind === "decision" && item.evidence.some((evidence) => evidence.block_id === firstBlockId),
        ) as Extract<ExtractedSignal, { kind: "decision" }>;
        paired.evidence = paired.evidence.filter((evidence) => evidence.block_id === firstBlockId);
      }),
    });

    expect(report.u4_status_guards).toEqual([]);
    expect(report.u3_complete_evidence.map((finding) => finding.expected_evidence_block_ids)).toEqual(expect.arrayContaining([
      ["northstar-data-handling-review:transcript:6", "northstar-data-handling-review:transcript:7"],
      ["turn-09", "turn-10"],
    ]));
  });

  it("allows extra valid support once every required evidence block is present", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-data-handling-review-2026-08-26") return;
        const paired = signals.find((item) =>
          item.kind === "decision" && item.evidence.some((evidence) => evidence.block_id === "northstar-data-handling-review:transcript:6"),
        ) as Extract<ExtractedSignal, { kind: "decision" }>;
        paired.evidence = [
          ...paired.evidence,
          { meeting_id: meeting.id, block_id: "northstar-data-handling-review:transcript:9" },
        ];
      }),
    });

    expect(report.passed).toBe(true);
    expect(report.u3_complete_evidence).toEqual([]);
  });

  it("does not let one merged signal satisfy two required facts", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-implementation-capacity-2026-08-28") return;
        const maya = signals.find((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === "transcript-12"),
        ) as Extract<ExtractedSignal, { kind: "action" }>;
        const imaniIndex = signals.findIndex((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === "transcript-11"),
        );
        const imani = signals[imaniIndex] as Extract<ExtractedSignal, { kind: "action" }>;
        maya.text = `${maya.text} ${imani.text}`;
        maya.evidence = [...maya.evidence, ...imani.evidence];
        signals.splice(imaniIndex, 1);
      }),
    });

    expect(report.u6_required_coverage).toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-implementation-capacity-2026-08-28",
      expected_evidence_block_ids: ["transcript-11"],
    }));
  });

  it("matches a required fact by its semantic anchors before a higher-overlap distractor", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-implementation-capacity-2026-08-28") return;
        const expected = signals.find((item) =>
          item.kind === "decision" && item.evidence.some((evidence) => evidence.block_id === "transcript-06"),
        ) as Extract<ExtractedSignal, { kind: "decision" }>;
        expected.evidence = expected.evidence.filter((evidence) => evidence.block_id === "transcript-06");
        signals.push({
          ...expected,
          id: `${meeting.id}:decision:distractor`,
          text: "Do not describe all 28 locations as already scheduled.",
          evidence: [
            { meeting_id: meeting.id, block_id: "transcript-06" },
            { meeting_id: meeting.id, block_id: "transcript-10" },
          ],
        });
      }),
    });

    expect(report.u6_required_coverage).not.toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-implementation-capacity-2026-08-28",
      expected_evidence_block_ids: ["transcript-06", "transcript-10"],
    }));
    expect(report.u3_complete_evidence).toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-implementation-capacity-2026-08-28",
      expected_evidence_block_ids: ["transcript-06", "transcript-10"],
      actual_evidence_block_ids: ["transcript-06"],
    }));
  });

  it("reports a text-mismatched action as U6 without a secondary evidence defect", async () => {
    const { meetings, oracle } = await fixture();
    const expectedEvidence = [
      "northstar-data-handling-review:transcript:6",
      "northstar-data-handling-review:transcript:10",
    ];
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-data-handling-review-2026-08-26") return;
        const rob = signals.find((item) =>
          item.kind === "action" && item.evidence.some((evidence) => evidence.block_id === expectedEvidence[0]),
        ) as Extract<ExtractedSignal, { kind: "action" }>;
        rob.text = "Copy Maya on the addendum email.";
        rob.evidence = rob.evidence.slice(0, 1);
      }),
    });

    expect(report.u6_required_coverage).toContainEqual(expect.objectContaining({
      meeting_id: "synthetic-demo-northstar-data-handling-review-2026-08-26",
      expected_evidence_block_ids: expectedEvidence,
    }));
    expect(report.u3_complete_evidence).not.toContainEqual(expect.objectContaining({
      expected_evidence_block_ids: expectedEvidence,
    }));
  });

  it("accepts source-grounded lexical variants of the same required facts", async () => {
    const { meetings, oracle } = await fixture();
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id === "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24") {
          const expansion = signals.find((item) =>
            item.kind === "decision" && item.evidence.some((evidence) => evidence.block_id === "transcript-09"),
          )!;
          expansion.text = "Expand after 8 of 10 locations complete the workflow four weeks in a row without manual correction.";
          const rationale = signals.find((item) =>
            item.kind === "rationale" && item.evidence.some((evidence) => evidence.block_id === "transcript-03"),
          )!;
          rationale.text = "Weekly use must prove the pattern before it becomes a broader commitment.";
        }
        if (meeting.id === "synthetic-demo-northstar-data-handling-review-2026-08-26") {
          const planning = signals.find((item) =>
            item.kind === "decision" && item.evidence.some((evidence) =>
              evidence.block_id === "northstar-data-handling-review:transcript:6"),
          )!;
          planning.text = "Implementation work may be scheduled, but production must not be enabled yet.";
          const omar = signals.find((item) =>
            item.kind === "action" && item.evidence.some((evidence) =>
              evidence.block_id === "northstar-data-handling-review:transcript:7"),
          )!;
          omar.text = "Verify Priya's details and the escalation route.";
          const rob = signals.find((item) =>
            item.kind === "action" && item.evidence.some((evidence) =>
              evidence.block_id === "northstar-data-handling-review:transcript:10"),
          )!;
          rob.text = "Send the revised data-processing addendum to Northstar.";
        }
        if (meeting.id === "synthetic-demo-northstar-implementation-capacity-2026-08-28") {
          const window = signals.find((item) =>
            item.kind === "decision" && item.evidence.some((evidence) => evidence.block_id === "transcript-06"),
          )!;
          window.text = "September 16 is a conditional onboarding window for the initial 10 Northstar locations.";
        }
        if (meeting.id === "synthetic-demo-northstar-commercial-exception-2026-08-29") {
          const rationale = signals.find((item) =>
            item.kind === "rationale" && item.evidence.some((evidence) => evidence.block_id === "turn-04"),
          )!;
          rationale.text = "An all-28-location exception would become the default commercial position.";
        }
      }),
    });

    expect(report.passed).toBe(true);
    expect(report.u6_required_coverage).toEqual([]);
  });

  it("rejects a promoted proposal with extra evidence but allows a grounded rejection", async () => {
    const { meetings, oracle } = await fixture();
    const run = (mode: "promoted" | "promoted-extra" | "grounded-rejection") => evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: processor(oracle, (signals, meeting) => {
        if (meeting.id !== "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24") return;
        if (mode === "grounded-rejection") {
          const current = signals.find((signal) =>
            signal.kind === "decision" &&
            signal.evidence.some((evidence) => evidence.block_id === "transcript-09"),
          ) as Extract<ExtractedSignal, { kind: "decision" }>;
          current.text = "All 28 locations are not in scope from day one. Start with 10 and expand after at least 8 of 10 complete four consecutive weekly workflows without manual correction.";
          current.evidence = [
            { meeting_id: meeting.id, block_id: "transcript-02" },
            { meeting_id: meeting.id, block_id: "transcript-09" },
          ];
          return;
        }
        signals.push({
          id: `${meeting.id}:decision:forbidden-proposal`,
          kind: "decision",
          text: mode === "promoted-extra"
            ? "We will roll out to 28 locations immediately."
            : "All 28 locations are in scope from day one.",
          status: "decided",
          subject: null,
          confidence: 1,
          evidence: [
            { meeting_id: meeting.id, block_id: "transcript-02" },
            ...(mode === "promoted-extra"
              ? [{ meeting_id: meeting.id, block_id: "transcript-09" }]
              : []),
          ],
        });
      }),
    });

    const promotedProposal = await run("promoted");
    const promotedWithExtraEvidence = await run("promoted-extra");
    const groundedRejection = await run("grounded-rejection");

    expect(promotedProposal.u4_status_guards).toHaveLength(1);
    expect(promotedWithExtraEvidence.u4_status_guards).toHaveLength(1);
    expect(groundedRejection.u4_status_guards).toEqual([]);
  });

  it("keeps the production command offline when its processor and corpus seams are injected", async () => {
    const { meetings, oracle } = await fixture();
    const output: string[] = [];
    const exit = await runNorthstarPreSlackEvaluatorCommandV1(
      [
        "run",
        "--meetings-dir", "/tmp/northstar-meetings",
        "--expectations", "/tmp/northstar-expectations.json",
        "--llm-credential-file", "/tmp/not-a-real-credential",
      ],
      { stdout: (line) => output.push(line) },
      {
        read_credential: () => "test-credential-not-a-real-token",
        create_processor: (config: AdapterConfig) => {
          expect(config).toEqual(
            fixedOpenRouterDecisionProcessorConfigV1(
              "founder-llm-v1",
              "file:/tmp/not-a-real-credential",
            ),
          );
          expect(config.settings.model).toBe(
            OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
          );
          return processor(oracle);
        },
        load_corpus: async () => ({
          meetings,
          corpus_digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        }),
        read_expectations: async () => oracle,
      },
    );

    expect(exit).toBe(0);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({ passed: true, processed_meeting_count: 4 });
    expect(output.join("")).not.toContain("test-credential-not-a-real-token");
  });

  it("passes an optional OpenRouter model override through the same evaluator contract", async () => {
    const { meetings, oracle } = await fixture();
    const output: string[] = [];
    let configuredModel: string | undefined;
    const exit = await runNorthstarPreSlackEvaluatorCommandV1(
      [
        "run",
        "--meetings-dir", "/tmp/northstar-meetings",
        "--expectations", "/tmp/northstar-expectations.json",
        "--llm-credential-file", "/tmp/not-a-real-credential",
        "--model", "openai/gpt-4.1",
      ],
      { stdout: (line) => output.push(line) },
      {
        read_credential: () => "test-credential-not-a-real-token",
        create_processor: (config: AdapterConfig) => {
          configuredModel = String(config.settings.model);
          return processor(oracle);
        },
        load_corpus: async () => ({
          meetings,
          corpus_digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        }),
        read_expectations: async () => oracle,
      },
    );

    expect(exit).toBe(0);
    expect(configuredModel).toBe("openai/gpt-4.1");
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      evaluated_model: "openai/gpt-4.1",
      passed: true,
    });
  });

  it("records a safe per-meeting extraction failure and continues the other meetings", async () => {
    const { meetings, oracle } = await fixture();
    const base = processor(oracle);
    const attempted: string[] = [];
    const failing: DecisionProcessorAdapter = {
      ...base,
      extract: async (meeting, context) => {
        attempted.push(meeting.id);
        if (meeting.id === "synthetic-demo-northstar-data-handling-review-2026-08-26") {
          throw new AdapterError(
            "temporarily_unavailable" satisfies AdapterErrorCode,
            "LLM output contained invalid or unsupported signal grounding",
            true,
          );
        }
        return base.extract(meeting, context);
      },
    };
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: failing,
    });

    expect(attempted).toHaveLength(4);
    expect(report.passed).toBe(false);
    expect(report.extraction_failures).toEqual([{
      meeting_id: "synthetic-demo-northstar-data-handling-review-2026-08-26",
      step: "decision_processor.extract",
      reason: "invalid_grounding",
      code: "temporarily_unavailable",
    }]);
    expect(JSON.stringify(report)).not.toContain("LLM output contained");
  });

  it("surfaces only an allowlisted parser stage for a schema failure", async () => {
    const { meetings, oracle } = await fixture();
    const base = processor(oracle);
    const failing: DecisionProcessorAdapter = {
      ...base,
      extract: async (meeting, context) => {
        if (meeting.id === "synthetic-demo-northstar-data-handling-review-2026-08-26") {
          throw new AdapterError(
            "temporarily_unavailable" satisfies AdapterErrorCode,
            "LLM output did not match the extraction schema at stage: evidence_shape",
            true,
          );
        }
        return base.extract(meeting, context);
      },
    };

    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: failing,
    });

    expect(report.extraction_failures).toEqual([{
      meeting_id: "synthetic-demo-northstar-data-handling-review-2026-08-26",
      step: "decision_processor.extract",
      reason: "invalid_schema",
      code: "temporarily_unavailable",
      schema_stage: "evidence_shape",
    }]);
    expect(JSON.stringify(report)).not.toContain("LLM output did not match");
  });

  it("surfaces only an allowlisted grounding stage", async () => {
    const { meetings, oracle } = await fixture();
    const base = processor(oracle);
    const failing: DecisionProcessorAdapter = {
      ...base,
      extract: async (meeting, context) => {
        if (meeting.id === "synthetic-demo-northstar-commercial-exception-2026-08-29") {
          throw new AdapterError(
            "temporarily_unavailable" satisfies AdapterErrorCode,
            "LLM output contained invalid or unsupported signal grounding at stage: evidence_quote",
            true,
          );
        }
        return base.extract(meeting, context);
      },
    };

    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: failing,
    });

    expect(report.extraction_failures).toEqual([{
      meeting_id: "synthetic-demo-northstar-commercial-exception-2026-08-29",
      step: "decision_processor.extract",
      reason: "invalid_grounding",
      code: "temporarily_unavailable",
      grounding_stage: "evidence_quote",
    }]);
    expect(JSON.stringify(report)).not.toContain("LLM output contained");
  });

  it("records a safe canonical decision-set failure and continues the other meetings", async () => {
    const { meetings, oracle } = await fixture();
    const base = processor(oracle);
    const attempted: string[] = [];
    const invalid: DecisionProcessorAdapter = {
      ...base,
      extract: async (meeting, context) => {
        attempted.push(meeting.id);
        const result = await base.extract(meeting, context);
        return meeting.id ===
          "synthetic-demo-northstar-commercial-exception-2026-08-29"
          ? { ...result, meeting_revision: "not-the-canonical-revision" }
          : result;
      },
    };
    const report = await evaluateNorthstarPreSlackExtractionV1({
      meetings,
      expectations: oracle,
      processor: invalid,
    });

    expect(attempted).toHaveLength(4);
    expect(report.passed).toBe(false);
    expect(report.extraction_failures).toEqual([
      {
        meeting_id:
          "synthetic-demo-northstar-commercial-exception-2026-08-29",
        step: "canonical_decision_set_validation",
        reason: "invalid_schema",
      },
    ]);
  });

  it("stops before meetings when the selected model fails the health capability gate", async () => {
    const { meetings, oracle } = await fixture();
    const output: string[] = [];
    let corpusLoaded = false;
    const unavailable: DecisionProcessorAdapter = {
      ...processor(oracle),
      healthCheck: async () => ({
        status: "unavailable",
        checked_at: "2026-08-30T00:00:00.000Z",
      }),
    };
    const exit = await runNorthstarPreSlackEvaluatorCommandV1(
      [
        "run",
        "--meetings-dir", "/tmp/northstar-meetings",
        "--expectations", "/tmp/northstar-expectations.json",
        "--llm-credential-file", "/tmp/not-a-real-credential",
      ],
      { stdout: (line) => output.push(line) },
      {
        read_credential: () => "test-credential-not-a-real-token",
        create_processor: () => unavailable,
        load_corpus: async () => {
          corpusLoaded = true;
          return {
            meetings,
            corpus_digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
          };
        },
      },
    );

    expect(exit).toBe(1);
    expect(corpusLoaded).toBe(false);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      evaluated_model: "anthropic/claude-sonnet-4.6",
      passed: false,
      extraction_failures: [{
        meeting_id: null,
        step: "decision_processor.health_check",
        reason: "health_check_failed",
      }],
    });
  });
});
