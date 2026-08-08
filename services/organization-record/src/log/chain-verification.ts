import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import type {
  OrganizationRecordChainFailure,
  OrganizationRecordChainVerification,
  OrganizationRecordLogRow,
  Sha256Digest,
} from '../application/contracts.js';
import {
  organizationRecordEnvelopeIndex,
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
  parseOrganizationRecordEnvelope,
} from '../application/record-frame.js';

export interface OrganizationRecordChainSource {
  readonly organization_id: string;
  readonly authority_id: string;
  rows(): readonly OrganizationRecordLogRow[];
}

/**
 * Walks the internal chain. A chain nobody walks is decoration, so the host
 * runs this at process start and before every backup.
 *
 * What it detects: mutation of any stored field, reordering, and deletion
 * inside the surviving chain. What it cannot detect, honestly reported in the
 * result: a valid-prefix tail truncation or a database rollback. Those are
 * indistinguishable from a shorter honest log without an external checkpoint.
 * Per-envelope signatures alone never detect removal.
 */
export function verifyOrganizationRecordChain(
  source: OrganizationRecordChainSource,
): OrganizationRecordChainVerification {
  const rows = source.rows();
  const failures: OrganizationRecordChainFailure[] = [];
  let previousRecordHash: Sha256Digest | null = null;
  let expectedPosition = 1;

  for (const row of rows) {
    if (row.position !== expectedPosition) {
      failures.push({
        position: row.position,
        kind: 'position_gap',
        detail: `expected position ${expectedPosition}`,
      });
    }
    expectedPosition = row.position + 1;

    let envelope: ReturnType<typeof parseOrganizationRecordEnvelope> | null =
      null;
    try {
      envelope = parseOrganizationRecordEnvelope(row.canonical_envelope);
    } catch (error) {
      failures.push({
        position: row.position,
        kind: 'envelope_not_canonical',
        detail: (error as Error).message,
      });
    }
    if (envelope !== null) {
      const envelopeDigest = sha256Digest(row.canonical_envelope);
      if (envelopeDigest !== row.envelope_sha256) {
        failures.push({
          position: row.position,
          kind: 'envelope_digest_mismatch',
          detail: `stored ${row.envelope_sha256}, recomputed ${envelopeDigest}`,
        });
      }
      try {
        const index = organizationRecordEnvelopeIndex(envelope);
        if (
          index.envelope_id !== row.envelope_id ||
          index.event_type !== row.event_type ||
          index.installation_id !== row.installation_id ||
          index.idempotency_key !== row.idempotency_key
        ) {
          failures.push({
            position: row.position,
            kind: 'envelope_index_mismatch',
            detail:
              'stored organization record index does not match its canonical envelope',
          });
        }
      } catch (error) {
        failures.push({
          position: row.position,
          kind: 'envelope_index_mismatch',
          detail: (error as Error).message,
        });
      }
    }

    if (row.previous_record_hash !== previousRecordHash) {
      failures.push({
        position: row.position,
        kind: 'predecessor_mismatch',
        detail: `stored ${String(row.previous_record_hash)}, chain ${String(previousRecordHash)}`,
      });
    }

    const recomputed = organizationRecordHash(
      organizationRecordFrame({
        organization_id: source.organization_id,
        position: row.position,
        previous_record_hash: row.previous_record_hash,
        recorded_at: row.recorded_at,
        envelope_sha256: row.envelope_sha256,
      }),
    );
    if (recomputed !== row.record_hash) {
      failures.push({
        position: row.position,
        kind: 'record_hash_mismatch',
        detail: `stored ${row.record_hash}, recomputed ${recomputed}`,
      });
    }

    const expectedReceipt = canonicalJson(
      organizationRecordReceiptPayload({
        authority_id: source.authority_id,
        organization_id: source.organization_id,
        envelope_id: row.envelope_id,
        envelope_sha256: row.envelope_sha256,
        installation_id: row.installation_id,
        idempotency_key: row.idempotency_key,
        position: row.position,
        record_hash: row.record_hash,
        recorded_at: row.recorded_at,
      }),
    );
    if (expectedReceipt !== row.receipt_payload) {
      failures.push({
        position: row.position,
        kind: 'receipt_payload_mismatch',
        detail: 'stored receipt payload does not match the record it was committed with',
      });
    }

    previousRecordHash = row.record_hash;
  }

  const head = rows.at(-1) ?? null;
  return {
    organization_id: source.organization_id,
    head_position: head?.position ?? null,
    head_record_hash: head?.record_hash ?? null,
    records_verified: rows.length,
    failures,
    tail_truncation_detectable: false,
  };
}
