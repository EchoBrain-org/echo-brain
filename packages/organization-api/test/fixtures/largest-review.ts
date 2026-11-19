import { PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1 } from '../../src/person-reviews-v1.js';

/** A value's size as the Authority sends it and the validator measures it: its JSON in UTF-8. */
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The largest opened review: the most items a review holds (500), every one an action with a deadline and its day, the
 * first one's text padded so the whole response is `size` bytes as JSON (the response's bound unless told otherwise).
 */
export function largestReviewV1(size: number = PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1) {
  const build = (pad: number) => ({
    review: { approval_id: `apr_${'a'.repeat(64)}`, title: 'Quarterly planning', project_ids: [], status: 'pending' as const, decided_on: null, first_line: null,
      action_count: 500, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false, records: [] },
    snapshot_sha256: `sha256:${'b'.repeat(64)}`, participants: ['Mina Patel'],
    items: Array.from({ length: 500 }, (_, index) => ({ signal_id: `action:${index}`, kind: 'action' as const, text: index === 0 ? 'x'.repeat(pad) : 'Send the plan.',
      subject: null, status: null, due_at: '2026-10-20T00:00:00.000Z' as string | null, due_on: '2026-10-20' as string | null,
      // Each item's own quote keeps the padding within one text's limit.
      quotes: ['[09:01] Mina: send the plan.'], owner: null, owner_editable: false, project_ids: [] })),
    reasons: [], suggested_projects: [], records: [],
  });
  return build(1 + size - jsonBytes(build(1)));
}
