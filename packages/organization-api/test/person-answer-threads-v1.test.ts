import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_REQUEST_MAX_BYTES_V3,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
  validatePersonAnswerThreadsV1,
} from '../src/index.js';

// The asker's threads on Ask (ADR-0056, Ask threads v1 T1 and T2): the other threads and the earlier turns a request
// carries, and where an answer says the question belongs.

const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10482', permalink: 'https://example.atlassian.net/browse/THERM-482', text_sha256: canonicalSha256('THERM-482') },
  kind: 'ticket' as const, label: 'THERM-482: Thermal fixture fails at 45 °C', visibility: 'only_me' as const,
};
const turn = (overrides: Record<string, unknown> = {}) => ({
  question: "What's blocking the DVT gate?", asked_at: '2026-10-24T17:05:00.000Z',
  statements: [{ text: 'THERM-482 blocks the DVT gate.', citation_indexes: [0] }], citations: [ticket], ...overrides,
});
const previous = (overrides: Record<string, unknown> = {}) => ({ purpose: 'follow_up', ...turn(), ...overrides });
const thread = (overrides: Record<string, unknown> = {}) => ({ questions: ['When does Apollo launch?', 'did that change?'], asked_at: '2026-11-16T18:00:00.000Z', ...overrides });
const ask = (extra: Record<string, unknown> = {}) => ({ schema_version: 3, question: 'did that change?', ...extra });

describe('the asker\'s other threads and the thread\'s earlier turns on the Ask request (T1)', () => {
  it('carries them exactly as sent and frozen, with no count of threads, questions or turns, and leaves a request without them as it was', () => {
    const many = Array.from({ length: 400 }, (_, index) => thread({ questions: Array.from({ length: 30 }, (_, at) => `Question ${index}.${at}?`) }));
    const older = [turn({ question: 'When does Apollo launch?', asked_at: '2026-10-20T17:05:00.000Z' }), turn({ question: 'who decided that?', statements: [], citations: [] })];
    for (const request of [
      ask({ threads: [thread(), thread({ questions: ['Who owns the billing migration?'], asked_at: '2026-11-17T18:00:00.000Z' })] }),
      ask({ previous: previous(), threads: [thread()], project_id: 'prj_00000000-0000-4000-8000-000000000001' }),
      // No other thread yet: the list still goes, empty, so the answer may say the question starts a new one.
      ask({ previous: previous(), threads: [] }), ask({ threads: [] }), ask({ threads: many }),
      ask({ previous: previous({ earlier: older }) }),
      ask({ previous: previous({ earlier: Array.from({ length: 300 }, (_, index) => turn({ question: `Question ${index}?` })) }) }),
      ask({ previous: previous() }),
    ]) expect(validatePersonAnswerRequestV3(request)).toEqual(request);
    const sent = validatePersonAnswerRequestV3(ask({ previous: previous({ earlier: older }), threads: [thread()] }));
    expect([Object.isFrozen(sent.threads![0]!.questions), Object.isFrozen(sent.previous!.earlier![0])]).toEqual([true, true]);
    expect(validatePersonAnswerThreadsV1([thread()])).toEqual([thread()]);
  });

  it('refuses a thread or earlier turn that breaks its rules, either beside an Ask again, and a body past the transport bound', () => {
    const again = (extra: Record<string, unknown>) => ({ schema_version: 3, question: turn().question, previous: previous({ purpose: 'ask_again', ...extra }) });
    for (const [request, reason] of [
      ...[
        [thread({ questions: [] })], [thread({ questions: [' padded '] })], [thread({ questions: ['a\u0007b'] })], [thread({ questions: [7] })],
        [thread({ asked_at: '2026-11-16T18:00:00Z' })], [{ ...thread(), title: 'Apollo' }], [(({ asked_at: _asked, ...rest }) => rest)(thread())], [null], {}, 'threads', null,
      ].map(threads => [ask({ threads }), undefined] as const),
      ...[
        [], [turn({ question: ' padded ' })], [turn({ asked_at: '2026-10-24' })], [{ ...turn(), purpose: 'follow_up' }], [{ ...turn(), earlier: [turn()] }],
        [turn({ statements: [{ text: 'Out of range.', citation_indexes: [1] }] })], [turn({ citations: [ticket, ticket] })],
        [turn({ statements: [{ text: 'Extra.', citation_indexes: [0], private: false }] })], [null], {}, null,
      ].map(earlier => [ask({ previous: previous({ earlier }) }), undefined] as const),
      [{ ...again({}), threads: [thread()] }, 'Ask again carries no threads'],
      [again({ earlier: [turn()] }), 'Ask again carries no earlier turns'],
      [ask({ threads: [thread({ questions: ['é'.repeat(PERSON_ANSWER_REQUEST_MAX_BYTES_V3)] })] }), 'Ask request exceeds JSON byte bound'],
      // Wrong in two places, a request fails on the field it always failed on first.
      [{ schema_version: 3, question: 'Q?', project_id: 'bad', previous: {} }, 'Ask request project_id'],
    ] as const) expect(() => validatePersonAnswerRequestV3(request), JSON.stringify(request).slice(0, 200)).toThrow(reason);
  });
});

const answered = (extra: Record<string, unknown> = {}) => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations: [ticket],
  parts: [{ question: 'Did the Apollo launch date change?', status: 'answered', statements: [{ text: 'It moved a week.', citation_indexes: [0], private: true }], blocks: [{ kind: 'answer', statements: [0] }] }],
  question: 'Did the Apollo launch date change?', ...extra,
});
const elsewhere = (threads: readonly number[], extra: Record<string, unknown> = {}) => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'clarify', citations: [], parts: [],
  question: 'did that change?', thread: { kind: 'other', threads }, ...extra,
});
const choices = [{ label: 'THERM-482', question: 'What are the details on THERM-482?' }];
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('where an answer says the question belongs (T2)', () => {
  it('takes a new subject on an answer, other threads on a clarify without choices, and a merge beside the open thread or the one other thread', () => {
    // An answer that says nothing of threads is as before: it continues the open thread.
    const asking = { ...without(elsewhere([2]), 'thread'), choices };
    for (const value of [answered(), answered({ thread: { kind: 'new' } }), elsewhere([2]), elsewhere([0, 3, 1]), answered({ merge: [1, 4] }), elsewhere([2], { merge: [0] }), asking]) {
      expect(validatePersonAnswerResponseV8(value)).toEqual(value);
    }
    expect(Object.isFrozen(validatePersonAnswerResponseV8(elsewhere([2])).thread)).toBe(true);
  });

  it('refuses a placement or merge that does not fit its outcome, or is not one', () => {
    for (const value of [
      // Other threads are a clarify, with no choices; a new subject is an answer; a clarify names choices or other threads.
      answered({ thread: { kind: 'other', threads: [1] } }), elsewhere([1], { choices }), elsewhere([1], { thread: { kind: 'new' } }),
      without(elsewhere([1]), 'thread'), without(elsewhere([1]), 'question'),
      elsewhere([]), elsewhere([1, 1]), elsewhere([-1]), elsewhere([1], { thread: { kind: 'other' } }), elsewhere([1], { thread: { kind: 'other', threads: [1], extra: 1 } }),
      answered({ thread: { kind: 'open' } }), answered({ thread: { kind: 'new', threads: [1] } }), answered({ thread: 'new' }), answered({ thread: null }),
      // A merge never beside choices (the answer to the choice names it), a new subject, several threads, or the thread itself.
      { ...without(elsewhere([2]), 'thread'), choices, merge: [0] }, answered({ thread: { kind: 'new' }, merge: [1] }), elsewhere([2, 3], { merge: [0] }), elsewhere([2], { merge: [2] }),
      answered({ merge: [] }), answered({ merge: [1, 1] }), answered({ merge: [-1] }), answered({ merge: [1.5] }), answered({ merge: '1' }),
      // An answer that says anything of threads names its question, and is never an Ask again's.
      without(answered({ thread: { kind: 'new' } }), 'question'), without(answered({ merge: [1] }), 'question'),
      answered({ thread: { kind: 'new' }, since: { statements: [] } }), answered({ merge: [1], since: { statements: [] } }),
    ]) expect(() => validatePersonAnswerResponseV8(value), JSON.stringify(value)).toThrow();
  });
});
