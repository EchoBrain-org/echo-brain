import { describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import type { PersonToolProviderV1, PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { runPersonClientCli } from '../../src/product/person-client/commands.js';

describe('neutral Person tool extension boundary', () => {
  it('keeps credential-bearing transport on the Authority with fixed size/time bounds', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const transport = new PersonAuthorityClient({ authority_origin: 'https://authority.example', fetch }).toolTransport('test-credential');
    expect(Object.isFrozen(transport)).toBe(true);
    for (const path of ['https://outside.example/read', '//outside.example/read', '/\\outside.example/read']) {
      await expect(transport.getJson({ path, validate_response: value => value, maximum_response_bytes: 100 })).rejects.toThrow('Authority');
    }
    for (const maximum_response_bytes of [0, Infinity, 65537]) {
      await expect(transport.getJson({ path: '/v3/tools/mail', validate_response: value => value, maximum_response_bytes })).rejects.toThrow('bounds');
    }
    await expect(transport.json({ path: '/v3/tools/mail', body: {}, validate_request: value => value, validate_response: value => value, timeout_ms: 75001 })).rejects.toThrow('bounds');
    expect(fetch).not.toHaveBeenCalled();
    await transport.getJson({ path: '/v3/tools/mail', validate_response: value => value, maximum_response_bytes: 100 });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://authority.example/v3/tools/mail');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-credential');
  });
  it('dispatches a verb to an independently supplied tool and refuses colliding registrations', async () => {
    let output = '';
    const run = vi.fn(async (input: PersonToolVerbContextV1) => input.print({ calendar: input.values.calendar }));
    const calendar: PersonToolProviderV1 = { tool_id: 'calendar', verbs: { status: { description: 'Read calendar status.', options: { calendar: { type: 'string' } }, requires: ['calendar'], run } } };
    const dependencies = { tool_providers: [calendar], stdout: { write: (value: string) => { output += value; return true; } }, stderr: { write: () => true } };
    expect(await runPersonClientCli(['tools', 'status', '--tool', 'calendar', '--calendar', 'team'], dependencies)).toBe(0);
    expect(JSON.parse(output)).toEqual({ calendar: 'team' });
    expect(run).toHaveBeenCalledOnce();
    expect(await runPersonClientCli(['tools', 'setup', '--tool', 'calendar'], dependencies)).toBe(2);
    for (const tool_providers of [[calendar, calendar], [{ ...calendar, verbs: { status: { ...calendar.verbs.status!, options: { limit: { type: 'string' as const } }, requires: [] } } }]]) {
      await expect(runPersonClientCli([], { ...dependencies, tool_providers })).rejects.toThrow('registration');
    }
  });
});
