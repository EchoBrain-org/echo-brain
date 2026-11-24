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

describe('the asker\'s other threads on the Ask request (ADR-0056)', () => {
  it('carries them exactly as sent, with or without a previous turn, and leaves a request without them unchanged', () => {
    const alone = ask({ threads: [thread(), thread({ questions: ['Who owns the billing migration?'], asked_at: '2026-11-17T18:00:00.000Z' })] });
    expect(validatePersonAnswerRequestV3(alone)).toEqual(alone);
    const following = ask({ previous: previous(), threads: [thread()], project_id: 'prj_00000000-0000-4000-8000-000000000001' });
    expect(validatePersonAnswerRequestV3(following)).toEqual(following);
    expect(Object.isFrozen(validatePersonAnswerRequestV3(alone).threads![0]!.questions)).toBe(true);
    expect(validatePersonAnswerRequestV3(ask({ previous: previous() }))).toEqual(ask({ previous: previous() }));
    expect(validatePersonAnswerThreadsV1([thread()])).toEqual([thread()]);
  });

  it('counts neither threads nor questions: the request\'s transport bound is the only limit', () => {
    const many = Array.from({ length: 400 }, (_, index) => thread({ questions: Array.from({ length: 30 }, (_, at) => `Question ${index}.${at}?`) }));
    expect(validatePersonAnswerRequestV3(ask({ threads: many })).threads).toHaveLength(400);
    const huge = [thread({ questions: ['é'.repeat(PERSON_ANSWER_REQUEST_MAX_BYTES_V3)] })];
    expect(() => validatePersonAnswerRequestV3(ask({ threads: huge }))).toThrow('Ask request exceeds JSON byte bound');
  });

  it('refuses anything else: none, a thread with no question, a bad question or time, another key, or an Ask again', () => {
    for (const threads of [
      [], [thread({ questions: [] })], [thread({ questions: [' padded '] })], [thread({ questions: ['a\u0007b'] })], [thread({ questions: [7] })],
      [thread({ asked_at: '2026-11-16T18:00:00Z' })], [{ ...thread(), title: 'Apollo' }], [(({ asked_at: _asked, ...rest }) => rest)(thread())],
      [null], {}, 'threads', null,
    ]) expect(() => validatePersonAnswerRequestV3(ask({ threads })), JSON.stringify(threads)).toThrow();
    const again = { schema_version: 3, question: turn().question, previous: previous({ purpose: 'ask_again' }), threads: [thread()] };
    expect(() => validatePersonAnswerRequestV3(again)).toThrow('Ask again carries no threads');
  });
});

describe('the earlier turns of the thread a follow-up continues (ADR-0056)', () => {
  it('carries them oldest first under the previous turn\'s own rules', () => {
    const older = [turn({ question: 'When does Apollo launch?', asked_at: '2026-10-20T17:05:00.000Z' }), turn({ question: 'who decided that?', statements: [], citations: [] })];
    const sent = ask({ previous: previous({ earlier: older }) });
    expect(validatePersonAnswerRequestV3(sent)).toEqual(sent);
    expect(Object.isFrozen(validatePersonAnswerRequestV3(sent).previous!.earlier![0])).toBe(true);
    // No count of turns.
    const long = Array.from({ length: 300 }, (_, index) => turn({ question: `Question ${index}?` }));
    expect(validatePersonAnswerRequestV3(ask({ previous: previous({ earlier: long }) })).previous!.earlier).toHaveLength(300);
  });

  it('refuses none, a turn that breaks a previous turn\'s rule, a purpose on one, and an Ask again that carries any', () => {
    for (const earlier of [
      [], [turn({ question: ' padded ' })], [turn({ asked_at: '2026-10-24' })], [{ ...turn(), purpose: 'follow_up' }], [{ ...turn(), earlier: [turn()] }],
      [turn({ statements: [{ text: 'Out of range.', citation_indexes: [1] }] })], [turn({ citations: [ticket, ticket] })],
      [turn({ statements: [{ text: 'Extra.', citation_indexes: [0], private: false }] })], [null], {}, null,
    ]) expect(() => validatePersonAnswerRequestV3(ask({ previous: previous({ earlier }) })), JSON.stringify(earlier)).toThrow();
    const again = { schema_version: 3, question: turn().question, previous: previous({ purpose: 'ask_again', earlier: [turn()] }) };
    expect(() => validatePersonAnswerRequestV3(again)).toThrow('Ask again carries no earlier turns');
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

describe('where an answer says the question belongs (ADR-0056)', () => {
  it('places an ordinary answer in a new thread, or names other threads on a clarify that offers no choices', () => {
    expect(validatePersonAnswerResponseV8(answered({ thread: { kind: 'new' } })).thread).toEqual({ kind: 'new' });
    expect(validatePersonAnswerResponseV8(elsewhere([2])).thread).toEqual({ kind: 'other', threads: [2] });
    expect(validatePersonAnswerResponseV8(elsewhere([0, 3, 1])).thread).toEqual({ kind: 'other', threads: [0, 3, 1] });
    expect(Object.isFrozen(validatePersonAnswerResponseV8(elsewhere([2])).thread)).toBe(true);
    // An answer that says nothing of threads is as before: it continues the open thread.
    expect(validatePersonAnswerResponseV8(answered())).toEqual(answered());
  });

  it('names threads on the same subject beside the open thread or the one other thread, never beside a new one or several', () => {
    expect(validatePersonAnswerResponseV8(answered({ merge: [1, 4] })).merge).toEqual([1, 4]);
    expect(validatePersonAnswerResponseV8(elsewhere([2], { merge: [0] })).merge).toEqual([0]);
    const choices = [{ label: 'THERM-482', question: 'What are the details on THERM-482?' }];
    const asking = { ...elsewhere([2]), thread: undefined, choices };
    delete (asking as { thread?: unknown }).thread;
    expect(validatePersonAnswerResponseV8(asking).choices).toHaveLength(1);
    for (const value of [
      // An answer that offers choices names no merge: the answer to the choice does.
      { ...asking, merge: [0] },
      answered({ thread: { kind: 'new' }, merge: [1] }), elsewhere([2, 3], { merge: [0] }), elsewhere([2], { merge: [2] }),
      answered({ merge: [] }), answered({ merge: [1, 1] }), answered({ merge: [-1] }), answered({ merge: [1.5] }), answered({ merge: '1' }),
    ]) expect(() => validatePersonAnswerResponseV8(value), JSON.stringify(value)).toThrow();
  });

  it('refuses a placement that does not fit its outcome, or is not one', () => {
    const choices = [{ label: 'THERM-482', question: 'What are the details on THERM-482?' }];
    for (const value of [
      // Other threads are a clarify, with no choices; a new subject is an answer.
      answered({ thread: { kind: 'other', threads: [1] } }), elsewhere([1], { choices }), elsewhere([1], { thread: { kind: 'new' } }),
      // A clarify names choices or other threads.
      (({ thread: _thread, ...rest }) => rest)(elsewhere([1])), (({ question: _question, ...rest }) => rest)(elsewhere([1])),
      elsewhere([]), elsewhere([1, 1]), elsewhere([-1]), elsewhere([1], { thread: { kind: 'other' } }), elsewhere([1], { thread: { kind: 'other', threads: [1], extra: 1 } }),
      answered({ thread: { kind: 'open' } }), answered({ thread: { kind: 'new', threads: [1] } }), answered({ thread: 'new' }), answered({ thread: null }),
      // An answer that says anything of threads names its question, and is never an Ask again's.
      (({ question: _question, ...rest }) => rest)(answered({ thread: { kind: 'new' } })), (({ question: _question, ...rest }) => rest)(answered({ merge: [1] })),
      answered({ thread: { kind: 'new' }, since: { statements: [] } }), answered({ merge: [1], since: { statements: [] } }),
    ]) expect(() => validatePersonAnswerResponseV8(value), JSON.stringify(value)).toThrow();
  });
});
