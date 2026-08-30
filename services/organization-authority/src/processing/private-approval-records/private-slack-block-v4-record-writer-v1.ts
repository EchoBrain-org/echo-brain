import { canonicalSha256, type JsonObject, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  buildPrivateSlackBlockApprovalRecordInputV1,
  createOrganizationRecordEnvelopeV4,
  createOrganizationRecordReceiptV2,
  organizationAuthorityPinSha256,
  validateDecisionProcessorProvenanceV1,
  validateMeetingSourceProvenanceV1,
  verifyOrganizationAuthorityPin,
  verifyOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordReceiptV2,
  validateOrganizationRecordReceiptBodyV2,
} from "@echo-brain/organization-protocol";
import type {
  DecisionProcessorProvenanceV1,
  MeetingSourceProvenanceV1,
  PinnedOrganizationAuthority,
} from "@echo-brain/organization-protocol";
import {
  OrganizationRecordAppenderV4,
  type AppendedV4Record,
  type RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView,
} from "@echo-brain/organization-record/organization-record-api-v1";
import type { OrganizationAuthoritySigner } from "../../application/ports/runtime-ports.js";

/** Authority-owned frozen candidate, re-read before a terminal V4 append. */
export interface FrozenPrivateSlackApprovalCandidateV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly candidate_sha256: Sha256Digest;
  readonly frozen_card_sha256: Sha256Digest;
  readonly approved_snapshot: unknown;
  readonly approved_snapshot_sha256: Sha256Digest;
  readonly source_provenance: MeetingSourceProvenanceV1;
  readonly processor_provenance: DecisionProcessorProvenanceV1;
}

/**
 * Authority-local structural view of the durable CP terminal. Keeping this
 * leaf independent of the CP package preserves the clean record-writer
 * boundary; composition is responsible for adapting the validated CP body.
 */
export interface PrivateSlackBlockApprovalTerminalV1 {
  readonly outcome: "approved" | "rejected";
  readonly signed_action_receipt_sha256: Sha256Digest;
  readonly resolution: {
    readonly command_id: string;
    readonly approval_id: string;
    readonly organization_id: string;
    readonly candidate_sha256: Sha256Digest;
    readonly frozen_card_sha256: Sha256Digest;
    readonly approved_snapshot_sha256: Sha256Digest;
    readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
    readonly current_slack_identity_link: {
      readonly provider: "slack";
      readonly external_identity_link_id: string;
      readonly external_identity_link_contract_sha256: Sha256Digest;
      readonly provider_subject_id: string;
    };
    readonly authorization_proof_sha256: Sha256Digest;
    readonly action: "approve" | "reject";
    readonly comment: string | null;
    readonly canonical_record_policy: {
      readonly policy_id:
        | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
        | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
      readonly policy_contract_sha256: Sha256Digest;
      readonly policy_consequence_sha256: Sha256Digest;
      readonly restricted_reader: { readonly principal_id: string; readonly membership_id: string } | null;
    } | null;
  };
  readonly audit: {
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly approval_id: string;
    readonly outcome: "approved" | "rejected";
  };
}

export interface PrivateSlackBlockV4RecordWriterV1Options {
  readonly append: OrganizationRecordAppenderV4;
  readonly signer: OrganizationAuthoritySigner;
  readonly pinned_authority: PinnedOrganizationAuthority;
  readonly state_lineage_id: string;
  readonly now: () => string;
  readonly next_envelope_id: () => string;
}

function timestamp(value: string): void {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error("private Block Kit V4 issuance time must be canonical UTC");
  }
}

function policyText(policyId: string): string {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    return RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT;
  }
  if (policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) {
    return ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT;
  }
  throw new Error("private terminal has an unsupported selected policy");
}

function resolutionAndCandidateMatch(
  terminal: PrivateSlackBlockApprovalTerminalV1,
  candidate: FrozenPrivateSlackApprovalCandidateV1,
  lineage: string,
): asserts terminal is PrivateSlackBlockApprovalTerminalV1 & {
  readonly outcome: "approved";
    readonly resolution: PrivateSlackBlockApprovalTerminalV1["resolution"] & {
    readonly action: "approve";
    readonly canonical_record_policy: NonNullable<PrivateSlackBlockApprovalTerminalV1["resolution"]["canonical_record_policy"]>;
  };
} {
  const resolution = terminal.resolution;
  if (
    terminal.outcome !== "approved" ||
    resolution.action !== "approve" ||
    resolution.canonical_record_policy === null
  ) {
    throw new Error("private rejection must not append a V4 record");
  }
  if (
    candidate.state_lineage_id !== lineage ||
    candidate.approval_id !== resolution.approval_id ||
    candidate.organization_id !== resolution.organization_id ||
    candidate.candidate_sha256 !== resolution.candidate_sha256 ||
    candidate.frozen_card_sha256 !== resolution.frozen_card_sha256 ||
    candidate.approved_snapshot_sha256 !== resolution.approved_snapshot_sha256 ||
    canonicalSha256(candidate.approved_snapshot) !== candidate.approved_snapshot_sha256
  ) {
    throw new Error("private terminal does not match the frozen Authority candidate");
  }
}

/**
 * Unwired Authority leaf for the private approved path. It accepts only a
 * durable CP terminal and a re-read frozen Authority candidate.
 */
export class PrivateSlackBlockV4RecordWriterV1 {
  constructor(private readonly options: PrivateSlackBlockV4RecordWriterV1Options) {}

  async appendApproved(
    terminal: PrivateSlackBlockApprovalTerminalV1,
    candidate: FrozenPrivateSlackApprovalCandidateV1,
  ): Promise<AppendedV4Record> {
    resolutionAndCandidateMatch(terminal, candidate, this.options.state_lineage_id);
    const resolution = terminal.resolution;
    const policy = resolution.canonical_record_policy;
    const source = validateMeetingSourceProvenanceV1(candidate.source_provenance);
    const processor = validateDecisionProcessorProvenanceV1(candidate.processor_provenance);
    if (
      candidate.authority_id !== source.authority_id ||
      candidate.organization_id !== source.organization_id ||
      candidate.state_lineage_id !== source.state_lineage_id ||
      source.authority_id !== processor.authority_id ||
      source.organization_id !== processor.organization_id ||
      source.state_lineage_id !== processor.state_lineage_id
    ) {
      throw new Error("private terminal candidate has mixed provenance coordinates");
    }
    const auditEntrySha256 = canonicalSha256(terminal.audit);
    const human = buildPrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: {
        schema_version: 1,
        kind: "echo-private-slack-block-approval-resolution-ref-v1",
        authority_id: candidate.authority_id,
        organization_id: candidate.organization_id,
        state_lineage_id: candidate.state_lineage_id,
        command_id: resolution.command_id,
        approval_id: resolution.approval_id,
        candidate_sha256: resolution.candidate_sha256,
        frozen_card_sha256: resolution.frozen_card_sha256,
        approved_snapshot_sha256: resolution.approved_snapshot_sha256,
        final_approver: resolution.final_approver,
        current_slack_identity_link: resolution.current_slack_identity_link,
        action: "approve",
        selected_policy_id: policy.policy_id,
        policy_contract_sha256: policy.policy_contract_sha256,
        policy_consequence_sha256: policy.policy_consequence_sha256,
        comment: resolution.comment,
        audit_event_id: terminal.audit.audit_event_id,
        audit_sequence: terminal.audit.audit_sequence,
        audit_entry_sha256: auditEntrySha256,
        provider_action_kind: "echo-signed-slack-block-action-v1",
        provider_action_schema_version: 1,
        provider_action_sha256: terminal.signed_action_receipt_sha256,
        authorization_proof_sha256: resolution.authorization_proof_sha256,
      },
      event: {
        kind: "approved",
        approved_snapshot: candidate.approved_snapshot as never,
        approved_snapshot_sha256: candidate.approved_snapshot_sha256,
        policy_id: policy.policy_id,
        policy_contract_sha256: policy.policy_contract_sha256,
        policy_consequence_text: policyText(policy.policy_id),
        policy_consequence_sha256: policy.policy_consequence_sha256,
      },
    });
    const authorizationWitness: RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1 = {
      authorization_allow: {
        authority_id: candidate.authority_id,
        organization_id: candidate.organization_id,
        state_lineage_id: candidate.state_lineage_id,
        approval_id: resolution.approval_id,
        action: "approve",
        final_approver: resolution.final_approver,
        selected_policy_id: policy.policy_id,
        policy_contract_sha256: policy.policy_contract_sha256,
        provider_action_sha256: terminal.signed_action_receipt_sha256,
        decision: "allow",
      },
      authorization_proof_sha256: resolution.authorization_proof_sha256,
      provider_action_kind: "echo-signed-slack-block-action-v1",
      provider_action_schema_version: 1,
      audit_entry: {
        authority_id: candidate.authority_id,
        organization_id: candidate.organization_id,
        state_lineage_id: candidate.state_lineage_id,
        audit_event_id: terminal.audit.audit_event_id,
        audit_sequence: terminal.audit.audit_sequence,
        actor_class: "provider_human",
        principal_id: resolution.final_approver.principal_id,
        membership_id: resolution.final_approver.membership_id,
        action: "approve",
        subject_kind: "approval",
        subject_id: resolution.approval_id,
        detail_digest: resolution.authorization_proof_sha256,
        provider_action_sha256: terminal.signed_action_receipt_sha256,
      },
      audit_entry_sha256: auditEntrySha256,
    };
    const issuedAt = this.options.now();
    timestamp(issuedAt);
    return this.options.append.append({
      approval_id: resolution.approval_id,
      action: "approve",
      semantic_idempotency_key: human.semantic_idempotency_key,
      receipt_issued_at: issuedAt,
      authorization_witness: authorizationWitness,
      envelope_factory: this.envelopeFactory({
        human_act_record_input: {
          private_slack_block_approval_resolution_ref:
            human.private_slack_block_approval_resolution_ref,
          event: human.event,
        },
        source_provenance: source,
        processor_provenance: processor,
        issued_at: issuedAt,
      }),
      receipt_factory: this.receiptFactory(),
    });
  }

  private envelopeFactory(input: {
    readonly human_act_record_input: Parameters<typeof createOrganizationRecordEnvelopeV4>[0]["human_act_record_input"];
    readonly source_provenance: MeetingSourceProvenanceV1;
    readonly processor_provenance: DecisionProcessorProvenanceV1;
    readonly issued_at: string;
  }): V4RecordEnvelopeFactory {
    return {
      create: async (allocation) =>
        (await createOrganizationRecordEnvelopeV4(
          {
            envelope_id: this.options.next_envelope_id(),
            issued_at: input.issued_at,
            predecessor_position: allocation.predecessor_position,
            predecessor_record_sha256: allocation.predecessor_record_sha256,
            human_act_record_input: input.human_act_record_input,
            source_provenance: input.source_provenance,
            processor_provenance: input.processor_provenance,
          },
          this.options.pinned_authority,
          this.options.state_lineage_id,
          (message, expectedKeyId) => this.options.signer.sign(message, expectedKeyId),
        )) as unknown as JsonObject,
      verify: (value) =>
        verifyOrganizationRecordEnvelopeV4(
          value,
          this.options.pinned_authority,
          this.options.state_lineage_id,
        ) as unknown as V4RecordEnvelopeView & JsonObject,
    };
  }

  private receiptFactory(): V4ReceiptFactory {
    return {
      createSeed: ({ envelope, position, issued_at, policy_fact_outcome }) =>
        validateOrganizationRecordReceiptBodyV2({
          schema_version: 2, kind: "echo-organization-record-receipt-v2",
          authority_id: envelope.body.authority_id, organization_id: envelope.body.organization_id,
          state_lineage_id: envelope.body.state_lineage_id, envelope_id: envelope.body.envelope_id,
          semantic_idempotency_key: envelope.body.semantic_idempotency_key, event_kind: envelope.body.event.kind,
          record_position: position, record_sha256: envelope.record_sha256,
          predecessor_record_sha256: envelope.body.predecessor_record_sha256,
          record_head_position: position, record_head_sha256: envelope.record_sha256,
          issued_at, policy_fact_outcome,
        }) as unknown as JsonObject,
      sign: async ({ envelope, receipt_seed }) =>
        (await createOrganizationRecordReceiptV2({
          envelope: envelope as never,
          record_position: envelope.body.predecessor_position === null ? 1 : envelope.body.predecessor_position + 1,
          issued_at: (receipt_seed as { readonly issued_at: string }).issued_at,
        }, this.options.pinned_authority, this.options.state_lineage_id,
        (message, expectedKeyId) => this.options.signer.sign(message, expectedKeyId))) as unknown as JsonObject,
      verify: ({ receipt, envelope }) =>
        verifyOrganizationRecordReceiptV2(receipt, envelope as never, this.options.pinned_authority, this.options.state_lineage_id) as unknown as JsonObject,
    };
  }
}

export async function createPrivateSlackBlockV4RecordWriterV1(input: {
  readonly append: OrganizationRecordAppenderV4;
  readonly signer: OrganizationAuthoritySigner;
  readonly state_lineage_id: string;
  readonly now?: () => string;
  readonly next_envelope_id: () => string;
}): Promise<PrivateSlackBlockV4RecordWriterV1> {
  const descriptor = await input.signer.inspect();
  return new PrivateSlackBlockV4RecordWriterV1({
    append: input.append, signer: input.signer,
    pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)),
    state_lineage_id: input.state_lineage_id,
    now: input.now ?? (() => new Date().toISOString()),
    next_envelope_id: input.next_envelope_id,
  });
}
