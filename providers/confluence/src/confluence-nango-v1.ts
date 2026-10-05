import { createNangoPersonConnectionV1, type NangoPersonConnectionV1 } from '@echo-brain/provider-runtime/nango-person-connection-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';

export type ConfluenceNangoV1 = NangoPersonConnectionV1;
export function createConfluenceNangoV1(options: { readonly integration_id: string; readonly authorization: () => string; readonly fetch: typeof fetch }): ConfluenceNangoV1 {
  return createNangoPersonConnectionV1({ ...options, provider: CONFLUENCE_PERSON_PROVIDER_V1 });
}
