import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import {
  createLlmDecisionProcessor,
  llmProcessingVersion,
} from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import type { CleanLiveSourceAdmissionV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceRuntimeCommitmentsV1 } from "../processing/clean-v1/live-source-runtime-commitments.js";
import {
  assertCleanLlmProcessorRuntimeCommitmentsV1,
  fixedCleanLlmProcessorConfigV1,
} from "./clean-live-llm-processor-config.js";
import type { CleanLiveProcessorRuntimeBundleV1 } from "./clean-live-processor-runtime.js";

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
export function createOpenRouterCleanLiveProcessorRuntimeBundleV1(input: {
  readonly credential_file: string;
}): CleanLiveProcessorRuntimeBundleV1 {
  const credentialReference = `file:${input.credential_file}`;
  let commitmentsChecked = false;
  return Object.freeze({
    processor_adapter_id: "llm",
    assert_runtime_commitments(
      commitments: CleanLiveSourceRuntimeCommitmentsV1,
    ): void {
      if (commitments.processor.adapter_id !== "llm") {
        throw new Error(
          "OpenRouter decision-processor adapter differs from the admitted commitment",
        );
      }
      assertCleanLlmProcessorRuntimeCommitmentsV1({
        configuration_sha256: commitments.processor.configuration_sha256,
        credential_reference_sha256:
          commitments.processor.credential_reference_sha256,
        credential_reference: credentialReference,
      });
      commitmentsChecked = true;
    },
    create_processor(admission: CleanLiveSourceAdmissionV1) {
      if (!commitmentsChecked) {
        throw new Error(
          "OpenRouter decision-processor runtime commitments were not checked",
        );
      }
      if (admission.processor.adapter_id !== "llm") {
        throw new Error(
          "OpenRouter decision-processor differs from the admitted processor",
        );
      }
      const config = fixedCleanLlmProcessorConfigV1(
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
