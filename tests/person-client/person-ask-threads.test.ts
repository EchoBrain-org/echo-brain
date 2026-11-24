import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  formatPersonAskProgressEventV3,
  validatePersonAskProgressResultLineV3,
  type OrganizationPersonSessionV2,
  type PersonAnswerPreviousV1,
  type PersonAnswerThreadV1,
  type PersonAskProgressEventV3,
} from '@echo-brain/organization-api';
import { PersonClient } from '../../src/product/person-client/client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

// The asker's threads on `person ask` (ADR-0056, Ask threads v1 T5): the other threads and the thread's earlier turns
// are validated before anything is sent and sent to /v7, and only an answer to an Ask that sent threads may place the
// question among them or name a merge, by indexes into what was sent.

const ORIGIN = 'https://authority.example.test';
const NOW = '2026-10-25T17:00:00.000Z';
const SESSION: OrganizationPersonSessionV2 = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-25T17:10:00.000Z', refresh_expires_at: '2026-11-01T17:00:00.000Z', hard_reauthentication_at: '2026-11-01T17:00:00.000Z',
};
const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10482', permalink: 'https://example.atlassian.net/browse/THERM-482', text_sha256: canonicalSha256('THERM-482') },
  kind: 'ticket' as const, label: 'THERM-482: Thermal fixture fails at 45 °C', visibility: 'only_me' as const,
};
const EARLIER = { question: 'When does Apollo launch?', asked_at: '2026-10-20T17:05:00.000Z', statements: [{ text: 'Apollo launches on November 3.', citation_indexes: [0] }], citations: [ticket] };
const PREVIOUS: PersonAnswerPreviousV1 = {
  purpose: 'follow_up', question: "What's blocking the DVT gate?", asked_at: '2026-10-24T17:05:00.000Z',
  statements: [{ text: 'THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.', citation_indexes: [0] }], citations: [ticket],
};
const THREADS: readonly PersonAnswerThreadV1[] = [
  { questions: ['Who owns the billing migration?', 'when is it due?'], asked_at: '2026-10-23T18:00:00.000Z' },
  { questions: ['When does Apollo launch?'], asked_at: '2026-10-20T17:05:00.000Z' },
];
const QUESTION = 'did that change?';
const answered = (extra: Record<string, unknown> = {}) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [ticket],
  parts: [{ question: QUESTION, status: 'answered' as const, statements: [{ text: 'THERM-482 is in progress, owned by Dev Patel.', citation_indexes: [0], private: true }], blocks: [{ kind: 'answer' as const, statements: [0] }] }], ...extra,
});
const elsewhere = (threads: readonly number[], extra: Record<string, unknown> = {}) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'clarify' as const, citations: [], parts: [],
  question: QUESTION, thread: { kind: 'other' as const, threads }, ...extra,
});
const RECEIPT = { looked_through: 0, elapsed_ms: 1, rows: [] };
const stream = (events: readonly PersonAskProgressEventV3[]) => new Response(events.map(event => formatPersonAskProgressEventV3(event)).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
const replying = (response: unknown) => vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream([{ type: 'answer', response, receipt: RECEIPT } as PersonAskProgressEventV3]));
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>;

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function sessionHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-ask-threads-'))); homes.push(home);
  new PersonSessionStore(home).install(ORIGIN, 'oau_00000000-0000-4000-8000-000000000001', SESSION);
  return home;
}
const client = (fetch: typeof globalThis.fetch) => new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch });
function cli(fetch: typeof globalThis.fetch) {
  const output = { stdout: '', stderr: '' };
  const run = (argv: readonly string[]) => runPersonClientCli(argv, {
    home_directory: sessionHome(), now: () => NOW, fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { output, run };
}
const lines = (text: string) => text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);
const choices = { ...(({ thread: _thread, ...clarify }) => clarify)(elsewhere([0])), choices: [{ label: 'THERM-482', question: 'What are the details on THERM-482?' }] };

describe('the asker\'s threads on the Person client (ADR-0056)', () => {
  it('sends the other threads and the thread\'s earlier turns on /v7 as given, and returns where the answer says the question belongs', async () => {
    const previous = { ...PREVIOUS, earlier: [EARLIER] };
    const fetch = replying(elsewhere([1], { merge: [0] }));
    const result = await client(fetch).askWithLiveProgress(QUESTION, undefined, undefined, () => undefined, previous, undefined, THREADS);
    expect(result.result).toEqual(elsewhere([1], { merge: [0] }));
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v7/person/ask');
    expect(bodyOf(init)).toEqual({ schema_version: 3, question: QUESTION, previous, threads: THREADS });
    // With no previous turn the request carries the threads alone; an Ask that carries neither sends neither.
    for (const [threads, sent] of [[THREADS, { threads: THREADS }], [undefined, {}]] as const) {
      const reply = replying(threads === undefined ? answered() : answered({ question: QUESTION, thread: { kind: 'new' } }));
      await client(reply).askWithLiveSources(QUESTION, undefined, undefined, undefined, threads);
      expect(bodyOf(reply.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, ...sent });
    }
  });

  it.each([
    // An answer that places the question or names a merge answers an Ask that sent threads, a previous turn alone or not.
    ['a new subject to an Ask that sent no threads', answered({ question: QUESTION, thread: { kind: 'new' } }), undefined, undefined, false],
    ['a new subject to an Ask that sent a previous turn alone', answered({ question: QUESTION, thread: { kind: 'new' } }), PREVIOUS, undefined, false],
    ['a merge to an Ask that sent no threads', answered({ question: QUESTION, merge: [0] }), undefined, undefined, false],
    ['a merge to an Ask that sent a previous turn alone', answered({ question: QUESTION, merge: [0] }), PREVIOUS, undefined, false],
    ['other threads to an Ask that sent no threads', elsewhere([0]), undefined, undefined, false],
    ['other threads to an Ask that sent a previous turn alone', elsewhere([0]), PREVIOUS, undefined, false],
    // Indexes are into the threads sent.
    ['a thread past those sent', elsewhere([2]), PREVIOUS, THREADS, false],
    ['threads one of which is past those sent', elsewhere([0, 2]), PREVIOUS, THREADS, false],
    ['a merge past those sent, beside another thread', elsewhere([0], { merge: [2] }), PREVIOUS, THREADS, false],
    ['a merge past those sent, beside the open thread', answered({ question: QUESTION, merge: [1, 2] }), PREVIOUS, THREADS, false],
    ['the last thread sent, and a merge', elsewhere([1], { merge: [0] }), PREVIOUS, THREADS, true],
    ['a thread, to an empty list sent', elsewhere([0]), PREVIOUS, [], false],
    ['a merge, to an empty list sent', answered({ question: QUESTION, merge: [0] }), PREVIOUS, [], false],
    // What an Ask that sent the threads is owed (T2): the question it answers, and with no previous turn, where that belongs.
    ['no question, to threads and a previous turn', answered(), PREVIOUS, THREADS, false],
    ['no question, to threads alone', answered(), undefined, THREADS, false],
    ['no place, to threads alone', answered({ question: QUESTION }), undefined, THREADS, false],
    ['a merge with no place, to threads alone', answered({ question: QUESTION, merge: [0] }), undefined, THREADS, false],
    ['no place, to an empty list alone', answered({ question: QUESTION }), undefined, [], false],
    ['a new subject, to an empty list alone', answered({ question: QUESTION, thread: { kind: 'new' } }), undefined, [], true],
    ['other threads, to threads alone', elsewhere([0]), undefined, THREADS, true],
    ['a new subject, to threads alone', answered({ question: QUESTION, thread: { kind: 'new' } }), undefined, THREADS, true],
    // With a previous turn the same answers continue its thread, and a merge joins that one.
    ['the open thread, to threads and a previous turn', answered({ question: QUESTION }), PREVIOUS, THREADS, true],
    ['the open thread and a merge, to threads and a previous turn', answered({ question: QUESTION, merge: [0] }), PREVIOUS, THREADS, true],
    // An Ask that sent no threads is owed neither, as before; one with threads and no previous turn still takes no since and no choices.
    ['an answer as before, to a previous turn alone', answered(), PREVIOUS, undefined, true],
    ['what is different since, to threads alone', answered({ question: QUESTION, since: { statements: [] } }), undefined, THREADS, false],
    ['choices, to threads alone', choices, undefined, THREADS, false],
  ] as const)('takes %s only as it fits what the Ask sent (T2)', async (_name, answer, previous, threads, fits) => {
    const asked = client(replying(answer)).askWithLiveSources(QUESTION, undefined, undefined, previous, threads);
    if (fits) await expect(asked).resolves.toEqual(answer);
    else await expect(asked).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('person ask --threads (ADR-0056)', () => {
  it.each([
    ['with progress and a previous turn with earlier turns', ['--progress', `--previous=${JSON.stringify({ ...PREVIOUS, earlier: [EARLIER] })}`, `--threads=${JSON.stringify(THREADS)}`],
      elsewhere([1]), { previous: { ...PREVIOUS, earlier: [EARLIER] }, threads: THREADS }],
    ['alone', [`--threads=${JSON.stringify(THREADS)}`], answered({ question: QUESTION, thread: { kind: 'new' } }), { threads: THREADS }],
    // An empty list goes too: the asker has no other thread, and the answer may still say the question starts one.
    ['empty, with a previous turn', [`--previous=${JSON.stringify(PREVIOUS)}`, '--threads=[]'], answered({ question: QUESTION, thread: { kind: 'new' } }), { previous: PREVIOUS, threads: [] }],
  ] as const)('sends the validated list, %s, and prints the answer it gets', async (_name, argv, answer, sent) => {
    const fetch = replying(answer);
    const run = cli(fetch);
    expect(await run.run(['ask', `--question=${QUESTION}`, ...argv])).toBe(0);
    const [last, progress] = [lines(run.output.stdout).at(-1), (argv as readonly string[]).includes('--progress')];
    expect(progress ? validatePersonAskProgressResultLineV3(last) : last).toMatchObject(progress ? { result: answer } : { ok: true, result: answer });
    expect(bodyOf(fetch.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, ...sent });
  });

  it.each([
    ...['{not json', '{}', JSON.stringify([{ questions: [], asked_at: THREADS[0]!.asked_at }]), JSON.stringify([{ ...THREADS[0], title: 'Billing' }]),
      JSON.stringify([{ questions: [' padded '], asked_at: THREADS[0]!.asked_at }]), JSON.stringify([{ questions: ['When?'], asked_at: '2026-10-23' }])]
      .map(threads => [`--threads=${threads}`, ['--progress', `--threads=${threads}`], /^Ask threads (JSON )?is invalid/u] as const),
    ['threads beside an Ask again', [`--previous=${JSON.stringify({ ...PREVIOUS, purpose: 'ask_again' })}`, `--threads=${JSON.stringify(THREADS)}`], /^Ask threads is invalid: .*Ask again carries no threads$/u],
    ['earlier turns beside an Ask again', [`--previous=${JSON.stringify({ ...PREVIOUS, purpose: 'ask_again', earlier: [EARLIER] })}`], /^Ask previous is invalid: .*Ask again carries no earlier turns$/u],
    ['an earlier turn that breaks a previous turn\'s rule', [`--previous=${JSON.stringify({ ...PREVIOUS, earlier: [{ ...EARLIER, purpose: 'follow_up' }] })}`], /^Ask previous is invalid/u],
  ] as const)('refuses %s before anything is sent, as invalid_request, so a caller can ask without it', async (_name, argv, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const run = cli(fetch);
    const question = argv.some(arg => arg.includes('ask_again')) ? PREVIOUS.question : QUESTION;
    expect(await run.run(['ask', `--question=${question}`, ...argv])).toBe(2);
    expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', error: expect.stringMatching(error) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['names a thread that was not sent', elsewhere([2]), ['--progress', `--threads=${JSON.stringify(THREADS)}`]],
    ['places a question no threads were sent for', answered({ question: QUESTION, thread: { kind: 'new' } }), []],
    ['does not place a question the threads were sent for', answered({ question: QUESTION }), ['--progress', `--threads=${JSON.stringify(THREADS)}`]],
  ] as const)('fails the Ask as invalid_response when the answer %s', async (_name, answer, argv) => {
    const run = cli(replying(answer));
    expect(await run.run(['ask', `--question=${QUESTION}`, ...argv])).toBe(1);
    expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response' });
  });
});
