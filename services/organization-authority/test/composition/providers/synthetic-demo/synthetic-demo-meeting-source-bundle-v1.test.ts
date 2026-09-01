import { fileURLToPath } from "node:url";
import { personLoginGrantExpectedEmailSha256 } from "../../../../src/domain/person-email-binding.js";
import { describe, expect, it } from "vitest";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../../../../src/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  createSyntheticDemoMeetingSourceBundleV1,
} from "../../../../src/composition/providers/synthetic-demo/synthetic-demo-meeting-source-bundle-v1.js";
import {
  SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
  loadSyntheticDemoMeetingCorpusV1,
  syntheticDemoMeetingSourceIdentityV1,
} from "../../../../src/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";
import { syntheticDemoAdmittedMeetingSourceCursorPolicyV1 } from "../../../../src/composition/providers/synthetic-demo/synthetic-demo-admitted-meeting-source-cursor-policy-v1.js";

const meetingsDirectory = fileURLToPath(
  new URL("../../../../../../demo/meetings/", import.meta.url),
);
const ownerEmail = "owner@example.test";

function admission(): AdmittedMeetingProcessingAdmissionV1 {
  return {
    source: {
      ...syntheticDemoMeetingSourceIdentityV1,
      cursor: SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
      cutoff_at: "2026-08-30T00:00:00.000Z",
    },
    processor: {
      adapter_id: "test-processor",
      instance_id: "test-processor",
      version: "1.0.0",
      configuration_sha256: `sha256:${"a".repeat(64)}`,
    },
  };
}

async function commitments() {
  const corpus = await loadSyntheticDemoMeetingCorpusV1(meetingsDirectory);
  return {
    source: {
      ...syntheticDemoMeetingSourceIdentityV1,
      custodian_sha256: personLoginGrantExpectedEmailSha256(ownerEmail),
      credential_reference_sha256: corpus.corpus_digest,
    },
    processor: {
      adapter_id: "test-processor",
      instance_id: "test-processor",
      version: "1.0.0",
      configuration_sha256: `sha256:${"c".repeat(64)}`,
      credential_reference_sha256: `sha256:${"d".repeat(64)}`,
    },
  } as const;
}

describe("synthetic-demo meeting source bundle", () => {
  it("accepts only the fixed source cursor offsets", () => {
    for (const offset of [0, 1, 2, 3, 4]) {
      expect(() =>
        syntheticDemoAdmittedMeetingSourceCursorPolicyV1.assert_live_cursor(
          `synthetic-demo-source:customer-demo:1.0.0:v1:${offset}`,
        ),
      ).not.toThrow();
    }
    expect(() =>
      syntheticDemoAdmittedMeetingSourceCursorPolicyV1.assert_live_cursor(
        "synthetic-demo-source:customer-demo:1.0.0:v1:5",
      ),
    ).toThrow(/synthetic-demo/i);
    expect(() =>
      syntheticDemoAdmittedMeetingSourceCursorPolicyV1.assert_live_cursor(
        "synthetic-demo-source:customer-demo:1.0.0:v1:01",
      ),
    ).toThrow(/synthetic-demo/i);
    expect(() =>
      syntheticDemoAdmittedMeetingSourceCursorPolicyV1.assert_live_cursor(
        "other-source:customer-demo:1.0.0:v1:0",
      ),
    ).toThrow(/synthetic-demo/i);
  });

  it("requires the corpus digest commitment before creating the admitted source", async () => {
    const bundle = await createSyntheticDemoMeetingSourceBundleV1({
      meetings_directory: meetingsDirectory,
      owner_email: ownerEmail,
    });
    const committed = await commitments();

    expect(() => bundle.create_source(admission())).toThrow(
      "commitments were not checked",
    );
    expect(() => bundle.assert_admission_commitments(committed)).not.toThrow();
    expect(bundle.create_source(admission()).identity).toEqual(
      syntheticDemoMeetingSourceIdentityV1,
    );
  });

  it("rejects an admitted source identity or corpus digest mismatch", async () => {
    const bundle = await createSyntheticDemoMeetingSourceBundleV1({
      meetings_directory: meetingsDirectory,
      owner_email: ownerEmail,
    });
    const committed = await commitments();

    expect(() =>
      bundle.assert_admission_commitments({
        ...committed,
        source: {
          ...committed.source,
          credential_reference_sha256: `sha256:${"e".repeat(64)}`,
        },
      }),
    ).toThrow("differs from the admitted commitment");
    expect(() =>
      bundle.assert_admission_commitments({
        ...committed,
        source: { ...committed.source, instance_id: "other-demo" },
      }),
    ).toThrow("differs from the admitted commitment");
  });
});
