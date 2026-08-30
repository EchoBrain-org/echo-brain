import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import { createOpenRouterStructuredOutput } from "../answer-composition/openrouter-structured-output.js";
import type { CleanAnswerCompositionRuntimeBundleV1 } from "./clean-answer-composition-runtime.js";

export const OPENROUTER_CLEAN_ANSWER_COMPOSITION_ADAPTER_ID_V1 =
  "openrouter" as const;
export const OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1 =
  "deepseek/deepseek-v3.2" as const;
export const OPENROUTER_CLEAN_ANSWER_COMPOSITION_TIMEOUT_MS_V1 = 60_000;

/**
 * OpenRouter answer-composition adapter bundle. It is the only owner of the
 * private credential read and OpenRouter transport construction.
 */
export function createOpenRouterCleanAnswerCompositionRuntimeBundleV1(input: {
  readonly credential_file: string;
}): CleanAnswerCompositionRuntimeBundleV1 {
  return Object.freeze({
    open() {
      const credentialReference = `file:${input.credential_file}`;
      const credential = readPrivateAuthorityCredential(credentialReference);
      return Object.freeze({
        structured_output: createOpenRouterStructuredOutput({
          credential_ref: credentialReference,
          credential_resolver: (reference) =>
            reference === credentialReference ? credential : undefined,
        }),
        generation: Object.freeze({
          generation_adapter_id:
            OPENROUTER_CLEAN_ANSWER_COMPOSITION_ADAPTER_ID_V1,
          planner_model: OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1,
          answer_model: OPENROUTER_CLEAN_ANSWER_COMPOSITION_MODEL_V1,
          timeout_ms: OPENROUTER_CLEAN_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
        }),
      });
    },
  });
}
