import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  OPENROUTER_DECISION_PROCESSOR_ADAPTER_VERSION_V1,
  OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
  OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1,
  OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1,
  assertOpenRouterDecisionProcessorConfigurationCommitmentV1,
  assertOpenRouterDecisionProcessorRuntimeCommitmentsV1,
  fixedOpenRouterDecisionProcessorConfigV1,
  openRouterDecisionProcessorConfigurationSha256V1,
  openRouterDecisionProcessorCredentialReferenceSha256V1,
} from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-config-v1.js";
import {
  LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
  LLM_DECISION_PROCESSOR_PROMPT_VERSION,
  LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
} from "../../../../src/processing/adapters/decision-processors/llm/llm-decision-processor.js";

describe("fixed OpenRouter processor runtime commitments", () => {
  const reference = "file:/private/openrouter-token";

  it("commits the exported LLM adapter, prompt, and schema versions", () => {
    expect(OPENROUTER_DECISION_PROCESSOR_ADAPTER_VERSION_V1).toBe(
      LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
    );
    expect(OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1).toBe(
      LLM_DECISION_PROCESSOR_PROMPT_VERSION,
    );
    expect(OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1).toBe(
      LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
    );
    expect(OPENROUTER_DECISION_PROCESSOR_ADAPTER_VERSION_V1).toBe("1.8.0");
    expect(OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1).toBe(
      "decision-extraction-v8",
    );
    expect(OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1).toBe(
      "decision-extraction-schema-v6",
    );
    expect(OPENROUTER_DECISION_PROCESSOR_MODEL_V1).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(fixedOpenRouterDecisionProcessorConfigV1("fixed").settings).toMatchObject(
      { model: OPENROUTER_DECISION_PROCESSOR_MODEL_V1 },
    );
  });

  it("validates the persisted processor identity without a credential", () => {
    const commitment = {
      adapter_id: "llm",
      version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
      configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
    };
    expect(() =>
      assertOpenRouterDecisionProcessorConfigurationCommitmentV1(commitment),
    ).not.toThrow();
    expect(() =>
      assertOpenRouterDecisionProcessorConfigurationCommitmentV1({
        ...commitment,
        version: "1.3.0+processing.legacy",
      }),
    ).toThrow(/differs from the admitted processor commitment/);
  });

  it("accepts the admission's exact fixed configuration and reference", () => {
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        adapter_id: "llm",
        version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
        credential_reference_sha256:
          openRouterDecisionProcessorCredentialReferenceSha256V1(reference),
        credential_reference: reference,
      }),
    ).not.toThrow();
  });

  it("rejects a changed credential reference or fixed processor configuration without resolving credentials", () => {
    const configuration = openRouterDecisionProcessorConfigurationSha256V1();
    const credential =
      openRouterDecisionProcessorCredentialReferenceSha256V1(reference);
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        adapter_id: "llm",
        version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: configuration,
        credential_reference_sha256: credential,
        credential_reference: "file:/private/replaced-openrouter-token",
      }),
    ).toThrow(/differs from the admitted processor commitment/);
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        adapter_id: "llm",
        version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: canonicalSha256({ changed: "configuration" }),
        credential_reference_sha256: credential,
        credential_reference: reference,
      }),
    ).toThrow(/differs from the admitted processor commitment/);
  });
});
