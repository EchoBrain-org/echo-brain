import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import type { JsonObject } from '@echo-brain/federation-protocol';
import type { OrganizationRecordRejectionCodeV1 } from '@echo-brain/organization-api';
import {
  isOrganizationProtocolValidationError,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordEnvelopeAnyVersion,
  OrganizationRecordEnvelopeV1,
  OrganizationRecordReceiptPayloadV1,
  OrganizationRecordReviewerApprovalEnvelopeV2,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityApplication,
  OrganizationRecordInstallationContext,
} from './organization-authority.js';
import { AuthorityOperationError } from '../domain/errors.js';

const ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE =
  'active_membership_direct_grant_pilot_notice_v1' as const;

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

/** Structural seam; the record package owns the durable marker/proof types. */
export interface OrganizationRecordPermissionPilotEligibilityProofView {
  readonly policy_id: 'pilot-member-readable-v1';
  readonly presentation_policy_id: 'pilot-two-person-audience-v1';
  readonly audience_notice_sha256: `sha256:${string}`;
  readonly message_presentation_sha256: `sha256:${string}`;
}

export interface OrganizationRecordPermissionPilotActivationView {
  readonly organization_id: string;
  readonly policy_id: 'pilot-member-readable-v1';
  readonly presentation_policy_id: 'pilot-two-person-audience-v1';
  readonly audience_notice_sha256: `sha256:${string}`;
}

/**
 * Startup-cached permission-pilot health. Unlike a nullable marker, this keeps
 * a clean pre-activation state distinct from a failed marker/index/audit
 * validation, so a frozen notice-qualified envelope can remain retryable.
 */
export type OrganizationRecordPermissionPilotHealthView =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'ready';
      readonly activation: OrganizationRecordPermissionPilotActivationView;
    }
  | { readonly kind: 'degraded'; readonly failure: Error };

/**
 * The closed reviewer proof one exact immutable audit row returned. It is
 * never constructed from client-signed fields: the control plane recomputes it
 * from stored columns and the fixed consequence before returning it.
 */
export interface OrganizationRecordReviewerRestrictedProofView {
  readonly policy_id: 'restricted-reviewer-v1';
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
  readonly reviewer_release_draft_sha256: `sha256:${string}`;
  readonly approval_presentation_sha256: `sha256:${string}`;
  readonly semantic_intent_sha256: `sha256:${string}`;
  readonly message_presentation_sha256: `sha256:${string}`;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: `sha256:${string}`;
  readonly evaluated_at: string;
}

export interface OrganizationRecordReviewerAuthorizationEvidenceView
  extends OrganizationRecordReviewerRestrictedProofView {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly installation_id: string;
  readonly approval_id: string;
  readonly request_id: string;
  readonly request_sha256: `sha256:${string}`;
  readonly provider_event_sha256: `sha256:${string}`;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
}

export interface OrganizationRecordIntegrationAuditChainView {
  readonly valid: boolean;
  readonly entries_verified: number;
  readonly head_sequence: number;
  readonly head_entry_sha256: `sha256:${string}` | null;
  readonly failure: string | null;
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
  verifyIntegrationAuditChain?(): OrganizationRecordIntegrationAuditChainView;

  readAllowedReviewerAuthorizationEvidenceById?(
    auditEventId: string,
  ):
    | {
        readonly status: 'matched';
        readonly evidence: OrganizationRecordReviewerAuthorizationEvidenceView;
      }
    | { readonly status: 'absent' | 'corrupt' | 'unavailable' };

  /**
   * The reviewer lookup is by exact primary key, never a descriptive scan, and
   * revalidates the stored entry hash and predecessor relation before matching
   * the closed proof. Healthy `absent`/`mismatch` is terminal invalid input;
   * `corrupt`/`unavailable` is retryable and degrades reviewer V1 only.
   */
  findAllowedReviewerAuthorizationEvidenceById(
    auditEventId: string,
    expected: {
      organization_id: string;
      installation_id: string;
      approval_id: string;
      request_id: string;
      principal_id: string;
      membership_id: string;
      request_sha256: string;
      provider_event_sha256: string;
      adapter_binding_id: string;
      permission_grant_id: string;
      evaluated_at: string;
      reviewer_release_draft_sha256: string;
      approval_presentation_sha256: string;
      semantic_intent_sha256: string;
      message_presentation_sha256: string;
      authorization_audit_entry_sha256: string;
    },
  ):
    | {
        readonly status: 'matched';
        readonly audit_entry_sha256: `sha256:${string}`;
        readonly proof: OrganizationRecordReviewerRestrictedProofView;
      }
    | { readonly status: 'absent' | 'mismatch' | 'corrupt' | 'unavailable' };

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
  }):
    | {
        readonly status: 'matched';
        readonly permission_pilot_eligibility?: OrganizationRecordPermissionPilotEligibilityProofView;
      }
    | { readonly status: 'absent' | 'ambiguous' | 'corrupt' };
}

/** The structural view `OrganizationRecordAuthorityPort` requires. */
export interface VerifiedOrganizationRecordEnvelopeView {
  readonly envelope: JsonObject;
  readonly envelope_id: string;
  readonly event_type: 'approval' | 'rejection';
  readonly envelope_schema_version: 1 | 2;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly permission_pilot_eligibility?: OrganizationRecordPermissionPilotEligibilityProofView;
  readonly reviewer_restricted_proof?: OrganizationRecordReviewerRestrictedProofView;
}

function isReviewerRestrictedEnvelope(
  envelope: OrganizationRecordEnvelopeAnyVersion,
): envelope is OrganizationRecordReviewerApprovalEnvelopeV2 {
  return envelope.schema_version === 2;
}

export interface OrganizationRecordIngestAuthorityOptions {
  readonly authority: Pick<
    OrganizationAuthorityApplication,
    'recordIngestInstallationContext' | 'verifyRecordEnvelope' | 'signRecordReceipt'
  >;
  readonly evidence: OrganizationRecordAuthorizationEvidenceStore;
  readonly permissionPilotHealth: OrganizationRecordPermissionPilotHealthView;
  readonly reviewerRestrictedHealth:
    | { readonly kind: 'ready' }
    | { readonly kind: 'degraded'; readonly failure: Error };
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
    if (isReviewerRestrictedEnvelope(envelope)) {
      if (this.options.reviewerRestrictedHealth.kind !== 'ready') {
        throw new AuthorityOperationError(
          'unavailable',
          'reviewer-restricted record ingest is temporarily unavailable',
        );
      }
      const proof = this.assertAuditedReviewerAuthorization(envelope, context);
      return {
        envelope: envelope as unknown as JsonObject,
        envelope_id: envelope.envelope_id,
        event_type: 'approval',
        envelope_schema_version: 2,
        idempotency_key: envelope.idempotency_key,
        installation_id: envelope.submitter.installation_id,
        reviewer_restricted_proof: proof,
      };
    }
    const permissionPilotEligibility = this.assertAuditedAuthorization(
      envelope,
      context,
    );
    return {
      envelope: envelope as unknown as JsonObject,
      envelope_id: envelope.envelope_id,
      event_type: envelope.event_type,
      envelope_schema_version: 1,
      idempotency_key: envelope.idempotency_key,
      installation_id: envelope.submitter.installation_id,
      ...(permissionPilotEligibility === undefined
        ? {}
        : { permission_pilot_eligibility: permissionPilotEligibility }),
    };
  }

  /**
   * The reviewer path never trusts the client-signed proof fields. It looks up
   * the one immutable audit row by its exact `aud_*` primary key, requires the
   * control plane's recomputed entry hash and closed proof to equal every
   * signed commitment, and only then admits the envelope.
   */
  private assertAuditedReviewerAuthorization(
    envelope: OrganizationRecordReviewerApprovalEnvelopeV2,
    context: OrganizationRecordInstallationContext,
  ): OrganizationRecordReviewerRestrictedProofView {
    const evidence = envelope.reviewer.authorization;
    const match =
      this.options.evidence.findAllowedReviewerAuthorizationEvidenceById(
        evidence.authorization_audit_event_id,
        {
          organization_id: context.organization_id,
          installation_id: context.installation_id,
          approval_id: evidence.approval_id,
          request_id: evidence.request_id,
          principal_id: evidence.principal_id,
          membership_id: evidence.membership_id,
          request_sha256: evidence.request_sha256,
          provider_event_sha256: evidence.provider_event_sha256,
          adapter_binding_id: evidence.adapter_binding_id,
          permission_grant_id: evidence.permission_grant_id,
          evaluated_at: evidence.evaluated_at,
          reviewer_release_draft_sha256:
            evidence.reviewer_release_draft_sha256,
          approval_presentation_sha256: evidence.approval_presentation_sha256,
          semantic_intent_sha256: evidence.semantic_intent_sha256,
          message_presentation_sha256: evidence.message_presentation_sha256,
          authorization_audit_entry_sha256:
            evidence.authorization_audit_entry_sha256,
        },
      );
    if (match.status === 'corrupt' || match.status === 'unavailable') {
      throw new AuthorityOperationError(
        'unavailable',
        'organization reviewer authorization evidence is temporarily unavailable',
      );
    }
    if (match.status !== 'matched') {
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        'record authorization evidence matches no audited allowed reviewer evaluation',
      );
    }
    if (
      match.audit_entry_sha256 !== evidence.authorization_audit_entry_sha256 ||
      match.proof.reviewer_principal_id !== envelope.reviewer.principal_id ||
      match.proof.reviewer_membership_id !== envelope.reviewer.membership_id ||
      match.proof.evaluated_at !== evidence.evaluated_at
    ) {
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        'record authorization reviewer proof does not match the audited evaluation',
      );
    }
    return match.proof;
  }

  signReceipt(payload: OrganizationRecordReceiptPayloadV1): Promise<JsonObject> {
    return this.options.authority
      .signRecordReceipt(payload)
      .then((receipt) => receipt as unknown as JsonObject);
  }

  private validate(
    value: unknown,
    context: OrganizationRecordInstallationContext,
  ): OrganizationRecordEnvelopeAnyVersion {
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
    envelope: OrganizationRecordEnvelopeAnyVersion,
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
   * frozen field is matched against one allowed row. Ordinary evidence that is
   * absent or ambiguous is terminally invalid. Notice-qualified evidence stays
   * retryable when its audit proof cannot be established: permanently rejecting
   * the already-frozen envelope would lose a record because of Authority-owned
   * pilot state or audit availability.
   */
  private assertAuditedAuthorization(
    envelope: OrganizationRecordEnvelopeV1,
    context: OrganizationRecordInstallationContext,
  ): OrganizationRecordPermissionPilotEligibilityProofView | undefined {
    const evidence = envelope.reviewer.authorization;
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
    const noticeQualified =
      evidence.reason_code ===
      ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE;
    if (match.status !== 'matched') {
      if (noticeQualified) {
        throw new AuthorityOperationError(
          'unavailable',
          'organization permission pilot authorization evidence is temporarily unavailable',
        );
      }
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        match.status === 'ambiguous'
          ? 'record authorization evidence matches more than one audited evaluation'
          : 'record authorization evidence matches no audited allowed evaluation',
      );
    }
    const proof = match.permission_pilot_eligibility;
    if (proof === undefined) {
      if (noticeQualified) {
        throw new AuthorityOperationError(
          'unavailable',
          'organization permission pilot authorization evidence is incomplete',
        );
      }
      return undefined;
    }
    const health = this.options.permissionPilotHealth;
    if (health.kind !== 'ready') {
      throw new AuthorityOperationError(
        'unavailable',
        'organization permission pilot activation is temporarily unavailable',
      );
    }
    const activation = health.activation;
    if (
      activation.organization_id !== context.organization_id ||
      proof.policy_id !== activation.policy_id ||
      proof.presentation_policy_id !== activation.presentation_policy_id ||
      proof.audience_notice_sha256 !== activation.audience_notice_sha256
    ) {
      throw new OrganizationRecordIngestRejectionError(
        'record_authorization_invalid',
        'record authorization notice proof does not match the active permission pilot',
      );
    }
    return proof;
  }
}
