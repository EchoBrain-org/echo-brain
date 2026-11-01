import { describe, expect, it, vi } from 'vitest';
import { personReviewCommandV1, validatePersonReviewRequestV1, validatePersonReviewResultV1 } from '../src/person-reviews-v1.js';
import { validatePersonMeetingRequestV2 } from '../src/person-meetings-v1.js';

const review = { schema_version: 1, operation: 'review', approval_id: 'apr_123', command_id: 'review-once', snapshot_sha256: `sha256:${'a'.repeat(64)}`,
  action: 'reject', routes: [], owners: [] };
describe('person-owned review contract', () => {
  it('accepts review operations without a provider and preserves the strict legacy request', () => {
    for (const request of [{ schema_version: 1, operation: 'reviews' }, { schema_version: 1, operation: 'review_open', approval_id: 'apr_123' }, review]) {
      expect(validatePersonReviewRequestV1(request)).toEqual(request);
      expect(() => validatePersonReviewRequestV1({ ...request, tool_id: 'granola' })).toThrow();
    }
    expect(() => validatePersonReviewRequestV1({ schema_version: 1, operation: 'home' })).toThrow();
    expect(() => validatePersonReviewRequestV1({ schema_version: 2, operation: 'reviews' })).toThrow();
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, operation: 'reviews' })).toThrow();
    expect(validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'meeting-fixture', operation: 'reviews' })).toHaveProperty('tool_id', 'meeting-fixture');
  });
  it('keeps the decision field constraints and validates released results', () => {
    for (const invalid of [{ ...review, command_id: 'bad command' }, { ...review, action: 'approve' }, { ...review, owners: [{ signal_id: 'act-1', owner: 'Someone' }] }, { ...review, snapshot_sha256: 'bad' }]) {
      expect(() => validatePersonReviewRequestV1(invalid)).toThrow();
    }
    expect(validatePersonReviewResultV1('reviews', { reviews: [] })).toEqual({ reviews: [] });
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [], tool_id: 'hidden' })).toThrow();
  });
  it('refuses provider-selected requests before opening a session', () => {
    const withToolSession = vi.fn();
    expect(() => personReviewCommandV1({ withToolSession }, { schema_version: 1, operation: 'reviews', tool_id: 'granola' } as never)).toThrow();
    expect(withToolSession).not.toHaveBeenCalled();
  });
});
