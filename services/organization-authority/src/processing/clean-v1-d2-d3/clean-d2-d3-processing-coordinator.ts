import {
  canonicalSha256,
  type JsonObject,
} from "@echo-brain/federation-protocol";
import {
  buildProviderHumanActionDurableResult,
  buildProviderHumanSemanticActionInputV1,
  finalizePersonSlackApprovalV2,
  validateProviderHumanActionDurableResult,
  validateProviderHumanAuthorizationAllowV2,
  validateProviderHumanIntegrationAuditEntryV2,
  validateProviderHumanSemanticActionInputV1,
  type ApprovalContractSha256,
  type PersonSlackApprovalFinalizationCodecV2,
  type PersonSlackApprovalFinalizationCoordinatorV2,
  type PersonSlackApprovalFinalizationIdFactoryV2,
  type PersonSlackApprovalObserverV2,
  type StoredProviderHumanActionV2,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  buildHumanActRecordInputV1,
  validateDecisionProcessorProvenanceV1,
  validateMeetingSourceProvenanceV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  type HumanActRecordInputV1,
} from "@echo-brain/organization-protocol";
import type {
  AppendedV4Record,
  ReprovedPersonPolicyD2WitnessV2,
} from "@echo-brain/organization-record/new-lineage-v1";
import type { DecisionSet, MeetingDocument } from "../core/index.js";
import type { CleanGranolaSourceAdmissionV1 } from "../clean-v1/live-only-source-cycle.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../clean-v1/sqlite-live-only-source-state.js";
import {
  type CleanV4RecordWriterV1,
  type FinalizedCleanD2RecordWitnessV1,
} from "../clean-v1-record/clean-v4-record-writer.js";

/**
 * The Authority-owned counterpart of an already posted, D2-staged card. The
 * snapshot is the exact immutable value whose digest was committed in D2; it
 * is not regenerated from a current source or current processor.
 */
export interface FrozenCleanD2ToD3CandidateV1 {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly approval_id: string;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot: unknown;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly control_approval_sha256: ApprovalContractSha256;
}

/**
 * Clean Authority persistence needed after source staging. It is deliberately
 * narrow: D2 remains the system of record for human authorization and D3 is
 * the system of record for the append. Authority holds only its frozen source
 * join and a replay-safe receipt witness.
 */
export interface CleanD2ToD3AuthorityStateV1 {
  listStagedApprovalIds(): Promise<readonly string[]>;
  readFrozenCandidateForApproval(
    approvalId: string,
  ): Promise<FrozenCleanD2ToD3CandidateV1 | undefined>;
  recordV4Receipt(input: {
    readonly approval_id: string;
    readonly receipt: JsonObject;
    readonly control_approval_sha256: ApprovalContractSha256;
  }): Promise<void>;
}

/**
 * Adapts the Authority's concrete live-source outbox to the D2→D3 port. The
 * source state re-proves stored canonical JSON; this adapter adds the only
 * state checks needed before handing the immutable tuple to the coordinator.
 */
export class SqliteCleanD2ToD3AuthorityStateV1 implements CleanD2ToD3AuthorityStateV1 {
  constructor(private readonly state: SqliteCleanLiveOnlySourceStateV1) {}

  async listStagedApprovalIds(): Promise<readonly string[]> {
    return this.state.listStagedApprovalIds();
  }

  async readFrozenCandidateForApproval(
    approvalId: string,
  ): Promise<FrozenCleanD2ToD3CandidateV1 | undefined> {
    const candidate = this.state.readFrozenCandidateForApproval(approvalId);
    if (candidate === undefined) return undefined;
    if (
      candidate.state !== "staged" ||
      candidate.frozen_card_sha256 === null ||
      candidate.approved_snapshot === null ||
      candidate.approved_snapshot_sha256 === null ||
      candidate.control_approval_sha256 === null
    ) {
      throw new Error("clean D2 action has an incomplete Authority outbox");
    }
    return {
      candidate_id: candidate.candidate_id,
      candidate_semantic_sha256: candidate.candidate_semantic_sha256,
      approval_id: candidate.approval_id,
      frozen_card_sha256:
        candidate.frozen_card_sha256 as ApprovalContractSha256,
      approved_snapshot: candidate.approved_snapshot,
      approved_snapshot_sha256:
        candidate.approved_snapshot_sha256 as ApprovalContractSha256,
      admission: candidate.admission,
      meeting: candidate.meeting,
      decisions: candidate.decisions,
      control_approval_sha256:
        candidate.control_approval_sha256 as ApprovalContractSha256,
    };
  }

  async recordV4Receipt(input: {
    readonly approval_id: string;
    readonly receipt: JsonObject;
    readonly control_approval_sha256: ApprovalContractSha256;
  }): Promise<void> {
    this.state.recordV4Receipt({
      approval_id: input.approval_id,
      control_approval_sha256: input.control_approval_sha256,
      receipt: input.receipt,
    });
  }
}

export interface CleanD2ToD3ProcessingCoordinatorV1Options {
  readonly authority: CleanD2ToD3AuthorityStateV1;
  readonly finalization: {
    readonly coordinator: PersonSlackApprovalFinalizationCoordinatorV2;
    readonly observer: PersonSlackApprovalObserverV2;
    readonly codec: PersonSlackApprovalFinalizationCodecV2;
    readonly ids: PersonSlackApprovalFinalizationIdFactoryV2;
    readonly now: () => string;
  };
  readonly record_writer: CleanV4RecordWriterV1;
}

interface ReprovedD2ActionV1 {
  readonly witness: ReprovedPersonPolicyD2WitnessV2;
  readonly action: "approve" | "reject";
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly observed_at: string;
}

function sameDigest(
  actual: string,
  expected: string,
  label: string,
): asserts actual is ApprovalContractSha256 {
  if (actual !== expected) {
    throw new Error(`clean D2 durable ${label} digest is invalid`);
  }
}

function reproveD2Action(
  stored: StoredProviderHumanActionV2,
  codec: PersonSlackApprovalFinalizationCodecV2,
  approvalId: string,
  auditEntryIsInVerifiedChain: (input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly audit_entry_sha256: ApprovalContractSha256;
    readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
  }) => boolean,
): ReprovedD2ActionV1 {
  const contracts = stored.contracts;
  const allow = validateProviderHumanAuthorizationAllowV2(
    contracts.authorization_allow,
  );
  const audit = validateProviderHumanIntegrationAuditEntryV2(
    contracts.audit_entry,
  );
  sameDigest(
    codec.sha256(allow),
    contracts.authorization_proof_sha256,
    "authorization",
  );
  sameDigest(codec.sha256(audit), contracts.audit_entry_sha256, "audit");
  const semantic = validateProviderHumanSemanticActionInputV1(
    stored.semantic_action,
  );
  sameDigest(
    codec.sha256(semantic),
    stored.semantic_action_sha256,
    "semantic action",
  );
  const derivedSemantic = buildProviderHumanSemanticActionInputV1(contracts);
  sameDigest(
    codec.sha256(derivedSemantic),
    stored.semantic_action_sha256,
    "derived semantic action",
  );
  sameDigest(
    codec.sha256(contracts.provider_action),
    contracts.provider_action_sha256,
    "provider action",
  );
  const durable = validateProviderHumanActionDurableResult(stored.result);
  const derivedDurable = buildProviderHumanActionDurableResult(contracts);
  if (codec.sha256(durable) !== codec.sha256(derivedDurable)) {
    throw new Error("clean D2 durable result differs from its contract set");
  }
  if (
    durable.approval_id !== approvalId ||
    durable.action !== allow.action ||
    semantic.approval_id !== approvalId ||
    semantic.action !== allow.action ||
    audit.subject_id !== approvalId ||
    audit.action !== allow.action ||
    audit.detail_digest !== contracts.authorization_proof_sha256 ||
    contracts.provider_action.approval_id !== approvalId ||
    contracts.provider_action.action !== allow.action ||
    contracts.provider_action.policy_id !== allow.policy_id ||
    contracts.provider_action.policy_contract_sha256 !==
      allow.policy_contract_sha256 ||
    allow.provider_action_sha256 !== contracts.provider_action_sha256 ||
    audit.provider_action_sha256 !== contracts.provider_action_sha256 ||
    !auditEntryIsInVerifiedChain({
      authority_id: audit.authority_id,
      organization_id: audit.organization_id,
      state_lineage_id: audit.state_lineage_id,
      audit_event_id: audit.audit_event_id,
      audit_sequence: audit.audit_sequence,
      audit_entry_sha256: contracts.audit_entry_sha256,
      predecessor_entry_sha256: audit.predecessor_entry_sha256,
    })
  ) {
    throw new Error("clean D2 durable action fails its approval reproof");
  }
  const witness: ReprovedPersonPolicyD2WitnessV2 = Object.freeze({
    authorization_allow: {
      authority_id: allow.authority_id,
      organization_id: allow.organization_id,
      state_lineage_id: allow.state_lineage_id,
      approval_id: allow.approval_id,
      action: allow.action,
      policy_id: allow.policy_id,
      policy_contract_sha256: allow.policy_contract_sha256,
      principal_id: allow.principal_id,
      membership_id: allow.membership_id,
      provider_action_sha256: allow.provider_action_sha256,
      decision: "allow" as const,
    },
    authorization_proof_sha256: contracts.authorization_proof_sha256,
    provider_action_kind: "echo-provider-human-action-v2" as const,
    provider_action_schema_version: 2 as const,
    audit_entry: {
      authority_id: audit.authority_id,
      organization_id: audit.organization_id,
      state_lineage_id: audit.state_lineage_id,
      audit_event_id: audit.audit_event_id,
      audit_sequence: audit.audit_sequence,
      actor_class: "provider_human" as const,
      principal_id: audit.principal_id,
      membership_id: audit.membership_id,
      action: audit.action,
      subject_kind: "approval" as const,
      subject_id: audit.subject_id,
      detail_digest: audit.detail_digest,
      provider_action_sha256: audit.provider_action_sha256,
    },
    audit_entry_sha256: contracts.audit_entry_sha256,
  });
  return {
    witness,
    action: allow.action,
    frozen_card_sha256: contracts.provider_action.frozen_card_sha256,
    approved_snapshot_sha256:
      contracts.provider_action.approved_snapshot_sha256,
    policy_consequence_sha256:
      contracts.provider_action.policy_consequence_sha256,
    observed_at: contracts.provider_action.observed_at,
  };
}

function consequenceText(policyId: string): string {
  if (policyId === "organization-member-readable-person-v2") {
    return ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT;
  }
  if (policyId === "restricted-reviewer-person-v2") {
    return RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT;
  }
  throw new Error("clean D2 action has an unsupported Person policy");
}

function buildRecordInput(
  candidate: FrozenCleanD2ToD3CandidateV1,
  reproved: ReprovedD2ActionV1,
): FinalizedCleanD2RecordWitnessV1 {
  const snapshot = candidate.approved_snapshot;
  if (
    candidate.approval_id !==
      reproved.witness.authorization_allow.approval_id ||
    canonicalSha256(snapshot) !== candidate.approved_snapshot_sha256 ||
    candidate.approved_snapshot_sha256 !== reproved.approved_snapshot_sha256 ||
    candidate.frozen_card_sha256 !== reproved.frozen_card_sha256
  ) {
    throw new Error("clean Authority candidate does not match its D2 action");
  }
  const allow = reproved.witness.authorization_allow;
  const ref = {
    schema_version: 1 as const,
    kind: "echo-human-act-resolution-ref-v1" as const,
    authority_id: allow.authority_id,
    organization_id: allow.organization_id,
    state_lineage_id: allow.state_lineage_id,
    approval_id: allow.approval_id,
    action: allow.action,
    policy_id: allow.policy_id,
    policy_contract_sha256: allow.policy_contract_sha256,
    audit_event_id: reproved.witness.audit_entry.audit_event_id,
    audit_sequence: reproved.witness.audit_entry.audit_sequence,
    audit_entry_sha256: reproved.witness.audit_entry_sha256,
    provider_action_kind: "echo-provider-human-action-v2" as const,
    provider_action_schema_version: 2 as const,
    provider_action_sha256: allow.provider_action_sha256,
    authorization_proof_sha256: reproved.witness.authorization_proof_sha256,
  };
  const finalEvent =
    reproved.action === "approve"
      ? {
          kind: "approved" as const,
          approved_snapshot: snapshot as never,
          approved_snapshot_sha256: candidate.approved_snapshot_sha256,
          policy_id: allow.policy_id,
          policy_contract_sha256: allow.policy_contract_sha256,
          policy_consequence_text: consequenceText(allow.policy_id),
          policy_consequence_sha256: reproved.policy_consequence_sha256,
        }
      : {
          kind: "rejected" as const,
          candidate_sha256:
            candidate.candidate_semantic_sha256 as ApprovalContractSha256,
          approved_snapshot_sha256: candidate.approved_snapshot_sha256,
          frozen_card_sha256: candidate.frozen_card_sha256,
          policy_id: allow.policy_id,
          policy_contract_sha256: allow.policy_contract_sha256,
          policy_consequence_sha256: reproved.policy_consequence_sha256,
          action: "reject" as const,
          rejection_payload: {
            source: {
              adapter_id: candidate.meeting.provenance.source.adapter_id,
              instance_id: candidate.meeting.provenance.source.instance_id,
              external_id: candidate.meeting.provenance.external_id,
            },
            meeting_id: candidate.meeting.id,
            rejected_at: reproved.observed_at,
            reason: null,
            reconsider_after: null,
          },
        };
  // The builder returns an enriched validation view with derived digest
  // fields. D3 accepts the exact three-field protocol input, so retain only
  // its canonical wire body at this composition boundary.
  const built = buildHumanActRecordInputV1({
    human_act_resolution_ref: ref,
    event: finalEvent,
  });
  const human_act_record_input: HumanActRecordInputV1 = {
    human_act_resolution_ref: built.human_act_resolution_ref,
    event: built.event,
    idempotency: built.idempotency,
  };
  return {
    d2_witness: reproved.witness,
    human_act_record_input,
    source_provenance: validateMeetingSourceProvenanceV1({
      schema_version: 1,
      kind: "echo-meeting-source-provenance-v1",
      authority_id: allow.authority_id,
      organization_id: allow.organization_id,
      state_lineage_id: allow.state_lineage_id,
      source_adapter_kind: "meeting-source",
      source_adapter_id: candidate.meeting.provenance.source.adapter_id,
      source_adapter_instance_id:
        candidate.meeting.provenance.source.instance_id,
      source_adapter_version: candidate.meeting.provenance.source.version,
      external_id: candidate.meeting.provenance.external_id,
      canonical_revision: candidate.meeting.provenance.canonical_revision,
      normalizer_version: candidate.meeting.provenance.normalizer_version,
      source_revision: candidate.meeting.provenance.source_revision ?? null,
    }),
    processor_provenance: validateDecisionProcessorProvenanceV1({
      schema_version: 1,
      kind: "echo-decision-processor-provenance-v1",
      authority_id: allow.authority_id,
      organization_id: allow.organization_id,
      state_lineage_id: allow.state_lineage_id,
      processor_adapter_kind: "decision-processor",
      processor_adapter_id: candidate.decisions.processor.adapter_id,
      processor_adapter_instance_id: candidate.decisions.processor.instance_id,
      processor_adapter_version: candidate.decisions.processor.version,
      processor_contract_sha256:
        candidate.admission.processor.configuration_sha256,
    }),
  };
}

/**
 * Concrete clean D2→D3 coordinator. D2 is finalized before append; a crash
 * after D2 simply re-proves the durable action and retries V4's idempotent
 * append. Rejections therefore receive an immutable V4 record while the D3
 * projector emits no readable fact.
 */
export class CleanD2ToD3ProcessingCoordinatorV1 {
  constructor(
    private readonly options: CleanD2ToD3ProcessingCoordinatorV1Options,
  ) {}

  async recoverV4Appends(signal: AbortSignal): Promise<void> {
    for (const approvalId of await this.options.authority.listStagedApprovalIds()) {
      signal.throwIfAborted();
      await this.appendIfFinalized(approvalId);
    }
  }

  async observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void> {
    for (const approvalId of await this.options.authority.listStagedApprovalIds()) {
      signal.throwIfAborted();
      await finalizePersonSlackApprovalV2({
        command: { approval_id: approvalId },
        coordinator: this.options.finalization.coordinator,
        provider: this.options.finalization.observer,
        codec: this.options.finalization.codec,
        ids: this.options.finalization.ids,
        now: this.options.finalization.now,
        signal,
      });
    }
  }

  async appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void> {
    for (const approvalId of await this.options.authority.listStagedApprovalIds()) {
      signal.throwIfAborted();
      await this.appendIfFinalized(approvalId);
    }
  }

  private async appendIfFinalized(approvalId: string): Promise<void> {
    const reproved =
      await this.options.finalization.coordinator.withStableProviderHumanAction(
        (fence) => {
          const stored =
            fence.transaction.durableActionByApprovalId(approvalId);
          return stored === undefined
            ? undefined
            : reproveD2Action(
                stored,
                this.options.finalization.codec,
                approvalId,
                (input) => fence.transaction.auditEntryIsInVerifiedChain(input),
              );
        },
      );
    if (reproved === undefined) return;
    const candidate =
      await this.options.authority.readFrozenCandidateForApproval(approvalId);
    if (candidate === undefined) {
      throw new Error("clean D2 action has no Authority frozen candidate");
    }
    const input = buildRecordInput(candidate, reproved);
    const appended: AppendedV4Record =
      await this.options.record_writer.appendFinalized(input);
    await this.options.authority.recordV4Receipt({
      approval_id: approvalId,
      receipt: appended.receipt,
      control_approval_sha256: candidate.control_approval_sha256,
    });
  }
}
