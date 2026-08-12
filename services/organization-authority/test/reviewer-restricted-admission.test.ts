import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
  type JsonObject,
} from '@echo-brain/organization-record';
import {
  OrganizationRecordLogStore,
  projectReviewerPolicyFacts,
  readReviewerRestrictedEnvelope,
  verifyReviewerFactAdmission,
} from '@echo-brain/organization-record/maintenance';
import {
  projectReviewerReleaseDraft,
  reviewerReleaseDraftSha256,
} from '@echo-brain/organization-protocol';
import { verifyReviewerRestrictedReadiness } from '../src/composition/reviewer-restricted-admission.js';
import { reviewerRestrictedEnvelopeValidator } from '../src/composition/reviewer-envelope-validator.js';
import type { OrganizationRecordAuthorizationEvidenceStore } from '../src/application/organization-record-ingest.js';

/**
 * The Authority half of log-fact integrity admission. The record package
 * proves structure and reprojection; this suite proves that Authority
 * independently re-queries each exact audit row and that any absent, corrupt,
 * or mismatched evidence holds reviewer reads closed with no repair offered.
 */

/**
 * These are the durable identifier forms the closed protocol validator
 * requires. This suite runs the real
 * `validateOrganizationRecordReviewerApprovalEnvelope` through the same
 * composition adapter production uses, so the fixture has to be a genuinely
 * admissible reviewer-v2 document rather than a stand-in.
 */
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const ENROLLMENT_ID = 'enr_00000000-0000-4000-8000-000000000001';
const REVIEWER_PRINCIPAL = 'prn_00000000-0000-4000-8000-000000000001';
const REVIEWER_MEMBERSHIP = 'mem_00000000-0000-4000-8000-000000000001';
const BINDING_ID = 'bnd_00000000-0000-4000-8000-000000000001';
const GRANT_ID = 'pgr_00000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'pcr_00000000-0000-4000-8000-000000000001';
const AUDIT_EVENT_ID = 'aud_00000000-0000-4000-8000-000000000001';
const ENVELOPE_ID = 'rec_00000000-0000-4000-8000-000000000001';
const EVALUATED_AT = '2026-08-11T12:00:00.000Z';
const APPROVAL_ID = 'd'.repeat(64);

const digest = (seed: string): `sha256:${string}` => canonicalSha256(seed);

/** Canonical base64 the structural integrity check accepts. */
const SIGNATURE_BASE64 = Buffer.from('r'.repeat(64)).toString('base64');

const directories: string[] = [];

/** The exact organization/authority binding the composition adapter closes over. */
const reviewerValidator = reviewerRestrictedEnvelopeValidator({
  organization_id: ORGANIZATION_ID,
  authority_id: AUTHORITY_ID,
});

const REVIEWER_BRIEF = {
  schema_version: 1,
  id: 'brief_admission',
  meeting: {
    id: 'mtg_admission',
    title: 'Pricing',
    participants: [{ id: 'participant-1' }],
  },
  decisions: [
    {
      id: 'signal-decision-1',
      kind: 'decision',
      text: 'Ship the pilot.',
      subject: null,
      confidence: null,
      evidence: [{ meeting_id: 'mtg_admission', block_id: 'b1' }],
      status: 'decided',
    },
  ],
  actions: [],
  rationales: [],
  provenance: {
    meeting_revision: 'rev-1',
    processor: {
      kind: 'decision-processor',
      adapter_id: 'structured-text',
      instance_id: 'default',
      version: '1.0.0',
    },
    generated_at: '2026-08-11T11:00:00.000Z',
  },
} as const;

/** The frozen draft digest the closed validator recomputes from the payload. */
const RELEASE_DRAFT_SHA256 = reviewerReleaseDraftSha256(
  projectReviewerReleaseDraft({
    approval_id: APPROVAL_ID,
    brief: REVIEWER_BRIEF,
  }),
);

function reviewerEnvelope(): JsonObject {
  const semantic = digest('semantic-intent');
  return {
    schema_version: 2,
    kind: 'echo-organization-record-envelope',
    event_type: 'approval',
    envelope_id: ENVELOPE_ID,
    idempotency_key: APPROVAL_ID,
    payload: {
      brief: REVIEWER_BRIEF,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'granola-admission-1',
      },
      alternatives: [],
      links: null,
      reviewed_at: EVALUATED_AT,
      surface: 'slack-reviewer-v1',
    },
    reviewer: {
      principal_id: REVIEWER_PRINCIPAL,
      membership_id: REVIEWER_MEMBERSHIP,
      reviewed_by: 'Reviewer One',
      authorization: {
        schema_version: 2,
        kind: 'echo-organization-authorization-evidence',
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        enrollment_id: ENROLLMENT_ID,
        installation_id: INSTALLATION_ID,
        request_id: REQUEST_ID,
        approval_id: APPROVAL_ID,
        action: 'approve',
        request_sha256: digest('request'),
        provider_event_sha256: digest('provider-event'),
        allowed: true,
        reason_code: 'active_reviewer_restricted_notice_v1',
        principal_id: REVIEWER_PRINCIPAL,
        membership_id: REVIEWER_MEMBERSHIP,
        adapter_binding_id: BINDING_ID,
        permission_grant_id: GRANT_ID,
        evaluated_at: EVALUATED_AT,
        authorization_audit_event_id: AUDIT_EVENT_ID,
        authorization_audit_entry_sha256: digest('audit-entry'),
        reviewer_release_draft_sha256: RELEASE_DRAFT_SHA256,
        approval_presentation_sha256: digest('approval-presentation'),
        semantic_intent_sha256: semantic,
        message_presentation_sha256: digest('message-presentation'),
      },
    },
    intent: {
      schema_version: 1,
      visibility: 'restricted',
      policy_id: 'restricted-reviewer-v1',
      provenance: {
        kind: 'approval-surface-confirmation-v1',
        semantic_intent_sha256: semantic,
      },
    },
    submitter: {
      installation_id: INSTALLATION_ID,
      submitted_at: '2026-08-11T12:00:01.000Z',
    },
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'ab'.repeat(32)}`,
      signature_base64: SIGNATURE_BASE64,
    },
  } as unknown as JsonObject;
}

function openLogWithReviewerRecord(): OrganizationRecordLogStore {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-admission-'));
  directories.push(directory);
  const log = OrganizationRecordLogStore.open(
    join(directory, 'record-log.sqlite'),
    { organization_id: ORGANIZATION_ID, authority_id: AUTHORITY_ID },
  );
  writeReviewerRecord(log, true);
  return log;
}

/**
 * Writes one reviewer record and, optionally, its facts.
 *
 * Authority cannot mint an eligibility capability: the channel is not on the
 * record package's public entry point, precisely so no composition outside
 * that workspace can authorize a reviewer append. This suite therefore writes
 * the committed state directly, which is also what a restore hands Authority.
 */
function writeReviewerRecord(
  log: OrganizationRecordLogStore,
  withFacts: boolean,
): void {
  const envelope = reviewerEnvelope();
  const view = readReviewerRestrictedEnvelope(envelope, reviewerValidator);
  const canonical = canonicalJson(envelope);
  const envelopeSha256 = canonicalSha256(envelope);
  const recordedAt = '2026-08-11T12:00:02.000Z';
  const recordHash = organizationRecordHash(
    organizationRecordFrame({
      organization_id: ORGANIZATION_ID,
      position: 1,
      previous_record_hash: null,
      recorded_at: recordedAt,
      envelope_sha256: envelopeSha256,
    }),
  );
  log.database
    .prepare(
      `INSERT INTO organization_record_log (
         position, envelope_id, event_type, installation_id, idempotency_key,
         canonical_envelope, envelope_sha256, receipt_payload,
         previous_record_hash, record_hash, recorded_at
       ) VALUES (1, ?, 'approval', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      view.envelope_id,
      view.installation_id,
      view.idempotency_key,
      canonical,
      envelopeSha256,
      canonicalJson(
        organizationRecordReceiptPayload({
          authority_id: AUTHORITY_ID,
          organization_id: ORGANIZATION_ID,
          envelope_id: view.envelope_id,
          envelope_sha256: envelopeSha256,
          installation_id: view.installation_id,
          idempotency_key: view.idempotency_key,
          position: 1,
          record_hash: recordHash,
          recorded_at: recordedAt,
        }),
      ),
      recordHash,
      recordedAt,
    );
  if (!withFacts) return;
  const insert = log.database.prepare(
    `INSERT INTO organization_record_reviewer_policy_fact (
       reviewer_principal_id, reviewer_membership_id, log_position,
       record_hash, atom_order, signal_id_sha256, atom_id,
       semantic_intent_sha256, authorization_audit_event_id,
       authorization_audit_entry_sha256, authorization_proof_sha256
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const fact of projectReviewerPolicyFacts({
    envelope: view,
    log_position: 1,
    record_hash: recordHash,
    organization_id: ORGANIZATION_ID,
    canonical_envelope_sha256: envelopeSha256,
  })) {
    insert.run(
      fact.reviewer_principal_id,
      fact.reviewer_membership_id,
      fact.log_position,
      fact.record_hash,
      fact.atom_order,
      fact.signal_id_sha256,
      fact.atom_id,
      fact.semantic_intent_sha256,
      fact.authorization_audit_event_id,
      fact.authorization_audit_entry_sha256,
      fact.authorization_proof_sha256,
    );
  }
}

function readiness(
  log: OrganizationRecordLogStore,
  readEvidence: NonNullable<
    OrganizationRecordAuthorizationEvidenceStore['readAllowedReviewerAuthorizationEvidenceById']
  >,
  chainValid = true,
) {
  return verifyReviewerRestrictedReadiness({
    records: {
      verifyFactAdmission: () =>
        verifyReviewerFactAdmission(log.database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: reviewerValidator,
        }),
      openSession: () => {
        throw new Error('not used by startup admission');
      },
    },
    evidence: {
      verifyIntegrationAuditChain: () => ({
        valid: chainValid,
        entries_verified: chainValid ? 1 : 0,
        head_sequence: chainValid ? 1 : 0,
        head_entry_sha256: chainValid ? digest('audit-entry') : null,
        failure: chainValid ? null : 'audit chain mismatch',
      }),
      readAllowedReviewerAuthorizationEvidenceById: readEvidence,
    } as OrganizationRecordAuthorizationEvidenceStore,
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
  });
}

function matchedEvidence(
  overrides: Record<string, unknown> = {},
): NonNullable<
  OrganizationRecordAuthorizationEvidenceStore['readAllowedReviewerAuthorizationEvidenceById']
> {
  return vi.fn(() => ({
    status: 'matched' as const,
    evidence: {
      policy_id: 'restricted-reviewer-v1' as const,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      installation_id: INSTALLATION_ID,
      approval_id: APPROVAL_ID,
      request_id: REQUEST_ID,
      request_sha256: digest('request'),
      provider_event_sha256: digest('provider-event'),
      adapter_binding_id: BINDING_ID,
      permission_grant_id: GRANT_ID,
      reviewer_principal_id: REVIEWER_PRINCIPAL,
      reviewer_membership_id: REVIEWER_MEMBERSHIP,
      reviewer_release_draft_sha256: RELEASE_DRAFT_SHA256,
      approval_presentation_sha256: digest('approval-presentation'),
      semantic_intent_sha256: digest('semantic-intent'),
      message_presentation_sha256: digest('message-presentation'),
      authorization_audit_event_id: AUDIT_EVENT_ID,
      authorization_audit_entry_sha256: digest('audit-entry'),
      evaluated_at: EVALUATED_AT,
      ...overrides,
    },
  }));
}

describe('reviewer envelope validator adapter', () => {
  it('is the real closed protocol validator, bound to this organization', () => {
    const view = reviewerValidator(reviewerEnvelope());
    expect(view).toMatchObject({
      schema_version: 2,
      organization_id: ORGANIZATION_ID,
      envelope_id: ENVELOPE_ID,
      idempotency_key: APPROVAL_ID,
      installation_id: INSTALLATION_ID,
      reviewer_principal_id: REVIEWER_PRINCIPAL,
      reviewer_membership_id: REVIEWER_MEMBERSHIP,
      reviewer_release_draft_sha256: RELEASE_DRAFT_SHA256,
      evaluated_at: EVALUATED_AT,
    });
    // Raw signal ids in canonical draft order: they are what the fact's
    // signal digest and atom id are derived from.
    expect(view.signals).toEqual([
      { id: 'signal-decision-1', kind: 'decision', text: 'Ship the pilot.' },
    ]);
  });

  it('fails closed on a v1 frame, a v2 rejection, and a foreign organization', () => {
    for (const [label, mutate] of [
      [
        'schema v1',
        (envelope: Record<string, unknown>) => ({
          ...envelope,
          schema_version: 1,
        }),
      ],
      [
        'v2 rejection',
        (envelope: Record<string, unknown>) => ({
          ...envelope,
          event_type: 'rejection',
        }),
      ],
      [
        'extra top-level key',
        (envelope: Record<string, unknown>) => ({ ...envelope, extra: true }),
      ],
      [
        'altered release draft digest',
        (envelope: Record<string, unknown>) => {
          const reviewer = envelope['reviewer'] as Record<string, unknown>;
          const authorization = reviewer['authorization'] as Record<
            string,
            unknown
          >;
          return {
            ...envelope,
            reviewer: {
              ...reviewer,
              authorization: {
                ...authorization,
                reviewer_release_draft_sha256: digest('another-draft'),
              },
            },
          };
        },
      ],
    ] as const) {
      expect(
        () => reviewerValidator(mutate(reviewerEnvelope()) as JsonObject),
        label,
      ).toThrow();
    }

    // A well-formed reviewer approval for a different organization is not
    // admissible here, even though the document itself is valid.
    const foreign = reviewerRestrictedEnvelopeValidator({
      organization_id: 'org_00000000-0000-4000-8000-000000000002',
      authority_id: AUTHORITY_ID,
    });
    expect(() => foreign(reviewerEnvelope())).toThrow(
      /does not name this organization and authority/,
    );
  });
});

describe('reviewer restricted admission', () => {
  it('marks reviewer reads ready only when both halves agree', () => {
    const log = openLogWithReviewerRecord();
    try {
      const evidence = matchedEvidence();
      const verdict = readiness(log, evidence);
      expect(verdict).toMatchObject({
        ready: true,
        reviewer_records_verified: 1,
        reviewer_facts_verified: 1,
        audit_rows_revalidated: 1,
        failures: [],
      });
      // Authority re-queried the exact aud_* key by primary key.
      expect(evidence).toHaveBeenCalledWith(
        AUDIT_EVENT_ID,
      );
    } finally {
      log.close();
    }
  });

  it.each([
    ['absent', 'audit_evidence_absent'],
    ['corrupt', 'audit_evidence_corrupt'],
    ['unavailable', 'audit_evidence_unavailable'],
  ] as const)(
    'holds reviewer reads closed when the audit lookup returns %s',
    (status, kind) => {
      const log = openLogWithReviewerRecord();
      try {
        const verdict = readiness(log, () => ({ status }) as never);
        expect(verdict.ready).toBe(false);
        expect(verdict.audit_rows_revalidated).toBe(0);
        expect(verdict.failures[0]).toMatchObject({ kind, log_position: 1 });
      } finally {
        log.close();
      }
    },
  );

  it('holds reviewer reads closed when the audit proof contradicts the fact', () => {
    const log = openLogWithReviewerRecord();
    try {
      const verdict = readiness(
        log,
        matchedEvidence({ reviewer_membership_id: 'mem_someone_else' }),
      );
      expect(verdict.ready).toBe(false);
      expect(verdict.failures[0]).toMatchObject({
        kind: 'audit_evidence_mismatch',
      });
    } finally {
      log.close();
    }
  });

  it('never re-queries anything when the structural pass already failed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reviewer-admission-bad-'));
    directories.push(directory);
    const log = OrganizationRecordLogStore.open(
      join(directory, 'record-log.sqlite'),
      { organization_id: ORGANIZATION_ID, authority_id: AUTHORITY_ID },
    );
    try {
      // A reviewer record whose facts were never co-committed.
      writeReviewerRecord(log, false);
      const evidence = matchedEvidence();
      const verdict = readiness(log, evidence);
      expect(verdict.ready).toBe(false);
      expect(verdict.failures[0]).toMatchObject({ kind: 'log_facts_invalid' });
      expect(evidence).not.toHaveBeenCalled();
    } finally {
      log.close();
      for (const path of directories.splice(0)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});
