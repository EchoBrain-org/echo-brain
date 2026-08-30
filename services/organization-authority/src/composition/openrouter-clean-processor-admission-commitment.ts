import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import type { CleanProcessorAdmissionCommitmentV1 } from "../processing/clean-v1/processor-admission-commitment.js";
import {
  OPENROUTER_CLEAN_PROCESSOR_RUNTIME_VERSION_V1,
  assertOpenRouterCleanProcessorRuntimeCommitmentsV1,
  openRouterCleanProcessorConfigurationSha256V1,
  openRouterCleanProcessorCredentialReferenceSha256V1,
} from "./openrouter-clean-processor-config-v1.js";

/**
 * Current OpenRouter/LLM admission bundle. The Granola admission flow only
 * receives its generic commitment and preflight capability.
 */
export function createOpenRouterCleanProcessorAdmissionCommitmentV1(input: {
  readonly instance_id: string;
  readonly credential_reference: string;
}): CleanProcessorAdmissionCommitmentV1 {
  const configurationSha256 = openRouterCleanProcessorConfigurationSha256V1();
  const credentialReferenceSha256 =
    openRouterCleanProcessorCredentialReferenceSha256V1(
      input.credential_reference,
    );
  return Object.freeze({
    adapter_id: "llm",
    instance_id: input.instance_id,
    version: OPENROUTER_CLEAN_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: configurationSha256,
    credential_reference_sha256: credentialReferenceSha256,
    preflight(): void {
      // This validates file-reference hygiene and private-file permissions;
      // neither the value nor the reference itself is persisted by admission.
      void readPrivateAuthorityCredential(input.credential_reference);
      assertOpenRouterCleanProcessorRuntimeCommitmentsV1({
        configuration_sha256: configurationSha256,
        credential_reference_sha256: credentialReferenceSha256,
        credential_reference: input.credential_reference,
      });
    },
  });
}
