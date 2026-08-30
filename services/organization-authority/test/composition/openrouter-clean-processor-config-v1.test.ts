import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  assertOpenRouterCleanProcessorRuntimeCommitmentsV1,
  openRouterCleanProcessorConfigurationSha256V1,
  openRouterCleanProcessorCredentialReferenceSha256V1,
} from "../../src/composition/openrouter-clean-processor-config-v1.js";

describe("fixed OpenRouter processor runtime commitments", () => {
  const reference = "file:/private/openrouter-token";

  it("accepts the admission's exact fixed configuration and reference", () => {
    expect(() =>
      assertOpenRouterCleanProcessorRuntimeCommitmentsV1({
        configuration_sha256: openRouterCleanProcessorConfigurationSha256V1(),
        credential_reference_sha256:
          openRouterCleanProcessorCredentialReferenceSha256V1(reference),
        credential_reference: reference,
      }),
    ).not.toThrow();
  });

  it("rejects a changed credential reference or fixed processor configuration without resolving credentials", () => {
    const configuration = openRouterCleanProcessorConfigurationSha256V1();
    const credential =
      openRouterCleanProcessorCredentialReferenceSha256V1(reference);
    expect(() =>
      assertOpenRouterCleanProcessorRuntimeCommitmentsV1({
        configuration_sha256: configuration,
        credential_reference_sha256: credential,
        credential_reference: "file:/private/replaced-openrouter-token",
      }),
    ).toThrow(/differs from the admitted processor commitment/);
    expect(() =>
      assertOpenRouterCleanProcessorRuntimeCommitmentsV1({
        configuration_sha256: canonicalSha256({ changed: "configuration" }),
        credential_reference_sha256: credential,
        credential_reference: reference,
      }),
    ).toThrow(/differs from the admitted processor commitment/);
  });
});
