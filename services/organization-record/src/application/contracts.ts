import type { JsonObject, JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';

/**
 * Local structural contracts for the organization record core.
 *
 * These are the *minimum* shapes this module reads. They are deliberately not
 * a second copy of the durable wire contract: `packages/organization-protocol`
 * owns the two envelope types, the receipt, and their validators, and the
 * adapter documented in `README.md` maps its exported types onto these views.
 * Every type here is structural, so a protocol-package type that carries more
 * fields is assignable without an import edge from this workspace to it.
 */

export const ORGANIZATION_RECORD_FRAME_KIND = 'echo-organization-record-frame' as const;
export const ORGANIZATION_RECORD_RECEIPT_KIND =
  'echo-organization-record-receipt' as const;
export const ORGANIZATION_RECORD_SCHEMA_VERSION = 1 as const;

export type OrganizationRecordEventTypeV1 = 'approval' | 'rejection';

/**
 * The result of the authority verification port: an envelope whose lease,
 * installation signature, schema, and authorization evidence the authority
 * application has already checked. `envelope` is the exact validated value;
 * its RFC 8785 canonical bytes are what the log stores and hashes.
 */
export interface VerifiedOrganizationRecordEnvelope {
  readonly envelope: JsonObject;
  readonly envelope_id: string;
  readonly event_type: OrganizationRecordEventTypeV1;
  readonly idempotency_key: string;
  readonly installation_id: string;
}

/** The versioned record frame. `record_hash` is sha256 over its canonical bytes. */
export interface OrganizationRecordFrameV1 {
  readonly schema_version: typeof ORGANIZATION_RECORD_SCHEMA_VERSION;
  readonly kind: typeof ORGANIZATION_RECORD_FRAME_KIND;
  readonly organization_id: string;
  readonly position: number;
  readonly previous_record_hash: Sha256Digest | null;
  readonly recorded_at: string;
  readonly envelope_sha256: Sha256Digest;
}

/**
 * The deterministic receipt payload committed with the log row. The signing
 * port turns exactly this value into the signed document members hold; the
 * `kind` and `schema_version` fields give it domain separation under the
 * shared `signed-document` primitive.
 */
export interface OrganizationRecordReceiptPayloadV1 {
  readonly schema_version: typeof ORGANIZATION_RECORD_SCHEMA_VERSION;
  readonly kind: typeof ORGANIZATION_RECORD_RECEIPT_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly installation_id: string;
  readonly idempotency_key: string;
  readonly position: number;
  readonly record_hash: Sha256Digest;
  readonly recorded_at: string;
}

/** One committed log row, exactly as stored. */
export interface OrganizationRecordLogRow {
  readonly position: number;
  readonly envelope_id: string;
  readonly event_type: OrganizationRecordEventTypeV1;
  readonly installation_id: string;
  readonly idempotency_key: string;
  readonly canonical_envelope: string;
  readonly envelope_sha256: Sha256Digest;
  readonly receipt_payload: string;
  readonly previous_record_hash: Sha256Digest | null;
  readonly record_hash: Sha256Digest;
  readonly recorded_at: string;
}

export interface OrganizationRecordAppendResult {
  readonly outcome: 'appended' | 'duplicate';
  readonly position: number;
  readonly envelope_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly record_hash: Sha256Digest;
  readonly recorded_at: string;
  readonly receipt_payload: OrganizationRecordReceiptPayloadV1;
  /** The signed receipt document produced by the receipt signing port. */
  readonly signed_receipt: JsonObject;
}

export type OrganizationRecordChainFailureKind =
  | 'position_gap'
  | 'predecessor_mismatch'
  | 'record_hash_mismatch'
  | 'envelope_digest_mismatch'
  | 'envelope_not_canonical'
  | 'receipt_payload_mismatch';

export interface OrganizationRecordChainFailure {
  readonly position: number;
  readonly kind: OrganizationRecordChainFailureKind;
  readonly detail: string;
}

/**
 * The result of walking the internal chain.
 *
 * Walking detects mutation, reordering, and deletion inside the surviving
 * chain. It cannot detect a valid-prefix tail truncation or a database
 * rollback: those look exactly like a shorter honest log from the inside.
 * `tail_truncation_detectable` states that boundary in the value itself.
 * Comparing against an external checkpoint is deferred beyond v1.
 */
export interface OrganizationRecordChainVerification {
  readonly organization_id: string;
  readonly head_position: number | null;
  readonly head_record_hash: Sha256Digest | null;
  readonly records_verified: number;
  readonly failures: readonly OrganizationRecordChainFailure[];
  readonly tail_truncation_detectable: false;
}

export interface DerivedAtomRow {
  readonly atom_id: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly approval_group: Sha256Digest;
  readonly signal_id: string;
  readonly kind: 'decision' | 'action' | 'rationale';
  readonly text: string;
  readonly subject: string | null;
  readonly status: string | null;
  readonly owner: string | null;
  readonly due_at: string | null;
  readonly confidence: number | null;
  readonly evidence: string;
  readonly restricted: 0 | 1;
  readonly reviewer_principal_id: string;
  readonly reviewer_display_name: string | null;
  readonly reviewed_at: string;
}

export interface DerivedMeetingSnapshotRow {
  readonly snapshot_id: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly meeting_id: string;
  readonly meeting_revision: string;
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
  readonly source_external_id: string;
  readonly title: string | null;
  readonly meeting_time: string | null;
}

export interface DerivedParticipantObservationRow {
  readonly observation_id: Sha256Digest;
  readonly snapshot_id: Sha256Digest;
  readonly participant_id: string;
  readonly display_name: string | null;
  readonly identities: string;
  readonly roles: string;
  readonly response_status: string | null;
  readonly attendance: string | null;
}

export interface DerivedRejectionRow {
  readonly rejection_id: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly meeting_id: string;
  readonly source_adapter_id: string;
  readonly source_instance_id: string;
  readonly source_external_id: string;
  readonly reviewer_principal_id: string;
  readonly reviewer_display_name: string | null;
  readonly rejected_at: string;
  readonly reason: string | null;
  readonly reconsider_after: string | null;
}

export type DerivedEdgeType =
  | 'derived-from'
  | 'from-meeting'
  | 'listed-participant'
  | 'attended-by'
  | 'supports';

export interface DerivedEdgeRow {
  readonly edge_type: DerivedEdgeType;
  readonly from_id: string;
  readonly to_id: string;
  readonly log_position: number;
}

/** Everything one log record derives to. Committed as one transaction with the cursor. */
export interface OrganizationRecordProjection {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atoms: readonly DerivedAtomRow[];
  readonly meeting_snapshots: readonly DerivedMeetingSnapshotRow[];
  readonly participant_observations: readonly DerivedParticipantObservationRow[];
  readonly rejections: readonly DerivedRejectionRow[];
  readonly edges: readonly DerivedEdgeRow[];
}

export interface OrganizationRecordDeriveProgress {
  readonly cursor_position: number;
  readonly records_derived: number;
  /**
   * True once the follower met a record it could not derive. Carried in the
   * value every caller already reads so a startup catch-up cannot return
   * looking healthy while the cursor is stuck.
   */
  readonly halted: boolean;
}

export type { JsonObject, JsonValue, Sha256Digest };
