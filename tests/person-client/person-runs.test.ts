import { describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('person runs client', () => {
  it('validates its request before networking and returns the operation result', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ runs: [] }));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.runs('bearer', { schema_version: 1, operation: 'list' })).resolves.toEqual({ runs: [] });
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/runs');
    await expect(client.runs('bearer', { schema_version: 1, operation: 'start', run_id: 'bad' } as never)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
