import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V2,
  PERSON_SOURCE_EVIDENCE_PATH_V1,
  validatePersonAnswerRequestV2,
  validatePersonAnswerResponseV3,
  validatePersonSourceEvidenceReadRequestV1,
  validatePersonSourceEvidenceV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const atom_id = `sha256:${'a'.repeat(64)}`;
const record_sha256 = `sha256:${'b'.repeat(64)}`;
const source_id = `source:${'c'.repeat(64)}`;
const source_sha256 = `sha256:${'d'.repeat(64)}`;
const document_id = `doc_${'e'.repeat(64)}`;
const representation_sha256 = `sha256:${'f'.repeat(64)}`;
const anchor_sha256 = `sha256:${'0'.repeat(64)}`;

describe('Person Ask V3 public contract', () => {
  it('defines the additive V2 endpoint and preserves global absence as a request coordinate', () => {
    expect(PERSON_ANSWER_PATH_V2).toBe('/v2/person/ask');
    expect(validatePersonAnswerRequestV2({ schema_version: 2, question: 'What changed?' }))
      .toEqual({ schema_version: 2, question: 'What changed?' });
    expect(validatePersonAnswerRequestV2({ schema_version: 2, question: 'What changed?', project_id }))
      .toEqual({ schema_version: 2, question: 'What changed?', project_id });
  });

  it('uses discriminated citations and explicit response scope without counterfeit record fields', () => {
    expect(validatePersonAnswerResponseV3({
      schema_version: 3,
      kind: 'echo-clean-person-answer-v3',
      answer: 'The approved rollout is ready.',
      scope: { kind: 'project', project_id },
      citations: [
        { kind: 'approved_record', atom_id, record_sha256, policy_id: 'organization-member-readable-person-v2' },
        { kind: 'source_revision', source_id, revision_id: 'sha256:' + '1'.repeat(64), source_sha256, representation_sha256, anchor_sha256, document_id, label: 'MRD' },
      ],
    })).toEqual({
      schema_version: 3,
      kind: 'echo-clean-person-answer-v3',
      answer: 'The approved rollout is ready.',
      scope: { kind: 'project', project_id },
      citations: [
        { kind: 'approved_record', atom_id, record_sha256, policy_id: 'organization-member-readable-person-v2' },
        { kind: 'source_revision', source_id, revision_id: 'sha256:' + '1'.repeat(64), source_sha256, representation_sha256, anchor_sha256, document_id, label: 'MRD' },
      ],
    });
  });

  it('allows a bounded multiline answer and distinguishes cited chunks from one source revision', () => {
    const response = validatePersonAnswerResponseV3({
      schema_version: 3,
      kind: 'echo-clean-person-answer-v3',
      answer: 'The MRD says:\n\n- Ship the pilot\n- Review the data contract',
      scope: { kind: 'global' },
      citations: [
        { kind: 'source_revision', source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256, label: 'MRD' },
        { kind: 'source_revision', source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256: `sha256:${'1'.repeat(64)}`, label: 'MRD' },
      ],
    });
    expect(response.citations).toHaveLength(2);
  });

  it('reads a bounded immutable source packet only with complete source coordinates', () => {
    const citation = { kind: 'source_revision' as const, source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256, document_id };
    expect(PERSON_SOURCE_EVIDENCE_PATH_V1).toBe('/v2/person/ask/source');
    expect(validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'project', project_id }, citation }))
      .toEqual({ schema_version: 1, scope: { kind: 'project', project_id }, citation });
    expect(validatePersonSourceEvidenceV1({
      schema_version: 1,
      kind: 'echo-person-source-evidence-v1',
      scope: { kind: 'project', project_id },
      citation: { ...citation, label: 'MRD' },
      text: 'MRD\n\nReview before launch.',
    })).toMatchObject({ citation: { label: 'MRD' }, text: 'MRD\n\nReview before launch.' });
  });

  it.each([
    [{ schema_version: 2, question: 'Q', project_id: 'not-a-project' }],
    [{ schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Answer', scope: { kind: 'global', project_id }, citations: [] }],
    [{ schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Answer', scope: { kind: 'global' }, citations: [{ kind: 'source_revision', source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256, record_sha256 }] }],
    [{ schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Answer', scope: { kind: 'global' }, citations: [{ kind: 'approved_record', atom_id, record_sha256, policy_id: 'organization-member-readable-person-v2', source_id }] }],
    [{ schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Answer', scope: { kind: 'global' }, outcome: 'authorship_unsupported', citations: [{ kind: 'approved_record', atom_id, record_sha256, policy_id: 'organization-member-readable-person-v2' }] }],
    [{ schema_version: 1, scope: { kind: 'global' }, citation: { kind: 'source_revision', source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256, label: 'caller-controlled' } }],
  ])('rejects ambiguous or cross-kind fields', value => {
    if ((value as { schema_version: number }).schema_version === 2) {
      expect(() => validatePersonAnswerRequestV2(value)).toThrow();
    } else if ((value as { kind?: string }).kind === undefined) {
      expect(() => validatePersonSourceEvidenceReadRequestV1(value)).toThrow();
    } else {
      expect(() => validatePersonAnswerResponseV3(value)).toThrow();
    }
  });
});
