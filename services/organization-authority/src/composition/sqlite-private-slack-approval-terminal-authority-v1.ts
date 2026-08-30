/**
 * Authority adapter for the post-terminal private approval worker.
 *
 * Control Plane has already made the terminal decision at this point. This
 * adapter therefore deliberately uses the frozen presentation path rather
 * than the current-only assignment capability: a terminal that won the race
 * immediately before source supersession must still be able to finish its V4
 * append and make its already-private card inert.
 */
import {
  validateDecisionProcessorProvenanceV1,
  validateMeetingSourceProvenanceV1,
  type DecisionProcessorProvenanceV1,
  type MeetingSourceProvenanceV1,
} from "@echo-brain/organization-protocol";
import type { ApprovalContractSha256 } from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  type PrivateSlackApprovalTerminalAuthorityV1,
  type PrivateSlackApprovalTerminalFrozenCandidateV1,
} from "./private-slack-approval-terminal-coordinator-v1.js";
import {
  SqlitePrivateSlackApprovalAssignmentStateV1,
  type PrivateApprovalPresentationRecoveryV1,
  type PrivateApprovalTerminalReceiptV1,
  type RecordPrivateApprovalTerminalReceiptInputV1,
} from "./sqlite-private-slack-approval-assignment-state-v1.js";
import {
  SqliteAuthorityMeetingProcessingStateV1,
  type FrozenMeetingProcessingCandidateForApprovalV1,
} from "../processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";

/** The immutable root that every generated record provenance must carry. */
export interface PrivateSlackApprovalTerminalAuthorityCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface SqlitePrivateSlackApprovalTerminalAuthorityV1Options {
  readonly source: SqliteAuthorityMeetingProcessingStateV1;
  readonly assignments: SqlitePrivateSlackApprovalAssignmentStateV1;
  readonly coordinates: PrivateSlackApprovalTerminalAuthorityCoordinatesV1;
}

function incomplete(message: string): never {
  throw new Error(`private terminal has an incomplete Authority frozen tuple: ${message}`);
}

function exactCoordinates(
  coordinates: PrivateSlackApprovalTerminalAuthorityCoordinatesV1,
): void {
  for (const [label, value] of Object.entries(coordinates)) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ) {
      throw new Error(`private approval ${label} is invalid`);
    }
  }
}

function sourceProvenance(
  candidate: FrozenMeetingProcessingCandidateForApprovalV1,
  coordinates: PrivateSlackApprovalTerminalAuthorityCoordinatesV1,
): MeetingSourceProvenanceV1 {
  const source = candidate.meeting.provenance.source;
  return validateMeetingSourceProvenanceV1({
    schema_version: 1,
    kind: "echo-meeting-source-provenance-v1",
    authority_id: coordinates.authority_id,
    organization_id: coordinates.organization_id,
    state_lineage_id: coordinates.state_lineage_id,
    source_adapter_kind: "meeting-source",
    source_adapter_id: source.adapter_id,
    source_adapter_instance_id: source.instance_id,
    source_adapter_version: source.version,
    external_id: candidate.meeting.provenance.external_id,
    canonical_revision: candidate.meeting.provenance.canonical_revision,
    normalizer_version: candidate.meeting.provenance.normalizer_version,
    source_revision: candidate.meeting.provenance.source_revision ?? null,
  });
}

function processorProvenance(
  candidate: FrozenMeetingProcessingCandidateForApprovalV1,
  coordinates: PrivateSlackApprovalTerminalAuthorityCoordinatesV1,
): DecisionProcessorProvenanceV1 {
  const processor = candidate.decisions.processor;
  return validateDecisionProcessorProvenanceV1({
    schema_version: 1,
    kind: "echo-decision-processor-provenance-v1",
    authority_id: coordinates.authority_id,
    organization_id: coordinates.organization_id,
    state_lineage_id: coordinates.state_lineage_id,
    processor_adapter_kind: "decision-processor",
    processor_adapter_id: processor.adapter_id,
    processor_adapter_instance_id: processor.instance_id,
    processor_adapter_version: processor.version,
    processor_contract_sha256:
      candidate.admission.processor.configuration_sha256,
  });
}

/**
 * Concrete Authority port for `PrivateSlackApprovalTerminalCoordinatorV1`.
 *
 * It never accepts a new Slack action. Its only capability is to re-read a
 * frozen, actionable source tuple after a durable terminal exists. An
 * assignment presentation row is required even on the append path so the
 * candidate/card/snapshot bindings cannot be spliced across approvals.
 */
export class SqlitePrivateSlackApprovalTerminalAuthorityV1
  implements PrivateSlackApprovalTerminalAuthorityV1
{
  private readonly source: SqliteAuthorityMeetingProcessingStateV1;
  private readonly assignments: SqlitePrivateSlackApprovalAssignmentStateV1;
  private readonly coordinates: PrivateSlackApprovalTerminalAuthorityCoordinatesV1;

  constructor(options: SqlitePrivateSlackApprovalTerminalAuthorityV1Options) {
    exactCoordinates(options.coordinates);
    this.source = options.source;
    this.assignments = options.assignments;
    this.coordinates = Object.freeze({ ...options.coordinates });
  }

  async readFrozenCandidateForApproval(
    approvalId: string,
  ): Promise<PrivateSlackApprovalTerminalFrozenCandidateV1 | undefined> {
    const candidate = this.source.readFrozenCandidateForApproval(approvalId);
    if (candidate === undefined) return undefined;
    if (candidate.approval_id !== approvalId) {
      incomplete("approval ID disagrees with its source lookup");
    }
    if (candidate.state !== "staged" && candidate.state !== "superseded") {
      incomplete("outbox is neither staged nor superseded");
    }
    if (
      candidate.frozen_card_sha256 === null ||
      candidate.approved_snapshot === null ||
      candidate.approved_snapshot_sha256 === null
    ) {
      incomplete("card or approved snapshot commitment is absent");
    }

    // `readForPresentation` intentionally works after supersession. It
    // re-proves the immutable assignment and its candidate/card/snapshot
    // commitment and also ensures this terminal has a concrete private card
    // to render inert after its append/rejection completes.
    const presentation = this.assignments.readForPresentation(approvalId);
    if (presentation === undefined) {
      incomplete("private assignment presentation is absent");
    }
    if (presentation.source_outbox_state !== candidate.state) {
      incomplete("assignment presentation disagrees with source outbox state");
    }
    const commitment = presentation.assignment.candidate;
    if (
      presentation.assignment.organization_id !== this.coordinates.organization_id ||
      commitment.approval_id !== candidate.approval_id ||
      commitment.candidate_id !== candidate.candidate_id ||
      commitment.candidate_sha256 !== candidate.candidate_semantic_sha256 ||
      commitment.frozen_card_sha256 !== candidate.frozen_card_sha256 ||
      commitment.approved_snapshot_sha256 !== candidate.approved_snapshot_sha256
    ) {
      incomplete("private assignment does not bind the frozen source tuple");
    }

    return Object.freeze({
      candidate_id: candidate.candidate_id,
      authority_id: this.coordinates.authority_id,
      organization_id: this.coordinates.organization_id,
      state_lineage_id: this.coordinates.state_lineage_id,
      approval_id: candidate.approval_id,
      candidate_sha256: candidate.candidate_semantic_sha256 as ApprovalContractSha256,
      frozen_card_sha256: candidate.frozen_card_sha256 as ApprovalContractSha256,
      approved_snapshot: candidate.approved_snapshot,
      approved_snapshot_sha256:
        candidate.approved_snapshot_sha256 as ApprovalContractSha256,
      source_provenance: sourceProvenance(candidate, this.coordinates),
      processor_provenance: processorProvenance(candidate, this.coordinates),
    });
  }

  async readTerminal(
    approvalId: string,
  ): Promise<PrivateApprovalTerminalReceiptV1 | undefined> {
    return this.assignments.readTerminal(approvalId);
  }

  async recordTerminal(
    input: RecordPrivateApprovalTerminalReceiptInputV1,
  ): Promise<PrivateApprovalTerminalReceiptV1> {
    return this.assignments.recordTerminal(input);
  }

  async readForPresentation(
    approvalId: string,
  ): Promise<PrivateApprovalPresentationRecoveryV1 | undefined> {
    return this.assignments.readForPresentation(approvalId);
  }

  async markTerminalCardRendered(
    approvalId: string,
  ): Promise<PrivateApprovalTerminalReceiptV1 | undefined> {
    return this.assignments.markTerminalCardRendered(approvalId);
  }
}
