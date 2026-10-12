import { describe, expect, it } from "vitest";
import type {
  AdapterConfig,
  DecisionProcessorAdapter,
  MeetingDocument,
} from "@echo-brain/organization-processing/core";
import { fixedOpenRouterDecisionProcessorConfigV1, OPENROUTER_DECISION_PROCESSOR_MODEL_V1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-config-v1";
import { fixture, processor } from "../../../../providers/synthetic-demo/test/pre-slack-evaluator-fixtures.js";
import { runNorthstarPreSlackEvaluatorCommandV1, type NorthstarPreSlackEvaluatorDependenciesV1 } from "../../src/composition/synthetic-demo-pre-slack-evaluator-cli-v1.js";

async function runCommand(
  meetings: readonly MeetingDocument[],
  dependencies: NorthstarPreSlackEvaluatorDependenciesV1,
  extraArgs: readonly string[] = [],
): Promise<{ readonly exit: number; readonly output: readonly string[] }> {
  const output: string[] = [];
  const exit = await runNorthstarPreSlackEvaluatorCommandV1(
    [
      "run",
      "--meetings-dir", "/tmp/northstar-meetings",
      "--expectations", "/tmp/northstar-expectations.json",
      "--llm-credential-file", "/tmp/not-a-real-credential",
      ...extraArgs,
    ],
    { stdout: (line) => output.push(line) },
    {
      read_credential: () => "test-credential-not-a-real-token",
      load_corpus: async () => ({
        meetings,
        corpus_digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      }),
      ...dependencies,
    },
  );
  return { exit, output };
}

describe("Echo pre-Slack evaluator command", () => {
  it("keeps the production command offline when its processor and corpus seams are injected", async () => {
    const { meetings, oracle } = await fixture();
    const { exit, output } = await runCommand(meetings, {
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
      read_expectations: async () => oracle,
    });

    expect(exit).toBe(0);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({ passed: true, processed_meeting_count: 4 });
    expect(output.join("")).not.toContain("test-credential-not-a-real-token");
  });

  it("passes an optional OpenRouter model override through the same evaluator contract", async () => {
    const { meetings, oracle } = await fixture();
    let configuredModel: string | undefined;
    const { exit, output } = await runCommand(
      meetings,
      {
        create_processor: (config: AdapterConfig) => {
          configuredModel = String(config.settings.model);
          return processor(oracle);
        },
        read_expectations: async () => oracle,
      },
      ["--model", "openai/gpt-4.1"],
    );

    expect(exit).toBe(0);
    expect(configuredModel).toBe("openai/gpt-4.1");
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      evaluated_model: "openai/gpt-4.1",
      passed: true,
    });
  });

  it("stops before meetings when the selected model fails the health capability gate", async () => {
    const { meetings, oracle } = await fixture();
    let corpusLoaded = false;
    const unavailable: DecisionProcessorAdapter = {
      ...processor(oracle),
      healthCheck: async () => ({
        status: "unavailable",
        checked_at: "2026-08-30T00:00:00.000Z",
      }),
    };
    const { exit, output } = await runCommand(meetings, {
      create_processor: () => unavailable,
      load_corpus: async () => {
        corpusLoaded = true;
        return {
          meetings,
          corpus_digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        };
      },
    });

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
