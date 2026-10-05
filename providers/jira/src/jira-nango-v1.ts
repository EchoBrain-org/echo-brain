import { createNangoPersonConnectionV1, type NangoPersonConnectionV1 } from '@echo-brain/provider-runtime/nango-person-connection-v1';
import { JIRA_PERSON_PROVIDER_V1 } from './jira-validation-v1.js';

export type JiraNangoV1 = NangoPersonConnectionV1;
export function createJiraNangoV1(options: { readonly integration_id: string; readonly authorization: () => string; readonly fetch: typeof fetch }): JiraNangoV1 {
  return createNangoPersonConnectionV1({ ...options, provider: JIRA_PERSON_PROVIDER_V1 });
}
