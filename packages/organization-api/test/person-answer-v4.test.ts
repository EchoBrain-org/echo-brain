import { describe, expect, it } from 'vitest';
import {
  PERSON_EVIDENCE_SEARCH_PATH_V1,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceDeskResponseV1,
  validatePersonEvidenceOpenRequestV1,
  validatePersonEvidenceSearchRequestV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const citation = {
  kind: 'approved_record' as const,
  atom_id: `sha256:${'a'.repeat(64)}`,
  record_sha256: `sha256:${'b'.repeat(64)}`,
  policy_id: 'project-members-readable-person-v1' as const,
};
const receipt_sha256 = `sha256:${'c'.repeat(64)}`;

describe('Agentic Ask V1 public contracts', () => {
  it('defines the desk endpoints and the Ask request', () => {
    expect(PERSON_EVIDENCE_SEARCH_PATH_V1).toBe('/v3/person/evidence/search');
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
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [1], private: false }] }],
    };
    expect(() => validatePersonAnswerResponseV8(response)).toThrow();
    response.parts[0]!.statements[0]!.citation_indexes = [];
    expect(() => validatePersonAnswerResponseV8(response)).toThrow();
  });

  it('refuses an approved-record citation under the retired organization-wide (Team) policy, which no record carries', () => {
    const response = {
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation: { ...citation, policy_id: 'organization-member-readable-person-v2' }, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }] }],
    };
    expect(() => validatePersonAnswerResponseV8(response)).toThrow('policy_id is invalid');
  });

  it('distinguishes an inventory result from released text and validates fresh HTTP open coordinates', () => {
    expect(validatePersonEvidenceSearchRequestV1({ schema_version: 1, kinds: ['decision'], limit: 10, project_id }))
      .toEqual({ schema_version: 1, kinds: ['decision'], limit: 10, project_id });
    expect(validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours: 2, project_id }))
      .toMatchObject({ citation, neighbours: 2, project_id });
    const inventory = validatePersonEvidenceDeskResponseV1({
      schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false,
      items: [{ id: 'desk-item-1', citation, kind: 'decision', label: 'Launch decision', visibility: 'team', receipt_sha256 }],
    });
    expect(inventory.items[0]).not.toHaveProperty('text');
    expect(() => validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation, neighbours: 3 })).toThrow();
  });

  it('preserves exact evidence whitespace while requiring model prose to be trimmed', () => {
    const item = {
      id: 'desk-item-1', citation, kind: 'decision', label: 'Launch decision', visibility: 'team', receipt_sha256,
      text: '  Exact released evidence\n',
    };
    expect(validatePersonEvidenceDeskResponseV1({
      schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false, items: [item],
    }).items[0]?.text).toBe(item.text);
    expect(() => validatePersonAnswerResponseV8({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: ' Prose is not trimmed.', citation_indexes: [0], private: false }] }],
    })).toThrow();
  });

  it('derives private from cited visibility and refuses evidence in no-evidence outcomes', () => {
    const privateCitation = { citation, kind: 'note' as const, label: 'Private note', visibility: 'only_me' as const };
    const base = {
      schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const,
      citations: [privateCitation], parts: [{ question: 'What changed?', status: 'answered' as const, statements: [{ text: 'Private evidence.', citation_indexes: [0], private: false }] }],
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
    expect(validatePersonEvidenceDeskResponseV1({
      schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false,
      items: [{ id: 'unicode-source', citation: sourceCitation, kind: 'document_passage', label: '🧪'.repeat(200), visibility: 'team', receipt_sha256 }],
    }).items[0]?.label).toBe('🧪'.repeat(200));
  });

  it('refuses the retired mine scope on answers and desk responses, alone or with a project', () => {
    const answer = (scope: unknown) => ({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What did I decide?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }] }],
    });
    const desk = (scope: unknown) => ({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope, truncated: false, items: [] });
    for (const scope of [{ kind: 'mine' }, { kind: 'mine', project_id }]) {
      expect(() => validatePersonAnswerResponseV8(answer(scope))).toThrow('Ask response scope is invalid');
      expect(() => validatePersonEvidenceDeskResponseV1(desk(scope))).toThrow('Ask response scope is invalid');
    }
    expect(validatePersonEvidenceDeskResponseV1(desk({ kind: 'global' })).scope).toEqual({ kind: 'global' });
    expect(() => validatePersonAnswerResponseV8(answer({ kind: 'everyone' }))).toThrow('Ask response scope is invalid');
  });

  it('refuses an Ask with mine, a retired scope, alone or with a project', () => {
    for (const mine of [true, false, 'true', 1, null]) {
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine })).toThrow('Ask request has an unexpected shape');
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine, project_id })).toThrow('Ask request has an unexpected shape');
    }
  });

  it('carries a citation ref only when it names the cited item (ADR-0024)', () => {
    const answer = (value: Record<string, unknown>) => ({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ kind: 'decision', label: 'Launch decision', visibility: 'team', ...value }],
      parts: [{ question: 'What did I decide?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }] }],
    });
    const document_id = `doc_${'1'.repeat(64)}`;
    const source = {
      kind: 'source_revision' as const, source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1',
      source_sha256: `sha256:${'e'.repeat(64)}`, representation_sha256: `sha256:${'f'.repeat(64)}`, anchor_sha256: `sha256:${'0'.repeat(64)}`,
    };
    const note = `note:ctx_${'2'.repeat(64)}`;
    const accepted = [
      { citation, ref: `meeting:${citation.record_sha256}` },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: `document:${document_id}` },
      { citation: source, kind: 'note', ref: note },
    ];
    for (const value of accepted) expect(validatePersonAnswerResponseV8(answer(value)).citations[0]!.ref).toBe(value.ref);
    // A citation without a ref still validates.
    expect(validatePersonAnswerResponseV8(answer({ citation }))).not.toHaveProperty('citations.0.ref');
    const rejected = [
      { citation, ref: `meeting:sha256:${'9'.repeat(64)}` },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: note },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: `document:doc_${'3'.repeat(64)}` },
      { citation: source, kind: 'note', ref: `document:${document_id}` },
      { citation: source, kind: 'note', ref: `meeting:${citation.record_sha256}` },
    ];
    for (const value of rejected) expect(() => validatePersonAnswerResponseV8(answer(value))).toThrow('Ask response citation ref is inconsistent');
    for (const ref of [`record:${citation.record_sha256}`, `meeting:${citation.record_sha256} `, `meeting:sha256:${'A'.repeat(64)}`, 42]) {
      expect(() => validatePersonAnswerResponseV8(answer({ citation, ref }))).toThrow('Ask response citation ref is invalid');
    }
    // The retired transcript ref (ADR-0046) is no ref at all.
    expect(() => validatePersonAnswerResponseV8(answer({ citation: source, kind: 'note', ref: `transcript:${citation.record_sha256}` })))
      .toThrow('Ask response citation ref is invalid');
  });

  it('keeps the evidence desk contract exact-key: a desk item never carries a ref', () => {
    const item = { id: 'desk-item-1', citation, kind: 'decision', label: 'Launch decision', visibility: 'team', receipt_sha256 };
    const desk = (value: unknown) => ({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false, items: [value] });
    expect(validatePersonEvidenceDeskResponseV1(desk(item)).items[0]).toEqual(item);
    expect(() => validatePersonEvidenceDeskResponseV1(desk({ ...item, ref: `meeting:${citation.record_sha256}` }))).toThrow('Evidence desk item has an unexpected shape');
  });

  it('allows up to ten statements in a part (RFC-0003) and rejects more', () => {
    const response = (count: number) => ({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch review', visibility: 'team' }],
      parts: [{ question: 'What is the plan?', status: 'answered', statements: Array.from({ length: count }, (_, index) => ({ text: `Fact ${index}.`, citation_indexes: [0], private: false })) }],
    });
    expect(validatePersonAnswerResponseV8(response(10)).parts[0]!.statements).toHaveLength(10);
    expect(() => validatePersonAnswerResponseV8(response(11))).toThrow('Ask response part is invalid');
  });
});
