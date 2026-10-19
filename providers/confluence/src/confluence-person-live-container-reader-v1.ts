import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReaderV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createAtlassianVerificationBatchV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import { createPersonToolContainerReaderV1, personToolContainerRowsV1, type PersonToolContainerV1 } from '@echo-brain/provider-runtime/person-tool-container-reader-v1';
import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { verifyConfluenceConnectionV1 } from './confluence-payload-v1.js';
import { confluenceArray, confluenceFailure, confluenceRecord, confluenceString, copyConfluenceBindingV1 } from './confluence-validation-v1.js';

const ID = /^[1-9][0-9]{0,19}$/;
/** A global space key, or a personal space's "~" and its owner's account or user name. */
const SPACE_KEY = /^~?[A-Za-z0-9][A-Za-z0-9_:.-]{0,253}$/;
const API_ORIGIN = 'https://api.atlassian.com';
/** A search looks through at most this many pages of spaces, each as large as Confluence serves. */
const SCAN_PAGES = 4;
const SCAN_PAGE = 250;

/**
 * The Confluence spaces the asker can view, as a tool container source (research tool contract v1). Confluence lists and
 * reads only the spaces the asker's own account can view. It has no space search, so a search looks through the spaces
 * the asker can view, a bounded number of pages. Construct once per request from trusted ECHO state.
 */
export async function createConfluencePersonLiveContainerReaderV1(options: {
  readonly binding: PersonConnectorReadBindingV1;
  readonly transport: ConfluenceCloudTransportV1;
  readonly expected_origin?: string;
  readonly signal?: AbortSignal;
  /** Trusted project-scope pin: the space ids an ECHO project maps. */
  readonly space_ids?: readonly string[];
  /** The names of the visible ECHO projects mapped to each space, by space id. */
  readonly echo_projects: () => ReadonlyMap<string, readonly string[]>;
}): Promise<PersonLiveEvidenceReaderV1<PersonToolContainerCitationV1>> {
  if (options.space_ids !== undefined && options.space_ids.some(id => typeof id !== 'string' || !ID.test(id))) confluenceFailure('invalid_request');
  const binding = copyConfluenceBindingV1(options.binding);
  const bindingDigest = canonicalSha256(binding);
  const { transport } = options;
  const cloud = binding.external_scope_id!;
  const fence = () => { if (canonicalSha256(transport.binding) !== bindingDigest) confluenceFailure('stale_access_state'); };
  fence();
  let origin = options.expected_origin;
  const verification = createAtlassianVerificationBatchV1(async (signal?: AbortSignal) => (await verifyConfluenceConnectionV1(transport, { signal, expected_origin: origin,
    require_account(account) { if (account !== binding.external_subject_id) confluenceFailure('unauthorized'); } })).origin);

  function space(raw: unknown): PersonToolContainerV1 {
    const value = confluenceRecord(raw);
    const name = confluenceString(value.name, 1024);
    // A blank name cannot label an item.
    if (name.trim() === '') confluenceFailure('invalid_output');
    return Object.freeze({ id: confluenceString(value.id, 20, ID), key: confluenceString(value.key, 255, SPACE_KEY), name });
  }
  /** Only the opaque cursor is taken from Confluence's next link, never the link itself. */
  function nextCursor(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    let url: URL;
    try { url = new URL(confluenceString(raw, 4096), API_ORIGIN); } catch { confluenceFailure('invalid_output'); }
    const paths = ['/api/v2/spaces', '/wiki/api/v2/spaces', `/ex/confluence/${cloud}/wiki/api/v2/spaces`];
    if (url.origin !== API_ORIGIN || !paths.includes(url.pathname) || url.username !== '' || url.password !== '' || url.hash !== '' ||
        url.searchParams.getAll('cursor').length !== 1) confluenceFailure('invalid_output');
    return confluenceString(url.searchParams.get('cursor'), 4096);
  }
  async function spaces(limit: number, cursor: string | undefined, signal?: AbortSignal) {
    const page = confluenceRecord(await transport.request({ path: '/api/v2/spaces', query: { limit: String(limit), ...(cursor === undefined ? {} : { cursor }) }, signal }));
    signal?.throwIfAborted();
    const { containers, left_out } = personToolContainerRowsV1(confluenceArray(page.results, limit), space);
    if (new Set(containers.map(value => value.id)).size !== containers.length) confluenceFailure('invalid_output');
    const next = nextCursor(page._links === undefined ? undefined : confluenceRecord(page._links).next);
    return { containers, left_out, next };
  }

  return createPersonToolContainerReaderV1({
    provider: {
      binding, tool: 'Confluence', container: 'confluence_space', noun: 'Confluence space', failure: confluenceFailure,
      async verify(signal) {
        fence();
        origin = await verification(signal);
        fence();
        return origin;
      },
      permalink: (site, value) => `${site}/wiki/spaces/${encodeURIComponent(value.key)}`,
      async page({ cursor, limit, signal }) {
        const { containers, left_out, next } = await spaces(limit, cursor, signal);
        return { containers, left_out, ...(next === undefined ? {} : { next }) };
      },
      async candidates({ signal }) {
        const found: PersonToolContainerV1[] = [];
        let left_out = 0;
        let cursor: string | undefined;
        for (let page = 0; page < SCAN_PAGES; page += 1) {
          const read = await spaces(SCAN_PAGE, cursor, signal);
          found.push(...read.containers);
          left_out += read.left_out;
          cursor = read.next;
          if (cursor === undefined) break;
        }
        if (new Set(found.map(value => value.id)).size !== found.length) confluenceFailure('invalid_output');
        return { containers: Object.freeze(found), left_out, more: cursor !== undefined };
      },
      async exact(id, signal) {
        const value = space(await transport.request({ path: `/api/v2/spaces/${id}`, signal }));
        signal?.throwIfAborted();
        if (value.id !== id) confluenceFailure('invalid_output');
        return value;
      },
    },
    ...(options.space_ids === undefined ? {} : { pinned: options.space_ids }),
    echo_projects: options.echo_projects,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
