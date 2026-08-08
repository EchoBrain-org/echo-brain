import type { JsonObject } from '@echo-brain/federation-protocol';

/**
 * Narrow local ports for the member-side organization record submitter.
 *
 * The durable signed shapes (both envelope types and the receipt) belong in
 * `packages/organization-protocol`, and the route DTOs belong in
 * `packages/organization-api`. The submitter depends on local structural ports
 * so the envelope builder and record client stay injected without reversing
 * either package boundary.
 *
 * The same restatement discipline the design applies to the payload schema
 * applies here: shapes are pinned by tests against their counterparts rather
 * than shared through code across a boundary that must stay one-directional.
 */

/** Where a decision came from, as persisted on the requested slot. */
export interface OrganizationRecordSourceLocator {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly external_id: string;
}

export type OrganizationRecordEventType = 'approval' | 'rejection';

/**
 * The authority-verified authorization evidence already stored on the resolved
 * slot by the Slack approval surface. Organization ingest requires it: a node
 * resolved before enrollment, or otherwise without evidence, is skipped with an
 * operator alert and never silently downgraded.
 *
 * The whole allow decision travels, not a summary of it. The request and
 * provider-event digests bind the evidence to the exact signed permission check
 * the Authority evaluated, and the binding and grant ids are its attribution;
 * dropping any of them would leave the Authority's pre-append audit lookup
 * unable to match the evidence it is asked to confirm.
 */
export interface OrganizationRecordAuthorizationEvidence {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-authorization-evidence';
  readonly authority_id: string;
  readonly organization_id: string;
  readonly enrollment_id: string;
  readonly installation_id: string;
  readonly request_id: string;
  readonly approval_id: string;
  readonly action: OrganizationRecordAction;
  readonly request_sha256: string;
  readonly provider_event_sha256: string;
  readonly allowed: true;
  readonly reason_code: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
  readonly evaluated_at: string;
}

export type OrganizationRecordAction = 'approve' | 'reject';

export interface OrganizationRecordEnvelopeBuildInput {
  readonly event_type: OrganizationRecordEventType;
  /** The sha256 approval id; also the envelope's idempotency key. */
  readonly approval_id: string;
  readonly source: OrganizationRecordSourceLocator;
  readonly meeting_id: string;
  /** The exact approved brief. Null for rejection events, which carry no brief content. */
  readonly brief: unknown;
  readonly alternatives: readonly JsonObject[];
  readonly links: {
    readonly parent: string | null;
    readonly supersedes: string | null;
  };
  readonly reviewed_at: string;
  /** Display-only; the verified principal in the evidence is the identity of record. */
  readonly reviewed_by: string;
  /** Organization-visible rejection reason, or null. */
  readonly reason: string | null;
  readonly surface: string;
  readonly authorization: OrganizationRecordAuthorizationEvidence;
  readonly submitted_at: string;
}

/** The built, installation-signed envelope before the submitter freezes it. */
export interface BuiltOrganizationRecordEnvelope {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly event_type: OrganizationRecordEventType;
  readonly envelope: JsonObject;
}

export interface OrganizationRecordEnvelopeBuilder {
  build(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope>;
}

export interface OrganizationRecordSubmission {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly envelope_sha256: string;
  readonly envelope: JsonObject;
}

/**
 * The `signed-document` integrity block as it travels with the receipt.
 * Restated with plain string digests rather than importing `SignedIntegrity`
 * so the durable local restatement and this port stay assignable in both
 * directions; `SignedIntegrity` itself is pinned as assignable to this shape.
 */
export interface OrganizationRecordReceiptIntegrity {
  readonly canonicalization: 'RFC8785';
  readonly payload_sha256: string;
  readonly signature_algorithm: 'ecdsa-p256-sha256-der-low-s';
  readonly key_id: string;
  readonly signature_base64: string;
}

/**
 * The authority-signed append receipt, carried whole. Implementations must
 * verify the authority signature against the pinned descriptor before
 * returning it; the submitter additionally proves the receipt binds this
 * installation and these exact envelope bytes before filing it.
 *
 * The integrity block travels with the receipt and is stored with it: a member
 * holding only unsigned fields could not later present the receipt as evidence
 * against the org log, which is the whole tamper-evidence mechanism. Key
 * identity lives in `integrity.key_id`; there is deliberately no second
 * top-level copy of it to disagree with.
 */
export interface VerifiedOrganizationRecordReceipt {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-record-receipt';
  readonly authority_id: string;
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly envelope_sha256: string;
  readonly installation_id: string;
  readonly idempotency_key: string;
  readonly position: number;
  readonly record_hash: string;
  readonly recorded_at: string;
  readonly integrity: OrganizationRecordReceiptIntegrity;
}

/**
 * Three outcomes, deliberately: only `rejected` is terminal and permanent.
 * `retry` covers transient transport and lease-refresh failures, which create
 * no terminal slot and are picked up by the next sweep with the same bytes.
 */
export type OrganizationRecordSubmissionResult =
  | { readonly outcome: 'accepted'; readonly receipt: VerifiedOrganizationRecordReceipt }
  | {
      readonly outcome: 'rejected';
      readonly reason_code: string;
      readonly reason: string;
    }
  | { readonly outcome: 'retry'; readonly reason: string };

export interface OrganizationRecordClient {
  submitRecord(
    submission: OrganizationRecordSubmission,
    signal?: AbortSignal,
  ): Promise<OrganizationRecordSubmissionResult>;
}

/** The frozen outbound envelope as the decision node store holds it. */
export interface OrganizationRecordFrozenEnvelope {
  readonly record_event_type: OrganizationRecordEventType;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly envelope_sha256: string;
  readonly envelope: JsonObject;
}

export type OrganizationRecordNodeStatus =
  | 'unresolved'
  | 'pending'
  | 'outbound'
  | 'published'
  | 'rejected';

/**
 * The subset of a decision node the submitter reads. `DecisionNodeStore`
 * satisfies this structurally; the approval layer never learns the
 * organization protocol and this module never reaches into local storage.
 */
export interface OrganizationRecordCandidateNode {
  readonly approval_id: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly reason: string | null;
  readonly resolved_surface: string | null;
  readonly resolved_metadata: JsonObject | null;
  readonly brief: { readonly meeting: { readonly id: string } };
  readonly alternatives: readonly JsonObject[];
  readonly links: {
    readonly parent: string | null;
    readonly supersedes: string | null;
  };
  readonly source: OrganizationRecordSourceLocator | null;
  readonly organization_record: {
    readonly status: OrganizationRecordNodeStatus;
    readonly envelope: OrganizationRecordFrozenEnvelope | null;
  };
}

export interface OrganizationRecordNodeSkip {
  readonly approval_id: string;
  readonly reason: string;
  readonly detail: string;
}

export interface OrganizationRecordNodeListing {
  readonly nodes: readonly OrganizationRecordCandidateNode[];
  readonly skipped: readonly OrganizationRecordNodeSkip[];
}

export interface OrganizationRecordNodeStore {
  listForSubmission(): Promise<OrganizationRecordNodeListing>;
  createOrganizationRecordEnvelope(input: {
    approvalId: string;
    recordEventType: OrganizationRecordEventType;
    envelopeId: string;
    idempotencyKey: string;
    envelopeSha256: string;
    envelope: JsonObject;
  }): Promise<OrganizationRecordFrozenEnvelope>;
  recordOrganizationRecordReceipt(input: {
    approvalId: string;
    receipt: VerifiedOrganizationRecordReceipt;
  }): Promise<unknown>;
  recordOrganizationRecordRejection(input: {
    approvalId: string;
    reasonCode: string;
    reason: string;
  }): Promise<unknown>;
}
