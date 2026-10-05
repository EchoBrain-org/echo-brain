import { verifyAtlassianConnectionV1, type AtlassianConnectionCheckInputV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';

export function verifyConfluenceConnectionV1(transport: ConfluenceCloudTransportV1, input: AtlassianConnectionCheckInputV1 = {}) {
  return verifyAtlassianConnectionV1(CONFLUENCE_PERSON_PROVIDER_V1, transport, input);
}
