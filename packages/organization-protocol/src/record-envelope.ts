import {
  createSignedDocumentWithKey,
  federationId,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from "@echo-brain/federation-protocol";
import type { P256SigningKeyDescriptor } from "@echo-brain/federation-protocol";
import { resolvePinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type {
  CanonicalPayloadSigner,
  OrganizationRecordApprovalEnvelopePayloadV1,
  OrganizationRecordApprovalEnvelopeV1,
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordEnvelopeAnyVersion,
  OrganizationRecordEventTypeV1,
  OrganizationRecordIntentV1,
  OrganizationRecordRejectionEnvelopePayloadV1,
  OrganizationRecordRejectionEnvelopeV1,
  OrganizationRecordRejectionPayloadV1,
  OrganizationRecordReviewerActionV1,
  OrganizationRecordReviewerApprovalEnvelopeV2,
  OrganizationRecordReviewerV1,
  OrganizationRecordSubmitterV1,
} from "./contracts.js";
import {
  REVIEWER_RECORD_ENVELOPE_SCHEMA_VERSION,
  assertReviewerApprovalEnvelopeSnapshot,
} from "./record-envelope-v2.js";
import { RESTRICTED_REVIEWER_ALLOW_REASON_CODE } from "./reviewer-restricted-policy.js";
import {
  assertOrganizationRecordApprovalPayload,
  assertOrganizationRecordRejectionPayload,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from "./record-payload.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  assertPrefixedUuidId,
  assertTimestamp,
  canonicalSnapshot,
  validateSignedIntegrity,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REVIEWED_BY_CHARACTERS = 256;
const MAX_REASON_CODE_CHARACTERS = 128;

/**
 * No approval surface has an intent affordance yet, so V1 records the
 * conservative installation default rather than an approver-set value.
 */
export const CONSERVATIVE_ORGANIZATION_RECORD_INTENT: OrganizationRecordIntentV1 =
  Object.freeze({ restricted: true, reconsider_after: null });

export interface CreateOrganizationRecordApprovalEnvelopeInput {
  envelope_id: string;
  idempotency_key: string;
  payload: OrganizationRecordApprovalPayloadV1;
  reviewer: OrganizationRecordReviewerV1;
  intent: OrganizationRecordIntentV1;
  submitter: OrganizationRecordSubmitterV1;
  installation_signing_key: P256SigningKeyDescriptor;
}

export interface CreateOrganizationRecordRejectionEnvelopeInput {
  envelope_id: string;
  idempotency_key: string;
  payload: OrganizationRecordRejectionPayloadV1;
  reviewer: OrganizationRecordReviewerV1;
  submitter: OrganizationRecordSubmitterV1;
  installation_signing_key: P256SigningKeyDescriptor;
}

/**
 * A random stable id generated once and frozen with the exact signed envelope
 * before its first send. Retries reuse the frozen bytes, never a fresh id.
 */
export function organizationRecordEnvelopeId(): string {
  return federationId("rec");
}

function assertBoundedText(
  value: unknown,
  label: string,
  maximumCharacters: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    organizationProtocolValidationFailure(`${label} is invalid`);
  }
}

function assertEventType(
  value: unknown,
  expected: OrganizationRecordEventTypeV1,
  label: string,
): void {
  if (value === "correction") {
    organizationProtocolValidationFailure(
      `${label} correction is reserved and is not supported in schema version 1`,
    );
  }
  if (value !== expected) {
    organizationProtocolValidationFailure(`${label} is unsupported`);
  }
}

function assertIdempotencyKey(value: unknown, label: string): void {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    organizationProtocolValidationFailure(
      `${label} must be a lowercase sha256 approval id`,
    );
  }
}

const REVIEWER_ACTION_BY_EVENT_TYPE: Readonly<
  Record<OrganizationRecordEventTypeV1, OrganizationRecordReviewerActionV1>
> = Object.freeze({ approval: "approve", rejection: "reject" });

/**
 * The authorization evidence is required for organization ingest and must be an
 * allow decision for this exact approval id, installation, reviewer, and
 * action. Whether that evaluation exists in the authority's integration audit
 * is an audit lookup the authority application performs; the wire contract
 * enforces that the quoted decision is at least for the act being submitted.
 */
function assertReviewer(
  value: unknown,
  label: string,
  idempotencyKey: string,
  installationId: string,
  eventType: OrganizationRecordEventTypeV1,
): void {
  const reviewer = asRecord(value, label);
  assertExactKeys(
    reviewer,
    ["principal_id", "membership_id", "reviewed_by", "authorization"],
    label,
  );
  assertId(reviewer.principal_id, "prn", `${label} principal_id`);
  assertId(reviewer.membership_id, "mem", `${label} membership_id`);
  assertBoundedText(
    reviewer.reviewed_by,
    `${label} reviewed_by`,
    MAX_REVIEWED_BY_CHARACTERS,
  );

  const evidence = asRecord(reviewer.authorization, `${label} authorization`);
  assertExactKeys(
    evidence,
    [
      "schema_version",
      "kind",
      "authority_id",
      "organization_id",
      "enrollment_id",
      "installation_id",
      "request_id",
      "approval_id",
      "action",
      "request_sha256",
      "provider_event_sha256",
      "allowed",
      "reason_code",
      "principal_id",
      "membership_id",
      "adapter_binding_id",
      "permission_grant_id",
      "evaluated_at",
    ],
    `${label} authorization`,
  );
  assertLiteral(
    evidence.schema_version,
    1,
    `${label} authorization schema_version`,
  );
  assertLiteral(
    evidence.kind,
    "echo-organization-authorization-evidence",
    `${label} authorization kind`,
  );
  assertId(evidence.authority_id, "oau", `${label} authorization authority_id`);
  assertId(
    evidence.organization_id,
    "org",
    `${label} authorization organization_id`,
  );
  assertId(
    evidence.enrollment_id,
    "enr",
    `${label} authorization enrollment_id`,
  );
  assertId(
    evidence.installation_id,
    "ins",
    `${label} authorization installation_id`,
  );
  assertPrefixedUuidId(
    evidence.request_id,
    "pcr",
    `${label} authorization request_id`,
  );
  assertIdempotencyKey(
    evidence.approval_id,
    `${label} authorization approval_id`,
  );
  if (evidence.action !== "approve" && evidence.action !== "reject") {
    organizationProtocolValidationFailure(
      `${label} authorization action must be approve or reject`,
    );
  }
  assertDigest(
    evidence.request_sha256,
    `${label} authorization request_sha256`,
  );
  assertDigest(
    evidence.provider_event_sha256,
    `${label} authorization provider_event_sha256`,
  );
  if (evidence.allowed !== true) {
    organizationProtocolValidationFailure(
      `${label} authorization must be an allow decision`,
    );
  }
  assertBoundedText(
    evidence.reason_code,
    `${label} authorization reason_code`,
    MAX_REASON_CODE_CHARACTERS,
  );
  // A reviewer-approved package must never enter the broad schema-v1 derive
  // path. Only the closed schema-v2 family may carry this reason.
  if (evidence.reason_code === RESTRICTED_REVIEWER_ALLOW_REASON_CODE) {
    organizationProtocolValidationFailure(
      `${label} authorization reason_code ${RESTRICTED_REVIEWER_ALLOW_REASON_CODE} requires schema version 2`,
    );
  }
  assertId(evidence.principal_id, "prn", `${label} authorization principal_id`);
  assertId(
    evidence.membership_id,
    "mem",
    `${label} authorization membership_id`,
  );
  assertId(
    evidence.adapter_binding_id,
    "bnd",
    `${label} authorization adapter_binding_id`,
  );
  assertPrefixedUuidId(
    evidence.permission_grant_id,
    "pgr",
    `${label} authorization permission_grant_id`,
  );
  assertTimestamp(evidence.evaluated_at, `${label} authorization evaluated_at`);

  if (
    evidence.approval_id !== idempotencyKey ||
    evidence.installation_id !== installationId ||
    evidence.principal_id !== reviewer.principal_id ||
    evidence.membership_id !== reviewer.membership_id
  ) {
    organizationProtocolValidationFailure(
      `${label} authorization does not bind this exact submission`,
    );
  }
  if (evidence.action !== REVIEWER_ACTION_BY_EVENT_TYPE[eventType]) {
    organizationProtocolValidationFailure(
      `${label} authorization action does not authorize this ${eventType} event`,
    );
  }
}

/**
 * Both fields stay in the contract so a later affordance needs no schema
 * change, but schema version 1 pins them to the conservative installation
 * default. No approval surface can express either value today, so anything
 * else on the wire would misrepresent an approver's intent.
 */
function assertIntent(value: unknown, label: string): void {
  const intent = asRecord(value, label);
  assertExactKeys(intent, ["restricted", "reconsider_after"], label);
  if (typeof intent.restricted !== "boolean") {
    organizationProtocolValidationFailure(
      `${label}.restricted must be a boolean`,
    );
  }
  if (intent.reconsider_after !== null) {
    assertTimestamp(intent.reconsider_after, `${label}.reconsider_after`);
  }
  if (
    intent.restricted !== CONSERVATIVE_ORGANIZATION_RECORD_INTENT.restricted ||
    intent.reconsider_after !==
      CONSERVATIVE_ORGANIZATION_RECORD_INTENT.reconsider_after
  ) {
    organizationProtocolValidationFailure(
      `${label} must be the conservative installation default in schema version 1: no approval surface can set it`,
    );
  }
}

function assertSubmitter(value: unknown, label: string): string {
  const submitter = asRecord(value, label);
  assertExactKeys(submitter, ["installation_id", "submitted_at"], label);
  assertId(submitter.installation_id, "ins", `${label} installation_id`);
  assertTimestamp(submitter.submitted_at, `${label} submitted_at`);
  return submitter.installation_id as string;
}

function envelopeSnapshot(value: unknown, label: string): Record<string, unknown> {
  const snapshot = canonicalSnapshot(
    value,
    label,
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  );
  return asRecord(snapshot, label);
}

function assertEnvelopeFrame(
  record: Record<string, unknown>,
  label: string,
  eventType: OrganizationRecordEventTypeV1,
): string {
  assertLiteral(record.schema_version, 1, `${label} schema_version`);
  assertLiteral(
    record.kind,
    "echo-organization-record-envelope",
    `${label} kind`,
  );
  assertEventType(record.event_type, eventType, `${label} event_type`);
  assertId(record.envelope_id, "rec", `${label} envelope_id`);
  assertIdempotencyKey(record.idempotency_key, `${label} idempotency_key`);
  const installationId = assertSubmitter(record.submitter, `${label} submitter`);
  assertReviewer(
    record.reviewer,
    `${label} reviewer`,
    record.idempotency_key as string,
    installationId,
    eventType,
  );
  const integrity = validateSignedIntegrity(
    record.integrity,
    `${label} integrity`,
  );
  return integrity.key_id;
}

const APPROVAL_ENVELOPE_LABEL = "organization record approval envelope";
const REJECTION_ENVELOPE_LABEL = "organization record rejection envelope";

function assertApprovalEnvelopeSnapshot(
  record: Record<string, unknown>,
  label: string,
): void {
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "event_type",
      "envelope_id",
      "idempotency_key",
      "payload",
      "reviewer",
      "intent",
      "submitter",
      "integrity",
    ],
    label,
  );
  assertEnvelopeFrame(record, label, "approval");
  assertOrganizationRecordApprovalPayload(record.payload, `${label} payload`);
  assertIntent(record.intent, `${label} intent`);
}

function assertRejectionEnvelopeSnapshot(
  record: Record<string, unknown>,
  label: string,
): void {
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "event_type",
      "envelope_id",
      "idempotency_key",
      "payload",
      "reviewer",
      "submitter",
      "integrity",
    ],
    label,
  );
  assertEnvelopeFrame(record, label, "rejection");
  assertOrganizationRecordRejectionPayload(record.payload, `${label} payload`);
}

export function validateOrganizationRecordApprovalEnvelope(
  value: unknown,
): OrganizationRecordApprovalEnvelopeV1 {
  const record = envelopeSnapshot(value, APPROVAL_ENVELOPE_LABEL);
  assertApprovalEnvelopeSnapshot(record, APPROVAL_ENVELOPE_LABEL);
  return record as unknown as OrganizationRecordApprovalEnvelopeV1;
}

export function validateOrganizationRecordRejectionEnvelope(
  value: unknown,
): OrganizationRecordRejectionEnvelopeV1 {
  const record = envelopeSnapshot(value, REJECTION_ENVELOPE_LABEL);
  assertRejectionEnvelopeSnapshot(record, REJECTION_ENVELOPE_LABEL);
  return record as unknown as OrganizationRecordRejectionEnvelopeV1;
}

/**
 * Strict envelope dispatch.
 *
 * One canonical snapshot is taken first, then the exact `(kind,
 * schema_version)` pair selects exactly one closed validator family before any
 * event, intent, payload, or reviewer field is read. An accessor-backed input
 * therefore cannot be routed by one value and validated as another, and no
 * cross-version field set can be interpreted by the wrong family.
 *
 * Version 1 keeps its landed behavior byte for byte, including rejecting the
 * reserved `correction` event by name. Version 2 is reviewer-only and admits
 * approval alone. Every other kind or version is unknown: it halts ingest and
 * derive rather than falling back to v1 or pilot behavior.
 */
export function validateOrganizationRecordEnvelope(
  value: unknown,
): OrganizationRecordEnvelopeAnyVersion {
  const label = "organization record envelope";
  const record = envelopeSnapshot(value, label);
  if (record.kind !== "echo-organization-record-envelope") {
    organizationProtocolValidationFailure(`${label} kind is unsupported`);
  }
  if (record.schema_version === REVIEWER_RECORD_ENVELOPE_SCHEMA_VERSION) {
    assertReviewerApprovalEnvelopeSnapshot(
      record,
      "organization record reviewer envelope",
    );
    return record as unknown as OrganizationRecordReviewerApprovalEnvelopeV2;
  }
  if (record.schema_version !== 1) {
    organizationProtocolValidationFailure(
      `${label} schema_version is unsupported`,
    );
  }
  if (record.event_type === "correction") {
    organizationProtocolValidationFailure(
      `${label} event_type correction is reserved and is not supported in schema version 1`,
    );
  }
  if (record.event_type === "approval") {
    assertApprovalEnvelopeSnapshot(record, APPROVAL_ENVELOPE_LABEL);
    return record as unknown as OrganizationRecordApprovalEnvelopeV1;
  }
  if (record.event_type === "rejection") {
    assertRejectionEnvelopeSnapshot(record, REJECTION_ENVELOPE_LABEL);
    return record as unknown as OrganizationRecordRejectionEnvelopeV1;
  }
  return organizationProtocolValidationFailure(
    `${label} event_type is unsupported`,
  );
}

function verifyRecordEnvelopeBindings(
  envelope: OrganizationRecordEnvelopeAnyVersion,
  pinnedAuthority: PinnedOrganizationAuthority,
  installationSigningKey: P256SigningKeyDescriptor,
): void {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const evidence = envelope.reviewer.authorization;
  if (
    evidence.authority_id !== authority.authority_id ||
    evidence.organization_id !== authority.organization_id
  ) {
    throw new Error(
      "organization record envelope does not match the pinned authority",
    );
  }
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (envelope.integrity.key_id !== installationSigningKey.key_id) {
    throw new Error(
      "organization record envelope does not match the installation key",
    );
  }
  verifySignedDocument(envelope, publicKey, installationSigningKey.key_id);
}

export function verifyOrganizationRecordApprovalEnvelope(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecordApprovalEnvelopeV1 {
  const envelope = validateOrganizationRecordApprovalEnvelope(value);
  verifyRecordEnvelopeBindings(
    envelope,
    pinnedAuthority,
    installationSigningKey,
  );
  return envelope;
}

export function verifyOrganizationRecordRejectionEnvelope(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecordRejectionEnvelopeV1 {
  const envelope = validateOrganizationRecordRejectionEnvelope(value);
  verifyRecordEnvelopeBindings(
    envelope,
    pinnedAuthority,
    installationSigningKey,
  );
  return envelope;
}

export function verifyOrganizationRecordEnvelope(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecordEnvelopeAnyVersion {
  const envelope = validateOrganizationRecordEnvelope(value);
  verifyRecordEnvelopeBindings(
    envelope,
    pinnedAuthority,
    installationSigningKey,
  );
  return envelope;
}

export async function createOrganizationRecordApprovalEnvelope(
  input: CreateOrganizationRecordApprovalEnvelopeInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationRecordApprovalEnvelopeV1> {
  const payload: OrganizationRecordApprovalEnvelopePayloadV1 = {
    schema_version: 1,
    kind: "echo-organization-record-envelope",
    event_type: "approval",
    envelope_id: input.envelope_id,
    idempotency_key: input.idempotency_key,
    payload: input.payload,
    reviewer: input.reviewer,
    intent: input.intent,
    submitter: input.submitter,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationRecordApprovalEnvelope(
    document,
    pinnedAuthority,
    input.installation_signing_key,
  );
}

export async function createOrganizationRecordRejectionEnvelope(
  input: CreateOrganizationRecordRejectionEnvelopeInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationRecordRejectionEnvelopeV1> {
  const payload: OrganizationRecordRejectionEnvelopePayloadV1 = {
    schema_version: 1,
    kind: "echo-organization-record-envelope",
    event_type: "rejection",
    envelope_id: input.envelope_id,
    idempotency_key: input.idempotency_key,
    payload: input.payload,
    reviewer: input.reviewer,
    submitter: input.submitter,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationRecordRejectionEnvelope(
    document,
    pinnedAuthority,
    input.installation_signing_key,
  );
}
