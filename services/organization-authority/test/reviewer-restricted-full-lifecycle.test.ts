import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  validateOrganizationReviewerRecentDecisionsResponse,
} from '@echo-brain/organization-api';
import type {
  ReviewerReadSession,
  ReviewerRecordPort,
} from '@echo-brain/organization-record/reviewer';
import {
  composeReviewerRecentDecisions,
} from '../src/composition/reviewer-recent-decisions.js';
import {
  openOrganizationRecordRuntime,
  type OrganizationRecordRuntime,
} from '../src/composition/organization-record.js';
import {
  approvalId,
  createRecordIngestFixture,
  type RecordIngestFixture,
} from './support/record-ingest-fixture.js';

let fixture: RecordIngestFixture | undefined;
let restarted: OrganizationRecordRuntime | undefined;

afterEach(async () => {
  const openRestarted = restarted;
  const openFixture = fixture;
  restarted = undefined;
  fixture = undefined;
  await openRestarted?.close().catch(() => undefined);
  await openFixture?.close().catch(() => undefined);
});

function observeContentReads(
  runtime: OrganizationRecordRuntime,
  observed: { fact_reads: number; content_reads: number },
): OrganizationRecordRuntime {
  const source = runtime.reviewerRecords;
  const reviewerRecords: ReviewerRecordPort = Object.freeze({
    verifyFactAdmission: () => source.verifyFactAdmission(),
    openSession(
      input: Parameters<ReviewerRecordPort['openSession']>[0],
    ): ReviewerReadSession {
      const session = source.openSession(input);
      return Object.freeze({
        ...session,
        readFacts() {
          observed.fact_reads += 1;
          return session.readFacts();
        },
        readAuthorizationReferences: () =>
          session.readAuthorizationReferences(),
        bindResolvedFacts: (
          facts: Parameters<ReviewerReadSession['bindResolvedFacts']>[0],
        ) => session.bindResolvedFacts(facts),
        readBoundCanonicalRecords(
          binding: Parameters<
            ReviewerReadSession['readBoundCanonicalRecords']
          >[0],
        ) {
          observed.content_reads += 1;
          return session.readBoundCanonicalRecords(binding);
        },
        close: () => session.close(),
      }) as ReviewerReadSession;
    },
  });
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === 'reviewerRecords') return reviewerRecords;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe('restricted reviewer minimum V1 full lifecycle', () => {
  it('survives restart, releases exact content only to its reviewer, and audits another current member as empty', async () => {
    fixture = await createRecordIngestFixture();
    const envelope = await fixture.reviewerApprovalEnvelope({
      approval_id: approvalId('reviewer-full-lifecycle'),
    });

    const accepted = await fixture.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    expect(accepted.record_receipt.position).toBe(1);

    const recordDatabase = new Database(fixture.recordLogDatabasePath, {
      readonly: true,
    });
    try {
      const fact = recordDatabase
        .prepare(
          `SELECT reviewer_principal_id, reviewer_membership_id, log_position,
                  atom_order, authorization_audit_event_id
           FROM organization_record_reviewer_policy_fact`,
        )
        .get() as
        | {
            reviewer_principal_id: string;
            reviewer_membership_id: string;
            log_position: number;
            atom_order: number;
            authorization_audit_event_id: string;
          }
        | undefined;
      expect(fact).toMatchObject({
        reviewer_principal_id: fixture.principalId,
        reviewer_membership_id: fixture.membershipId,
        log_position: 1,
        atom_order: 0,
      });
      expect(fact?.authorization_audit_event_id).toMatch(/^aud_/u);
    } finally {
      recordDatabase.close();
    }

    await fixture.runtime.close();
    restarted = await openOrganizationRecordRuntime({
      authority: fixture.application,
      evidence: fixture.integrations,
      organization_id: fixture.organizationId,
      authority_id: fixture.authorityId,
      record_log_database_path: fixture.recordLogDatabasePath,
      record_derived_database_path: fixture.recordDerivedDatabasePath,
      alert: () => undefined,
    });
    expect(restarted.reviewerRestrictedHealth.kind).toBe('ready');

    const observed = { fact_reads: 0, content_reads: 0 };
    const application = composeReviewerRecentDecisions(
      fixture.application,
      observeContentReads(restarted, observed),
      fixture.integrations,
    );

    const reviewerResponse = application.reviewerRecentDecisions(
      await fixture.reviewerRecentDecisionsRequest(),
    );
    expect(reviewerResponse.status_code).toBe(200);
    expect(reviewerResponse.body.toString('utf8')).toBe(
      canonicalJson({
        schema_version: 1,
        items: [
          { kind: 'decision', text: 'Adopt usage-based pricing.' },
        ],
        policy_id: 'restricted-reviewer-v1',
        witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
      }),
    );
    expect(
      validateOrganizationReviewerRecentDecisionsResponse(
        JSON.parse(reviewerResponse.body.toString('utf8')),
      ).items,
    ).toHaveLength(1);
    expect(observed).toEqual({ fact_reads: 1, content_reads: 1 });

    observed.fact_reads = 0;
    observed.content_reads = 0;
    const otherResponse = application.reviewerRecentDecisions(
      await fixture.otherReviewerRecentDecisionsRequest(),
    );
    const expectedEmptyBytes = canonicalJson({
      schema_version: 1,
      items: [],
      policy_id: 'restricted-reviewer-v1',
      witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
    });
    expect(otherResponse.status_code).toBe(200);
    expect(otherResponse.body.toString('utf8')).toBe(expectedEmptyBytes);
    // The exact Person resolver and text-free fact index run. The protected
    // canonical record reader does not run for a different member.
    expect(observed).toEqual({ fact_reads: 1, content_reads: 0 });

    const authorityDatabase = new Database(
      `${fixture.directory}/authority.sqlite`,
      { readonly: true },
    );
    try {
      const rows = authorityDatabase
        .prepare(
          `SELECT decision, reason_code, detail_json
           FROM authority_query_decision_audit
           ORDER BY audit_sequence ASC`,
        )
        .all() as {
        decision: string;
        reason_code: string;
        detail_json: string;
      }[];
      expect(rows).toHaveLength(2);
      expect(
        rows.map((row) => ({
          decision: row.decision,
          reason_code: row.reason_code,
        })),
      ).toEqual([
        {
          decision: 'allow',
          reason_code: 'active_exact_reviewer_membership',
        },
        {
          decision: 'allow',
          reason_code: 'active_exact_reviewer_membership',
        },
      ]);
      const reviewerAudit = JSON.parse(rows[0]!.detail_json) as Record<
        string,
        unknown
      >;
      const otherAudit = JSON.parse(rows[1]!.detail_json) as Record<
        string,
        unknown
      >;
      expect(reviewerAudit['response_sha256']).toBe(
        sha256Digest(reviewerResponse.body),
      );
      expect(reviewerAudit['returned_atom_ids']).toHaveLength(1);
      expect(otherAudit).toMatchObject({
        response_sha256: sha256Digest(otherResponse.body),
        returned_atom_ids: [],
        returned_record_hashes: [],
        requester: {
          principal_id: fixture.otherPrincipalId,
          membership_id: fixture.otherMembershipId,
          enrollment_id: fixture.otherEnrollmentId,
        },
      });
      expect(rows[1]!.detail_json).not.toContain('Adopt usage-based pricing.');
    } finally {
      authorityDatabase.close();
    }
  });
});
