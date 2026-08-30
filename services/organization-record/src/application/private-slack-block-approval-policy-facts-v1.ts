import { sha256Digest } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { derivedAtomIdentity } from "./atom-identity.js";
import type {
  RecordPolicyFactEnvelopeV1,
  RecordPolicyFactProjectorV1,
} from "./record-policy-fact-projection-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonPolicyFactItemKindV2,
  type PersonPolicyFactProjectionV2,
  type PersonPolicyFactRowV2,
  type PersonPolicyIdV2,
} from "./person-policy-facts-v2.js";

/**
 * D3 projection for the private Slack Block Kit approval protocol. This is
 * deliberately separate from the legacy provider-human/reaction witness so a
 * signed Block Kit action cannot be type-confused with that older contract.
 */
export const PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND =
  "echo-private-slack-block-approval-resolution-ref-v1" as const;
export const SIGNED_SLACK_BLOCK_ACTION_V1_KIND =
  "echo-signed-slack-block-action-v1" as const;

export interface PrivateSlackBlockApprovalPolicyFactsInputV1 {
  readonly envelope: unknown;
  readonly record_position: number;
  readonly witness: unknown;
}

/** D2 revalidation shape for the signed private Slack Block Kit action. */
export interface RevalidatedPrivateSlackBlockApprovalAuthorizationWitnessV1 {
  readonly authorization_allow: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly approval_id: string;
    readonly action: "approve" | "reject";
    readonly final_approver: {
      readonly principal_id: string;
      readonly membership_id: string;
    };
    readonly selected_policy_id: PersonPolicyIdV2 | null;
    readonly policy_contract_sha256: Sha256Digest | null;
    readonly provider_action_sha256: Sha256Digest;
    readonly decision: "allow";
  };
  readonly authorization_proof_sha256: Sha256Digest;
  readonly provider_action_kind: typeof SIGNED_SLACK_BLOCK_ACTION_V1_KIND;
  readonly provider_action_schema_version: 1;
  readonly audit_entry: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly actor_class: "provider_human";
    readonly principal_id: string;
    readonly membership_id: string;
    readonly action: "approve" | "reject";
    readonly subject_kind: "approval";
    readonly subject_id: string;
    readonly detail_digest: Sha256Digest;
    readonly provider_action_sha256: Sha256Digest;
  };
  readonly audit_entry_sha256: Sha256Digest;
}

export class PrivateSlackBlockApprovalPolicyFactProjectionV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateSlackBlockApprovalPolicyFactProjectionV1Error";
  }
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REF_KEYS = [
  "schema_version", "kind", "authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id", "candidate_sha256", "frozen_card_sha256", "approved_snapshot_sha256", "final_approver", "current_slack_identity_link", "action", "selected_policy_id", "policy_contract_sha256", "policy_consequence_sha256", "comment", "audit_event_id", "audit_sequence", "audit_entry_sha256", "provider_action_kind", "provider_action_schema_version", "provider_action_sha256", "authorization_proof_sha256",
] as const;
const INPUT_KEYS = ["envelope", "record_position", "witness"] as const;
const ENVELOPE_KEYS = ["record_sha256", "body"] as const;
const BODY_KEYS = ["authority_id", "organization_id", "state_lineage_id", "human_act_resolution_ref", "event"] as const;
const ASSIGNEE_KEYS = ["principal_id", "membership_id"] as const;
const WITNESS_KEYS = ["authorization_allow", "authorization_proof_sha256", "provider_action_kind", "provider_action_schema_version", "audit_entry", "audit_entry_sha256"] as const;
const ALLOW_KEYS = ["authority_id", "organization_id", "state_lineage_id", "approval_id", "action", "final_approver", "selected_policy_id", "policy_contract_sha256", "provider_action_sha256", "decision"] as const;
const AUDIT_KEYS = ["authority_id", "organization_id", "state_lineage_id", "audit_event_id", "audit_sequence", "actor_class", "principal_id", "membership_id", "action", "subject_kind", "subject_id", "detail_digest", "provider_action_sha256"] as const;
const APPROVED_EVENT_KEYS = ["kind", "approved_snapshot", "approved_snapshot_sha256", "policy_id", "policy_contract_sha256", "policy_consequence_text", "policy_consequence_sha256"] as const;
const REJECTED_EVENT_KEYS = ["kind"] as const;
const SNAPSHOT_KEYS = ["approved_payload"] as const;
const PAYLOAD_KEYS = ["brief"] as const;
const BRIEF_KEYS = ["decisions", "actions", "rationales"] as const;
const SIGNAL_KEYS = ["id", "kind"] as const;

function invalid(message: string): never {
  throw new PrivateSlackBlockApprovalPolicyFactProjectionV1Error(message);
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) invalid(`${label} must be a plain object`);
  const names = Object.getOwnPropertyNames(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (names.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) invalid(`${label} has an unexpected shape`);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) invalid(`${label} must contain only enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}
function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must be a canonical sha256 digest`);
  return value as Sha256Digest;
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive safe integer`);
  return value as number;
}
function action(value: unknown, label: string): "approve" | "reject" {
  if (value !== "approve" && value !== "reject") invalid(`${label} is unsupported`);
  return value;
}
function policy(value: unknown, label: string): PersonPolicyIdV2 {
  if (value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID && value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) invalid(`${label} is unsupported`);
  return value;
}
function assignee(value: unknown, label: string): { readonly principal_id: string; readonly membership_id: string } {
  const record = exact(value, ASSIGNEE_KEYS, label);
  return Object.freeze({ principal_id: text(record.principal_id, `${label} principal_id`), membership_id: text(record.membership_id, `${label} membership_id`) });
}
function same(left: unknown, right: unknown, label: string): void { if (left !== right) invalid(`${label} does not match`); }

interface Ref {
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  readonly approval_id: string; readonly action: "approve" | "reject";
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly policy_id: PersonPolicyIdV2 | null; readonly policy_contract_sha256: Sha256Digest | null;
  readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest;
}
function ref(value: unknown): Ref {
  const record = exact(value, REF_KEYS, "Private Slack block approval resolution ref");
  if (record.schema_version !== 1 || record.kind !== PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND || record.provider_action_kind !== SIGNED_SLACK_BLOCK_ACTION_V1_KIND || record.provider_action_schema_version !== 1) invalid("Private Slack block approval resolution ref has an unsupported witness kind");
  for (const key of ["authority_id", "organization_id", "state_lineage_id", "command_id", "approval_id", "audit_event_id"] as const) text(record[key], `resolution ${key}`);
  for (const key of ["candidate_sha256", "frozen_card_sha256", "approved_snapshot_sha256", "audit_entry_sha256", "provider_action_sha256", "authorization_proof_sha256"] as const) digest(record[key], `resolution ${key}`);
  const currentAction = action(record.action, "resolution action");
  const policyId = record.selected_policy_id === null ? null : policy(record.selected_policy_id, "resolution selected policy");
  if (currentAction === "approve") {
    if (policyId === null) invalid("approved resolution requires a selected policy");
    digest(record.policy_contract_sha256, "resolution policy contract digest");
    digest(record.policy_consequence_sha256, "resolution policy consequence digest");
  } else if (policyId !== null || record.policy_contract_sha256 !== null || record.policy_consequence_sha256 !== null) invalid("rejected resolution must not select a policy");
  return Object.freeze({ authority_id: text(record.authority_id, "resolution authority_id"), organization_id: text(record.organization_id, "resolution organization_id"), state_lineage_id: text(record.state_lineage_id, "resolution state_lineage_id"), approval_id: text(record.approval_id, "resolution approval_id"), action: currentAction, final_approver: assignee(record.final_approver, "resolution final approver"), policy_id: policyId, policy_contract_sha256: record.policy_contract_sha256 === null ? null : digest(record.policy_contract_sha256, "resolution policy contract digest"), audit_event_id: text(record.audit_event_id, "resolution audit event ID"), audit_sequence: positive(record.audit_sequence, "resolution audit sequence"), audit_entry_sha256: digest(record.audit_entry_sha256, "resolution audit digest"), provider_action_sha256: digest(record.provider_action_sha256, "resolution provider action digest"), authorization_proof_sha256: digest(record.authorization_proof_sha256, "resolution authorization proof digest") });
}

interface Witness { readonly allow: Ref & { readonly final_approver: { readonly principal_id: string; readonly membership_id: string } }; readonly audit: { readonly audit_event_id: string; readonly audit_sequence: number; readonly principal_id: string; readonly membership_id: string; readonly action: "approve" | "reject"; readonly subject_id: string; readonly detail_digest: Sha256Digest; readonly provider_action_sha256: Sha256Digest; readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string }; readonly audit_entry_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest; }
function witness(value: unknown): Witness {
  const record = exact(value, WITNESS_KEYS, "Private Slack block approval D2 witness");
  if (record.provider_action_kind !== SIGNED_SLACK_BLOCK_ACTION_V1_KIND || record.provider_action_schema_version !== 1) invalid("Private Slack block approval D2 witness must name a signed Slack block action");
  const allowRecord = exact(record.authorization_allow, ALLOW_KEYS, "Private Slack block approval D2 allow");
  if (allowRecord.decision !== "allow") invalid("Private Slack block approval D2 allow decision is unsupported");
  const allowAction = action(allowRecord.action, "D2 allow action");
  const allowPolicy = allowRecord.selected_policy_id === null ? null : policy(allowRecord.selected_policy_id, "D2 allow selected policy");
  if (allowAction === "approve") { if (allowPolicy === null) invalid("D2 approve allow requires a policy"); digest(allowRecord.policy_contract_sha256, "D2 allow policy contract digest"); } else if (allowPolicy !== null || allowRecord.policy_contract_sha256 !== null) invalid("D2 reject allow must not select a policy");
  const auditRecord = exact(record.audit_entry, AUDIT_KEYS, "Private Slack block approval D2 audit");
  if (auditRecord.actor_class !== "provider_human" || auditRecord.subject_kind !== "approval") invalid("Private Slack block approval D2 audit actor or subject is unsupported");
  return Object.freeze({
    allow: Object.freeze({ authority_id: text(allowRecord.authority_id, "D2 allow authority_id"), organization_id: text(allowRecord.organization_id, "D2 allow organization_id"), state_lineage_id: text(allowRecord.state_lineage_id, "D2 allow state_lineage_id"), approval_id: text(allowRecord.approval_id, "D2 allow approval_id"), action: allowAction, final_approver: assignee(allowRecord.final_approver, "D2 allow final approver"), policy_id: allowPolicy, policy_contract_sha256: allowRecord.policy_contract_sha256 === null ? null : digest(allowRecord.policy_contract_sha256, "D2 allow policy contract digest"), audit_event_id: "unused", audit_sequence: 1, audit_entry_sha256: digest(record.audit_entry_sha256, "D2 audit digest"), provider_action_sha256: digest(allowRecord.provider_action_sha256, "D2 allow provider action digest"), authorization_proof_sha256: digest(record.authorization_proof_sha256, "D2 authorization proof digest") }),
    audit: Object.freeze({ authority_id: text(auditRecord.authority_id, "D2 audit authority_id"), organization_id: text(auditRecord.organization_id, "D2 audit organization_id"), state_lineage_id: text(auditRecord.state_lineage_id, "D2 audit state_lineage_id"), audit_event_id: text(auditRecord.audit_event_id, "D2 audit event ID"), audit_sequence: positive(auditRecord.audit_sequence, "D2 audit sequence"), principal_id: text(auditRecord.principal_id, "D2 audit principal"), membership_id: text(auditRecord.membership_id, "D2 audit membership"), action: action(auditRecord.action, "D2 audit action"), subject_id: text(auditRecord.subject_id, "D2 audit subject"), detail_digest: digest(auditRecord.detail_digest, "D2 audit detail digest"), provider_action_sha256: digest(auditRecord.provider_action_sha256, "D2 audit provider action digest") }),
    audit_entry_sha256: digest(record.audit_entry_sha256, "D2 audit digest"), authorization_proof_sha256: digest(record.authorization_proof_sha256, "D2 authorization proof digest"),
  });
}

function joined(refValue: Ref, witnessValue: Witness, body: Record<string, unknown>): void {
  const allow = witnessValue.allow; const audit = witnessValue.audit;
  for (const key of ["authority_id", "organization_id", "state_lineage_id"] as const) { same(refValue[key], body[key], `resolution ${key}`); same(allow[key], body[key], `D2 allow ${key}`); same(audit[key], body[key], `D2 audit ${key}`); }
  for (const key of ["approval_id", "action", "policy_id", "policy_contract_sha256", "provider_action_sha256"] as const) same(allow[key], refValue[key], `D2 allow ${key}`);
  same(allow.final_approver.principal_id, refValue.final_approver.principal_id, "D2 final approver principal"); same(allow.final_approver.membership_id, refValue.final_approver.membership_id, "D2 final approver membership");
  same(audit.audit_event_id, refValue.audit_event_id, "D2 audit event ID"); same(audit.audit_sequence, refValue.audit_sequence, "D2 audit sequence"); same(witnessValue.audit_entry_sha256, refValue.audit_entry_sha256, "D2 audit digest"); same(audit.action, refValue.action, "D2 audit action"); same(audit.subject_id, refValue.approval_id, "D2 audit subject"); same(audit.principal_id, refValue.final_approver.principal_id, "D2 audit actor principal"); same(audit.membership_id, refValue.final_approver.membership_id, "D2 audit actor membership"); same(audit.provider_action_sha256, refValue.provider_action_sha256, "D2 audit provider action digest"); same(witnessValue.authorization_proof_sha256, refValue.authorization_proof_sha256, "D2 authorization proof digest"); same(audit.detail_digest, refValue.authorization_proof_sha256, "D2 audit detail digest");
}

function signals(value: unknown, expected: PersonPolicyFactItemKindV2, seen: Set<string>): readonly { readonly id: string; readonly kind: PersonPolicyFactItemKindV2 }[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid("approved signals must be a plain array");
  return value.map((item, index) => { const signal = exact(item, SIGNAL_KEYS, `approved signal ${index}`); const id = text(signal.id, `approved signal ${index} id`); if (signal.kind !== expected || seen.has(id)) invalid("approved signal kind or identity is invalid"); seen.add(id); return Object.freeze({ id, kind: expected }); });
}

function approvedSignals(event: unknown): readonly { readonly id: string; readonly kind: PersonPolicyFactItemKindV2 }[] {
  const body = exact(event, APPROVED_EVENT_KEYS, "Private Slack block approved event"); if (body.kind !== "approved") invalid("approved event kind is unsupported");
  const snapshot = exact(body.approved_snapshot, SNAPSHOT_KEYS, "approved snapshot"); const payload = exact(snapshot.approved_payload, PAYLOAD_KEYS, "approved payload"); const brief = exact(payload.brief, BRIEF_KEYS, "approved brief"); const seen = new Set<string>();
  return Object.freeze([...signals(brief.decisions, "decision", seen), ...signals(brief.actions, "action", seen), ...signals(brief.rationales, "rationale", seen)]);
}

export function projectPrivateSlackBlockApprovalPolicyFactsV1(input: PrivateSlackBlockApprovalPolicyFactsInputV1): PersonPolicyFactProjectionV2 {
  const source = exact(input, INPUT_KEYS, "Private Slack block policy projection input"); const position = positive(source.record_position, "record_position");
  const envelope = exact(source.envelope, ENVELOPE_KEYS, "Private Slack block policy envelope"); const recordSha256 = digest(envelope.record_sha256, "record_sha256"); const body = exact(envelope.body, BODY_KEYS, "Private Slack block policy envelope body");
  const resolution = ref(body.human_act_resolution_ref); const proof = witness(source.witness); joined(resolution, proof, body);
  if (resolution.action === "reject") { const rejected = exact(body.event, REJECTED_EVENT_KEYS, "Private Slack block rejected event"); if (rejected.kind !== "rejected") invalid("rejected event kind is unsupported"); return Object.freeze({ facts: Object.freeze([]), policy_fact_outcome: Object.freeze({ kind: "none" }) }); }
  const facts: PersonPolicyFactRowV2[] = approvedSignals(body.event).map((signal, atom_order) => {
    const common = { authority_id: resolution.authority_id, organization_id: resolution.organization_id, state_lineage_id: resolution.state_lineage_id, approval_id: resolution.approval_id, action: "approve" as const, policy_id: resolution.policy_id as PersonPolicyIdV2, policy_contract_sha256: resolution.policy_contract_sha256 as Sha256Digest, record_position: position, record_sha256: recordSha256, atom_order, signal_id_sha256: sha256Digest(signal.id), atom_id: derivedAtomIdentity(recordSha256, signal.id), item_kind: signal.kind, audit_event_id: resolution.audit_event_id, audit_sequence: resolution.audit_sequence, audit_entry_sha256: resolution.audit_entry_sha256, provider_action_sha256: resolution.provider_action_sha256, authorization_proof_sha256: resolution.authorization_proof_sha256 };
    return resolution.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? Object.freeze({ ...common, policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID, reviewer_principal_id: resolution.final_approver.principal_id, reviewer_membership_id: resolution.final_approver.membership_id }) : Object.freeze({ ...common, policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID });
  });
  return Object.freeze({ facts: Object.freeze(facts), policy_fact_outcome: Object.freeze({ kind: "appended", policy_id: resolution.policy_id as PersonPolicyIdV2 }) });
}

function privateSlackPolicyEnvelope(
  envelope: RecordPolicyFactEnvelopeV1,
): unknown {
  const event = envelope.body.event as {
    readonly kind: "approved" | "rejected";
    readonly approved_snapshot?: {
      readonly approved_payload: {
        readonly brief: {
          readonly decisions: readonly { readonly id: string; readonly kind: "decision" }[];
          readonly actions: readonly { readonly id: string; readonly kind: "action" }[];
          readonly rationales: readonly { readonly id: string; readonly kind: "rationale" }[];
        };
      };
    };
    readonly approved_snapshot_sha256?: Sha256Digest;
    readonly policy_id?: PersonPolicyIdV2;
    readonly policy_contract_sha256?: Sha256Digest;
    readonly policy_consequence_text?: string;
    readonly policy_consequence_sha256?: Sha256Digest;
  };
  return {
    record_sha256: envelope.record_sha256,
    body: {
      authority_id: envelope.body.authority_id,
      organization_id: envelope.body.organization_id,
      state_lineage_id: envelope.body.state_lineage_id,
      human_act_resolution_ref: envelope.body.human_act_resolution_ref,
      event:
        event.kind === "rejected"
          ? { kind: "rejected" }
          : {
              kind: "approved",
              approved_snapshot: {
                approved_payload: {
                  brief: {
                    decisions: event.approved_snapshot!.approved_payload.brief.decisions.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                    actions: event.approved_snapshot!.approved_payload.brief.actions.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                    rationales: event.approved_snapshot!.approved_payload.brief.rationales.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                  },
                },
              },
              approved_snapshot_sha256: event.approved_snapshot_sha256,
              policy_id: event.policy_id,
              policy_contract_sha256: event.policy_contract_sha256,
              policy_consequence_text: event.policy_consequence_text,
              policy_consequence_sha256: event.policy_consequence_sha256,
            },
    },
  };
}

/**
 * Slack's signed Block Kit contract is selected only here. Record append and
 * retrieval-source snapshotting pass the verified envelope through the
 * generic record-policy-fact seam.
 */
export function createPrivateSlackBlockApprovalPolicyProjectorV1(): RecordPolicyFactProjectorV1 {
  const projector: RecordPolicyFactProjectorV1 = {
    id: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
    matches: (envelope: RecordPolicyFactEnvelopeV1) =>
      (envelope.body.human_act_resolution_ref as { readonly kind?: unknown }).kind ===
      PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
    project: ({ envelope, record_position, witness }: {
      readonly envelope: RecordPolicyFactEnvelopeV1;
      readonly record_position: number;
      readonly witness: unknown;
    }) =>
      projectPrivateSlackBlockApprovalPolicyFactsV1({
        envelope: privateSlackPolicyEnvelope(envelope),
        record_position,
        witness,
      }),
    policyBinding: (envelope: RecordPolicyFactEnvelopeV1) => {
      const resolution = ref(envelope.body.human_act_resolution_ref);
      if (resolution.action !== "approve" || envelope.body.event.kind !== "approved") {
        invalid("approved private Slack policy binding is unavailable");
      }
      return Object.freeze({
        policy_id: resolution.policy_id!,
        policy_contract_sha256: resolution.policy_contract_sha256!,
      });
    },
  };
  return Object.freeze(projector);
}
