import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { signedInHome } from './signed-in-home.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const now = '2026-10-31T10:00:00.000Z';
function cli(fetch: typeof globalThis.fetch) {
  const home = signedInHome({ prefix: 'echo-person-reviews-', now }); homes.push(home);
  const output = { stdout: '', stderr: '' };
  return { output, run: (argv: readonly string[]) => runPersonClientCli(argv, { home_directory: home, now: () => now, fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } } }) };
}
describe('person reviews CLI', () => {
  it('lists reviews through the neutral route without choosing a tool', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ reviews: [] }), { headers: { 'content-type': 'application/json' } }));
    const { run, output } = cli(fetch);
    expect(await run(['reviews', '--request', JSON.stringify({ schema_version: 1, operation: 'reviews' })])).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ ok: true, result: { reviews: [] } });
    expect(output.stderr).toBe('');
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/reviews');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ schema_version: 1, operation: 'reviews' });
  });
  it('rejects provider selectors and malformed JSON before networking', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const request of ['{', JSON.stringify({ schema_version: 1, operation: 'reviews', tool_id: 'granola' })]) {
      const { run } = cli(fetch);
      expect(await run(['reviews', '--request', request])).toBe(2);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('documents all operations and the provider-independent route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const { run, output } = cli(fetch);
    expect(await run(['reviews', '--help'])).toBe(0);
    for (const value of ['reviews', 'review_open', 'review', 'no tool_id']) expect(output.stdout).toContain(value);
    expect(fetch).not.toHaveBeenCalled();
  });
});
