import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import type { JsonObject } from '@echo-brain/federation-protocol';
import type { OrganizationRecordRejectionCodeV1 } from '@echo-brain/organization-api';
import {
  isOrganizationProtocolValidationError,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordEnvelopeV1,
  OrganizationRecordReceiptPayloadV1,
  OrganizationRecordReviewerAuthorizationV1,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityApplication,
  OrganizationRecordInstallationContext,
} from './organization-authority.js';

/**
 * A terminal ingest outcome the member files as a permanent rejection.
 *
 * Everything that is *not* one of these — an expired lease, a revoked
 * installation, a transport fault — stays an `AuthorityOperationError` and
 * reaches the member as a retryable code, because the design's whole retry
 * contract is "expired lease → submitter refreshes and retries".
 */
export class OrganizationRecordIngestRejectionError extends Error {
  readonly code: OrganizationRecordRejectionCodeV1;

  constructor(code: OrganizationRecordRejectionCodeV1, message: string) {
    super(message);
    this.name = 'OrganizationRecordIngestRejectionError';
    this.code = code;
  }
}

/**
 * The read-only view of the Authority's existing integration audit.
 *
 * Structural on purpose: the control plane owns the table and the query, the
 * application layer owns the rule that ingest requires a matching row. No
 * control-plane table is added for records — the permission evaluation that
 * produced the evidence is already an appended, immutable audit row.
 */
export interface OrganizationRecordAuthorizationEvidenceStore {
  findAllowedApprovalAuthorizationEvidence(input: {
    organization_id: string;
    installation_id: string;
    approval_id: string;
    action: 'approve' | 'reject';
    request_id: string;
    principal_id: string;
    membership_id: string;
    request_sha256: string;
    provider_event_sha256: string;
    adapter_binding_id: string;
    permission_grant_id: string;
    reason_code: string;
    evaluated_at: string;
  }): { readonly status: 'matched' | 'absent' | 'ambiguous' };
}

/** The structural view `OrganizationRecordAuthorityPort` requires. */
export interface VerifiedOrganizationRecordEnvelopeView {
  readonly envelope: JsonObject;
  readonly envelope_id: string;
  readonly event_type: 'approval' | 'rejection';
  readonly idempotency_key: string;
  readonly installation_id: string;
}

export interface OrganizationRecordIngestAuthorityOptions {
  readonly authority: Pick<
    OrganizationAuthorityApplication,
    'recordIngestInstallationContext' | 'verifyRecordEnvelope' | 'signRecordReceipt'
  >;
  readonly evidence: OrganizationRecordAuthorizationEvidenceStore;
}

function installationIdOf(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrganizationRecordIngestRejectionError(
      'record_envelope_invalid',
      'record envelope is not a JSON object',
    );
  }
  const submitter = (value as Record<string, unknown>)['submitter'];
  const installationId =
    submitter !== null && typeof submitter === 'object' && !Array.isArray(submitter)
      ? (submitter as Record<string, unknown>)['installation_id']
      : undefined;
  if (typeof installationId !== 'string' || installationId === '') {
    throw new OrganizationRecordIngestRejectionError(
      'record_envelope_invalid',
      'record envelope names no submitting installation',
    );
  }
  return installationId;
}

/**
 * Verify, in the order the design fixes: current access lease, installation
 * signature over the canonical bytes, envelope and payload schema validation,
 * then the exact allowed authorization-evidence lookup in the existing
 * integration audit.
 *
 * The installation is resolved from the envelope's own `submitter` before
 * anything else is trusted, because the signing key that authenticates the
 * rest of the document comes from that enrollment row.
 */
export class OrganizationRecordIngestAuthority {
  constructor(private readonly options: OrganizationRecordIngestAuthorityOptions) {}

  async verifyEnvelope(value: unknown): Promise<VerifiedOrganizationRecordEnvelopeView> {
    const claimedInstallationId = installationIdOf(value);
    // Throws `unauthorized` (retryable) when the lease expired or the
    // installation was revoked; never a permanent rejection.
    const context =
      this.options.authority.recordIngestInstallationContext(
        claimedInstallationId,
      );
    const envelope = this.validate(value, context);
    this.assertEnrolledSubmitter(envelope, context);
    this.assertAuditedAuthorization(envelope, context);
    return {
      envelope: envelope as unknown as JsonObject,
      envelope_id: envelope.envelope_id,
      event_type: envelope.event_type,
      idempotency_key: envelope.idempotency_key,
      installation_id: envelope.submitter.installation_id,
    };
  }

  signReceipt(payload: OrganizationRecordReceiptPayloadV1): Promise<JsonObject> {
    return this.options.authority
      .signRecordReceipt(payload)
      .then((receipt) => receipt as unknown as JsonObject);
  }

  private validate(
    value: unknown,
    context: OrganizationRecordInstallationContext,
  ): OrganizationRecordEnvelopeV1 {
    try {
      return this.options.authority.verifyRecordEnvelope(
        value,
        context.installation_signing_key,
      );
    } catch (error) {
      // Schema and signature failures are both permanent, and they are told
      // apart by which check the protocol package failed: validation runs to
      // completion before any signature is verified.
      if (isOrganizationProtocolValidationError(error)) {
        throw this.validationRejection(value);
      }
      throw new OrganizationRecordIngestRejectionError(
        'record_signature_invalid',
        'record envelope signature or authority binding is invalid',
      );
    }
  }

  /**
   * Classifies the protocol validator's size failure without making every
   * valid ingest canonicalize twice. The route's raw-body cap is a separate,
   * earlier limit on wire bytes.
   */
  private validationRejection(
    value: unknown,
  ): OrganizationRecordIngestRejectionError {
    try {
      if (
        canonicalJsonBytes(value).length >
        MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES
      ) {
        return new OrganizationRecordIngestRejectionError(
          'record_envelope_too_large',
          `record envelope must be at most ${MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES} canonical bytes`,
        );
      }
    } catch {
      return new OrganizationRecordIngestRejectionError(
        'record_envelope_invalid',
        'record envelope is not canonicalizable JSON',
      );
    }
    return new OrganizationRecordIngestRejectionError(
      'record_envelope_invalid',
      'record envelope failed schema validation',
    );
  }

  /**
   * The machine binding, and only the machine binding.
   *
   * Submitter, evidence authority, organization, enrollment, and installation
   * must all name the enrollment row this request authenticated against — that
   * is what proves the signing key is this machine's. The reviewer is
   * deliberately not compared to the installation owner: an approval surface
   * is a shared organization channel, so any authorized member may be the
   * approver of a decision a colleague's machine submits. The reviewer's own
   * identity is bound twice elsewhere and needs no third rule here — the
   * protocol validator pins `reviewer.principal_id`/`membership_id` to the
   * carried evidence, and `assertAuditedAuthorization` pins that evidence to
   * one exact allowed audit row for this organization and installation.
   */
  private assertEnrolledSubmitter(
    envelope: OrganizationRecordEnvelopeV1,
    context: OrganizationRecordInstallationContext,
  ): void {
    const evidence = envelope.reviewer.authorization;
    if (
      envelope.submitter.installation_id !== context.installation_id ||
      evidence.installation_id !== context.installation_id ||
      evidence.enrollment_id !== context.enrollment_id ||
      evidence.organization_id !== context.organization_id ||
      evidence.authority_id !== context.authority_id
    ) {
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        'record envelope does not bind this enrolled installation',
      );
    }
  }

  /**
   * The evidence is only worth what the Authority's own audit says. Every
   * frozen field is matched against one allowed row; absent and ambiguous both
   * deny, because "some row might be this evaluation" authorizes nothing.
   */
  private assertAuditedAuthorization(
    envelope: OrganizationRecordEnvelopeV1,
    context: OrganizationRecordInstallationContext,
  ): void {
    const evidence: OrganizationRecordReviewerAuthorizationV1 =
      envelope.reviewer.authorization;
    const match = this.options.evidence.findAllowedApprovalAuthorizationEvidence({
      organization_id: context.organization_id,
      installation_id: context.installation_id,
      approval_id: evidence.approval_id,
      action: evidence.action,
      request_id: evidence.request_id,
      principal_id: evidence.principal_id,
      membership_id: evidence.membership_id,
      request_sha256: evidence.request_sha256,
      provider_event_sha256: evidence.provider_event_sha256,
      adapter_binding_id: evidence.adapter_binding_id,
      permission_grant_id: evidence.permission_grant_id,
      reason_code: evidence.reason_code,
      evaluated_at: evidence.evaluated_at,
    });
    if (match.status !== 'matched') {
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        match.status === 'ambiguous'
          ? 'record authorization evidence matches more than one audited evaluation'
          : 'record authorization evidence matches no audited allowed evaluation',
      );
    }
  }
}
