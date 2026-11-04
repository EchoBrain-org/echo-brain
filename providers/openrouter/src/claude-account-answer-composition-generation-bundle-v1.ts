import type { AnswerCompositionGenerationBundleV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import { assertClaudeAccountProfileV1, CLAUDE_ACCOUNT_MODEL_V1, type ClaudeAccountProfileV1 } from './claude-research/account-profile.js';
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
          timeout_ms: 60_000,
          // Retain Ask's conservative prompt-size contract when changing payer.
          context_tokens: 131_072,
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
