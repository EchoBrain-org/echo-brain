import { createHash } from 'node:crypto';
import {
  assertCanonicalDecisionBrief,
  isCanonicalTimestamp,
  type ApprovalDecision,
  type DecisionBrief,
  type JsonObject,
} from '../../core/index.js';
import { assertReviewerDisplayName } from './reviewer-authorization-evidence.js';

/**
 * A decision node is one link in the decision chain: what was decided, by
 * whom, when, why, which alternatives were considered, and how it relates to
 * other nodes. V1 records carry the full shape but leave `alternatives` empty
 * and `links` null; later revisit/branch features append new linked nodes
 * instead of rewriting existing ones.
 */
export interface DecisionNodeLinks {
  parent: string | null;
  supersedes: string | null;
}

/**
 * The typed tuple that identifies where a decision came from, persisted with
 * the requested slot so downstream exclusion checks never have to reconstruct
 * it from an opaque processing key. Nodes stored before this field existed
 * carry `null` and are handled fail-closed by their consumers.
 */
export interface DecisionSourceLocator {
  adapter_id: string;
  instance_id: string;
  external_id: string;
}

export interface DecisionRequestedEvent {
  schema_version: 1;
  event_type: 'requested';
  node_id: string;
  processing_key: string;
  requested_at: string;
  brief: DecisionBrief;
  alternatives: readonly JsonObject[];
  links: DecisionNodeLinks;
  metadata: JsonObject;
  /** Absent on nodes written before the locator was persisted. */
  source?: DecisionSourceLocator;
}

export interface DecisionPublishedEvent {
  schema_version: 1;
  event_type: 'published';
  node_id: string;
  surface: string;
  posted_at: string;
  reference: JsonObject;
}

export interface DecisionResolvedEvent {
  schema_version: 1;
  event_type: 'resolved';
  node_id: string;
  status: 'approved' | 'rejected';
  reviewed_at: string;
  reviewed_by: string;
  reason: string | null;
  surface: string;
  metadata: JsonObject;
}

/**
 * The one delivery surface reserved for organization-record receipts. Filing a
 * receipt reuses the ordinary create-once `published-<surface>.json` slot, so
 * an accepted append can never be overwritten or double-filed.
 */
export const ORGANIZATION_RECORD_SURFACE = 'organization-record';

/** The one approval surface whose publication mode is frozen before posting. */
export const APPROVAL_PRESENTATION_CONTRACT_SURFACE = 'slack-authority-v1';

export const RESTRICTED_REVIEWER_PRESENTATION_MODE = 'restricted-reviewer-v1';
export const ORGANIZATION_MEMBER_READABLE_PRESENTATION_MODE =
  'organization-member-readable-v1';

/**
 * The immutable local publication contract.
 *
 * It stores only the closed contract, its two content digests, the non-secret
 * `env:`/`file:` credential reference, and the frozen adapter settings -- never
 * token bytes and never a second copy of the title or item text. Its frozen
 * mode and adapter identity override current configuration for every render,
 * post retry, poll, and action request, so no retry can reinterpret a card.
 */
export interface SlackApprovalPresentationContract {
  schema_version: 1;
  kind: 'echo-slack-approval-presentation-contract';
  mode: typeof RESTRICTED_REVIEWER_PRESENTATION_MODE;
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  reviewer_slack_user_id: string;
  reviewer_name: string;
  credential_ref: string;
  credential_fingerprint_sha256: string;
  approve_reaction: string;
  reject_reaction: string;
  reviewer_release_draft_sha256: string;
  approval_presentation_sha256: string;
}

/**
 * The second closed Slack publication contract. It deliberately has a
 * different discriminator and proof field names from the reviewer contract:
 * schema-v2 reviewer evidence cannot be reinterpreted as a schema-v3
 * organization-member approval.
 */
export interface OrganizationMemberSlackApprovalPresentationContract {
  schema_version: 1;
  kind: 'echo-slack-approval-presentation-contract';
  mode: typeof ORGANIZATION_MEMBER_READABLE_PRESENTATION_MODE;
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  reviewer_slack_user_id: string;
  reviewer_name: string;
  credential_ref: string;
  credential_fingerprint_sha256: string;
  approve_reaction: string;
  reject_reaction: string;
  policy_id: 'organization-member-readable-v1';
  policy_contract_sha256: string;
  release_draft_sha256: string;
  approval_presentation_sha256: string;
}

/** Every persisted contract is one closed mode, never a hybrid. */
export type ApprovalPresentationContract =
  | SlackApprovalPresentationContract
  | OrganizationMemberSlackApprovalPresentationContract;

export interface DecisionApprovalPresentationContractEvent {
  schema_version: 1;
  event_type: 'approval-presentation-contract';
  node_id: string;
  surface: typeof APPROVAL_PRESENTATION_CONTRACT_SURFACE;
  created_at: string;
  presentation_contract: ApprovalPresentationContract;
}

const REACTION_NAME_RE = /^[a-z0-9_+-]{1,64}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const CREDENTIAL_REF_RE = /^(?:env|file):[^\s]{1,512}$/;

export function assertSlackApprovalPresentationContract(
  value: unknown,
  file: string,
): SlackApprovalPresentationContract {
  if (!isPlainObject(value)) throw invalid(file, 'presentation_contract');
  assertExactKeys(
    value,
    [
      'schema_version',
      'kind',
      'mode',
      'adapter_id',
      'adapter_instance_id',
      'adapter_version',
      'channel_id',
      'reviewer_slack_user_id',
      'reviewer_name',
      'credential_ref',
      'credential_fingerprint_sha256',
      'approve_reaction',
      'reject_reaction',
      'reviewer_release_draft_sha256',
      'approval_presentation_sha256',
    ],
    file,
    'presentation_contract',
  );
  if (value['schema_version'] !== 1) {
    throw invalid(file, 'presentation_contract.schema_version');
  }
  if (value['kind'] !== 'echo-slack-approval-presentation-contract') {
    throw invalid(file, 'presentation_contract.kind');
  }
  if (value['mode'] !== RESTRICTED_REVIEWER_PRESENTATION_MODE) {
    throw invalid(file, 'presentation_contract.mode');
  }
  for (const field of [
    'adapter_id',
    'adapter_instance_id',
    'adapter_version',
    'channel_id',
  ] as const) {
    if (!isBoundedString(value[field], MAX_LOCATOR_FIELD_BYTES)) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  try {
    assertReviewerDisplayName(
      value['reviewer_name'],
      'presentation_contract.reviewer_name',
    );
  } catch {
    throw invalid(file, 'presentation_contract.reviewer_name');
  }
  if (
    typeof value['reviewer_slack_user_id'] !== 'string' ||
    !SLACK_USER_ID_RE.test(value['reviewer_slack_user_id'])
  ) {
    throw invalid(file, 'presentation_contract.reviewer_slack_user_id');
  }
  if (
    typeof value['credential_ref'] !== 'string' ||
    !CREDENTIAL_REF_RE.test(value['credential_ref'])
  ) {
    throw invalid(file, 'presentation_contract.credential_ref');
  }
  for (const field of [
    'credential_fingerprint_sha256',
    'reviewer_release_draft_sha256',
    'approval_presentation_sha256',
  ] as const) {
    if (!isSha256Digest(value[field])) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  for (const field of ['approve_reaction', 'reject_reaction'] as const) {
    if (
      typeof value[field] !== 'string' ||
      !REACTION_NAME_RE.test(value[field])
    ) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  if (value['approve_reaction'] === value['reject_reaction']) {
    throw invalid(file, 'presentation_contract.reject_reaction');
  }
  return value as unknown as SlackApprovalPresentationContract;
}

export function assertOrganizationMemberSlackApprovalPresentationContract(
  value: unknown,
  file: string,
): OrganizationMemberSlackApprovalPresentationContract {
  if (
    !isPlainObject(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw invalid(file, 'presentation_contract');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw invalid(file, 'presentation_contract');
    }
  }
  assertExactKeys(
    value,
    [
      'schema_version',
      'kind',
      'mode',
      'adapter_id',
      'adapter_instance_id',
      'adapter_version',
      'channel_id',
      'reviewer_slack_user_id',
      'reviewer_name',
      'credential_ref',
      'credential_fingerprint_sha256',
      'approve_reaction',
      'reject_reaction',
      'policy_id',
      'policy_contract_sha256',
      'release_draft_sha256',
      'approval_presentation_sha256',
    ],
    file,
    'presentation_contract',
  );
  if (value['schema_version'] !== 1) {
    throw invalid(file, 'presentation_contract.schema_version');
  }
  if (value['kind'] !== 'echo-slack-approval-presentation-contract') {
    throw invalid(file, 'presentation_contract.kind');
  }
  if (value['mode'] !== ORGANIZATION_MEMBER_READABLE_PRESENTATION_MODE) {
    throw invalid(file, 'presentation_contract.mode');
  }
  if (value['policy_id'] !== 'organization-member-readable-v1') {
    throw invalid(file, 'presentation_contract.policy_id');
  }
  for (const field of [
    'adapter_id',
    'adapter_instance_id',
    'adapter_version',
    'channel_id',
  ] as const) {
    if (!isBoundedString(value[field], MAX_LOCATOR_FIELD_BYTES)) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  try {
    assertReviewerDisplayName(
      value['reviewer_name'],
      'presentation_contract.reviewer_name',
    );
  } catch {
    throw invalid(file, 'presentation_contract.reviewer_name');
  }
  if (
    typeof value['reviewer_slack_user_id'] !== 'string' ||
    !SLACK_USER_ID_RE.test(value['reviewer_slack_user_id'])
  ) {
    throw invalid(file, 'presentation_contract.reviewer_slack_user_id');
  }
  if (
    typeof value['credential_ref'] !== 'string' ||
    !CREDENTIAL_REF_RE.test(value['credential_ref'])
  ) {
    throw invalid(file, 'presentation_contract.credential_ref');
  }
  for (const field of [
    'credential_fingerprint_sha256',
    'policy_contract_sha256',
    'release_draft_sha256',
    'approval_presentation_sha256',
  ] as const) {
    if (!isSha256Digest(value[field])) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  for (const field of ['approve_reaction', 'reject_reaction'] as const) {
    if (
      typeof value[field] !== 'string' ||
      !REACTION_NAME_RE.test(value[field])
    ) {
      throw invalid(file, `presentation_contract.${field}`);
    }
  }
  if (value['approve_reaction'] === value['reject_reaction']) {
    throw invalid(file, 'presentation_contract.reject_reaction');
  }
  return value as unknown as OrganizationMemberSlackApprovalPresentationContract;
}

export function assertApprovalPresentationContract(
  value: unknown,
  file: string,
): ApprovalPresentationContract {
  if (!isPlainObject(value)) throw invalid(file, 'presentation_contract');
  if (value['mode'] === RESTRICTED_REVIEWER_PRESENTATION_MODE) {
    return assertSlackApprovalPresentationContract(value, file);
  }
  if (value['mode'] === ORGANIZATION_MEMBER_READABLE_PRESENTATION_MODE) {
    return assertOrganizationMemberSlackApprovalPresentationContract(value, file);
  }
  throw invalid(file, 'presentation_contract.mode');
}

export function assertDecisionApprovalPresentationContractEvent(
  value: unknown,
  file: string,
): DecisionApprovalPresentationContractEvent {
  const record = assertEventEnvelope(
    value,
    'approval-presentation-contract',
    file,
  );
  assertExactKeys(
    record,
    [
      'schema_version',
      'event_type',
      'node_id',
      'surface',
      'created_at',
      'presentation_contract',
    ],
    file,
    'presentation contract event',
  );
  if (record['surface'] !== APPROVAL_PRESENTATION_CONTRACT_SURFACE) {
    throw invalid(file, 'surface');
  }
  if (!isCanonicalTimestamp(record['created_at'])) {
    throw invalid(file, 'created_at');
  }
  assertApprovalPresentationContract(
    record['presentation_contract'],
    file,
  );
  return record as unknown as DecisionApprovalPresentationContractEvent;
}

/**
 * The exact signed outbound envelope, frozen once before its first send. The
 * slot file is pretty-printed for inspection; the wire form is always the RFC
 * 8785 canonicalization of `envelope`, pinned here by `envelope_sha256` so a
 * retry can prove it is resending the same bytes.
 */
export interface DecisionOrganizationRecordEnvelopeEvent {
  schema_version: 1;
  event_type: 'organization-record-envelope';
  node_id: string;
  record_event_type: 'approval' | 'rejection';
  envelope_id: string;
  idempotency_key: string;
  envelope_sha256: string;
  envelope: JsonObject;
  created_at: string;
}

/** Terminal, operator-visible schema/signature/evidence rejection. */
export interface DecisionOrganizationRecordRejectionEvent {
  schema_version: 1;
  event_type: 'organization-record-rejected';
  node_id: string;
  envelope_id: string;
  idempotency_key: string;
  envelope_sha256: string;
  reason_code: string;
  reason: string;
  rejected_at: string;
}

/**
 * The `signed-document` integrity block, restated here because the approval
 * layer records durable local state and never imports the protocol packages.
 * Its shape is pinned against `SignedIntegrity` by test.
 */
export interface DecisionOrganizationRecordReceiptIntegrity {
  canonicalization: 'RFC8785';
  payload_sha256: string;
  signature_algorithm: 'ecdsa-p256-sha256-der-low-s';
  key_id: string;
  signature_base64: string;
}

/**
 * The authority-signed append receipt, verified by the submitter before it is
 * filed and then held whole. The signature travels into durable state with the
 * payload: member-held receipts are the off-box half of the log's
 * tamper-evidence, and a receipt stripped of its integrity block proves
 * nothing when presented back. Key identity lives in `integrity.key_id`, so no
 * second top-level copy exists to disagree with it.
 */
export interface DecisionOrganizationRecordReceipt {
  schema_version: 1;
  kind: 'echo-organization-record-receipt';
  authority_id: string;
  organization_id: string;
  envelope_id: string;
  envelope_sha256: string;
  installation_id: string;
  idempotency_key: string;
  position: number;
  record_hash: string;
  recorded_at: string;
  integrity: DecisionOrganizationRecordReceiptIntegrity;
}

export type DecisionOrganizationRecordStatus =
  | 'unresolved'
  | 'pending'
  | 'outbound'
  | 'published'
  | 'rejected';

export interface DecisionOrganizationRecordState {
  status: DecisionOrganizationRecordStatus;
  envelope: DecisionOrganizationRecordEnvelopeEvent | null;
  receipt: DecisionOrganizationRecordReceipt | null;
  rejection: DecisionOrganizationRecordRejectionEvent | null;
}

export interface DecisionNodeState {
  approval_id: string;
  node_id: string;
  processing_key: string;
  requested_at: string;
  requested_metadata: JsonObject;
  brief: DecisionBrief;
  alternatives: readonly JsonObject[];
  links: DecisionNodeLinks;
  source: DecisionSourceLocator | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by: string | null;
  reason: string | null;
  resolved_surface: string | null;
  resolved_metadata: JsonObject | null;
  published: readonly DecisionPublishedEvent[];
  organization_record: DecisionOrganizationRecordState;
}

const SURFACE_RE = /^[a-z][a-z0-9-]*$/;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIN_SIGNATURE_BASE64_LENGTH = 8;
const MAX_SIGNATURE_BASE64_LENGTH = 96;
const MAX_LOCATOR_FIELD_BYTES = 512;
const MAX_REJECTION_REASON_BYTES = 2048;

export function decisionApprovalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

function invalid(file: string, detail: string): Error {
  return new Error(`invalid decision node event (${detail}): ${file}`);
}

function assertEventEnvelope(
  value: unknown,
  eventType: string,
  file: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(file, 'not an object');
  if (value['schema_version'] !== 1) throw invalid(file, 'schema_version');
  if (value['event_type'] !== eventType) throw invalid(file, 'event_type');
  if (!isNonEmptyString(value['node_id'])) throw invalid(file, 'node_id');
  return value;
}

function assertLinks(value: unknown, file: string): DecisionNodeLinks {
  if (!isPlainObject(value)) throw invalid(file, 'links');
  const parent = value['parent'];
  const supersedes = value['supersedes'];
  if (parent !== null && !isNonEmptyString(parent))
    throw invalid(file, 'links.parent');
  if (supersedes !== null && !isNonEmptyString(supersedes)) {
    throw invalid(file, 'links.supersedes');
  }
  return {
    parent: parent as string | null,
    supersedes: supersedes as string | null,
  };
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    isNonEmptyString(value) && Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST_RE.test(value);
}

/**
 * Locator fields mirror the meeting provenance the core contract already
 * validates as non-empty strings, plus a byte bound so one adapter cannot make
 * a slot file unbounded.
 */
export function assertDecisionSourceLocator(
  value: unknown,
  file: string,
): DecisionSourceLocator {
  if (!isPlainObject(value)) throw invalid(file, 'source');
  for (const field of ['adapter_id', 'instance_id', 'external_id'] as const) {
    if (!isBoundedString(value[field], MAX_LOCATOR_FIELD_BYTES)) {
      throw invalid(file, `source.${field}`);
    }
  }
  return {
    adapter_id: value['adapter_id'] as string,
    instance_id: value['instance_id'] as string,
    external_id: value['external_id'] as string,
  };
}

export function assertDecisionOrganizationRecordEnvelopeEvent(
  value: unknown,
  file: string,
): DecisionOrganizationRecordEnvelopeEvent {
  const record = assertEventEnvelope(
    value,
    'organization-record-envelope',
    file,
  );
  if (
    record['record_event_type'] !== 'approval' &&
    record['record_event_type'] !== 'rejection'
  ) {
    throw invalid(file, 'record_event_type');
  }
  if (!isNonEmptyString(record['envelope_id']))
    throw invalid(file, 'envelope_id');
  if (!APPROVAL_ID_RE.test(String(record['idempotency_key']))) {
    throw invalid(file, 'idempotency_key');
  }
  if (!isSha256Digest(record['envelope_sha256'])) {
    throw invalid(file, 'envelope_sha256');
  }
  if (!isJsonObjectValue(record['envelope'])) throw invalid(file, 'envelope');
  if (!isCanonicalTimestamp(record['created_at']))
    throw invalid(file, 'created_at');
  return record as unknown as DecisionOrganizationRecordEnvelopeEvent;
}

export function assertDecisionOrganizationRecordRejectionEvent(
  value: unknown,
  file: string,
): DecisionOrganizationRecordRejectionEvent {
  const record = assertEventEnvelope(
    value,
    'organization-record-rejected',
    file,
  );
  if (!isNonEmptyString(record['envelope_id']))
    throw invalid(file, 'envelope_id');
  if (!APPROVAL_ID_RE.test(String(record['idempotency_key']))) {
    throw invalid(file, 'idempotency_key');
  }
  if (!isSha256Digest(record['envelope_sha256'])) {
    throw invalid(file, 'envelope_sha256');
  }
  if (!isNonEmptyString(record['reason_code']))
    throw invalid(file, 'reason_code');
  if (!isBoundedString(record['reason'], MAX_REJECTION_REASON_BYTES)) {
    throw invalid(file, 'reason');
  }
  if (!isCanonicalTimestamp(record['rejected_at']))
    throw invalid(file, 'rejected_at');
  return record as unknown as DecisionOrganizationRecordRejectionEvent;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  file: string,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(file, `${label}.${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) throw invalid(file, `${label}.${key}`);
  }
}

/**
 * Mirrors the shared `signed-document` integrity validator field for field.
 * The point is narrow but load-bearing: this slot must be unable to hold a
 * receipt that was never signed, so an absent or malformed integrity block is
 * a refusal rather than a missing optional.
 */
function assertReceiptIntegrity(
  value: unknown,
  file: string,
): DecisionOrganizationRecordReceiptIntegrity {
  if (!isPlainObject(value)) throw invalid(file, 'receipt.integrity');
  assertExactKeys(
    value,
    [
      'canonicalization',
      'payload_sha256',
      'signature_algorithm',
      'key_id',
      'signature_base64',
    ],
    file,
    'receipt.integrity',
  );
  if (value['canonicalization'] !== 'RFC8785') {
    throw invalid(file, 'receipt.integrity.canonicalization');
  }
  if (value['signature_algorithm'] !== 'ecdsa-p256-sha256-der-low-s') {
    throw invalid(file, 'receipt.integrity.signature_algorithm');
  }
  if (!isSha256Digest(value['payload_sha256'])) {
    throw invalid(file, 'receipt.integrity.payload_sha256');
  }
  if (!isSha256Digest(value['key_id'])) {
    throw invalid(file, 'receipt.integrity.key_id');
  }
  const signature = value['signature_base64'];
  if (
    typeof signature !== 'string' ||
    signature.length < MIN_SIGNATURE_BASE64_LENGTH ||
    signature.length > MAX_SIGNATURE_BASE64_LENGTH ||
    !CANONICAL_BASE64_RE.test(signature) ||
    Buffer.from(signature, 'base64').toString('base64') !== signature
  ) {
    throw invalid(file, 'receipt.integrity.signature_base64');
  }
  return value as unknown as DecisionOrganizationRecordReceiptIntegrity;
}

export function assertDecisionOrganizationRecordReceipt(
  value: unknown,
  file: string,
): DecisionOrganizationRecordReceipt {
  if (!isPlainObject(value)) throw invalid(file, 'receipt');
  assertExactKeys(
    value,
    [
      'schema_version',
      'kind',
      'authority_id',
      'organization_id',
      'envelope_id',
      'envelope_sha256',
      'installation_id',
      'idempotency_key',
      'position',
      'record_hash',
      'recorded_at',
      'integrity',
    ],
    file,
    'receipt',
  );
  if (value['schema_version'] !== 1)
    throw invalid(file, 'receipt.schema_version');
  if (value['kind'] !== 'echo-organization-record-receipt') {
    throw invalid(file, 'receipt.kind');
  }
  for (const field of [
    'authority_id',
    'organization_id',
    'envelope_id',
    'installation_id',
  ] as const) {
    if (!isNonEmptyString(value[field])) throw invalid(file, `receipt.${field}`);
  }
  if (!isSha256Digest(value['envelope_sha256'])) {
    throw invalid(file, 'receipt.envelope_sha256');
  }
  if (!isSha256Digest(value['record_hash'])) {
    throw invalid(file, 'receipt.record_hash');
  }
  if (!APPROVAL_ID_RE.test(String(value['idempotency_key']))) {
    throw invalid(file, 'receipt.idempotency_key');
  }
  const position = value['position'];
  if (
    typeof position !== 'number' ||
    !Number.isSafeInteger(position) ||
    position < 1
  ) {
    throw invalid(file, 'receipt.position');
  }
  if (!isCanonicalTimestamp(value['recorded_at'])) {
    throw invalid(file, 'receipt.recorded_at');
  }
  assertReceiptIntegrity(value['integrity'], file);
  return value as unknown as DecisionOrganizationRecordReceipt;
}

export function assertDecisionRequestedEvent(
  value: unknown,
  file: string,
): DecisionRequestedEvent {
  const record = assertEventEnvelope(value, 'requested', file);
  if (!isNonEmptyString(record['processing_key'])) {
    throw invalid(file, 'processing_key');
  }
  if (!isCanonicalTimestamp(record['requested_at'])) {
    throw invalid(file, 'requested_at');
  }
  if (
    !Array.isArray(record['alternatives']) ||
    !record['alternatives'].every(isJsonObjectValue)
  ) {
    throw invalid(file, 'alternatives');
  }
  assertLinks(record['links'], file);
  if (!isJsonObjectValue(record['metadata'])) throw invalid(file, 'metadata');
  // Absent on nodes written before the locator existed; present means valid.
  if (record['source'] !== undefined) {
    assertDecisionSourceLocator(record['source'], file);
  }
  try {
    assertCanonicalDecisionBrief(record['brief']);
  } catch {
    throw invalid(file, 'brief');
  }
  return record as unknown as DecisionRequestedEvent;
}

export function assertDecisionPublishedEvent(
  value: unknown,
  file: string,
): DecisionPublishedEvent {
  const record = assertEventEnvelope(value, 'published', file);
  if (
    typeof record['surface'] !== 'string' ||
    !SURFACE_RE.test(record['surface'])
  ) {
    throw invalid(file, 'surface');
  }
  if (!isCanonicalTimestamp(record['posted_at']))
    throw invalid(file, 'posted_at');
  if (!isJsonObjectValue(record['reference'])) throw invalid(file, 'reference');
  return record as unknown as DecisionPublishedEvent;
}

export function assertDecisionResolvedEvent(
  value: unknown,
  file: string,
): DecisionResolvedEvent {
  const record = assertEventEnvelope(value, 'resolved', file);
  if (record['status'] !== 'approved' && record['status'] !== 'rejected') {
    throw invalid(file, 'status');
  }
  if (!isCanonicalTimestamp(record['reviewed_at']))
    throw invalid(file, 'reviewed_at');
  if (!isNonEmptyString(record['reviewed_by']))
    throw invalid(file, 'reviewed_by');
  if (record['reason'] !== null && typeof record['reason'] !== 'string') {
    throw invalid(file, 'reason');
  }
  if (
    typeof record['surface'] !== 'string' ||
    !SURFACE_RE.test(record['surface'])
  ) {
    throw invalid(file, 'surface');
  }
  if (!isJsonObjectValue(record['metadata'])) throw invalid(file, 'metadata');
  return record as unknown as DecisionResolvedEvent;
}

export interface DecisionNodeEvents {
  approval_id: string;
  requested: DecisionRequestedEvent;
  published: readonly DecisionPublishedEvent[];
  resolved?: DecisionResolvedEvent | undefined;
  organization_record_envelope?:
    | DecisionOrganizationRecordEnvelopeEvent
    | undefined;
  organization_record_rejection?:
    | DecisionOrganizationRecordRejectionEvent
    | undefined;
}

/**
 * Fold the organization-record slot files into one terminal-state view. The
 * slot files alone are the state machine: an accepted receipt and a permanent
 * rejection are mutually exclusive terminal states, so holding both is
 * corruption rather than a state to interpret.
 */
function foldOrganizationRecord(
  events: DecisionNodeEvents,
  approvalId: string,
): DecisionOrganizationRecordState {
  const envelope = events.organization_record_envelope ?? null;
  const rejection = events.organization_record_rejection ?? null;
  const publication = events.published.find(
    (event) => event.surface === ORGANIZATION_RECORD_SURFACE,
  );
  const receipt =
    publication === undefined
      ? null
      : assertDecisionOrganizationRecordReceipt(
          publication.reference,
          `published-${ORGANIZATION_RECORD_SURFACE}.json`,
        );
  if (receipt !== null && rejection !== null) {
    throw new Error(
      `decision node holds both an organization record receipt and a permanent rejection (${approvalId})`,
    );
  }
  if ((receipt !== null || rejection !== null) && envelope === null) {
    throw new Error(
      `decision node has an organization record outcome without its frozen envelope (${approvalId})`,
    );
  }
  if (envelope !== null) {
    if (envelope.idempotency_key !== approvalId) {
      throw new Error(
        `decision node organization record envelope uses another idempotency key (${approvalId})`,
      );
    }
    if (events.resolved === undefined) {
      throw new Error(
        `decision node has an organization record envelope without a resolution (${approvalId})`,
      );
    }
    const expectedEventType =
      events.resolved.status === 'approved' ? 'approval' : 'rejection';
    if (envelope.record_event_type !== expectedEventType) {
      throw new Error(
        `decision node organization record envelope does not match its ${events.resolved.status} resolution (${approvalId})`,
      );
    }
    for (const [label, outcome] of [
      ['receipt', receipt],
      ['rejection', rejection],
    ] as const) {
      if (
        outcome !== null &&
        (outcome.envelope_id !== envelope.envelope_id ||
          outcome.envelope_sha256 !== envelope.envelope_sha256 ||
          outcome.idempotency_key !== envelope.idempotency_key)
      ) {
        throw new Error(
          `decision node organization record ${label} does not bind its frozen envelope (${approvalId})`,
        );
      }
    }
  }
  const status: DecisionOrganizationRecordStatus =
    rejection !== null
      ? 'rejected'
      : receipt !== null
        ? 'published'
        : envelope !== null
          ? 'outbound'
          : events.resolved === undefined
            ? 'unresolved'
            : 'pending';
  return { status, envelope, receipt, rejection };
}

/**
 * Fold a node's immutable event slots into its current state. Slot files are
 * not chronological: a CLI resolution may exist without (or before) any
 * publication, and publications never gate resolution.
 */
export function foldDecisionNode(
  events: DecisionNodeEvents,
): DecisionNodeState {
  const { approval_id: approvalId, requested, published, resolved } = events;
  if (!APPROVAL_ID_RE.test(approvalId)) {
    throw new Error(
      'decision node approval id must be a 64-character hex digest',
    );
  }
  if (decisionApprovalId(requested.processing_key) !== approvalId) {
    throw new Error(
      `decision node identity mismatch: approval id does not match processing key digest (${approvalId})`,
    );
  }
  for (const event of [
    ...published,
    ...(resolved === undefined ? [] : [resolved]),
    ...(events.organization_record_envelope === undefined
      ? []
      : [events.organization_record_envelope]),
    ...(events.organization_record_rejection === undefined
      ? []
      : [events.organization_record_rejection]),
  ]) {
    if (event.node_id !== requested.node_id) {
      throw new Error(
        `decision node identity mismatch: event node_id diverges (${approvalId})`,
      );
    }
  }
  return {
    approval_id: approvalId,
    node_id: requested.node_id,
    processing_key: requested.processing_key,
    requested_at: requested.requested_at,
    requested_metadata: requested.metadata,
    brief: requested.brief,
    alternatives: requested.alternatives,
    links: requested.links,
    source: requested.source ?? null,
    status: resolved?.status ?? 'pending',
    reviewed_at: resolved?.reviewed_at ?? null,
    reviewed_by: resolved?.reviewed_by ?? null,
    reason: resolved?.reason ?? null,
    resolved_surface: resolved?.surface ?? null,
    resolved_metadata: resolved?.metadata ?? null,
    published,
    organization_record: foldOrganizationRecord(events, approvalId),
  };
}

export interface DecisionOrganizationRecordProjection {
  status: DecisionOrganizationRecordStatus;
  position: number | null;
  record_hash: string | null;
  rejection_reason_code: string | null;
  rejection_reason: string | null;
}

/**
 * The approvals-view projection of a node's organization-record slot state.
 * Derived from local slot files alone: exclusion is a configuration fact the
 * submitter contributes, not something the durable node records.
 */
export function projectDecisionOrganizationRecord(
  state: DecisionNodeState,
): DecisionOrganizationRecordProjection {
  const { status, receipt, rejection } = state.organization_record;
  return {
    status,
    position: receipt?.position ?? null,
    record_hash: receipt?.record_hash ?? null,
    rejection_reason_code: rejection?.reason_code ?? null,
    rejection_reason: rejection?.reason ?? null,
  };
}

/**
 * Project a node state onto the core `ApprovalDecision` contract. Approved
 * projections always use the brief stored on the requested event: the core
 * cycle recompiles briefs with fresh ids on every retry, and the reviewer
 * approved the stored snapshot, not a recompilation.
 */
export function toApprovalDecision(state: DecisionNodeState): ApprovalDecision {
  if (state.status === 'approved') {
    return {
      status: 'approved',
      reviewed_at: state.reviewed_at as string,
      reviewed_by: state.reviewed_by as string,
      reason: state.reason,
      approved_brief: state.brief,
    };
  }
  if (state.status === 'rejected') {
    return {
      status: 'rejected',
      reviewed_at: state.reviewed_at as string,
      reviewed_by: state.reviewed_by as string,
      reason: state.reason,
      approved_brief: null,
    };
  }
  return {
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    reason: null,
    approved_brief: null,
  };
}
