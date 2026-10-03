import type { ContextCaptureContentV1 } from '@echo-brain/organization-processing/core';
import { parseJiraIssueV1 } from './jira-payload-v1.js';
import { JIRA_ID, jiraArray, jiraBoundText, jiraDay, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

export interface ParsedJiraContextIssueV1 {
  readonly id: string;
  readonly project_id: string;
  readonly label: string;
  readonly content: ContextCaptureContentV1;
}

function canonicalProviderTimestamp(value: unknown): string {
  const raw = jiraString(value, 64, /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/);
  // Date parsing otherwise normalizes impossible provider days into a new revision.
  jiraDay(raw.slice(0, 10));
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.getTime())) jiraFailure('invalid_output');
  return timestamp.toISOString();
}

/**
 * Capture-specific Jira fields. This intentionally builds on the bounded
 * live-evidence parser, while retaining only fields that have stable provider
 * coordinates. It never turns a display name or a date-only due date into an
 * ECHO identity or timestamp.
 */
export function parseJiraContextIssueV1(value: unknown, input: {
  readonly cloudid: string;
  readonly origin: string;
  readonly representation: 'pointer' | 'excerpt';
}): ParsedJiraContextIssueV1 {
  const parsed = parseJiraIssueV1(value, { cloudid: input.cloudid, origin: input.origin, inventory: false });
  const issue = jiraRecord(value);
  const fields = jiraRecord(issue.fields);
  const updatedAt = canonicalProviderTimestamp(fields.updated);
  const labels = jiraArray(fields.labels, 32).map((label) => jiraString(label, 256));
  if (new Set(labels).size !== labels.length) jiraFailure('invalid_output');

  let priority: string | undefined;
  if (fields.priority !== null && fields.priority !== undefined) {
    priority = jiraString(jiraRecord(fields.priority).name, 256);
  }
  let assigneeRef: string | undefined;
  if (fields.assignee !== null && fields.assignee !== undefined) {
    // parseJiraIssueV1 has already validated the display-only name. Capture
    // uses the provider's opaque stable account coordinate instead.
    assigneeRef = `jira:account:${jiraString(jiraRecord(fields.assignee).accountId, 256)}`;
  }
  const text = parsed.value.text;
  if (text === undefined || text.trim() === '') jiraFailure('invalid_output');
  const label = jiraBoundText(parsed.value.label, 200).text;
  if (label === '') jiraFailure('invalid_output');
  const permalink = parsed.value.citation.permalink;
  const content: ContextCaptureContentV1 = {
    schema_version: 1,
    kind: 'echo-context-capture-v1',
    label,
    provenance: { origin_ref: permalink, source_updated_at: updatedAt },
    payload: {
      schema_version: 1,
      kind: 'ticket',
      key: parsed.key,
      status: parsed.value.attributes?.status ?? jiraFailure('invalid_output'),
      labels,
      ...(priority === undefined ? {} : { priority }),
      ...(assigneeRef === undefined ? {} : { assignee_ref: assigneeRef }),
    },
    representation: input.representation === 'pointer'
      ? { kind: 'pointer', pointer: permalink }
      : {
          // The existing Jira text parser bounds the rendered source evidence
          // to 3 KiB. This is explicitly an excerpt, never a full snapshot.
          kind: 'excerpt',
          passages: [{
            id: 'rendered-body',
            source_anchor: `jira:issue:${parsed.id}:rendered-v1`,
            start: 0,
            end: text.length,
            text,
          }],
        },
  };
  return Object.freeze({ id: jiraString(parsed.id, 20, JIRA_ID), project_id: parsed.project_id, label, content: Object.freeze(content) });
}
