import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { inBatchesOfFourV1 as parallel } from '@echo-brain/provider-runtime/person-provider-v1';
import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { normalizeConfluencePageDocumentV1 } from './confluence-page-text-v1.js';
import {
  CONFLUENCE_ID as ID, confluenceArray, confluenceAtlasDocumentV1, confluenceFailure, confluenceNextCursorV1, confluenceRecord, confluenceString, confluenceVersionNumberV1,
} from './confluence-validation-v1.js';

/**
 * The Ask source check's page reads (Ask timeline v1, C1; ADR-0047): versions by id, then the bodies of the few pages whose
 * cited section needs comparing. A page the asker can read is current or archived; a trashed or deleted one is gone for them.
 */
const READABLE_STATUSES = Object.freeze(['current', 'archived']);
/** Two metadata calls of 50 ids; ten page bodies. */
const VERSIONS_BATCH = 50;
const VERSIONS_MAX_IDS = 100;
const SECTIONS_MAX_PAGES = 10;

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

/**
 * The SHA-256 digest of each non-blank section of each page's current body, as the page reader releases and cites a section,
 * four pages at a time. A page Confluence answers 404 for, gone or hidden from the asker, is left out; one whose body cannot be
 * read as text is null, and the others keep theirs. Any other failure fails the read.
 */
export async function readConfluencePageSectionsV1(transport: ConfluenceCloudTransportV1, input: { readonly page_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, readonly Sha256Digest[] | null>> {
  if (input.page_ids.length > SECTIONS_MAX_PAGES) confluenceFailure('invalid_request');
  const found = new Map<string, readonly Sha256Digest[] | null>();
  await parallel(input.page_ids, async id => {
    let raw: unknown;
    try {
      raw = await transport.request({ path: `/api/v2/pages/${id}`, query: { 'body-format': 'atlas_doc_format', status: READABLE_STATUSES }, signal: input.signal });
    } catch (error) {
      if (error instanceof AuthorityOperationError && error.code === 'not_found') return;
      throw error;
    }
    input.signal?.throwIfAborted();
    const page = confluenceRecord(raw);
    if (confluenceString(page.id, 20, ID) !== id) confluenceFailure('invalid_output');
    const document = confluenceAtlasDocumentV1(page.body);
    let sections: readonly string[] | undefined;
    try { sections = normalizeConfluencePageDocumentV1(document).sections; } catch { sections = undefined; }
    found.set(id, sections === undefined ? null : Object.freeze(sections.filter(text => text.trim() !== '').map(text => sha256Digest(text))));
  });
  return found;
}
