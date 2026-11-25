import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_LABEL_MAX_CHARS_V1,
  PERSON_ANSWER_REQUEST_MAX_BYTES_V3,
  isPersonAnswerLabelV1,
  personAnswerLabelFitsV1,
  personAnswerLabelWordsV1,
  personAnswerThreadsProblemV1,
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

// A conversation's label (ADR-0057, Ask memory v1 R2, T1 and T2): one line in the asker's own words.

describe('a conversation\'s label (ADR-0057)', () => {
  const typed = ['When does the pilot start?', 'who owns it?', 'Does it cover ANNUAL plans?'];

  it('is one line of 1 to 80 characters with a word in it, and fits only when every word of it was typed, in any case', () => {
    expect(PERSON_ANSWER_LABEL_MAX_CHARS_V1).toBe(80);
    expect(personAnswerLabelWordsV1('Pilot: start, owns; ÉTÉ-2')).toEqual(['pilot', 'start', 'owns', 'été', '2']);
    for (const label of ['pilot', 'pilot: start, owns, annual plans', 'p'.repeat(80), '𝒑'.repeat(80)]) expect(isPersonAnswerLabelV1(label), label).toBe(true);
    for (const label of ['', ' pilot', 'pilot ', 'pilot\nstart', 'pilot start', 'pilot\u0007', '::: ...', 'p'.repeat(81), 'éte', 7, null, undefined]) {
      expect(isPersonAnswerLabelV1(label), JSON.stringify(label)).toBe(false);
    }
    expect(personAnswerLabelFitsV1('PILOT: start, owns, annual plans', typed)).toBe(true);
    // Words are used as typed: a different form of a typed word is not that word.
    for (const label of ['pilot owner', 'pilot starts', 'the pilots', 'billing']) expect(personAnswerLabelFitsV1(label, typed), label).toBe(false);
    expect(personAnswerLabelFitsV1('pilot', [])).toBe(false);
  });

  it('rides on a thread, on a follow-up\'s previous turn and as the request\'s ask for labels, each exactly as sent', () => {
    const labelled = thread({ questions: typed, label: 'pilot: start, owns, annual plans' });
    for (const request of [
      ask({ threads: [labelled, thread()], labels: true }),
      ask({ previous: previous({ label: 'DVT gate' }), threads: [labelled], labels: true }),
      // The previous turn's label is checked in form only: its question may be a model's rewrite, so its words are the client's to check.
      ask({ previous: previous({ label: 'words no question here holds', earlier: [turn()] }) }),
      ask({ labels: true }),
    ]) expect(validatePersonAnswerRequestV3(request)).toEqual(request);
    expect(validatePersonAnswerThreadsV1([labelled])).toEqual([labelled]);
  });

  it('refuses a thread label with a word its questions do not hold, any label not in form, and a label or the ask for labels beside an Ask again', () => {
    const again = (extra: Record<string, unknown> = {}) => ({ schema_version: 3, question: turn().question, previous: previous({ purpose: 'ask_again' }), ...extra });
    for (const [request, reason] of [
      [ask({ threads: [thread({ questions: typed, label: 'pilot owner' })] }), 'Ask thread label uses a word its questions do not'],
      [ask({ threads: [thread({ questions: typed, label: 'p'.repeat(81) })] }), 'Ask thread label is invalid'],
      [ask({ threads: [thread({ label: '' })] }), 'Ask thread label is invalid'],
      [ask({ previous: previous({ label: 'two\nlines' }) }), 'Ask previous label is invalid'],
      [ask({ previous: previous({ label: 7 }) }), 'Ask previous label is invalid'],
      // Only the conversation is labelled, never one of its older turns.
      [ask({ previous: previous({ earlier: [{ ...turn(), label: 'DVT gate' }] }) }), undefined],
      [ask({ labels: false }), 'Ask request labels must be true'],
      [ask({ labels: 'true' }), 'Ask request labels must be true'],
      [{ ...again(), previous: previous({ purpose: 'ask_again', label: 'DVT gate' }) }, 'Ask again carries no label'],
      [again({ labels: true }), 'Ask again reads no labels'],
    ] as const) expect(() => validatePersonAnswerRequestV3(request), JSON.stringify(request).slice(0, 200)).toThrow(reason);
  });

  it('comes back only on an ordinary answer that names its question, beside a merge but never a clarify, a placement or an Ask again\'s since', () => {
    for (const value of [answered({ label: 'Apollo launch date' }), answered({ label: 'Apollo launch date', merge: [1] })]) {
      expect(validatePersonAnswerResponseV8(value)).toEqual(value);
    }
    for (const value of [
      answered({ label: 'two\nlines' }), answered({ label: 'p'.repeat(81) }), answered({ label: '' }), answered({ label: null }),
      answered({ label: 'Apollo', thread: { kind: 'new' } }), elsewhere([1], { label: 'Apollo' }), { ...without(elsewhere([2]), 'thread'), choices, label: 'Apollo' },
      without(answered({ label: 'Apollo' }), 'question'), answered({ label: 'Apollo', since: { statements: [] } }),
    ]) expect(() => validatePersonAnswerResponseV8(value), JSON.stringify(value)).toThrow();
  });

  it('is a problem for a client that did not ask for labels, or sent no previous turn to label', () => {
    const labelled = { question: 'Did the Apollo launch date change?', label: 'Apollo launch date' };
    expect(personAnswerThreadsProblemV1(labelled, 1, true, true)).toBeNull();
    expect(personAnswerThreadsProblemV1(labelled, undefined, true, true)).toBeNull();
    for (const [continued, labels] of [[true, false], [false, true], [false, false]] as const) {
      expect(personAnswerThreadsProblemV1({ ...labelled, thread: { kind: 'new' } }, 1, continued, labels), `${continued} ${labels}`).toBe('unasked');
    }
    // An answer with no label is as it was, whatever was asked.
    expect(personAnswerThreadsProblemV1({ question: 'Q?' }, 1, true)).toBeNull();
  });
});
