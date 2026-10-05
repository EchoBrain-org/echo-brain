import { normalizeAtlassianDocumentTextV1 } from '@echo-brain/provider-runtime/atlassian-document-text-v1';
import { atlassianSiteOriginV1, verifyAtlassianConnectionV1, type AtlassianConnectionCheckInputV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import { createHash } from 'node:crypto';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { JIRA_PERSON_PROVIDER_V1, JIRA_ID, JIRA_PROJECT_KEY, JIRA_TICKET_KEY, jiraArray, jiraBoundText, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

export const jiraTextDigest = (text: string): `sha256:${string}` => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

export function jiraSiteOrigin(value: unknown): string { return atlassianSiteOriginV1(JIRA_PERSON_PROVIDER_V1, value); }

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
  readonly value: Omit<PersonLiveEvidenceValueV1<PersonTicketCitationV1>, 'handle'>;
  readonly truncated: boolean;
}

export function parseJiraIssueV1(value: unknown, input: { readonly cloudid: string; readonly origin: string; readonly inventory: boolean }): ParsedJiraIssueV1 {
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
  const content = input.inventory ? undefined : jiraBoundText(`${key}: ${fields.summary}\n\n${(fields.description === null ? '' : normalizeAtlassianDocumentTextV1(fields.description, JIRA_PERSON_PROVIDER_V1).text.trim())}`.trim(), 3072);
  const citation: PersonTicketCitationV1 = Object.freeze({ kind: 'ticket', tool_id: 'jira', external_scope_id: input.cloudid,
    ticket_id: id, permalink: `${input.origin}/browse/${key}`, text_sha256: jiraTextDigest(content?.text ?? '') });
  return Object.freeze({ id, key, project_id: project.id, created_at: created.toISOString(),
    truncated: label.truncated || (content?.truncated ?? false),
    value: Object.freeze({ citation, label: label.text, visibility: 'only_me', occurred_at,
      attributes: Object.freeze({ status, ...(owner === undefined ? {} : { owner }), ...(due_at === undefined ? {} : { due_at }) }),
      ...(content === undefined ? {} : { text: content.text }) }) });
}
