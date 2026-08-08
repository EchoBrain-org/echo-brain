import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordApprovalEnvelopeV1,
  OrganizationRecordReceiptV1,
  OrganizationRecordRejectionEnvelopeV1,
} from '@echo-brain/organization-protocol';
import {
  isOrganizationRecordPermanentRejectionCode,
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
  ORGANIZATION_API_ACCESS_LEASES_PATH,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
  ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES,
  ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES,
  validateAcceptedOrganizationRecord,
  validateOrganizationApiError,
  validateSubmitOrganizationRecordEnvelopeRequest,
} from '../src/index.js';

interface RecordFixture {
  approval_envelope: OrganizationRecordApprovalEnvelopeV1;
  approval_receipt: OrganizationRecordReceiptV1;
  rejection_envelope: OrganizationRecordRejectionEnvelopeV1;
  rejection_receipt: OrganizationRecordReceiptV1;
}

/**
 * The exact key set of the member-side
 * `OrganizationApprovalActionAuthorizationEvidence` for an allow decision.
 * The organization-api boundary forbids importing product code, so this list
 * is the pin: if the member evidence shape changes, the ingest contract must
 * change with it, and this list is where that shows up.
 */
const MEMBER_EVIDENCE_KEYS = [
  'action',
  'adapter_binding_id',
  'allowed',
  'approval_id',
  'authority_id',
  'enrollment_id',
  'evaluated_at',
  'installation_id',
  'kind',
  'membership_id',
  'organization_id',
  'permission_grant_id',
  'principal_id',
  'provider_event_sha256',
  'reason_code',
  'request_id',
  'request_sha256',
  'schema_version',
] as const;

/** The record core's own field names for one log row's identity. */
const RECEIPT_PAYLOAD_KEYS = [
  'authority_id',
  'envelope_id',
  'envelope_sha256',
  'idempotency_key',
  'installation_id',
  'kind',
  'organization_id',
  'position',
  'record_hash',
  'recorded_at',
  'schema_version',
] as const;

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../organization-protocol/fixtures/organization-record-chain.v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as RecordFixture;

describe('organization record ingest transport contract', () => {
  it('mounts one dedicated ingest path beside the existing routes', () => {
    expect(ORGANIZATION_API_RECORD_ENVELOPES_PATH).toBe('/v1/record-envelopes');
    expect(
      new Set([
        ORGANIZATION_API_RECORD_ENVELOPES_PATH,
        ORGANIZATION_API_ACCESS_LEASES_PATH,
        ORGANIZATION_API_PERMISSION_CHECKS_PATH,
      ]).size,
    ).toBe(3);
  });

  it('exempts only the record route from the shared raw body limit', () => {
    expect(MAX_ORGANIZATION_API_BODY_BYTES).toBe(16 * 1024);
    expect(MAX_ORGANIZATION_RECORD_API_BODY_BYTES).toBeGreaterThan(
      MAX_ORGANIZATION_API_BODY_BYTES,
    );
    // The raw limit must admit the largest canonical envelope the protocol
    // validator accepts, or oversize rejection would depend on which guard ran.
    // That means it is the document cap *plus the wrapper*, never equal to it:
    // an exactly-256-KiB envelope wrapped in `{"record_envelope": ... }` is 20
    // bytes larger than the thing the contract measures.
    expect(ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES).toBe(20);
    expect(
      Buffer.byteLength(
        JSON.stringify({ record_envelope: {} }),
        'utf8',
      ),
    ).toBe(ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES + 2);
    expect(MAX_ORGANIZATION_RECORD_API_BODY_BYTES).toBe(
      MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES +
        ORGANIZATION_RECORD_ENVELOPE_WRAPPER_BYTES,
    );
    expect(MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES).toBe(256 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify({ record_envelope: fixture.approval_envelope }),
        'utf8',
      ),
    ).toBeLessThan(MAX_ORGANIZATION_RECORD_API_BODY_BYTES);
  });

  it('accepts both event types in the submission DTO', () => {
    expect(
      validateSubmitOrganizationRecordEnvelopeRequest({
        record_envelope: fixture.approval_envelope,
      }),
    ).toEqual({ record_envelope: fixture.approval_envelope });
    expect(
      validateSubmitOrganizationRecordEnvelopeRequest({
        record_envelope: fixture.rejection_envelope,
      }).record_envelope.event_type,
    ).toBe('rejection');
  });

  it('validates only the submission wrapper', () => {
    expect(() =>
      validateSubmitOrganizationRecordEnvelopeRequest({
        record_envelope: fixture.approval_envelope,
        extra: true,
      }),
    ).toThrow('record submission request has an unexpected shape');
    expect(() =>
      validateSubmitOrganizationRecordEnvelopeRequest({
        envelope: fixture.approval_envelope,
      }),
    ).toThrow('record submission request has an unexpected shape');

    const malformedEnvelope = { event_type: 'correction' };
    expect(
      validateSubmitOrganizationRecordEnvelopeRequest({
        record_envelope: malformedEnvelope,
      }),
    ).toEqual({ record_envelope: malformedEnvelope });
  });

  it('validates only the accepted-record response wrapper', () => {
    expect(
      validateAcceptedOrganizationRecord({
        record_receipt: fixture.approval_receipt,
      }),
    ).toEqual({ record_receipt: fixture.approval_receipt });
    expect(() =>
      validateAcceptedOrganizationRecord({
        record_receipt: fixture.approval_receipt,
        duplicate: false,
      }),
    ).toThrow('accepted record response has an unexpected shape');
    const malformedReceipt = { kind: 'not-a-receipt' };
    expect(
      validateAcceptedOrganizationRecord({
        record_receipt: malformedReceipt,
      }),
    ).toEqual({ record_receipt: malformedReceipt });
  });

  it('carries the complete real member evidence through to an accepted receipt', () => {
    for (const [envelope, action] of [
      [fixture.approval_envelope, 'approve'],
      [fixture.rejection_envelope, 'reject'],
    ] as const) {
      const evidence = envelope.reviewer.authorization;
      expect(Object.keys(evidence).sort()).toEqual([...MEMBER_EVIDENCE_KEYS]);
      expect(evidence.allowed).toBe(true);
      expect(evidence.action).toBe(action);
      expect(evidence.approval_id).toBe(envelope.idempotency_key);
      expect(evidence.installation_id).toBe(
        envelope.submitter.installation_id,
      );
      expect(evidence.principal_id).toBe(envelope.reviewer.principal_id);
      expect(evidence.membership_id).toBe(envelope.reviewer.membership_id);
      expect(evidence.adapter_binding_id).not.toBeNull();
      expect(evidence.permission_grant_id).not.toBeNull();

      // That exact envelope is what the ingest DTO carries.
      expect(
        validateSubmitOrganizationRecordEnvelopeRequest({
          record_envelope: envelope,
        }).record_envelope.reviewer.authorization.action,
      ).toBe(action);
    }
  });

  it('accepts the core-compatible signed receipt for both event types', () => {
    for (const [receipt, envelope, position] of [
      [fixture.approval_receipt, fixture.approval_envelope, 1],
      [fixture.rejection_receipt, fixture.rejection_envelope, 2],
    ] as const) {
      const { integrity, ...payload } = receipt;
      expect(Object.keys(payload).sort()).toEqual([...RECEIPT_PAYLOAD_KEYS]);
      expect(payload.position).toBe(position);
      expect(payload.envelope_id).toBe(envelope.envelope_id);
      expect(payload.idempotency_key).toBe(envelope.idempotency_key);
      expect(payload.installation_id).toBe(envelope.submitter.installation_id);
      expect(integrity.canonicalization).toBe('RFC8785');

      const accepted = validateAcceptedOrganizationRecord({
        record_receipt: receipt,
      });
      expect(accepted).toEqual({ record_receipt: receipt });
      expect(accepted.record_receipt.position).toBe(position);
    }
  });

  it('separates terminal rejection codes from retryable failures', () => {
    expect([...ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES]).toEqual([
      'record_authorization_invalid',
      'record_envelope_invalid',
      'record_envelope_too_large',
      'record_idempotency_conflict',
      'record_signature_invalid',
    ]);
    for (const code of ORGANIZATION_RECORD_PERMANENT_REJECTION_CODES) {
      expect(isOrganizationRecordPermanentRejectionCode(code)).toBe(true);
      expect(
        validateOrganizationApiError({
          error: { code, message: 'permanent ingest rejection' },
        }),
      ).toEqual({ error: { code, message: 'permanent ingest rejection' } });
    }

    for (const code of ['access_lease_expired', 'internal_error', 'not_found']) {
      expect(isOrganizationRecordPermanentRejectionCode(code)).toBe(false);
      // A transient failure is still a well-formed API error; it just must not
      // narrow to a terminal outcome the submitter would file forever.
      expect(
        validateOrganizationApiError({ error: { code, message: 'retry' } })
          .error.code,
      ).toBe(code);
    }
    expect(isOrganizationRecordPermanentRejectionCode(undefined)).toBe(false);
  });
});
