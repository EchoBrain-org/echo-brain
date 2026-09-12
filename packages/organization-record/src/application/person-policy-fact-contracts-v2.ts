import type { Sha256Digest } from "@echo-brain/federation-protocol";

/** Derived policy facts shared by the projection port and its implementations. */
export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  'restricted-reviewer-person-v2' as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  'organization-member-readable-person-v2' as const;

export type PersonPolicyIdV2 =
  | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
  | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;

export type PersonPolicyFactItemKindV2 =
  | 'decision'
  | 'action'
  | 'rationale';

export interface PersonPolicyFactRowV2Common {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: 'approve';
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly item_kind: PersonPolicyFactItemKindV2;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface OrganizationMemberReadablePersonPolicyFactRowV2
  extends PersonPolicyFactRowV2Common {
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
}

export interface RestrictedReviewerPersonPolicyFactRowV2
  extends PersonPolicyFactRowV2Common {
  readonly policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
}

export type PersonPolicyFactRowV2 =
  | OrganizationMemberReadablePersonPolicyFactRowV2
  | RestrictedReviewerPersonPolicyFactRowV2;

export type PersonPolicyFactOutcomeV2 =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'appended';
      readonly policy_id: PersonPolicyIdV2;
    };

export interface PersonPolicyFactProjectionV2 {
  readonly facts: readonly PersonPolicyFactRowV2[];
  readonly policy_fact_outcome: PersonPolicyFactOutcomeV2;
}

