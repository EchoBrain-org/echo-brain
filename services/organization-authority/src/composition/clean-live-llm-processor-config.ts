import { llmProcessingVersion } from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";

export const CLEAN_LLM_PROCESSOR_ADAPTER_VERSION_V1 = "1.3.0";
export const CLEAN_LLM_PROCESSOR_PROMPT_VERSION_V1 = "decision-extraction-v3";
export const CLEAN_LLM_PROCESSOR_SCHEMA_VERSION_V1 =
  "decision-extraction-schema-v4";
export const CLEAN_LLM_PROCESSOR_PROVIDER_V1 = "openrouter";
export const CLEAN_LLM_PROCESSOR_MODEL_V1 = "deepseek/deepseek-r1";
export const CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1 = 8192;
export const CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1 = 600_000;

export function fixedCleanLlmProcessorConfigV1(
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
      provider: CLEAN_LLM_PROCESSOR_PROVIDER_V1,
      model: CLEAN_LLM_PROCESSOR_MODEL_V1,
      max_output_tokens: CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
      request_timeout_ms: CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
    },
  };
}

/** Exact runtime identity emitted by the fixed clean LLM adapter configuration. */
export const CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1 = llmProcessingVersion(
  fixedCleanLlmProcessorConfigV1("clean-fixed-llm"),
);

/** Immutable configuration identity committed at live-source admission. */
export function cleanLlmProcessorConfigurationSha256V1(): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-llm-processor-configuration-v1",
    adapter_id: "llm",
    adapter_version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
    prompt_version: CLEAN_LLM_PROCESSOR_PROMPT_VERSION_V1,
    extraction_schema_version: CLEAN_LLM_PROCESSOR_SCHEMA_VERSION_V1,
    provider: CLEAN_LLM_PROCESSOR_PROVIDER_V1,
    model: CLEAN_LLM_PROCESSOR_MODEL_V1,
    max_output_tokens: CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
    request_timeout_ms: CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
  });
}

/** Hashes a reference, never the credential bytes behind it. */
export function cleanLlmProcessorCredentialReferenceSha256V1(
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
export function assertCleanLlmProcessorRuntimeCommitmentsV1(input: {
  readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest;
  readonly credential_reference: string;
}): void {
  if (
    input.configuration_sha256 !== cleanLlmProcessorConfigurationSha256V1() ||
    input.credential_reference_sha256 !==
      cleanLlmProcessorCredentialReferenceSha256V1(
        input.credential_reference,
      )
  ) {
    throw new Error(
      "clean live LLM configuration differs from the admitted processor commitment",
    );
  }
}
