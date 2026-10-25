import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256, sha256Digest, type JsonValue } from "@echo-brain/federation-protocol";
import {
  APPROVAL_DECISION_CONSEQUENCE_KIND_V1,
  APPROVAL_DECISION_FIELD_V2,
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2,
  APPROVAL_DECISION_REF_KIND_V2,
  APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
  approvalDecisionSubsetSnapshotV2,
  approvalRecordIdV2,
  validateApprovalDecisionRecordInputV2,
} from "../src/approval-decision-record-input-v2.js";
import { isApprovalOwnerTextV1 } from "../src/approval-owner-choice-v1.js";
import { approvedDecisionSnapshotV2Sha256, validateApprovedDecisionSnapshotV2 } from "../src/human-act-record-input-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../src/person-content-policy-v2.js";
import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1 } from "../src/record-input-codec-v4.js";

const PROPOSAL_ID = `apr_${"a".repeat(64)}`;
const PROJECT_1 = "prj_00000000-0000-4000-8000-000000000001";
const PROJECT_2 = "prj_00000000-0000-4000-8000-000000000002";
type Mutable = Record<string, unknown>;
type PolicyId = typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID | typeof PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;

interface Options {
  readonly projects?: readonly string[];
  readonly policy?: PolicyId;
  readonly owners?: readonly { readonly signal_id: string; readonly owner: string }[];
  readonly surface?: "desktop" | "slack";
  readonly command_id?: string;
  readonly decisions?: number;
  readonly actions?: readonly { readonly id: string; readonly owner?: string | null }[];
  readonly rationales?: readonly { readonly id: string; readonly supports: readonly string[] }[];
  readonly snapshot_surface?: string;
  /** Puts the retired transcript fields (ADR-0046) back in the reference and its consequence, digests included. */
  readonly share_transcript?: boolean;
  readonly route_signal_ids?: readonly string[];
  /** Every span quotes this text, as each item of a one-paragraph note quotes the whole note. */
  readonly quote?: string;
}

function snapshot(options: Options, approval_id: string) {
  const evidence = (block: string) => [{ meeting_id: "meeting-1", block_id: block, ...(options.quote === undefined ? {} : { quote: options.quote }) }];
  return validateApprovedDecisionSnapshotV2({
    schema_version: 2, kind: "echo-approved-decision-snapshot-v2", approval_id,
    staged_content_sha256: sha256Digest("staged"), final_content_sha256: sha256Digest("final"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: {
      brief: {
        schema_version: 1, id: "brief-1", meeting: { id: "meeting-1", participants: [] },
        decisions: Array.from({ length: options.decisions ?? 1 }, (_, index) => ({
          id: `dec-${index + 1}`, kind: "decision", text: `Decision ${index + 1}`, subject: null, confidence: null, evidence: evidence(`d${index}`), status: "decided",
        })),
        actions: (options.actions ?? [{ id: "act-1" }, { id: "act-2" }]).map((action, index) => ({
          id: action.id, kind: "action", text: `Action ${index + 1}`, subject: null, confidence: null, owner: action.owner ?? null, due_at: null, evidence: evidence(`a${index}`),
        })),
        rationales: (options.rationales ?? []).map((rationale, index) => ({
          id: rationale.id, kind: "rationale", text: `Reason ${index + 1}`, subject: null, confidence: null, evidence: evidence(`r${index}`), supports_signal_ids: [...rationale.supports],
        })),
        provenance: { meeting_revision: "revision-1", processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "primary", version: "1.0.0" }, generated_at: "2026-10-07T09:00:00.000Z" },
      },
      source: { adapter_id: "granola", instance_id: "primary", external_id: "note-1" },
      alternatives: [], links: null, reviewed_at: "2026-10-07T09:00:00.000Z", surface: options.snapshot_surface ?? APPROVAL_DECISION_SNAPSHOT_SURFACE_V1,
    },
  });
}

function validInput(options: Options = {}) {
  const projects = [...(options.projects ?? [])];
  const policy_id: PolicyId = options.policy ?? (projects.length === 0 ? RESTRICTED_REVIEWER_PERSON_POLICY_ID : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
  const policy_contract_sha256 = policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? restrictedReviewerPersonPolicyContractSha256()
    : policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID ? projectMembersReadablePersonPolicyContractSha256() : organizationMemberReadablePersonPolicyContractSha256();
  const approval_id = approvalRecordIdV2(PROPOSAL_ID, projects);
  const approved = snapshot(options, approval_id);
  const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(approved);
  const brief = approved.approved_payload.brief;
  const transcript = options.share_transcript === undefined ? {}
    : { share_transcript: options.share_transcript, transcript_source: { source_id: "source-1", revision_id: "revision-1", source_sha256: sha256Digest("source-1") } };
  const consequence = { schema_version: 2, kind: APPROVAL_DECISION_CONSEQUENCE_KIND_V1, policy_id, audience_project_ids: projects, association_project_ids: projects, ...transcript };
  const policy_consequence_sha256 = canonicalSha256(consequence as unknown as JsonValue);
  const surface = options.surface ?? "desktop";
  const command_id = options.command_id ?? (surface === "slack" ? "slack:k1" : "cmd-1");
  const ref: Mutable = {
    schema_version: 2, kind: APPROVAL_DECISION_REF_KIND_V2,
    authority_id: "oau_00000000-0000-4000-8000-000000000001", organization_id: "org_00000000-0000-4000-8000-000000000002", state_lineage_id: "lineage-1",
    approval_id, proposal_approval_id: PROPOSAL_ID, command_id, action: "approve", surface,
    candidate_sha256: sha256Digest("candidate"), proposal_snapshot_sha256: sha256Digest("proposal snapshot"), approved_snapshot_sha256,
    route_signal_ids: options.route_signal_ids ?? [...brief.decisions, ...brief.actions].map(signal => signal.id),
    final_approver: { principal_id: "prn_1", membership_id: "mem_1" },
    selected_policy_id: policy_id, policy_contract_sha256, policy_consequence_sha256,
    audience_project_ids: projects, association_project_ids: projects, ...transcript,
    action_owners: options.owners ?? [],
    audit_event_id: `audit:${command_id}`, audit_sequence: 7, audit_entry_sha256: sha256Digest("audit"),
    provider_action_kind: "echo-approval-decision-v2", provider_action_schema_version: 2,
    provider_action_sha256: sha256Digest("action"), authorization_proof_sha256: sha256Digest("authorization"), approved_at: "2026-10-07T09:01:00.000Z",
  };
  const event: Mutable = { kind: "approved", approved_snapshot: approved, approved_snapshot_sha256, policy_id, policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256 };
  return { [APPROVAL_DECISION_FIELD_V2]: ref, event } as { approval_decision_ref_v2: Mutable; event: Mutable };
}
const refuses = (value: unknown, message?: string | RegExp) => expect(() => validateApprovalDecisionRecordInputV2(value)).toThrow(message);

describe("approval decision record input v2", () => {
  it("round-trips a valid reference", () => {
    const input = validInput({ projects: [PROJECT_1], owners: [{ signal_id: "act-1", owner: "Rafael M." }] });
    const validated = APPROVAL_DECISION_RECORD_INPUT_CODEC_V2.validateInput(input);
    expect(canonicalJson(validated.human_act_resolution_ref as unknown as JsonValue)).toBe(canonicalJson(input.approval_decision_ref_v2 as JsonValue));
    expect(canonicalJson(validated.event as unknown as JsonValue)).toBe(canonicalJson(input.event as JsonValue));
    expect(validated.semantic_idempotency_key).toBe(canonicalSha256(input.approval_decision_ref_v2 as JsonValue));
    const again = APPROVAL_DECISION_RECORD_INPUT_CODEC_V2.fromReference(input.approval_decision_ref_v2, input.event);
    expect(canonicalJson(again as unknown as JsonValue)).toBe(canonicalJson(validated as unknown as JsonValue));
    const registry = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, APPROVAL_DECISION_RECORD_INPUT_CODEC_V2]);
    expect(registry.validateInput(input).semantic_idempotency_key).toBe(validated.semantic_idempotency_key);
    expect(registry.fromReference(input.approval_decision_ref_v2, input.event).human_act_resolution_ref.kind).toBe(APPROVAL_DECISION_REF_KIND_V2);
    expect(APPROVAL_DECISION_RECORD_INPUT_CODEC_V2).toMatchObject({ input_reference_field: "approval_decision_ref_v2", reference_kind: "echo-approval-decision-ref-v2", reference_schema_version: 2 });
  });
  it("accepts Only me and projects, each under its own derived record id", () => {
    const only = validateApprovalDecisionRecordInputV2(validInput());
    expect(only.event.policy_id).toBe(RESTRICTED_REVIEWER_PERSON_POLICY_ID);
    const projects = validateApprovalDecisionRecordInputV2(validInput({ projects: [PROJECT_1, PROJECT_2] }));
    expect(projects.event.policy_id).toBe(PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID);
    expect(projects.approval_decision_ref_v2.audience_project_ids).toEqual([PROJECT_1, PROJECT_2]);
    expect(only.approval_decision_ref_v2.approval_id).toBe(`apr_${canonicalSha256({ kind: "echo-approval-route-v1", approval_id: PROPOSAL_ID, project_ids: [] }).slice(7)}`);
    expect(projects.approval_decision_ref_v2.approval_id).toBe(approvalRecordIdV2(PROPOSAL_ID, [PROJECT_1, PROJECT_2]));
    expect(new Set([only, projects, validateApprovalDecisionRecordInputV2(validInput({ projects: [PROJECT_1] }))].map(value => value.approval_decision_ref_v2.approval_id)).size).toBe(3);
    expect(only.approval_decision_ref_v2.approval_id).toMatch(/^apr_[0-9a-f]{64}$/);
  });
  it("refuses a record id that is not its destination's", () => {
    const other = validInput({ projects: [PROJECT_1] });
    other.approval_decision_ref_v2.proposal_approval_id = `apr_${"b".repeat(64)}`;
    refuses(other, "destination");
    // The snapshot names the record id, so a record cannot claim another destination's id either.
    const swapped = validInput({ projects: [PROJECT_1] });
    const id = approvalRecordIdV2(PROPOSAL_ID, [PROJECT_2]);
    swapped.approval_decision_ref_v2.approval_id = id;
    refuses(swapped);
  });
  it("refuses an extra or missing key", () => {
    const extraInput = validInput() as Mutable; extraInput.extra = 1; refuses(extraInput);
    const missingInput = validInput() as Mutable; delete missingInput.event; refuses(missingInput);
    const extraRef = validInput(); extraRef.approval_decision_ref_v2.frozen_card_sha256 = sha256Digest("card"); refuses(extraRef);
    for (const key of ["action_owners", "route_signal_ids", "proposal_approval_id", "proposal_snapshot_sha256"]) {
      const missingRef = validInput(); delete missingRef.approval_decision_ref_v2[key]; refuses(missingRef);
    }
    const approver = validInput(); (approver.approval_decision_ref_v2.final_approver as Mutable).extra = "x"; refuses(approver);
    const owner = validInput({ owners: [{ signal_id: "act-1", owner: "Jules" }] });
    (owner.approval_decision_ref_v2.action_owners as Mutable[])[0]!.note = "x"; refuses(owner);
  });
  it("refuses the v1 reference and its field", () => {
    const v1 = validInput(); v1.approval_decision_ref_v2.schema_version = 1; v1.approval_decision_ref_v2.kind = "echo-approval-decision-ref-v1"; refuses(v1, "unsupported");
    const action = validInput(); action.approval_decision_ref_v2.provider_action_kind = "echo-approval-decision-v1"; refuses(action, "unsupported");
    const version = validInput(); version.approval_decision_ref_v2.provider_action_schema_version = 1; refuses(version, "unsupported");
    const input = validInput();
    refuses({ approval_decision_ref_v1: input.approval_decision_ref_v2, event: input.event });
  });
  it("refuses the retired transcript fields (ADR-0046), even when reference and event agree", () => {
    for (const share_transcript of [true, false]) {
      refuses(validInput({ share_transcript }), "unexpected shape");
      refuses(validInput({ projects: [PROJECT_1], share_transcript }), "unexpected shape");
    }
  });
  it("refuses Team even when reference and event agree", () => {
    refuses(validInput({ policy: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID }), "Only me or projects");
  });
  it("refuses a rejected event and action reject", () => {
    const rejected = validInput(); rejected.event = { kind: "rejected" }; refuses(rejected);
    const reject = validInput(); reject.approval_decision_ref_v2.action = "reject"; refuses(reject, "unsupported");
  });
  it("binds the command to its surface", () => {
    expect(validateApprovalDecisionRecordInputV2(validInput({ surface: "slack", command_id: "slack:k1" })).approval_decision_ref_v2.surface).toBe("slack");
    refuses(validInput({ surface: "slack", command_id: "cmd-1" }), "surface");
    refuses(validInput({ surface: "desktop", command_id: "slack:x" }), "surface");
    const email = validInput(); email.approval_decision_ref_v2.surface = "email"; refuses(email, "surface");
  });
  it("refuses an audit event that is not its command", () => {
    const input = validInput(); input.approval_decision_ref_v2.audit_event_id = "audit:other"; refuses(input, "audit event");
  });
  it.each([
    ["miss an item", ["dec-1", "act-1"]],
    ["name an item twice", ["dec-1", "act-1", "act-1", "act-2"]],
    ["are out of brief order", ["act-1", "dec-1", "act-2"]],
    ["name another record's item", ["dec-1", "act-1", "act-2", "act-9"]],
    ["name a rationale", ["dec-1", "act-1", "act-2", "why-1"]],
    ["are empty", []],
    ["hold a non-identifier", ["dec-1", "act-1", "act 2"]],
  ])("refuses routes that %s", (_label, route_signal_ids) => {
    refuses(validInput({ route_signal_ids, rationales: [{ id: "why-1", supports: ["dec-1"] }] }), "routes differ");
  });
  it("accepts a record of actions alone, and refuses one that keeps no decision or action", () => {
    expect(validateApprovalDecisionRecordInputV2(validInput({ decisions: 0, actions: [{ id: "act-1" }] })).approval_decision_ref_v2.route_signal_ids).toEqual(["act-1"]);
    refuses(validInput({ decisions: 0, actions: [], route_signal_ids: [] }), "keeps no decision or action");
    refuses(validInput({ decisions: 0, actions: [], rationales: [{ id: "why-1", supports: [] }], route_signal_ids: [] }), "keeps no decision or action");
  });
  it("keeps rationale links inside the record's brief", () => {
    expect(validateApprovalDecisionRecordInputV2(validInput({ rationales: [{ id: "why-1", supports: ["dec-1", "act-2"] }, { id: "why-2", supports: [] }] }))
      .event.approved_snapshot.approved_payload.brief.rationales).toHaveLength(2);
    expect(() => validInput({ rationales: [{ id: "why-1", supports: ["dec-9"] }] })).toThrow("rationale links");
  });
  it.each([
    ["repeat a signal", [{ signal_id: "act-1", owner: "A" }, { signal_id: "act-1", owner: "B" }]],
    ["name an unknown signal", [{ signal_id: "act-99", owner: "A" }]],
    ["name a decision", [{ signal_id: "dec-1", owner: "A" }]],
    ["are out of brief order", [{ signal_id: "act-2", owner: "A" }, { signal_id: "act-1", owner: "B" }]],
    ["number 41", Array.from({ length: 41 }, (_, index) => ({ signal_id: `act-${index + 1}`, owner: "A" }))],
  ])("refuses owners that %s", (_label, owners) => {
    const actions = Array.from({ length: 41 }, (_, index) => ({ id: `act-${index + 1}` }));
    refuses(validInput({ owners, actions }));
  });
  it("refuses an owner of an action this record does not hold", () => {
    refuses(validInput({ actions: [{ id: "act-1" }], owners: [{ signal_id: "act-2", owner: "Ana" }] }), "owners");
  });
  it("accepts owner text with a double space or non-NFC form", () => {
    for (const owner of ["Rafael  M.", "José"]) {
      expect(validateApprovalDecisionRecordInputV2(validInput({ owners: [{ signal_id: "act-1", owner }] })).approval_decision_ref_v2.action_owners).toEqual([{ signal_id: "act-1", owner }]);
    }
  });
  it("refuses a snapshot whose unnamed action carries an owner", () => {
    refuses(validInput({ actions: [{ id: "act-1" }, { id: "act-2", owner: "Jules" }] }), "owner");
    refuses(validInput({ actions: [{ id: "act-1" }, { id: "act-2", owner: "Jules" }], owners: [{ signal_id: "act-1", owner: "Ana" }] }), "owner");
  });
  it("refuses a snapshot surface other than echo-approval-core", () => {
    refuses(validInput({ snapshot_surface: "person-approval" }), "approval core");
  });
  it.each([
    ["audience", (ref: Mutable) => { ref.audience_project_ids = [PROJECT_2]; }],
    ["association", (ref: Mutable) => { ref.association_project_ids = [PROJECT_2]; }],
    ["consequence digest", (ref: Mutable) => { ref.policy_consequence_sha256 = sha256Digest("other"); }],
    ["snapshot digest", (ref: Mutable) => { ref.approved_snapshot_sha256 = sha256Digest("other"); }],
    ["policy id", (ref: Mutable) => { ref.selected_policy_id = RESTRICTED_REVIEWER_PERSON_POLICY_ID; }],
    ["approval id", (ref: Mutable) => { ref.approval_id = `apr_${"b".repeat(64)}`; }],
  ])("refuses a reference that differs from its event: %s", (_label, change) => {
    const input = validInput({ projects: [PROJECT_1] });
    change(input.approval_decision_ref_v2);
    refuses(input);
  });
  it("refuses an owner exactly when the shared owner rule does", () => {
    const samples = ["Jules", " Jules", "Jules ", "", "x".repeat(120), "x".repeat(121), "a\u0007b", "a​b", "Ana  Lima", "José", "é", "a\tb", "Zoë"];
    for (const owner of samples) {
      const accepted = (() => { try { validateApprovalDecisionRecordInputV2(validInput({ owners: [{ signal_id: "act-1", owner }] })); return true; } catch { return false; } })();
      expect(accepted, JSON.stringify(owner)).toBe(isApprovalOwnerTextV1(owner));
    }
  });
  it("derives a destination's subset snapshot: its items, a reason for a project only when it holds every item the reason supports, and Only me's own reasons pruned plus the unsupported ones", () => {
    const proposal = snapshot({ rationales: [{ id: "why-1", supports: ["dec-1", "act-1"] }, { id: "why-2", supports: ["act-2"] }, { id: "why-3", supports: [] }] }, PROPOSAL_ID);
    const before = canonicalJson(proposal as unknown as JsonValue);
    const group = { approval_id: approvalRecordIdV2(PROPOSAL_ID, [PROJECT_1]), project_ids: [PROJECT_1], signal_ids: ["act-1", "act-2"] };
    const subset = approvalDecisionSubsetSnapshotV2(proposal, group);
    expect(subset.approval_id).toBe(group.approval_id);
    expect(subset.staged_content_sha256).toBe(proposal.staged_content_sha256);
    expect(subset.final_content_sha256).toBe(canonicalSha256(subset.approved_payload as unknown as JsonValue));
    const brief = subset.approved_payload.brief;
    expect([brief.decisions.length, brief.actions.map(action => action.id)]).toEqual([0, ["act-1", "act-2"]]);
    // why-1 may speak of dec-1, which goes elsewhere (Only me below), so the project never reads it.
    expect(brief.rationales.map(reason => [reason.id, reason.supports_signal_ids])).toEqual([["why-2", ["act-2"]]]);
    const whole = approvalDecisionSubsetSnapshotV2(proposal, { ...group, signal_ids: ["dec-1", "act-1"] });
    expect(whole.approved_payload.brief.rationales.map(reason => [reason.id, reason.supports_signal_ids])).toEqual([["why-1", ["dec-1", "act-1"]]]);
    const only = approvalDecisionSubsetSnapshotV2(proposal, { approval_id: approvalRecordIdV2(PROPOSAL_ID, []), project_ids: [], signal_ids: ["dec-1"] });
    expect(only.approved_payload.brief.rationales.map(reason => [reason.id, reason.supports_signal_ids])).toEqual([["why-1", ["dec-1"]], ["why-3", []]]);
    // Pure: the same bytes from a copy, and the proposal is untouched.
    expect(canonicalJson(approvalDecisionSubsetSnapshotV2(JSON.parse(before), group) as unknown as JsonValue)).toBe(canonicalJson(subset as unknown as JsonValue));
    expect(canonicalJson(proposal as unknown as JsonValue)).toBe(before);
    // A group names decisions or actions of its proposal, each once; anything else is refused.
    for (const signal_ids of [[], ["act-9"], ["why-1"], ["act-1", "act-1"]]) {
      expect(() => approvalDecisionSubsetSnapshotV2(proposal, { ...group, signal_ids })).toThrow("group names items");
    }
    expect(() => approvalDecisionSubsetSnapshotV2({ ...proposal, kind: "other" }, group)).toThrow();
  });
  it("keeps no quote in a project's subset, since a quote is the cited note text and can speak of any item, and keeps every quote for Only me", () => {
    const note = "Totals show two decimals. Project B runs the six-test matrix VIOLET-62. Keep the supplier reserve SILVER-95.";
    const proposal = snapshot({ decisions: 3, actions: [{ id: "act-1" }], rationales: [{ id: "why-1", supports: ["dec-1"] }], quote: note }, PROPOSAL_ID);
    const project = approvalDecisionSubsetSnapshotV2(proposal, { approval_id: approvalRecordIdV2(PROPOSAL_ID, [PROJECT_1]), project_ids: [PROJECT_1], signal_ids: ["dec-1", "act-1"] });
    const brief = project.approved_payload.brief;
    const ids = (signals: readonly { readonly id: string }[]) => signals.map(signal => signal.id);
    expect([ids(brief.decisions), ids(brief.actions), ids(brief.rationales)]).toEqual([["dec-1"], ["act-1"], ["why-1"]]);
    // The whole record, not one field: no quote key anywhere, so no other item's words, and every span keeps its reference.
    const whole = canonicalJson(project as unknown as JsonValue);
    for (const leaked of ['"quote"', "VIOLET-62", "SILVER-95", "Totals show"]) expect(whole).not.toContain(leaked);
    expect([...brief.decisions, ...brief.actions, ...brief.rationales].map(signal => signal.evidence))
      .toEqual([[{ meeting_id: "meeting-1", block_id: "d0" }], [{ meeting_id: "meeting-1", block_id: "a0" }], [{ meeting_id: "meeting-1", block_id: "r0" }]]);
    expect(project.final_content_sha256).toBe(canonicalSha256(project.approved_payload as unknown as JsonValue));
    const only = approvalDecisionSubsetSnapshotV2(proposal, { approval_id: approvalRecordIdV2(PROPOSAL_ID, []), project_ids: [], signal_ids: ["dec-2"] });
    expect(only.approved_payload.brief.decisions.map(signal => signal.evidence)).toEqual([[{ meeting_id: "meeting-1", block_id: "d1", quote: note }]]);
  });
  it("freezes its result and does not alias the input", () => {
    const input = validInput();
    const result = validateApprovalDecisionRecordInputV2(input);
    expect(Object.isFrozen(result)).toBe(true);
    const before = canonicalJson(result.approval_decision_ref_v2 as unknown as JsonValue);
    (input.approval_decision_ref_v2 as Mutable).audit_sequence = 99;
    expect(canonicalJson(result.approval_decision_ref_v2 as unknown as JsonValue)).toBe(before);
  });
});
