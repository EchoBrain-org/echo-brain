import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../../../../src/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  openRouterDecisionProcessorConfigurationSha256V1,
  openRouterDecisionProcessorCredentialReferenceSha256V1,
} from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-config-v1.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-bundle-v1.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function credentialFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-openrouter-runtime-"));
  directories.push(directory);
  const path = join(directory, "credential");
  writeFileSync(path, "a".repeat(32), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function admission(): AdmittedMeetingProcessingAdmissionV1 {
  return {
    source: {
      adapter_id: "synthetic-source",
      instance_id: "synthetic-source",
      version: "1.0.0",
      cursor: "opaque-cursor",
      cutoff_at: "2026-08-29T00:00:00.000Z",
    },
    processor: {
      adapter_id: "llm",
      instance_id: "fixed-processor",
      version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
      configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
    },
  };
}

describe("OpenRouter decision processor bundle", () => {
  it("validates the immutable commitment before reading its credential and constructs the admitted processor", () => {
    const credential_file = credentialFile();
    const bundle = createOpenRouterDecisionProcessorBundleV1({
      credential_file,
    });
    const commitment = {
      source: {
        adapter_id: "synthetic-source",
        instance_id: "synthetic-source",
        version: "1.0.0",
        custodian_sha256: `sha256:${"a".repeat(64)}`,
        credential_reference_sha256: `sha256:${"b".repeat(64)}`,
      },
      processor: {
        adapter_id: "llm",
        instance_id: "fixed-processor",
        version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
        configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
        credential_reference_sha256:
          openRouterDecisionProcessorCredentialReferenceSha256V1(
            `file:${credential_file}`,
          ),
      },
    } as const;

    expect(bundle.processor_adapter_id).toBe("llm");
    expect(() => bundle.create_processor(admission())).toThrow(
      "admission commitments were not checked",
    );
    expect(() => bundle.assert_admission_commitments(commitment)).not.toThrow();
    expect(bundle.create_processor(admission()).identity).toMatchObject({
      kind: "decision-processor",
      adapter_id: "llm",
      instance_id: "fixed-processor",
      version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
    });
  });

  it("rejects an uncommitted processor credential reference before it reads the credential", () => {
    const credential_file = credentialFile();
    const bundle = createOpenRouterDecisionProcessorBundleV1({
      credential_file,
    });

    expect(() =>
      bundle.assert_admission_commitments({
        source: {
          adapter_id: "synthetic-source",
          instance_id: "synthetic-source",
          version: "1.0.0",
          custodian_sha256: `sha256:${"a".repeat(64)}`,
          credential_reference_sha256: `sha256:${"b".repeat(64)}`,
        },
        processor: {
          adapter_id: "llm",
          instance_id: "fixed-processor",
          version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
          configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1(),
          credential_reference_sha256:
            openRouterDecisionProcessorCredentialReferenceSha256V1(
              "file:/private/replaced-credential",
            ),
        },
      }),
    ).toThrow("differs from the admitted processor commitment");
  });
});
