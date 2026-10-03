import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonTicketCitationV1, type PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { parseJiraIssueV1, parseJiraProject, verifyJiraConnectionV1, type ParsedJiraIssueV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

const INVENTORY_FIELDS = 'summary,project,created,status,assignee,duedate';
const TEXT_FIELDS = `${INVENTORY_FIELDS},description`;
const REQUEST_MAX_HANDLES = 512;

interface ListCursor {
  readonly selection: string;
  readonly token: string;
  readonly projectId?: string;
  readonly tokens: ReadonlySet<string>;
  readonly ids: ReadonlySet<string>;
}

function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) jiraFailure('invalid_request');
  return value;
}

/** A literal phrase, not caller-authored JQL or Lucene operators. */
function searchJql(query: string): string {
  if (typeof query !== 'string' || query.trim() === '' || Buffer.byteLength(query, 'utf8') > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)) jiraFailure('invalid_request');
  if (JIRA_TICKET_KEY.test(query)) return `key = ${JSON.stringify(query)} ORDER BY created DESC, id DESC`;
  const phrase = query.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&');
  return `text ~ ${JSON.stringify(`"${phrase}"`)} ORDER BY created DESC, id DESC`;
}

/** Construct once per request from trusted ECHO state, never from model arguments. */
export async function createJiraPersonLiveEvidenceReaderV1(options: {
  readonly binding: PersonConnectorReadBindingV1;
  readonly transport: JiraCloudTransportV1;
  readonly signal?: AbortSignal;
  readonly expected_origin?: string;
}): Promise<PersonLiveEvidenceReaderV1<PersonTicketCitationV1>> {
  const binding = copyJiraBindingV1(options.binding);
  const bindingDigest = canonicalSha256(binding);
  const transport = options.transport;
  if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('unauthorized');
  const cloudid = binding.external_scope_id!;
  const apiPrefix = `https://api.atlassian.com/ex/jira/${cloudid}`;
  const pathPrefix = `/ex/jira/${cloudid}/rest/api/3`;
  const handles = new Map<string, string>();
  const issued = new Map<string, string>();
  const cursors = new Map<string, ListCursor>();
  let pinnedOrigin: string | undefined = options.expected_origin;

  async function safe<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    try {
      const result = await operation();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AuthorityOperationError && ['invalid_request', 'invalid_output', 'unauthorized', 'not_found', 'stale_access_state', 'unavailable', 'rate_limited'].includes(error.code)) jiraFailure(error.code as Parameters<typeof jiraFailure>[0]);
      jiraFailure('unavailable');
    }
  }

  async function verifyConnection(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('stale_access_state');
    const { origin } = await verifyJiraConnectionV1(transport, { signal, expected_origin: pinnedOrigin });
    pinnedOrigin = origin;
    return origin;
  }

  async function issue(id: string, origin: string, inventory: boolean, signal?: AbortSignal): Promise<ParsedJiraIssueV1> {
    const value = await transport.request({ path: `${pathPrefix}/issue/${id}`, query: { fields: inventory ? INVENTORY_FIELDS : TEXT_FIELDS }, signal });
    signal?.throwIfAborted();
    const parsed = parseJiraIssueV1(value, { cloudid, origin, inventory });
    if (parsed.id !== id) jiraFailure('invalid_output');
    return parsed;
  }

  function remember(items: readonly ParsedJiraIssueV1[]): readonly PersonLiveEvidenceValueV1<PersonTicketCitationV1>[] {
    if (handles.size + items.length > REQUEST_MAX_HANDLES) jiraFailure('unavailable');
    return Object.freeze(items.map(item => {
      const handle = `jira_item_${randomUUID()}`;
      handles.set(handle, item.id);
      issued.set(canonicalSha256(item.value.citation), item.id);
      return Object.freeze({ ...item.value, handle });
    }));
  }

  async function searchPage(input: { readonly jql: string; readonly maximum: number; readonly origin: string; readonly inventory: boolean; readonly cursor?: ListCursor; readonly projectId?: string; readonly signal?: AbortSignal }) {
    const page = jiraRecord(await transport.request({ path: `${pathPrefix}/search/jql`, method: 'POST',
      body: { jql: input.jql, maxResults: input.maximum, fields: ['id'], ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor.token }) }, signal: input.signal }));
    input.signal?.throwIfAborted();
    if (typeof page.isLast !== 'boolean') jiraFailure('invalid_output');
    const token = page.nextPageToken === undefined || page.nextPageToken === null ? undefined : jiraString(page.nextPageToken, 4096);
    if (page.isLast ? token !== undefined : token === undefined) jiraFailure('invalid_output');
    const tokens = new Set(input.cursor?.tokens);
    if (token !== undefined) {
      if (tokens.has(token)) jiraFailure('invalid_output');
      tokens.add(token);
    }
    const ids = new Set(input.cursor?.ids);
    const selected: ParsedJiraIssueV1[] = [];
    for (const raw of jiraArray(page.issues, input.maximum)) {
      const reference = jiraRecord(raw);
      const id = jiraString(reference.id, 20, JIRA_ID);
      if (ids.has(id)) jiraFailure('invalid_output');
      ids.add(id);
      if (ids.size > REQUEST_MAX_HANDLES || tokens.size > REQUEST_MAX_HANDLES) jiraFailure('unavailable');
      // Search is eventually consistent. Exact reads enforce current issue security before exposing even its title.
      const current = await issue(id, input.origin, input.inventory, input.signal);
      if (input.projectId !== undefined && current.project_id !== input.projectId) jiraFailure('invalid_output');
      selected.push(current);
    }
    return { selected, token, tokens, ids };
  }

  await safe(() => verifyConnection(options.signal), options.signal);

  return Object.freeze({
    binding,
    validateCitation(value: unknown) {
      const citation = validatePersonTicketCitationV1(value);
      if (issued.get(canonicalSha256(citation)) !== citation.ticket_id || citation.tool_id !== 'jira' || citation.external_scope_id !== cloudid || !citation.permalink.startsWith(`${pinnedOrigin}/browse/`) || !JIRA_TICKET_KEY.test(new URL(citation.permalink).pathname.slice(8))) jiraFailure('invalid_output');
      return Object.freeze({ citation, tool_id: 'jira', external_scope_id: cloudid, coordinates: Object.freeze({ object_id: citation.ticket_id }) });
    },
    async search(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      const maximum = Math.min(limit(input.limit), 5);
      const jql = searchJql(input.query);
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const page = await searchPage({ jql, maximum, origin, inventory: false, signal: input.signal });
        await verifyConnection(input.signal);
        return Object.freeze({ items: remember(page.selected), truncated: page.token !== undefined || page.selected.some(item => item.truncated) });
      }, input.signal);
    },
    async open(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      limit(input.limit);
      const id = handles.get(input.handle);
      if (id === undefined) jiraFailure('not_found');
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const selected = await issue(id, origin, false, input.signal);
        await verifyConnection(input.signal);
        return Object.freeze({ items: remember([selected]), truncated: selected.truncated });
      }, input.signal);
    },
    async list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      const maximum = Math.min(limit(input.limit), 20);
      if (input.container !== undefined && (typeof input.container !== 'string' || !(JIRA_ID.test(input.container) || JIRA_PROJECT_KEY.test(input.container)))) jiraFailure('invalid_request');
      if (input.since !== undefined) jiraDay(input.since, 'invalid_request');
      if (input.until !== undefined) jiraDay(input.until, 'invalid_request');
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) jiraFailure('invalid_request');
      const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null });
      const cursor = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.selection !== selection)) jiraFailure('invalid_request');
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const project = input.container === undefined ? undefined : parseJiraProject(await transport.request({ path: `${pathPrefix}/project/${input.container}`, signal: input.signal }), origin, apiPrefix);
        input.signal?.throwIfAborted();
        if (project !== undefined && project.id !== input.container && project.key !== input.container) jiraFailure('invalid_output');
        if (cursor !== undefined && cursor.projectId !== project?.id) jiraFailure('stale_access_state');
        const jql = `${project === undefined ? 'created >= "1970-01-01"' : `project = ${project.id}`} ORDER BY created DESC, id DESC`;
        const page = await searchPage({ jql, maximum, origin, inventory: true, cursor, projectId: project?.id, signal: input.signal });
        // UTC inclusive calendar days. Jira JQL dates use the account timezone, so do not push these filters into JQL.
        const selected = page.selected.filter(item => (input.since === undefined || item.value.occurred_at! >= input.since) && (input.until === undefined || item.value.occurred_at! <= input.until));
        await verifyConnection(input.signal);
        const items = remember(selected);
        let next_cursor: string | undefined;
        if (page.token !== undefined) {
          if (cursors.size >= REQUEST_MAX_HANDLES) jiraFailure('unavailable');
          next_cursor = `jira_cursor_${randomUUID()}`;
          cursors.set(next_cursor, { selection, token: page.token, projectId: project?.id, tokens: page.tokens, ids: page.ids });
        }
        return Object.freeze({ items, truncated: page.token !== undefined || selected.some(item => item.truncated), ...(next_cursor === undefined ? {} : { next_cursor }) });
      }, input.signal);
    },
    async revalidate(input): Promise<void> {
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const ids = new Set<string>();
        for (const raw of jiraArray(input.citations, REQUEST_MAX_HANDLES)) {
          let citation: PersonTicketCitationV1;
          try { citation = validatePersonTicketCitationV1(raw); } catch { jiraFailure('invalid_request'); }
          const id = issued.get(canonicalSha256(citation));
          if (citation.tool_id !== binding.tool_id || citation.external_scope_id !== cloudid || id === undefined) jiraFailure('unauthorized');
          ids.add(id);
        }
        // Historical citations remain valid evidence bytes only while this exact person can still see the ticket.
        for (const id of ids) await issue(id, origin, true, input.signal);
        await verifyConnection(input.signal);
      }, input.signal);
    },
  } satisfies PersonLiveEvidenceReaderV1<PersonTicketCitationV1>);
}
