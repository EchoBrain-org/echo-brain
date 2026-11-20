import { normalizeAtlassianDocumentTextV1, splitAtlassianTextV1 } from '@echo-brain/provider-runtime/atlassian-document-text-v1';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_LABEL_MAX_BYTES_V1, type PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { JIRA_PERSON_PROVIDER_V1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraBoundText, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

/** Validate Jira's returned self link, but never use it as a fetch target. */
function jiraSelf(value: unknown, origin: string, apiPrefix: string, type: 'issue' | 'project', id: string, key: string): void {
  const self = jiraString(value, 1024);
  const candidates = [origin, apiPrefix].flatMap(base => [id, key].map(coordinate => `${base}/rest/api/3/${type}/${coordinate}`));
  if (!candidates.includes(self)) jiraFailure('invalid_output');
}

export function parseJiraProject(value: unknown, origin: string, apiPrefix: string): { readonly id: string; readonly key: string; readonly keys: readonly string[] } {
  const p = jiraRecord(value);
  const id = jiraString(p.id, 20, JIRA_ID); const key = jiraString(p.key, 64, JIRA_PROJECT_KEY);
  jiraSelf(p.self, origin, apiPrefix, 'project', id, key);
  const keys = p.projectKeys === undefined ? [] : jiraArray(p.projectKeys, 256).map(value => jiraString(value, 64, JIRA_PROJECT_KEY));
  return { id, key, keys: Object.freeze(keys) };
}

/** Historical keys are provider-verified aliases; project IDs still define the read boundary. */
export function jiraProjectMatches(project: ReturnType<typeof parseJiraProject>, selection: string): boolean {
  return project.id === selection || project.key === selection || project.keys.includes(selection);
}


export interface ParsedJiraIssueV1 {
  readonly id: string;
  readonly key: string;
  readonly project_id: string;
  readonly created_at: string;
  /** Direct provider references only; each is exact-read before its metadata is released. */
  readonly related_issue_ids: readonly string[];
  readonly value: Omit<PersonLiveEvidenceValueV1<PersonTicketCitationV1>, 'handle'>;
  /** The row's label was cut to its bound; the text stays whole (ADR-0041). */
  readonly truncated: boolean;
  /** Content the text cannot represent (a screenshot, a macro) was left out, with a marker where it was. */
  readonly incomplete: boolean;
  /** The ticket's whole text in sections of at most 3 KiB, the first being `value.text`; empty for an inventory read. */
  readonly sections: readonly string[];
}

/**
 * Jira includes summary/key/self data in link stubs. Those values are never
 * trusted or released: a link contributes only an opaque issue ID, and the
 * reader exact-reads that ID under the current connection before release.
 */
function relatedIssueIds(value: unknown, anchorId: string): readonly string[] {
  // Every link is inspected: the provider transport's 1 MiB response bound
  // already bounds the list, while a malformed present array or link is refused.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) jiraFailure('invalid_output');
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) jiraFailure('invalid_output');
    const raw = descriptor.value;
    const link = jiraRecord(raw);
    const inward = link.inwardIssue;
    const outward = link.outwardIssue;
    if ((inward === undefined) === (outward === undefined)) jiraFailure('invalid_output');
    const issue = jiraRecord(inward ?? outward);
    const id = jiraString(issue.id, 20, JIRA_ID);
    if (id !== anchorId) ids.add(id);
  }
  // Jira does not promise a useful link order. Numeric IDs are canonical,
  // non-zero decimal strings, so length then byte order is a stable order.
  return Object.freeze([...ids].sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)));
}

/** An issue's summary: one non-blank line, as long as the response that carried it. */
function issueSummary(fields: Record<string, unknown>): string {
  if (typeof fields.summary !== 'string' || fields.summary.trim() === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(fields.summary)) jiraFailure('invalid_output');
  return fields.summary;
}

/** An issue's description as text, empty when it has none; content it cannot represent is left out and `incomplete`. */
function issueDescription(fields: Record<string, unknown>): { readonly text: string; readonly incomplete: boolean } {
  if (fields.description === null) return { text: '', incomplete: false };
  const normalized = normalizeAtlassianDocumentTextV1(fields.description, JIRA_PERSON_PROVIDER_V1, { unsupported: 'omit' });
  return { text: normalized.text.trim(), incomplete: normalized.incomplete };
}

/** An issue's status name, its assignee's display name and its due day, when it has them. */
function issueState(fields: Record<string, unknown>): { readonly status: string; readonly owner?: string; readonly due_at?: string } {
  const status = jiraString(jiraRecord(fields.status).name, 128);
  const owner = fields.assignee === null ? undefined : jiraString(jiraRecord(fields.assignee).displayName, 128);
  const due_at = fields.duedate === null ? undefined : jiraDay(fields.duedate);
  return { status, ...(owner === undefined ? {} : { owner }), ...(due_at === undefined ? {} : { due_at }) };
}

export function parseJiraIssueV1(value: unknown, input: { readonly cloudid: string; readonly origin: string; readonly inventory: boolean; readonly related?: boolean }): ParsedJiraIssueV1 {
  const issue = jiraRecord(value);
  const id = jiraString(issue.id, 20, JIRA_ID); const key = jiraString(issue.key, 85, JIRA_TICKET_KEY);
  const apiPrefix = `https://api.atlassian.com/ex/jira/${input.cloudid}`;
  jiraSelf(issue.self, input.origin, apiPrefix, 'issue', id, key);
  const fields = jiraRecord(issue.fields);
  const project = parseJiraProject(fields.project, input.origin, apiPrefix);
  if (!key.startsWith(`${project.key}-`)) jiraFailure('invalid_output');
  const summary = issueSummary(fields);
  // The row's title within the evidence label bound; the whole summary stays in the ticket's text.
  const label = jiraBoundText(`${key}: ${summary}`, PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
  const rawCreated = jiraString(fields.created, 64, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/);
  jiraDay(rawCreated.slice(0, 10));
  const created = new Date(rawCreated);
  if (!Number.isFinite(created.getTime())) jiraFailure('invalid_output');
  const occurred_at = created.toISOString().slice(0, 10);
  const updated = fields.updated == null ? undefined : jiraString(fields.updated, 64, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/);
  if (updated !== undefined && !Number.isFinite(Date.parse(updated))) jiraFailure('invalid_output');
  const { status, owner, due_at } = issueState(fields);
  // Jira can omit this optional field when linking is disabled or unavailable.
  // That means no related context was discoverable, not that no link exists.
  // A field that is present must still have the expected safe array shape.
  const related_issue_ids = input.related && fields.issuelinks !== undefined ? relatedIssueIds(fields.issuelinks, id) : Object.freeze([]);
  const description = input.inventory ? undefined : issueDescription(fields);
  // The whole ticket text in lossless sections of the evidence text size, the way a Confluence page is read.
  const sections = description === undefined ? Object.freeze([]) : splitAtlassianTextV1(jiraBoundText(`${key}: ${summary}\n\n${description.text}`.trim(), Number.MAX_SAFE_INTEGER).text);
  const content = sections[0];
  const citation: PersonTicketCitationV1 = Object.freeze({ kind: 'ticket', tool_id: 'jira', external_scope_id: input.cloudid,
    ticket_id: id, permalink: `${input.origin}/browse/${key}`, text_sha256: sha256Digest(content ?? '') });
  return Object.freeze({ id, key, project_id: project.id, created_at: created.toISOString(), related_issue_ids,
    truncated: label.truncated, incomplete: description?.incomplete ?? false, sections,
    value: Object.freeze({ citation, label: label.text, visibility: 'only_me', occurred_at, date_kind: 'created', dates: Object.freeze({ created: created.toISOString(), ...(updated === undefined ? {} : { updated: new Date(updated).toISOString() }), ...(due_at === undefined ? {} : { due: due_at }) }),
      attributes: Object.freeze({ status, ...(owner === undefined ? {} : { owner }), ...(due_at === undefined ? {} : { due_at }) }),
      ...(content === undefined ? {} : { text: content }) }) });
}

/**
 * The issues of these distinct issue ids, read in bulk calls of `batch` ids that apply this person's current issue permissions:
 * hidden, deleted and unknown issues do not come back. Each comes once, with its id and the `fields` asked for; a malformed
 * page fails the whole read. With `issue_errors`, an issue Jira could not return just now fails it too; with `abort`, a call
 * that returns to an aborted signal stops it.
 */
async function* jiraBulkIssues(transport: JiraCloudTransportV1, input: { readonly cloud_id: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal },
  options: { readonly batch: number; readonly fields: readonly string[]; readonly issue_errors: boolean; readonly abort: boolean }): AsyncGenerator<{ readonly id: string; readonly fields: unknown }> {
  for (let offset = 0; offset < input.ticket_ids.length; offset += options.batch) {
    const batch = new Set(input.ticket_ids.slice(offset, offset + options.batch));
    const page = jiraRecord(await transport.request({ path: `/ex/jira/${input.cloud_id}/rest/api/3/issue/bulkfetch`, method: 'POST',
      body: { issueIdsOrKeys: [...batch], fields: [...options.fields] }, signal: input.signal }));
    if (options.abort) input.signal?.throwIfAborted();
    if (options.issue_errors && jiraArray(page.issueErrors === undefined ? [] : page.issueErrors, batch.size).length > 0) jiraFailure('unavailable');
    const seen = new Set<string>();
    for (const raw of jiraArray(page.issues, batch.size)) {
      const issue = jiraRecord(raw);
      const id = jiraString(issue.id, 20, JIRA_ID);
      if (!batch.has(id) || seen.has(id)) jiraFailure('invalid_output');
      seen.add(id);
      yield { id, fields: issue.fields };
    }
  }
}

/** Jira's bulk fetch reads at most 100 issues per call; the Ask source check and assignee read take that many at a time. */
const JIRA_BULK_FETCH_MAX_IDS = 100;
/** Readability only: one small field, never read. */
const TICKET_CHECK_FIELDS = Object.freeze(['status']);

/**
 * The ids of the tickets this person can read now (Ask timeline v1, C1; ADR-0047), for distinct valid issue ids, in bulk reads
 * that apply their current issue permissions. Hidden, deleted and unknown issues do not come back and are left out; an issue
 * Jira could not return just now (issueErrors) or a malformed page fails the whole read, never a partial answer.
 */
export async function readJiraReadableTicketsV1(transport: JiraCloudTransportV1, input: { readonly cloud_id: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for await (const issue of jiraBulkIssues(transport, input, { batch: JIRA_BULK_FETCH_MAX_IDS, fields: TICKET_CHECK_FIELDS, issue_errors: true, abort: true })) found.add(issue.id);
  return found;
}

const JIRA_ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

/**
 * Assignee account ids by issue id, for distinct valid issue ids. Issues this
 * person cannot read (issueErrors) and unassigned issues are left out; any
 * malformed page fails the whole read.
 */
export async function readJiraAssigneeAccountsV1(transport: JiraCloudTransportV1, input: { readonly cloud_id: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for await (const issue of jiraBulkIssues(transport, input, { batch: JIRA_BULK_FETCH_MAX_IDS, fields: ['assignee'], issue_errors: false, abort: false })) {
    const assignee = jiraRecord(issue.fields).assignee;
    if (assignee !== null && assignee !== undefined) found.set(issue.id, jiraString(jiraRecord(assignee).accountId, 128, JIRA_ACCOUNT_ID));
  }
  return found;
}
