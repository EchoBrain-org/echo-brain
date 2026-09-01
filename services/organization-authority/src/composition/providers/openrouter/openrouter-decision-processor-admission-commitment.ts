import { readPrivateAuthorityCredential } from "../../../adapters/security/private-file-credentials.js";
import type { DecisionProcessorAdmissionCommitmentV1 } from "../../../processing/admitted-meeting-processing/decision-processor-admission-commitment.js";
import {
  OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  assertOpenRouterDecisionProcessorRuntimeCommitmentsV1,
  openRouterDecisionProcessorConfigurationSha256V1,
  openRouterDecisionProcessorCredentialReferenceSha256V1,
} from "./openrouter-decision-processor-config-v1.js";

/**
 * Current OpenRouter/LLM admission bundle. The Granola admission flow only
 * receives its generic commitment and preflight capability.
 */
export function createOpenRouterDecisionProcessorAdmissionCommitmentV1(input: {
  readonly instance_id: string;
  readonly credential_reference: string;
}): DecisionProcessorAdmissionCommitmentV1 {
  const configurationSha256 = openRouterDecisionProcessorConfigurationSha256V1();
  const credentialReferenceSha256 =
    openRouterDecisionProcessorCredentialReferenceSha256V1(
      input.credential_reference,
    );
  return Object.freeze({
    adapter_id: "llm",
    instance_id: input.instance_id,
    version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: configurationSha256,
    credential_reference_sha256: credentialReferenceSha256,
    preflight(): void {
      // This validates file-reference hygiene and private-file permissions;
      // neither the value nor the reference itself is persisted by admission.
      void readPrivateAuthorityCredential(input.credential_reference);
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        adapter_id: "llm",
        version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: configurationSha256,
        credential_reference_sha256: credentialReferenceSha256,
        credential_reference: input.credential_reference,
      });
    },
  });
}
