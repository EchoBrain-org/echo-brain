import { once } from 'node:events';
import { expect, it } from 'vitest';
import { PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1, PERSON_REVIEW_RESPONSE_MAX_BYTES_V1, PERSON_REVIEWS_PATH_V1, PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, validatePersonReviewResultV1 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { authorityHttpServerOptions } from './fixtures/authority-http-server.js';
import { jsonBytes, largestReviewV1 } from '../../../packages/organization-api/test/fixtures/largest-review.js';

/** The bytes the HTTP server sends when the review route answers `body` to `request`: the route's own typed check first, as the route does. */
async function answered(request: { readonly operation: 'reviews' } | { readonly operation: 'review_open'; readonly approval_id: string }, body: unknown): Promise<{ readonly status: number; readonly bytes: Uint8Array }> {
  const reviews: ProviderHttpApplicationV1 = {
    routes: [{ route_id: 'personal-reviews', method: 'POST', path: PERSON_REVIEWS_PATH_V1 }],
    async accept() { return { status: 200, body: validatePersonReviewResultV1(request.operation, body) }; },
  };
  const instance = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_tool_connections: [reviews] }));
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(instance.address() as { port: number }).port}${PERSON_REVIEWS_PATH_V1}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, body: JSON.stringify({ schema_version: 1, ...request }),
    });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  } finally { const closed = once(instance, 'close'); instance.close(); await closed; }
}

// An item's day made the largest review longer (ADR-0053). The review route checks its own answer against the typed
// bound, and the HTTP server then holds every tool route's JSON to the transport ceiling: both must let that review out.
it('answers the largest review a reviewer could open before items carried a day, at the response bound, through the HTTP server', async () => {
  const largest = largestReviewV1();
  const { status, bytes } = await answered({ operation: 'review_open', approval_id: largest.review.approval_id }, largest);
  expect(status).toBe(200);
  // On the wire it is the bytes the typed bound measured, within what the client reads.
  expect(bytes.byteLength).toBe(PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1);
  expect(bytes.byteLength).toBeLessThanOrEqual(PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1);
  expect(validatePersonReviewResultV1('review_open', JSON.parse(new TextDecoder().decode(bytes))).items).toHaveLength(500);
});

// A reviewer's list has no largest size, so it pages at the same bound (ADR-0055): a page is rows and the cursor of the page
// after it. The fullest page the route could build must get out through both checks, as the largest opened review does;
// one byte more is refused, which is why the route fits every page to the bound before it answers.
it('answers a full page of the reviews list, the next cursor included, at the response bound, through the HTTP server', async () => {
  const row = (index: number, title: string) => ({ approval_id: `apr_${String(index).padStart(64, '0')}`, title, project_ids: [], status: 'pending' as const, decided_on: null,
    first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false, records: [] });
  // 2,000 rows and the longest cursor; the first row's title pads the page to `size` bytes as JSON.
  const page = (pad: number) => ({ reviews: Array.from({ length: 2_000 }, (_, index) => row(index, index === 0 ? 'T'.repeat(pad) : 'Pilot planning')), next_cursor: 'c'.repeat(512) });
  const sized = (size: number) => page(1 + size - jsonBytes(page(1)));
  const { status, bytes } = await answered({ operation: 'reviews' }, sized(PERSON_REVIEW_RESPONSE_MAX_BYTES_V1));
  expect(status).toBe(200);
  expect(bytes.byteLength).toBe(PERSON_REVIEW_RESPONSE_MAX_BYTES_V1);
  expect(bytes.byteLength).toBeLessThanOrEqual(PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1);
  const read = validatePersonReviewResultV1('reviews', JSON.parse(new TextDecoder().decode(bytes)));
  expect(read.reviews).toHaveLength(2_000);
  expect(read.next_cursor).toBe('c'.repeat(512));
  expect(() => validatePersonReviewResultV1('reviews', sized(PERSON_REVIEW_RESPONSE_MAX_BYTES_V1 + 1))).toThrow('exceeds its bound');
});
