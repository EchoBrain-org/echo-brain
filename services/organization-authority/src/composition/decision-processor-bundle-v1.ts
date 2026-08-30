import type { DecisionProcessorAdapter } from "../processing/core/ports/adapters.js";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { AdmittedMeetingProcessingCommitmentsV1 } from "../processing/admitted-meeting-processing/admitted-meeting-processing-commitments.js";

/**
 * Provider-neutral construction boundary for the decision processor selected
 * by a live-source admission. The shared runtime knows only this committed
 * adapter identity and the canonical decision-processor port.
 */
export interface DecisionProcessorBundleV1 {
  /** The only decision-processor adapter identity this bundle can construct. */
  readonly processor_adapter_id: string;
  /**
   * Proves local, provider-owned configuration still matches the immutable
   * admission before the bundle reads any private credential.
   */
  assert_admission_commitments(
    commitments: AdmittedMeetingProcessingCommitmentsV1,
  ): void;
  /** Creates and validates the admitted decision processor. */
  create_processor(
    admission: AdmittedMeetingProcessingAdmissionV1,
  ): DecisionProcessorAdapter;
}
