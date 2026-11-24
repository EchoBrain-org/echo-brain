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

describe('the asker\'s threads on the Person client (ADR-0056)', () => {
  it('sends the other threads and the thread\'s earlier turns on /v7, and returns where the answer says the question belongs', async () => {
    const previous = { ...PREVIOUS, earlier: [EARLIER] };
    const fetch = replying(elsewhere([1], { merge: [0] }));
    const result = await client(fetch).askWithLiveProgress(QUESTION, undefined, undefined, () => undefined, previous, undefined, THREADS);
    expect(result.result).toEqual(elsewhere([1], { merge: [0] }));
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v7/person/ask');
    expect(bodyOf(init)).toEqual({ schema_version: 3, question: QUESTION, previous, threads: THREADS });
    // With no previous turn the request carries the threads alone, and its answer says the subject is new.
    const alone = replying(answered({ question: QUESTION, thread: { kind: 'new' } }));
    await expect(client(alone).askWithLiveSources(QUESTION, undefined, undefined, undefined, THREADS)).resolves.toMatchObject({ thread: { kind: 'new' } });
    expect(bodyOf(alone.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, threads: THREADS });
    // An Ask that carries neither sends neither.
    const plain = replying(answered());
    await client(plain).askWithLiveSources(QUESTION);
    expect(bodyOf(plain.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION });
  });

  it('refuses an answer that places the question or names a merge when the Ask sent no threads', async () => {
    for (const answer of [answered({ question: QUESTION, thread: { kind: 'new' } }), answered({ question: QUESTION, merge: [0] }), elsewhere([0])]) {
      await expect(client(replying(answer)).askWithLiveSources(QUESTION), JSON.stringify(answer)).rejects.toMatchObject({ code: 'invalid_response' });
      // A previous turn alone does not make them answerable either.
      await expect(client(replying(answer)).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS), JSON.stringify(answer)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('refuses an index past the threads it sent, in the placement or the merge', async () => {
    for (const answer of [elsewhere([2]), elsewhere([0, 2]), elsewhere([0], { merge: [2] }), answered({ question: QUESTION, merge: [1, 2] })]) {
      await expect(client(replying(answer)).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS, THREADS), JSON.stringify(answer)).rejects.toMatchObject({ code: 'invalid_response' });
    }
    // The last thread sent is in range.
    await expect(client(replying(elsewhere([1], { merge: [0] }))).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS, THREADS)).resolves.toMatchObject({ thread: { kind: 'other', threads: [1] } });
  });

  it('refuses an answer that leaves out what an Ask that sent the threads is owed (T2): the question it answers, and with no previous turn, where that belongs', async () => {
    const asked = (answer: unknown, previous?: PersonAnswerPreviousV1, threads = THREADS) => client(replying(answer)).askWithLiveSources(QUESTION, undefined, undefined, previous, threads);
    // No question named: not an answer to an Ask that sent the threads, with a previous turn or without.
    await expect(asked(answered(), PREVIOUS)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(asked(answered())).rejects.toMatchObject({ code: 'invalid_response' });
    // With no previous turn there is no thread to continue: an ordinary answer must say the subject is new, and a merge
    // has nothing to merge into.
    await expect(asked(answered({ question: QUESTION }))).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(asked(answered({ question: QUESTION, merge: [0] }))).rejects.toMatchObject({ code: 'invalid_response' });
    // An empty list is a list sent, and is owed the same.
    await expect(asked(answered({ question: QUESTION }), undefined, [])).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(asked(answered({ question: QUESTION, thread: { kind: 'new' } }), undefined, [])).resolves.toMatchObject({ thread: { kind: 'new' } });
    // With a previous turn the same answers continue its thread, and a merge joins that one.
    await expect(asked(answered({ question: QUESTION }), PREVIOUS)).resolves.toMatchObject({ question: QUESTION });
    await expect(asked(answered({ question: QUESTION, merge: [0] }), PREVIOUS)).resolves.toMatchObject({ merge: [0] });
    // An Ask that sent no threads is owed neither, as before.
    await expect(client(replying(answered())).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS)).resolves.toMatchObject({ outcome: 'answered' });
  });

  it('with threads and no previous turn, takes a named question but still no since and no choices', async () => {
    // A question that belongs to another thread names the question asked.
    await expect(client(replying(elsewhere([0]))).askWithLiveSources(QUESTION, undefined, undefined, undefined, THREADS)).resolves.toMatchObject({ question: QUESTION });
    await expect(client(replying(answered({ question: QUESTION, thread: { kind: 'new' } }))).askWithLiveSources(QUESTION, undefined, undefined, undefined, THREADS)).resolves.toMatchObject({ question: QUESTION });
    const { thread: _thread, ...clarify } = elsewhere([0]);
    const choices = { ...clarify, choices: [{ label: 'THERM-482', question: 'What are the details on THERM-482?' }] };
    for (const answer of [answered({ question: QUESTION, since: { statements: [] } }), choices]) {
      await expect(client(replying(answer)).askWithLiveSources(QUESTION, undefined, undefined, undefined, THREADS), JSON.stringify(answer)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('person ask --threads (ADR-0056)', () => {
  it('sends the validated list and prints the answer it gets, with or without progress and a previous turn', async () => {
    const previous = { ...PREVIOUS, earlier: [EARLIER] };
    const streamed = replying(elsewhere([1]));
    const progress = cli(streamed);
    expect(await progress.run(['ask', `--question=${QUESTION}`, '--progress', `--previous=${JSON.stringify(previous)}`, `--threads=${JSON.stringify(THREADS)}`])).toBe(0);
    expect(validatePersonAskProgressResultLineV3(lines(progress.output.stdout).at(-1))).toMatchObject({ result: { outcome: 'clarify', thread: { kind: 'other', threads: [1] } } });
    expect(bodyOf(streamed.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, previous, threads: THREADS });
    const plain = replying(answered({ question: QUESTION, thread: { kind: 'new' } }));
    const once = cli(plain);
    expect(await once.run(['ask', `--question=${QUESTION}`, `--threads=${JSON.stringify(THREADS)}`])).toBe(0);
    expect(lines(once.output.stdout).at(-1)).toMatchObject({ ok: true, result: { thread: { kind: 'new' } } });
    expect(bodyOf(plain.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, threads: THREADS });
  });

  it('sends an empty list too: the asker has no other thread, and the answer may still say the question starts one', async () => {
    const first = replying(answered({ question: QUESTION, thread: { kind: 'new' } }));
    const run = cli(first);
    expect(await run.run(['ask', `--question=${QUESTION}`, `--previous=${JSON.stringify(PREVIOUS)}`, '--threads=[]'])).toBe(0);
    expect(lines(run.output.stdout).at(-1)).toMatchObject({ ok: true, result: { thread: { kind: 'new' } } });
    expect(bodyOf(first.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, previous: PREVIOUS, threads: [] });
    // With none sent, every thread an answer names is one the Ask did not send.
    await expect(client(replying(elsewhere([0]))).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS, [])).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client(replying(answered({ question: QUESTION, merge: [0] }))).askWithLiveSources(QUESTION, undefined, undefined, PREVIOUS, [])).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses a list it cannot send before anything is sent, as invalid_request, so a caller can ask without it', async () => {
    for (const threads of ['{not json', '{}', JSON.stringify([{ questions: [], asked_at: THREADS[0]!.asked_at }]), JSON.stringify([{ ...THREADS[0], title: 'Billing' }]),
      JSON.stringify([{ questions: [' padded '], asked_at: THREADS[0]!.asked_at }]), JSON.stringify([{ questions: ['When?'], asked_at: '2026-10-23' }])]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const run = cli(fetch);
      expect(await run.run(['ask', `--question=${QUESTION}`, '--progress', `--threads=${threads}`]), threads).toBe(2);
      expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', error: expect.stringMatching(/^Ask threads (JSON )?is invalid/u) });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('refuses threads, or earlier turns, beside an Ask again before anything is sent', async () => {
    const again = { ...PREVIOUS, purpose: 'ask_again' };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const threads = cli(fetch);
    expect(await threads.run(['ask', `--question=${PREVIOUS.question}`, `--previous=${JSON.stringify(again)}`, `--threads=${JSON.stringify(THREADS)}`])).toBe(2);
    expect(lines(threads.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', error: expect.stringMatching(/^Ask threads is invalid: .*Ask again carries no threads$/u) });
    const earlier = cli(fetch);
    expect(await earlier.run(['ask', `--question=${PREVIOUS.question}`, `--previous=${JSON.stringify({ ...again, earlier: [EARLIER] })}`])).toBe(2);
    expect(lines(earlier.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', error: expect.stringMatching(/^Ask previous is invalid: .*Ask again carries no earlier turns$/u) });
    // An earlier turn that breaks a previous turn's rule is refused the same way.
    const bad = cli(fetch);
    expect(await bad.run(['ask', `--question=${QUESTION}`, `--previous=${JSON.stringify({ ...PREVIOUS, earlier: [{ ...EARLIER, purpose: 'follow_up' }] })}`])).toBe(2);
    expect(lines(bad.output.stderr).at(-1)).toMatchObject({ code: 'invalid_request', error: expect.stringMatching(/^Ask previous is invalid/u) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails the Ask as invalid_response when the answer names a thread that was not sent', async () => {
    const run = cli(replying(elsewhere([2])));
    expect(await run.run(['ask', `--question=${QUESTION}`, '--progress', `--threads=${JSON.stringify(THREADS)}`])).toBe(1);
    expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response' });
    const unsent = cli(replying(answered({ question: QUESTION, thread: { kind: 'new' } })));
    expect(await unsent.run(['ask', `--question=${QUESTION}`])).toBe(1);
    expect(lines(unsent.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response' });
    // And when the answer does not place a question the threads were sent for.
    const unplaced = cli(replying(answered({ question: QUESTION })));
    expect(await unplaced.run(['ask', `--question=${QUESTION}`, '--progress', `--threads=${JSON.stringify(THREADS)}`])).toBe(1);
    expect(lines(unplaced.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response' });
  });
});
