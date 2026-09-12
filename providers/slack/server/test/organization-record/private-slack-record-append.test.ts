import {
  sha256Digest,
  type JsonObject,
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { HUMAN_ACT_RECORD_INPUT_CODEC_V1, createRecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1, SIGNED_SLACK_BLOCK_ACTION_V1_KIND, buildPrivateSlackBlockApprovalRecordInputV1 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV1, type RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import { describe, expect, it } from "vitest";
import {
  approvedDecisionSnapshotV2Sha256,
  type HumanActEventV1
} from "../../../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4
} from "../../../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonPolicyIdV2
} from "../../../../../packages/organization-record/src/application/person-policy-fact-contracts-v2.js";
import {
  createPersonPolicyFactProjectorV2,
  type PersonHumanActActionV2
} from "../../../../../packages/organization-record/src/application/person-policy-facts-v2.js";
import {
  createRecordPolicyFactProjectorRegistryV1
} from "../../../../../packages/organization-record/src/application/record-policy-fact-projection-v1.js";
import {
  OrganizationRecordAppenderV4,
  type AppendV4RecordInput,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView
} from "../../../../../packages/organization-record/src/log/record-log-v4-append.js";
import {
  RecordRetrievalSourceSnapshotPortV1,
  type RecordRetrievalSourceVerifiedEnvelopeV1,
} from "../../../../../packages/organization-record/src/retrieve/record-retrieval-source-snapshot-v1.js";
import { COORDINATES, database, humanAct, policy, processorProvenance, protocolAuthority, receiptFactory, sourceProvenance, type ProtocolAuthority } from "../../../../../packages/organization-record/test/fixtures/record-append-fixture.js";

const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1]);
const PRIVATE_APPROVAL_PROJECTORS = createRecordPolicyFactProjectorRegistryV1([
  createPersonPolicyFactProjectorV2(),
  createPrivateSlackBlockApprovalPolicyProjectorV1(),
]);

function privateApprovalAppend(
  db: ReturnType<typeof database>,
): OrganizationRecordAppenderV4 {
  return new OrganizationRecordAppenderV4(
    db,
    COORDINATES,
    PRIVATE_APPROVAL_PROJECTORS,
  );
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

function privateSlackBlockAuthorizationWitness(
  human: ReturnType<typeof privateSlackBlockHumanAct>,
): RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1 {
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
    authorization_witness: privateSlackBlockAuthorizationWitness(human),
    envelope_factory: privateSlackBlockEnvelopeFactory(
      input.authority,
      human,
      input.envelope_calls ?? { value: 0 },
    ),
    receipt_factory:
      input.receipt ??
      receiptFactory(input.authority, { sign_calls: { value: 0 } }, RECORD_INPUT_CODECS),
  };
}
describe("Private Slack V4 record append", () => {
  it("append-atomically projects a signed private Block Kit approval and retries it without a second envelope", async () => {
    const db = database(2);
    try {
      const authority = protocolAuthority();
      const app = privateApprovalAppend(db);
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
      const sourceSnapshot = new RecordRetrievalSourceSnapshotPortV1(
        db,
      ).snapshot({
        ...COORDINATES,
        policy_projectors: PRIVATE_APPROVAL_PROJECTORS,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            authority.pinned,
            COORDINATES.state_lineage_id, RECORD_INPUT_CODECS,
          ) as unknown as RecordRetrievalSourceVerifiedEnvelopeV1,
      });
      expect(sourceSnapshot.atoms).toHaveLength(2);
      expect(sourceSnapshot.rows[0]?.classification).toEqual({
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
      const app = privateApprovalAppend(db);
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
});
