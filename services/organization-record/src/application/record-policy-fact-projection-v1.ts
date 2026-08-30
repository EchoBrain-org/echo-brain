import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  PersonPolicyFactProjectionV2,
  PersonPolicyIdV2,
} from "./person-policy-facts-v2.js";

export type RecordResolutionActionV1 = "approve" | "reject";
export type RecordResolutionEventKindV1 = "approved" | "rejected";

/**
 * Minimal provider-neutral view shared by record append and retrieval-source
 * snapshotting. Protocol verification remains outside this workspace; a policy
 * projector validates its own durable resolution and witness contract before
 * deriving facts.
 */
export interface RecordPolicyFactResolutionRefV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: RecordResolutionActionV1;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: string;
  readonly provider_action_schema_version: number;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface RecordResolutionEventV1 {
  readonly kind: RecordResolutionEventKindV1;
}

export interface RecordPolicyFactEnvelopeV1 {
  readonly record_sha256: Sha256Digest;
  readonly body: {
    readonly envelope_id: string;
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly semantic_idempotency_key: Sha256Digest;
    readonly predecessor_position: number | null;
    readonly predecessor_record_sha256: Sha256Digest | null;
    readonly human_act_resolution_ref: RecordPolicyFactResolutionRefV1;
    readonly event: RecordResolutionEventV1;
  };
}

export interface RecordPolicyBindingV1 {
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
}

/**
 * One explicit durable record-resolution protocol projector. This is intentionally a
 * small static composition seam, not a runtime plugin mechanism.
 */
export interface RecordPolicyFactProjectorV1 {
  readonly id: string;
  matches(envelope: RecordPolicyFactEnvelopeV1): boolean;
  project(input: {
    readonly envelope: RecordPolicyFactEnvelopeV1;
    readonly record_position: number;
    readonly witness: unknown;
  }): PersonPolicyFactProjectionV2;
  policyBinding(
    envelope: RecordPolicyFactEnvelopeV1,
  ): RecordPolicyBindingV1;
}

export type RecordPolicyFactProjectorRegistryV1 = Pick<
  RecordPolicyFactProjectorV1,
  "project" | "policyBinding"
>;

function projectorFor(
  projectors: readonly RecordPolicyFactProjectorV1[],
  envelope: RecordPolicyFactEnvelopeV1,
): RecordPolicyFactProjectorV1 {
  const matches = projectors.filter((projector) => projector.matches(envelope));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "record has no configured policy fact projector"
        : "record matches multiple policy fact projectors",
    );
  }
  return matches[0]!;
}

export function createRecordPolicyFactProjectorRegistryV1(
  projectors: readonly RecordPolicyFactProjectorV1[],
): RecordPolicyFactProjectorRegistryV1 {
  if (projectors.length === 0) {
    throw new Error("record policy fact projector registry is empty");
  }
  const identifiers = new Set<string>();
  for (const projector of projectors) {
    if (
      typeof projector.id !== "string" ||
      projector.id.length === 0 ||
      typeof projector.matches !== "function" ||
      typeof projector.project !== "function" ||
      typeof projector.policyBinding !== "function" ||
      identifiers.has(projector.id)
    ) {
      throw new Error("record policy fact projector registry is invalid");
    }
    identifiers.add(projector.id);
  }
  const frozen = Object.freeze([...projectors]);
  return Object.freeze({
    project: (input: {
      readonly envelope: RecordPolicyFactEnvelopeV1;
      readonly record_position: number;
      readonly witness: unknown;
    }) => projectorFor(frozen, input.envelope).project(input),
    policyBinding: (envelope: RecordPolicyFactEnvelopeV1) =>
      projectorFor(frozen, envelope).policyBinding(envelope),
  });
}
