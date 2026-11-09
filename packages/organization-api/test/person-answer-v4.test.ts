import { describe, expect, it } from 'vitest';
import {
  validatePersonAnswerRequestV3,
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
    expect(() => validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours: 3 })).toThrow();
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
