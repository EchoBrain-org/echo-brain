import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import { assertClaudeAccountProfileV1, claudeAccountEnvironmentV1, type ClaudeAccountProfileV1 } from './claude-research/account-profile.js';
import { createFixedDecisionProcessorBundleV1 } from './fixed-decision-processor-bundle-v1.js';
import { createClaudeAccountDecisionProcessorV1 } from './llm/claude-account-decision-processor.js';
import { claudeAccountDecisionProcessorConfigurationSha256V1, claudeAccountDecisionProcessorCredentialReferenceV1,
  claudeAccountDecisionProcessorCredentialReferenceSha256V1, CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  fixedClaudeAccountDecisionProcessorConfigV1 } from './claude-account-decision-processor-config-v1.js';

/** Native auth status only: no model call, credential read, or credential transfer. */
export async function preflightClaudeAccountDecisionProcessorV1(account: ClaudeAccountProfileV1): Promise<void> {
  assertClaudeAccountProfileV1(account);
  await claudeAccountEnvironmentV1(account, new AbortController().signal);
}

/** Native authentication stays inside Claude; source admissions bind only its selected non-secret profile. */
export function createClaudeAccountDecisionProcessorBundleV1(input: {
  readonly account: ClaudeAccountProfileV1;
  readonly limit?: <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
}): DecisionProcessorBundleV1 {
  const account = Object.freeze({ home_directory: input.account.home_directory, executable_path: input.account.executable_path });
  const reference = claudeAccountDecisionProcessorCredentialReferenceV1(account);
  return createFixedDecisionProcessorBundleV1({
    label: 'Claude account',
    invalid_processor: 'Claude account decision-processor configuration is invalid',
    version: CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: claudeAccountDecisionProcessorConfigurationSha256V1(),
    credential_reference_sha256: claudeAccountDecisionProcessorCredentialReferenceSha256V1(reference),
    config: instance_id => fixedClaudeAccountDecisionProcessorConfigV1(instance_id, reference),
    processor: config => createClaudeAccountDecisionProcessorV1(config, { account, ...(input.limit === undefined ? {} : { limit: input.limit }) }),
  });
}
