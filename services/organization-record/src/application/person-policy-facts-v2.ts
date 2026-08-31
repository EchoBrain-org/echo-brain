import { sha256Digest } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from './contracts.js';
import { derivedAtomIdentity } from './atom-identity.js';
import type {
  ApprovedRecordPolicyEnvelopeV1,
  ApprovedRecordPolicyProjectorV1,
} from './approved-record-policy-projection-v1.js';

/**
 * Private D3-3 structural views for append-atomic Person-v2 policy facts.
 *
 * Protocol owns the complete durable v4 envelope. Authority composition must
 * first validate that envelope and independently reprove its immutable D2
 * authorization/audit bodies, then adapt only the fields read here. These
 * deliberately reduced views are not another durable document contract: they
 * have no schema or kind, are not exported from the workspace entry point,
 * and make no persistence or current-membership claim.
 */

export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  'restricted-reviewer-person-v2' as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  'organization-member-readable-person-v2' as const;

export type PersonPolicyIdV2 =
  | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
  | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;

export type PersonPolicyFactItemKindV2 =
  | 'decision'
  | 'action'
  | 'rationale';

export type PersonHumanActActionV2 = 'approve' | 'reject';

export interface PersonPolicySignalV2View {
  readonly id: string;
  readonly kind: PersonPolicyFactItemKindV2;
}

export interface ApprovedPersonPolicyEventV4View {
  readonly kind: 'approved';
  readonly approved_snapshot: {
    readonly approved_payload: {
      readonly brief: {
        readonly decisions: readonly PersonPolicySignalV2View[];
        readonly actions: readonly PersonPolicySignalV2View[];
        readonly rationales: readonly PersonPolicySignalV2View[];
      };
    };
  };
}

export interface RejectedPersonPolicyEventV4View {
  /** Rejection content is intentionally absent from the fact projection. */
  readonly kind: 'rejected';
}

export type PersonPolicyEventV4View =
  | ApprovedPersonPolicyEventV4View
  | RejectedPersonPolicyEventV4View;

export interface PersonHumanActResolutionRefV1View {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: PersonHumanActActionV2;
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-provider-human-action-v2';
  readonly provider_action_schema_version: 2;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface StructurallyVerifiedPersonPolicyRecordV4View {
  readonly record_sha256: Sha256Digest;
  readonly body: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly human_act_resolution_ref: PersonHumanActResolutionRefV1View;
    readonly event: PersonPolicyEventV4View;
  };
}

/**
 * Minimum fields read from the independently revalidated D2 allow body.
 * `authorization_proof_sha256` below is its recomputed canonical digest.
 */
export interface ReprovedPersonPolicyAuthorizationAllowV2View {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: PersonHumanActActionV2;
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly provider_action_sha256: Sha256Digest;
  readonly decision: 'allow';
}

/**
 * Minimum identity and chain coordinates read from the independently
 * revalidated immutable D2 integration-audit entry.
 */
export interface ReprovedPersonPolicyAuditEntryV2View {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly actor_class: 'provider_human';
  readonly principal_id: string;
  readonly membership_id: string;
  readonly action: PersonHumanActActionV2;
  readonly subject_kind: 'approval';
  readonly subject_id: string;
  readonly detail_digest: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
}

/**
 * Ephemeral, already-reproved D2 evidence. It is a structural injection seam,
 * never a caller-signed or stored document.
 */
export interface ReprovedPersonPolicyD2WitnessV2 {
  readonly authorization_allow: ReprovedPersonPolicyAuthorizationAllowV2View;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-provider-human-action-v2';
  readonly provider_action_schema_version: 2;
  readonly audit_entry: ReprovedPersonPolicyAuditEntryV2View;
  readonly audit_entry_sha256: Sha256Digest;
}

interface PersonPolicyFactRowV2Common {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: 'approve';
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly item_kind: PersonPolicyFactItemKindV2;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

export interface OrganizationMemberReadablePersonPolicyFactRowV2
  extends PersonPolicyFactRowV2Common {
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
}

export interface RestrictedReviewerPersonPolicyFactRowV2
  extends PersonPolicyFactRowV2Common {
  readonly policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
}

export type PersonPolicyFactRowV2 =
  | OrganizationMemberReadablePersonPolicyFactRowV2
  | RestrictedReviewerPersonPolicyFactRowV2;

export type PersonPolicyFactOutcomeV2 =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'appended';
      readonly policy_id: PersonPolicyIdV2;
    };

export interface PersonPolicyFactProjectionV2 {
  readonly facts: readonly PersonPolicyFactRowV2[];
  readonly policy_fact_outcome: PersonPolicyFactOutcomeV2;
}

export interface ProjectPersonPolicyFactsV2Input {
  readonly envelope: StructurallyVerifiedPersonPolicyRecordV4View;
  readonly record_position: number;
  readonly witness: ReprovedPersonPolicyD2WitnessV2;
}

export class PersonPolicyFactProjectionV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonPolicyFactProjectionV2Error';
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const PROJECT_INPUT_KEYS = ['envelope', 'record_position', 'witness'] as const;
const ENVELOPE_KEYS = ['record_sha256', 'body'] as const;
const BODY_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'human_act_resolution_ref',
  'event',
] as const;
const RESOLUTION_REF_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'approval_id',
  'action',
  'policy_id',
  'policy_contract_sha256',
  'audit_event_id',
  'audit_sequence',
  'audit_entry_sha256',
  'provider_action_kind',
  'provider_action_schema_version',
  'provider_action_sha256',
  'authorization_proof_sha256',
] as const;
const WITNESS_KEYS = [
  'authorization_allow',
  'authorization_proof_sha256',
  'provider_action_kind',
  'provider_action_schema_version',
  'audit_entry',
  'audit_entry_sha256',
] as const;
const AUTHORIZATION_ALLOW_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'approval_id',
  'action',
  'policy_id',
  'policy_contract_sha256',
  'principal_id',
  'membership_id',
  'provider_action_sha256',
  'decision',
] as const;
const AUDIT_ENTRY_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'audit_event_id',
  'audit_sequence',
  'actor_class',
  'principal_id',
  'membership_id',
  'action',
  'subject_kind',
  'subject_id',
  'detail_digest',
  'provider_action_sha256',
] as const;
const APPROVED_EVENT_KEYS = ['kind', 'approved_snapshot'] as const;
const REJECTED_EVENT_KEYS = ['kind'] as const;
const APPROVED_SNAPSHOT_KEYS = ['approved_payload'] as const;
const APPROVED_PAYLOAD_KEYS = ['brief'] as const;
const BRIEF_KEYS = ['decisions', 'actions', 'rationales'] as const;
const SIGNAL_KEYS = ['id', 'kind'] as const;

function invalid(message: string): never {
  throw new PersonPolicyFactProjectionV2Error(message);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} must be a plain object`);
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return invalid(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return invalid(`${label} has an unexpected shape`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${label} must contain only enumerable data properties`);
    }
  }
  return value as Record<string, unknown>;
}

function plainArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(`${label} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return invalid(`${label} must not contain symbol properties`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length')
  ) {
    return invalid(`${label} must be a dense plain array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${label} must be a dense plain array`);
    }
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} must be a canonical sha256 digest`);
  }
  return value as Sha256Digest;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function action(value: unknown, label: string): PersonHumanActActionV2 {
  if (value !== 'approve' && value !== 'reject') {
    return invalid(`${label} is unsupported`);
  }
  return value;
}

function policyId(value: unknown, label: string): PersonPolicyIdV2 {
  if (
    value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
    value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
  ) {
    return invalid(`${label} is unsupported`);
  }
  return value;
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) return invalid(`${label} is unsupported`);
  return expected;
}

interface ValidatedResolutionRef {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: PersonHumanActActionV2;
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-provider-human-action-v2';
  readonly provider_action_schema_version: 2;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
}

function resolutionRef(value: unknown): ValidatedResolutionRef {
  const record = exactRecord(
    value,
    RESOLUTION_REF_KEYS,
    'Person policy resolution reference view',
  );
  return Object.freeze({
    authority_id: text(record.authority_id, 'resolution authority_id'),
    organization_id: text(record.organization_id, 'resolution organization_id'),
    state_lineage_id: text(
      record.state_lineage_id,
      'resolution state_lineage_id',
    ),
    approval_id: text(record.approval_id, 'resolution approval_id'),
    action: action(record.action, 'resolution action'),
    policy_id: policyId(record.policy_id, 'resolution policy_id'),
    policy_contract_sha256: digest(
      record.policy_contract_sha256,
      'resolution policy_contract_sha256',
    ),
    audit_event_id: text(record.audit_event_id, 'resolution audit_event_id'),
    audit_sequence: positiveSafeInteger(
      record.audit_sequence,
      'resolution audit_sequence',
    ),
    audit_entry_sha256: digest(
      record.audit_entry_sha256,
      'resolution audit_entry_sha256',
    ),
    provider_action_kind: literal(
      record.provider_action_kind,
      'echo-provider-human-action-v2',
      'resolution provider_action_kind',
    ),
    provider_action_schema_version: literal(
      record.provider_action_schema_version,
      2,
      'resolution provider_action_schema_version',
    ),
    provider_action_sha256: digest(
      record.provider_action_sha256,
      'resolution provider_action_sha256',
    ),
    authorization_proof_sha256: digest(
      record.authorization_proof_sha256,
      'resolution authorization_proof_sha256',
    ),
  });
}

interface ValidatedAuthorizationAllow {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: PersonHumanActActionV2;
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly provider_action_sha256: Sha256Digest;
}

function authorizationAllow(value: unknown): ValidatedAuthorizationAllow {
  const record = exactRecord(
    value,
    AUTHORIZATION_ALLOW_KEYS,
    'Person policy D2 authorization allow view',
  );
  literal(record.decision, 'allow', 'D2 authorization decision');
  return Object.freeze({
    authority_id: text(record.authority_id, 'D2 allow authority_id'),
    organization_id: text(record.organization_id, 'D2 allow organization_id'),
    state_lineage_id: text(
      record.state_lineage_id,
      'D2 allow state_lineage_id',
    ),
    approval_id: text(record.approval_id, 'D2 allow approval_id'),
    action: action(record.action, 'D2 allow action'),
    policy_id: policyId(record.policy_id, 'D2 allow policy_id'),
    policy_contract_sha256: digest(
      record.policy_contract_sha256,
      'D2 allow policy_contract_sha256',
    ),
    principal_id: text(record.principal_id, 'D2 allow principal_id'),
    membership_id: text(record.membership_id, 'D2 allow membership_id'),
    provider_action_sha256: digest(
      record.provider_action_sha256,
      'D2 allow provider_action_sha256',
    ),
  });
}

interface ValidatedAuditEntry {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly action: PersonHumanActActionV2;
  readonly subject_id: string;
  readonly detail_digest: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
}

function auditEntry(value: unknown): ValidatedAuditEntry {
  const record = exactRecord(
    value,
    AUDIT_ENTRY_KEYS,
    'Person policy D2 audit entry view',
  );
  literal(record.actor_class, 'provider_human', 'D2 audit actor_class');
  literal(record.subject_kind, 'approval', 'D2 audit subject_kind');
  return Object.freeze({
    authority_id: text(record.authority_id, 'D2 audit authority_id'),
    organization_id: text(record.organization_id, 'D2 audit organization_id'),
    state_lineage_id: text(
      record.state_lineage_id,
      'D2 audit state_lineage_id',
    ),
    audit_event_id: text(record.audit_event_id, 'D2 audit audit_event_id'),
    audit_sequence: positiveSafeInteger(
      record.audit_sequence,
      'D2 audit audit_sequence',
    ),
    principal_id: text(record.principal_id, 'D2 audit principal_id'),
    membership_id: text(record.membership_id, 'D2 audit membership_id'),
    action: action(record.action, 'D2 audit action'),
    subject_id: text(record.subject_id, 'D2 audit subject_id'),
    detail_digest: digest(record.detail_digest, 'D2 audit detail_digest'),
    provider_action_sha256: digest(
      record.provider_action_sha256,
      'D2 audit provider_action_sha256',
    ),
  });
}

interface ValidatedD2Witness {
  readonly authorization_allow: ValidatedAuthorizationAllow;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-provider-human-action-v2';
  readonly provider_action_schema_version: 2;
  readonly audit_entry: ValidatedAuditEntry;
  readonly audit_entry_sha256: Sha256Digest;
}

function d2Witness(value: unknown): ValidatedD2Witness {
  const record = exactRecord(
    value,
    WITNESS_KEYS,
    'Person policy D2 reproof witness',
  );
  return Object.freeze({
    authorization_allow: authorizationAllow(record.authorization_allow),
    authorization_proof_sha256: digest(
      record.authorization_proof_sha256,
      'D2 witness authorization_proof_sha256',
    ),
    provider_action_kind: literal(
      record.provider_action_kind,
      'echo-provider-human-action-v2',
      'D2 witness provider_action_kind',
    ),
    provider_action_schema_version: literal(
      record.provider_action_schema_version,
      2,
      'D2 witness provider_action_schema_version',
    ),
    audit_entry: auditEntry(record.audit_entry),
    audit_entry_sha256: digest(
      record.audit_entry_sha256,
      'D2 witness audit_entry_sha256',
    ),
  });
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) invalid(`${label} does not match`);
}

function joinResolutionToD2(
  body: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  },
  ref: ValidatedResolutionRef,
  witness: ValidatedD2Witness,
): void {
  const allow = witness.authorization_allow;
  const audit = witness.audit_entry;

  for (const key of [
    'authority_id',
    'organization_id',
    'state_lineage_id',
  ] as const) {
    same(ref[key], body[key], `resolution ${key}`);
    same(allow[key], body[key], `D2 allow ${key}`);
    same(audit[key], body[key], `D2 audit ${key}`);
  }
  for (const key of [
    'approval_id',
    'action',
    'policy_id',
    'policy_contract_sha256',
  ] as const) {
    same(allow[key], ref[key], `D2 allow ${key}`);
  }
  same(audit.audit_event_id, ref.audit_event_id, 'D2 audit event ID');
  same(audit.audit_sequence, ref.audit_sequence, 'D2 audit sequence');
  same(
    witness.audit_entry_sha256,
    ref.audit_entry_sha256,
    'D2 audit entry digest',
  );
  same(audit.action, ref.action, 'D2 audit action');
  same(audit.subject_id, ref.approval_id, 'D2 audit approval subject');
  same(
    audit.principal_id,
    allow.principal_id,
    'D2 audit actor principal',
  );
  same(
    audit.membership_id,
    allow.membership_id,
    'D2 audit actor membership',
  );
  same(
    witness.provider_action_kind,
    ref.provider_action_kind,
    'D2 provider action kind',
  );
  same(
    witness.provider_action_schema_version,
    ref.provider_action_schema_version,
    'D2 provider action schema version',
  );
  same(
    allow.provider_action_sha256,
    ref.provider_action_sha256,
    'D2 allow provider action digest',
  );
  same(
    audit.provider_action_sha256,
    ref.provider_action_sha256,
    'D2 audit provider action digest',
  );
  same(
    witness.authorization_proof_sha256,
    ref.authorization_proof_sha256,
    'D2 authorization proof digest',
  );
  same(
    audit.detail_digest,
    ref.authorization_proof_sha256,
    'D2 audit authorization detail digest',
  );
}

function signals(
  value: unknown,
  expectedKind: PersonPolicyFactItemKindV2,
  label: string,
  seenIds: Set<string>,
): readonly PersonPolicySignalV2View[] {
  const array = plainArray(value, label);
  return Object.freeze(
    array.map((item, index) => {
      const signal = exactRecord(item, SIGNAL_KEYS, `${label}[${index}]`);
      const id = text(signal.id, `${label}[${index}].id`);
      literal(signal.kind, expectedKind, `${label}[${index}].kind`);
      if (seenIds.has(id)) {
        invalid('Person policy signal ids must be unique across the record');
      }
      seenIds.add(id);
      return Object.freeze({ id, kind: expectedKind });
    }),
  );
}

function approvedSignals(
  eventValue: unknown,
): readonly PersonPolicySignalV2View[] {
  const event = exactRecord(
    eventValue,
    APPROVED_EVENT_KEYS,
    'Approved Person policy event view',
  );
  literal(event.kind, 'approved', 'Person policy event kind');
  const snapshot = exactRecord(
    event.approved_snapshot,
    APPROVED_SNAPSHOT_KEYS,
    'Approved Person policy snapshot view',
  );
  const payload = exactRecord(
    snapshot.approved_payload,
    APPROVED_PAYLOAD_KEYS,
    'Approved Person policy payload view',
  );
  const brief = exactRecord(
    payload.brief,
    BRIEF_KEYS,
    'Approved Person policy brief view',
  );
  const seenIds = new Set<string>();
  return Object.freeze([
    ...signals(brief.decisions, 'decision', 'approved decisions', seenIds),
    ...signals(brief.actions, 'action', 'approved actions', seenIds),
    ...signals(brief.rationales, 'rationale', 'approved rationales', seenIds),
  ]);
}

function rejectedEvent(eventValue: unknown): void {
  const event = exactRecord(
    eventValue,
    REJECTED_EVENT_KEYS,
    'Rejected Person policy event view',
  );
  literal(event.kind, 'rejected', 'Person policy event kind');
}

function commonFact(
  body: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  },
  ref: ValidatedResolutionRef & { readonly action: 'approve' },
  recordPosition: number,
  recordSha256: Sha256Digest,
  atomOrder: number,
  signal: PersonPolicySignalV2View,
): PersonPolicyFactRowV2Common {
  /*
   * These two identities are inherited byte-for-byte from main. They are
   * compatibility identities, not newly claimed D3 structured-digest
   * preimages: signal IDs are hashed raw and atom IDs retain main's exact
   * `echo-organization-record-atom` preimage.
   */
  const signalIdSha256 = sha256Digest(signal.id);
  const atomId = derivedAtomIdentity(recordSha256, signal.id);
  return {
    authority_id: body.authority_id,
    organization_id: body.organization_id,
    state_lineage_id: body.state_lineage_id,
    approval_id: ref.approval_id,
    action: ref.action,
    policy_id: ref.policy_id,
    policy_contract_sha256: ref.policy_contract_sha256,
    record_position: recordPosition,
    record_sha256: recordSha256,
    atom_order: atomOrder,
    signal_id_sha256: signalIdSha256,
    atom_id: atomId,
    item_kind: signal.kind,
    audit_event_id: ref.audit_event_id,
    audit_sequence: ref.audit_sequence,
    audit_entry_sha256: ref.audit_entry_sha256,
    provider_action_sha256: ref.provider_action_sha256,
    authorization_proof_sha256: ref.authorization_proof_sha256,
  };
}

/**
 * Pure D3-3 projection. Durable admission must still reproject and compare
 * every row atomically with the record append; this checkpoint performs no IO.
 */
export function projectPersonPolicyFactsV2(
  input: ProjectPersonPolicyFactsV2Input,
): PersonPolicyFactProjectionV2 {
  const source = exactRecord(
    input,
    PROJECT_INPUT_KEYS,
    'Person policy fact projection input',
  );
  const recordPosition = positiveSafeInteger(
    source.record_position,
    'record_position',
  );
  const envelope = exactRecord(
    source.envelope,
    ENVELOPE_KEYS,
    'Person policy record v4 view',
  );
  const recordSha256 = digest(
    envelope.record_sha256,
    'Person policy record_sha256',
  );
  const bodyRecord = exactRecord(
    envelope.body,
    BODY_KEYS,
    'Person policy record v4 body view',
  );
  const body = Object.freeze({
    authority_id: text(bodyRecord.authority_id, 'record body authority_id'),
    organization_id: text(
      bodyRecord.organization_id,
      'record body organization_id',
    ),
    state_lineage_id: text(
      bodyRecord.state_lineage_id,
      'record body state_lineage_id',
    ),
  });
  const ref = resolutionRef(bodyRecord.human_act_resolution_ref);
  const witness = d2Witness(source.witness);
  joinResolutionToD2(body, ref, witness);

  const eventRecord = exactRecord(
    bodyRecord.event,
    ref.action === 'approve' ? APPROVED_EVENT_KEYS : REJECTED_EVENT_KEYS,
    'Person policy event view',
  );
  if (ref.action === 'reject') {
    rejectedEvent(eventRecord);
    return Object.freeze({
      facts: Object.freeze([]),
      policy_fact_outcome: Object.freeze({ kind: 'none' }),
    });
  }

  if (eventRecord.kind !== 'approved') {
    invalid('Approved resolution must name an approved event');
  }
  const approvedRef = ref as ValidatedResolutionRef & {
    readonly action: 'approve';
  };
  const projectedSignals = approvedSignals(eventRecord);
  const facts: PersonPolicyFactRowV2[] = projectedSignals.map(
    (signal, atomOrder) => {
      const common = commonFact(
        body,
        approvedRef,
        recordPosition,
        recordSha256,
        atomOrder,
        signal,
      );
      if (approvedRef.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
        return Object.freeze({
          ...common,
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          reviewer_principal_id: witness.authorization_allow.principal_id,
          reviewer_membership_id: witness.authorization_allow.membership_id,
        });
      }
      return Object.freeze({
        ...common,
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      });
    },
  );
  if (
    new Set(facts.map((fact) => fact.signal_id_sha256)).size !== facts.length ||
    new Set(facts.map((fact) => fact.atom_id)).size !== facts.length
  ) {
    invalid('Person policy projected signal and atom identities must be unique');
  }
  return Object.freeze({
    facts: Object.freeze(facts),
    policy_fact_outcome: Object.freeze({
      kind: 'appended',
      policy_id: approvedRef.policy_id,
    }),
  });
}

function personPolicyEnvelope(
  envelope: ApprovedRecordPolicyEnvelopeV1,
): StructurallyVerifiedPersonPolicyRecordV4View {
  const reference = envelope.body.human_act_resolution_ref as
    ApprovedRecordPolicyEnvelopeV1["body"]["human_act_resolution_ref"] & {
      readonly policy_id: PersonPolicyIdV2;
      readonly policy_contract_sha256: Sha256Digest;
      readonly provider_action_kind: "echo-provider-human-action-v2";
      readonly provider_action_schema_version: 2;
    };
  const event = envelope.body.event as PersonPolicyEventV4View;
  const projectedEvent: PersonPolicyEventV4View =
    event.kind === 'rejected'
      ? { kind: 'rejected' }
      : {
          kind: 'approved',
          approved_snapshot: {
            approved_payload: {
              brief: {
                decisions:
                  event.approved_snapshot.approved_payload.brief.decisions.map(
                    (signal) => ({ id: signal.id, kind: signal.kind }),
                  ),
                actions: event.approved_snapshot.approved_payload.brief.actions.map(
                  (signal) => ({ id: signal.id, kind: signal.kind }),
                ),
                rationales:
                  event.approved_snapshot.approved_payload.brief.rationales.map(
                    (signal) => ({ id: signal.id, kind: signal.kind }),
                  ),
              },
            },
          },
        };
  return {
    record_sha256: envelope.record_sha256,
    body: {
      authority_id: envelope.body.authority_id,
      organization_id: envelope.body.organization_id,
      state_lineage_id: envelope.body.state_lineage_id,
      human_act_resolution_ref: {
        authority_id: reference.authority_id,
        organization_id: reference.organization_id,
        state_lineage_id: reference.state_lineage_id,
        approval_id: reference.approval_id,
        action: reference.action,
        policy_id: reference.policy_id,
        policy_contract_sha256: reference.policy_contract_sha256,
        audit_event_id: reference.audit_event_id,
        audit_sequence: reference.audit_sequence,
        audit_entry_sha256: reference.audit_entry_sha256,
        provider_action_kind: reference.provider_action_kind,
        provider_action_schema_version: reference.provider_action_schema_version,
        provider_action_sha256: reference.provider_action_sha256,
        authorization_proof_sha256: reference.authorization_proof_sha256,
      },
      event: projectedEvent,
    },
  };
}

/** The established provider-human action protocol behind the generic seam. */
export function createPersonPolicyFactProjectorV2(): ApprovedRecordPolicyProjectorV1 {
  const projector: ApprovedRecordPolicyProjectorV1 = {
    id: 'echo-provider-human-action-v2',
    matches: (envelope: ApprovedRecordPolicyEnvelopeV1) =>
      envelope.body.human_act_resolution_ref.provider_action_kind ===
        'echo-provider-human-action-v2' &&
      envelope.body.human_act_resolution_ref.provider_action_schema_version === 2,
    project: ({ envelope, record_position, witness }: {
      readonly envelope: ApprovedRecordPolicyEnvelopeV1;
      readonly record_position: number;
      readonly witness: unknown;
    }) =>
      projectPersonPolicyFactsV2({
        envelope: personPolicyEnvelope(envelope),
        record_position,
        witness: witness as ReprovedPersonPolicyD2WitnessV2,
    }),
    approvedPolicy: (envelope: ApprovedRecordPolicyEnvelopeV1) => {
      const reference = resolutionRef(
        personPolicyEnvelope(envelope).body.human_act_resolution_ref,
      );
      if (
        reference.action !== 'approve' ||
        envelope.body.event.kind !== 'approved'
      ) {
        invalid('approved Person policy binding is unavailable');
      }
      return Object.freeze({
        policy_id: reference.policy_id,
        policy_contract_sha256: reference.policy_contract_sha256,
      });
    },
  };
  return Object.freeze(projector);
}
