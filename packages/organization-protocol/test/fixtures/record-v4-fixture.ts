// Shared authority, approval-decision, and provenance fixtures for the record
// envelope v4 and record receipt v2 suites.
import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import { expect } from "vitest";
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
} from "@echo-brain/federation-protocol";
import type {
  JsonValue,
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../src/authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "../../src/authority-descriptor.js";
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
  APPROVAL_DECISION_FIELD_V2,
  APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2,
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2,
  APPROVAL_DECISION_REF_KIND_V2,
  APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
  approvalRecordIdV2,
  validateApprovalDecisionRecordInputV2,
} from "../../src/approval-decision-record-input-v2.js";
import type {
  ApprovalDecisionEventV2,
  ApprovalDecisionPolicyIdV1,
  ApprovalDecisionRecordInputV2,
  ApprovalDecisionRefV2,
} from "../../src/approval-decision-record-input-v2.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
} from "../../src/approved-decision-snapshot-v2.js";
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../../src/person-content-policy-v2.js";
import { createRecordInputCodecRegistryV4 } from "../../src/record-input-codec-v4.js";
import {
  DECISION_PROCESSOR_PROVENANCE_V1_KIND,
  MEETING_SOURCE_PROVENANCE_V1_KIND,
} from "../../src/record-envelope-v4.js";
import type {
  AuthorityDetachedSigner,
  CreateOrganizationRecordEnvelopeV4Input,
  DecisionProcessorProvenanceV1,
  MeetingSourceProvenanceV1,
} from "../../src/record-envelope-v4.js";

export const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
export const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000002";
export const STATE_LINEAGE_ID = "state-lineage-1";
export const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

export const digest = (letter: string): Sha256Digest =>
  `sha256:${letter.repeat(64)}`;

export function mutable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export interface TestAuthority {
  readonly descriptor: {
    readonly schema_version: 1;
    readonly kind: "echo-organization-authority";
    readonly authority_id: string;
    readonly organization_id: string;
    readonly signing_key: P256SigningKeyDescriptor;
  };
  readonly pinned: PinnedOrganizationAuthority;
  readonly sign: AuthorityDetachedSigner;
}

export function testAuthority(
  authorityId: string = AUTHORITY_ID,
  organizationId: string = ORGANIZATION_ID,
): TestAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer)) throw new Error("unexpected key export");
  const signingKey: P256SigningKeyDescriptor = {
    key_id: p256KeyId(publicKeyDer),
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: publicKeyDer.toString("base64"),
  };
  const descriptor = {
    schema_version: 1 as const,
    kind: "echo-organization-authority" as const,
    authority_id: authorityId,
    organization_id: organizationId,
    signing_key: signingKey,
  };
  return {
    descriptor,
    pinned: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
    sign: async (message, expectedKeyId) => {
      expect(expectedKeyId).toBe(signingKey.key_id);
      return normalizeP256LowS(
        signMessage("sha256", message, {
          key: privateKey,
          dsaEncoding: "der",
        }),
      );
    },
  };
}

/** The record codecs the Authority appends and reads with: approval decisions only. */
export const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2,
]);
/** The decided proposal every fixture record belongs to. */
export const PROPOSAL_APPROVAL_ID = "approval-1";
export const PROJECT_ID = "prj_00000000-0000-4000-8000-000000000001";

function approvedPayload(): Record<string, unknown> {
  return {
    brief: {
      schema_version: 1,
      id: "brief-1",
      meeting: { id: "meeting-1", participants: [] },
      decisions: [
        {
          id: "decision-1",
          kind: "decision",
          text: "Ship the pilot.",
          subject: null,
          confidence: null,
          evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
          status: "decided",
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: "revision-1",
        processor: {
          kind: "decision-processor",
          adapter_id: "llm",
          instance_id: "primary",
          version: "1.3.0+processing.0123456789abcdef",
        },
        generated_at: "2026-08-20T12:00:00.000Z",
      },
    },
    source: {
      adapter_id: "granola",
      instance_id: "primary",
      external_id: "meeting-external-1",
    },
    alternatives: [],
    links: null,
    reviewed_at: "2026-08-20T12:01:00.000Z",
    surface: APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
  };
}

/**
 * One approval-decision record input: Only me (the restricted reviewer) or
 * one project, with the decision routed there.
 */
export function approvalDecision(
  policyId: ApprovalDecisionPolicyIdV1 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
): ApprovalDecisionRecordInputV2 {
  const projects =
    policyId === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID ? [PROJECT_ID] : [];
  const approvalId = approvalRecordIdV2(PROPOSAL_APPROVAL_ID, projects);
  const snapshot = validateApprovedDecisionSnapshotV2({
    schema_version: 2,
    kind: APPROVED_DECISION_SNAPSHOT_V2_KIND,
    approval_id: approvalId,
    staged_content_sha256: digest("a"),
    final_content_sha256: digest("b"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: approvedPayload(),
  });
  const approvedSnapshotSha256 = approvedDecisionSnapshotV2Sha256(snapshot);
  const policyContractSha256 =
    policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID
      ? restrictedReviewerPersonPolicyContractSha256()
      : projectMembersReadablePersonPolicyContractSha256();
  const consequence: ApprovalDecisionEventV2["policy_consequence"] = {
    schema_version: 2,
    kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
    policy_id: policyId,
    audience_project_ids: projects,
    association_project_ids: projects,
  };
  const policyConsequenceSha256 = canonicalSha256(
    consequence as unknown as JsonValue,
  );
  const commandId = "cmd-1";
  const reference: ApprovalDecisionRefV2 = {
    schema_version: 2,
    kind: APPROVAL_DECISION_REF_KIND_V2,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    approval_id: approvalId,
    proposal_approval_id: PROPOSAL_APPROVAL_ID,
    command_id: commandId,
    action: "approve",
    surface: "desktop",
    candidate_sha256: digest("f"),
    proposal_snapshot_sha256: digest("0"),
    approved_snapshot_sha256: approvedSnapshotSha256,
    route_signal_ids: ["decision-1"],
    final_approver: { principal_id: "principal-1", membership_id: "membership-1" },
    selected_policy_id: policyId,
    policy_contract_sha256: policyContractSha256,
    policy_consequence_sha256: policyConsequenceSha256,
    audience_project_ids: projects,
    association_project_ids: projects,
    action_owners: [],
    audit_event_id: `audit:${commandId}`,
    audit_sequence: 1,
    audit_entry_sha256: digest("c"),
    provider_action_kind: APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2,
    provider_action_schema_version: 2,
    provider_action_sha256: digest("d"),
    authorization_proof_sha256: digest("e"),
    approved_at: "2026-08-20T12:02:00.000Z",
  };
  const event: ApprovalDecisionEventV2 = {
    kind: "approved",
    approved_snapshot: snapshot,
    approved_snapshot_sha256: approvedSnapshotSha256,
    policy_id: policyId,
    policy_contract_sha256: policyContractSha256,
    policy_consequence: consequence,
    policy_consequence_sha256: policyConsequenceSha256,
  };
  // The fixture is valid before any suite mutates its own copy.
  validateApprovalDecisionRecordInputV2({ [APPROVAL_DECISION_FIELD_V2]: reference, event });
  return { approval_decision_ref_v2: reference, event };
}

export function sourceProvenance(
  overrides: Partial<MeetingSourceProvenanceV1> = {},
): MeetingSourceProvenanceV1 {
  return {
    schema_version: 1,
    kind: MEETING_SOURCE_PROVENANCE_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    source_adapter_kind: "meeting-source",
    source_adapter_id: "granola",
    source_adapter_instance_id: "primary",
    source_adapter_version: "2.2.0",
    external_id: "meeting-external-1",
    canonical_revision: "revision-1",
    normalizer_version: "2.2.0",
    source_revision: null,
    ...overrides,
  };
}

export function processorProvenance(
  overrides: Partial<DecisionProcessorProvenanceV1> = {},
): DecisionProcessorProvenanceV1 {
  return {
    schema_version: 1,
    kind: DECISION_PROCESSOR_PROVENANCE_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    processor_adapter_kind: "decision-processor",
    processor_adapter_id: "llm",
    processor_adapter_instance_id: "primary",
    processor_adapter_version: "1.3.0+processing.0123456789abcdef",
    processor_contract_sha256: digest("6"),
    ...overrides,
  };
}

export function envelopeInput(
  policyId: ApprovalDecisionPolicyIdV1 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): CreateOrganizationRecordEnvelopeV4Input {
  return {
    envelope_id: `envelope-${policyId}`,
    issued_at: "2026-08-20T12:03:00.000Z",
    predecessor_position: predecessor?.position ?? null,
    predecessor_record_sha256: predecessor?.sha256 ?? null,
    human_act_record_input: approvalDecision(policyId),
    source_provenance: sourceProvenance(),
    processor_provenance: processorProvenance(),
  };
}
