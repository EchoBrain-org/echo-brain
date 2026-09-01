import { readPrivateAuthorityCredential } from "../../../adapters/security/private-file-credentials.js";
import {
  createLlmDecisionProcessor,
  llmProcessingVersion,
} from "../../../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import type { AdapterConfig } from "../../../processing/core/contracts/adapter.js";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../../../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { AdmittedMeetingProcessingCommitmentsV1 } from "../../../processing/admitted-meeting-processing/admitted-meeting-processing-commitments.js";
import {
  assertOpenRouterDecisionProcessorRuntimeCommitmentsV1,
  fixedOpenRouterDecisionProcessorConfigV1,
} from "./openrouter-decision-processor-config-v1.js";
import type { DecisionProcessorBundleV1 } from "../../decision-processor-bundle-v1.js";

function assertProcessorConfig(
  adapter: {
    validateConfig(config: AdapterConfig): {
      ok: boolean;
      errors: readonly string[];
    };
  },
  config: AdapterConfig,
): void {
  const validation = adapter.validateConfig(config);
  if (!validation.ok) {
    throw new Error(
      `OpenRouter decision-processor configuration is invalid: ${validation.errors.join("; ")}`,
    );
  }
}

/**
 * Contains the fixed V1 OpenRouter construction path. The shared runtime
 * never reads this credential, selects this provider, or knows its model
 * configuration.
 */
export function createOpenRouterDecisionProcessorBundleV1(input: {
  readonly credential_file: string;
}): DecisionProcessorBundleV1 {
  const credentialReference = `file:${input.credential_file}`;
  let commitmentsChecked = false;
  return Object.freeze({
    processor_adapter_id: "llm",
    assert_admission_commitments(
      commitments: AdmittedMeetingProcessingCommitmentsV1,
    ): void {
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        adapter_id: commitments.processor.adapter_id,
        version: commitments.processor.version,
        configuration_sha256: commitments.processor.configuration_sha256,
        credential_reference_sha256:
          commitments.processor.credential_reference_sha256,
        credential_reference: credentialReference,
      });
      commitmentsChecked = true;
    },
    create_processor(admission: AdmittedMeetingProcessingAdmissionV1) {
      if (!commitmentsChecked) {
        throw new Error(
          "OpenRouter decision-processor admission commitments were not checked",
        );
      }
      if (admission.processor.adapter_id !== "llm") {
        throw new Error(
          "OpenRouter decision-processor differs from the admitted processor",
        );
      }
      const config = fixedOpenRouterDecisionProcessorConfigV1(
        admission.processor.instance_id,
        credentialReference,
      );
      const credential = readPrivateAuthorityCredential(credentialReference);
      const processor = createLlmDecisionProcessor(config, {
        credentialResolver: (reference) =>
          reference === credentialReference ? credential : undefined,
      });
      assertProcessorConfig(processor, config);
      if (
        processor.identity.adapter_id !== admission.processor.adapter_id ||
        processor.identity.instance_id !== admission.processor.instance_id ||
        processor.identity.version !== admission.processor.version ||
        llmProcessingVersion(config) !== admission.processor.version
      ) {
        throw new Error(
          "OpenRouter decision-processor differs from the admitted processor",
        );
      }
      return processor;
    },
  });
}
