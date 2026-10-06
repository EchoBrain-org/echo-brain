import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenRouterAnswerCompositionGenerationBundleV1, OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1, OPENROUTER_ANSWER_COMPOSITION_MODEL_V1, OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1, OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1 } from "../src/openrouter-answer-composition-generation-bundle-v1.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function credentialFile(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "echo-openrouter-answer-composition-"),
  );
  directories.push(directory);
  const path = join(directory, "credential");
  writeFileSync(path, "a".repeat(32), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("OpenRouter answer-composition generation bundle", () => {
  it("owns credential resolution, structured-output construction, and the V3.2 generation profile", () => {
    const bundle = createOpenRouterAnswerCompositionGenerationBundleV1({
      credential_file: credentialFile(),
    });
    const runtime = bundle.load();

    expect(runtime.generation).toEqual({
      generation_adapter_id:
        OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1,
      planner_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
      answer_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
      timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
      context_tokens: OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1,
    });
    expect(runtime.structured_output.generate).toBeTypeOf("function");
  });

  it("loads without credentials and checks the private file only when generating", async () => {
    const bundle = createOpenRouterAnswerCompositionGenerationBundleV1({
      credential_file: "/private/missing-openrouter-credential",
    });
    const runtime = bundle.load();
    expect(runtime.structured_output.generate_with_observation).toBeTypeOf("function");
    await expect(runtime.structured_output.generate({
      model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
      system_prompt: "fixture", user_prompt: "fixture", schema: { type: "object" },
      max_output_tokens: 1, timeout_ms: 1_000,
    })).rejects.toThrow();
  });
});
