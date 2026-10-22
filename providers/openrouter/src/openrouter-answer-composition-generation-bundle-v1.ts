import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { createOpenRouterStructuredGenerationAdapter } from "./adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import type { AnswerCompositionGenerationBundleV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import { createClaudeResearchDriverV1 } from './claude-research/driver.js';
import { claudeAccountForwarderV1, openRouterClaudeForwarderV1 } from './claude-research/model-transport.js';
import { assertPersonalClaudeResearchV1, type PersonalClaudeResearchV1 } from './claude-research/account-profile.js';
import { createClaudeAccountStructuredGenerationV1 } from './claude-research/structured-generation.js';
export type { PersonalClaudeResearchV1 } from './claude-research/account-profile.js';
export { assertPersonalClaudeResearchV1 } from './claude-research/account-profile.js';

export const OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1 =
  "openrouter" as const;
export const OPENROUTER_ANSWER_COMPOSITION_MODEL_V1 =
  "anthropic/claude-sonnet-5.5" as const;
export const OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1 = 60_000;
/** Kept conservative so changing the model does not expand Ask's prompt-size contract. */
export const OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1 = 131_072;

/**
 * OpenRouter answer-composition adapter bundle. It is the only owner of the
 * private credential read and OpenRouter transport construction.
 */
export function createOpenRouterAnswerCompositionGenerationBundleV1(input: {
  readonly credential_file: string;
  readonly research_engine?: 'claude-sdk';
  readonly personal_claude_research?: PersonalClaudeResearchV1;
}): AnswerCompositionGenerationBundleV1 {
  if (input.personal_claude_research !== undefined) assertPersonalClaudeResearchV1(input.personal_claude_research);
  return Object.freeze({
    load() {
      const credentialReference = `file:${input.credential_file}`;
      return Object.freeze({
        ...(input.personal_claude_research === undefined ? {} : { personal_research: {
          membership_id: input.personal_claude_research.membership_id,
          generation: Object.freeze({ generation_adapter_id: 'claude-account-research-writer-v1',
            planner_model: 'claude-sonnet-5-5', answer_model: 'claude-sonnet-5-5',
            timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1, context_tokens: OPENROUTER_ANSWER_COMPOSITION_CONTEXT_TOKENS_V1 }),
          driver: createClaudeResearchDriverV1({ model: 'claude-sonnet-5-5',
            account: input.personal_claude_research, forward: claudeAccountForwarderV1('claude-sonnet-5-5') }),
          structured_output: createClaudeAccountStructuredGenerationV1({ model: 'claude-sonnet-5-5', account: input.personal_claude_research }),
        } }),
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
        }),
      });
    },
  });
}
