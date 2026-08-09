import type {
  OrganizationRecordEventTypeV1,
  OrganizationRecordLogRow,
  Sha256Digest,
} from './contracts.js';

/**
 * The log row exactly as SQLite returns it.
 *
 * Append and derive never call each other; they communicate only through data
 * at rest. This mapper is the shape of that data, kept in the pure layer so
 * both sides read the same columns without either importing the other.
 */
export interface RawOrganizationRecordLogRow {
  position: number;
  envelope_id: string;
  event_type: string;
  installation_id: string;
  idempotency_key: string;
  canonical_envelope: string;
  envelope_sha256: string;
  receipt_payload: string;
  previous_record_hash: string | null;
  record_hash: string;
  recorded_at: string;
}

export function toOrganizationRecordLogRow(
  raw: RawOrganizationRecordLogRow,
): OrganizationRecordLogRow {
  return {
    position: raw.position,
    envelope_id: raw.envelope_id,
    event_type: raw.event_type as OrganizationRecordEventTypeV1,
    installation_id: raw.installation_id,
    idempotency_key: raw.idempotency_key,
    canonical_envelope: raw.canonical_envelope,
    envelope_sha256: raw.envelope_sha256 as Sha256Digest,
    receipt_payload: raw.receipt_payload,
    previous_record_hash: raw.previous_record_hash as Sha256Digest | null,
    record_hash: raw.record_hash as Sha256Digest,
    recorded_at: raw.recorded_at,
  };
}
