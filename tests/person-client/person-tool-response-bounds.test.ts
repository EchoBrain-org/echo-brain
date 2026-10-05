import { describe, expect, it, vi } from 'vitest';
import { validatePersonToolConnectV1, type PersonToolHostV1, type PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { createConfluencePersonToolProviderV1 } from '@echo-brain/provider-confluence-client/person/confluence-tool-provider';
import { createJiraPersonToolProviderV1 } from '@echo-brain/provider-jira-client/person/jira-tool-provider';
import { validateConfluenceProjectMappingsV1, validateConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const spaces = Array.from({ length: 20 }, (_, index) => String(10n ** 19n + BigInt(index)));
const mapping = (index: number) => ({ schema_version: 1 as const, project_id: `prj_${uuid(index)}`, revision: uuid(1), mapping: { cloud_id: uuid(2), space_ids: spaces } });

/** Uses the production bounded HTTP reader; only the network is substituted. */
function hostFor(value: unknown, extraBytes = 0) {
  const encoded = new TextEncoder().encode(JSON.stringify(value) + ' '.repeat(extraBytes));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 1024) controller.enqueue(encoded.slice(offset, offset + 1024));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json' } }));
  const transport = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch }).toolTransport('fixture-bearer');
  const host: PersonToolHostV1 = { withToolSession: operation => operation({ transport,
    identity: { organization_id: 'org-fixture', membership_id: 'member-fixture' },
    request_id: () => 'unused', random_bytes: size => new Uint8Array(size),
  }) };
  return { host, fetch, bytes: encoded.length };
}

/** Exercise each package's public tool verbs, including its private client. */
async function callTool(host: PersonToolHostV1, provider: 'jira' | 'confluence', verb: 'connect' | 'project', values: PersonToolVerbContextV1['values']) {
  const tool = provider === 'confluence' ? createConfluencePersonToolProviderV1() : createJiraPersonToolProviderV1();
  const printed: unknown[] = []; const opened: string[] = [];
  await tool.verbs[verb]!.run({ host, values, print: value => { printed.push(value); },
    open_browser: async url => { opened.push(url); return true; },
    read_interactive_line: async () => '', read_secret_line: async () => '', sleep: async () => undefined,
  });
  return { printed, opened };
}

describe('Person tool response byte budgets', () => {
  it.each(['jira', 'confluence'] as const)('accepts a maximum valid escaped %s consent link', async provider => {
    const prefix = 'https://connect.example.test/?state=';
    const response = validatePersonToolConnectV1({ schema_version: 1, attempt: uuid(1), expires_at: '2026-10-05T00:00:00.000Z',
      connect_link: prefix + '\ud800'.repeat(4096 - prefix.length),
    }, provider);
    const fixture = hostFor(response);
    expect(fixture.bytes).toBeGreaterThan(8192);
    await expect(callTool(fixture.host, provider, 'connect', { 'no-wait': true })).resolves.toMatchObject({
      printed: [{ ok: true, phase: 'waiting', attempt: response.attempt, expires_at: response.expires_at }], opened: [response.connect_link],
    });
    const oversized = hostFor(response, 32 * 1024);
    await expect(callTool(oversized.host, provider, 'connect', { 'no-wait': true })).rejects.toMatchObject({ code: 'response_too_large' });
    expect(oversized.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['ASCII', 'x'.repeat(256)],
    ['three-byte Unicode', '\uffff'.repeat(256)],
    ['supplementary Unicode', '😀'.repeat(128)],
    ['JSON escapes', '\\"'.repeat(128)],
    ['JSON-escaped lone surrogates', '\ud800'.repeat(256)],
  ])('accepts a maximum valid spaces page with %s fields', async (_name, label) => {
    const response = validateConfluenceSpacesPageV1({ schema_version: 1, next_cursor: 'c'.repeat(4096),
      items: spaces.map(id => ({ id, key: label, name: label })),
    });
    const fixture = hostFor(response);
    expect(fixture.bytes).toBeGreaterThan(8192);
    await expect(callTool(fixture.host, 'confluence', 'project', { spaces: true })).resolves.toMatchObject({ printed: [{ ok: true, result: response }] });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it('accepts 100 maximum-size mappings using the list contract', async () => {
    const response = validateConfluenceProjectMappingsV1({ schema_version: 1, mappings: Array.from({ length: 100 }, (_, index) => mapping(index)) });
    const fixture = hostFor(response);
    expect(fixture.bytes).toBeGreaterThan(64 * 1024);
    await expect(callTool(fixture.host, 'confluence', 'project', { list: true })).resolves.toMatchObject({ printed: [{ ok: true, result: response }] });
  });

  it.each(['jira', 'confluence'] as const)('retains the small budget for maximum valid %s single mappings', async provider => {
    const confluence = mapping(0);
    const response = provider === 'confluence' ? confluence : { ...confluence, mapping: { cloud_id: uuid(2), project_id: spaces[0], project_key: 'K'.repeat(64) } };
    const fixture = hostFor(response);
    await expect(callTool(fixture.host, provider, 'project', { 'echo-project': response.project_id })).resolves.toMatchObject({ printed: [{ ok: true, result: response }] });
    const oversized = hostFor(response, 8192);
    await expect(callTool(oversized.host, provider, 'project', { 'echo-project': response.project_id })).rejects.toMatchObject({ code: 'response_too_large' });
    expect(oversized.fetch).toHaveBeenCalledOnce();
  });

  it('rejects oversized collection streams without retrying under a larger budget', async () => {
    const fixture = hostFor({ schema_version: 1, items: [], next_cursor: null }, 128 * 1024);
    await expect(callTool(fixture.host, 'confluence', 'project', { spaces: true })).rejects.toMatchObject({ code: 'response_too_large' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});
