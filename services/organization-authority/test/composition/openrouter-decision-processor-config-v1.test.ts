import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  assertOpenRouterDecisionProcessorRuntimeCommitmentsV1,
  openRouterDecisionProcessorConfigurationSha256V1,
  openRouterDecisionProcessorCredentialReferenceSha256V1,
} from "../../src/composition/openrouter-decision-processor-config-v1.js";

describe("fixed OpenRouter processor runtime commitments", () => {
  const reference = "file:/private/openrouter-token";

  it("accepts the admission's exact fixed configuration and reference", () => {
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
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
        configuration_sha256: configuration,
        credential_reference_sha256: credential,
        credential_reference: "file:/private/replaced-openrouter-token",
      }),
    ).toThrow(/differs from the admitted processor commitment/);
    expect(() =>
      assertOpenRouterDecisionProcessorRuntimeCommitmentsV1({
        configuration_sha256: canonicalSha256({ changed: "configuration" }),
        credential_reference_sha256: credential,
        credential_reference: reference,
      }),
    ).toThrow(/differs from the admitted processor commitment/);
  });
});
