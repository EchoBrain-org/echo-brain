import {
  parseOrganizationRecordEnvelope,
} from '@echo-brain/organization-record';
import {
  verifyOrganizationMemberFactAdmission,
} from '@echo-brain/organization-record/maintenance';
import {
  validateOrganizationRecordOrganizationMemberApprovalEnvelope,
} from '@echo-brain/organization-protocol';
import type { OrganizationMemberReadableEnvelopeValidator } from '@echo-brain/organization-record/append';
import type { OrganizationRecordAuthorizationEvidenceStore } from '../application/organization-record-ingest.js';
import {
  isOrganizationMemberReadableRecordingPolicy,
  type OrganizationRecordingPolicyV1,
} from '../application/organization-recording-policy.js';

type RecordLogDatabase = Parameters<typeof verifyOrganizationMemberFactAdmission>[0];

export interface OrganizationMemberReadableReadiness {
  readonly ready: boolean;
  readonly organization_member_records_verified: number;
  readonly organization_member_facts_verified: number;
  readonly audit_rows_revalidated: number;
  readonly failures: readonly { readonly log_position: number | null; readonly detail: string }[];
}

/**
 * Coordinates record's pure v3 fact admission with Authority's exact-ID audit
 * reproof. Neither half alone is sufficient to admit schema-v3 ingest.
 */
export function verifyOrganizationMemberReadableReadiness(input: {
  readonly database: RecordLogDatabase;
  readonly organization_id: string;
  readonly validator: OrganizationMemberReadableEnvelopeValidator;
  readonly evidence: OrganizationRecordAuthorizationEvidenceStore;
  readonly organization_recording_policy_v1?: OrganizationRecordingPolicyV1;
}): OrganizationMemberReadableReadiness {
  const admission = verifyOrganizationMemberFactAdmission(input.database, {
    organization_id: input.organization_id,
    validator: input.validator,
  });
  const failures: { log_position: number | null; detail: string }[] = admission.failures.map((failure) => Object.freeze({
    log_position: failure.position,
    detail: `log facts: ${failure.detail}`,
  }));
  const lookup = input.evidence.findAllowedOrganizationMemberAuthorizationEvidenceById;
  const verifyChain = input.evidence.verifyIntegrationAuditChain;
  if (lookup === undefined || verifyChain === undefined) {
    failures.push(Object.freeze({ log_position: null, detail: 'organization-member audit reproof is unavailable' }));
  } else {
    const chain = verifyChain.call(input.evidence);
    if (!chain.valid) {
      failures.push(Object.freeze({ log_position: null, detail: chain.failure ?? 'organization-member integration audit chain is invalid' }));
    }
  }
  let audit_rows_revalidated = 0;
  if (admission.admitted && lookup !== undefined) {
    const rows = input.database.prepare(
      `SELECT position, canonical_envelope
       FROM organization_record_log
       WHERE json_valid(canonical_envelope)
         AND json_extract(canonical_envelope, '$.kind') = 'echo-organization-record-envelope'
         AND json_extract(canonical_envelope, '$.schema_version') = 3
       ORDER BY position`,
    ).all() as { position: number; canonical_envelope: string }[];
    const policy = input.organization_recording_policy_v1;
    if (
      rows.length > 0 &&
      !isOrganizationMemberReadableRecordingPolicy(policy)
    ) {
      failures.push(Object.freeze({
        log_position: null,
        detail: 'organization-member records exist without an active effective recording policy',
      }));
    }
    for (const row of rows) {
      try {
        const envelope = validateOrganizationRecordOrganizationMemberApprovalEnvelope(
          parseOrganizationRecordEnvelope(row.canonical_envelope),
        );
        if (!isOrganizationMemberReadableRecordingPolicy(policy)) continue;
        const evidence = envelope.reviewer.authorization;
        const match = lookup.call(input.evidence, evidence.authorization_audit_event_id, {
          organization_id: input.organization_id,
          installation_id: envelope.submitter.installation_id,
          approval_id: evidence.approval_id,
          request_id: evidence.request_id,
          principal_id: evidence.principal_id,
          membership_id: evidence.membership_id,
          request_sha256: evidence.request_sha256,
          provider_event_sha256: evidence.provider_event_sha256,
          adapter_binding_id: evidence.adapter_binding_id,
          adapter_instance_id: policy.approval_surface_adapter_instance_id,
          permission_grant_id: evidence.permission_grant_id,
          evaluated_at: evidence.evaluated_at,
          policy_contract_sha256: evidence.policy_contract_sha256,
          release_draft_sha256: evidence.release_draft_sha256,
          approval_presentation_sha256: evidence.approval_presentation_sha256,
          semantic_intent_sha256: evidence.semantic_intent_sha256,
          message_presentation_sha256: evidence.message_presentation_sha256,
          authorization_audit_entry_sha256: evidence.authorization_audit_entry_sha256,
        });
        if (match.status !== 'matched' ||
          match.audit_entry_sha256 !== evidence.authorization_audit_entry_sha256 ||
          match.adapter_instance_id !== policy.approval_surface_adapter_instance_id) {
          failures.push(Object.freeze({
            log_position: row.position,
            detail: `organization-member audit ${evidence.authorization_audit_event_id} is ${match.status}`,
          }));
        } else {
          audit_rows_revalidated += 1;
        }
      } catch (error) {
        failures.push(Object.freeze({
          log_position: row.position,
          detail: error instanceof Error ? error.message : 'organization-member audit reproof failed',
        }));
      }
    }
  }
  return Object.freeze({
    ready: failures.length === 0,
    organization_member_records_verified: admission.records_verified,
    organization_member_facts_verified: admission.facts_verified,
    audit_rows_revalidated,
    failures: Object.freeze(failures),
  });
}
