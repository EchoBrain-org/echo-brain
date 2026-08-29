import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import {
  canonicalJson,
  normalizeP256LowS,
  parseCanonicalJson,
  p256KeyId,
  sha256Digest,
  type JsonObject,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../../packages/organization-protocol/src/authority-descriptor.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  HUMAN_ACT_RESOLUTION_REF_V1_KIND,
  approvedDecisionSnapshotV2Sha256,
  buildHumanActRecordInputV1,
  type HumanActEventV1,
  validateApprovedDecisionSnapshotV2,
} from "../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
  buildPrivateSlackBlockApprovalRecordInputV1,
} from "../../../packages/organization-protocol/src/private-slack-block-approval-record-input-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../../../packages/organization-protocol/src/person-content-policy-v2.js";
import {
  DECISION_PROCESSOR_PROVENANCE_V1_KIND,
  MEETING_SOURCE_PROVENANCE_V1_KIND,
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  createOrganizationRecordReceiptV2,
  validateOrganizationRecordReceiptBodyV2,
  verifyOrganizationRecordReceiptV2,
} from "../../../packages/organization-protocol/src/organization-record-receipt-v2.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonHumanActActionV2,
  type PersonPolicyIdV2,
  type ReprovedPersonPolicyD2WitnessV2,
} from "../src/application/person-policy-facts-v2.js";
import {
  OrganizationRecordV4AppendApplication,
  V4RecordIdempotencyConflictError,
  type AppendV4RecordInput,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView,
  type ReprovedPrivateSlackBlockApprovalD2WitnessV1,
} from "../src/log/record-log-v4-append.js";
import { CleanPersonRecordReaderV1 } from "../src/retrieve/clean-person-record-reader-v1.js";
import {
  CleanV4Layer1SnapshotPort,
  type CleanV4Layer1VerifiedEnvelope,
} from "../src/retrieve/clean-v4-layer1-snapshot.js";
import {
  applyOrganizationRecordLogBaselineV1,
  applyOrganizationRecordLogBaselineV2,
} from "../src/persistence/record-log-baseline.js";
import { openOrganizationRecordDatabase } from "../src/persistence/open-unmigrated-database.js";

const COORDINATES = {
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000002",
  state_lineage_id: "state-lineage-1",
} as const;

interface ProtocolAuthority {
  readonly pinned: ReturnType<typeof verifyOrganizationAuthorityPin>;
  readonly sign: (
    message: Buffer,
    expectedKeyId: Sha256Digest,
  ) => Promise<Buffer>;
}

function protocolAuthority(): ProtocolAuthority {
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

function database(baseline: 1 | 2 = 1) {
  const value = openOrganizationRecordDatabase(":memory:");
  if (baseline === 1) applyOrganizationRecordLogBaselineV1(value);
  else applyOrganizationRecordLogBaselineV2(value);
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

function policy(policy_id: PersonPolicyIdV2) {
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

function humanAct(
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

function d2Witness(
  human: ReturnType<typeof humanAct>,
): ReprovedPersonPolicyD2WitnessV2 {
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

function privateSlackBlockHumanAct(
  approval_id: string,
  action: PersonHumanActActionV2,
  policy_id: PersonPolicyIdV2,
  signal_count: number,
) {
  // Reuse the validated frozen snapshot only. The private event itself is a
  // distinct Block Kit contract and its reject carries no release payload.
  const legacy = humanAct(approval_id, "approve", policy_id, signal_count);
  const snapshot = (legacy.event as Extract<HumanActEventV1, { kind: "approved" }>)
    .approved_snapshot;
  const selected = policy(policy_id);
  const reference = {
    schema_version: 1 as const,
    kind: "echo-private-slack-block-approval-resolution-ref-v1" as const,
    ...COORDINATES,
    command_id: `command-${approval_id}`,
    approval_id,
    candidate_sha256: sha256Digest(`candidate-${approval_id}`),
    frozen_card_sha256: sha256Digest(`card-${approval_id}`),
    approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot),
    final_approver: { principal_id: "principal-1", membership_id: "membership-1" },
    current_slack_identity_link: {
      provider: "slack" as const,
      external_identity_link_id: `clm_${approval_id}`,
      external_identity_link_contract_sha256: sha256Digest(`link-${approval_id}`),
      provider_subject_id: "U123",
    },
    action,
    selected_policy_id: action === "approve" ? policy_id : null,
    policy_contract_sha256:
      action === "approve" ? selected.policy_contract_sha256 : null,
    policy_consequence_sha256:
      action === "approve" ? selected.policy_consequence_sha256 : null,
    comment: action === "approve" ? "Approved in the private card." : null,
    audit_event_id: `audit-${approval_id}`,
    audit_sequence: 1,
    audit_entry_sha256: sha256Digest(`audit-entry-${approval_id}`),
    provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
    provider_action_schema_version: 1 as const,
    provider_action_sha256: sha256Digest(`block-action-${approval_id}`),
    authorization_proof_sha256: sha256Digest(`authorization-${approval_id}`),
  };
  const event =
    action === "approve"
      ? {
          kind: "approved" as const,
          approved_snapshot: snapshot,
          approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot),
          policy_id,
          ...selected,
        }
      : { kind: "rejected" as const };
  return buildPrivateSlackBlockApprovalRecordInputV1({
    private_slack_block_approval_resolution_ref: reference,
    event,
  });
}

function privateSlackBlockD2Witness(
  human: ReturnType<typeof privateSlackBlockHumanAct>,
): ReprovedPrivateSlackBlockApprovalD2WitnessV1 {
  const ref = human.private_slack_block_approval_resolution_ref;
  return {
    authorization_allow: {
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      approval_id: ref.approval_id,
      action: ref.action,
      final_approver: ref.final_approver,
      selected_policy_id: ref.selected_policy_id,
      policy_contract_sha256: ref.policy_contract_sha256,
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
      principal_id: ref.final_approver.principal_id,
      membership_id: ref.final_approver.membership_id,
      action: ref.action,
      subject_kind: "approval",
      subject_id: ref.approval_id,
      detail_digest: ref.authorization_proof_sha256,
      provider_action_sha256: ref.provider_action_sha256,
    },
    audit_entry_sha256: ref.audit_entry_sha256,
  };
}

function sourceProvenance() {
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

function processorProvenance() {
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
        authority.sign,
      ) as unknown as JsonObject;
    },
    verify(value) {
      return verifyOrganizationRecordEnvelopeV4(
        value,
        authority.pinned,
        COORDINATES.state_lineage_id,
      ) as unknown as V4RecordEnvelopeView & JsonObject;
    },
  };
}

function privateSlackBlockEnvelopeFactory(
  authority: ProtocolAuthority,
  human: ReturnType<typeof privateSlackBlockHumanAct>,
  calls: { value: number },
): V4RecordEnvelopeFactory {
  return {
    async create(allocation) {
      calls.value += 1;
      return createOrganizationRecordEnvelopeV4(
        {
          envelope_id: `private-envelope-${human.private_slack_block_approval_resolution_ref.approval_id}`,
          issued_at: "2026-08-21T12:01:00.000Z",
          predecessor_position: allocation.predecessor_position,
          predecessor_record_sha256: allocation.predecessor_record_sha256,
          human_act_record_input: {
            private_slack_block_approval_resolution_ref:
              human.private_slack_block_approval_resolution_ref,
            event: human.event,
          },
          source_provenance: sourceProvenance(),
          processor_provenance: processorProvenance(),
        },
        authority.pinned,
        COORDINATES.state_lineage_id,
        authority.sign,
      ) as unknown as JsonObject;
    },
    verify(value) {
      return verifyOrganizationRecordEnvelopeV4(
        value,
        authority.pinned,
        COORDINATES.state_lineage_id,
      ) as unknown as V4RecordEnvelopeView & JsonObject;
    },
  };
}

function receiptFactory(
  authority: ProtocolAuthority,
  options: {
    readonly sign_calls: { value: number };
    readonly fail_sign?: boolean;
  },
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
        authority.sign,
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
        COORDINATES.state_lineage_id,
      ) as unknown as JsonObject;
    },
  };
}

function appendInput(input: {
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
    d2_witness: d2Witness(human),
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

function privateSlackBlockAppendInput(input: {
  readonly authority: ProtocolAuthority;
  readonly approval_id?: string;
  readonly action?: PersonHumanActActionV2;
  readonly policy_id?: PersonPolicyIdV2;
  readonly signal_count?: number;
  readonly envelope_calls?: { value: number };
  readonly receipt?: V4ReceiptFactory;
  readonly semantic_idempotency_key?: Sha256Digest;
}): AppendV4RecordInput {
  const human = privateSlackBlockHumanAct(
    input.approval_id ?? "private-approval-1",
    input.action ?? "approve",
    input.policy_id ?? RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    input.signal_count ?? 1,
  );
  return {
    approval_id: human.private_slack_block_approval_resolution_ref.approval_id,
    action: human.private_slack_block_approval_resolution_ref.action,
    semantic_idempotency_key:
      input.semantic_idempotency_key ?? human.semantic_idempotency_key,
    receipt_issued_at: "2026-08-21T12:02:00.000Z",
    d2_witness: privateSlackBlockD2Witness(human),
    envelope_factory: privateSlackBlockEnvelopeFactory(
      input.authority,
      human,
      input.envelope_calls ?? { value: 0 },
    ),
    receipt_factory:
      input.receipt ??
      receiptFactory(input.authority, { sign_calls: { value: 0 } }),
  };
}

describe("private V4 new-lineage record-log append", () => {
  it("append-atomically projects a signed private Block Kit approval and retries it without a second envelope", async () => {
    const db = database(2);
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const calls = { value: 0 };
      const input = privateSlackBlockAppendInput({
        authority,
        signal_count: 2,
        envelope_calls: calls,
      });
      const appended = await app.append(input);
      expect(appended).toMatchObject({ outcome: "appended", position: 1 });
      expect(
        db.prepare(
          "SELECT count(*) AS count FROM organization_record_restricted_reviewer_person_fact",
        ).get(),
      ).toEqual({ count: 2 });
      const layer1 = new CleanV4Layer1SnapshotPort(db).snapshot({
        ...COORDINATES,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            authority.pinned,
            COORDINATES.state_lineage_id,
          ) as unknown as CleanV4Layer1VerifiedEnvelope,
      });
      expect(layer1.atoms).toHaveLength(2);
      expect(layer1.rows[0]?.classification).toEqual({
        kind: "approved",
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        atom_count: 2,
      });
      expect(await app.append(input)).toEqual({ ...appended, outcome: "duplicate" });
      expect(calls.value).toBe(1);
    } finally {
      db.close();
    }
  });

  it("append-atomically records a signed private Block Kit rejection without Person facts", async () => {
    const db = database(2);
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const result = await app.append(
        privateSlackBlockAppendInput({
          authority,
          approval_id: "private-reject-1",
          action: "reject",
        }),
      );
      expect(result).toMatchObject({ outcome: "appended", position: 1 });
      expect(
        db.prepare(
          "SELECT count(*) AS count FROM organization_record_restricted_reviewer_person_fact",
        ).get(),
      ).toEqual({ count: 0 });
      expect(
        db.prepare(
          "SELECT count(*) AS count FROM organization_record_member_readable_person_fact",
        ).get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("uses real V4 and Receipt V2 verification before persisting approval facts", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const result = await app.append(
        appendInput({
          authority,
          signal_count: 11,
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
      );
      expect(result).toMatchObject({ outcome: "appended", position: 1 });
      const row = db
        .prepare(
          `SELECT canonical_envelope, envelope_sha256, record_sha256, receipt_payload FROM organization_record_log WHERE position = 1`,
        )
        .get() as {
        canonical_envelope: string;
        envelope_sha256: Sha256Digest;
        record_sha256: Sha256Digest;
        receipt_payload: string;
      };
      expect(row.envelope_sha256).toBe(sha256Digest(row.canonical_envelope));
      expect(row.envelope_sha256).not.toBe(row.record_sha256);
      expect(canonicalJson(result.receipt.body as JsonObject)).toBe(
        row.receipt_payload,
      );
      expect(
        db
          .prepare(
            "SELECT atom_order FROM organization_record_member_readable_person_fact ORDER BY atom_order",
          )
          .all(),
      ).toEqual(
        Array.from({ length: 11 }, (_, atom_order) => ({ atom_order })),
      );
    } finally {
      db.close();
    }
  });

  it("commits a real rejected V4 record without Person facts", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      expect(
        (
          await app.append(
            appendInput({
              authority,
              approval_id: "approval-rejected",
              action: "reject",
            }),
          )
        ).outcome,
      ).toBe("appended");
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM organization_record_member_readable_person_fact",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM organization_record_restricted_reviewer_person_fact",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("releases approved records only through a matching current Person fact", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const approved = appendInput({
        authority,
        approval_id: "approval-reader",
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      });
      const first = await app.append(approved);
      expect(await app.append(approved)).toMatchObject({
        outcome: "duplicate",
        position: first.position,
      });
      await app.append(
        appendInput({
          authority,
          approval_id: "approval-reader-rejected",
          action: "reject",
        }),
      );
      const reader = new CleanPersonRecordReaderV1(db);
      expect(
        reader.list({
          ...COORDINATES,
          principal_id: "principal-1",
          membership_id: "membership-1",
        }),
      ).toMatchObject([
        {
          position: 1,
          approval_id: "approval-reader",
          record_sha256: first.record_sha256,
        },
      ]);
      expect(
        reader.list({
          ...COORDINATES,
          principal_id: "principal-other",
          membership_id: "membership-other",
        }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("materializes a verified dense V4 Layer 1 snapshot for both Person policies", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const member = await app.append(
        appendInput({
          authority,
          approval_id: "approval-member-snapshot",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          signal_counts: { decisions: 1, actions: 1, rationales: 1 },
        }),
      );
      const restricted = await app.append(
        appendInput({
          authority,
          approval_id: "approval-reviewer-snapshot",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        }),
      );
      const rejected = await app.append(
        appendInput({
          authority,
          approval_id: "approval-rejected-snapshot",
          action: "reject",
        }),
      );
      const snapshot = new CleanV4Layer1SnapshotPort(db).snapshot({
        ...COORDINATES,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            authority.pinned,
            COORDINATES.state_lineage_id,
          ) as unknown as CleanV4Layer1VerifiedEnvelope,
      });

      expect(snapshot.head).toEqual({
        position: 3,
        record_sha256: rejected.record_sha256,
      });
      expect(snapshot.rows).toMatchObject([
        {
          position: 1,
          record_sha256: member.record_sha256,
          classification: {
            kind: "approved",
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            atom_count: 3,
          },
        },
        {
          position: 2,
          record_sha256: restricted.record_sha256,
          classification: {
            kind: "approved",
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
            atom_count: 1,
          },
        },
        {
          position: 3,
          classification: { kind: "rejected" },
        },
      ]);
      expect(snapshot.atoms.map((atom) => atom.text)).toEqual([
        "Decision 0",
        "Action 0",
        "Rationale 0",
        "Decision 0",
      ]);
      expect(
        snapshot.atoms
          .slice(0, 3)
          .every(
            (atom) =>
              atom.reviewer_principal_id === null &&
              atom.reviewer_membership_id === null &&
              atom.provider_action_sha256.startsWith("sha256:") &&
              atom.authorization_proof_sha256.startsWith("sha256:"),
          ),
      ).toBe(true);
      expect(snapshot.atoms[3]).toMatchObject({
        reviewer_principal_id: "principal-1",
        reviewer_membership_id: "membership-1",
      });
      expect(snapshot.upstream_input_sha256).toBe(
        sha256Digest(snapshot.upstream_input_preimage),
      );
    } finally {
      db.close();
    }
  });

  it("rejects a tampered append-atomic Person fact during a V4 snapshot", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      await app.append(
        appendInput({
          authority,
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
      );
      db.exec(
        "DROP TRIGGER organization_record_member_readable_person_fact_immutable_update",
      );
      db.prepare(
        `UPDATE organization_record_member_readable_person_fact
            SET provider_action_sha256 = ? WHERE record_position = 1`,
      ).run(sha256Digest("tampered-provider-action"));
      expect(() =>
        new CleanV4Layer1SnapshotPort(db).snapshot({
          ...COORDINATES,
          verify_envelope: (value) =>
            verifyOrganizationRecordEnvelopeV4(
              value,
              authority.pinned,
              COORDINATES.state_lineage_id,
            ) as unknown as CleanV4Layer1VerifiedEnvelope,
        }),
      ).toThrow("provider action digest");
    } finally {
      db.close();
    }
  });

  it("returns an exact retry without creating another signed V4 envelope or receipt", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const envelope_calls = { value: 0 };
      const sign_calls = { value: 0 };
      const input = appendInput({
        authority,
        envelope_calls,
        receipt: receiptFactory(authority, { sign_calls }),
      });
      const first = await app.append(input);
      expect(await app.append(input)).toEqual({
        ...first,
        outcome: "duplicate",
      });
      expect(envelope_calls.value).toBe(1);
      expect(sign_calls.value).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a reused semantic key before another V4 envelope is created", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const first = appendInput({ authority });
      await app.append(first);
      const calls = { value: 0 };
      await expect(
        app.append(
          appendInput({
            authority,
            approval_id: "other-approval",
            semantic_idempotency_key: first.semantic_idempotency_key,
            envelope_calls: calls,
          }),
        ),
      ).rejects.toBeInstanceOf(V4RecordIdempotencyConflictError);
      expect(calls.value).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recovers a real Receipt V2 after signer failure without another record or seed", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      const committed = db
        .prepare(
          "SELECT receipt_payload FROM organization_record_log WHERE position = 1",
        )
        .get() as { receipt_payload: string };
      const recovered = await new OrganizationRecordV4AppendApplication(
        db,
        COORDINATES,
      ).append(appendInput({ authority }));
      expect(recovered.outcome).toBe("duplicate");
      expect(canonicalJson(recovered.receipt.body as JsonObject)).toBe(
        committed.receipt_payload,
      );
      expect(
        db
          .prepare("SELECT count(*) AS count FROM organization_record_log")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects a malformed pre-stored receipt instead of returning it on recovery", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      db.prepare(
        `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at) VALUES (1, ?, '2026-08-21T12:03:00.000Z')`,
      ).run('{"body":{}}');
      await expect(
        new OrganizationRecordV4AppendApplication(db, COORDINATES).append(
          appendInput({ authority }),
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects a valid Receipt V2 that differs from the committed deterministic seed", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordV4AppendApplication(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      const row = db
        .prepare(
          "SELECT canonical_envelope FROM organization_record_log WHERE position = 1",
        )
        .get() as { canonical_envelope: string };
      const wrongSeedReceipt = await createOrganizationRecordReceiptV2(
        {
          envelope: parseCanonicalJson(row.canonical_envelope) as never,
          record_position: 1,
          issued_at: "2026-08-21T12:04:00.000Z",
        },
        authority.pinned,
        COORDINATES.state_lineage_id,
        authority.sign,
      );
      db.prepare(
        `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at)
        VALUES (1, ?, '2026-08-21T12:04:00.000Z')`,
      ).run(canonicalJson(wrongSeedReceipt));
      await expect(
        new OrganizationRecordV4AppendApplication(db, COORDINATES).append(
          appendInput({ authority }),
        ),
      ).rejects.toThrow("committed receipt seed");
    } finally {
      db.close();
    }
  });
});
