import { describe, expect, it } from 'vitest';
import type { OrganizationRecordAuthorizationEvidenceStore } from '../src/application/organization-record-ingest.js';
import { ReviewerRecentDecisionsError } from '../src/application/reviewer-recent-decisions.js';
import type { OrganizationRecordRuntime } from '../src/composition/organization-record.js';
import { loadReviewerRecentDecisionsSource } from '../src/composition/reviewer-recent-decisions.js';

describe('reviewer recent-decisions composition', () => {
  it('keeps the shared V1/V2 source closed when reviewer startup is degraded', () => {
    let sourceOpened = false;
    const failure = new Error('reviewer startup evidence is inconsistent');
    const records = {
      fatalFailure: null,
      reviewerRestrictedHealth: { kind: 'degraded', failure },
      reviewerRecords: {
        openSession() {
          sourceOpened = true;
          throw new Error('degraded source must not open');
        },
      },
    } as unknown as OrganizationRecordRuntime;

    expect(() =>
      loadReviewerRecentDecisionsSource(
        records,
        {} as OrganizationRecordAuthorizationEvidenceStore,
        {} as never,
      ),
    ).toThrow(
      expect.objectContaining<Partial<ReviewerRecentDecisionsError>>({
        code: 'unavailable',
      }),
    );
    expect(sourceOpened).toBe(false);
  });
});
