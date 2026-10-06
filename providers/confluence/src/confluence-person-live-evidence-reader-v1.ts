import { createHash, randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonPageCitationV1, type PersonPageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { normalizeConfluencePageDocumentV1 } from './confluence-page-text-v1.js';
import { verifyConfluenceConnectionV1 } from './confluence-payload-v1.js';
import { confluenceArray, confluenceFailure, confluenceRecord, confluenceString, copyConfluenceBindingV1 } from './confluence-validation-v1.js';

const API_ORIGIN = 'https://api.atlassian.com';
const ID = /^[1-9][0-9]{0,19}$/;
const MAX_HANDLES = 512;
const MAX_REQUESTS = 160;
const REVALIDATION_BATCH_SIZE = 50;
const LIST_STATUSES = Object.freeze(['current', 'archived', 'deleted', 'trashed']);
const STATUSES = Object.freeze([...LIST_STATUSES, 'draft', 'historical']);
const EMPTY_DIGEST = textDigest('');
type Page = Readonly<{ id: string; space_id: string; title: string; version: string; status: string; occurred_at?: string; date_kind?: 'created' | 'version_created'; document?: string }>;
type Item = Readonly<{ page: Page; section: string; offset: number; text?: string }>;
type Cursor = Readonly<{ selection: string; path: string; query: Readonly<Record<string, string | readonly string[]>>; token: string }>;

function textDigest(value: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function limit(value: number, maximum = 20): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) confluenceFailure('invalid_request');
  return Math.min(value, maximum);
}
function quote(value: string): string { return `"${value.replace(/[\\"]/g, '\\$&')}"`; }
function boundedLabel(value: string): string {
  let result = '';
  for (const point of value.normalize('NFC')) { if (Buffer.byteLength(result + point, 'utf8') > 256) break; result += point; }
  return result;
}
function metadata(raw: unknown, body = false): Page {
  const record = confluenceRecord(raw);
  const version = confluenceRecord(record.version);
  const number = version.number;
  if (!Number.isSafeInteger(number) || (number as number) < 1) confluenceFailure('invalid_output');
  const status = confluenceString(record.status, 32);
  if (!STATUSES.includes(status)) confluenceFailure('invalid_output');
  const occurred = version.createdAt ?? record.createdAt;
  let occurred_at: string | undefined;
  if (occurred !== undefined) {
    if (typeof occurred !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(occurred) || !Number.isFinite(Date.parse(occurred))) confluenceFailure('invalid_output');
    occurred_at = new Date(occurred).toISOString().slice(0, 10);
  }
  let document: string | undefined;
  if (body) {
    const representation = confluenceRecord(confluenceRecord(record.body).atlas_doc_format);
    if (representation.representation !== undefined && representation.representation !== 'atlas_doc_format') confluenceFailure('invalid_output');
    if (typeof representation.value !== 'string') confluenceFailure('invalid_output');
    document = representation.value;
  }
  return Object.freeze({ id: confluenceString(record.id, 20, ID), space_id: confluenceString(record.spaceId, 20, ID),
    title: confluenceString(record.title, 1024), version: String(number), status,
    ...(occurred_at === undefined ? {} : { occurred_at, date_kind: version.createdAt === undefined || version.createdAt === null ? 'created' as const : 'version_created' as const }), ...(document === undefined ? {} : { document }) });
}
function samePage(left: Page, right: Page): boolean {
  return left.id === right.id && left.space_id === right.space_id && left.version === right.version && left.title === right.title && left.status === right.status && left.occurred_at === right.occurred_at && left.date_kind === right.date_kind;
}
function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) confluenceFailure('invalid_request');
  return value;
}

/** Metadata-only discovery, followed by bounded text opens, under one current personal grant. */
export async function createConfluencePersonLiveEvidenceReaderV1(options: {
  readonly binding: PersonConnectorReadBindingV1;
  readonly transport: ConfluenceCloudTransportV1;
  readonly space_ids?: readonly string[];
  readonly expected_origin?: string;
  readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceReaderV1<PersonPageCitationV1>> {
  const binding = copyConfluenceBindingV1(options.binding);
  const bindingHash = canonicalSha256(binding);
  const cloud = binding.external_scope_id!;
  const selected = options.space_ids === undefined ? undefined : Object.freeze([...new Set(options.space_ids)]);
  if (selected !== undefined && (selected.length === 0 || selected.length > 20 || selected.some(id => !ID.test(id)))) confluenceFailure('invalid_request');
  const handles = new Map<string, Item>();
  const issued = new Map<string, Item>();
  const cursors = new Map<string, Cursor>();
  let requests = 0;
  let origin = options.expected_origin;
  const transport: ConfluenceCloudTransportV1 = Object.freeze({ binding, async request(input: Parameters<ConfluenceCloudTransportV1['request']>[0]) {
    if (++requests > MAX_REQUESTS) confluenceFailure('unavailable');
    return options.transport.request(input);
  } });
  function current(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (canonicalSha256(options.transport.binding) !== bindingHash) confluenceFailure('stale_access_state');
  }
  async function verify(signal?: AbortSignal): Promise<void> {
    current(signal);
    const result = await verifyConfluenceConnectionV1(transport, { signal, expected_origin: origin,
      require_account(account) { if (account !== binding.external_subject_id) confluenceFailure('unauthorized'); } });
    origin = result.origin;
    current(signal);
  }
  function inScope(page: Page): void { if (selected !== undefined && !selected.includes(page.space_id)) confluenceFailure('unauthorized'); }
  function permalink(page: Page): string { return `${origin}/wiki/pages/viewpage.action?pageId=${page.id}`; }
  async function exact(id: string, body: boolean, status?: string, signal?: AbortSignal): Promise<Page> {
    const page = metadata(await transport.request({ path: `/api/v2/pages/${id}`, query: { ...(body ? { 'body-format': 'atlas_doc_format' } : {}), ...(status === undefined ? {} : { status }) }, signal }), body);
    if (page.id !== id) confluenceFailure('invalid_output');
    inScope(page);
    return page;
  }
  async function parallel<T, R>(values: readonly T[], fn: (value: T) => Promise<R>): Promise<R[]> {
    const result: R[] = [];
    for (let offset = 0; offset < values.length; offset += 4) result.push(...await Promise.all(values.slice(offset, offset + 4).map(fn)));
    return result;
  }
  function remember(item: Item): PersonLiveEvidenceValueV1<PersonPageCitationV1> {
    if (handles.size >= MAX_HANDLES) confluenceFailure('unavailable');
    const citation = validatePersonPageCitationV1({ kind: 'page', tool_id: 'confluence', external_scope_id: cloud,
      page_id: item.page.id, section_id: item.section, version: item.page.version,
      permalink: permalink(item.page), text_sha256: item.text === undefined ? EMPTY_DIGEST : textDigest(item.text) });
    const handle = `confluence_item_${randomUUID()}`;
    // Page bodies are never needed in a handle or audit. Keep only the released section in request memory.
    const { document: _document, ...page } = item.page;
    const saved: Item = Object.freeze({ ...item, page: Object.freeze(page) });
    handles.set(handle, saved);
    issued.set(canonicalSha256(citation), saved);
    const label = item.section.startsWith('continue:') ? `Continue ${item.page.title} from section ${item.offset + 1}`
      : item.section === 'inventory' ? item.page.title : `${item.page.title} · section ${item.offset + 1}`;
    return Object.freeze({ citation, handle, label: boundedLabel(label), visibility: 'only_me',
      attributes: Object.freeze({ status: item.page.status }), ...(item.page.occurred_at === undefined ? {} : { occurred_at: item.page.occurred_at, date_kind: item.page.date_kind }),
      ...(item.text === undefined ? {} : { text: item.text }) });
  }
  function inventory(page: Page): Item { return Object.freeze({ page, section: 'inventory', offset: 0 }); }
  function nextToken(raw: unknown, path: string): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    const link = confluenceString(raw, 8192);
    let url: URL;
    try { url = new URL(link, API_ORIGIN); } catch { confluenceFailure('invalid_output'); }
    const allowed = [path, `/wiki${path}`, `/ex/confluence/${cloud}/wiki${path}`];
    if (url.origin !== API_ORIGIN || url.username !== '' || url.password !== '' || url.hash !== '' || !allowed.includes(url.pathname) || url.searchParams.getAll('cursor').length !== 1) confluenceFailure('invalid_output');
    // Atlassian repeats limit/status/space-id in next links. Preserve our own
    // operation and scope; only the cursor token is consumed from this URL.
    return confluenceString(url.searchParams.get('cursor'), 4096);
  }
  async function spaceKeys(signal?: AbortSignal): Promise<readonly string[] | undefined> {
    if (selected === undefined) return undefined;
    const keys = await parallel(selected, async id => {
      try {
        const space = confluenceRecord(await transport.request({ path: `/api/v2/spaces/${id}`, signal }));
        if (confluenceString(space.id, 20, ID) !== id) confluenceFailure('invalid_output');
        return confluenceString(space.key, 256);
      } catch (error) {
        // Different project members can see different subsets of mapped spaces.
        // The operation's final connection fence still detects a revoked grant.
        if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'not_found')) return undefined;
        throw error;
      }
    });
    return Object.freeze(keys.filter((key): key is string => key !== undefined));
  }
  async function cql(query: string | undefined, since: string | undefined, until: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    const keys = await spaceKeys(signal);
    if (keys?.length === 0) return undefined;
    const clauses = ['type = page'];
    if (query !== undefined) clauses.push(`text ~ ${quote(query)}`);
    if (keys !== undefined) clauses.push(`space IN (${keys.map(quote).join(', ')})`);
    if (since !== undefined) clauses.push(`lastmodified >= ${quote(day(since))}`);
    if (until !== undefined) {
      // CQL dates are midnight boundaries: include the full final day.
      const next = new Date(`${day(until)}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      clauses.push(`lastmodified < ${quote(next.toISOString().slice(0, 10))}`);
    }
    return clauses.join(' AND ');
  }
  async function discover(path: string, query: Readonly<Record<string, string | readonly string[]>>, maximum: number, signal?: AbortSignal): Promise<{ pages: readonly Page[]; token?: string }> {
    const response = confluenceRecord(await transport.request({ path, query, signal }));
    const rows = confluenceArray(response.results, maximum);
    let pages: readonly Page[];
    if (path === '/rest/api/search') {
      const ids = rows.map(row => {
        const content = confluenceRecord(confluenceRecord(row).content);
        if (content.type !== 'page') confluenceFailure('invalid_output');
        return confluenceString(content.id, 20, ID);
      });
      // CQL uses v1 content envelopes. Fetch only v2 metadata, never assume the
      // v1 fields are the v2 page schema or release a search excerpt as evidence.
      pages = await parallel(ids, id => exact(id, false, undefined, signal));
    } else pages = rows.map(row => metadata(row));
    if (new Set(pages.map(page => page.id)).size !== pages.length) confluenceFailure('invalid_output');
    pages.forEach(inScope);
    const links = response._links === undefined ? {} : confluenceRecord(response._links);
    const token = nextToken(links.next, path);
    return { pages, ...(token === undefined ? {} : { token }) };
  }
  async function revalidateMetadata(groups: readonly (readonly Item[])[], signal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < groups.length; offset += REVALIDATION_BATCH_SIZE) {
      const batch = groups.slice(offset, offset + REVALIDATION_BATCH_SIZE);
      const expected = new Map(batch.map(items => [items[0]!.page.id, items]));
      const returned = new Set<string>();
      const tokens = new Set<string>();
      let cursor: string | undefined;
      do {
        current(signal);
        // GET /pages applies the asker's current permissions to this exact ID
        // set. Never retrieve bodies merely to revalidate inventory metadata.
        const response = confluenceRecord(await transport.request({ path: '/api/v2/pages',
          query: { id: [...expected.keys()], limit: String(batch.length), status: LIST_STATUSES,
            ...(cursor === undefined ? {} : { cursor }) }, signal }));
        current(signal);
        const rows = confluenceArray(response.results, batch.length);
        for (const raw of rows) {
          const page = metadata(raw);
          const items = expected.get(page.id);
          if (items === undefined || returned.has(page.id)) confluenceFailure('invalid_output');
          inScope(page);
          if (items.some(item => !samePage(item.page, page))) confluenceFailure('stale_access_state');
          returned.add(page.id);
        }
        const links = response._links === undefined ? {} : confluenceRecord(response._links);
        cursor = nextToken(links.next, '/api/v2/pages');
        if (cursor !== undefined) {
          // Each continuation must advance within the finite requested set.
          if (rows.length === 0 || returned.size === expected.size || tokens.has(cursor)) confluenceFailure('invalid_output');
          tokens.add(cursor);
        }
      } while (cursor !== undefined);
      if (returned.size !== expected.size) confluenceFailure('not_found');
    }
  }
  await verify(options.signal);
  return Object.freeze({
    binding,
    validateCitation(raw) {
      const citation = validatePersonPageCitationV1(raw);
      const item = issued.get(canonicalSha256(citation));
      if (item === undefined || citation.permalink !== permalink(item.page)) confluenceFailure('unauthorized');
      return Object.freeze({ citation, tool_id: 'confluence', external_scope_id: cloud,
        coordinates: Object.freeze({ object_id: `${item.page.id}:${item.section}:${item.page.version}`, container_id: item.page.space_id }) });
    },
    async search(input): Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>> {
      const maximum = limit(input.limit, 5);
      const query = confluenceString(input.query, 1024).trim();
      if (query === '') confluenceFailure('invalid_request');
      await verify(input.signal);
      const expression = await cql(query, undefined, undefined, input.signal);
      const result = expression === undefined ? { pages: [] } : await discover('/rest/api/search', { cql: expression, limit: String(maximum), includeArchivedSpaces: 'true' }, maximum, input.signal);
      await verify(input.signal);
      return Object.freeze({ items: Object.freeze(result.pages.map(page => remember(inventory(page)))), truncated: result.token !== undefined });
    },
    async list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>> {
      const maximum = limit(input.limit);
      const container = input.container === undefined ? undefined : confluenceString(input.container, 20, ID);
      if (selected !== undefined && container !== undefined && !selected.includes(container)) confluenceFailure('unauthorized');
      if (input.since !== undefined) day(input.since);
      if (input.until !== undefined) day(input.until);
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) confluenceFailure('invalid_request');
      const selection = canonicalSha256({ container: container ?? null, since: input.since ?? null, until: input.until ?? null, maximum });
      const previous = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (previous === undefined || previous.selection !== selection)) confluenceFailure('invalid_request');
      await verify(input.signal);
      let path = '/api/v2/pages';
      let query: Readonly<Record<string, string | readonly string[]>>;
      if (previous !== undefined) { path = previous.path; query = { ...previous.query, cursor: previous.token }; }
      else if (input.since !== undefined || input.until !== undefined) {
        if (container !== undefined) confluenceFailure('invalid_request');
        const expression = await cql(undefined, input.since, input.until, input.signal);
        if (expression === undefined) { await verify(input.signal); return Object.freeze({ items: Object.freeze([]), truncated: false }); }
        path = '/rest/api/search'; query = { cql: expression, limit: String(maximum), includeArchivedSpaces: 'true' };
      } else query = { limit: String(maximum), status: LIST_STATUSES, ...(container === undefined ? selected === undefined ? {} : { 'space-id': selected } : { 'space-id': container }) };
      const result = await discover(path, query, maximum, input.signal);
      await verify(input.signal);
      let next_cursor: string | undefined;
      if (result.token !== undefined) {
        if (cursors.size >= MAX_HANDLES) confluenceFailure('unavailable');
        next_cursor = `confluence_cursor_${randomUUID()}`;
        const { cursor: _cursor, ...stable } = query;
        cursors.set(next_cursor, Object.freeze({ selection, path, query: Object.freeze(stable), token: result.token }));
      }
      return Object.freeze({ items: Object.freeze(result.pages.map(page => remember(inventory(page)))), truncated: next_cursor !== undefined, ...(next_cursor === undefined ? {} : { next_cursor }) });
    },
    async open(input): Promise<PersonLiveEvidencePageV1<PersonPageCitationV1>> {
      const maximum = limit(input.limit, 8);
      const item = handles.get(input.handle);
      if (item === undefined) confluenceFailure('not_found');
      await verify(input.signal);
      const page = await exact(item.page.id, true, item.page.status, input.signal);
      if (!samePage(page, item.page)) confluenceFailure('stale_access_state');
      const normalized = normalizeConfluencePageDocumentV1(page.document!);
      const texts = normalized.sections;
      if (item.offset >= texts.length) confluenceFailure('stale_access_state');
      if (item.text !== undefined && textDigest(texts[item.offset]!) !== textDigest(item.text)) confluenceFailure('stale_access_state');
      const single = item.text !== undefined;
      const remaining = single ? 1 : texts.length - item.offset;
      if (remaining > 1 && maximum < 2) confluenceFailure('invalid_request');
      const count = remaining > maximum ? maximum - 1 : Math.min(remaining, maximum);
      const result: Item[] = [];
      for (let index = item.offset; index < item.offset + count; index += 1) {
        // Empty/whitespace-only pages contain no releasable evidence.
        if (texts[index]!.trim() !== '') result.push(Object.freeze({ page, section: `s${index + 1}`, offset: index, text: texts[index]! }));
      }
      const hasMore = !single && item.offset + count < texts.length;
      if (hasMore) result.push(Object.freeze({ page, section: `continue:${item.offset + count}`, offset: item.offset + count }));
      await verify(input.signal);
      return Object.freeze({ items: Object.freeze(result.map(remember)), truncated: hasMore,
        ...(normalized.incomplete ? { notice: 'Some Confluence page content could not be fully represented as text.' } : {}) });
    },
    async revalidate(input): Promise<void> {
      await verify(input.signal);
      const grouped = new Map<string, Item[]>();
      for (const raw of input.citations) {
        const citation = validatePersonPageCitationV1(raw);
        const item = issued.get(canonicalSha256(citation));
        if (item === undefined) confluenceFailure('unauthorized');
        const values = grouped.get(item.page.id) ?? []; values.push(item); grouped.set(item.page.id, values);
      }
      const metadataOnly: Item[][] = [];
      const exactReads: Item[][] = [];
      for (const items of grouped.values()) {
        // The bulk endpoint does not accept draft/historical statuses. Opened
        // bodies also keep their exact read and same-version digest check.
        (items.every(item => item.text === undefined && LIST_STATUSES.includes(item.page.status)) ? metadataOnly : exactReads).push(items);
      }
      await revalidateMetadata(metadataOnly, input.signal);
      await parallel(exactReads, async items => {
        const needsBody = items.some(item => item.text !== undefined);
        const page = await exact(items[0]!.page.id, needsBody, items[0]!.page.status, input.signal);
        const normalized = needsBody ? normalizeConfluencePageDocumentV1(page.document!) : undefined;
        for (const item of items) {
          if (!samePage(item.page, page)) confluenceFailure('stale_access_state');
          if (item.text !== undefined && (normalized?.sections[item.offset] === undefined || textDigest(normalized.sections[item.offset]!) !== textDigest(item.text))) confluenceFailure('stale_access_state');
        }
      });
      await verify(input.signal);
    },
  } satisfies PersonLiveEvidenceReaderV1<PersonPageCitationV1>);
}
