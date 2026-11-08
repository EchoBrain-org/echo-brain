import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { AdapterConfig } from "@echo-brain/organization-processing/core/contracts/adapter";
import { LLM_DECISION_PROCESSOR_PROMPT_VERSION, LLM_DECISION_PROCESSOR_SCHEMA_VERSION } from "@echo-brain/organization-processing/llm/llm-decision-processor";
import { credentialReferenceSha256V1 } from "./fixed-decision-processor-bundle-v1.js";
import { openrouterProcessingVersion } from "./llm/openrouter-decision-processor.js";

export const OPENROUTER_DECISION_PROCESSOR_MODEL_V1 = "anthropic/claude-sonnet-4.6";

export function fixedOpenRouterDecisionProcessorConfigV1(
  instanceId: string,
  credentialReference?: string,
): AdapterConfig {
  return {
    adapter_id: "llm",
    instance_id: instanceId,
    ...(credentialReference === undefined
      ? {}
      : { credential_ref: credentialReference }),
    settings: {
      provider: "openrouter",
      model: OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
      max_output_tokens: 8192,
      request_timeout_ms: 600_000,
    },
  };
}

/** Exact runtime identity emitted by the fixed OpenRouter adapter configuration. */
export const OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1 =
  openrouterProcessingVersion(
    fixedOpenRouterDecisionProcessorConfigV1("clean-fixed-llm"),
  );

/** Immutable configuration identity committed at source admission. */
export function openRouterDecisionProcessorConfigurationSha256V1(): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-llm-processor-configuration-v1",
    adapter_id: "llm",
    adapter_version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    prompt_version: LLM_DECISION_PROCESSOR_PROMPT_VERSION,
    extraction_schema_version: LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
    ...fixedOpenRouterDecisionProcessorConfigV1("clean-fixed-llm").settings,
  });
}

/** Hashes a reference, never the credential bytes behind it. */
export function openRouterDecisionProcessorCredentialReferenceSha256V1(
  reference: string,
): Sha256Digest {
  return credentialReferenceSha256V1("echo-clean-llm-processor-credential-reference-v1", reference);
}
