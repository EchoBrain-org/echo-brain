import { describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
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
  it('dispatches an independently supplied command and refuses collisions with core commands', async () => {
    let output = '';
    const command = { name: 'calendar-status', description: 'Read calendar status', options: { calendar: { type: 'string' as const } }, requires: ['calendar'], run: vi.fn(async (input: { values: Readonly<Record<string, string | boolean | undefined>>; print(value: unknown): void }) => input.print({ calendar: input.values.calendar })) };
    const dependencies = { tool_commands: [command], stdout: { write: (value: string) => { output += value; return true; } }, stderr: { write: () => true } };
    expect(await runPersonClientCli(['calendar-status', '--calendar', 'team'], dependencies)).toBe(0);
    expect(JSON.parse(output)).toEqual({ calendar: 'team' });
    expect(command.run).toHaveBeenCalledOnce();
    await expect(runPersonClientCli([], { ...dependencies, tool_commands: [{ ...command, name: 'records' }] })).rejects.toThrow('registration');
  });
});
