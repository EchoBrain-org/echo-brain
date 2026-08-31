import { llmProcessingVersion } from "../../../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type { AdapterConfig } from "../../../processing/core/contracts/adapter.js";

export const OPENROUTER_DECISION_PROCESSOR_ADAPTER_VERSION_V1 = "1.3.0";
export const OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1 =
  "decision-extraction-v3";
export const OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1 =
  "decision-extraction-schema-v4";
export const OPENROUTER_DECISION_PROCESSOR_PROVIDER_V1 = "openrouter";
export const OPENROUTER_DECISION_PROCESSOR_MODEL_V1 = "deepseek/deepseek-v3.2";
export const OPENROUTER_DECISION_PROCESSOR_MAX_OUTPUT_TOKENS_V1 = 8192;
export const OPENROUTER_DECISION_PROCESSOR_TIMEOUT_MS_V1 = 600_000;

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
      provider: OPENROUTER_DECISION_PROCESSOR_PROVIDER_V1,
      model: OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
      max_output_tokens: OPENROUTER_DECISION_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
      request_timeout_ms: OPENROUTER_DECISION_PROCESSOR_TIMEOUT_MS_V1,
    },
  };
}

/** Exact runtime identity emitted by the fixed OpenRouter adapter configuration. */
export const OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1 =
  llmProcessingVersion(
    fixedOpenRouterDecisionProcessorConfigV1("clean-fixed-llm"),
  );

/** Immutable configuration identity committed at source admission. */
export function openRouterDecisionProcessorConfigurationSha256V1(): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-llm-processor-configuration-v1",
    adapter_id: "llm",
    adapter_version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    prompt_version: OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1,
    extraction_schema_version: OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1,
    provider: OPENROUTER_DECISION_PROCESSOR_PROVIDER_V1,
    model: OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
    max_output_tokens: OPENROUTER_DECISION_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
    request_timeout_ms: OPENROUTER_DECISION_PROCESSOR_TIMEOUT_MS_V1,
  });
}

/** Hashes a reference, never the credential bytes behind it. */
export function openRouterDecisionProcessorCredentialReferenceSha256V1(
  reference: string,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-llm-processor-credential-reference-v1",
    reference,
  });
}

/**
 * Validates fixed processor configuration without resolving the credential
 * reference. The caller may safely do this before touching its private file.
 */
export function assertOpenRouterDecisionProcessorRuntimeCommitmentsV1(input: {
  readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest;
  readonly credential_reference: string;
}): void {
  if (
    input.configuration_sha256 !==
      openRouterDecisionProcessorConfigurationSha256V1() ||
    input.credential_reference_sha256 !==
      openRouterDecisionProcessorCredentialReferenceSha256V1(
        input.credential_reference,
      )
  ) {
    throw new Error(
      "OpenRouter processor configuration differs from the admitted processor commitment",
    );
  }
}
