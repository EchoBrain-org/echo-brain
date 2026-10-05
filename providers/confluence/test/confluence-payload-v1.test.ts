import { expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { verifyConfluenceConnectionV1 } from '../src/confluence-payload-v1.js';
import type { ConfluenceCloudTransportV1 } from '../src/confluence-cloud-transport-v1.js';

const binding = { organization_id: 'org', principal_id: 'person', membership_id: 'member', tool_id: 'confluence', external_scope_id: '00000000-0000-4000-8000-000000000007', external_subject_id: 'acct', read_grant_sha256: canonicalSha256({ fixture: true }) } as const;
function fixture(scopes: readonly string[] = ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user']): ConfluenceCloudTransportV1 {
  return { binding, request: vi.fn(async ({ path }) => path === '/oauth/token/accessible-resources'
    ? [{ id: binding.external_scope_id, url: 'https://fixture.atlassian.net', scopes }]
    : { accountId: 'acct', type: 'known', accountType: 'atlassian' }) };
}
it('requires the exact Confluence cloud resource, all live-read scopes, pinned site, and bound account', async () => {
  await expect(verifyConfluenceConnectionV1(fixture(), { expected_origin: 'https://fixture.atlassian.net' })).resolves.toEqual({ origin: 'https://fixture.atlassian.net', account_id: 'acct' });
  await expect(verifyConfluenceConnectionV1(fixture(['read:page:confluence']))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(verifyConfluenceConnectionV1(fixture(), { expected_origin: 'https://other.atlassian.net' })).rejects.toMatchObject({ code: 'stale_access_state' });
});

it('accepts the documented granular capabilities without requiring classic scopes or offline_access in the resource grant', async () => {
  const transport = fixture(['read:page:confluence', 'read:space:confluence', 'read:content-details:confluence']);
  await expect(verifyConfluenceConnectionV1(transport)).resolves.toEqual({ origin: 'https://fixture.atlassian.net', account_id: 'acct' });
  expect(transport.request).toHaveBeenNthCalledWith(2, { path: '/rest/api/user/current', signal: undefined });
});

it.each([
  { missing: 'pages', scopes: ['read:space:confluence', 'read:content-details:confluence'] },
  { missing: 'spaces', scopes: ['read:page:confluence', 'read:content-details:confluence'] },
  { missing: 'search', scopes: ['read:page:confluence', 'read:space:confluence', 'read:confluence-user'] },
  { missing: 'current user', scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence'] },
  // read:user:confluence is documented for other endpoints, not /user/current.
  { missing: 'current user despite read:user', scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:user:confluence'] },
])('rejects a returned grant missing $missing before any identity read', async ({ scopes }) => {
  const transport = fixture(scopes);
  await expect(verifyConfluenceConnectionV1(transport)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(transport.request).toHaveBeenCalledExactlyOnceWith({ path: '/oauth/token/accessible-resources', signal: undefined });
});

it('rejects anonymous, app, and inactive current-user records before binding a person', async () => {
  for (const current of [
    { accountId: 'acct', active: true, type: 'anonymous', accountType: 'atlassian' },
    { accountId: 'acct', active: true, type: 'known', accountType: 'app' },
    { accountId: 'acct', active: false, type: 'known', accountType: 'atlassian' },
  ]) {
    const transport = fixture();
    const request = transport.request;
    const altered: ConfluenceCloudTransportV1 = { binding: transport.binding, request: async input => input.path === '/rest/api/user/current' ? current : request(input) };
    await expect(verifyConfluenceConnectionV1(altered)).rejects.toMatchObject({ code: 'unauthorized' });
  }
});

it.each([undefined, ''])('accepts a bound known current user when optional accountType is unavailable: %s', async accountType => {
  const transport = fixture();
  const altered: ConfluenceCloudTransportV1 = { binding: transport.binding, request: async input => input.path === '/rest/api/user/current'
    ? { accountId: 'acct', type: 'known', ...(accountType === undefined ? {} : { accountType }) } : transport.request(input) };
  await expect(verifyConfluenceConnectionV1(altered)).resolves.toMatchObject({ account_id: 'acct' });
});
