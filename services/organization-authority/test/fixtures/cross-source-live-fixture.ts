import { vi } from 'vitest';
import { fakeConfluenceCloudFetchV1, fakeConfluenceNangoV1 } from './fake-confluence-v1.js';
import { fakeJiraCloudFetchV1, fakeJiraNangoV1 } from './fake-jira-v1.js';

export const CONFLUENCE_TEXT = 'Launchscope Confluence page: customer support is ready.';
export const JIRA_TEXT = 'Launchscope Jira ticket: ship after the security review.';

/** Fake Jira and Confluence wire responses, each exercised through its real reader. */
export function crossSourceLiveFixture() {
  let jiraPermitted = true;
  let confluencePermitted = true;
  let revokeConfluenceAfterSearch = false;
  let beforeConfluenceResponse: (() => Promise<void>) | undefined;
  const jira = fakeJiraNangoV1();
  const baseJiraFetch = fakeJiraCloudFetchV1();
  const jiraFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseJiraFetch(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/issue/bulkfetch')) return jiraPermitted ? response : Response.json({ issues: [], issueErrors: [] });
    if (!path.endsWith('/issue/10001')) return response;
    if (!jiraPermitted) return Response.json({ errorMessages: ['Synthetic issue permission denied'] }, { status: 403 });
    const body = await response.json() as { fields: { summary: string; description: unknown } };
    body.fields.summary = 'Launchscope security review';
    body.fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: JIRA_TEXT }] }] };
    return Response.json(body);
  });
  const confluence = fakeConfluenceNangoV1();
  const baseConfluenceFetch = fakeConfluenceCloudFetchV1({ page: { title: 'Launchscope support', text: CONFLUENCE_TEXT } });
  /** Every Confluence call, so tests can prove what a refused source read. Once access is revoked, Confluence answers 403. */
  const confluenceFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    await beforeConfluenceResponse?.();
    if (!confluencePermitted) return Response.json({ message: 'Synthetic Confluence permission revoked' }, { status: 403 });
    const response = await baseConfluenceFetch(input, init);
    if (revokeConfluenceAfterSearch && new URL(String(input)).pathname.endsWith('/rest/api/search')) confluencePermitted = false;
    return response;
  });
  return { jira, jiraFetch, confluence, confluenceFetch,
    beforeConfluenceResponse(callback: () => Promise<void>) { beforeConfluenceResponse = callback; },
    denyConfluence() { confluencePermitted = false; }, revokeConfluenceDuringRead() { revokeConfluenceAfterSearch = true; },
    denyJira() { jiraPermitted = false; } };
}
