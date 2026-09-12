import { personLoginGrantExpectedEmailSha256 } from "@echo-brain/organization-authority-kernel/domain/person-email-binding";
import { loadSyntheticDemoMeetingCorpusV1, SyntheticDemoMeetingSourceAdapterV1, syntheticDemoMeetingSourceIdentityV1 } from "./source/synthetic-demo-meeting-source-v1.js";
import type { AdmittedMeetingProcessingAdmissionV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import type { AdmittedMeetingProcessingCommitmentsV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments";
import type { MeetingSourceBundleV1 } from "@echo-brain/organization-processing/ports/meeting-source-bundle-v1";
import { syntheticDemoAdmittedMeetingSourceCursorPolicyV1 } from "./synthetic-demo-admitted-meeting-source-cursor-policy-v1.js";

/**
 * Creates the fixed local-file source selected by the synthetic demo.
 * Loading is deliberately completed before the runtime opens, so its corpus
 * digest can be compared with the immutable source admission.
 */
export async function createSyntheticDemoMeetingSourceBundleV1(input: {
  readonly meetings_directory: string;
  readonly owner_email: string;
}): Promise<MeetingSourceBundleV1> {
  const corpus = await loadSyntheticDemoMeetingCorpusV1(input.meetings_directory);
  const ownerEmailSha256 = personLoginGrantExpectedEmailSha256(input.owner_email);
  let commitmentsChecked = false;

  return Object.freeze({
    create_source(admission: AdmittedMeetingProcessingAdmissionV1) {
      if (!commitmentsChecked) {
        throw new Error("synthetic-demo meeting source commitments were not checked");
      }
      if (
        admission.source.adapter_id !== syntheticDemoMeetingSourceIdentityV1.adapter_id ||
        admission.source.instance_id !== syntheticDemoMeetingSourceIdentityV1.instance_id ||
        admission.source.version !== syntheticDemoMeetingSourceIdentityV1.version
      ) {
        throw new Error("synthetic-demo meeting source differs from the admitted source");
      }
      return new SyntheticDemoMeetingSourceAdapterV1(corpus);
    },
    assert_admission_commitments(
      commitments: AdmittedMeetingProcessingCommitmentsV1,
    ): void {
      if (
        commitments.source.adapter_id !== syntheticDemoMeetingSourceIdentityV1.adapter_id ||
        commitments.source.instance_id !== syntheticDemoMeetingSourceIdentityV1.instance_id ||
        commitments.source.version !== syntheticDemoMeetingSourceIdentityV1.version ||
        commitments.source.custodian_sha256 !== ownerEmailSha256 ||
        commitments.source.credential_reference_sha256 !== corpus.corpus_digest
      ) {
        throw new Error(
          "synthetic-demo meeting source differs from the admitted commitment",
        );
      }
      commitmentsChecked = true;
    },
    source_cursor_policy: syntheticDemoAdmittedMeetingSourceCursorPolicyV1,
  });
}
