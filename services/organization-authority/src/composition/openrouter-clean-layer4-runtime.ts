import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import { createOpenRouterStructuredOutput } from "../answer-composition/openrouter-structured-output.js";
import type { CleanLayer4RuntimeBundleV1 } from "./clean-layer4-runtime.js";

export const OPENROUTER_CLEAN_LAYER4_ADAPTER_ID_V1 = "openrouter" as const;
export const OPENROUTER_CLEAN_LAYER4_MODEL_V1 = "deepseek/deepseek-v3.2" as const;
export const OPENROUTER_CLEAN_LAYER4_TIMEOUT_MS_V1 = 60_000;

/**
 * Current Layer 4 provider composition. It is the only owner of the private
 * credential read and OpenRouter transport construction.
 */
export function createOpenRouterCleanLayer4RuntimeBundleV1(input: {
  readonly credential_file: string;
}): CleanLayer4RuntimeBundleV1 {
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
          generation_adapter_id: OPENROUTER_CLEAN_LAYER4_ADAPTER_ID_V1,
          planner_model: OPENROUTER_CLEAN_LAYER4_MODEL_V1,
          answer_model: OPENROUTER_CLEAN_LAYER4_MODEL_V1,
          timeout_ms: OPENROUTER_CLEAN_LAYER4_TIMEOUT_MS_V1,
        }),
      });
    },
  });
}
