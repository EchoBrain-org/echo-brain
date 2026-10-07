import { canonicalJson, canonicalSha256, sha256Digest, type JsonObject, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  HUMAN_ACT_RECORD_INPUT_CODEC_V1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  createRecordInputCodecRegistryV4,
  organizationMemberReadablePersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
  type OrganizationRecordDecisionBriefV1,
} from "@echo-brain/organization-protocol";
import {
  RecordRetrievalSourceSnapshotPortV1,
  composeRecordApproverProjectorsV1,
  createRecordPolicyFactProjectorRegistryV1,
  type OrganizationRecordAppenderV4,
  type V4RecordEnvelopeView,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  buildReadableSearchGenerationV1,
  readableSearchPlaneBaselineSha256,
  warmReadableSearchActiveGenerationV1,
  type ReadableSearchActiveGenerationV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import { SIGNED_SLACK_BLOCK_ACTION_V1_KIND } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import {
  PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V3_KIND,
  validatePrivateSlackBlockApprovalRecordInputV2,
  validatePrivateSlackBlockApprovalRecordInputV3,
  privateSlackBlockApprovalConsequenceV2Sha256,
} from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v2";
import { projectPrivateSlackBlockApprovalApproverV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import {
  createPrivateSlackBlockApprovalPolicyProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV3,
  projectPrivateSlackBlockApprovalApproverV2,
} from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2";
import type Database from "better-sqlite3";
import {
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
  type HumanActEventV1,
} from "../../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  COORDINATES,
  humanAct,
  processorProvenance,
  receiptFactory,
  sourceProvenance,
  type ProtocolAuthority,
} from "../../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { readableSearchGenerationContractV1 } from "../../src/composition/readable-search-generation-composition.js";

/** The Authority's record codecs for Slack-approved records, V2 and V3. */
export const SIGNED_APPROVAL_CODECS = createRecordInputCodecRegistryV4([
  HUMAN_ACT_RECORD_INPUT_CODEC_V1,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3,
]);
export const SIGNED_APPROVAL_PROJECTORS = createRecordPolicyFactProjectorRegistryV1([
  createPrivateSlackBlockApprovalPolicyProjectorV2(),
  createPrivateSlackBlockApprovalPolicyProjectorV3(),
]);
/** The approver projectors production composes (organization-authority-composition-root.ts). */
export const SIGNED_APPROVAL_APPROVER = composeRecordApproverProjectorsV1([
  projectPrivateSlackBlockApprovalApproverV1,
  projectPrivateSlackBlockApprovalApproverV2,
]);
/** The approver's Slack user id, carried by every fixture envelope and never released. */
export const SIGNED_APPROVAL_SLACK_SUBJECT = "U0APPROVERSUBJECT";
export const SIGNED_APPROVAL_ISSUED_AT = "2026-08-21T12:02:00.000Z";

export interface SignedSlackApprovalV2Input {
  readonly approval_id: string;
  readonly audit_sequence: number;
  /** A project audience; [] is Only me, and "team" is the whole organization. */
  readonly projects: readonly string[] | "team";
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  /** The receipt and envelope time; it is the meeting's list time. */
  readonly issued_at?: string;
  readonly action?: "approve" | "reject";
  readonly share_transcript?: boolean;
  readonly transcript_source?: { readonly source_id: string; readonly revision_id: string; readonly source_sha256: Sha256Digest };
  /** Signal counts of the fixture brief (one decision by default). */
  readonly signals?: { readonly decisions?: number; readonly actions?: number; readonly rationales?: number };
  /** Reshapes the approved brief (title, time, participants, signals) before it is signed. */
  readonly brief?: (brief: OrganizationRecordDecisionBriefV1) => OrganizationRecordDecisionBriefV1;
  /** Present: a V3 record with these approver-confirmed owners (ADR-0021). */
  readonly action_owners?: readonly { readonly signal_id: string; readonly owner: string }[];
}

/** One real signed V2 (or V3) Slack approval or rejection, appended through the record appender. */
export async function approveSignedSlackV2(
  app: OrganizationRecordAppenderV4,
  authority: ProtocolAuthority,
  input: SignedSlackApprovalV2Input,
): Promise<void> {
  const { approval_id, audit_sequence } = input;
  const final_approver = { principal_id: input.final_approver.principal_id, membership_id: input.final_approver.membership_id };
  const issued_at = input.issued_at ?? SIGNED_APPROVAL_ISSUED_AT;
  const action = input.action ?? "approve";
  const projects = input.projects === "team" ? [] : [...input.projects];
  const policy_id = input.projects === "team" ? ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
    : projects.length === 0 ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
  const policy_contract_sha256 = policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID ? organizationMemberReadablePersonPolicyContractSha256()
    : policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? restrictedReviewerPersonPolicyContractSha256() : projectMembersReadablePersonPolicyContractSha256();
  const fixture = (humanAct(approval_id, "approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, 1, input.signals)
    .event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
  const snapshot = input.brief === undefined ? fixture : validateApprovedDecisionSnapshotV2({
    ...fixture, approved_payload: { ...fixture.approved_payload, brief: input.brief(fixture.approved_payload.brief) },
  });
  const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(snapshot);
  const share_transcript = action === "approve" && input.share_transcript === true;
  const transcript_source = input.transcript_source ?? {
    source_id: `source-${approval_id}`, revision_id: "revision-1", source_sha256: sha256Digest(`source-${approval_id}`),
  };
  const approved = action === "approve";
  const consequence = {
    schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND, policy_id,
    audience_project_ids: projects, association_project_ids: projects, share_transcript, transcript_source,
  };
  const policy_consequence_sha256 = privateSlackBlockApprovalConsequenceV2Sha256(consequence);
  const provider_action_sha256 = sha256Digest(`action-${approval_id}`);
  const authorization_proof_sha256 = sha256Digest(`proof-${approval_id}`);
  const audit_entry = {
    ...COORDINATES, audit_event_id: `audit-${approval_id}`, audit_sequence, actor_class: "provider_human" as const,
    ...final_approver, action, subject_kind: "approval" as const, subject_id: approval_id,
    detail_digest: authorization_proof_sha256, provider_action_sha256,
  };
  const ref = {
    schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND, ...COORDINATES,
    command_id: `command-${approval_id}`, approval_id,
    candidate_sha256: sha256Digest(`candidate-${approval_id}`), frozen_card_sha256: sha256Digest(`card-${approval_id}`),
    approved_snapshot_sha256, final_approver,
    current_slack_identity_link: {
      provider: "slack" as const, external_identity_link_id: `clm_${final_approver.membership_id}`,
      external_identity_link_contract_sha256: sha256Digest(`link-${final_approver.membership_id}`), provider_subject_id: SIGNED_APPROVAL_SLACK_SUBJECT,
    },
    action,
    selected_policy_id: approved ? policy_id : null,
    policy_contract_sha256: approved ? policy_contract_sha256 : null,
    policy_consequence_sha256: approved ? policy_consequence_sha256 : null,
    comment: null,
    audit_event_id: audit_entry.audit_event_id, audit_sequence, audit_entry_sha256: canonicalSha256(audit_entry),
    provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1 as const,
    provider_action_sha256, authorization_proof_sha256,
    audience_project_ids: approved ? projects : [], association_project_ids: approved ? projects : [], share_transcript, transcript_source,
  };
  const event = approved
    ? {
      kind: "approved" as const, approved_snapshot: snapshot, approved_snapshot_sha256, policy_id,
      policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256,
    }
    : { kind: "rejected" as const };
  const built = input.action_owners === undefined
    ? (() => {
      const value = validatePrivateSlackBlockApprovalRecordInputV2({ private_slack_block_approval_resolution_ref_v2: ref, event });
      return { key: value.semantic_idempotency_key, record: { private_slack_block_approval_resolution_ref_v2: value.private_slack_block_approval_resolution_ref_v2, event: value.event } };
    })()
    : (() => {
      const value = validatePrivateSlackBlockApprovalRecordInputV3({
        private_slack_block_approval_resolution_ref_v3: { ...ref, schema_version: 3, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V3_KIND, action_owners: input.action_owners! },
        event,
      });
      return { key: value.semantic_idempotency_key, record: { private_slack_block_approval_resolution_ref_v3: value.private_slack_block_approval_resolution_ref_v3, event: value.event } };
    })();
  const witness = {
    authorization_allow: {
      ...COORDINATES, approval_id, action, final_approver, selected_policy_id: policy_id,
      policy_contract_sha256, policy_consequence_sha256, audience_project_ids: projects, association_project_ids: projects,
      share_transcript, transcript_source, provider_action_sha256, decision: "allow" as const,
    },
    authorization_proof_sha256, provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
    provider_action_schema_version: 1 as const, audit_entry, audit_entry_sha256: ref.audit_entry_sha256,
  };
  await app.append({
    approval_id, action, semantic_idempotency_key: built.key,
    receipt_issued_at: issued_at, authorization_witness: witness,
    envelope_factory: {
      create: async (allocation) => createOrganizationRecordEnvelopeV4({
        envelope_id: `envelope-${approval_id}`, issued_at,
        predecessor_position: allocation.predecessor_position,
        predecessor_record_sha256: allocation.predecessor_record_sha256,
        human_act_record_input: built.record,
        source_provenance: sourceProvenance(), processor_provenance: processorProvenance(),
      }, authority.pinned, COORDINATES.state_lineage_id, authority.sign, SIGNED_APPROVAL_CODECS) as unknown as JsonObject,
      verify: (value) => verifyOrganizationRecordEnvelopeV4(
        value, authority.pinned, COORDINATES.state_lineage_id, SIGNED_APPROVAL_CODECS,
      ) as unknown as V4RecordEnvelopeView & JsonObject,
    },
    receipt_factory: receiptFactory(authority, { sign_calls: { value: 0 } }, SIGNED_APPROVAL_CODECS),
  });
}

function plane(role: string, schema_sha256: Sha256Digest, database_schema_version: 1 | 2 | 3) {
  const manifest_json = canonicalJson({
    schema_version: 1, kind: "echo-state-lineage-database-manifest-v1", role, ...COORDINATES,
    database_schema_version, schema_sha256, created_at: "2026-08-21T12:00:00.000Z", creating_artifact_revision: "test",
  });
  return { database_schema_version, schema_sha256, manifest_json, manifest_sha256: sha256Digest(manifest_json) };
}

/**
 * Builds, warms and publishes the readable-search generation of the record
 * log's current head, with the production atom mapping and contract
 * (readable-search-generation-composition.ts), as the reconciler would.
 */
export function generationFromRecordDatabase(input: {
  readonly record: Database.Database;
  readonly authority: Database.Database;
  readonly state_directory: string;
  readonly signer: ProtocolAuthority;
}): ReadableSearchActiveGenerationV1 {
  const contract = readableSearchGenerationContractV1();
  const snapshot = new RecordRetrievalSourceSnapshotPortV1(input.record).snapshot({
    ...COORDINATES, policy_projectors: SIGNED_APPROVAL_PROJECTORS,
    verify_envelope: (value) => verifyOrganizationRecordEnvelopeV4(value, input.signer.pinned, COORDINATES.state_lineage_id, SIGNED_APPROVAL_CODECS),
  });
  const envelopes = new Map(snapshot.rows.map((row) => [row.position, row.envelope_sha256]));
  const head = snapshot.head ?? { position: 0, record_sha256: null };
  const built = buildReadableSearchGenerationV1({
    state_directory: input.state_directory,
    lineage: { ...COORDINATES, planes: {
      facts: plane("retrieval-facts", readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3), READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3),
      content: plane("retrieval-content", readableSearchPlaneBaselineSha256(READABLE_SEARCH_CONTENT_BASELINE_V2), READABLE_SEARCH_CONTENT_BASELINE_V2.schema_version),
      lexical: plane("retrieval-lexical", readableSearchPlaneBaselineSha256(READABLE_SEARCH_LEXICAL_BASELINE_V2), READABLE_SEARCH_LEXICAL_BASELINE_V2.schema_version),
    } },
    exact_head: { ...COORDINATES, position: head.position, record_sha256: head.record_sha256 },
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    organization_member_policy_contract_sha256: contract.organization_member_policy_contract_sha256,
    restricted_reviewer_policy_contract_sha256: contract.restricted_reviewer_policy_contract_sha256,
    project_members_policy_contract_sha256: contract.project_members_policy_contract_sha256,
    analyzer: contract.analyzer, source_revision: contract.source_revision, builder_artifact_sha256: contract.builder_artifact_sha256,
    sqlite_version: (input.record.prepare("SELECT sqlite_version() AS version").get() as { readonly version: string }).version,
    atoms: snapshot.atoms.map((atom) => ({
      authority_id: atom.authority_id, organization_id: atom.organization_id, state_lineage_id: atom.state_lineage_id,
      record_position: atom.record_position, record_sha256: atom.record_sha256, envelope_sha256: envelopes.get(atom.record_position)!,
      approval_id: atom.approval_id, atom_id: atom.atom_id, atom_order: atom.atom_order, signal_id_sha256: atom.signal_id_sha256,
      item_kind: atom.item_kind, text: atom.text, text_sha256: sha256Digest(atom.text),
      policy_id: atom.policy_id, policy_contract_sha256: atom.policy_contract_sha256,
      authorization_audit_event_id: atom.audit_event_id, authorization_audit_sequence: atom.audit_sequence,
      authorization_audit_entry_sha256: atom.audit_entry_sha256, provider_action_sha256: atom.provider_action_sha256,
      authorization_proof_sha256: atom.authorization_proof_sha256,
      reviewer_principal_id: atom.reviewer_principal_id, reviewer_membership_id: atom.reviewer_membership_id,
      ...(atom.audience_project_ids === undefined ? {} : { audience_project_ids: atom.audience_project_ids }),
      ...(atom.association_project_ids === undefined ? {} : { association_project_ids: atom.association_project_ids }),
    })),
  });
  const active: ReadableSearchActiveGenerationV1 = {
    generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256,
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    exact_head: { ...COORDINATES, position: head.position, record_sha256: head.record_sha256 },
  };
  warmReadableSearchActiveGenerationV1({ state_directory: input.state_directory, active_generation: active });
  input.authority.prepare("DELETE FROM authority_readable_search_active_generation").run();
  input.authority.prepare(`INSERT INTO authority_readable_search_active_generation
    (singleton, organization_id, generation_id, manifest_sha256, retrieval_contract_sha256, record_head_position, record_head_hash, published_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)`).run(COORDINATES.organization_id, active.generation_id, active.manifest_sha256, active.retrieval_contract_sha256, head.position, head.record_sha256, "2026-08-21T12:03:00.000Z");
  return active;
}
