import { canonicalJsonBytes, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  PERSON_ANSWER_REQUEST_MAX_BYTES_V3,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
} from '../src/index.js';

// The previous turn on Ask (ADR-0047, Ask timeline v1 C3) and what C4 removed from the contract.

const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10482', permalink: 'https://example.atlassian.net/browse/THERM-482', text_sha256: canonicalSha256('THERM-482') },
  kind: 'ticket' as const, label: 'THERM-482: Thermal fixture fails at 45 °C', visibility: 'only_me' as const,
};
const record = `sha256:${'a'.repeat(64)}` as const;
const decision = {
  citation: { kind: 'approved_record' as const, atom_id: `sha256:${'b'.repeat(64)}` as const, record_sha256: record, policy_id: 'project-members-readable-person-v1' as const },
  kind: 'decision' as const, label: 'DVT gate review: hold until THERM-482 is fixed', visibility: 'team' as const, ref: `meeting:${record}` as const,
};
const previous = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'follow_up', question: "What's blocking the DVT gate?", asked_at: '2026-10-24T17:05:00.000Z',
  statements: [{ text: 'THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.', citation_indexes: [0, 1] }],
  citations: [ticket, decision], ...overrides,
});
const ask = (value: unknown) => ({ schema_version: 3, question: 'what are the details on that ticket?', previous: value });

describe('the previous turn on the Ask request (ADR-0047)', () => {
  it('carries a follow-up or an Ask again, exactly as sent, and leaves a request without it unchanged', () => {
    expect(validatePersonAnswerRequestV3(ask(previous()))).toEqual(ask(previous()));
    const again = { schema_version: 3, question: previous().question, previous: previous({ purpose: 'ask_again', statements: [], citations: [] }) };
    expect(validatePersonAnswerRequestV3(again)).toEqual(again);
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'What changed?' })).toEqual({ schema_version: 3, question: 'What changed?' });
    expect(Object.isFrozen(validatePersonAnswerRequestV3(ask(previous())).previous!.statements[0])).toBe(true);
    // Scope rides beside it as before.
    const project_id = 'prj_00000000-0000-4000-8000-000000000001';
    expect(validatePersonAnswerRequestV3({ ...ask(previous()), project_id })).toMatchObject({ project_id, previous: previous() });
  });

  it('holds the whole earlier answer: its statements as released, each with a statement\'s own citations, inside the request', () => {
    const citations = Array.from({ length: 60 }, (_, index) => ({ ...ticket, citation: { ...ticket.citation, ticket_id: String(10_000 + index) }, label: `THERM-${index}` }));
    // No count of sentences or citations: 250 sentences, past the old 200; one citing 60 citations, past the old 40.
    const statements = [...Array.from({ length: 249 }, (_, index) => ({ text: `S${index}.`, citation_indexes: [index % 60] })),
      { text: `${'é'.repeat(1_000)}`, citation_indexes: Array.from({ length: 60 }, (_, index) => index) }];
    expect(validatePersonAnswerRequestV3(ask(previous({ citations, statements }))).previous!.statements).toHaveLength(250);
    // A sentence of any length: only the request's own transport bound limits it.
    expect(validatePersonAnswerRequestV3(ask(previous({ statements: [{ text: 'é'.repeat(4 * 1024), citation_indexes: [] }] }))).previous!.statements).toHaveLength(1);
    // A sentence may cite nothing the asker can still read; one that cites nothing at all is still the asker's context.
    expect(validatePersonAnswerRequestV3(ask(previous({ statements: [{ text: 'It is on hold.', citation_indexes: [] }] }))).previous!.statements[0]!.citation_indexes).toEqual([]);
  });

  it('refuses anything else: another purpose, key or shape, a bad question or time, an index out of range, a repeated citation', () => {
    for (const value of [
      previous({ purpose: 'clarify' }), { ...previous(), extra: true }, (({ asked_at: _asked, ...rest }) => rest)(previous()),
      previous({ question: ' padded ' }), previous({ question: 'a\u0007b' }), previous({ question: '' }), previous({ question: 'a\u0000b' }),
      previous({ asked_at: '2026-10-24T17:05:00Z' }), previous({ asked_at: '2026-02-30T00:00:00.000Z' }),
      previous({ statements: [{ text: 'Out of range.', citation_indexes: [2] }] }), previous({ statements: [{ text: 'Twice.', citation_indexes: [0, 0] }] }),
      previous({ statements: [{ text: ' Untrimmed.', citation_indexes: [0] }] }), previous({ statements: [{ text: 'Extra.', citation_indexes: [0], private: false }] }),
      previous({ citations: [ticket, ticket] }), previous({ citations: [{ ...ticket, kind: 'page' }] }),
      null, [], 'previous',
    ]) expect(() => validatePersonAnswerRequestV3(ask(value))).toThrow();
    // The earlier question has no length of its own: only the request's body bound limits it.
    expect(validatePersonAnswerRequestV3(ask(previous({ question: 'x'.repeat(10_000) }))).previous!.question).toHaveLength(10_000);
  });

  it('takes an Ask again only of the earlier question itself, and a follow-up of any question', () => {
    const again = previous({ purpose: 'ask_again' });
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: again.question, previous: again }).previous).toEqual(again);
    for (const question of ['what are the details on that ticket?', "what's blocking the DVT gate?", "What's blocking the DVT gate"]) {
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question, previous: again }), question).toThrow('Ask previous question is not the question asked again');
    }
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: again.question, previous: previous() }).previous!.purpose).toBe('follow_up');
  });

  it('carries a long earlier question, and keeps the whole request within the Authority\'s one 1 MiB Person body bound', () => {
    expect(PERSON_ANSWER_REQUEST_MAX_BYTES_V3).toBe(1024 * 1024);
    expect(MAX_ORGANIZATION_API_BODY_BYTES).toBe(PERSON_ANSWER_REQUEST_MAX_BYTES_V3);
    const long = `${'Who owns the thermal retest, '.repeat(130)}and when?\nAnd what is blocked?`;
    expect(validatePersonAnswerRequestV3(ask(previous({ question: long }))).previous!.question).toBe(long);
    const label = 'L'.repeat(1_000);
    const citations = Array.from({ length: 12 }, (_, index) => ({ ...ticket, citation: { ...ticket.citation, ticket_id: String(20_000 + index) }, label: `${index}${label}` }));
    const statements = Array.from({ length: 8 }, (_, index) => ({ text: `${index}${'s'.repeat(399)}`, citation_indexes: [index] }));
    const big = { ...ask(previous({ citations, statements, question: long })), question: '😀'.repeat(4_000) };
    expect(canonicalJsonBytes(big).byteLength).toBeGreaterThan(16 * 1024);
    expect(validatePersonAnswerRequestV3(big).question).toBe(big.question);
  });
});

/** A V8 answer to a request that carried the previous turn. */
const answered = (extra: Record<string, unknown> = {}, outcome = 'answered') => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome, citations: [ticket, decision],
  parts: [{ question: 'What are the details on THERM-482?', status: 'answered', statements: [{ text: 'THERM-482 is in progress, owned by Dev.', citation_indexes: [0], private: true }], blocks: [{ kind: 'answer', statements: [0] }] }],
  question: 'What are the details on THERM-482?', ...extra,
});
const clarified = (extra: Record<string, unknown> = {}) => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'clarify', citations: [], parts: [],
  question: 'what are the details on that ticket?',
  choices: [
    { label: 'THERM-482: thermal fixture', question: 'What are the details on THERM-482?' },
    { label: 'MECH-214: drop test', question: 'What are the details on MECH-214?' },
  ], ...extra,
});

describe('what an answer to the previous turn carries (ADR-0047)', () => {
  it('names the question it answers, and for an Ask again what is different since, each cited', () => {
    expect(validatePersonAnswerResponseV8(answered()).question).toBe('What are the details on THERM-482?');
    const since = { statements: [{ text: 'The DVT review on Oct 24 kept the gate on hold.', citation_indexes: [1], private: false }] };
    expect(validatePersonAnswerResponseV8(answered({ since })).since).toEqual(since);
    // Nothing material changed.
    expect(validatePersonAnswerResponseV8(answered({ since: { statements: [] } })).since).toEqual({ statements: [] });
    // Key order and bytes of an answer without the previous turn are as before.
    const plain = answered();
    delete (plain as { question?: unknown }).question;
    expect(JSON.stringify(validatePersonAnswerResponseV8(plain))).toBe(JSON.stringify(plain));
  });

  it('accepts a since of any length and an answer of any number of parts: the response\'s bytes bound them', () => {
    const statement = { text: 'Changed.', citation_indexes: [1], private: false };
    const many = answered({ since: { statements: Array.from({ length: 20 }, (_, index) => ({ ...statement, text: `Changed ${index}.` })) } });
    expect(validatePersonAnswerResponseV8(many).since!.statements).toHaveLength(20);
    const parts = answered();
    const sixParts = { ...parts, parts: Array.from({ length: 6 }, (_, index) => ({ ...parts.parts[0]!, question: `Part ${index + 1}?` })) };
    expect(validatePersonAnswerResponseV8(sixParts).parts).toHaveLength(6);
  });

  it('refuses a since that is not an Ask again answer\'s: uncited, out of range, without a question, or with no evidence', () => {
    const statement = { text: 'Changed.', citation_indexes: [1], private: false };
    for (const value of [
      answered({ since: { statements: [{ ...statement, citation_indexes: [] }] } }),
      answered({ since: { statements: [{ ...statement, citation_indexes: [2] }] } }),
      answered({ since: { statements: [{ ...statement, citation_indexes: [0] }] } }),
      answered({ since: { statements: [statement], extra: [] } }),
      (({ question: _question, ...rest }) => rest)(answered({ since: { statements: [] } })),
      { ...answered({ since: { statements: [] } }), outcome: 'not_found', citations: [], parts: [{ question: 'Q', status: 'not_found', statements: [], gap: 'Not found.' }] },
      { ...answered({ since: { statements: [] } }), outcome: 'partial', citations: [], parts: [{ question: 'Q', status: 'not_found', statements: [], gap: 'Research stopped early.' }] },
      answered({ question: 'a\u0007b' }), answered({ question: ' padded' }),
    ]) expect(() => validatePersonAnswerResponseV8(value)).toThrow();
  });

  it('asks which one with clarify: any number of full questions, each label one line of any length, and no part or citation', () => {
    const accepted = validatePersonAnswerResponseV8(clarified());
    expect(accepted).toEqual(clarified());
    expect(Object.isFrozen(accepted.choices![0])).toBe(true);
    const four = Array.from({ length: 4 }, (_, index) => ({ label: `Ticket ${index}`, question: `What are the details on THERM-${index}?` }));
    expect(validatePersonAnswerResponseV8(clarified({ choices: four })).choices).toHaveLength(4);
    expect(validatePersonAnswerResponseV8(clarified({ choices: [{ label: 'L'.repeat(600), question: 'What is A?' }, { label: 'B', question: 'What is B?' }] })).choices).toHaveLength(2);
    expect(validatePersonAnswerResponseV8(clarified({ choices: [...four, { label: 'Five', question: 'What is five?' }] })).choices).toHaveLength(5);
    expect(validatePersonAnswerResponseV8(clarified({ choices: four.slice(0, 1) })).choices).toHaveLength(1);
    for (const value of [
      clarified({ choices: [] }),
      clarified({ choices: [four[0], { ...four[1], question: four[0]!.question }] }), clarified({ choices: [four[0], { ...four[1], label: four[0]!.label }] }),
      clarified({ choices: [four[0], { ...four[1], label: 'two\nlines' }] }),
      clarified({ choices: [four[0], { ...four[1], question: 'q\u0007' }] }), clarified({ choices: [four[0], { ...four[1], extra: 1 }] }),
      (({ choices: _choices, ...rest }) => rest)(clarified()), (({ question: _question, ...rest }) => rest)(clarified()),
      clarified({ citations: [ticket] }), clarified({ parts: answered().parts }), clarified({ notice: 'Research stopped early.' }), clarified({ since: { statements: [] } }),
      answered({ choices: clarified().choices }),
    ]) expect(() => validatePersonAnswerResponseV8(value)).toThrow();
  });
});

describe('removed from the contract (ADR-0047 C4)', () => {
  const notFound = () => ({
    schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'not_found', citations: [],
    parts: [{ question: 'Q', status: 'not_found', statements: [], gap: 'Not found.' }],
  });

  it('refuses an assumption and the off_scope outcome, which only the retired A1 pipeline produced', () => {
    expect(validatePersonAnswerResponseV8(notFound()).outcome).toBe('not_found');
    expect(() => validatePersonAnswerResponseV8({ ...notFound(), assumption: 'You meant the DVT gate.' })).toThrow('Ask response has an unexpected shape');
    expect(() => validatePersonAnswerResponseV8({ ...notFound(), outcome: 'off_scope' })).toThrow('Ask response is invalid');
    // `notice` and `gap` stay.
    expect(validatePersonAnswerResponseV8({ ...notFound(), notice: 'Research stopped early.' }).notice).toBe('Research stopped early.');
  });
});
