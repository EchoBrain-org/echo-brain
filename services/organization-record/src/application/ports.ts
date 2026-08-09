import type {
  JsonObject,
  OrganizationRecordLogRow,
  OrganizationRecordReceiptPayloadV1,
  Sha256Digest,
  VerifiedOrganizationRecordEnvelope,
} from './contracts.js';

/**
 * Authority verification.
 *
 * The record module never opens `authority.sqlite` and never re-implements a
 * verification rule. Everything the design requires before append — current
 * access lease, installation signature over the canonical bytes, envelope and
 * payload schema validation, and the exact allowed authorization-evidence
 * lookup in the integration audit — happens behind this one call, in the
 * authority's application interface. A permanent rejection is signalled by
 * throwing; the caller turns that into the member-visible rejection.
 */
export interface OrganizationRecordAuthorityPort {
  verifyEnvelope(envelope: unknown): Promise<VerifiedOrganizationRecordEnvelope>;
}

/**
 * Receipt signing with the existing authority signing key that member machines
 * already pin. The port receives exactly the deterministic receipt payload the
 * append transaction stored and returns the signed document.
 */
export interface OrganizationRecordReceiptSignerPort {
  signReceipt(payload: OrganizationRecordReceiptPayloadV1): Promise<JsonObject>;
}

/** RFC 3339 UTC millisecond timestamps. Injected so record time is testable. */
export type OrganizationRecordClock = () => string;

export const systemOrganizationRecordClock: OrganizationRecordClock = () =>
  new Date().toISOString();

export type OrganizationRecordAlertKind =
  | 'derive-halted'
  | 'derive-nudge-failed'
  | 'receipt-materialization-failed';

export interface OrganizationRecordAlert {
  readonly kind: OrganizationRecordAlertKind;
  readonly message: string;
  readonly log_position: number | null;
  readonly cause: unknown;
}

/**
 * Operator alerting. The composition root decides what a halt does to the
 * process — the design makes a deterministic derive failure fatal after the
 * alert so the supervisor restart exercises the startup catch-up path. This
 * library never calls `process.exit` on its caller's behalf.
 */
export type OrganizationRecordAlertPort = (alert: OrganizationRecordAlert) => void;

export interface OrganizationRecordLogAppendInput {
  readonly envelope: VerifiedOrganizationRecordEnvelope;
  readonly canonical_envelope: string;
  readonly envelope_sha256: Sha256Digest;
  readonly recorded_at: string;
}

export interface OrganizationRecordLogAppendOutcome {
  readonly outcome: 'appended' | 'duplicate';
  readonly row: OrganizationRecordLogRow;
}

/** The append side of the log, data-at-rest. Implemented over `record-log.sqlite`. */
export interface OrganizationRecordLogPort {
  readonly organization_id: string;
  readonly authority_id: string;
  append(input: OrganizationRecordLogAppendInput): OrganizationRecordLogAppendOutcome;
  /** The row already accepted under this installation-scoped idempotency key. */
  findAcceptedRecord(
    installationId: string,
    idempotencyKey: string,
  ): OrganizationRecordLogRow | null;
  readSignedReceipt(position: number): string | null;
  /** Create-once. Returns the stored document, which may be an earlier writer's. */
  putSignedReceipt(
    position: number,
    signedReceipt: string,
    materializedAt: string,
  ): string;
}

/**
 * The read side of the log, data-at-rest. Derive follows the log through this
 * port and never calls the append machine.
 */
export interface OrganizationRecordLogReaderPort {
  readAfter(position: number, limit: number): readonly OrganizationRecordLogRow[];
}
