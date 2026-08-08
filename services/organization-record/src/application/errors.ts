export type OrganizationRecordErrorCode =
  | 'envelope_index_mismatch'
  | 'idempotency_conflict'
  | 'log_invariant_violated'
  | 'derive_unprocessable_record'
  | 'derive_halted';

export class OrganizationRecordError extends Error {
  readonly code: OrganizationRecordErrorCode;

  constructor(code: OrganizationRecordErrorCode, message: string) {
    super(message);
    this.name = 'OrganizationRecordError';
    this.code = code;
  }
}

/**
 * A known `(installation_id, idempotency_key)` was reused with a different
 * envelope digest. Permanent and loud: the member machine froze one exact
 * envelope per human act, so divergent reuse is never a retry.
 */
export class OrganizationRecordIdempotencyConflictError extends OrganizationRecordError {
  readonly installation_id: string;
  readonly idempotency_key: string;
  readonly stored_envelope_sha256: string;
  readonly presented_envelope_sha256: string;

  constructor(input: {
    installation_id: string;
    idempotency_key: string;
    stored_envelope_sha256: string;
    presented_envelope_sha256: string;
  }) {
    super(
      'idempotency_conflict',
      `organization record idempotency key ${input.idempotency_key} for installation ${input.installation_id} was reused with a different envelope`,
    );
    this.name = 'OrganizationRecordIdempotencyConflictError';
    this.installation_id = input.installation_id;
    this.idempotency_key = input.idempotency_key;
    this.stored_envelope_sha256 = input.stored_envelope_sha256;
    this.presented_envelope_sha256 = input.presented_envelope_sha256;
  }
}

/**
 * Derive met a record it cannot process. Ingest-time payload validation should
 * make this impossible; when it happens the follower halts rather than skipping
 * so staleness is visible and truth is untouched.
 */
export class OrganizationRecordDeriveError extends OrganizationRecordError {
  readonly log_position: number;

  constructor(logPosition: number, detail: string) {
    super(
      'derive_unprocessable_record',
      `organization record at position ${logPosition} cannot be derived: ${detail}`,
    );
    this.name = 'OrganizationRecordDeriveError';
    this.log_position = logPosition;
  }
}

export function isOrganizationRecordError(
  value: unknown,
): value is OrganizationRecordError {
  return value instanceof OrganizationRecordError;
}
