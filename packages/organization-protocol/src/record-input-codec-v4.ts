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

/** A closed snapshot, constructed once by composition; no runtime registration. */
export function createRecordInputCodecRegistryV4(codecs: readonly RecordInputCodecV4[]): RecordInputCodecRegistryV4 {
  const fields = new Set<string>();
  const kinds = new Set<string>();
  const selected = codecs.map((codec) => {
    const key = `${codec.reference_kind}:${codec.reference_schema_version}`;
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(codec.input_reference_field) ||
        !/^[a-z][a-z0-9-]{0,127}$/.test(codec.reference_kind) ||
        !Number.isSafeInteger(codec.reference_schema_version) || codec.reference_schema_version < 1 ||
        fields.has(codec.input_reference_field) || kinds.has(key) ||
        typeof codec.validateInput !== "function" || typeof codec.fromReference !== "function") fail("V4 record codecs are invalid or ambiguous");
    fields.add(codec.input_reference_field); kinds.add(key);
    return Object.freeze({ input_reference_field: codec.input_reference_field, reference_kind: codec.reference_kind,
      reference_schema_version: codec.reference_schema_version, validateInput: codec.validateInput, fromReference: codec.fromReference });
  });
  function check(codec: RecordInputCodecV4, result: ValidatedRecordInputV4): ValidatedRecordInputV4 {
    if (result.human_act_resolution_ref.kind !== codec.reference_kind || result.human_act_resolution_ref.schema_version !== codec.reference_schema_version ||
        result.event.kind !== "approved") fail("V4 record codec returned a different contract");
    return result;
  }
  return Object.freeze({
    validateInput(value: unknown) {
      const input = object(value);
      const matches = selected.filter((codec) => Object.hasOwn(input, codec.input_reference_field));
      if (matches.length !== 1) fail("V4 record input codec is unknown or ambiguous");
      return check(matches[0]!, matches[0]!.validateInput(value));
    },
    fromReference(value: unknown, event: unknown) {
      const reference = object(value);
      const codec = selected.find((candidate) => candidate.reference_kind === reference.kind && candidate.reference_schema_version === reference.schema_version);
      if (!codec) fail("V4 record resolution codec is unknown");
      return check(codec, codec.fromReference(value, event));
    },
  });
}
