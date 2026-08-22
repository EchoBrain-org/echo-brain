import {
  createOrganizationRecordEnvelopeV4,
  createOrganizationRecordReceiptV2,
  organizationAuthorityPinSha256,
  validateDecisionProcessorProvenanceV1,
  validateHumanActRecordInputV1,
  validateMeetingSourceProvenanceV1,
  verifyOrganizationRecordEnvelopeV4,
  validateOrganizationRecordReceiptBodyV2,
  verifyOrganizationAuthorityPin,
  verifyOrganizationRecordReceiptV2,
} from "@echo-brain/organization-protocol";
import type {
  DecisionProcessorProvenanceV1,
  HumanActRecordInputV1,
  MeetingSourceProvenanceV1,
  PinnedOrganizationAuthority,
} from "@echo-brain/organization-protocol";
import type { JsonObject } from "@echo-brain/federation-protocol";
import {
  OrganizationRecordV4AppendApplication,
  type AppendedV4Record,
  type ReprovedPersonPolicyD2WitnessV2,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView,
} from "@echo-brain/organization-record/new-lineage-v1";
import type { OrganizationAuthoritySigner } from "../../application/ports/runtime-ports.js";

/**
 * The re-proved D2 decision plus the frozen source/processor facts that make
 * up one V4 record. This is deliberately an Authority-private handoff: D2
 * owns finalizing the Slack act; D3 only accepts a witness that its caller has
 * already recovered and re-proved from the immutable D2 state.
 */
export interface FinalizedCleanD2RecordWitnessV1 {
  readonly d2_witness: ReprovedPersonPolicyD2WitnessV2;
  readonly human_act_record_input: HumanActRecordInputV1;
  readonly source_provenance: MeetingSourceProvenanceV1;
  readonly processor_provenance: DecisionProcessorProvenanceV1;
}

export interface CleanV4RecordWriterV1Options {
  readonly append: OrganizationRecordV4AppendApplication;
  readonly signer: OrganizationAuthoritySigner;
  readonly pinned_authority: PinnedOrganizationAuthority;
  readonly state_lineage_id: string;
  readonly now: () => string;
  readonly next_envelope_id: () => string;
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
}

function sameD2Witness(
  witness: ReprovedPersonPolicyD2WitnessV2,
  human: HumanActRecordInputV1,
): void {
  const ref = human.human_act_resolution_ref;
  const allow = witness.authorization_allow;
  const audit = witness.audit_entry;
  if (
    allow.decision !== "allow" ||
    allow.authority_id !== ref.authority_id ||
    allow.organization_id !== ref.organization_id ||
    allow.state_lineage_id !== ref.state_lineage_id ||
    allow.approval_id !== ref.approval_id ||
    allow.action !== ref.action ||
    allow.policy_id !== ref.policy_id ||
    allow.policy_contract_sha256 !== ref.policy_contract_sha256 ||
    allow.provider_action_sha256 !== ref.provider_action_sha256 ||
    witness.authorization_proof_sha256 !== ref.authorization_proof_sha256 ||
    witness.provider_action_kind !== ref.provider_action_kind ||
    witness.provider_action_schema_version !==
      ref.provider_action_schema_version ||
    audit.authority_id !== ref.authority_id ||
    audit.organization_id !== ref.organization_id ||
    audit.state_lineage_id !== ref.state_lineage_id ||
    audit.audit_event_id !== ref.audit_event_id ||
    audit.audit_sequence !== ref.audit_sequence ||
    witness.audit_entry_sha256 !== ref.audit_entry_sha256 ||
    audit.actor_class !== "provider_human" ||
    audit.principal_id !== allow.principal_id ||
    audit.membership_id !== allow.membership_id ||
    audit.action !== ref.action ||
    audit.subject_kind !== "approval" ||
    audit.subject_id !== ref.approval_id ||
    audit.provider_action_sha256 !== ref.provider_action_sha256
  ) {
    throw new Error("finalized D2 witness does not bind the human act record");
  }
}

/**
 * Builds only real protocol V4 envelopes and Receipt V2 wrappers. The record
 * workspace owns append serialization and atomic fact persistence; this
 * Authority leaf supplies the clean authority signing boundary and checks the
 * D2 witness cannot drift from its frozen human act.
 */
export class CleanV4RecordWriterV1 {
  constructor(private readonly options: CleanV4RecordWriterV1Options) {}

  async appendFinalized(
    witness: FinalizedCleanD2RecordWitnessV1,
  ): Promise<AppendedV4Record> {
    const human = validateHumanActRecordInputV1(witness.human_act_record_input);
    const source = validateMeetingSourceProvenanceV1(witness.source_provenance);
    const processor = validateDecisionProcessorProvenanceV1(
      witness.processor_provenance,
    );
    const ref = human.human_act_resolution_ref;
    if (
      ref.state_lineage_id !== this.options.state_lineage_id ||
      source.authority_id !== ref.authority_id ||
      source.organization_id !== ref.organization_id ||
      source.state_lineage_id !== ref.state_lineage_id ||
      processor.authority_id !== ref.authority_id ||
      processor.organization_id !== ref.organization_id ||
      processor.state_lineage_id !== ref.state_lineage_id
    ) {
      throw new Error("clean V4 record witness has mixed lineage coordinates");
    }
    sameD2Witness(witness.d2_witness, human);
    const issuedAt = this.options.now();
    assertTimestamp(issuedAt, "clean V4 record issuance time");
    const envelopeFactory = this.envelopeFactory({
      human_act_record_input: human,
      source_provenance: source,
      processor_provenance: processor,
      issued_at: issuedAt,
    });
    return await this.options.append.append({
      approval_id: ref.approval_id,
      action: ref.action,
      semantic_idempotency_key: human.semantic_idempotency_key,
      receipt_issued_at: issuedAt,
      d2_witness: witness.d2_witness,
      envelope_factory: envelopeFactory,
      receipt_factory: this.receiptFactory(),
    });
  }

  private envelopeFactory(input: {
    readonly human_act_record_input: HumanActRecordInputV1;
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
          (message, expectedKeyId) =>
            this.options.signer.sign(message, expectedKeyId),
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
        }) as unknown as JsonObject,
      sign: async ({ envelope, receipt_seed }) =>
        (await createOrganizationRecordReceiptV2(
          {
            envelope: envelope as never,
            record_position:
              envelope.body.predecessor_position === null
                ? 1
                : envelope.body.predecessor_position + 1,
            issued_at: (receipt_seed as { readonly issued_at: string })
              .issued_at,
          },
          this.options.pinned_authority,
          this.options.state_lineage_id,
          (message, expectedKeyId) =>
            this.options.signer.sign(message, expectedKeyId),
        )) as unknown as JsonObject,
      verify: ({ receipt, envelope }) =>
        verifyOrganizationRecordReceiptV2(
          receipt,
          envelope as never,
          this.options.pinned_authority,
          this.options.state_lineage_id,
        ) as unknown as JsonObject,
    };
  }
}

/** A tiny checked constructor keeps the signer descriptor pinned at wiring. */
export async function createCleanV4RecordWriterV1(input: {
  readonly append: OrganizationRecordV4AppendApplication;
  readonly signer: OrganizationAuthoritySigner;
  readonly state_lineage_id: string;
  readonly now?: () => string;
  readonly next_envelope_id: () => string;
}): Promise<CleanV4RecordWriterV1> {
  const descriptor = await input.signer.inspect();
  return new CleanV4RecordWriterV1({
    append: input.append,
    signer: input.signer,
    pinned_authority: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
    state_lineage_id: input.state_lineage_id,
    now: input.now ?? (() => new Date().toISOString()),
    next_envelope_id: input.next_envelope_id,
  });
}
