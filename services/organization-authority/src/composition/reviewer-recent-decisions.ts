import type { OrganizationReviewerRecentDecisionsRequestV1 } from '@echo-brain/organization-api';
import type { OrganizationRecordAuthorizationEvidenceStore } from '../application/organization-record-ingest.js';
import type {
  OrganizationAuthorityApplication,
  ReviewerRecentDecisionsSourceInput,
  ReviewerRecentDecisionsSourceOutput,
} from '../application/organization-authority.js';
import {
  ReviewerRecentDecisionsError,
  type PreparedReviewerRecentDecisionsResponse,
  type ReviewerResolvedItem,
} from '../application/reviewer-recent-decisions.js';
import type { OrganizationReviewerRecentDecisionsHttpApplication } from '../presentation/organization-reviewer-recent-decisions-http-application.js';
import type { OrganizationRecordRuntime } from './organization-record.js';
import { reviewerAuthorizationEvidenceMatchesReference } from './reviewer-restricted-admission.js';

function unavailable(message: string, cause?: unknown): never {
  throw new ReviewerRecentDecisionsError('unavailable', message, { cause });
}

/** The V1 and V2 adapters share this reviewer-bound selection only. */
export function loadReviewerRecentDecisionsSource(
  records: OrganizationRecordRuntime,
  evidence: OrganizationRecordAuthorizationEvidenceStore,
  caller: ReviewerRecentDecisionsSourceInput,
): ReviewerRecentDecisionsSourceOutput {
  if (records.reviewerRestrictedHealth.kind === 'degraded') {
    unavailable(
      'reviewer-restricted runtime is unavailable',
      records.reviewerRestrictedHealth.failure,
    );
  }
  if (records.fatalFailure !== null) {
    unavailable('reviewer record runtime is unavailable', records.fatalFailure);
  }
  const readEvidence = evidence.readAllowedReviewerAuthorizationEvidenceById;
  if (readEvidence === undefined) {
    unavailable('reviewer authorization evidence reader is unavailable');
  }
  const session = records.reviewerRecords.openSession({
    caller: {
      reviewer_principal_id: caller.reviewer_principal_id,
      reviewer_membership_id: caller.reviewer_membership_id,
    },
    request_sha256: caller.request_sha256,
    limit: 10,
  });
  try {
    const facts = session.readFacts();
    const authorization = session.readAuthorizationReferences();
    for (const reference of authorization.references) {
      const match = readEvidence.call(
        evidence,
        reference.authorization_audit_event_id,
      );
      if (
        match.status !== 'matched' ||
        !reviewerAuthorizationEvidenceMatchesReference(reference, match.evidence)
      ) {
        unavailable(
          `reviewer authorization evidence ${reference.authorization_audit_event_id} is unavailable or mismatched`,
        );
      }
    }
    if (facts.length === 0) {
      return Object.freeze({
        items: Object.freeze([]) as readonly ReviewerResolvedItem[],
        record_head: authorization.record_head,
      });
    }
    const binding = session.bindResolvedFacts(facts);
    const released = session.readBoundCanonicalRecords(binding);
    if (released.length !== facts.length) {
      unavailable('reviewer released items are not aligned with facts');
    }
    const items = released.map((item, index) => {
      const fact = facts[index];
      if (fact === undefined) {
        unavailable('reviewer released item has no aligned fact');
      }
      return Object.freeze({
        kind: item.kind,
        text: item.text,
        atom_id: fact.atom_id,
        record_hash: fact.record_hash,
      });
    });
    return Object.freeze({
      items: Object.freeze(items),
      record_head: authorization.record_head,
    });
  } finally {
    session.close();
  }
}

export function composeReviewerRecentDecisions(
  authority: OrganizationAuthorityApplication,
  records: OrganizationRecordRuntime,
  evidence: OrganizationRecordAuthorizationEvidenceStore,
): OrganizationReviewerRecentDecisionsHttpApplication {
  if (records.reviewerRestrictedHealth.kind === 'degraded') {
    return {
      reviewerRecentDecisions(): never {
        unavailable(
          'reviewer-restricted runtime is unavailable',
          records.reviewerRestrictedHealth.kind === 'degraded'
            ? records.reviewerRestrictedHealth.failure
            : undefined,
        );
      },
    };
  }
  return {
    reviewerRecentDecisions(
      request: OrganizationReviewerRecentDecisionsRequestV1,
    ): PreparedReviewerRecentDecisionsResponse {
      return authority.serveReviewerRecentDecisions(request, (caller) =>
        loadReviewerRecentDecisionsSource(records, evidence, caller),
      );
    },
  };
}
