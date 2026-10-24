import { canonicalJson, canonicalSha256, sha256Digest, type JsonObject, type JsonValue, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2,
  APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
  HUMAN_ACT_RECORD_INPUT_CODEC_V1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  createRecordInputCodecRegistryV4,
  validateMeetingApprovalEventV2,
  type OrganizationRecordDecisionBriefV1,
  type RecordInputCodecV4,
} from "@echo-brain/organization-protocol";
import {
  RecordRetrievalSourceSnapshotPortV1,
  composeRecordApproverProjectorsV1,
  createPersonPolicyFactProjectorV2,
  createRecordPolicyFactProjectorRegistryV1,
  projectApprovedMeetingPolicyFactsV1,
  type OrganizationRecordAppenderV4,
  type RecordApproverProjectorV1,
  type RecordPolicyFactProjectorV1,
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
import type Database from "better-sqlite3";
import {
  approvedDecisionSnapshotV2Sha256,
  buildHumanActRecordInputV1,
  validateApprovedDecisionSnapshotV2,
  type HumanActEventV1,
} from "../../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  COORDINATES,
  authorizationWitness,
  humanAct,
  processorProvenance,
  receiptFactory,
  sourceProvenance,
  type ProtocolAuthority,
} from "../../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import type { ApprovalDecisionBodyV1 } from "../../src/composition/approval-core-v1.js";
import { buildApprovalDecisionRecordsV1, createApprovalDecisionPolicyProjectorV1 } from "../../src/composition/approval-decision-projection-v1.js";
import { AUTHORITY_RECORD_APPROVER_PROJECTORS_V1 } from "../../src/composition/authority-record-protocols-v1.js";
import { readableSearchGenerationContractV1 } from "../../src/composition/readable-search-generation-composition.js";

/**
 * A test-only protocol for the one thing production no longer writes: an approved meeting that shares its transcript. An
 * approval decision never shares one (ADR-0046), but ADR-0017's grant reader stays, so the readers keep a record to read.
 * Its reference is an approval decision's audience, approver and transcript fields on the common V4 joins.
 */
const TRANSCRIPT_SHARE_KIND = "echo-test-transcript-share-ref-v1";
const TRANSCRIPT_SHARE_FIELD = "test_transcript_share_ref_v1";
const TRANSCRIPT_SHARE_KEYS = ["schema_version", "kind", "authority_id", "organization_id", "state_lineage_id", "approval_id", "action", "final_approver",
  "selected_policy_id", "policy_contract_sha256", "policy_consequence_sha256", "audience_project_ids", "association_project_ids", "share_transcript",
  "transcript_source", "audit_event_id", "audit_sequence", "audit_entry_sha256", "provider_action_kind", "provider_action_schema_version",
  "provider_action_sha256", "authorization_proof_sha256"].sort();
function transcriptShare(reference: unknown, value: unknown) {
  const ref = reference as Record<string, unknown> & { readonly final_approver: { readonly principal_id: string; readonly membership_id: string } };
  if (ref === null || typeof ref !== "object" || Object.keys(ref).sort().join() !== TRANSCRIPT_SHARE_KEYS.join() || ref.kind !== TRANSCRIPT_SHARE_KIND
    || ref.schema_version !== 1 || ref.action !== "approve" || ref.share_transcript !== true) throw new Error("test transcript share reference is invalid");
  const event = validateMeetingApprovalEventV2(value, APPROVAL_DECISION_CONSEQUENCE_KIND_V1);
  if (event.kind !== "approved" || ref.approval_id !== event.approved_snapshot.approval_id || ref.selected_policy_id !== event.policy_id
    || ref.policy_consequence_sha256 !== event.policy_consequence_sha256
    || (["audience_project_ids", "association_project_ids", "share_transcript", "transcript_source"] as const).some((key) =>
      canonicalJson(ref[key] as JsonValue) !== canonicalJson(event.policy_consequence[key] as unknown as JsonValue))) throw new Error("test transcript share differs from its event");
  return { human_act_resolution_ref: ref as never, event, semantic_idempotency_key: canonicalSha256(ref as JsonValue) };
}
const TRANSCRIPT_SHARE_CODEC: RecordInputCodecV4 = Object.freeze({
  input_reference_field: TRANSCRIPT_SHARE_FIELD, reference_kind: TRANSCRIPT_SHARE_KIND, reference_schema_version: 1,
  validateInput: (value: unknown) => transcriptShare((value as Record<string, unknown>)[TRANSCRIPT_SHARE_FIELD], (value as Record<string, unknown>).event),
  fromReference: transcriptShare,
});
const transcriptShareProjector: RecordPolicyFactProjectorV1 = Object.freeze<RecordPolicyFactProjectorV1>({
  id: TRANSCRIPT_SHARE_KIND,
  matches: (envelope) => (envelope.body.human_act_resolution_ref as { readonly kind?: unknown }).kind === TRANSCRIPT_SHARE_KIND,
  policyBinding: (envelope) => {
    const { event } = transcriptShare(envelope.body.human_act_resolution_ref, envelope.body.event);
    if (event.kind !== "approved" || event.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) throw new Error("test transcript share is Only me or projects");
    return { policy_id: event.policy_id, policy_contract_sha256: event.policy_contract_sha256 };
  },
  project: (input) => {
    const { human_act_resolution_ref, event } = transcriptShare(input.envelope.body.human_act_resolution_ref, input.envelope.body.event);
    return projectApprovedMeetingPolicyFactsV1({ ...input, event, reference: human_act_resolution_ref });
  },
});
const transcriptShareApprover: RecordApproverProjectorV1 = (envelope) => {
  const ref = (envelope.body as { readonly human_act_resolution_ref?: Record<string, unknown> & { readonly final_approver?: { readonly principal_id: string; readonly membership_id: string } } })
    .human_act_resolution_ref;
  if (ref?.kind !== TRANSCRIPT_SHARE_KIND || ref.final_approver === undefined) return undefined;
  return { authority_id: ref.authority_id as string, organization_id: ref.organization_id as string, state_lineage_id: ref.state_lineage_id as string,
    approval_id: ref.approval_id as string, principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id };
};

/** The Authority's record codecs (authority-record-protocols-v1.ts: generic human acts and approval decisions), plus the test transcript share. */
export const SIGNED_APPROVAL_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, APPROVAL_DECISION_RECORD_INPUT_CODEC_V2, TRANSCRIPT_SHARE_CODEC]);
/** The Authority's policy projectors, plus the test transcript share's. */
export const SIGNED_APPROVAL_PROJECTORS = createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2(), createApprovalDecisionPolicyProjectorV1(), transcriptShareProjector]);
/** The approver projectors production composes (organization-authority-composition-root.ts), plus the test transcript share's. */
export const SIGNED_APPROVAL_APPROVER = composeRecordApproverProjectorsV1([...AUTHORITY_RECORD_APPROVER_PROJECTORS_V1, transcriptShareApprover]);
/** The prefix of every fixture command_id. It travels in the signed reference and must never be released. */
export const SIGNED_APPROVAL_PRIVATE_MARKER = "cmd-fixture";
export const SIGNED_APPROVAL_ISSUED_AT = "2026-08-21T12:02:00.000Z";

export interface SignedApprovalInputV1 {
  /** The proposal's approval id. An approval decision's record carries the id derived for its destination (approvalRecordIdV2);
   *  any other record carries this one. */
  readonly approval_id: string;
  readonly audit_sequence: number;
  /** A project audience; [] is Only me (both an approval decision, every item routed there). "team" is the whole organization (a generic human act). */
  readonly projects: readonly string[] | "team";
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  /** The receipt and envelope time; it is the meeting's list time. */
  readonly issued_at?: string;
  /** A rejection is a generic human act. */
  readonly action?: "approve" | "reject";
  /** True writes the test transcript share instead of an approval decision (which never shares one). */
  readonly share_transcript?: boolean;
  readonly transcript_source?: { readonly source_id: string; readonly revision_id: string; readonly source_sha256: Sha256Digest };
  /** Signal counts of the fixture brief (one decision by default). */
  readonly signals?: { readonly decisions?: number; readonly actions?: number; readonly rationales?: number };
  /** Reshapes the approved brief (title, time, participants, signals) before it is signed. */
  readonly brief?: (brief: OrganizationRecordDecisionBriefV1) => OrganizationRecordDecisionBriefV1;
  /** Approver-confirmed owners (ADR-0021); approval decisions only. */
  readonly action_owners?: readonly { readonly signal_id: string; readonly owner: string }[];
  /** The decision's surface (default desktop); approval decisions only. */
  readonly surface?: "desktop" | "slack";
}

type SignedEnvelopeInput = Parameters<typeof createOrganizationRecordEnvelopeV4>[0]["human_act_record_input"];

/**
 * One real signed record, appended through the record appender; returns the approval id it was appended under. An approval
 * with an array audience is an approval decision built by the production builder (buildApprovalDecisionRecordsV1) with every
 * item routed to that audience, so it is one record under its destination's derived id; with share_transcript it is the test
 * transcript share instead. A Team approval or a rejection is a generic human act (HUMAN_ACT_RECORD_INPUT_CODEC_V1):
 * production writes neither for meetings, but the Authority still reads them.
 */
export async function appendSignedApprovalV1(
  app: OrganizationRecordAppenderV4,
  authority: ProtocolAuthority,
  input: SignedApprovalInputV1,
): Promise<string> {
  const { approval_id, audit_sequence } = input;
  const final_approver = { principal_id: input.final_approver.principal_id, membership_id: input.final_approver.membership_id };
  const issued_at = input.issued_at ?? SIGNED_APPROVAL_ISSUED_AT;
  const action = input.action ?? "approve";
  const decision = action === "approve" && input.projects !== "team";
  const transform = (snapshot: ReturnType<typeof validateApprovedDecisionSnapshotV2>, surface?: string) => validateApprovedDecisionSnapshotV2({
    ...snapshot, approved_payload: { ...snapshot.approved_payload, ...(surface === undefined ? {} : { surface }),
      brief: input.brief === undefined ? snapshot.approved_payload.brief : input.brief(snapshot.approved_payload.brief) },
  });
  let human_act_record_input: SignedEnvelopeInput, semantic_idempotency_key: Sha256Digest, witness: unknown, appended_as = approval_id;
  if (decision) {
    const fixture = (humanAct(approval_id, "approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, 1, input.signals).event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
    const shaped = transform(fixture, APPROVAL_DECISION_SNAPSHOT_SURFACE_V1);
    // The fixture's reasons support nothing, and a destination group holds only reasons for its items (an unsupported one
    // goes to Only me alone): each supports the first item, so every record keeps every signal it is given.
    const first = [...shaped.approved_payload.brief.decisions, ...shaped.approved_payload.brief.actions][0]?.id;
    const snapshot = validateApprovedDecisionSnapshotV2({ ...shaped, approved_payload: { ...shaped.approved_payload, brief: { ...shaped.approved_payload.brief,
      rationales: shaped.approved_payload.brief.rationales.map((reason) => reason.supports_signal_ids.length > 0 || first === undefined ? reason : { ...reason, supports_signal_ids: [first] }) } } });
    const brief = snapshot.approved_payload.brief;
    if (brief.decisions.length + brief.actions.length === 0) {
      throw new Error("an approval-decision record keeps at least one decision or action (production never stages a proposal without one)");
    }
    if (brief.actions.some((signal) => signal.owner !== null)) {
      throw new Error("an approval-decision snapshot carries no owner; confirmed owners go in action_owners");
    }
    const surface = input.surface ?? "desktop";
    const command_id = `${surface === "slack" ? "slack:" : ""}${SIGNED_APPROVAL_PRIVATE_MARKER}-${approval_id}`;
    const projects = [...(input.projects as readonly string[])];
    const body: ApprovalDecisionBodyV1 = {
      request: { approval_id, command_id, snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot), action: "approve",
        routes: [...brief.decisions, ...brief.actions].map((signal) => ({ signal_id: signal.id, project_ids: projects })), owners: input.action_owners ?? [] },
      surface, actor: { organization_id: COORDINATES.organization_id, ...final_approver },
      evidence: { kind: surface === "desktop" ? "person-session" : "slack-click", sha256: sha256Digest(`evidence-${approval_id}`) },
      transcript_source: input.transcript_source ?? { source_id: `source-${approval_id}`, revision_id: "revision-1", source_sha256: sha256Digest(`source-${approval_id}`) },
      decided_at: issued_at,
    };
    const [built] = buildApprovalDecisionRecordsV1({ coordinates: COORDINATES, decision: { sequence: audit_sequence, body },
      candidate_sha256: sha256Digest(`candidate-${approval_id}`), approved_snapshot: snapshot });
    if (input.share_transcript === true) {
      // The same approval, as the test transcript share: the proposal's own id, its audience, and the transcript granted.
      const { approval_decision_ref_v2: ref, event } = built!.human_act_record_input;
      const proposal = validateApprovedDecisionSnapshotV2({ ...event.approved_snapshot, approval_id });
      const policy_consequence = { ...event.policy_consequence, share_transcript: true };
      const policy_consequence_sha256 = canonicalSha256(policy_consequence as unknown as JsonValue);
      const share = { schema_version: 1, kind: TRANSCRIPT_SHARE_KIND, authority_id: ref.authority_id, organization_id: ref.organization_id,
        state_lineage_id: ref.state_lineage_id, approval_id, action: "approve", final_approver: ref.final_approver, selected_policy_id: ref.selected_policy_id,
        policy_contract_sha256: ref.policy_contract_sha256, policy_consequence_sha256, audience_project_ids: ref.audience_project_ids,
        association_project_ids: ref.association_project_ids, share_transcript: true, transcript_source: ref.transcript_source, audit_event_id: ref.audit_event_id,
        audit_sequence: ref.audit_sequence, audit_entry_sha256: ref.audit_entry_sha256, provider_action_kind: "echo-test-transcript-share-v1",
        provider_action_schema_version: 1, provider_action_sha256: ref.provider_action_sha256, authorization_proof_sha256: ref.authorization_proof_sha256 };
      const shared = { ...event, approved_snapshot: proposal, approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(proposal), policy_consequence, policy_consequence_sha256 };
      human_act_record_input = { [TRANSCRIPT_SHARE_FIELD]: share, event: shared } as unknown as SignedEnvelopeInput;
      semantic_idempotency_key = canonicalSha256(share as unknown as JsonValue);
      witness = {};
    } else {
      human_act_record_input = built!.human_act_record_input as unknown as SignedEnvelopeInput;
      semantic_idempotency_key = built!.semantic_idempotency_key;
      witness = built!.authorization_witness;
      appended_as = built!.approval_id;
    }
  } else {
    if (input.action_owners !== undefined || input.share_transcript === true || input.surface !== undefined) {
      throw new Error("owners, transcript and surface need an approval-decision record");
    }
    const policy = input.projects === "team" ? ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID : RESTRICTED_REVIEWER_PERSON_POLICY_ID;
    const fixture = humanAct(approval_id, action, policy, 1, input.signals);
    const event = fixture.event;
    const changed = event.kind === "approved"
      ? (() => { const snapshot = transform(event.approved_snapshot); return { ...event, approved_snapshot: snapshot, approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(snapshot) }; })()
      : event;
    const human = buildHumanActRecordInputV1({ human_act_resolution_ref: { ...fixture.human_act_resolution_ref, audit_sequence }, event: changed });
    human_act_record_input = { human_act_resolution_ref: human.human_act_resolution_ref, event: human.event, idempotency: human.idempotency } as unknown as SignedEnvelopeInput;
    semantic_idempotency_key = human.semantic_idempotency_key;
    witness = authorizationWitness(human, final_approver);
  }
  await app.append({
    approval_id: appended_as, action, semantic_idempotency_key,
    receipt_issued_at: issued_at, authorization_witness: witness,
    envelope_factory: {
      create: async (allocation) => createOrganizationRecordEnvelopeV4({
        envelope_id: `envelope-${approval_id}`, issued_at,
        predecessor_position: allocation.predecessor_position,
        predecessor_record_sha256: allocation.predecessor_record_sha256,
        human_act_record_input,
        source_provenance: sourceProvenance(), processor_provenance: processorProvenance(),
      }, authority.pinned, COORDINATES.state_lineage_id, authority.sign, SIGNED_APPROVAL_CODECS) as unknown as JsonObject,
      verify: (value) => verifyOrganizationRecordEnvelopeV4(
        value, authority.pinned, COORDINATES.state_lineage_id, SIGNED_APPROVAL_CODECS,
      ) as unknown as V4RecordEnvelopeView & JsonObject,
    },
    receipt_factory: receiptFactory(authority, { sign_calls: { value: 0 } }, SIGNED_APPROVAL_CODECS),
  });
  return appended_as;
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
