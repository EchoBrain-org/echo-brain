import type { AdmittedMeetingProcessingAdmissionV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { AdmittedMeetingProcessingCommitmentsV1 } from "../processing/admitted-meeting-processing/admitted-meeting-processing-commitments.js";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "../processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1.js";
import type { AdmittedMeetingProcessingCycleV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";

type MeetingSourceAdapter = ConstructorParameters<
  typeof AdmittedMeetingProcessingCycleV1
>[0]["source"];

/**
 * Provider-neutral construction boundary for the meeting source selected by a
 * source admission. The shared runtime knows only this committed source
 * identity and the canonical meeting-source port.
 */
export interface MeetingSourceBundleV1 {
  /** Creates the one source adapter for the admitted source identity. */
  create_source(admission: AdmittedMeetingProcessingAdmissionV1): MeetingSourceAdapter;
  /**
   * Proves local, provider-owned configuration still matches the immutable
   * admission before the bundle reads any private credential.
   */
  assert_admission_commitments(
    commitments: AdmittedMeetingProcessingCommitmentsV1,
  ): void;
  /** Owns provider cursor and metadata validation. */
  readonly source_cursor_policy: AdmittedMeetingSourceCursorPolicyV1;
}
