import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_RECORD_FRAME_KIND,
  ORGANIZATION_RECORD_RECEIPT_KIND,
  ORGANIZATION_RECORD_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
  type OrganizationRecordEventTypeV1,
  type OrganizationRecordFrameV1,
  type OrganizationRecordReceiptPayloadV1,
  type Sha256Digest,
  type VerifiedOrganizationRecordEnvelope,
} from './contracts.js';
import { OrganizationRecordError } from './errors.js';

/**
 * One canonicalization. Every digest in this module is RFC 8785 over the
 * parsed value, produced by `packages/federation-protocol`. This workspace
 * adds no canonical-JSON implementation of its own, and core's divergent
 * delivery-envelope digest is never used for organization-record artifacts.
 */
export function organizationRecordCanonicalEnvelope(envelope: JsonObject): string {
  return canonicalJson(envelope);
}

export function parseOrganizationRecordEnvelope(canonicalEnvelope: string): JsonObject {
  const parsed = parseCanonicalJson<JsonValue>(canonicalEnvelope);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrganizationRecordError(
      'log_invariant_violated',
      'stored organization record envelope is not a JSON object',
    );
  }
  return parsed;
}

export function organizationRecordFrame(input: {
  organization_id: string;
  position: number;
  previous_record_hash: Sha256Digest | null;
  recorded_at: string;
  envelope_sha256: Sha256Digest;
}): OrganizationRecordFrameV1 {
  return {
    schema_version: ORGANIZATION_RECORD_SCHEMA_VERSION,
    kind: ORGANIZATION_RECORD_FRAME_KIND,
    organization_id: input.organization_id,
    position: input.position,
    previous_record_hash: input.previous_record_hash,
    recorded_at: input.recorded_at,
    envelope_sha256: input.envelope_sha256,
  };
}

/** `record_hash = sha256(canonical_record_frame_bytes)`. */
export function organizationRecordHash(frame: OrganizationRecordFrameV1): Sha256Digest {
  return canonicalSha256(frame);
}

export function organizationRecordReceiptPayload(input: {
  authority_id: string;
  organization_id: string;
  envelope_id: string;
  envelope_sha256: Sha256Digest;
  installation_id: string;
  idempotency_key: string;
  position: number;
  record_hash: Sha256Digest;
  recorded_at: string;
}): OrganizationRecordReceiptPayloadV1 {
  return {
    schema_version: ORGANIZATION_RECORD_SCHEMA_VERSION,
    kind: ORGANIZATION_RECORD_RECEIPT_KIND,
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    envelope_id: input.envelope_id,
    envelope_sha256: input.envelope_sha256,
    installation_id: input.installation_id,
    idempotency_key: input.idempotency_key,
    position: input.position,
    record_hash: input.record_hash,
    recorded_at: input.recorded_at,
  };
}

function readString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface OrganizationRecordEnvelopeIndex {
  readonly envelope_id: string;
  readonly event_type: OrganizationRecordEventTypeV1;
  readonly idempotency_key: string;
  readonly installation_id: string;
}

/**
 * Reads the four index columns out of the canonical envelope bytes.
 *
 * This is not schema validation — the authority verification port owns that.
 * It exists so the columns the log indexes and dedupes on are read from the
 * same bytes the digest covers, and an adapter that reported a different key
 * than it signed cannot write a row whose index disagrees with its content.
 */
export function organizationRecordEnvelopeIndex(
  envelope: JsonObject,
): OrganizationRecordEnvelopeIndex {
  const envelopeId = readString(envelope['envelope_id']);
  const eventType = readString(envelope['event_type']);
  const idempotencyKey = readString(envelope['idempotency_key']);
  const submitter = envelope['submitter'];
  const installationId =
    submitter !== null && typeof submitter === 'object' && !Array.isArray(submitter)
      ? readString((submitter as JsonObject)['installation_id'])
      : null;
  if (
    envelopeId === null ||
    idempotencyKey === null ||
    installationId === null ||
    (eventType !== 'approval' && eventType !== 'rejection')
  ) {
    throw new OrganizationRecordError(
      'envelope_index_mismatch',
      'organization record envelope is missing an index field the log requires',
    );
  }
  return {
    envelope_id: envelopeId,
    event_type: eventType,
    idempotency_key: idempotencyKey,
    installation_id: installationId,
  };
}

export function assertVerifiedEnvelopeIndexBinding(
  verified: VerifiedOrganizationRecordEnvelope,
): void {
  const index = organizationRecordEnvelopeIndex(verified.envelope);
  if (
    index.envelope_id !== verified.envelope_id ||
    index.event_type !== verified.event_type ||
    index.idempotency_key !== verified.idempotency_key ||
    index.installation_id !== verified.installation_id
  ) {
    throw new OrganizationRecordError(
      'envelope_index_mismatch',
      'verified organization record envelope does not match its own canonical bytes',
    );
  }
}
