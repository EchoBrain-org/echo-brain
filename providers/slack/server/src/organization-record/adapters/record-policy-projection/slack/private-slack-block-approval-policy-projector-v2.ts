/** V2 projector for project-scoped Slack approvals. V1 remains frozen. */
import { canonicalSha256, sha256Digest, type JsonObject, type Sha256Digest } from "@echo-brain/federation-protocol";
import { PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID } from "@echo-brain/organization-protocol";
import { derivedAtomIdentity } from "@echo-brain/organization-record/application/atom-identity";
import type { RecordApproverV1 } from "@echo-brain/organization-record/application/record-approver-projection-v1";
import type { RecordPolicyFactEnvelopeV1, RecordPolicyFactProjectorV1 } from "@echo-brain/organization-record/application/record-policy-fact-projection-v1";
import type { PersonPolicyFactItemKindV2, PersonPolicyFactProjectionV2, PersonPolicyFactRowV2 } from "@echo-brain/organization-record/application/person-policy-fact-contracts-v2";
import {
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
  validatePrivateSlackBlockApprovalRecordInputV2,
} from "../../../../organization-protocol/private-slack-block-approval-record-input-v2.js";

export const PRIVATE_SLACK_BLOCK_APPROVAL_AUTHORIZATION_WITNESS_V2_KIND =
  "echo-private-slack-block-approval-authorization-witness-v2" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(detail: string): never { throw new Error(`private Slack approval policy projector v2 ${detail}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = object(value, label); const actual = Object.keys(record).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has an unexpected shape`);
  return record;
}
function digest(value: unknown, label: string): Sha256Digest { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 digest`); return value as Sha256Digest; }
function text(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) fail(`${label} must be text`); return value; }
function same(left: unknown, right: unknown, label: string): void { if (left !== right) fail(`${label} does not match`); }
function sameArray(left: readonly string[], right: unknown, label: string): void { if (!Array.isArray(right) || left.length !== right.length || left.some((id, index) => id !== right[index])) fail(`${label} does not match`); }

function validateWitness(value: unknown, ref: ReturnType<typeof validatePrivateSlackBlockApprovalRecordInputV2>["private_slack_block_approval_resolution_ref_v2"]): void {
  const witness = exact(value, ["authorization_allow", "authorization_proof_sha256", "provider_action_kind", "provider_action_schema_version", "audit_entry", "audit_entry_sha256"], "witness");
  if (witness.provider_action_kind !== "echo-signed-slack-block-action-v1" || witness.provider_action_schema_version !== 1) fail("witness provider action is unsupported");
  const allow = exact(witness.authorization_allow, ["authority_id", "organization_id", "state_lineage_id", "approval_id", "action", "final_approver", "selected_policy_id", "policy_contract_sha256", "policy_consequence_sha256", "audience_project_ids", "association_project_ids", "share_transcript", "transcript_source", "provider_action_sha256", "decision"], "witness allow");
  if (allow.decision !== "allow" || allow.action !== "approve") fail("witness allow is not approved");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "approval_id", "selected_policy_id", "policy_contract_sha256", "policy_consequence_sha256", "provider_action_sha256"] as const) same(allow[key], ref[key], `witness allow ${key}`);
  sameArray(ref.audience_project_ids, allow.audience_project_ids, "witness audience projects"); sameArray(ref.association_project_ids, allow.association_project_ids, "witness association projects");
  same(allow.share_transcript, ref.share_transcript, "witness transcript sharing");
  const source = exact(allow.transcript_source, ["source_id", "revision_id", "source_sha256"], "witness transcript source");
  same(source.source_id, ref.transcript_source.source_id, "witness transcript source id"); same(source.revision_id, ref.transcript_source.revision_id, "witness transcript revision"); same(source.source_sha256, ref.transcript_source.source_sha256, "witness transcript hash");
  const approver = exact(allow.final_approver, ["principal_id", "membership_id"], "witness approver"); same(approver.principal_id, ref.final_approver.principal_id, "witness approver principal"); same(approver.membership_id, ref.final_approver.membership_id, "witness approver membership");
  same(witness.authorization_proof_sha256, ref.authorization_proof_sha256, "witness authorization proof");
  const audit = exact(witness.audit_entry, ["authority_id", "organization_id", "state_lineage_id", "audit_event_id", "audit_sequence", "actor_class", "principal_id", "membership_id", "action", "subject_kind", "subject_id", "detail_digest", "provider_action_sha256"], "witness audit");
  if (audit.actor_class !== "provider_human" || audit.action !== "approve" || audit.subject_kind !== "approval") fail("witness audit is unsupported");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "audit_event_id", "audit_sequence", "provider_action_sha256"] as const) same(audit[key], ref[key], `witness audit ${key}`);
  same(audit.principal_id, ref.final_approver.principal_id, "witness audit principal"); same(audit.membership_id, ref.final_approver.membership_id, "witness audit membership"); same(audit.subject_id, ref.approval_id, "witness audit subject"); same(audit.detail_digest, ref.authorization_proof_sha256, "witness audit detail");
  same(digest(witness.audit_entry_sha256, "witness audit digest"), ref.audit_entry_sha256, "witness audit digest");
  if (canonicalSha256(audit) !== witness.audit_entry_sha256) fail("witness audit digest is not bound to audit entry");
}
function signals(event: unknown): readonly { readonly id: string; readonly kind: PersonPolicyFactItemKindV2 }[] {
  const approved = object(event, "event"); const snapshot = object(approved.approved_snapshot, "snapshot"); const payload = object(snapshot.approved_payload, "payload"); const brief = object(payload.brief, "brief"); const result: { id: string; kind: PersonPolicyFactItemKindV2 }[] = []; const seen = new Set<string>();
  for (const [field, kind] of [["decisions", "decision"], ["actions", "action"], ["rationales", "rationale"]] as const) {
    const items = brief[field]; if (!Array.isArray(items)) fail(`brief ${field} must be an array`);
    for (const item of items) { const signal = object(item, `brief ${field} signal`); const id = text(signal.id, `brief ${field} signal id`); if (signal.kind !== kind || seen.has(id)) fail("brief signal is invalid"); seen.add(id); result.push({ id, kind }); }
  }
  return Object.freeze(result);
}

export function projectPrivateSlackBlockApprovalPolicyFactsV2(input: { readonly envelope: RecordPolicyFactEnvelopeV1; readonly record_position: number; readonly witness: unknown }): PersonPolicyFactProjectionV2 {
  if (!Number.isSafeInteger(input.record_position) || input.record_position < 1) fail("record position is invalid");
  const body = input.envelope.body;
  const parsed = validatePrivateSlackBlockApprovalRecordInputV2({ [PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD]: body.human_act_resolution_ref, event: body.event });
  if (parsed.event.kind === "rejected") return Object.freeze({ facts: Object.freeze([]), policy_fact_outcome: Object.freeze({ kind: "none" }) });
  const ref = parsed.private_slack_block_approval_resolution_ref_v2; validateWitness(input.witness, ref);
  const facts: PersonPolicyFactRowV2[] = signals(parsed.event).map((signal, atom_order) => {
    const common = { authority_id: ref.authority_id, organization_id: ref.organization_id, state_lineage_id: ref.state_lineage_id, approval_id: ref.approval_id, action: "approve" as const, policy_id: ref.selected_policy_id!, policy_contract_sha256: ref.policy_contract_sha256!, record_position: input.record_position, record_sha256: input.envelope.record_sha256, atom_order, signal_id_sha256: sha256Digest(signal.id), atom_id: derivedAtomIdentity(input.envelope.record_sha256, signal.id), item_kind: signal.kind, audit_event_id: ref.audit_event_id, audit_sequence: ref.audit_sequence, audit_entry_sha256: ref.audit_entry_sha256, provider_action_sha256: ref.provider_action_sha256, authorization_proof_sha256: ref.authorization_proof_sha256 };
    if (ref.selected_policy_id === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) return Object.freeze({ ...common, policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID });
    if (ref.selected_policy_id === "restricted-reviewer-person-v2") return Object.freeze({ ...common, policy_id: ref.selected_policy_id, reviewer_principal_id: ref.final_approver.principal_id, reviewer_membership_id: ref.final_approver.membership_id });
    return Object.freeze({ ...common, policy_id: "organization-member-readable-person-v2" as const });
  });
  return Object.freeze({ facts: Object.freeze(facts), policy_fact_outcome: Object.freeze({ kind: "appended", policy_id: ref.selected_policy_id! }) });
}

export function createPrivateSlackBlockApprovalPolicyProjectorV2(): RecordPolicyFactProjectorV1 {
  return Object.freeze({ id: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
    matches: (envelope: RecordPolicyFactEnvelopeV1) => (envelope.body.human_act_resolution_ref as { readonly kind?: unknown }).kind === PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
    project: ({ envelope, record_position, witness }: { readonly envelope: RecordPolicyFactEnvelopeV1; readonly record_position: number; readonly witness: unknown }) => projectPrivateSlackBlockApprovalPolicyFactsV2({ envelope, record_position, witness }),
    policyBinding: (envelope: RecordPolicyFactEnvelopeV1) => { const parsed = validatePrivateSlackBlockApprovalRecordInputV2({ [PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD]: envelope.body.human_act_resolution_ref, event: envelope.body.event }); const ref = parsed.private_slack_block_approval_resolution_ref_v2; if (parsed.event.kind !== "approved" || ref.selected_policy_id === null || ref.policy_contract_sha256 === null) fail("approved V2 policy binding is unavailable"); return Object.freeze({ policy_id: ref.selected_policy_id, policy_contract_sha256: ref.policy_contract_sha256 }); },
  });
}

/**
 * Optional display metadata for a record that has already passed the record
 * authorization path. This V2 branch must validate the V2 envelope in full;
 * V1 decoding would silently discard the frozen project and transcript facts.
 */
export function projectPrivateSlackBlockApprovalApproverV2(
  envelope: JsonObject,
): RecordApproverV1 | undefined {
  const rawBody = envelope.body;
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return undefined;
  }
  const body = rawBody as Record<string, unknown>;
  if (body.event === null || typeof body.event !== "object" ||
      Array.isArray(body.event) || (body.event as Record<string, unknown>).kind !== "approved") {
    return undefined;
  }
  try {
    const parsed = validatePrivateSlackBlockApprovalRecordInputV2({
      [PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_V2_FIELD]: body.human_act_resolution_ref,
      event: body.event,
    });
    if (parsed.event.kind !== "approved") return undefined;
    const ref = parsed.private_slack_block_approval_resolution_ref_v2;
    if (body.authority_id !== ref.authority_id ||
        body.organization_id !== ref.organization_id ||
        body.state_lineage_id !== ref.state_lineage_id) {
      return undefined;
    }
    return Object.freeze({
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      approval_id: ref.approval_id,
      principal_id: ref.final_approver.principal_id,
      membership_id: ref.final_approver.membership_id,
    });
  } catch {
    return undefined;
  }
}
