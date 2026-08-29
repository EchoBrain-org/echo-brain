import type { Sha256Digest } from "./contracts.js";
import type {
  PersonPolicyFactProjectionV2,
  PersonPolicyIdV2,
} from "./person-policy-facts-v2.js";

export type ApprovedRecordActionV1 = "approve" | "reject";
export type ApprovedRecordEventKindV1 = "approved" | "rejected";

/**
 * Minimal provider-neutral view shared by append and Layer 1. Protocol
 * verification remains outside this workspace; a policy projector validates
 * its own durable resolution and witness contract before deriving facts.
 */
export interface ApprovedRecordResolutionRefV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: ApprovedRecordActionV1;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: string;
  readonly provider_action_schema_version: number;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface ApprovedRecordEventV1 {
  readonly kind: ApprovedRecordEventKindV1;
}

export interface ApprovedRecordPolicyEnvelopeV1 {
  readonly record_sha256: Sha256Digest;
  readonly body: {
    readonly envelope_id: string;
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly semantic_idempotency_key: Sha256Digest;
    readonly predecessor_position: number | null;
    readonly predecessor_record_sha256: Sha256Digest | null;
    readonly human_act_resolution_ref: ApprovedRecordResolutionRefV1;
    readonly event: ApprovedRecordEventV1;
  };
}

export interface ApprovedRecordPolicyBindingV1 {
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
}

/**
 * One explicit durable approval protocol projector. This is intentionally a
 * small static composition seam, not a runtime plugin mechanism.
 */
export interface ApprovedRecordPolicyProjectorV1 {
  readonly id: string;
  matches(envelope: ApprovedRecordPolicyEnvelopeV1): boolean;
  project(input: {
    readonly envelope: ApprovedRecordPolicyEnvelopeV1;
    readonly record_position: number;
    readonly witness: unknown;
  }): PersonPolicyFactProjectionV2;
  approvedPolicy(
    envelope: ApprovedRecordPolicyEnvelopeV1,
  ): ApprovedRecordPolicyBindingV1;
}

export type ApprovedRecordPolicyProjectorRegistryV1 = Pick<
  ApprovedRecordPolicyProjectorV1,
  "project" | "approvedPolicy"
>;

function projectorFor(
  projectors: readonly ApprovedRecordPolicyProjectorV1[],
  envelope: ApprovedRecordPolicyEnvelopeV1,
): ApprovedRecordPolicyProjectorV1 {
  const matches = projectors.filter((projector) => projector.matches(envelope));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "approved record has no configured policy projector"
        : "approved record matches multiple policy projectors",
    );
  }
  return matches[0]!;
}

export function createApprovedRecordPolicyProjectorRegistryV1(
  projectors: readonly ApprovedRecordPolicyProjectorV1[],
): ApprovedRecordPolicyProjectorRegistryV1 {
  if (projectors.length === 0) {
    throw new Error("approved record policy projector registry is empty");
  }
  const identifiers = new Set<string>();
  for (const projector of projectors) {
    if (
      typeof projector.id !== "string" ||
      projector.id.length === 0 ||
      typeof projector.matches !== "function" ||
      typeof projector.project !== "function" ||
      typeof projector.approvedPolicy !== "function" ||
      identifiers.has(projector.id)
    ) {
      throw new Error("approved record policy projector registry is invalid");
    }
    identifiers.add(projector.id);
  }
  const frozen = Object.freeze([...projectors]);
  return Object.freeze({
    project: (input: {
      readonly envelope: ApprovedRecordPolicyEnvelopeV1;
      readonly record_position: number;
      readonly witness: unknown;
    }) => projectorFor(frozen, input.envelope).project(input),
    approvedPolicy: (envelope: ApprovedRecordPolicyEnvelopeV1) =>
      projectorFor(frozen, envelope).approvedPolicy(envelope),
  });
}
