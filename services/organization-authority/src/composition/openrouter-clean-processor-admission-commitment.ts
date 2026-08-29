import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import type { CleanProcessorAdmissionCommitmentV1 } from "../processing/clean-v1/processor-admission-commitment.js";
import {
  CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
  assertCleanLlmProcessorRuntimeCommitmentsV1,
  cleanLlmProcessorConfigurationSha256V1,
  cleanLlmProcessorCredentialReferenceSha256V1,
} from "./clean-live-llm-processor-config.js";

/**
 * Current OpenRouter/LLM admission bundle. The Granola admission flow only
 * receives its generic commitment and preflight capability.
 */
export function createOpenRouterCleanProcessorAdmissionCommitmentV1(input: {
  readonly instance_id: string;
  readonly credential_reference: string;
}): CleanProcessorAdmissionCommitmentV1 {
  const configurationSha256 = cleanLlmProcessorConfigurationSha256V1();
  const credentialReferenceSha256 =
    cleanLlmProcessorCredentialReferenceSha256V1(input.credential_reference);
  return Object.freeze({
    adapter_id: "llm",
    instance_id: input.instance_id,
    version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: configurationSha256,
    credential_reference_sha256: credentialReferenceSha256,
    preflight(): void {
      // This validates file-reference hygiene and private-file permissions;
      // neither the value nor the reference itself is persisted by admission.
      void readPrivateAuthorityCredential(input.credential_reference);
      assertCleanLlmProcessorRuntimeCommitmentsV1({
        configuration_sha256: configurationSha256,
        credential_reference_sha256: credentialReferenceSha256,
        credential_reference: input.credential_reference,
      });
    },
  });
}
