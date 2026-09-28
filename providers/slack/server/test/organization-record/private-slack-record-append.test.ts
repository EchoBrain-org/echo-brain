import {
  sha256Digest,
  canonicalSha256,
  type JsonObject,
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { HUMAN_ACT_RECORD_INPUT_CODEC_V1, createRecordInputCodecRegistryV4, PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, projectMembersReadablePersonPolicyContractSha256 } from "@echo-brain/organization-protocol";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1, SIGNED_SLACK_BLOCK_ACTION_V1_KIND, buildPrivateSlackBlockApprovalRecordInputV1 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND, PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND, buildPrivateSlackBlockApprovalRecordInputV2, privateSlackBlockApprovalConsequenceV2Sha256 } from "../../src/organization-protocol/private-slack-block-approval-record-input-v2.js";
import { createPrivateSlackBlockApprovalPolicyProjectorV1, type RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV2, projectPrivateSlackBlockApprovalApproverV2 } from "../../src/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2.js";
import { resolvePrivateApprovalPolicyV2 } from "../../src/organization-control-plane/application/slack/private-approval-policy-resolution-v2.js";
import { createPrivateSlackBlockV4RecordWriterV1 } from "../../src/processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js";
import { describe, expect, it } from "vitest";
import {
  approvedDecisionSnapshotV2Sha256,
  type HumanActEventV1,
  type PersonContentPolicyIdV2
} from "../../../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4
} from "../../../../../packages/organization-protocol/src/record-envelope-v4.js";
import { resolvePinnedOrganizationAuthority } from "../../../../../packages/organization-protocol/src/authority-descriptor.js";
import {
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
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
import { ApprovedMeetingTranscriptGrantReaderV1 } from "../../../../../packages/organization-record/src/retrieve/approved-meeting-transcript-grant-reader-v1.js";
import { PersonRecordReaderV1 } from "../../../../../packages/organization-record/src/retrieve/person-record-reader-v1.js";
import {
  RecordRetrievalSourceSnapshotPortV1,
  type RecordRetrievalSourceVerifiedEnvelopeV1,
} from "../../../../../packages/organization-record/src/retrieve/record-retrieval-source-snapshot-v1.js";
import { COORDINATES, database, humanAct, policy, processorProvenance, protocolAuthority, receiptFactory, sourceProvenance, type ProtocolAuthority } from "../../../../../packages/organization-record/test/fixtures/record-append-fixture.js";

const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2]);
const PRIVATE_APPROVAL_PROJECTORS = createRecordPolicyFactProjectorRegistryV1([
  createPersonPolicyFactProjectorV2(),
  createPrivateSlackBlockApprovalPolicyProjectorV1(),
  createPrivateSlackBlockApprovalPolicyProjectorV2(),
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
  policy_id: PersonContentPolicyIdV2,
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
  readonly policy_id?: PersonContentPolicyIdV2;
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
  it("accepts the resolver's V2 project consequence through the actual writer and persists its exact grant", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const approval_id = "apr_resolver_writer_v2";
      const snapshot = (humanAct(
        approval_id,
        "approve",
        RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        1,
      ).event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
      const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(snapshot);
      const project = {
        project_id: "prj_11111111-1111-4111-8111-111111111111",
        project_membership_id: "pgm_11111111-1111-4111-8111-111111111111",
        name: "Apollo",
      };
      const transcript_source = {
        source_id: "source_resolver_writer_v2",
        revision_id: "revision_resolver_writer_v2",
        source_sha256: sha256Digest("source-resolver-writer-v2"),
      };
      const owner = { principal_id: "principal-resolver-writer", membership_id: "membership-resolver-writer" };
      const link = {
        provider: "slack" as const,
        external_identity_link_id: "clm_resolver_writer_v2",
        external_identity_link_contract_sha256: sha256Digest("link-resolver-writer-v2"),
        provider_subject_id: "U123",
      };
      const pending = {
        schema_version: 2 as const,
        kind: "echo-private-approval-pending-v2" as const,
        approval_id,
        organization_id: COORDINATES.organization_id,
        candidate_sha256: sha256Digest("candidate-resolver-writer-v2"),
        frozen_card_sha256: sha256Digest("card-resolver-writer-v2"),
        approved_snapshot_sha256,
        assigned_owner: owner,
        assigned_owner_slack_identity_link: link,
        eligible_projects: [project],
        transcript_source,
      };
      const authorization_allow = {
        schema_version: 2 as const,
        kind: "echo-private-approval-authorization-allow-v2" as const,
        approval_id,
        organization_id: COORDINATES.organization_id,
        candidate_sha256: pending.candidate_sha256,
        frozen_card_sha256: pending.frozen_card_sha256,
        approved_snapshot_sha256,
        authorized_assignee: owner,
        current_slack_identity_link: link,
        authorization_proof_sha256: sha256Digest("proof-resolver-writer-v2"),
      };
      const resolution = resolvePrivateApprovalPolicyV2({
        pending,
        command: {
          schema_version: 2,
          command_id: "command-resolver-writer-v2",
          approval_id,
          action: "approve",
          selected_policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
          selected_project_ids: [project.project_id],
          share_transcript: true,
          comment: null,
        },
        authorization_allow,
        selected_projects_current: [project],
      });
      const appender = new OrganizationRecordAppenderV4(
        db,
        COORDINATES,
        PRIVATE_APPROVAL_PROJECTORS,
      );
      const writer = await createPrivateSlackBlockV4RecordWriterV1({
        append: appender,
        signer: {
          inspect: async () => resolvePinnedOrganizationAuthority(authority.pinned),
          sign: authority.sign,
        },
        state_lineage_id: COORDINATES.state_lineage_id,
        now: () => "2026-08-21T12:04:00.000Z",
        next_envelope_id: () => "envelope-resolver-writer-v2",
      });

      await expect(writer.appendApprovedV2({
        outcome: "approved",
        signed_action_receipt_sha256: sha256Digest("signed-action-resolver-writer-v2"),
        resolution,
        audit: {
          audit_event_id: "audit-resolver-writer-v2",
          audit_sequence: 1,
          approval_id,
          outcome: "approved",
        },
      }, {
        ...COORDINATES,
        approval_id,
        candidate_sha256: pending.candidate_sha256,
        frozen_card_sha256: pending.frozen_card_sha256,
        approved_snapshot: snapshot,
        approved_snapshot_sha256,
        source_provenance: sourceProvenance(),
        processor_provenance: processorProvenance(),
      })).resolves.toMatchObject({ outcome: "appended", position: 1 });

      expect(new ApprovedMeetingTranscriptGrantReaderV1(db).find({
        ...COORDINATES,
        approval_id,
      })).toMatchObject({
        source_id: transcript_source.source_id,
        revision_id: transcript_source.revision_id,
        source_sha256: transcript_source.source_sha256,
        audience_project_ids: [project.project_id],
        association_project_ids: [project.project_id],
      });
    } finally {
      db.close();
    }
  });

  it("projects a real V2 project approval into the current-project union and only grants its opted-in exact transcript", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const approval_id = "private-v2-project";
      const legacy = humanAct(approval_id, "approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, 1);
      const snapshot = (legacy.event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
      const transcript_source = { source_id: "source_v2", revision_id: "revision_v2", source_sha256: sha256Digest("source-v2") };
      const consequence = { schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND,
        policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
        audience_project_ids: ["prj_00000000-0000-4000-8000-000000000011", "prj_00000000-0000-4000-8000-000000000012"],
        association_project_ids: ["prj_00000000-0000-4000-8000-000000000011", "prj_00000000-0000-4000-8000-000000000012"], share_transcript: true, transcript_source };
      const consequence_sha256 = privateSlackBlockApprovalConsequenceV2Sha256(consequence);
      const ref = { schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
        ...COORDINATES, command_id: "command-v2-project", approval_id, candidate_sha256: sha256Digest("candidate-v2"), frozen_card_sha256: sha256Digest("card-v2"),
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot), final_approver: { principal_id: "principal-1", membership_id: "membership-1" },
        current_slack_identity_link: { provider: "slack" as const, external_identity_link_id: "clm_v2", external_identity_link_contract_sha256: sha256Digest("link-v2"), provider_subject_id: "U123" },
        action: "approve" as const, selected_policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
        policy_contract_sha256: projectMembersReadablePersonPolicyContractSha256(), policy_consequence_sha256: consequence_sha256, comment: null,
        audit_event_id: "audit-v2", audit_sequence: 1, audit_entry_sha256: canonicalSha256({ authority_id: COORDINATES.authority_id, organization_id: COORDINATES.organization_id, state_lineage_id: COORDINATES.state_lineage_id, audit_event_id: "audit-v2", audit_sequence: 1, actor_class: "provider_human", principal_id: "principal-1", membership_id: "membership-1", action: "approve", subject_kind: "approval", subject_id: approval_id, detail_digest: sha256Digest("proof-v2"), provider_action_sha256: sha256Digest("action-v2") }), provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
        provider_action_schema_version: 1 as const, provider_action_sha256: sha256Digest("action-v2"), authorization_proof_sha256: sha256Digest("proof-v2"),
        audience_project_ids: consequence.audience_project_ids, association_project_ids: consequence.association_project_ids, share_transcript: true, transcript_source };
      const human = buildPrivateSlackBlockApprovalRecordInputV2({ private_slack_block_approval_resolution_ref_v2: ref,
        event: { kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot), policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
          policy_contract_sha256: ref.policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256: consequence_sha256 } });
      expect(() => buildPrivateSlackBlockApprovalRecordInputV2({
        private_slack_block_approval_resolution_ref_v2: { ...ref, audience_project_ids: [] },
        event: human.event,
      })).toThrow(/project/i);
      expect(() => buildPrivateSlackBlockApprovalRecordInputV2({
        private_slack_block_approval_resolution_ref_v2: {
          ...ref,
          audience_project_ids: ["prj_not-a-uuid", ref.audience_project_ids[1]!],
        },
        event: human.event,
      })).toThrow(/canonical project ID/i);
      expect(() => buildPrivateSlackBlockApprovalRecordInputV2({
        private_slack_block_approval_resolution_ref_v2: { ...ref, transcript_source: { ...transcript_source, source_sha256: "sha256:bad" as Sha256Digest } },
        event: human.event,
      })).toThrow(/source/i);
      const v2Envelope = {
        body: {
          authority_id: COORDINATES.authority_id,
          organization_id: COORDINATES.organization_id,
          state_lineage_id: COORDINATES.state_lineage_id,
          human_act_resolution_ref: human.private_slack_block_approval_resolution_ref_v2,
          event: human.event,
        },
      } as unknown as JsonObject;
      expect(projectPrivateSlackBlockApprovalApproverV2(v2Envelope)).toEqual({
        authority_id: COORDINATES.authority_id,
        organization_id: COORDINATES.organization_id,
        state_lineage_id: COORDINATES.state_lineage_id,
        approval_id,
        principal_id: "principal-1",
        membership_id: "membership-1",
      });
      expect(projectPrivateSlackBlockApprovalApproverV2({
        ...v2Envelope,
        body: { ...(v2Envelope.body as JsonObject), organization_id: "other-organization" },
      })).toBeUndefined();
      const witness = { authorization_allow: { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id,
        action: "approve" as const, final_approver: ref.final_approver, selected_policy_id: ref.selected_policy_id, policy_contract_sha256: ref.policy_contract_sha256,
        policy_consequence_sha256: consequence_sha256, audience_project_ids: ref.audience_project_ids, association_project_ids: ref.association_project_ids, share_transcript: true, transcript_source,
        provider_action_sha256: ref.provider_action_sha256, decision: "allow" as const }, authorization_proof_sha256: ref.authorization_proof_sha256,
        provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1 as const,
        audit_entry: { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, audit_event_id: ref.audit_event_id, audit_sequence: 1,
          actor_class: "provider_human" as const, principal_id: "principal-1", membership_id: "membership-1", action: "approve" as const, subject_kind: "approval" as const, subject_id: approval_id,
          detail_digest: ref.authorization_proof_sha256, provider_action_sha256: ref.provider_action_sha256 }, audit_entry_sha256: ref.audit_entry_sha256 };
      const app = new OrganizationRecordAppenderV4(db, COORDINATES, PRIVATE_APPROVAL_PROJECTORS);
      await app.append({ approval_id, action: "approve", semantic_idempotency_key: human.semantic_idempotency_key, receipt_issued_at: "2026-08-21T12:02:00.000Z", authorization_witness: witness,
        envelope_factory: { create: async allocation => createOrganizationRecordEnvelopeV4({ envelope_id: "envelope-v2", issued_at: "2026-08-21T12:02:00.000Z", predecessor_position: allocation.predecessor_position, predecessor_record_sha256: allocation.predecessor_record_sha256,
          human_act_record_input: { private_slack_block_approval_resolution_ref_v2: human.private_slack_block_approval_resolution_ref_v2, event: human.event }, source_provenance: sourceProvenance(), processor_provenance: processorProvenance() }, authority.pinned, COORDINATES.state_lineage_id, authority.sign, RECORD_INPUT_CODECS) as unknown as JsonObject,
          verify: value => verifyOrganizationRecordEnvelopeV4(value, authority.pinned, COORDINATES.state_lineage_id, RECORD_INPUT_CODECS) as unknown as V4RecordEnvelopeView & JsonObject },
        receipt_factory: receiptFactory(authority, { sign_calls: { value: 0 } }, RECORD_INPUT_CODECS) });
      const offApprovalId = "private-v2-project-off";
      const offLegacy = humanAct(offApprovalId, "approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, 1);
      const offSnapshot = (offLegacy.event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
      const offConsequence = { ...consequence, share_transcript: false };
      const offConsequenceSha256 = privateSlackBlockApprovalConsequenceV2Sha256(offConsequence);
      const offAudit = { ...witness.audit_entry, audit_event_id: "audit-v2-off", subject_id: offApprovalId };
      const offAuditSha256 = canonicalSha256(offAudit);
      const offRef = { ...ref, command_id: "command-v2-project-off", approval_id: offApprovalId, candidate_sha256: sha256Digest("candidate-v2-off"), frozen_card_sha256: sha256Digest("card-v2-off"), approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(offSnapshot), policy_consequence_sha256: offConsequenceSha256, audit_event_id: "audit-v2-off", audit_entry_sha256: offAuditSha256, share_transcript: false };
      const offHuman = buildPrivateSlackBlockApprovalRecordInputV2({ private_slack_block_approval_resolution_ref_v2: offRef, event: { kind: "approved", approved_snapshot: offSnapshot, approved_snapshot_sha256: offRef.approved_snapshot_sha256, policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, policy_contract_sha256: offRef.policy_contract_sha256, policy_consequence: offConsequence, policy_consequence_sha256: offConsequenceSha256 } });
      const offWitness = { ...witness, authorization_allow: { ...witness.authorization_allow, approval_id: offApprovalId, policy_consequence_sha256: offConsequenceSha256, share_transcript: false }, audit_entry: offAudit, audit_entry_sha256: offAuditSha256 };
      await app.append({ approval_id: offApprovalId, action: "approve", semantic_idempotency_key: offHuman.semantic_idempotency_key, receipt_issued_at: "2026-08-21T12:03:00.000Z", authorization_witness: offWitness,
        envelope_factory: { create: async allocation => createOrganizationRecordEnvelopeV4({ envelope_id: "envelope-v2-off", issued_at: "2026-08-21T12:03:00.000Z", predecessor_position: allocation.predecessor_position, predecessor_record_sha256: allocation.predecessor_record_sha256, human_act_record_input: { private_slack_block_approval_resolution_ref_v2: offHuman.private_slack_block_approval_resolution_ref_v2, event: offHuman.event }, source_provenance: sourceProvenance(), processor_provenance: processorProvenance() }, authority.pinned, COORDINATES.state_lineage_id, authority.sign, RECORD_INPUT_CODECS) as unknown as JsonObject, verify: value => verifyOrganizationRecordEnvelopeV4(value, authority.pinned, COORDINATES.state_lineage_id, RECORD_INPUT_CODECS) as unknown as V4RecordEnvelopeView & JsonObject }, receipt_factory: receiptFactory(authority, { sign_calls: { value: 0 } }, RECORD_INPUT_CODECS) });
      expect(new ApprovedMeetingTranscriptGrantReaderV1(db).find({ ...COORDINATES, approval_id: offApprovalId })).toBeNull();
      expect(new PersonRecordReaderV1(db).list({ ...COORDINATES, principal_id: "member", membership_id: "m", project_ids: ["prj_00000000-0000-4000-8000-000000000012"] })).toHaveLength(2);
      expect(new PersonRecordReaderV1(db).list({ ...COORDINATES, principal_id: "member", membership_id: "m", project_ids: ["prj_00000000-0000-4000-8000-000000000013"] })).toHaveLength(0);
      expect(new ApprovedMeetingTranscriptGrantReaderV1(db).find({ ...COORDINATES, approval_id })).toMatchObject({ source_id: transcript_source.source_id, audience_project_ids: ["prj_00000000-0000-4000-8000-000000000011", "prj_00000000-0000-4000-8000-000000000012"] });
    } finally { db.close(); }
  });
  it("append-atomically projects a signed private Block Kit approval and retries it without a second envelope", async () => {
    const db = database();
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
    const db = database();
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
