import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_REQUEST_MAX_BYTES_V3,
  PERSON_QUERY_INPUT_MESSAGES_V1,
  PersonQueryInputError,
  personQuestionToSend,
  validatePersonAnswerRequestV3,
  validatePersonQueryText,
  validatePersonQuestionText,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceOpenRequestV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const citation = {
  kind: 'approved_record' as const,
  atom_id: `sha256:${'a'.repeat(64)}`,
  record_sha256: `sha256:${'b'.repeat(64)}`,
  policy_id: 'project-members-readable-person-v1' as const,
};

describe('Agentic Ask V1 public contracts', () => {
  it('defines the Ask request', () => {
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'What changed?', project_id }))
      .toEqual({ schema_version: 3, question: 'What changed?', project_id });
  });

  it('takes a long natural-language question on two lines: no distinct-word count, no 240-character cap', () => {
    const question = 'Can you summarize what the hardware and firmware teams decided about the thermal fix, who owns each follow-up, '
      + "what's still blocked on supplier samples, and what changed since last Tuesday's review?\nAnd which of those are due before Friday's build review?";
    expect(new Set(question.match(/[\p{L}\p{N}]+/gu)!.map(word => word.toLowerCase())).size).toBeGreaterThan(32);
    expect(question.length).toBeGreaterThan(240);
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question })).toEqual({ schema_version: 3, question });
    // The keyword search rule is unchanged: one line.
    expect(() => validatePersonQueryText(question)).toThrow(PersonQueryInputError);
  });

  it('has no question length of its own: the Ask request body bound is the only limit, and each refusal names its rule', () => {
    // 10,000 code points (40,000 UTF-8 bytes) is a question; it fits the 64 KiB Ask request body.
    expect(validatePersonQuestionText('😀'.repeat(10_000))).toHaveLength(20_000);
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: '😀'.repeat(10_000) }).question).toHaveLength(20_000);
    // Past the body bound, the request says so.
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'a'.repeat(PERSON_ANSWER_REQUEST_MAX_BYTES_V3) }))
      .toThrow('Ask request exceeds JSON byte bound');
    expect(validatePersonQuestionText('Who owns it?\tAnd\r\nwhen?')).toBe('Who owns it?\tAnd\r\nwhen?');
    // A symbol is a question: there is no term rule.
    expect(validatePersonQuestionText('?')).toBe('?');
    for (const [value, code] of [
      ['', 'question_empty'], [' \n ', 'question_empty'], [42, 'question_empty'], ['e\u0301', 'question_normalization'], [' Who owns it?', 'question_whitespace'],
      ['Who owns it?\n', 'question_whitespace'], ['Who\u0000 owns it?', 'question_controls'], ['Who\u007f owns it?', 'question_controls'],
      ['Who \ud800owns it?', 'question_controls'],
    ] as const) {
      let caught: unknown;
      try { validatePersonQuestionText(value); } catch (error) { caught = error; }
      expect(caught, String(value)).toBeInstanceOf(PersonQueryInputError);
      expect((caught as PersonQueryInputError).code, String(value)).toBe(code);
      // The Ask request reports the question's own rule.
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: value })).toThrow((caught as Error).message);
    }
  });

  it('gives clients one way to send a question: NFC and trimmed, and not empty', () => {
    expect(personQuestionToSend('  e\u0301 and\nmore \n')).toBe('\u00e9 and\nmore');
    expect(() => personQuestionToSend(' \n\t ')).toThrow(expect.objectContaining({ code: 'question_empty' }));
    // Whatever it sends, the rule takes, apart from a length or control the Authority names.
    expect(validatePersonQuestionText(personQuestionToSend(' Who owns it? '))).toBe('Who owns it?');
  });

  it('accepts a structured answer with cited prose and bounded deterministic fallback records', () => {
    const response = validatePersonAnswerResponseV8({
      schema_version: 8,
      kind: 'echo-clean-person-answer-v8',
      scope: { kind: 'project', project_id },
      outcome: 'partial',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      direct: { text: 'The pilot is approved.', citation_indexes: [0], private: false },
      parts: [{
        question: 'What changed?', status: 'answered',
        statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }],
        blocks: [{ kind: 'answer', statements: [0] }],
      }, {
        question: 'What was released?', status: 'records_only', statements: [],
        records: [{ text: ' Launch decision\n', citation_indexes: [0], private: false }],
      }],
    });
    expect(response.parts[1]?.records).toHaveLength(1);
    expect(response.direct?.citation_indexes).toEqual([0]);
  });

  it('rejects uncited statements and citation indexes outside the released packet', () => {
    const response = {
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [1], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }],
    };
    expect(() => validatePersonAnswerResponseV8(response)).toThrow();
    response.parts[0]!.statements[0]!.citation_indexes = [];
    expect(() => validatePersonAnswerResponseV8(response)).toThrow();
  });

  it('refuses an approved-record citation under the retired organization-wide (Team) policy, which no record carries', () => {
    const response = {
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation: { ...citation, policy_id: 'organization-member-readable-person-v2' }, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }],
    };
    expect(() => validatePersonAnswerResponseV8(response)).toThrow('policy_id is invalid');
  });

  it('validates evidence open coordinates', () => {
    expect(validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours: 2, project_id }))
      .toMatchObject({ citation, neighbours: 2, project_id });
    // Any whole number of neighbours: the desk reads as many as its open's byte budget holds and offers the next.
    expect(validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours: 40 })).toMatchObject({ neighbours: 40 });
    for (const neighbours of [-1, 1.5, '2', null]) expect(() => validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours })).toThrow();
  });

  it('preserves exact evidence whitespace while requiring model prose to be trimmed', () => {
    const text = '  Exact released evidence\n';
    expect(validatePersonAnswerResponseV8({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'partial',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'records_only', statements: [], records: [{ text, citation_indexes: [0], private: false }] }],
    }).parts[0]?.records?.[0]?.text).toBe(text);
    expect(() => validatePersonAnswerResponseV8({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: ' Prose is not trimmed.', citation_indexes: [0], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }],
    })).toThrow();
  });

  it('derives private from cited visibility and refuses evidence in no-evidence outcomes', () => {
    const privateCitation = { citation, kind: 'note' as const, label: 'Private note', visibility: 'only_me' as const };
    const base = {
      schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const,
      citations: [privateCitation], parts: [{ question: 'What changed?', status: 'answered' as const, statements: [{ text: 'Private evidence.', citation_indexes: [0], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }],
    };
    expect(() => validatePersonAnswerResponseV8(base)).toThrow();
    base.parts[0]!.statements[0]!.private = true;
    expect(validatePersonAnswerResponseV8(base).parts[0]?.statements[0]?.private).toBe(true);
    expect(() => validatePersonAnswerResponseV8({
      ...base, outcome: 'not_found', direct: { text: 'A direct answer.', citation_indexes: [0], private: true },
    })).toThrow('No-evidence outcome is inconsistent');
  });

  it('requires one to five consistent parts', () => {
    expect(() => validatePersonAnswerResponseV8({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations: [], parts: [],
    })).toThrow();
    expect(() => validatePersonAnswerResponseV8({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations: [],
      parts: [{ question: 'What changed?', status: 'records_only', statements: [] }],
    })).toThrow();
  });

  it('preserves V3 source-coordinate Unicode character limits', () => {
    const sourceCitation = {
      kind: 'source_revision' as const,
      source_id: `source:${'d'.repeat(64)}`,
      revision_id: '🧪'.repeat(512),
      source_sha256: `sha256:${'e'.repeat(64)}`,
      representation_sha256: `sha256:${'f'.repeat(64)}`,
      anchor_sha256: `sha256:${'0'.repeat(64)}`,
      label: '🧪'.repeat(200),
    };
    expect(validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation: sourceCitation }))
      .toMatchObject({ citation: sourceCitation });
  });

  it('refuses the retired mine scope on answers, alone or with a project', () => {
    const answer = (scope: unknown) => ({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What did I decide?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }], blocks: [{ kind: 'answer', statements: [0] }] }],
    });
    for (const scope of [{ kind: 'mine' }, { kind: 'mine', project_id }]) {
      expect(() => validatePersonAnswerResponseV8(answer(scope))).toThrow('Ask response scope is invalid');
    }
    expect(validatePersonAnswerResponseV8(answer({ kind: 'global' })).scope).toEqual({ kind: 'global' });
    expect(() => validatePersonAnswerResponseV8(answer({ kind: 'everyone' }))).toThrow('Ask response scope is invalid');
  });

  it('refuses an Ask with mine, a retired scope, alone or with a project', () => {
    for (const mine of [true, false, 'true', 1, null]) {
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine })).toThrow('Ask request has an unexpected shape');
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine, project_id })).toThrow('Ask request has an unexpected shape');
    }
  });

  it('refuses an Ask with a capture id: diagnostic captures are retired (SVC-9)', () => {
    const capture_id = 'cap_00000000-0000-4000-8000-000000000001';
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'Why is Thermo DVT on hold?', capture_id })).toThrow('Ask request has an unexpected shape');
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'Why is Thermo DVT on hold?', project_id, capture_id })).toThrow('Ask request has an unexpected shape');
  });

  it('allows more than RFC-0003\'s ten statements in a part, which its blocks arrange (ADR-0051)', () => {
    const response = (count: number) => ({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch review', visibility: 'team' }],
      parts: [{ question: 'What is the plan?', status: 'answered', statements: Array.from({ length: count }, (_, index) => ({ text: `Fact ${index}.`, citation_indexes: [0], private: false })),
        blocks: [{ kind: 'answer', statements: [0] }, { kind: 'text', statements: Array.from({ length: count - 1 }, (_, index) => index + 1) }] }],
    });
    expect(validatePersonAnswerResponseV8(response(10)).parts[0]!.statements).toHaveLength(10);
    expect(validatePersonAnswerResponseV8(response(11)).parts[0]!.statements).toHaveLength(11);
  });
});
