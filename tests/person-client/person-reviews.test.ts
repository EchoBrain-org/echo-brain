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
    for (const value of ['reviews', 'review_open', 'review', 'no tool_id', 'due_on']) expect(output.stdout).toContain(value);
    expect(fetch).not.toHaveBeenCalled();
  });
  // One deadline, one day (ADR-0053): noon on November 20 in Tokyo is still the 19th in Los Angeles, so the review carries
  // the meeting's own day and the CLI prints it as sent.
  it("prints an opened review's action with its deadline and its day in the meeting's own time zone, and refuses a review without the day", async () => {
    const item = { signal_id: 'act-1', kind: 'action', text: 'Send the launch checklist.', subject: null, status: null, due_at: '2026-11-20T03:00:00.000Z', due_on: '2026-11-20',
      quotes: [], owner: null, owner_editable: false, project_ids: [] };
    const opened = { review: { approval_id: 'apr_tokyo', title: 'Tokyo launch sync', project_ids: [], status: 'pending', decided_on: null, first_line: null, action_count: 1,
      meeting_at: '2026-11-17T01:00:00.000Z', all_day: false, records: [] }, snapshot_sha256: `sha256:${'a'.repeat(64)}`, participants: ['Aiko Tanaka'], items: [item],
      reasons: [], suggested_projects: [], records: [] };
    const request = JSON.stringify({ schema_version: 1, operation: 'review_open', approval_id: 'apr_tokyo' });
    const answer = (body: unknown) => vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    const sent = cli(answer(opened));
    expect(await sent.run(['reviews', '--request', request])).toBe(0);
    expect(JSON.parse(sent.output.stdout)).toEqual({ ok: true, result: opened });
    // An Authority from before the day existed: the keys are exact, so the two ship together (ADR-0050).
    const { due_on: _day, ...before } = item;
    const older = cli(answer({ ...opened, items: [before] }));
    expect(await older.run(['reviews', '--request', request])).not.toBe(0);
    expect(older.output.stdout).not.toContain('2026-11-20');
  });
});
