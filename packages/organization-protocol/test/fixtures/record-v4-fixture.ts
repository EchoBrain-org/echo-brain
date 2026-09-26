// Shared authority, human-act, and provenance fixtures for the record
// envelope v4 and record receipt v2 suites.
import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import { expect } from "vitest";
import {
  normalizeP256LowS,
  p256KeyId,
} from "@echo-brain/federation-protocol";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../src/authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "../../src/authority-descriptor.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  HUMAN_ACT_RESOLUTION_REF_V1_KIND,
  approvedDecisionSnapshotV2Sha256,
  buildHumanActRecordInputV1,
  validateApprovedDecisionSnapshotV2,
} from "../../src/human-act-record-input-v1.js";
import type {
  HumanActEventV1,
  HumanActRecordInputV1,
  PersonContentPolicyIdV2,
} from "../../src/human-act-record-input-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../../src/person-content-policy-v2.js";
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

function selectedPolicy(policyId: PersonContentPolicyIdV2): {
  policy_id: PersonContentPolicyIdV2;
  policy_contract_sha256: Sha256Digest;
  policy_consequence_text: string;
  policy_consequence_sha256: Sha256Digest;
} {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    return {
      policy_id: policyId,
      policy_contract_sha256: restrictedReviewerPersonPolicyContractSha256(),
      policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
      policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256(),
    };
  }
  return {
    policy_id: policyId,
    policy_contract_sha256:
      organizationMemberReadablePersonPolicyContractSha256(),
    policy_consequence_text:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256:
      organizationMemberReadablePersonConsequenceSha256(),
  };
}

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
    surface: "person-approval",
  };
}

function approvedSnapshot(): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: APPROVED_DECISION_SNAPSHOT_V2_KIND,
    approval_id: "approval-1",
    staged_content_sha256: digest("a"),
    final_content_sha256: digest("b"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: approvedPayload(),
  };
}

export function humanAct(
  action: "approve" | "reject",
  policyId: PersonContentPolicyIdV2,
): HumanActRecordInputV1 {
  const policy = selectedPolicy(policyId);
  const reference = {
    schema_version: 1 as const,
    kind: HUMAN_ACT_RESOLUTION_REF_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    approval_id: "approval-1",
    action,
    policy_id: policy.policy_id,
    policy_contract_sha256: policy.policy_contract_sha256,
    audit_event_id: "audit-1",
    audit_sequence: 1,
    audit_entry_sha256: digest("c"),
    provider_action_kind: "echo-provider-human-action-v2" as const,
    provider_action_schema_version: 2 as const,
    provider_action_sha256: digest("d"),
    authorization_proof_sha256: digest("e"),
  };
  const snapshot = approvedSnapshot();
  const event = (action === "approve"
    ? {
        kind: "approved" as const,
        approved_snapshot: snapshot,
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
          validateApprovedDecisionSnapshotV2(snapshot),
        ),
        ...policy,
      }
    : {
        kind: "rejected" as const,
        candidate_sha256: digest("f"),
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
          validateApprovedDecisionSnapshotV2(snapshot),
        ),
        frozen_card_sha256: digest("0"),
        policy_id: policy.policy_id,
        policy_contract_sha256: policy.policy_contract_sha256,
        policy_consequence_sha256: policy.policy_consequence_sha256,
        action: "reject" as const,
        rejection_payload: {
          source: {
            adapter_id: "granola",
            instance_id: "primary",
            external_id: "meeting-external-1",
          },
          meeting_id: "meeting-1",
          rejected_at: "2026-08-20T12:02:00.000Z",
          reason: "Needs a clearer owner.",
          reconsider_after: null,
        },
      }) as unknown as HumanActEventV1;
  const aggregate = buildHumanActRecordInputV1({
    human_act_resolution_ref: reference,
    event,
  });
  return {
    human_act_resolution_ref: aggregate.human_act_resolution_ref,
    event: aggregate.event,
    idempotency: aggregate.idempotency,
  };
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
  action: "approve" | "reject" = "approve",
  policyId: PersonContentPolicyIdV2 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): CreateOrganizationRecordEnvelopeV4Input {
  return {
    envelope_id: `envelope-${action}-${policyId}`,
    issued_at: "2026-08-20T12:03:00.000Z",
    predecessor_position: predecessor?.position ?? null,
    predecessor_record_sha256: predecessor?.sha256 ?? null,
    human_act_record_input: humanAct(action, policyId),
    source_provenance: sourceProvenance(),
    processor_provenance: processorProvenance(),
  };
}
