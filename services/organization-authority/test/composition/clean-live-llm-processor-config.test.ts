import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  assertCleanLlmProcessorRuntimeCommitmentsV1,
  cleanLlmProcessorConfigurationSha256V1,
  cleanLlmProcessorCredentialReferenceSha256V1,
} from "../../src/composition/clean-live-llm-processor-config.js";

describe("fixed clean LLM runtime commitments", () => {
  const reference = "file:/private/openrouter-token";

  it("accepts the admission's exact fixed configuration and reference", () => {
    expect(() =>
      assertCleanLlmProcessorRuntimeCommitmentsV1({
        configuration_sha256: cleanLlmProcessorConfigurationSha256V1(),
        credential_reference_sha256:
          cleanLlmProcessorCredentialReferenceSha256V1(reference),
        credential_reference: reference,
      }),
    ).not.toThrow();
  });

  it("rejects a changed credential reference or fixed processor configuration without resolving credentials", () => {
    const configuration = cleanLlmProcessorConfigurationSha256V1();
    const credential = cleanLlmProcessorCredentialReferenceSha256V1(reference);
    expect(() =>
      assertCleanLlmProcessorRuntimeCommitmentsV1({
        configuration_sha256: configuration,
        credential_reference_sha256: credential,
        credential_reference: "file:/private/replaced-openrouter-token",
      }),
    ).toThrow(/differs from the admitted processor commitment/);
    expect(() =>
      assertCleanLlmProcessorRuntimeCommitmentsV1({
        configuration_sha256: canonicalSha256({ changed: "configuration" }),
        credential_reference_sha256: credential,
        credential_reference: reference,
      }),
    ).toThrow(/differs from the admitted processor commitment/);
  });
});
