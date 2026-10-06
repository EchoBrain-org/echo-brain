import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { createOpenRouterStructuredGenerationAdapter } from "./adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import type { AnswerCompositionGenerationBundleV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";

export const OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1 =
  "openrouter" as const;
export const OPENROUTER_ANSWER_COMPOSITION_MODEL_V1 =
  "deepseek/deepseek-v3.2" as const;
export const OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1 = 60_000;
/** OpenRouter's top provider context for deepseek-v3.2 (the model lists 163,840; routing uses the smaller). */
export const OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1 = 131_072;

/**
 * OpenRouter answer-composition adapter bundle. It is the only owner of the
 * private credential read and OpenRouter transport construction.
 */
export function createOpenRouterAnswerCompositionGenerationBundleV1(input: {
  readonly credential_file: string;
}): AnswerCompositionGenerationBundleV1 {
  return Object.freeze({
    load() {
      const credentialReference = `file:${input.credential_file}`;
      return Object.freeze({
        // Startup must not depend on an installed model credential. The API and
        // non-model maintenance lanes are useful during bootstrap; resolve and
        // validate the private file only when a request actually uses the model.
        structured_output: createOpenRouterStructuredGenerationAdapter({
          credential_ref: credentialReference,
          credential_resolver: (reference) => reference === credentialReference
            ? readPrivateAuthorityCredential(reference)
            : undefined,
        }),
        generation: Object.freeze({
          generation_adapter_id:
            OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1,
          planner_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
          answer_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
          timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
          context_tokens: OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1,
        }),
      });
    },
  });
}
