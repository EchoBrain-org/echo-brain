import { describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';

const runId = 'rr_00000000-0000-4000-8000-000000000001';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('staging research evaluation client calls', () => {
  it('starts a run and reads a large completed result on the research routes', async () => {
    const research = { schema_version: 1, kind: 'echo-agentic-research-result-v1', trigger: 'check', plan: [], rounds: [], items: [{ id: 'E1', text: 'x'.repeat(200_000) }] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ schema_version: 1, kind: 'echo-person-research-eval-run-v1', run_id: runId, status: 'running' }))
      .mockResolvedValueOnce(json({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research }));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    const receipt = await client.startResearchEval('bearer', { schema_version: 1, trigger: 'ask', budget: 'live', input: { question: 'Why is DVT on hold?' } });
    expect(receipt.run_id).toBe(runId);
    const result = await client.readResearchEval('bearer', runId);
    expect(result.status).toBe('completed');
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/person/research-eval/start', '/v1/person/research-eval/read']);
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer bearer' });
  });

  it('sends a legacy Ask question as the envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ schema_version: 1, kind: 'echo-person-research-eval-run-v1', run_id: runId, status: 'running' }));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await client.startResearchEval('bearer', { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Why is DVT on hold?' } as never);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ schema_version: 1, trigger: 'ask', budget: 'live', input: { question: 'Why is DVT on hold?' } });
  });

  it('refuses an invalid start request before sending it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.startResearchEval('bearer', { schema_version: 1, trigger: 'check', budget: 'live', record: { kind: 'ticket' } } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
