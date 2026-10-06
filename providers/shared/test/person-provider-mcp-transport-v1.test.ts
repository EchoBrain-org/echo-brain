import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createPersonProviderMcpTransportV1 } from '../src/person-provider-mcp-transport-v1.js';
import { JIRA_PERSON_PROVIDER_V1 } from '../../jira/src/jira-validation-v1.js';

const binding = { organization_id: 'org', principal_id: 'person', membership_id: 'member', tool_id: 'jira',
  external_scope_id: '00000000-0000-4000-8000-000000000001', external_subject_id: 'account', read_grant_sha256: canonicalSha256({ grant: 1 }) };
function fixture(reply: (id: string) => Response) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => reply((JSON.parse(init.body as string) as { id: string }).id));
  const transport = createPersonProviderMcpTransportV1(JIRA_PERSON_PROVIDER_V1, { binding, fetch }, 'https://mcp.example.test/mcp');
  return { fetch, transport };
}
const result = (id: string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'fixture content' }] } });

describe('shared stateless MCP read transport', () => {
  it.each(['json', 'sse'])('uses shared HTTP controls and accepts %s framing', format => {
    const f = fixture(id => format === 'json' ? Response.json(result(id)) : new Response(`: heartbeat\r\nevent: message\r\ndata: ${JSON.stringify(result(id))}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    return f.transport.call('list_meetings', { folder_id: 'fixture' }).then(value => {
      expect(value).toBe('fixture content');
      expect(f.fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { Accept: 'application/json, text/event-stream' } });
      expect(JSON.parse(f.fetch.mock.calls[0]![1].body as string)).toMatchObject({ method: 'tools/call', params: { name: 'list_meetings', arguments: { folder_id: 'fixture' } } });
    });
  });
  it.each([
    (id: string) => ({ ...result(id), id: 'someone-else' }),
    (id: string) => ({ ...result(id), jsonrpc: '1.0' }),
    (id: string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'resource', text: 'private' }] } }),
  ])('rejects a response outside the exact call/text contract (%#)', change => {
    const f = fixture(id => Response.json(change(id)));
    return expect(f.transport.call('read', {})).rejects.toMatchObject({ code: 'invalid_output' });
  });
  it('does not turn plan/access failures into an empty successful inventory', async () => {
    const f = fixture(id => Response.json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'private provider restriction details' }] } }));
    await expect(f.transport.call('list_folders', {})).rejects.toMatchObject({ code: 'unavailable', message: 'Jira live evidence operation could not be completed' });
  });
  it('rejects duplicate responses, invalid media types and oversized streams', async () => {
    for (const reply of [
      (id: string) => new Response(`data: ${JSON.stringify(result(id))}\n\ndata: ${JSON.stringify(result(id))}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
      () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
      () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'text/event-stream' } }),
    ]) await expect(fixture(reply).transport.call('read', {})).rejects.toMatchObject({ code: 'invalid_output' });
  });
});
