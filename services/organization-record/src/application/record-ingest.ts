import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  JsonObject,
  OrganizationRecordAppendResult,
  OrganizationRecordLogRow,
  OrganizationRecordReceiptPayloadV1,
  Sha256Digest,
  VerifiedOrganizationRecordEnvelope,
} from './contracts.js';
import {
  createReviewerEligibilityCapabilityChannel,
  type ReviewerEligibilityCapabilityChannel,
  type ReviewerPolicyFactAppendInput,
} from './reviewer-eligibility-capability.js';
import {
  readReviewerRestrictedEnvelope,
  type ReviewerRestrictedEnvelopeValidator,
} from './reviewer-policy-fact.js';
import { OrganizationRecordError } from './errors.js';
import {
  assertVerifiedEnvelopeIndexBinding,
  organizationRecordCanonicalEnvelope,
  organizationRecordEnvelopeIndex,
} from './record-frame.js';
import { assertOrganizationPermissionPilotProofBinding } from './permission-pilot.js';
import {
  systemOrganizationRecordClock,
  type OrganizationRecordAlertPort,
  type OrganizationRecordAuthorityPort,
  type OrganizationRecordClock,
  type OrganizationRecordLogPort,
  type OrganizationRecordReceiptSignerPort,
} from './ports.js';

export interface OrganizationRecordIngestDependencies {
  readonly log: OrganizationRecordLogPort;
  readonly authority: OrganizationRecordAuthorityPort;
  readonly receiptSigner: OrganizationRecordReceiptSignerPort;
  /**
   * Receipt materialization time only. Record time belongs to the log's own
   * append transaction and is never sampled here.
   */
  readonly clock?: OrganizationRecordClock;
  /** The injected closed reviewer-v2 validator, from Authority composition. */
  readonly reviewerValidator?: ReviewerRestrictedEnvelopeValidator;
  /** The in-process derive nudge, fired after each append commit. */
  readonly onAppended?: () => void;
  readonly alert?: OrganizationRecordAlertPort;
}

function storedReceiptPayload(row: OrganizationRecordLogRow): OrganizationRecordReceiptPayloadV1 {
  return parseCanonicalJson(row.receipt_payload) as unknown as OrganizationRecordReceiptPayloadV1;
}

function asJsonObject(value: unknown, detail: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrganizationRecordError('log_invariant_violated', detail);
  }
  return value as JsonObject;
}

/**
 * The create-once guard on the receipt seam.
 *
 * `putSignedReceipt` is the one write in this module that can never be taken
 * back, so what it stores has to be a signed form of the exact payload the
 * append transaction committed — same position, same record hash, same
 * everything but the integrity block. Verifying the *signature* needs the
 * authority key and belongs to the signer adapter; proving the document did
 * not drift from the stored payload is this module's own invariant, and it is
 * the difference between a receipt a member can present against the log and a
 * permanent row nobody can use.
 */
function assertSignedReceiptBindsStoredPayload(
  signed: JsonObject,
  row: OrganizationRecordLogRow,
): void {
  const { integrity, ...payload } = signed as Record<string, unknown>;
  if (integrity === null || typeof integrity !== 'object' || Array.isArray(integrity)) {
    throw new OrganizationRecordError(
      'log_invariant_violated',
      `signed organization record receipt at position ${row.position} carries no integrity block`,
    );
  }
  if (canonicalJson(payload as JsonObject) !== row.receipt_payload) {
    throw new OrganizationRecordError(
      'log_invariant_violated',
      `signed organization record receipt at position ${row.position} does not carry the committed receipt payload`,
    );
  }
}

/**
 * Verify, then dedupe and append.
 *
 * Ingest is two steps in a fixed order. Payload validation happens before
 * append, always: an immutable log must never accept a record derive cannot
 * process. Append never waits on derive — the approver waits only for the
 * receipt round trip, and derivation follows in the same process via the nudge.
 */
export class OrganizationRecordIngest {
  private readonly log: OrganizationRecordLogPort;
  private readonly authority: OrganizationRecordAuthorityPort;
  private readonly receiptSigner: OrganizationRecordReceiptSignerPort;
  private readonly clock: OrganizationRecordClock;
  private readonly reviewerValidator:
    | ReviewerRestrictedEnvelopeValidator
    | undefined;
  private readonly onAppended: (() => void) | null;
  private readonly alert: OrganizationRecordAlertPort | null;
  /**
   * One channel per ingest. Capabilities minted here are honored only by this
   * object's own appends, so a capability can never cross processes, ingests,
   * or organizations.
   */
  private readonly reviewerEligibilityChannel: ReviewerEligibilityCapabilityChannel =
    createReviewerEligibilityCapabilityChannel();

  constructor(dependencies: OrganizationRecordIngestDependencies) {
    this.log = dependencies.log;
    this.authority = dependencies.authority;
    this.receiptSigner = dependencies.receiptSigner;
    this.clock = dependencies.clock ?? systemOrganizationRecordClock;
    this.reviewerValidator = dependencies.reviewerValidator;
    this.onAppended = dependencies.onAppended ?? null;
    this.alert = dependencies.alert ?? null;
  }

  async append(envelope: unknown): Promise<OrganizationRecordAppendResult> {
    const accepted = this.findAcceptedRecord(envelope);
    if (accepted !== null) return this.resultFor('duplicate', accepted);

    const verified = await this.authority.verifyEnvelope(envelope);
    assertVerifiedEnvelopeIndexBinding(verified);
    assertOrganizationPermissionPilotProofBinding(
      verified.envelope,
      verified.permission_pilot_eligibility,
    );
    const canonicalEnvelope = organizationRecordCanonicalEnvelope(verified.envelope);
    const envelopeSha256 = sha256Digest(canonicalEnvelope);

    // Only after the Authority port proved the exact immutable audit row does
    // the coordinator mint a capability, and it mints one per append attempt:
    // a failed transaction is retried by repeating the lookup, never by
    // reusing this object.
    const reviewerEligibility = this.mintReviewerEligibility(
      verified,
      envelopeSha256,
    );

    const { outcome, row } = this.log.append({
      envelope: verified,
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: envelopeSha256,
      ...(reviewerEligibility === null
        ? {}
        : { reviewer_eligibility: reviewerEligibility }),
    });

    if (outcome === 'appended') this.nudge();
    return this.resultFor(outcome, row);
  }

  /**
   * Mints the single-use eligibility capability for one reviewer-v2 append.
   *
   * The proof view arrives from the Authority verification port, which already
   * performed the exact primary-key integration-audit lookup and matched the
   * closed reviewer proof. This method only turns that proved evidence into an
   * unforgeable runtime object bound to this exact canonical envelope; it
   * decides nothing and reads no audit state itself.
   */
  private mintReviewerEligibility(
    verified: VerifiedOrganizationRecordEnvelope,
    envelopeSha256: Sha256Digest,
  ): ReviewerPolicyFactAppendInput | null {
    const proof = verified.reviewer_restricted_proof;
    if (proof === undefined) return null;
    const view = readReviewerRestrictedEnvelope(
      verified.envelope,
      this.reviewerValidator as ReviewerRestrictedEnvelopeValidator,
    );
    const capability = this.reviewerEligibilityChannel.issue({
      organization_id: this.log.organization_id,
      envelope_id: view.envelope_id,
      idempotency_key: view.idempotency_key,
      installation_id: view.installation_id,
      canonical_envelope_sha256: envelopeSha256,
      reviewer_principal_id: proof.reviewer_principal_id,
      reviewer_membership_id: proof.reviewer_membership_id,
      reviewer_release_draft_sha256: proof.reviewer_release_draft_sha256,
      approval_presentation_sha256: proof.approval_presentation_sha256,
      semantic_intent_sha256: proof.semantic_intent_sha256,
      message_presentation_sha256: proof.message_presentation_sha256,
      authorization_audit_event_id: proof.authorization_audit_event_id,
      authorization_audit_entry_sha256: proof.authorization_audit_entry_sha256,
      evaluated_at: proof.evaluated_at,
    });
    return { capability, channel: this.reviewerEligibilityChannel };
  }

  /**
   * Finds the committed row for an exact resend of an already-accepted act.
   *
   * The append path is verify-then-dedupe, which is right for a new act and
   * wrong for a receipt that was lost after its append committed: a lease that
   * has since expired, or a membership revoked afterwards, would block the
   * retry forever and strand a durable record with no receipt. Resending the
   * exact canonical bytes already accepted under the same installation-scoped
   * idempotency key is not a new act, so it does not need a fresh
   * authorization — the caller already holds the member's signed envelope, and
   * everything it can recover is that member's own receipt for it.
   *
   * The match is exact on both the canonical bytes and the stored digest.
   * Anything else — an absent row, divergent content, or an unreadable
   * request — returns null and takes the full verification path, where an
   * absent row still faces undiminished authority verification and a divergent
   * reuse still raises `idempotency_conflict`.
   */
  private findAcceptedRecord(envelope: unknown): OrganizationRecordLogRow | null {
    try {
      const value = asJsonObject(
        envelope,
        'organization record envelope is not a JSON object',
      );
      // A schema-v2 duplicate may not return before Authority verification.
      // The reviewer path has to repeat its exact audit lookup, mint and
      // consume a fresh capability, and compare the complete committed fact
      // set before it may hand back the existing row.
      if (value['schema_version'] === 2) return null;
      const index = organizationRecordEnvelopeIndex(value);
      const row = this.log.findAcceptedRecord(
        index.installation_id,
        index.idempotency_key,
      );
      if (row === null) return null;
      const canonicalEnvelope = organizationRecordCanonicalEnvelope(value);
      const envelopeSha256 = sha256Digest(canonicalEnvelope);
      if (
        row.canonical_envelope !== canonicalEnvelope ||
        row.envelope_sha256 !== envelopeSha256
      ) {
        return null;
      }
      return row;
    } catch {
      return null;
    }
  }

  private async resultFor(
    outcome: 'appended' | 'duplicate',
    row: OrganizationRecordLogRow,
  ): Promise<OrganizationRecordAppendResult> {
    const receiptPayload = storedReceiptPayload(row);
    const signedReceipt = await this.materializeSignedReceipt(row);
    return {
      outcome,
      position: row.position,
      envelope_id: row.envelope_id,
      envelope_sha256: row.envelope_sha256,
      record_hash: row.record_hash,
      recorded_at: row.recorded_at,
      receipt_payload: receiptPayload,
      signed_receipt: signedReceipt,
    };
  }

  /**
   * The recoverable materialization seam. The receipt payload is already
   * durable, committed with the log row; only the signature is missing after a
   * crash in the narrow post-commit window. A retry materializes it from the
   * stored payload and appends nothing.
   */
  async materializeSignedReceipt(row: OrganizationRecordLogRow): Promise<JsonObject> {
    const stored = this.log.readSignedReceipt(row.position);
    if (stored !== null) return asJsonObject(parseCanonicalJson(stored), 'stored signed receipt is not a JSON object');

    let signed: JsonObject;
    try {
      signed = asJsonObject(
        await this.receiptSigner.signReceipt(storedReceiptPayload(row)),
        'receipt signing port returned a non-object document',
      );
      assertSignedReceiptBindsStoredPayload(signed, row);
    } catch (error) {
      this.alert?.({
        kind: 'receipt-materialization-failed',
        message: `organization record receipt at position ${row.position} could not be signed`,
        log_position: row.position,
        cause: error,
      });
      throw error;
    }
    const winner = this.log.putSignedReceipt(row.position, canonicalJson(signed), this.clock());
    return asJsonObject(parseCanonicalJson(winner), 'stored signed receipt is not a JSON object');
  }

  private nudge(): void {
    if (this.onAppended === null) return;
    try {
      this.onAppended();
    } catch (error) {
      // A scheduling failure must never fail an append that already committed.
      // The record is durable; the startup catch-up heals a missed nudge.
      this.alert?.({
        kind: 'derive-nudge-failed',
        message: 'organization record derive nudge failed after append',
        log_position: null,
        cause: error,
      });
    }
  }
}
