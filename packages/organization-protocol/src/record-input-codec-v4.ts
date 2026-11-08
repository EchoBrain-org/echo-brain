import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { ApprovedDecisionSnapshotV2 } from "./approved-decision-snapshot-v2.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

/** V4 domain fields shared by every admitted, versioned resolution codec. */
export interface RecordResolutionRefV4 {
  readonly schema_version: number;
  readonly kind: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: "approve";
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: string;
  readonly provider_action_schema_version: number;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}
/**
 * Codecs may add a versioned approval consequence while retaining the common
 * V4 envelope joins. The envelope only needs the approved snapshot and selected
 * policy; each codec validates its richer event before this point. Every record
 * is an approval: a rejection writes none.
 */
export interface RecordHumanActEventV4 {
  readonly kind: "approved";
  readonly approved_snapshot: ApprovedDecisionSnapshotV2;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly policy_id: string;
  readonly policy_contract_sha256: Sha256Digest;
  readonly policy_consequence_sha256: Sha256Digest;
}
export interface ValidatedRecordInputV4 {
  readonly human_act_resolution_ref: RecordResolutionRefV4;
  readonly event: RecordHumanActEventV4;
  readonly semantic_idempotency_key: Sha256Digest;
}

/** Implementations own exact input/reference/event shapes and their commitment. */
export interface RecordInputCodecV4 {
  readonly input_reference_field: string;
  readonly reference_kind: string;
  readonly reference_schema_version: number;
  validateInput(value: unknown): ValidatedRecordInputV4;
  fromReference(reference: unknown, event: unknown): ValidatedRecordInputV4;
}
export interface RecordInputCodecRegistryV4 {
  validateInput(value: unknown): ValidatedRecordInputV4;
  fromReference(reference: unknown, event: unknown): ValidatedRecordInputV4;
}

function fail(message: string): never { return organizationProtocolValidationFailure(message); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("V4 record input must be an object");
  return value as Record<string, unknown>;
}

/**
 * The one record codec (approval-decision V2, the only record the publisher writes), frozen once by composition with
 * the joins every envelope relies on; no runtime registration. The registry keeps its own frozen copy of the codec and
 * calls its functions as that copy's methods, so a codec may use `this` and later mutation of the codec changes nothing.
 */
export function createRecordInputCodecRegistryV4([codec]: readonly [RecordInputCodecV4]): RecordInputCodecRegistryV4 {
  const selected: RecordInputCodecV4 = Object.freeze({ input_reference_field: codec.input_reference_field, reference_kind: codec.reference_kind,
    reference_schema_version: codec.reference_schema_version, validateInput: codec.validateInput, fromReference: codec.fromReference });
  function check(result: ValidatedRecordInputV4): ValidatedRecordInputV4 {
    if (result.human_act_resolution_ref.kind !== selected.reference_kind || result.human_act_resolution_ref.schema_version !== selected.reference_schema_version ||
        result.event.kind !== "approved") fail("V4 record codec returned a different contract");
    return result;
  }
  return Object.freeze({
    validateInput(value: unknown) {
      if (!Object.hasOwn(object(value), selected.input_reference_field)) fail("V4 record input codec is unknown or ambiguous");
      return check(selected.validateInput(value));
    },
    fromReference(value: unknown, event: unknown) {
      const reference = object(value);
      if (reference.kind !== selected.reference_kind || reference.schema_version !== selected.reference_schema_version) fail("V4 record resolution codec is unknown");
      return check(selected.fromReference(value, event));
    },
  });
}
