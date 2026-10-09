import { expect, it, vi } from 'vitest';
import { createJiraNangoV1 } from '../src/jira-nango-v1.js';

const integration = 'jira-fixture';
const tags = { echo_attempt: 'attempt-fixture', organization_id: 'org-fixture', end_user_id: 'person-fixture', echo_membership: 'membership-fixture' };
const connection = { connection_id: 'reference-fixture', provider_config_key: integration, provider: 'jira', tags, credentials: { type: 'OAUTH2', access_token: 'synthetic-jira-access' } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

it('starts a lowercase Jira Nango connection with exactly the live-read scopes and never returns refresh credentials', async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ data: { connect_link: 'https://connect.nango.dev/fixture-consent' } }));
  const nango = createJiraNangoV1({ integration_id: integration, authorization: () => 'synthetic-nango-key', fetch: fetch as typeof globalThis.fetch });
  await expect(nango.connect(tags)).resolves.toEqual({ link: 'https://connect.nango.dev/fixture-consent' });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
    tags, allowed_integrations: [integration], integrations_config_defaults: {
      [integration]: { connection_config: { oauth_scopes_override: 'offline_access read:jira-work read:jira-user' } },
    },
  });
  fetch.mockResolvedValueOnce(json(connection));
  await expect(nango.connection('reference-fixture')).resolves.toEqual({ tags, access_token: 'synthetic-jira-access' });
});
