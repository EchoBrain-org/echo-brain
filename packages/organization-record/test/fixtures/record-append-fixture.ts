import {
  canonicalJson,
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
  sha256Digest,
  type JsonObject,
  type JsonValue,
  type P256SigningKeyDescriptor,
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
  APPROVAL_DECISION_FIELD_V2,
  APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2,
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2,
  APPROVAL_DECISION_REF_KIND_V2,
  APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
  approvalRecordIdV2,
  validateApprovalDecisionRecordInputV2,
  type ApprovalDecisionPolicyIdV1,
} from "../../../organization-protocol/src/approval-decision-record-input-v2.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
  type ApprovedDecisionSnapshotV2,
} from "../../../organization-protocol/src/approved-decision-snapshot-v2.js";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../../organization-protocol/src/authority-descriptor.js";
import {
  createOrganizationRecordReceiptV2,
  validateOrganizationRecordReceiptBodyV2,
  verifyOrganizationRecordReceiptV2,
} from "../../../organization-protocol/src/organization-record-receipt-v2.js";
import {
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../../../organization-protocol/src/person-content-policy-v2.js";
import {
  DECISION_PROCESSOR_PROVENANCE_V1_KIND,
  MEETING_SOURCE_PROVENANCE_V1_KIND,
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../organization-protocol/src/record-envelope-v4.js";
import { createRecordInputCodecRegistryV4 } from "../../../organization-protocol/src/record-input-codec-v4.js";
import { projectApprovedMeetingPolicyFactsV1 } from "../../src/application/approved-meeting-policy-projection-v1.js";
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../../src/application/person-policy-fact-contracts-v2.js";
import {
  createRecordPolicyFactProjectorRegistryV1,
  type RecordPolicyFactEnvelopeV1,
  type RecordPolicyFactProjectorV1,
} from "../../src/application/record-policy-fact-projection-v1.js";
import {
  type AppendV4RecordInput,
  type V4ReceiptFactory,
  type V4RecordEnvelopeFactory,
  type V4RecordEnvelopeView
} from "../../src/log/record-log-v4-append.js";
import { openOrganizationRecordDatabase } from "../../src/persistence/open-organization-record-database.js";
import { applyOrganizationRecordLogBaselineV6 } from "../../src/persistence/record-log-baseline.js";

/** The record codecs the Authority appends and reads with: approval decisions only. */
export const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([APPROVAL_DECISION_RECORD_INPUT_CODEC_V2]);

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
  applyOrganizationRecordLogBaselineV6(value);
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

/** The project every fixture project record is shared with unless a test names others. */
export const FIXTURE_PROJECT_ID = "prj_00000000-0000-4000-8000-000000000001";
export const FIXTURE_REVIEWER = { principal_id: "principal-1", membership_id: "membership-1" } as const;

/**
 * A neutral policy projector for approval-decision records. The Authority's
 * projector (approval-decision-projection-v1.ts) also re-checks the decision
 * witness; this one derives the same facts from the verified reference alone,
 * so the record log is tested without the Authority.
 */
export function approvalDecisionTestProjector(): RecordPolicyFactProjectorV1 {
  const parse = (envelope: RecordPolicyFactEnvelopeV1) => validateApprovalDecisionRecordInputV2({
    [APPROVAL_DECISION_FIELD_V2]: envelope.body.human_act_resolution_ref,
    event: envelope.body.event,
  });
  return Object.freeze({
    id: APPROVAL_DECISION_REF_KIND_V2,
    matches: (envelope: RecordPolicyFactEnvelopeV1) =>
      (envelope.body.human_act_resolution_ref as { readonly kind?: unknown }).kind === APPROVAL_DECISION_REF_KIND_V2,
    policyBinding(envelope: RecordPolicyFactEnvelopeV1) {
      const { event } = parse(envelope);
      return { policy_id: event.policy_id, policy_contract_sha256: event.policy_contract_sha256 };
    },
    project(input: Parameters<RecordPolicyFactProjectorV1["project"]>[0]) {
      const parsed = parse(input.envelope);
      return projectApprovedMeetingPolicyFactsV1({ ...input, event: parsed.event, reference: parsed.approval_decision_ref_v2 });
    },
  });
}

export const RECORD_POLICY_PROJECTORS = createRecordPolicyFactProjectorRegistryV1([approvalDecisionTestProjector()]);

/** The record approval id of a proposal's destination: Only me ([]) or its projects. */
export function recordApprovalId(proposal_approval_id: string, projects: readonly string[] = []): string {
  return approvalRecordIdV2(proposal_approval_id, projects);
}

/** A frozen approval-core snapshot under `approval_id`: decisions, then actions, then rationales. */
export function approvedSnapshot(
  approval_id: string,
  signal_count: number,
  signal_counts?: {
    readonly decisions?: number;
    readonly actions?: number;
    readonly rationales?: number;
  },
  decision_text?: string,
): ApprovedDecisionSnapshotV2 {
  return validateApprovedDecisionSnapshotV2({
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
            text: decision_text ?? `Decision ${index}`,
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
      surface: APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
    },
  });
}

/**
 * One approval decision of proposal `proposal_approval_id` with every item
 * routed to one destination: Only me (the restricted reviewer) or `projects`.
 */
export function approvalDecision(input: {
  readonly proposal_approval_id: string;
  readonly policy_id: ApprovalDecisionPolicyIdV1;
  readonly projects?: readonly string[];
  readonly signal_count: number;
  readonly signal_counts?: {
    readonly decisions?: number;
    readonly actions?: number;
    readonly rationales?: number;
  };
  readonly decision_text?: string;
  readonly reviewer?: { readonly principal_id: string; readonly membership_id: string };
}) {
  const projects = input.policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID ? [...(input.projects ?? [FIXTURE_PROJECT_ID])] : [];
  const approval_id = recordApprovalId(input.proposal_approval_id, projects);
  const snapshot = approvedSnapshot(approval_id, input.signal_count, input.signal_counts, input.decision_text);
  const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(snapshot);
  const policy_contract_sha256 = input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID
    ? restrictedReviewerPersonPolicyContractSha256()
    : projectMembersReadablePersonPolicyContractSha256();
  const policy_consequence = {
    schema_version: 2 as const, kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id: input.policy_id,
    audience_project_ids: projects, association_project_ids: projects,
  };
  const policy_consequence_sha256 = canonicalSha256(policy_consequence as unknown as JsonValue);
  const brief = snapshot.approved_payload.brief;
  const command_id = `cmd-${input.proposal_approval_id}`;
  const reviewer = input.reviewer ?? FIXTURE_REVIEWER;
  return validateApprovalDecisionRecordInputV2({
    [APPROVAL_DECISION_FIELD_V2]: {
      schema_version: 2, kind: APPROVAL_DECISION_REF_KIND_V2, ...COORDINATES,
      approval_id, proposal_approval_id: input.proposal_approval_id, command_id, action: "approve", surface: "desktop",
      candidate_sha256: sha256Digest(`candidate-${input.proposal_approval_id}`),
      proposal_snapshot_sha256: sha256Digest(`proposal-${input.proposal_approval_id}`),
      approved_snapshot_sha256,
      route_signal_ids: [...brief.decisions, ...brief.actions].map((signal) => signal.id),
      final_approver: { principal_id: reviewer.principal_id, membership_id: reviewer.membership_id },
      selected_policy_id: input.policy_id, policy_contract_sha256, policy_consequence_sha256,
      audience_project_ids: projects, association_project_ids: projects, action_owners: [],
      audit_event_id: `audit:${command_id}`, audit_sequence: 1,
      audit_entry_sha256: sha256Digest(`audit-entry-${input.proposal_approval_id}`),
      provider_action_kind: APPROVAL_DECISION_PROVIDER_ACTION_KIND_V2, provider_action_schema_version: 2,
      provider_action_sha256: sha256Digest(`provider-${input.proposal_approval_id}`),
      authorization_proof_sha256: sha256Digest(`authorization-${input.proposal_approval_id}`),
      approved_at: "2026-08-21T12:01:00.000Z",
    },
    event: {
      kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256, policy_id: input.policy_id,
      policy_contract_sha256, policy_consequence, policy_consequence_sha256,
    },
  });
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
  decision: ReturnType<typeof approvalDecision>,
  calls: { value: number },
): V4RecordEnvelopeFactory {
  return {
    async create(allocation) {
      calls.value += 1;
      return createOrganizationRecordEnvelopeV4(
        {
          envelope_id: `envelope-${decision.approval_decision_ref_v2.proposal_approval_id}`,
          issued_at: "2026-08-21T12:01:00.000Z",
          predecessor_position: allocation.predecessor_position,
          predecessor_record_sha256: allocation.predecessor_record_sha256,
          human_act_record_input: {
            approval_decision_ref_v2: decision.approval_decision_ref_v2,
            event: decision.event,
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
    readonly state_lineage_id?: string;
  },
  codecs = RECORD_INPUT_CODECS,
): V4ReceiptFactory {
  const lineage = options.state_lineage_id ?? COORDINATES.state_lineage_id;
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
        lineage,
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
        lineage, codecs,
      ) as unknown as JsonObject;
    },
  };
}

export function appendInput(input: {
  readonly authority: ProtocolAuthority;
  /** The decided proposal; the record is appended under its destination's derived approval id. */
  readonly approval_id?: string;
  readonly policy_id?: ApprovalDecisionPolicyIdV1;
  /** A project record's audience (default the fixture project). */
  readonly projects?: readonly string[];
  readonly reviewer?: { readonly principal_id: string; readonly membership_id: string };
  readonly signal_count?: number;
  readonly signal_counts?: {
    readonly decisions?: number;
    readonly actions?: number;
    readonly rationales?: number;
  };
  readonly decision_text?: string;
  readonly envelope_calls?: { value: number };
  readonly receipt?: V4ReceiptFactory;
  readonly semantic_idempotency_key?: Sha256Digest;
}): AppendV4RecordInput {
  const decision = approvalDecision({
    proposal_approval_id: input.approval_id ?? "approval-1",
    policy_id: input.policy_id ?? RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    signal_count: input.signal_count ?? 1,
    ...(input.projects === undefined ? {} : { projects: input.projects }),
    ...(input.signal_counts === undefined ? {} : { signal_counts: input.signal_counts }),
    ...(input.decision_text === undefined ? {} : { decision_text: input.decision_text }),
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
  });
  return {
    approval_id: decision.approval_decision_ref_v2.approval_id,
    action: "approve",
    semantic_idempotency_key:
      input.semantic_idempotency_key ?? decision.semantic_idempotency_key,
    receipt_issued_at: "2026-08-21T12:02:00.000Z",
    // The test projector reads the verified reference alone.
    authorization_witness: {},
    envelope_factory: envelopeFactory(
      input.authority,
      decision,
      input.envelope_calls ?? { value: 0 },
    ),
    receipt_factory:
      input.receipt ??
      receiptFactory(input.authority, { sign_calls: { value: 0 } }),
  };
}
