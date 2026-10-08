import { normalizeAtlassianDocumentTextV1 } from '@echo-brain/provider-runtime/atlassian-document-text-v1';
import { verifyAtlassianConnectionV1, type AtlassianConnectionCheckInputV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import { sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { JIRA_PERSON_PROVIDER_V1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraBoundText, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

export function verifyJiraConnectionV1(transport: JiraCloudTransportV1, input: AtlassianConnectionCheckInputV1 = {}) {
  return verifyAtlassianConnectionV1(JIRA_PERSON_PROVIDER_V1, transport, input);
}

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
  /** True when optional link discovery inspected only its bounded prefix. */
  readonly related_truncated: boolean;
  readonly value: Omit<PersonLiveEvidenceValueV1<PersonTicketCitationV1>, 'handle'>;
  readonly truncated: boolean;
}

/**
 * Jira includes summary/key/self data in link stubs. Those values are never
 * trusted or released: a link contributes only an opaque issue ID, and the
 * reader exact-reads that ID under the current connection before release.
 */
const RELATED_LINK_SCAN_MAX = 64;

function relatedIssueIds(value: unknown, anchorId: string): { readonly ids: readonly string[]; readonly truncated: boolean } {
  // The provider transport bounds JSON response bytes. Inspecting a fixed
  // prefix avoids turning a large but valid link list into a failed anchor
  // read, while still rejecting a malformed present array or inspected link.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) jiraFailure('invalid_output');
  const ids = new Set<string>();
  const count = Math.min(value.length, RELATED_LINK_SCAN_MAX);
  for (let index = 0; index < count; index += 1) {
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
  return Object.freeze({ ids: Object.freeze([...ids].sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))),
    truncated: value.length > count });
}

export function parseJiraIssueV1(value: unknown, input: { readonly cloudid: string; readonly origin: string; readonly inventory: boolean; readonly related?: boolean }): ParsedJiraIssueV1 {
  const issue = jiraRecord(value);
  const id = jiraString(issue.id, 20, JIRA_ID); const key = jiraString(issue.key, 85, JIRA_TICKET_KEY);
  const apiPrefix = `https://api.atlassian.com/ex/jira/${input.cloudid}`;
  jiraSelf(issue.self, input.origin, apiPrefix, 'issue', id, key);
  const fields = jiraRecord(issue.fields);
  const project = parseJiraProject(fields.project, input.origin, apiPrefix);
  if (!key.startsWith(`${project.key}-`)) jiraFailure('invalid_output');
  if (typeof fields.summary !== 'string' || fields.summary.trim() === '' || Buffer.byteLength(fields.summary, 'utf8') > 256 * 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(fields.summary)) jiraFailure('invalid_output');
  const label = jiraBoundText(`${key}: ${fields.summary}`, 256);
  const rawCreated = jiraString(fields.created, 64, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/);
  jiraDay(rawCreated.slice(0, 10));
  const created = new Date(rawCreated);
  if (!Number.isFinite(created.getTime())) jiraFailure('invalid_output');
  const occurred_at = created.toISOString().slice(0, 10);
  const status = jiraString(jiraRecord(fields.status).name, 128);
  const owner = fields.assignee === null ? undefined : jiraString(jiraRecord(fields.assignee).displayName, 128);
  const due_at = fields.duedate === null ? undefined : jiraDay(fields.duedate);
  // Jira can omit this optional field when linking is disabled or unavailable.
  // That means no related context was discoverable, not that no link exists.
  // A field that is present must still have the expected safe array shape.
  const relatedLinks = input.related && fields.issuelinks !== undefined ? relatedIssueIds(fields.issuelinks, id) : Object.freeze({ ids: Object.freeze([]), truncated: false });
  const content = input.inventory ? undefined : jiraBoundText(`${key}: ${fields.summary}\n\n${(fields.description === null ? '' : normalizeAtlassianDocumentTextV1(fields.description, JIRA_PERSON_PROVIDER_V1).text.trim())}`.trim(), 3072);
  const citation: PersonTicketCitationV1 = Object.freeze({ kind: 'ticket', tool_id: 'jira', external_scope_id: input.cloudid,
    ticket_id: id, permalink: `${input.origin}/browse/${key}`, text_sha256: sha256Digest(content?.text ?? '') });
  return Object.freeze({ id, key, project_id: project.id, created_at: created.toISOString(), related_issue_ids: relatedLinks.ids, related_truncated: relatedLinks.truncated,
    truncated: label.truncated || (content?.truncated ?? false),
    value: Object.freeze({ citation, label: label.text, visibility: 'only_me', occurred_at, date_kind: 'created',
      attributes: Object.freeze({ status, ...(owner === undefined ? {} : { owner }), ...(due_at === undefined ? {} : { due_at }) }),
      ...(content === undefined ? {} : { text: content.text }) }) });
}
