import { evidenceDateFilterV1, evidenceDayV1, matchesEvidenceDateV1, validateEvidenceDateFilterV1, type EvidenceDateFilterV1 } from "@echo-brain/organization-authority-kernel/shared/temporal-query-v1";
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonTicketCitationV1, type PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { observeCoreRuntimeDiagnosticV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createAtlassianVerificationBatchV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { jiraProjectMatches, parseJiraIssueV1, parseJiraProject, verifyJiraConnectionV1, type ParsedJiraIssueV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

const INVENTORY_FIELDS = 'summary,project,created,updated,status,assignee,duedate';
const TEXT_FIELDS = `${INVENTORY_FIELDS},description`;
const OPEN_FIELDS = `${TEXT_FIELDS},issuelinks`;
const REQUEST_MAX_HANDLES = 512;
const REVALIDATION_BATCH_SIZE = 50;
/**
 * One list page is one search plus one bulk read. 25 matches the research
 * loop's shown page; at worst-case label, owner and status bytes a page of
 * 25 still fits the shared 64 KiB result bound, which 50 would not.
 */
const LIST_MAX_ITEMS = 25;
/** One-hop expansion is deliberately bounded; deeper traversal requires an explicit existing open. */
const OPEN_RELATED_MAX_ITEMS = 4;

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

/** A relaxed retry drops one word at a time; past this many words it would be too broad and too long. */
const RELAXED_SEARCH_MAX_TERMS = 6;

interface SearchTerms {
  /** Distinct literal keywords, compared case-insensitively. */
  readonly terms: readonly string[];
  /** Distinct issue keys among the terms, ignoring surrounding punctuation. */
  readonly keys: readonly string[];
  /** Which of `terms` name an issue key, by the same rule as `keys`. */
  readonly keyed: readonly boolean[];
}

/** Shared keyword semantics. Never caller-authored JQL or Lucene operators. */
function searchTerms(query: string): SearchTerms {
  if (typeof query !== 'string' || query.trim() === '' || Buffer.byteLength(query, 'utf8') > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)) jiraFailure('invalid_request');
  const terms = [...new Map(query.trim().split(/\s+/u).map(term => [term.toLowerCase(), term])).values()];
  if (terms.length > 32) jiraFailure('invalid_request');
  const normalized = terms.map(term => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toUpperCase());
  const keyed = normalized.map(term => JIRA_TICKET_KEY.test(term));
  const keys = [...new Set(normalized.filter((_, index) => keyed[index]))];
  return Object.freeze({ terms: Object.freeze(terms), keys: Object.freeze(keys), keyed: Object.freeze(keyed) });
}

/**
 * Every term as an escaped literal text clause. The relaxed form, for one
 * retry after an empty search, matches all terms but one word: an OR of
 * each word dropped in turn, with every named key kept in every clause, so a
 * key nothing matched never falls out of the search. With two words and no
 * key that is a plain OR; with one word and a key, the key's clause alone.
 */
function textJql(terms: readonly string[], keyed: readonly boolean[], relaxed: boolean, projectId?: string): string {
  const clause = (term: string) => `text ~ ${JSON.stringify(`"${term.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')}"`)}`;
  const expression = relaxed
    ? terms.flatMap((_, dropped) => (keyed[dropped] ? [] : [`(${terms.filter((_, index) => index !== dropped).map(clause).join(' AND ')})`])).join(' OR ')
    : terms.map(clause).join(' AND ');
  return `${projectId === undefined ? expression : `project = ${projectId} AND (${expression})`} ORDER BY created DESC, id DESC`;
}

/** A UTC day moved by whole days, or undefined once it leaves the four-digit years a JQL date can name. */
function shiftDay(day: string, days: number): string | undefined {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const shifted = value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(shifted) ? shifted : undefined;
}

/**
 * Inventory JQL. JQL dates use the account timezone, so the created bounds are
 * coarse, with one day of margin either side; the exact UTC filter stays in code.
 * A bound past four-digit years is left out rather than sent malformed.
 */
function listJql(projectId: string | undefined, since: string | undefined, until: string | undefined, selection: EvidenceDateFilterV1 = {}): string {
  const field = selection.date_field ?? "created";
  const lower = since === undefined ? undefined : shiftDay(since, selection.time_zone === undefined ? -1 : -2);
  const upper = until === undefined ? undefined : shiftDay(until, selection.time_zone === undefined ? 2 : 3);
  const clauses = [
    ...(projectId === undefined ? [] : [`project = ${projectId}`]),
    // The search endpoint refuses an unbounded query; a site-wide list keeps a created restriction.
    ...(lower !== undefined ? [`${field} >= "${lower}"`] : projectId === undefined ? ['created >= "1970-01-01"'] : []),
    ...(upper === undefined ? [] : [`${field} < "${upper}"`]),
  ];
  return `${clauses.join(' AND ')} ORDER BY ${field} DESC, id DESC`;
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

  const verificationBatch = createAtlassianVerificationBatchV1(async (signal?: AbortSignal) => {
    const previousOrigin = pinnedOrigin;
    const previousProjectId = pinnedProject?.id;
    const { origin } = await verifyJiraConnectionV1(transport, { signal, expected_origin: previousOrigin });
    let project: ReturnType<typeof parseJiraProject> | undefined;
    if (fixedProject !== undefined) {
      project = parseJiraProject(await transport.request({ path: `${pathPrefix}/project/${fixedProject}`, query: { expand: 'projectKeys' }, signal }), origin, apiPrefix);
      signal?.throwIfAborted();
      if (!jiraProjectMatches(project, fixedProject)) jiraFailure('invalid_output');
      if (previousProjectId !== undefined && project.id !== previousProjectId) jiraFailure('stale_access_state');
    }
    return Object.freeze({ origin, project });
  });

  async function verifyConnection(signal?: AbortSignal): Promise<string> {
    // The local binding and caller abort fence remain caller-specific even
    // when several checks share a not-yet-started remote verification.
    signal?.throwIfAborted();
    if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('stale_access_state');
    const current = await verificationBatch(signal);
    signal?.throwIfAborted();
    if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('stale_access_state');
    pinnedOrigin = current.origin;
    if (current.project !== undefined) pinnedProject = current.project;
    return current.origin;
  }

  async function issue(id: string, origin: string, inventory: boolean, signal?: AbortSignal, related = false): Promise<ParsedJiraIssueV1> {
    const value = await transport.request({ path: `${pathPrefix}/issue/${id}`, query: { fields: inventory ? INVENTORY_FIELDS : related ? OPEN_FIELDS : TEXT_FIELDS }, signal });
    signal?.throwIfAborted();
    const parsed = parseJiraIssueV1(value, { cloudid, origin, inventory, related });
    if (parsed.id !== id) jiraFailure('invalid_output');
    // Exact reads fence stale search pages, moved tickets and retained handles.
    if (pinnedProject !== undefined && parsed.project_id !== pinnedProject.id) jiraFailure('unauthorized');
    return parsed;
  }

  /** A direct link is only an optional navigation hint. Never release a hidden or moved target. */
  async function relatedIssue(id: string, origin: string, signal?: AbortSignal): Promise<ParsedJiraIssueV1 | undefined> {
    try {
      return await issue(id, origin, true, signal);
    } catch (error) {
      // Jira commonly represents an inaccessible or deleted linked issue as
      // 403/404. Its link stub is not evidence, so omit only those targets.
      // Transient, malformed and stale-state failures still fail closed.
      if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'not_found')) return undefined;
      throw error;
    }
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
    observeCoreRuntimeDiagnosticV1({ kind: 'provider_query', provider: 'jira', operation: 'search', query: input.jql, max_results: input.maximum });
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
    // Search is eventually consistent. Current reads enforce issue security
    // before exposing even a title; results keep discovery order.
    for (const current of await currentIssues(discovered, input.origin, input.inventory, input.signal)) {
      if (input.projectId !== undefined && current.project_id !== input.projectId) jiraFailure('invalid_output');
      selected.push(current);
    }
    return { selected, token, tokens, ids };
  }

  /**
   * One bulk fetch per discovered page; it applies current issue permissions.
   * It omits hidden and deleted issues without saying which, so an omitted hit
   * gets its own exact read, whose refusal fails the page as before.
   */
  async function currentIssues(ids: readonly string[], origin: string, inventory: boolean, signal?: AbortSignal): Promise<readonly ParsedJiraIssueV1[]> {
    if (ids.length === 0) return Object.freeze([]);
    const page = jiraRecord(await transport.request({ path: `${pathPrefix}/issue/bulkfetch`, method: 'POST',
      body: { issueIdsOrKeys: [...ids], fields: (inventory ? INVENTORY_FIELDS : TEXT_FIELDS).split(',') }, signal }));
    signal?.throwIfAborted();
    // issueErrors are retriable failures, never a partial page.
    if (jiraArray(page.issueErrors === undefined ? [] : page.issueErrors, ids.length).length > 0) jiraFailure('unavailable');
    const expected = new Set(ids);
    const found = new Map<string, ParsedJiraIssueV1>();
    for (const raw of jiraArray(page.issues, ids.length)) {
      const parsed = parseJiraIssueV1(raw, { cloudid, origin, inventory });
      if (!expected.has(parsed.id) || found.has(parsed.id)) jiraFailure('invalid_output');
      if (pinnedProject !== undefined && parsed.project_id !== pinnedProject.id) jiraFailure('unauthorized');
      found.set(parsed.id, parsed);
    }
    const missing = ids.filter(id => !found.has(id));
    for (let offset = 0; offset < missing.length; offset += 4) {
      for (const parsed of await Promise.all(missing.slice(offset, offset + 4).map(id => issue(id, origin, inventory, signal)))) found.set(parsed.id, parsed);
    }
    return Object.freeze(ids.map(id => found.get(id)!));
  }

  /**
   * Issue keys named in a search, read through the bulk issue read rather than
   * JQL: Jira refuses a whole JQL query when one named key is missing or
   * hidden, while the bulk read applies current permissions and simply omits
   * it. A missing, hidden or out-of-scope key is no match, not a failure.
   */
  async function keyIssues(keys: readonly string[], origin: string, signal?: AbortSignal): Promise<readonly ParsedJiraIssueV1[]> {
    if (keys.length === 0) return Object.freeze([]);
    // Diagnostics name the lookup in JQL form; it runs as a bulk read.
    observeCoreRuntimeDiagnosticV1({ kind: 'provider_query', provider: 'jira', operation: 'search', query: `key in (${keys.map(key => JSON.stringify(key)).join(', ')})`, max_results: keys.length });
    const page = jiraRecord(await transport.request({ path: `${pathPrefix}/issue/bulkfetch`, method: 'POST',
      body: { issueIdsOrKeys: [...keys], fields: INVENTORY_FIELDS.split(',') }, signal }));
    signal?.throwIfAborted();
    if (jiraArray(page.issueErrors === undefined ? [] : page.issueErrors, keys.length).length > 0) jiraFailure('unavailable');
    const ids = new Set<string>();
    const found: ParsedJiraIssueV1[] = [];
    for (const raw of jiraArray(page.issues, keys.length)) {
      // A moved issue answers to its old key with its current one, so keys cannot be matched one to one.
      const parsed = parseJiraIssueV1(raw, { cloudid, origin, inventory: true });
      if (ids.has(parsed.id)) jiraFailure('invalid_output');
      ids.add(parsed.id);
      if (pinnedProject === undefined || parsed.project_id === pinnedProject.id) found.push(parsed);
    }
    // Bulk results arrive in id order; answer in the order the keys were named.
    const rank = (issue: ParsedJiraIssueV1) => { const index = keys.indexOf(issue.key); return index < 0 ? keys.length : index; };
    return Object.freeze(found.sort((left, right) => rank(left) - rank(right)));
  }

  /**
   * The anchor's direct Jira links are only opaque IDs. Every selected linked
   * issue receives its own current exact read before metadata is released;
   * linked bodies remain unavailable until the caller opens that item ref.
   */
  function openIssue(id: string, maximum: number, signal?: AbortSignal, expandRelated = true): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
    return safe(async () => {
      const origin = await verifyConnection(signal);
      let selected: ParsedJiraIssueV1;
      let relatedIds: readonly string[];
      let related: readonly (ParsedJiraIssueV1 | undefined)[];
      try {
        selected = await issue(id, origin, false, signal, expandRelated);
        relatedIds = expandRelated ? selected.related_issue_ids.slice(0, Math.min(OPEN_RELATED_MAX_ITEMS, Math.max(0, maximum - 1))) : Object.freeze([]);
        related = await Promise.all(relatedIds.map(relatedId => relatedIssue(relatedId, origin, signal)));
      } finally {
        // A link target may be omitted, but every open still finishes with a
        // fresh account/resource/project fence before it can issue handles.
        await verifyConnection(signal);
      }
      const visibleRelated = related.filter((item): item is ParsedJiraIssueV1 => item !== undefined);
      return Object.freeze({ items: remember([selected, ...visibleRelated]),
        truncated: selected.truncated || selected.related_truncated || visibleRelated.some(item => item.truncated) || visibleRelated.length !== relatedIds.length || relatedIds.length !== selected.related_issue_ids.length });
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
      validateEvidenceDateFilterV1(input, ["created", "updated", "due"]);
      const maximum = Math.min(limit(input.limit), 5);
      const { terms, keys, keyed } = searchTerms(input.query);
      const projectId = pinnedProject?.id;
      const named = keys.slice(0, maximum);
      // A query of only keys is a key lookup. Otherwise named keys match
      // exactly, or as words alongside the rest: key in (...) OR every term.
      const text = keys.length === terms.length ? undefined : terms;
      const words = keyed.filter(key => !key).length;
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const textPage = (relaxed: boolean) => {
          const wordsJql = textJql(text!, keyed, relaxed, projectId);
          const datesJql = listJql(undefined, input.since, input.until, input);
          const jql = input.since === undefined && input.until === undefined ? wordsJql : `(${wordsJql.split(' ORDER BY ')[0]}) AND ${datesJql}`;
          return searchPage({ jql, maximum, origin, inventory: true, projectId, signal: input.signal }); };
        const [byKey, firstText] = await Promise.all([keyIssues(named, origin, input.signal), text === undefined ? undefined : textPage(false)]);
        let byText = firstText;
        // One bounded retry when nothing at all matched every term; only words are dropped.
        if (byKey.length === 0 && byText !== undefined && byText.selected.length === 0 && byText.token === undefined &&
            text!.length >= 2 && words >= 1 && words <= RELAXED_SEARCH_MAX_TERMS) byText = await textPage(true);
        await verifyConnection(input.signal);
        const seen = new Set(byKey.map(item => item.id));
        const matches = [...byKey, ...(byText?.selected ?? []).filter(item => !seen.has(item.id))].filter(item => matchesEvidenceDateV1(item.value.dates ?? {}, input, "created"));
        const selected = matches.slice(0, maximum);
        return Object.freeze({ items: remember(selected),
          truncated: byText?.token !== undefined || keys.length > named.length || matches.length > selected.length || selected.some(item => item.truncated) });
      }, input.signal);
    },
    async open(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      const maximum = limit(input.limit);
      const id = handles.get(input.handle);
      if (id === undefined) jiraFailure('not_found');
      return openIssue(id, maximum, input.signal);
    },
    async openCitation(input): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      const maximum = limit(input.limit);
      let citation: PersonTicketCitationV1;
      try { citation = validatePersonTicketCitationV1(input.citation); } catch { jiraFailure('invalid_request'); }
      if (citation.tool_id !== binding.tool_id || citation.external_scope_id !== cloudid || !JIRA_ID.test(citation.ticket_id)) jiraFailure('unauthorized');
      // A citation refresh proves the cited anchor remains readable. It does
      // not need to discover new neighboring metadata or pay link-read costs.
      return openIssue(citation.ticket_id, maximum, input.signal, false);
    },
    async list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<PersonTicketCitationV1>> {
      validateEvidenceDateFilterV1(input, ["created", "updated", "due"]);
      const maximum = Math.min(limit(input.limit), LIST_MAX_ITEMS);
      if (input.container !== undefined && (typeof input.container !== 'string' || !(JIRA_ID.test(input.container) || JIRA_PROJECT_KEY.test(input.container)))) jiraFailure('invalid_request');
      if (pinnedProject !== undefined && input.container !== undefined && input.container !== fixedProject && !jiraProjectMatches(pinnedProject, input.container)) jiraFailure('unauthorized');
      if (input.since !== undefined) jiraDay(input.since, 'invalid_request');
      if (input.until !== undefined) jiraDay(input.until, 'invalid_request');
      if (input.since !== undefined && input.until !== undefined && input.since > input.until) jiraFailure('invalid_request');
      const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null, ...evidenceDateFilterV1(input) });
      const cursor = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.selection !== selection)) jiraFailure('invalid_request');
      return safe(async () => {
        const origin = await verifyConnection(input.signal);
        const project = pinnedProject ?? (input.container === undefined ? undefined : parseJiraProject(await transport.request({ path: `${pathPrefix}/project/${input.container}`, query: { expand: 'projectKeys' }, signal: input.signal }), origin, apiPrefix));
        input.signal?.throwIfAborted();
        if (project !== undefined && input.container !== undefined && !jiraProjectMatches(project, input.container)) jiraFailure('invalid_output');
        if (cursor !== undefined && cursor.projectId !== project?.id) jiraFailure('stale_access_state');
        const jql = listJql(project?.id, input.since, input.until, input);
        const page = await searchPage({ jql, maximum, origin, inventory: true, cursor, projectId: project?.id, signal: input.signal });
        // UTC inclusive calendar days; the JQL date bounds are only coarse.
        const selected = page.selected.filter(item => matchesEvidenceDateV1(item.value.dates ?? {}, input, "created"));
        // Pages run newest first: once a page's oldest issue predates since, no later page can match.
        const oldest = page.selected.at(-1);
        const oldestDay = evidenceDayV1(oldest?.value.dates?.[input.date_field ?? "created"], input.time_zone);
        const token = input.since !== undefined && oldestDay !== undefined && oldestDay < input.since ? undefined : page.token;
        await verifyConnection(input.signal);
        const items = remember(selected);
        let next_cursor: string | undefined;
        if (token !== undefined) {
          if (cursors.size >= REQUEST_MAX_HANDLES) jiraFailure('unavailable');
          next_cursor = `jira_cursor_${randomUUID()}`;
          cursors.set(next_cursor, { selection, token, projectId: project?.id, tokens: page.tokens, ids: page.ids });
        }
        // Jira's last page can be exactly full (ADR-0041): its end is confirmed only when the page held fewer issues than
        // asked for, or when the newest-first order passed since. Counted before ECHO's own date filter.
        const page_full = token === undefined && page.token === undefined && page.selected.length >= maximum;
        // Only a next page means more items exist. A summary cut to its label bound is one row's title, never a sign that
        // the list did not reach its end (ADR-0041).
        return Object.freeze({ items, truncated: token !== undefined, ...(next_cursor === undefined ? {} : { next_cursor }), page_full });
      }, input.signal);
    },
    async revalidate(input): Promise<void> {
      return safe(async () => {
        // An incremental check carries only tickets released since the caller's
        // last successful check (ADR-0038). It reads them against the pinned
        // site and then verifies the account, site and project pin once; a full
        // check also verifies before its reads.
        const origin = input.mode === 'incremental' && pinnedOrigin !== undefined ? pinnedOrigin : await verifyConnection(input.signal);
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
