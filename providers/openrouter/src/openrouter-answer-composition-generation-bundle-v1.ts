import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { createOpenRouterStructuredGenerationAdapter } from "./adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import type { AnswerCompositionGenerationBundleV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import { createClaudeResearchDriverV1 } from './claude-research/driver.js';
import { openRouterClaudeForwarderV1 } from './claude-research/model-transport.js';

export const OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1 =
  "openrouter" as const;
export const OPENROUTER_ANSWER_COMPOSITION_MODEL_V1 =
  "anthropic/claude-sonnet-5.5" as const;
/**
 * How long one call may send nothing: the adapter streams the reply, and every piece (or OpenRouter's keep-alive)
 * resets it, so a reply that keeps arriving runs as long as it needs. Research and the writer have no clock of their own.
 */
export const OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1 = 600_000;
/** Claude Sonnet 5.5's own context window, in tokens (Anthropic's model table). */
export const OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1 = 1_000_000;
/** Claude Sonnet 5.5's own maximum output, in tokens, reasoning included (Anthropic's model table). */
export const OPENROUTER_ANSWER_COMPOSITION_MAX_OUTPUT_TOKENS_V1 = 128_000;
/**
 * OpenRouter answer-composition adapter bundle. It is the only owner of the
 * private credential read and OpenRouter transport construction.
 */
export function createOpenRouterAnswerCompositionGenerationBundleV1(input: {
  readonly credential_file: string;
  readonly research_engine?: 'claude-sdk';
}): AnswerCompositionGenerationBundleV1 {
  return Object.freeze({
    load() {
      const credentialReference = `file:${input.credential_file}`;
      return Object.freeze({
        ...(input.research_engine === 'claude-sdk' ? { research_driver: createClaudeResearchDriverV1({
          model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
          forward: openRouterClaudeForwarderV1(() => readPrivateAuthorityCredential(credentialReference), OPENROUTER_ANSWER_COMPOSITION_MODEL_V1),
        }) } : {}),
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
            input.research_engine === 'claude-sdk' ? 'openrouter-claude-sdk-v1' : OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1,
          planner_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
          answer_model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
          timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
          context_tokens: OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1,
          max_output_tokens: OPENROUTER_ANSWER_COMPOSITION_MAX_OUTPUT_TOKENS_V1,
        }),
      });
    },
  });
}
