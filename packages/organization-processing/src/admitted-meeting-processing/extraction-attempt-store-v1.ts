import type { AdapterErrorCode } from '../core/contracts/adapter.js';

export const EXTRACTION_ATTEMPT_FAILURE_CODES_V1 = [
  'invalid_config', 'unauthorized', 'rate_limited', 'temporarily_unavailable',
  'permanently_rejected', 'timeout', 'unknown_outcome', 'invalid_output', 'cancelled', 'unknown',
] as const satisfies readonly (AdapterErrorCode | 'invalid_output' | 'cancelled' | 'unknown')[];
export type ExtractionAttemptFailureCodeV1 = typeof EXTRACTION_ATTEMPT_FAILURE_CODES_V1[number];
export type ExtractionAttemptOutcomeV1 = 'pending' | 'succeeded' | 'failed';
export interface ExtractionAttemptBindingV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}
export interface ExtractionAttemptKeyV1 {
  readonly admission_sha256: string;
  readonly review_lineage_id: string;
  readonly review_input_sha256: string;
}
export interface ExtractionAttemptSnapshotV1 {
  readonly attempt: number;
  readonly outcome: ExtractionAttemptOutcomeV1;
  readonly failure_code: ExtractionAttemptFailureCodeV1 | null;
  readonly reserved_at: string;
  readonly completed_at: string | null;
}
export type ExtractionAttemptLatestV1 = ExtractionAttemptKeyV1 & ExtractionAttemptSnapshotV1 & {
  readonly retry_authorized: boolean;
};
export type ExtractionAttemptInspectionV1 = Omit<ExtractionAttemptSnapshotV1, 'completed_at'> & {
  readonly retry_authorized: boolean;
};
export type ExtractionAttemptReservationV1 =
  | { readonly status: 'reserved'; readonly attempt: number; readonly claim_id: string }
  | { readonly status: 'blocked'; readonly attempt: number; readonly outcome: ExtractionAttemptOutcomeV1; readonly failure_code: ExtractionAttemptFailureCodeV1 | null };
export type ExtractionAttemptCompletionV1 = {
  readonly key: ExtractionAttemptKeyV1;
  readonly attempt: number;
  readonly claim_id: string;
} & (
  | { readonly outcome: 'succeeded' }
  | { readonly outcome: 'failed'; readonly failure_code: ExtractionAttemptFailureCodeV1 }
);
export interface ExtractionAttemptStoreV1 {
  /** The reservation commits durably before this method returns. */
  reserve(key: ExtractionAttemptKeyV1): ExtractionAttemptReservationV1;
  complete(input: ExtractionAttemptCompletionV1): void;
  /** Read-only: the latest attempt for one exact key, or undefined before its first reservation. */
  inspect(key: ExtractionAttemptKeyV1): ExtractionAttemptInspectionV1 | undefined;
}
