import {
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from "@echo-brain/federation-protocol";
import type { P256SigningKeyDescriptor } from "@echo-brain/federation-protocol";
import { resolvePinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type {
  CanonicalPayloadSigner,
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordReviewerApprovalEnvelopePayloadV2,
  OrganizationRecordReviewerApprovalEnvelopeV2,
  OrganizationRecordReviewerAuthorizationV2,
  OrganizationRecordReviewerIntentV2,
  OrganizationRecordReviewerV2,
  OrganizationRecordSubmitterV1,
} from "./contracts.js";
import {
  assertOrganizationRecordApprovalPayload,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from "./record-payload.js";
import {
  projectReviewerReleaseDraft,
  reviewerReleaseDraftSha256,
} from "./reviewer-release-draft.js";
import {
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_POLICY_ID,
  RESTRICTED_REVIEWER_RECORD_SURFACE,
  assertReviewerApprovalId,
  assertReviewerPresentableText,
} from "./reviewer-restricted-policy.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  assertOnlyEnumerableDataProperties,
  assertPrefixedUuidId,
  assertTimestamp,
  canonicalSnapshot,
  timestampMillis,
  validateSignedIntegrity,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

const MAX_REVIEWED_BY_SCALARS = 256;

const REVIEWER_ENVELOPE_LABEL = "organization record reviewer envelope";

export const REVIEWER_RECORD_ENVELOPE_SCHEMA_VERSION = 2;

/** Display only, and never an authorization input. */
function assertReviewedBy(value: unknown, label: string): void {
  assertReviewerPresentableText(value, label, MAX_REVIEWED_BY_SCALARS);
}

/**
 * The complete Authority proof. Every field is recomputed centrally; this
 * validator only proves that the quoted decision is closed, is an allow, is an
 * approval, and carries the one reviewer reason code.
 */
function assertReviewerAuthorization(
  value: unknown,
  label: string,
): OrganizationRecordReviewerAuthorizationV2 {
  const evidence = asRecord(value, label);
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
      "authorization_audit_event_id",
      "authorization_audit_entry_sha256",
      "reviewer_release_draft_sha256",
      "approval_presentation_sha256",
      "semantic_intent_sha256",
      "message_presentation_sha256",
    ],
    label,
  );
  assertLiteral(evidence.schema_version, 2, `${label} schema_version`);
  assertLiteral(
    evidence.kind,
    "echo-organization-authorization-evidence",
    `${label} kind`,
  );
  assertId(evidence.authority_id, "oau", `${label} authority_id`);
  assertId(evidence.organization_id, "org", `${label} organization_id`);
  assertId(evidence.enrollment_id, "enr", `${label} enrollment_id`);
  assertId(evidence.installation_id, "ins", `${label} installation_id`);
  assertPrefixedUuidId(evidence.request_id, "pcr", `${label} request_id`);
  assertReviewerApprovalId(evidence.approval_id, `${label} approval_id`);
  assertLiteral(evidence.action, "approve", `${label} action`);
  assertDigest(evidence.request_sha256, `${label} request_sha256`);
  assertDigest(
    evidence.provider_event_sha256,
    `${label} provider_event_sha256`,
  );
  if (evidence.allowed !== true) {
    organizationProtocolValidationFailure(`${label} must be an allow decision`);
  }
  assertLiteral(
    evidence.reason_code,
    RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
    `${label} reason_code`,
  );
  assertId(evidence.principal_id, "prn", `${label} principal_id`);
  assertId(evidence.membership_id, "mem", `${label} membership_id`);
  assertId(evidence.adapter_binding_id, "bnd", `${label} adapter_binding_id`);
  assertPrefixedUuidId(
    evidence.permission_grant_id,
    "pgr",
    `${label} permission_grant_id`,
  );
  assertTimestamp(evidence.evaluated_at, `${label} evaluated_at`);
  assertPrefixedUuidId(
    evidence.authorization_audit_event_id,
    "aud",
    `${label} authorization_audit_event_id`,
  );
  assertDigest(
    evidence.authorization_audit_entry_sha256,
    `${label} authorization_audit_entry_sha256`,
  );
  assertDigest(
    evidence.reviewer_release_draft_sha256,
    `${label} reviewer_release_draft_sha256`,
  );
  assertDigest(
    evidence.approval_presentation_sha256,
    `${label} approval_presentation_sha256`,
  );
  assertDigest(
    evidence.semantic_intent_sha256,
    `${label} semantic_intent_sha256`,
  );
  assertDigest(
    evidence.message_presentation_sha256,
    `${label} message_presentation_sha256`,
  );
  return evidence as unknown as OrganizationRecordReviewerAuthorizationV2;
}

function assertReviewer(
  value: unknown,
  label: string,
  approvalId: string,
  installationId: string,
): OrganizationRecordReviewerV2 {
  const reviewer = asRecord(value, label);
  assertExactKeys(
    reviewer,
    ["principal_id", "membership_id", "reviewed_by", "authorization"],
    label,
  );
  assertId(reviewer.principal_id, "prn", `${label} principal_id`);
  assertId(reviewer.membership_id, "mem", `${label} membership_id`);
  assertReviewedBy(reviewer.reviewed_by, `${label} reviewed_by`);
  const evidence = assertReviewerAuthorization(
    reviewer.authorization,
    `${label} authorization`,
  );
  if (
    evidence.approval_id !== approvalId ||
    evidence.installation_id !== installationId ||
    evidence.principal_id !== reviewer.principal_id ||
    evidence.membership_id !== reviewer.membership_id
  ) {
    organizationProtocolValidationFailure(
      `${label} authorization does not bind this exact submission`,
    );
  }
  return reviewer as unknown as OrganizationRecordReviewerV2;
}

function assertReviewerIntent(
  value: unknown,
  label: string,
  semanticIntentSha256: string,
): void {
  const intent = asRecord(value, label);
  assertExactKeys(
    intent,
    ["schema_version", "visibility", "policy_id", "provenance"],
    label,
  );
  assertLiteral(intent.schema_version, 1, `${label} schema_version`);
  assertLiteral(intent.visibility, "restricted", `${label} visibility`);
  assertLiteral(
    intent.policy_id,
    RESTRICTED_REVIEWER_POLICY_ID,
    `${label} policy_id`,
  );
  const provenance = asRecord(intent.provenance, `${label} provenance`);
  assertExactKeys(
    provenance,
    ["kind", "semantic_intent_sha256"],
    `${label} provenance`,
  );
  assertLiteral(
    provenance.kind,
    "approval-surface-confirmation-v1",
    `${label} provenance kind`,
  );
  assertDigest(
    provenance.semantic_intent_sha256,
    `${label} provenance semantic_intent_sha256`,
  );
  if (provenance.semantic_intent_sha256 !== semanticIntentSha256) {
    organizationProtocolValidationFailure(
      `${label} provenance does not quote the authorized semantic intent`,
    );
  }
}

function assertSubmitter(
  value: unknown,
  label: string,
): OrganizationRecordSubmitterV1 {
  const submitter = asRecord(value, label);
  assertExactKeys(submitter, ["installation_id", "submitted_at"], label);
  assertId(submitter.installation_id, "ins", `${label} installation_id`);
  assertTimestamp(submitter.submitted_at, `${label} submitted_at`);
  return submitter as unknown as OrganizationRecordSubmitterV1;
}

/**
 * The closed reviewer-v2 approval validator. It never reads a v1 field set and
 * is never reached by a v1 document: the strict dispatcher switches on the
 * exact `(kind, schema_version)` pair before any field is interpreted.
 */
export function assertReviewerApprovalEnvelopeSnapshot(
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
  assertLiteral(record.schema_version, 2, `${label} schema_version`);
  assertLiteral(
    record.kind,
    "echo-organization-record-envelope",
    `${label} kind`,
  );
  if (record.event_type !== "approval") {
    organizationProtocolValidationFailure(
      `${label} schema version 2 admits approval only`,
    );
  }
  assertId(record.envelope_id, "rec", `${label} envelope_id`);
  assertReviewerApprovalId(record.idempotency_key, `${label} idempotency_key`);
  const submitter = assertSubmitter(record.submitter, `${label} submitter`);
  const reviewer = assertReviewer(
    record.reviewer,
    `${label} reviewer`,
    record.idempotency_key as string,
    submitter.installation_id,
  );
  assertReviewerIntent(
    record.intent,
    `${label} intent`,
    reviewer.authorization.semantic_intent_sha256,
  );
  validateSignedIntegrity(record.integrity, `${label} integrity`);

  assertOrganizationRecordApprovalPayload(record.payload, `${label} payload`);
  const payload = record.payload as OrganizationRecordApprovalPayloadV1;
  if (payload.surface !== RESTRICTED_REVIEWER_RECORD_SURFACE) {
    organizationProtocolValidationFailure(
      `${label} payload surface must be ${RESTRICTED_REVIEWER_RECORD_SURFACE}`,
    );
  }
  const draft = projectReviewerReleaseDraft({
    approval_id: record.idempotency_key as string,
    brief: payload.brief,
  });
  if (
    reviewerReleaseDraftSha256(draft) !==
    reviewer.authorization.reviewer_release_draft_sha256
  ) {
    organizationProtocolValidationFailure(
      `${label} payload does not reproduce the approved release draft`,
    );
  }
  if (payload.reviewed_at !== reviewer.authorization.evaluated_at) {
    organizationProtocolValidationFailure(
      `${label} payload reviewed_at must be the authority evaluation time`,
    );
  }
  if (
    timestampMillis(submitter.submitted_at, `${label} submitter submitted_at`) <
    timestampMillis(payload.reviewed_at, `${label} payload reviewed_at`)
  ) {
    organizationProtocolValidationFailure(
      `${label} submitter submitted_at precedes the approval`,
    );
  }
}

export function validateOrganizationRecordReviewerApprovalEnvelope(
  value: unknown,
): OrganizationRecordReviewerApprovalEnvelopeV2 {
  assertOnlyEnumerableDataProperties(value, REVIEWER_ENVELOPE_LABEL);
  const record = asRecord(
    canonicalSnapshot(
      value,
      REVIEWER_ENVELOPE_LABEL,
      MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
    ),
    REVIEWER_ENVELOPE_LABEL,
  );
  assertReviewerApprovalEnvelopeSnapshot(record, REVIEWER_ENVELOPE_LABEL);
  return record as unknown as OrganizationRecordReviewerApprovalEnvelopeV2;
}

export function verifyOrganizationRecordReviewerApprovalEnvelope(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecordReviewerApprovalEnvelopeV2 {
  const envelope = validateOrganizationRecordReviewerApprovalEnvelope(value);
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
  return envelope;
}

export interface CreateOrganizationRecordReviewerApprovalEnvelopeInput {
  envelope_id: string;
  idempotency_key: string;
  payload: OrganizationRecordApprovalPayloadV1;
  reviewer: OrganizationRecordReviewerV2;
  intent: OrganizationRecordReviewerIntentV2;
  submitter: OrganizationRecordSubmitterV1;
  installation_signing_key: P256SigningKeyDescriptor;
}

export async function createOrganizationRecordReviewerApprovalEnvelope(
  input: CreateOrganizationRecordReviewerApprovalEnvelopeInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationRecordReviewerApprovalEnvelopeV2> {
  const payload: OrganizationRecordReviewerApprovalEnvelopePayloadV2 = {
    schema_version: 2,
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
  return verifyOrganizationRecordReviewerApprovalEnvelope(
    document,
    pinnedAuthority,
    input.installation_signing_key,
  );
}

/**
 * The reviewer intent object for one authorized approval. It is derived, never
 * client-chosen: the only variable is the Authority-computed semantic digest.
 */
export function organizationRecordReviewerIntent(
  semanticIntentSha256: string,
): OrganizationRecordReviewerIntentV2 {
  assertDigest(semanticIntentSha256, "reviewer intent semantic_intent_sha256");
  return {
    schema_version: 1,
    visibility: "restricted",
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    provenance: {
      kind: "approval-surface-confirmation-v1",
      semantic_intent_sha256: semanticIntentSha256,
    },
  };
}
