import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import type { DecisionProcessorBundleV1 } from "@echo-brain/organization-processing/ports/decision-processor-bundle-v1";
import { createFixedDecisionProcessorBundleV1 } from "./fixed-decision-processor-bundle-v1.js";
import { createOpenRouterDecisionProcessor } from "./llm/openrouter-decision-processor.js";
import { fixedOpenRouterDecisionProcessorConfigV1, OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1, openRouterDecisionProcessorConfigurationSha256V1, openRouterDecisionProcessorCredentialReferenceSha256V1 } from "./openrouter-decision-processor-config-v1.js";

/**
 * Contains the fixed V1 OpenRouter construction path. The shared runtime
 * never reads this credential, selects this provider, or knows its model
 * configuration.
 */
export function createOpenRouterDecisionProcessorBundleV1(input: {
  readonly credential_file: string;
  /** Provider-neutral admission for each extraction call; it does not change processor commitments. */
  readonly limit?: <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
}): DecisionProcessorBundleV1 {
  const credentialReference = `file:${input.credential_file}`;
  return createFixedDecisionProcessorBundleV1({
    label: "OpenRouter",
    version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
    credential_reference_sha256: openRouterDecisionProcessorCredentialReferenceSha256V1(credentialReference),
    config: (instance_id) => fixedOpenRouterDecisionProcessorConfigV1(instance_id, credentialReference),
    processor: (config) => {
      const credential = readPrivateAuthorityCredential(credentialReference);
      return createOpenRouterDecisionProcessor(config, {
        credentialResolver: (reference) => (reference === credentialReference ? credential : undefined),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },
  });
}
