import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { OPENROUTER_DECISION_PROCESSOR_MODEL_V1, OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1, OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1, OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1, assertOpenRouterDecisionProcessorConfigurationCommitmentV1, assertOpenRouterDecisionProcessorRuntimeCommitmentsV1, fixedOpenRouterDecisionProcessorConfigV1, openRouterDecisionProcessorConfigurationSha256V1, openRouterDecisionProcessorCredentialReferenceSha256V1 } from "../src/openrouter-decision-processor-config-v1.js";
import {
  LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
  LLM_DECISION_PROCESSOR_PROMPT_VERSION,
  LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
} from "@echo-brain/organization-processing/llm/llm-decision-processor";

describe("fixed OpenRouter processor runtime commitments", () => {
  const reference = "file:/private/openrouter-token";
  const runtime = (
    overrides: Partial<Parameters<typeof assertOpenRouterDecisionProcessorRuntimeCommitmentsV1>[0]> = {},
  ) => ({
    adapter_id: "llm",
    version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
    credential_reference_sha256:
      openRouterDecisionProcessorCredentialReferenceSha256V1(reference),
    credential_reference: reference,
    ...overrides,
  });

  it("commits the exported LLM adapter, prompt, and schema versions", () => {
    expect(OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1).toBe(
      LLM_DECISION_PROCESSOR_PROMPT_VERSION,
    );
    expect(OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1).toBe(
      LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
    );
    expect(LLM_DECISION_PROCESSOR_ADAPTER_VERSION).toBe("2.0.0");
    expect(OPENROUTER_DECISION_PROCESSOR_PROMPT_VERSION_V1).toBe(
      "decision-extraction-v11",
    );
    expect(OPENROUTER_DECISION_PROCESSOR_SCHEMA_VERSION_V1).toBe(
      "decision-extraction-schema-v8",
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
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1(runtime()),
    ).not.toThrow();
  });

  it("rejects a changed credential reference or fixed processor configuration without resolving credentials", () => {
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1(
        runtime({ credential_reference: "file:/private/replaced-openrouter-token" }),
      ),
    ).toThrow(/differs from the admitted processor commitment/);
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1(
        runtime({ configuration_sha256: canonicalSha256({ changed: "configuration" }) }),
      ),
    ).toThrow(/differs from the admitted processor commitment/);
  });
});
