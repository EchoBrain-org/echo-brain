import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  sha256Digest,
  type JsonObject,
  type P256SigningKeyDescriptor,
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { HUMAN_ACT_RECORD_INPUT_CODEC_V1, createRecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../../organization-protocol/src/authority-descriptor.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  HUMAN_ACT_RESOLUTION_REF_V1_KIND,
  approvedDecisionSnapshotV2Sha256,
  buildHumanActRecordInputV1,
  validateApprovedDecisionSnapshotV2,
  type HumanActEventV1,
} from "../../../organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordReceiptV2,
  validateOrganizationRecordReceiptBodyV2,
  verifyOrganizationRecordReceiptV2,
} from "../../../organization-protocol/src/organization-record-receipt-v2.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../../../organization-protocol/src/person-content-policy-v2.js";
import {
  DECISION_PROCESSOR_PROVENANCE_V1_KIND,
  MEETING_SOURCE_PROVENANCE_V1_KIND,
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../organization-protocol/src/record-envelope-v4.js";
import {
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonPolicyIdV2
} from "../../src/application/person-policy-fact-contracts-v2.js";
import {
  type PersonHumanActActionV2,
  type RevalidatedPersonPolicyAuthorizationWitnessV2,
} from "../../src/application/person-policy-facts-v2.js";
import {
  type AppendV4RecordInput,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView
} from "../../src/log/record-log-v4-append.js";
import { openOrganizationRecordDatabase } from "../../src/persistence/open-organization-record-database.js";
import {
  applyOrganizationRecordLogBaselineV3,
} from "../../src/persistence/record-log-baseline.js";

export const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1]);

export const COORDINATES = {
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000002",
  state_lineage_id: "state-lineage-1",
} as const;

export interface ProtocolAuthority {
  readonly pinned: ReturnType<typeof verifyOrganizationAuthorityPin>;
  readonly sign: (
    message: Buffer,
    expectedKeyId: Sha256Digest,
  ) => Promise<Buffer>;
}

export function protocolAuthority(): ProtocolAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer))
    throw new Error("test authority key export failed");
  const signing_key: P256SigningKeyDescriptor = {
    key_id: p256KeyId(publicKeyDer),
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: publicKeyDer.toString("base64"),
  };
  const descriptor = {
    schema_version: 1 as const,
    kind: "echo-organization-authority" as const,
    authority_id: COORDINATES.authority_id,
    organization_id: COORDINATES.organization_id,
    signing_key,
  };
  return {
    pinned: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
    sign: async (message, expectedKeyId) => {
      if (expectedKeyId !== signing_key.key_id)
        throw new Error("unexpected signing key");
      return normalizeP256LowS(
        signMessage("sha256", message, { key: privateKey, dsaEncoding: "der" }),
      );
    },
  };
}

export function database(): ReturnType<typeof openOrganizationRecordDatabase> {
  const value = openOrganizationRecordDatabase(":memory:");
  applyOrganizationRecordLogBaselineV3(value);
  value
    .prepare(
      `INSERT INTO organization_record_log_metadata (
    singleton, authority_id, organization_id, state_lineage_id, created_at
  ) VALUES (1, ?, ?, ?, ?)`,
    )
    .run(
      COORDINATES.authority_id,
      COORDINATES.organization_id,
      COORDINATES.state_lineage_id,
      "2026-08-21T12:00:00.000Z",
    );
  return value;
}

export function policy(policy_id: PersonPolicyIdV2) {
  if (policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    return {
      policy_contract_sha256: restrictedReviewerPersonPolicyContractSha256(),
      policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
      policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256(),
    };
  }
  return {
    policy_contract_sha256:
      organizationMemberReadablePersonPolicyContractSha256(),
    policy_consequence_text:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256:
      organizationMemberReadablePersonConsequenceSha256(),
  };
}

export function humanAct(
  approval_id: string,
  action: PersonHumanActActionV2,
  policy_id: PersonPolicyIdV2,
  signal_count: number,
  signal_counts?: {
    readonly decisions?: number;
    readonly actions?: number;
    readonly rationales?: number;
  },
) {
  const selected = policy(policy_id);
  const reference = {
    schema_version: 1 as const,
    kind: HUMAN_ACT_RESOLUTION_REF_V1_KIND,
    ...COORDINATES,
    approval_id,
    action,
    policy_id,
    policy_contract_sha256: selected.policy_contract_sha256,
    audit_event_id: `audit-${approval_id}`,
    audit_sequence: 1,
    audit_entry_sha256: sha256Digest(`audit-entry-${approval_id}`),
    provider_action_kind: "echo-provider-human-action-v2" as const,
    provider_action_schema_version: 2 as const,
    provider_action_sha256: sha256Digest(`provider-${approval_id}`),
    authorization_proof_sha256: sha256Digest(`authorization-${approval_id}`),
  };
  const snapshot = {
    schema_version: 2 as const,
    kind: APPROVED_DECISION_SNAPSHOT_V2_KIND,
    approval_id,
    staged_content_sha256: sha256Digest(`staged-${approval_id}`),
    final_content_sha256: sha256Digest(`final-${approval_id}`),
    payload_contract_id: "organization-record-approval-payload-v1" as const,
    approved_payload: {
      brief: {
        schema_version: 1,
        id: `brief-${approval_id}`,
        meeting: { id: `meeting-${approval_id}`, participants: [] },
        decisions: Array.from(
          { length: signal_counts?.decisions ?? signal_count },
          (_, index) => ({
            id: `decision-${approval_id}-${index}`,
            kind: "decision" as const,
            text: `Decision ${index}`,
            subject: null,
            confidence: null,
            evidence: [
              {
                meeting_id: `meeting-${approval_id}`,
                block_id: `block-${index}`,
              },
            ],
            status: "decided" as const,
          }),
        ),
        actions: Array.from(
          { length: signal_counts?.actions ?? 0 },
          (_, index) => ({
            id: `action-${approval_id}-${index}`,
            kind: "action" as const,
            text: `Action ${index}`,
            subject: null,
            confidence: null,
            owner: null,
            due_at: null,
            evidence: [
              {
                meeting_id: `meeting-${approval_id}`,
                block_id: `action-block-${index}`,
              },
            ],
          }),
        ),
        rationales: Array.from(
          { length: signal_counts?.rationales ?? 0 },
          (_, index) => ({
            id: `rationale-${approval_id}-${index}`,
            kind: "rationale" as const,
            text: `Rationale ${index}`,
            subject: null,
            confidence: null,
            supports_signal_ids: [],
            evidence: [
              {
                meeting_id: `meeting-${approval_id}`,
                block_id: `rationale-block-${index}`,
              },
            ],
          }),
        ),
        provenance: {
          meeting_revision: "revision-1",
          processor: {
            kind: "decision-processor" as const,
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
        external_id: "external-approval-1",
      },
      alternatives: [],
      links: null,
      reviewed_at: "2026-08-20T12:01:00.000Z",
      surface: "person-approval",
    },
  };
  const approvedSnapshot = validateApprovedDecisionSnapshotV2(snapshot);
  const event: HumanActEventV1 =
    action === "approve"
      ? {
          kind: "approved" as const,
          approved_snapshot: approvedSnapshot,
          approved_snapshot_sha256:
            approvedDecisionSnapshotV2Sha256(approvedSnapshot),
          policy_id,
          ...selected,
        }
      : {
          kind: "rejected" as const,
          candidate_sha256: sha256Digest(`candidate-${approval_id}`),
          approved_snapshot_sha256:
            approvedDecisionSnapshotV2Sha256(approvedSnapshot),
          frozen_card_sha256: sha256Digest(`card-${approval_id}`),
          policy_id,
          policy_contract_sha256: selected.policy_contract_sha256,
          policy_consequence_sha256: selected.policy_consequence_sha256,
          action: "reject" as const,
          rejection_payload: {
            source: {
              adapter_id: "granola",
              instance_id: "primary",
              external_id: "external-approval-1",
            },
            meeting_id: `meeting-${approval_id}`,
            rejected_at: "2026-08-20T12:02:00.000Z",
            reason: "Needs a clearer owner.",
            reconsider_after: null,
          },
        };
  return buildHumanActRecordInputV1({
    human_act_resolution_ref: reference,
    event,
  });
}

function authorizationWitness(
  human: ReturnType<typeof humanAct>,
): RevalidatedPersonPolicyAuthorizationWitnessV2 {
  const ref = human.human_act_resolution_ref;
  return {
    authorization_allow: {
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      approval_id: ref.approval_id,
      action: ref.action,
      policy_id: ref.policy_id,
      policy_contract_sha256: ref.policy_contract_sha256,
      principal_id: "principal-1",
      membership_id: "membership-1",
      provider_action_sha256: ref.provider_action_sha256,
      decision: "allow",
    },
    authorization_proof_sha256: ref.authorization_proof_sha256,
    provider_action_kind: ref.provider_action_kind,
    provider_action_schema_version: ref.provider_action_schema_version,
    audit_entry: {
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      audit_event_id: ref.audit_event_id,
      audit_sequence: ref.audit_sequence,
      actor_class: "provider_human",
      principal_id: "principal-1",
      membership_id: "membership-1",
      action: ref.action,
      subject_kind: "approval",
      subject_id: ref.approval_id,
      detail_digest: ref.authorization_proof_sha256,
      provider_action_sha256: ref.provider_action_sha256,
    },
    audit_entry_sha256: ref.audit_entry_sha256,
  };
}

export function sourceProvenance() {
  return {
    schema_version: 1 as const,
    kind: MEETING_SOURCE_PROVENANCE_V1_KIND,
    ...COORDINATES,
    source_adapter_kind: "meeting-source" as const,
    source_adapter_id: "granola",
    source_adapter_instance_id: "primary",
    source_adapter_version: "2.2.0",
    external_id: "external-approval-1",
    canonical_revision: "revision-1",
    normalizer_version: "2.2.0",
    source_revision: null,
  };
}

export function processorProvenance() {
  return {
    schema_version: 1 as const,
    kind: DECISION_PROCESSOR_PROVENANCE_V1_KIND,
    ...COORDINATES,
    processor_adapter_kind: "decision-processor" as const,
    processor_adapter_id: "llm",
    processor_adapter_instance_id: "primary",
    processor_adapter_version: "1.3.0+processing.0123456789abcdef",
    processor_contract_sha256: sha256Digest("processor-contract"),
  };
}

function envelopeFactory(
  authority: ProtocolAuthority,
  human: ReturnType<typeof humanAct>,
  calls: { value: number },
): V4RecordEnvelopeFactory {
  return {
    async create(allocation) {
      calls.value += 1;
      return createOrganizationRecordEnvelopeV4(
        {
          envelope_id: `envelope-${human.human_act_resolution_ref.approval_id}`,
          issued_at: "2026-08-21T12:01:00.000Z",
          predecessor_position: allocation.predecessor_position,
          predecessor_record_sha256: allocation.predecessor_record_sha256,
          human_act_record_input: {
            human_act_resolution_ref: human.human_act_resolution_ref,
            event: human.event,
            idempotency: human.idempotency,
          },
          source_provenance: sourceProvenance(),
          processor_provenance: processorProvenance(),
        },
        authority.pinned,
        COORDINATES.state_lineage_id,
        authority.sign, RECORD_INPUT_CODECS,
      ) as unknown as JsonObject;
    },
    verify(value) {
      return verifyOrganizationRecordEnvelopeV4(
        value,
        authority.pinned,
        COORDINATES.state_lineage_id, RECORD_INPUT_CODECS,
      ) as unknown as V4RecordEnvelopeView & JsonObject;
    },
  };
}

export function receiptFactory(
  authority: ProtocolAuthority,
  options: {
    readonly sign_calls: { value: number };
    readonly fail_sign?: boolean;
  },
  codecs = RECORD_INPUT_CODECS,
): V4ReceiptFactory {
  return {
    createSeed({ envelope, position, issued_at, policy_fact_outcome }) {
      return validateOrganizationRecordReceiptBodyV2({
        schema_version: 2,
        kind: "echo-organization-record-receipt-v2",
        authority_id: envelope.body.authority_id,
        organization_id: envelope.body.organization_id,
        state_lineage_id: envelope.body.state_lineage_id,
        envelope_id: envelope.body.envelope_id,
        semantic_idempotency_key: envelope.body.semantic_idempotency_key,
        event_kind: envelope.body.event.kind,
        record_position: position,
        record_sha256: envelope.record_sha256,
        predecessor_record_sha256: envelope.body.predecessor_record_sha256,
        record_head_position: position,
        record_head_sha256: envelope.record_sha256,
        issued_at,
        policy_fact_outcome,
      }) as unknown as JsonObject;
    },
    async sign({ envelope, receipt_seed }) {
      options.sign_calls.value += 1;
      if (options.fail_sign)
        throw new Error("signer stopped after append commit");
      const seed = receipt_seed as unknown as {
        readonly record_position: number;
        readonly issued_at: string;
      };
      const receipt = await createOrganizationRecordReceiptV2(
        {
          envelope: envelope as never,
          record_position: seed.record_position,
          issued_at: seed.issued_at,
        },
        authority.pinned,
        COORDINATES.state_lineage_id,
        authority.sign, codecs,
      );
      if (canonicalJson(receipt.body) !== canonicalJson(receipt_seed))
        throw new Error(
          "real Receipt V2 builder did not reproduce the committed seed",
        );
      return receipt as unknown as JsonObject;
    },
    verify({ receipt, envelope }) {
      return verifyOrganizationRecordReceiptV2(
        receipt,
        envelope,
        authority.pinned,
        COORDINATES.state_lineage_id, codecs,
      ) as unknown as JsonObject;
    },
  };
}

export function appendInput(input: {
  readonly authority: ProtocolAuthority;
  readonly approval_id?: string;
  readonly action?: PersonHumanActActionV2;
  readonly policy_id?: PersonPolicyIdV2;
  readonly signal_count?: number;
  readonly signal_counts?: {
    readonly decisions?: number;
    readonly actions?: number;
    readonly rationales?: number;
  };
  readonly envelope_calls?: { value: number };
  readonly receipt?: V4ReceiptFactory;
  readonly semantic_idempotency_key?: Sha256Digest;
}): AppendV4RecordInput {
  const human = humanAct(
    input.approval_id ?? "approval-1",
    input.action ?? "approve",
    input.policy_id ?? RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    input.signal_count ?? 1,
    input.signal_counts,
  );
  return {
    approval_id: input.approval_id ?? "approval-1",
    action: input.action ?? "approve",
    semantic_idempotency_key:
      input.semantic_idempotency_key ?? human.semantic_idempotency_key,
    receipt_issued_at: "2026-08-21T12:02:00.000Z",
    authorization_witness: authorizationWitness(human),
    envelope_factory: envelopeFactory(
      input.authority,
      human,
      input.envelope_calls ?? { value: 0 },
    ),
    receipt_factory:
      input.receipt ??
      receiptFactory(input.authority, { sign_calls: { value: 0 } }),
  };
}
