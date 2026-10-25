import { canonicalJsonBytes, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1,
  PERSON_ANSWER_PREVIOUS_MAX_CITATIONS_V1,
  PERSON_ANSWER_PREVIOUS_MAX_STATEMENTS_V1,
  PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1,
  PERSON_ANSWER_SINCE_MAX_STATEMENTS_V1,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV4,
  validatePersonAnswerResponseV5,
  validatePersonAnswerResponseV6,
  validatePersonAnswerResponseV7,
  validatePersonAnswerResponseV8,
} from '../src/index.js';

// The previous turn on Ask (ADR-0047, Ask timeline v1 C3) and what C4 removed from the contract.

const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10482', permalink: 'https://example.atlassian.net/browse/THERM-482', text_sha256: canonicalSha256('THERM-482') },
  kind: 'ticket' as const, label: 'THERM-482: Thermal fixture fails at 45 °C', visibility: 'only_me' as const,
};
const record = `sha256:${'a'.repeat(64)}` as const;
const decision = {
  citation: { kind: 'approved_record' as const, atom_id: `sha256:${'b'.repeat(64)}` as const, record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const },
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
    expect(validatePersonAnswerRequestV3(ask(previous({ purpose: 'ask_again', statements: [], citations: [] })))).toEqual(ask(previous({ purpose: 'ask_again', statements: [], citations: [] })));
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'What changed?' })).toEqual({ schema_version: 3, question: 'What changed?' });
    expect(Object.isFrozen(validatePersonAnswerRequestV3(ask(previous())).previous!.statements[0])).toBe(true);
    // Scope rides beside it as before.
    expect(validatePersonAnswerRequestV3({ ...ask(previous()), mine: true })).toMatchObject({ mine: true, previous: previous() });
  });

  it('holds 8 sentences of 400 characters, 4 citations each, among 12 citations of its answer', () => {
    const citations = Array.from({ length: PERSON_ANSWER_PREVIOUS_MAX_CITATIONS_V1 }, (_, index) => ({ ...ticket, citation: { ...ticket.citation, ticket_id: String(10_000 + index) }, label: `THERM-${index}` }));
    const statements = Array.from({ length: PERSON_ANSWER_PREVIOUS_MAX_STATEMENTS_V1 }, (_, index) => ({ text: `${'é'.repeat(PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1 - 1)}${index}`, citation_indexes: [index, index + 1, index + 2, index + 3] }));
    expect(validatePersonAnswerRequestV3(ask(previous({ citations, statements }))).previous!.statements).toHaveLength(8);
    for (const value of [
      previous({ citations, statements: [...statements, statements[0]] }),
      previous({ citations: [...citations, { ...ticket, citation: { ...ticket.citation, ticket_id: '99999' } }] }),
      previous({ statements: [{ text: 'x'.repeat(PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1 + 1), citation_indexes: [] }] }),
      previous({ citations, statements: [{ text: 'Five citations.', citation_indexes: [0, 1, 2, 3, 4] }] }),
    ]) expect(() => validatePersonAnswerRequestV3(ask(value))).toThrow();
    // A sentence may cite nothing the asker can still read; one that cites nothing at all is still the asker's context.
    expect(validatePersonAnswerRequestV3(ask(previous({ statements: [{ text: 'It is on hold.', citation_indexes: [] }] }))).previous!.statements[0]!.citation_indexes).toEqual([]);
  });

  it('refuses anything else: another purpose, key or shape, a bad question or time, an index out of range, a repeated citation', () => {
    for (const value of [
      previous({ purpose: 'clarify' }), { ...previous(), extra: true }, (({ asked_at: _asked, ...rest }) => rest)(previous()),
      previous({ question: ' padded ' }), previous({ question: 'x'.repeat(241) }), previous({ question: '' }),
      previous({ asked_at: '2026-10-24T17:05:00Z' }), previous({ asked_at: '2026-02-30T00:00:00.000Z' }),
      previous({ statements: [{ text: 'Out of range.', citation_indexes: [2] }] }), previous({ statements: [{ text: 'Twice.', citation_indexes: [0, 0] }] }),
      previous({ statements: [{ text: ' Untrimmed.', citation_indexes: [0] }] }), previous({ statements: [{ text: 'Extra.', citation_indexes: [0], private: false }] }),
      previous({ citations: [ticket, ticket] }), previous({ citations: [{ ...ticket, kind: 'page' }] }),
      null, [], 'previous',
    ]) expect(() => validatePersonAnswerRequestV3(ask(value))).toThrow();
  });

  it('keeps the whole request within its 16 KiB bound', () => {
    const label = 'L'.repeat(1_000);
    const citations = Array.from({ length: 12 }, (_, index) => ({ ...ticket, citation: { ...ticket.citation, ticket_id: String(20_000 + index) }, label: `${index}${label}` }));
    const statements = Array.from({ length: 8 }, (_, index) => ({ text: `${index}${'s'.repeat(399)}`, citation_indexes: [index] }));
    const big = ask(previous({ citations, statements }));
    expect(canonicalJsonBytes(big).byteLength).toBeGreaterThan(MAX_ORGANIZATION_API_BODY_BYTES);
    expect(() => validatePersonAnswerRequestV3(big)).toThrow('Ask request exceeds JSON byte bound');
  });
});

/** A V8 answer to a request that carried the previous turn. */
const answered = (extra: Record<string, unknown> = {}, outcome = 'answered') => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome, citations: [ticket, decision],
  parts: [{ question: 'What are the details on THERM-482?', status: 'answered', statements: [{ text: 'THERM-482 is in progress, owned by Dev.', citation_indexes: [0], private: true }] }],
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

  it('refuses a since that is not an Ask again answer\'s: uncited, out of range, too long, without a question, or with no evidence', () => {
    const statement = { text: 'Changed.', citation_indexes: [1], private: false };
    for (const value of [
      answered({ since: { statements: [{ ...statement, citation_indexes: [] }] } }),
      answered({ since: { statements: [{ ...statement, citation_indexes: [2] }] } }),
      answered({ since: { statements: [{ ...statement, citation_indexes: [0] }] } }),
      answered({ since: { statements: Array.from({ length: PERSON_ANSWER_SINCE_MAX_STATEMENTS_V1 + 1 }, (_, index) => ({ ...statement, text: `Changed ${index}.` })) } }),
      answered({ since: { statements: [statement], extra: [] } }),
      (({ question: _question, ...rest }) => rest)(answered({ since: { statements: [] } })),
      { ...answered({ since: { statements: [] } }), outcome: 'not_found', citations: [], parts: [{ question: 'Q', status: 'not_found', statements: [], gap: 'Not found.' }] },
      answered({ question: 'x'.repeat(241) }),
    ]) expect(() => validatePersonAnswerResponseV8(value)).toThrow();
  });

  it('asks which one with clarify: two to four full questions, the question asked, and no part or citation', () => {
    const accepted = validatePersonAnswerResponseV8(clarified());
    expect(accepted).toEqual(clarified());
    expect(Object.isFrozen(accepted.choices![0])).toBe(true);
    const four = Array.from({ length: 4 }, (_, index) => ({ label: `Ticket ${index}`, question: `What are the details on THERM-${index}?` }));
    expect(validatePersonAnswerResponseV8(clarified({ choices: four })).choices).toHaveLength(4);
    expect(validatePersonAnswerResponseV8(clarified({ choices: [{ label: 'L'.repeat(PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1), question: 'What is A?' }, { label: 'B', question: 'What is B?' }] })).choices).toHaveLength(2);
    for (const value of [
      clarified({ choices: four.slice(0, 1) }), clarified({ choices: [...four, { label: 'Five', question: 'What is five?' }] }),
      clarified({ choices: [four[0], { ...four[1], question: four[0]!.question }] }), clarified({ choices: [four[0], { ...four[1], label: four[0]!.label }] }),
      clarified({ choices: [four[0], { ...four[1], label: 'L'.repeat(PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1 + 1) }] }),
      clarified({ choices: [four[0], { ...four[1], question: 'q'.repeat(241) }] }), clarified({ choices: [four[0], { ...four[1], extra: 1 }] }),
      (({ choices: _choices, ...rest }) => rest)(clarified()), (({ question: _question, ...rest }) => rest)(clarified()),
      clarified({ citations: [ticket] }), clarified({ parts: answered().parts }), clarified({ notice: 'Research stopped early.' }), clarified({ since: { statements: [] } }),
      answered({ choices: clarified().choices }),
    ]) expect(() => validatePersonAnswerResponseV8(value)).toThrow();
  });

  it('keeps every answer before V8 closed to the previous turn', () => {
    const v7 = (extra: Record<string, unknown>) => ({ ...answered(), schema_version: 7, kind: 'echo-clean-person-answer-v7', citations: [decision],
      parts: [{ question: 'Q', status: 'answered', statements: [{ text: 'Held.', citation_indexes: [0], private: false }] }], ...extra });
    const { question: _question, ...plain } = v7({});
    expect(validatePersonAnswerResponseV7(plain).outcome).toBe('answered');
    expect(() => validatePersonAnswerResponseV7(v7({}))).toThrow();
    expect(() => validatePersonAnswerResponseV7({ ...clarified(), schema_version: 7, kind: 'echo-clean-person-answer-v7' })).toThrow();
  });
});

describe('removed from the contract (ADR-0047 C4)', () => {
  const at = (version: number) => ({
    schema_version: version, kind: `echo-clean-person-answer-v${version}`, scope: { kind: 'global' }, outcome: 'not_found', citations: [],
    parts: [{ question: 'Q', status: 'not_found', statements: [], gap: 'Not found.' }],
  });
  const validators = [validatePersonAnswerResponseV4, validatePersonAnswerResponseV5, validatePersonAnswerResponseV6, validatePersonAnswerResponseV7, validatePersonAnswerResponseV8];

  it('refuses an assumption and the off_scope outcome on every answer version, which nothing ever produced', () => {
    validators.forEach((validate, index) => {
      expect(validate(at(index + 4)).outcome).toBe('not_found');
      expect(() => validate({ ...at(index + 4), assumption: 'You meant the DVT gate.' })).toThrow('Ask response has an unexpected shape');
      expect(() => validate({ ...at(index + 4), outcome: 'off_scope' })).toThrow('Ask response is invalid');
      // `notice` and `gap` stay.
      expect(validate({ ...at(index + 4), notice: 'Research stopped early.' }).notice).toBe('Research stopped early.');
    });
  });
});
