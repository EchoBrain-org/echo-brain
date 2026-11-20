import { describe, expect, it } from "vitest";
import { LLM_DECISION_PROCESSOR_ADAPTER_VERSION, LLM_DECISION_PROCESSOR_PROMPT_VERSION, LLM_DECISION_PROCESSOR_SCHEMA_VERSION } from "@echo-brain/organization-processing/llm/llm-decision-processor";
import { createClaudeAccountDecisionProcessorBundleV1 } from "../src/claude-account-decision-processor-bundle-v1.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "../src/openrouter-decision-processor-bundle-v1.js";
import { fixedOpenRouterDecisionProcessorConfigV1, OPENROUTER_DECISION_PROCESSOR_MODEL_V1 } from "../src/openrouter-decision-processor-config-v1.js";
import { fixedClaudeAccountDecisionProcessorConfigV1 } from "../src/claude-account-decision-processor-config-v1.js";

const source = { adapter_id: "synthetic-source", instance_id: "synthetic-source", version: "1.0.0",
  custodian_sha256: `sha256:${"a".repeat(64)}`, credential_reference_sha256: `sha256:${"b".repeat(64)}` } as const;
const payers = [
  ["OpenRouter", createOpenRouterDecisionProcessorBundleV1({ credential_file: "/private/openrouter-token" })],
  ["Claude account", createClaudeAccountDecisionProcessorBundleV1({ account: { home_directory: "/synthetic/owner", executable_path: "/synthetic/claude" } })],
] as const;

describe("fixed decision-processor commitments", () => {
  // Every source admission stores these. A change must be deliberate: it re-admits every source.
  it("commits each payer's exact processor version, configuration and credential reference", () => {
    expect([LLM_DECISION_PROCESSOR_ADAPTER_VERSION, LLM_DECISION_PROCESSOR_PROMPT_VERSION, LLM_DECISION_PROCESSOR_SCHEMA_VERSION, OPENROUTER_DECISION_PROCESSOR_MODEL_V1])
      .toEqual(["2.2.0", "decision-extraction-v13", "decision-extraction-schema-v8", "anthropic/claude-sonnet-4.6"]);
    expect(fixedOpenRouterDecisionProcessorConfigV1("fixed-processor").settings.max_output_tokens).toBe(64_000);
    expect(fixedClaudeAccountDecisionProcessorConfigV1("fixed-processor").settings.max_output_tokens).toBe(64_000);
    expect(payers.map(([, bundle]) => bundle.current_commitments("fixed-processor"))).toEqual([
      { adapter_id: "llm", instance_id: "fixed-processor", version: "2.2.0+processing.baf8d93eb136d567",
        configuration_sha256: "sha256:237e992b7ecc3983e0804253ef9c27f9c1a1a9e20ccd031a525fefc36c81eb66",
        credential_reference_sha256: "sha256:fee20b471db316d5878cf953f357c235be482bc104afcb4729a826584c72830e" },
      { adapter_id: "llm", instance_id: "fixed-processor", version: "2.2.0+processing.30743af1c6d8630f",
        configuration_sha256: "sha256:4f96dbc36a8d9ac600463421f330017c593e3e793a8121af8394352ccfb5bbfb",
        credential_reference_sha256: "sha256:e4902f78de5f9820e38d0c63a3e478dd7165ffb62a534a1010cf445e9f181c01" },
    ]);
  });

  it.each(payers)("refuses %s commitments that differ from its fixed ones, without reading a credential", (label, bundle) => {
    const processor = bundle.current_commitments("fixed-processor");
    for (const changed of [{ adapter_id: "other" }, { version: "1.3.0+processing.legacy" }, { configuration_sha256: `sha256:${"c".repeat(64)}` },
      { credential_reference_sha256: `sha256:${"d".repeat(64)}` }] as const) {
      expect(() => bundle.assert_admission_commitments({ source, processor: { ...processor, ...changed } }))
        .toThrow(`${label} processor configuration differs from the admitted processor commitment`);
    }
    expect(() => bundle.assert_admission_commitments({ source, processor })).not.toThrow();
  });
});
