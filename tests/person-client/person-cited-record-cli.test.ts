import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { personRecordAtomIdV1, validatePersonCitedRecordV1 } from '@echo-brain/organization-api';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { signedInHome } from './signed-in-home.js';

// `person records --record-sha256 <digest> --brief`: the one record an Ask citation names, as Ask cites it, in place of
// its signed envelope. Without --brief the command prints what it always printed.

const NOW = '2026-10-31T10:00:00.000Z';
const RECORD = `sha256:${'d'.repeat(64)}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const brief = {
  meeting: { id: 'm1', title: 'Tuesday sync', participants: [{ id: 'p1', display_name: 'Maya Chen', identities: [{ kind: 'email', value: 'private@example.test' }] }] },
  decisions: [{ id: 'd1', kind: 'decision', status: 'decided', text: 'Ship annual plans first.', evidence: [{ quote: 'Annual first.', started_at: '2026-09-15T17:12:00Z' }] }],
  actions: [{ id: 'a1', kind: 'action', text: 'Maya updates the pricing page.' }],
  rationales: [],
};
const list = (records: readonly Record<string, unknown>[]) => ({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records });
const record = (envelope: Record<string, unknown> = { record_sha256: RECORD, body: { event: {
  kind: 'approved', policy_id: 'organization-member-readable-person-v2', approved_snapshot: { approved_payload: { brief } },
} } }) => ({ position: 3, approval_id: 'apr_1', record_sha256: RECORD, envelope, source_metadata: { record_approved_by: { display_name: 'Maya Chen' } } });

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function run(argv: readonly string[], fetch: typeof globalThis.fetch) {
  const home = signedInHome({ prefix: 'echo-person-cited-record-', now: NOW });
  homes.push(home);
  const output = { stdout: '', stderr: '' };
  const code = await runPersonClientCli(argv, { home_directory: home, now: () => NOW, fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } } });
  return { code, ...output };
}

describe('one cited record, as Ask cites it', () => {
  it('reads the record as without --brief, and prints its meeting and items, each with its atom id, and no identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(list([record()])));
    const cited = await run(['records', '--record-sha256', RECORD, '--brief'], fetch);
    expect(cited).toMatchObject({ code: 0, stderr: '' });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname + url.search).toBe(`/v1/person/records?record_sha256=${RECORD}`);
    const printed = JSON.parse(cited.stdout) as { ok: true; result: unknown };
    expect(printed.ok).toBe(true);
    expect(validatePersonCitedRecordV1(printed.result)).toMatchObject({
      record_sha256: RECORD, policy_id: 'organization-member-readable-person-v2', title: 'Tuesday sync', approved_by: 'Maya Chen', participants: ['Maya Chen'],
      decisions: { items: [{ atom_id: personRecordAtomIdV1(RECORD, 'd1'), text: 'Ship annual plans first.', status: 'decided',
        quotes: [{ quote: 'Annual first.', started_at: '2026-09-15T17:12:00Z' }] }], more: false },
      actions: { items: [{ atom_id: personRecordAtomIdV1(RECORD, 'a1'), text: 'Maya updates the pricing page.', quotes: [] }], more: false },
    });
    expect(cited.stdout).not.toContain('private@example.test');

    const whole = await run(['records', '--record-sha256', RECORD], vi.fn<typeof globalThis.fetch>(async () => json(list([record()]))));
    expect(JSON.parse(whole.stdout)).toEqual({ ok: true, result: list([record()]) });
  });

  it('fails with not_found for a record the person cannot read, and invalid_response for one Ask cannot cite', async () => {
    const gone = await run(['records', '--record-sha256', RECORD, '--brief'], vi.fn<typeof globalThis.fetch>(async () => json(list([]))));
    expect(gone).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(gone.stderr)).toMatchObject({ ok: false, action: 'records', code: 'not_found' });
    const unapproved = await run(['records', '--record-sha256', RECORD, '--brief'],
      vi.fn<typeof globalThis.fetch>(async () => json(list([record({ record_sha256: RECORD, body: { event: { kind: 'rejected' } } })]))));
    expect(unapproved).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(unapproved.stderr)).toMatchObject({ ok: false, action: 'records', code: 'invalid_response' });
  });

  it('takes --brief only with --record-sha256, before any network use', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const argv of [['records', '--brief'], ['records', '--query', 'pricing', '--brief']]) {
      const refused = await run(argv, fetch);
      expect(refused.code, argv.join(' ')).toBe(2);
      expect(JSON.parse(refused.stderr)).toEqual({ ok: false, error: '--brief requires --record-sha256' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
