import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import type { AdapterConfig } from '@echo-brain/organization-processing/core/contracts/adapter';
import { llmProcessingVersion, LLM_DECISION_PROCESSOR_PROMPT_VERSION, LLM_DECISION_PROCESSOR_SCHEMA_VERSION } from '@echo-brain/organization-processing/llm/llm-decision-processor';
import { assertClaudeAccountProfileV1, CLAUDE_ACCOUNT_MODEL_V1, type ClaudeAccountProfileV1 } from './claude-research/account-profile.js';

export const CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1 = 'claude-account';
export const CLAUDE_ACCOUNT_DECISION_PROCESSOR_TRANSPORT_V1 = 'claude-account-sdk-single-generation-v1';
export const CLAUDE_ACCOUNT_DECISION_PROCESSOR_MAX_OUTPUT_TOKENS_V1 = 8192;
export const CLAUDE_ACCOUNT_DECISION_PROCESSOR_TIMEOUT_MS_V1 = 600_000;

/** Only operator-selected paths identify the account. Native Claude alone reads the sign-in. */
export function claudeAccountDecisionProcessorCredentialReferenceV1(account: ClaudeAccountProfileV1): string {
  assertClaudeAccountProfileV1(account);
  return `claude-account:${JSON.stringify({ home_directory: account.home_directory, executable_path: account.executable_path })}`;
}

export function fixedClaudeAccountDecisionProcessorConfigV1(instanceId: string, credentialReference?: string): AdapterConfig {
  return {
    adapter_id: 'llm', instance_id: instanceId,
    ...(credentialReference === undefined ? {} : { credential_ref: credentialReference }),
    settings: { provider: CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1, model: CLAUDE_ACCOUNT_MODEL_V1,
      max_output_tokens: CLAUDE_ACCOUNT_DECISION_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
      request_timeout_ms: CLAUDE_ACCOUNT_DECISION_PROCESSOR_TIMEOUT_MS_V1 },
  };
}

export const CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1 = llmProcessingVersion(
  fixedClaudeAccountDecisionProcessorConfigV1('clean-fixed-llm'), CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1, CLAUDE_ACCOUNT_DECISION_PROCESSOR_TRANSPORT_V1,
);

export function claudeAccountDecisionProcessorConfigurationSha256V1(): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind: 'echo-claude-account-processor-configuration-v1', adapter_id: 'llm',
    adapter_version: CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    prompt_version: LLM_DECISION_PROCESSOR_PROMPT_VERSION, extraction_schema_version: LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
    ...fixedClaudeAccountDecisionProcessorConfigV1('clean-fixed-llm').settings,
    transport: CLAUDE_ACCOUNT_DECISION_PROCESSOR_TRANSPORT_V1, max_model_requests: 1,
  });
}

/** Hashes the non-secret reference, never native credential bytes. */
export function claudeAccountDecisionProcessorCredentialReferenceSha256V1(reference: string): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind: 'echo-claude-account-processor-credential-reference-v1', reference });
}

export function assertClaudeAccountDecisionProcessorRuntimeCommitmentsV1(input: {
  readonly adapter_id: string; readonly version: string; readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest; readonly credential_reference: string;
}): void {
  if (input.adapter_id !== 'llm' || input.version !== CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1 ||
      input.configuration_sha256 !== claudeAccountDecisionProcessorConfigurationSha256V1() ||
      input.credential_reference_sha256 !== claudeAccountDecisionProcessorCredentialReferenceSha256V1(input.credential_reference)) {
    throw new Error('Claude account processor configuration differs from the admitted processor commitment');
  }
}
