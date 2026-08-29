import { describe, expect, it } from "vitest";
import type {
  AdapterConfig,
  DecisionProcessorAdapter,
  MeetingDocument,
} from "../../src/processing/core/index.js";
import {
  phaseOneSyntheticExtractionExpectationsV1,
} from "../../src/quality/synthetic-meeting-quality-evaluator-v1.js";
import { runSyntheticMeetingQualityCommandV1 } from "../../src/composition/synthetic-meeting-quality-cli.js";

function replayMeeting(id: string): MeetingDocument {
  return {
    schema_version: 1,
    id,
    title: id,
    lifecycle: "completed",
    capture: {
      state: "complete",
      components: [{ kind: "notes", state: "available" }],
    },
    participants: [],
    content: [{ id: "notes-1", kind: "note", text: "Synthetic fixture content." }],
    artifacts: [],
    context: {},
    provenance: {
      source: {
        kind: "meeting-source",
        adapter_id: "synthetic-source",
        instance_id: "fixture",
        version: "1.0.0",
      },
      external_id: `${id}.example.test`,
      canonical_revision: "r1",
      observed_at: "2026-08-29T00:00:00.000Z",
      normalizer_version: "1.0.0",
    },
  };
}

function expectedProcessor(): DecisionProcessorAdapter {
  const expectations = new Map(
    phaseOneSyntheticExtractionExpectationsV1.map((value) => [
      value.meeting_id,
      value.expected_signals,
    ]),
  );
  return {
    identity: {
      kind: "decision-processor",
      adapter_id: "llm",
      instance_id: "synthetic-quality-eval",
      version: "test",
    },
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({
      status: "healthy",
      checked_at: "2026-08-29T00:00:00.000Z",
    }),
    extract: async (meeting) => ({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: {
        kind: "decision-processor",
        adapter_id: "llm",
        instance_id: "synthetic-quality-eval",
        version: "test",
      },
      generated_at: "2026-08-29T00:00:00.000Z",
      signals: (expectations.get(meeting.id) ?? []).map((item, index) => {
        const base = {
          id: `${meeting.id}-${index}`,
          confidence: 1,
          evidence: [{ meeting_id: meeting.id, block_id: "notes-1" }],
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
}

describe("synthetic meeting quality command", () => {
  it("wires the fixed OpenRouter configuration to injected local seams", async () => {
    const output: string[] = [];
    const received: { config?: AdapterConfig; credential?: string; paths: string[] } = {
      paths: [],
    };
    const exit = await runSyntheticMeetingQualityCommandV1(
      [
        "run",
        "--corpus",
        "/tmp/phase1-synthetic-replay-corpus.v1.json",
        "--llm-credential-file",
        "/tmp/private-openrouter-token",
      ],
      { stdout: (line) => output.push(line) },
      {
        read_credential: (reference) => {
          received.credential = reference;
          return "test-credential-not-a-real-token";
        },
        load_corpus: async (path) => {
          received.paths.push(path);
          return phaseOneSyntheticExtractionExpectationsV1.map((value) =>
            replayMeeting(value.meeting_id),
          );
        },
        create_processor: (config, credential) => {
          received.config = config;
          received.credential = credential;
          return expectedProcessor();
        },
        create_structured_output: () => ({
          generate: async (input) =>
            Array.isArray(input.schema.required) && input.schema.required.includes("queries")
              ? { queries: [] }
              : input.user_prompt.includes("Only me")
                ? { status: "answered", answer: "Only me.", citations: ["a1"] }
                : { status: "answered", answer: "Organization members can read records.", citations: ["a1"] },
        }),
      },
    );

    expect(exit).toBe(0);
    expect(received.paths).toEqual(["/tmp/phase1-synthetic-replay-corpus.v1.json"]);
    expect(received.credential).toBe("test-credential-not-a-real-token");
    expect(received.config).toMatchObject({
      adapter_id: "llm",
      instance_id: "synthetic-quality-eval",
      credential_ref: "file:/tmp/private-openrouter-token",
      settings: { provider: "openrouter", model: "deepseek/deepseek-r1" },
    });
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("Adopt a two-stage release review");
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      kind: "echo-synthetic-meeting-quality-evaluation-v1",
      source_adapter_id: "synthetic-source",
      passed: true,
    });
  });

  it("rejects malformed input and redacts credential-reader failures", async () => {
    const usage: string[] = [];
    const usageExit = await runSyntheticMeetingQualityCommandV1(
      ["run", "--corpus", "relative.json", "--llm-credential-file", "/tmp/credential"],
      { stdout: (line) => usage.push(line) },
    );
    expect(usageExit).toBe(2);
    expect(JSON.parse(usage[0] ?? "")).toMatchObject({ failure: "usage" });

    const failures: string[] = [];
    const evaluationExit = await runSyntheticMeetingQualityCommandV1(
      ["run", "--corpus", "/tmp/corpus.json", "--llm-credential-file", "/tmp/credential"],
      { stdout: (line) => failures.push(line) },
      { read_credential: () => { throw new Error("secret-token-must-not-appear"); } },
    );
    expect(evaluationExit).toBe(2);
    expect(failures[0]).not.toContain("secret-token-must-not-appear");
    expect(JSON.parse(failures[0] ?? "")).toMatchObject({ failure: "evaluation" });
  });
});
