import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createPersonProviderJsonTransportV1, PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1, type PersonProviderAuthenticatedFetchV1 } from '@echo-brain/provider-runtime/person-provider-json-transport-v1';
import { JIRA_PERSON_PROVIDER_V1, jiraFailure } from './jira-validation-v1.js';

export interface JiraCloudRequestV1 {
  readonly path: string;
  readonly method?: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** Trusted transport port. Its authorization is fixed to the same ECHO person and grant. */
export interface JiraCloudTransportV1 {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: JiraCloudRequestV1): Promise<unknown>;
}

export type JiraCloudAuthenticatedFetchV1 = PersonProviderAuthenticatedFetchV1;

export const JIRA_RESPONSE_MAX_BYTES_V1 = PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1;

/** Product-owned read endpoint/selector allowlist, over the shared bounded Atlassian transport. */
export function createJiraCloudTransportV1(authenticated: JiraCloudAuthenticatedFetchV1): JiraCloudTransportV1 {
  return createPersonProviderJsonTransportV1(JIRA_PERSON_PROVIDER_V1, authenticated, (input: JiraCloudRequestV1, binding) => {
    const prefix = `/ex/jira/${binding.external_scope_id}/rest/api/3/`;
    const method = input.method ?? 'GET';
    const suffix = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : '';
    const resources = input.path === '/oauth/token/accessible-resources';
    const postRead = suffix === 'search/jql' || suffix === 'issue/bulkfetch';
    if (!(resources || /^(?:myself|project\/(?:[1-9][0-9]{0,19}|[A-Z][A-Z0-9_]{0,63})|issue\/(?:[1-9][0-9]{0,19}|bulkfetch)|search\/jql)$/.test(suffix)) ||
        (postRead ? method !== 'POST' : method !== 'GET') || (method === 'GET' && input.body !== undefined)) jiraFailure('invalid_request');
    const url = new URL(input.path, 'https://api.atlassian.com');
    for (const [key, value] of Object.entries(input.query ?? {})) {
      const issueFields = key === 'fields' && /^[a-zA-Z,]+$/.test(value) && suffix.startsWith('issue/') && !postRead;
      const projectKeys = key === 'expand' && value === 'projectKeys' && suffix.startsWith('project/');
      if (!issueFields && !projectKeys) jiraFailure('invalid_request');
      url.searchParams.set(key, value);
    }
    return { url, method, ...(input.body === undefined ? {} : { body: input.body }) };
  });
}
