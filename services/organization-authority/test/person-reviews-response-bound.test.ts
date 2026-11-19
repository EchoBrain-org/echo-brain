import { once } from 'node:events';
import { expect, it } from 'vitest';
import { PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1, PERSON_REVIEWS_PATH_V1, PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, validatePersonReviewResultV1 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { authorityHttpServerOptions } from './fixtures/authority-http-server.js';
import { largestReviewV1 } from '../../../packages/organization-api/test/fixtures/largest-review.js';

// An item's day made the largest review longer (ADR-0053). The review route checks its own answer against the typed
// bound, and the HTTP server then holds every tool route's JSON to the transport ceiling: both must let that review out.
it('answers the largest review a reviewer could open before items carried a day, at the response bound, through the HTTP server', async () => {
  const largest = largestReviewV1();
  const reviews: ProviderHttpApplicationV1 = {
    routes: [{ route_id: 'personal-reviews', method: 'POST', path: PERSON_REVIEWS_PATH_V1 }],
    // As the review route answers: its own typed check first.
    async accept() { return { status: 200, body: validatePersonReviewResultV1('review_open', largest) }; },
  };
  const instance = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_tool_connections: [reviews] }));
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(instance.address() as { port: number }).port}${PERSON_REVIEWS_PATH_V1}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
      body: JSON.stringify({ schema_version: 1, operation: 'review_open', approval_id: largest.review.approval_id }),
    });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // On the wire it is the bytes the typed bound measured, within what the client reads.
    expect(bytes.byteLength).toBe(PERSON_REVIEW_OPEN_RESPONSE_MAX_BYTES_V1);
    expect(bytes.byteLength).toBeLessThanOrEqual(PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1);
    expect(validatePersonReviewResultV1('review_open', JSON.parse(new TextDecoder().decode(bytes))).items).toHaveLength(500);
  } finally { const closed = once(instance, 'close'); instance.close(); await closed; }
});
