import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenRouterCleanAnswerCompositionRuntimeBundleV1,
  OPENROUTER_CLEAN_ANSWER_COMPOSITION_ADAPTER_ID_V1,
  OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1,
  OPENROUTER_CLEAN_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
} from "../../src/composition/openrouter-clean-answer-composition-runtime.js";

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

describe("OpenRouter clean Layer 4 runtime bundle", () => {
  it("owns credential resolution, structured-output construction, and the V3.2 generation profile", () => {
    const bundle = createOpenRouterCleanAnswerCompositionRuntimeBundleV1({
      credential_file: credentialFile(),
    });
    const runtime = bundle.open();

    expect(runtime.generation).toEqual({
      generation_adapter_id:
        OPENROUTER_CLEAN_ANSWER_COMPOSITION_ADAPTER_ID_V1,
      planner_model: OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1,
      answer_model: OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1,
      timeout_ms: OPENROUTER_CLEAN_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
    });
    expect(runtime.structured_output.generate).toBeTypeOf("function");
  });

  it("defers credential access until the active runtime opens", () => {
    const bundle = createOpenRouterCleanAnswerCompositionRuntimeBundleV1({
      credential_file: "/private/missing-openrouter-credential",
    });
    expect(() => bundle.open()).toThrow();
  });
});
