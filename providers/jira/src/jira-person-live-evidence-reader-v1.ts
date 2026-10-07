import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonTicketCitationV1, type PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { jiraProjectMatches, parseJiraIssueV1, parseJiraProject, verifyJiraConnectionV1, type ParsedJiraIssueV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

const INVENTORY_FIELDS = 'summary,project,created,status,assignee,duedate';
const TEXT_FIELDS = `${INVENTORY_FIELDS},description`;
const REQUEST_MAX_HANDLES = 512;
const REVALIDATION_BATCH_SIZE = 50;

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

/** Shared keyword semantics, or an exact key. Never caller-authored JQL or Lucene operators. */
function searchJql(query: string, projectId?: string): string {
  if (typeof query !== 'string' || query.trim() === '' || Buffer.byteLength(query, 'utf8') > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)) jiraFailure('invalid_request');
  const terms = [...new Map(query.trim().split(/\s+/u).map(term => [term.toLowerCase(), term])).values()];
  if (terms.length > 32) jiraFailure('invalid_request');
  const ticketKey = query.trim().toUpperCase();
  const expression = JIRA_TICKET_KEY.test(ticketKey) ? `key = ${JSON.stringify(ticketKey)}` : terms.map(term => {
    const literal = term.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&');
    return `text ~ ${JSON.stringify(`"${literal}"`)}`;
  }).join(' AND ');
  return `${projectId === undefined ? expression : `project = ${projectId} AND (${expression})`} ORDER BY created DESC, id DESC`;
}

/** Construct once per request from trusted ECHO state, never from model arguments. */
export async function createJiraPersonLiveEvidenceReaderV1(options: {
  readonly binding: PersonConnectorReadBindingV1;
  readonly transport: JiraCloudTransportV1;
  readonly signal?: AbortSignal;
  readonly expected_origin?: string;
  /** Optional trusted composition scope. Models cannot widen or replace it. */
  readonly project?: string;
}): Promise<PersonLiveEvidenceReaderV1<PersonTicketCitationV1>> {
  const fixedProject = options.project;
  if (fixedProject !== undefined && (typeof fixedProject !== 'string' || !(JIRA_ID.test(fixedProject) || JIRA_PROJECT_KEY.test(fixedProject)))) jiraFailure('invalid_request');
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
  let pinnedProject: ReturnType<typeof parseJiraProject> | undefined;

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
    if (fixedProject !== undefined) {
      const current = parseJiraProject(await transport.request({ path: `${pathPrefix}/project/${fixedProject}`, query: { expand: 'projectKeys' }, signal }), origin, apiPrefix);
      signal?.throwIfAborted();
      if (!jiraProjectMatches(current, fixedProject)) jiraFailure('invalid_output');
      if (pinnedProject !== undefined && current.id !== pinnedProject.id) jiraFailure('stale_access_state');
      pinnedProject = current;
    }
    return origin;
  }

  async function issue(id: string, origin: string, inventory: boolean, signal?: AbortSignal): Promise<ParsedJiraIssueV1> {
    const value = await transport.request({ path: `${pathPrefix}/issue/${id}`, query: { fields: inventory ? INVENTORY_FIELDS : TEXT_FIELDS }, signal });
    signal?.throwIfAborted();
    const parsed = parseJiraIssueV1(value, { cloudid, origin, inventory });
    if (parsed.id !== id) jiraFailure('invalid_output');
    // Exact reads fence stale search pages, moved tickets and retained handles.
    if (pinnedProject !== undefined && parsed.project_id !== pinnedProject.id) jiraFailure('unauthorized');
    return parsed;
  }

  async function revalidateIssues(ids: readonly string[], origin: string, signal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += REVALIDATION_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + REVALIDATION_BATCH_SIZE);
      const page = jiraRecord(await transport.request({ path: `${pathPrefix}/issue/bulkfetch`, method: 'POST',
        body: { issueIdsOrKeys: batch, fields: INVENTORY_FIELDS.split(',') }, signal }));
      signal?.throwIfAborted();
      // Bulk fetch applies current issue permissions. Missing issues must not
      // be treated as a successful partial check; issueErrors are retriable failures.
      if (jiraArray(page.issueErrors === undefined ? [] : page.issueErrors, batch.length).length > 0) jiraFailure('unavailable');
      const expected = new Set(batch);
      const returned = new Set<string>();
      for (const raw of jiraArray(page.issues, batch.length)) {
        const parsed = parseJiraIssueV1(raw, { cloudid, origin, inventory: true });
        if (!expected.has(parsed.id) || returned.has(parsed.id)) jiraFailure('invalid_output');
        if (pinnedProject !== undefined && parsed.project_id !== pinnedProject.id) jiraFailure('unauthorized');
        returned.add(parsed.id);
      }
      if (returned.size !== expected.size) jiraFailure('not_found');
    }
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
    const discovered = jiraArray(page.issues, input.maximum).map(raw => {
      const reference = jiraRecord(raw);
      const id = jiraString(reference.id, 20, JIRA_ID);
      if (ids.has(id)) jiraFailure('invalid_output');
      ids.add(id);
      if (ids.size > REQUEST_MAX_HANDLES || tokens.size > REQUEST_MAX_HANDLES) jiraFailure('unavailable');
      return id;
    });
    for (let offset = 0; offset < discovered.length; offset += 4) {
      // Search is eventually consistent. Exact reads enforce current issue security before exposing even its title.
      // Independent reads overlap in bounded batches, with results admitted in
      // discovery order only after the entire batch passes its scope checks.
      const batch = await Promise.all(discovered.slice(offset, offset + 4).map(async id => {
        const current = await issue(id, input.origin, input.inventory, input.signal);
        if (input.projectId !== undefined && current.project_id !== input.projectId) jiraFailure('invalid_output');
        return current;
      }));
      selected.push(...batch);
    }
    return { selected, token, tokens, ids };
  }

  /** The exact read enforces current issue security and the project pin. */
  function openIssue(id: string, signal?: AbortSignal): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
    return safe(async () => {
      const origin = await verifyConnection(signal);
      const selected = await issue(id, origin, false, signal);
      await verifyConnection(signal);
      return Object.freeze({ items: remember([selected]), truncated: selected.truncated });
    }, signal);
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
      const jql = searchJql(input.query, pinnedProject?.id);
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const page = await searchPage({ jql, maximum, origin, inventory: true, projectId: pinnedProject?.id, signal: input.signal });
        await verifyConnection(input.signal);
        return Object.freeze({ items: remember(page.selected), truncated: page.token !== undefined || page.selected.some(item => item.truncated) });
      }, input.signal);
    },
    async open(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      limit(input.limit);
      const id = handles.get(input.handle);
      if (id === undefined) jiraFailure('not_found');
      return openIssue(id, input.signal);
    },
    async openCitation(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      limit(input.limit);
      let citation: PersonTicketCitationV1;
      try { citation = validatePersonTicketCitationV1(input.citation); } catch { jiraFailure('invalid_request'); }
      if (citation.tool_id !== binding.tool_id || citation.external_scope_id !== cloudid || !JIRA_ID.test(citation.ticket_id)) jiraFailure('unauthorized');
      return openIssue(citation.ticket_id, input.signal);
    },
    async list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      const maximum = Math.min(limit(input.limit), 20);
      if (input.container !== undefined && (typeof input.container !== 'string' || !(JIRA_ID.test(input.container) || JIRA_PROJECT_KEY.test(input.container)))) jiraFailure('invalid_request');
      if (pinnedProject !== undefined && input.container !== undefined && input.container !== fixedProject && !jiraProjectMatches(pinnedProject, input.container)) jiraFailure('unauthorized');
      if (input.since !== undefined) jiraDay(input.since, 'invalid_request');
      if (input.until !== undefined) jiraDay(input.until, 'invalid_request');
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) jiraFailure('invalid_request');
      const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null });
      const cursor = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.selection !== selection)) jiraFailure('invalid_request');
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const project = pinnedProject ?? (input.container === undefined ? undefined : parseJiraProject(await transport.request({ path: `${pathPrefix}/project/${input.container}`, query: { expand: 'projectKeys' }, signal: input.signal }), origin, apiPrefix));
        input.signal?.throwIfAborted();
        if (project !== undefined && input.container !== undefined && !jiraProjectMatches(project, input.container)) jiraFailure('invalid_output');
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
        await revalidateIssues([...ids], origin, input.signal);
        await verifyConnection(input.signal);
      }, input.signal);
    },
  } satisfies PersonLiveEvidenceReaderV1<PersonTicketCitationV1>);
}
