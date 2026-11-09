import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import {
  CONFLUENCE_ID as ID, confluenceArray, confluenceFailure, confluenceNextCursorV1, confluenceRecord, confluenceString, confluenceVersionNumberV1,
} from './confluence-validation-v1.js';

/**
 * The Ask source check's page read (Ask timeline v1, C1; ADR-0047): versions by id, and no page body. A page the asker can
 * read is current or archived; a trashed or deleted one is gone for them.
 */
const READABLE_STATUSES = Object.freeze(['current', 'archived']);
/** Two metadata calls of 50 ids. */
const VERSIONS_BATCH = 50;
const VERSIONS_MAX_IDS = 100;

/**
 * Each readable page's current version by its id, for distinct valid page ids. `GET /pages` applies the asker's current
 * permissions to the exact id set and leaves out what they cannot read. A short page that still links to a next one may have
 * left out readable pages, so it fails the read rather than answer them as unreadable.
 */
export async function readConfluencePageVersionsV1(transport: ConfluenceCloudTransportV1, input: { readonly cloud_id: string; readonly page_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>> {
  if (input.page_ids.length > VERSIONS_MAX_IDS) confluenceFailure('invalid_request');
  const found = new Map<string, string>();
  for (let offset = 0; offset < input.page_ids.length; offset += VERSIONS_BATCH) {
    const batch = input.page_ids.slice(offset, offset + VERSIONS_BATCH);
    const expected = new Set(batch);
    const response = confluenceRecord(await transport.request({ path: '/api/v2/pages', query: { id: batch, limit: String(batch.length), status: READABLE_STATUSES }, signal: input.signal }));
    input.signal?.throwIfAborted();
    const rows = confluenceArray(response.results, batch.length);
    for (const raw of rows) {
      const page = confluenceRecord(raw);
      const id = confluenceString(page.id, 20, ID);
      if (!expected.has(id) || found.has(id) || !READABLE_STATUSES.includes(confluenceString(page.status, 32))) confluenceFailure('invalid_output');
      found.set(id, confluenceVersionNumberV1(confluenceRecord(page.version)));
    }
    const links = response._links === undefined ? {} : confluenceRecord(response._links);
    if (rows.length < batch.length && confluenceNextCursorV1(links.next, input.cloud_id, '/api/v2/pages', 8192) !== undefined) confluenceFailure('unavailable');
  }
  return found;
}
