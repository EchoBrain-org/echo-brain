import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { createOpenRouterDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1';
import { createClaudeAccountDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/claude-account-decision-processor-bundle-v1';
import { assertClaudeAccountProfileV1, type ClaudeAccountProfileV1 } from '@echo-brain/provider-openrouter/claude-account-answer-composition-generation-bundle-v1';

/** Setup admissions and running extraction use the same selected processor. */
export function createAuthorityDecisionProcessorV1(input: {
  readonly authority_url: string;
  readonly openrouter_credential_file: string;
  readonly staging_claude_account?: ClaudeAccountProfileV1;
  readonly limit?: <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
}): DecisionProcessorBundleV1 {
  const limiter = input.limit === undefined ? {} : { limit: input.limit };
  if (input.staging_claude_account === undefined) {
    return createOpenRouterDecisionProcessorBundleV1({ credential_file: input.openrouter_credential_file, ...limiter });
  }
  if (input.authority_url !== STAGING_AUTHORITY_ORIGIN_V1) throw new Error('Personal Claude is staging-only');
  assertClaudeAccountProfileV1(input.staging_claude_account);
  return createClaudeAccountDecisionProcessorBundleV1({ account: input.staging_claude_account, ...limiter });
}
