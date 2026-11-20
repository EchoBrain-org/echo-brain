import type { AnswerCompositionGenerationBundleV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import { assertClaudeAccountProfileV1, CLAUDE_ACCOUNT_MODEL_CONTEXT_TOKENS_V1, CLAUDE_ACCOUNT_MODEL_MAX_OUTPUT_TOKENS_V1, CLAUDE_ACCOUNT_MODEL_V1, type ClaudeAccountProfileV1 } from './claude-research/account-profile.js';
import { createClaudeResearchDriverV1 } from './claude-research/driver.js';
import { claudeAccountForwarderV1 } from './claude-research/model-transport.js';
import { createClaudeAccountStructuredGenerationV1 } from './claude-research/structured-generation.js';
export { assertClaudeAccountProfileV1, type ClaudeAccountProfileV1 } from './claude-research/account-profile.js';

/** Binds the runtime's default research and writing to one native Claude account. */
export function createClaudeAccountAnswerCompositionGenerationBundleV1(input: {
  readonly account: ClaudeAccountProfileV1;
}): AnswerCompositionGenerationBundleV1 {
  assertClaudeAccountProfileV1(input.account);
  return Object.freeze({
    load() {
      return Object.freeze({
        generation: Object.freeze({
          generation_adapter_id: 'claude-account-research-writer-v1',
          planner_model: CLAUDE_ACCOUNT_MODEL_V1,
          answer_model: CLAUDE_ACCOUNT_MODEL_V1,
          // How long one SDK session may receive nothing: each piece of a model reply streamed through the local transport
          // resets it, so a long reply runs as long as it keeps arriving. Research and the writer have no clock of their own.
          timeout_ms: 600_000,
          context_tokens: CLAUDE_ACCOUNT_MODEL_CONTEXT_TOKENS_V1,
          max_output_tokens: CLAUDE_ACCOUNT_MODEL_MAX_OUTPUT_TOKENS_V1,
        }),
        research_driver: createClaudeResearchDriverV1({
          model: CLAUDE_ACCOUNT_MODEL_V1,
          account: input.account,
          forward: claudeAccountForwarderV1(CLAUDE_ACCOUNT_MODEL_V1),
        }),
        structured_output: createClaudeAccountStructuredGenerationV1({
          model: CLAUDE_ACCOUNT_MODEL_V1,
          account: input.account,
        }),
      });
    },
  });
}
