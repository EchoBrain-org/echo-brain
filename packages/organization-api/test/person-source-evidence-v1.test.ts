import { describe, expect, it } from 'vitest';
import {
  PERSON_SOURCE_EVIDENCE_PATH_V1,
  validatePersonSourceEvidenceReadRequestV1,
  validatePersonSourceEvidenceV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const source_id = `source:${'c'.repeat(64)}`;
const source_sha256 = `sha256:${'d'.repeat(64)}`;
const document_id = `doc_${'e'.repeat(64)}`;
const representation_sha256 = `sha256:${'f'.repeat(64)}`;
const anchor_sha256 = `sha256:${'0'.repeat(64)}`;
const sourceCitation = { kind: 'source_revision' as const, source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256 };

describe('cited original public contracts', () => {
  it('reads a bounded immutable source packet only with complete source coordinates', () => {
    const citation = { ...sourceCitation, document_id };
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

  it('never reads a cited original under the mine scope', () => {
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'mine' }, citation: sourceCitation })).toThrow('Ask response scope is invalid');
    expect(() => validatePersonSourceEvidenceV1({
      schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: { kind: 'mine' }, citation: { ...sourceCitation, label: 'MRD' }, text: 'MRD',
    })).toThrow('Ask response scope is invalid');
  });

  it('rejects a caller-controlled label or a malformed project in a source read', () => {
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'global' }, citation: { ...sourceCitation, label: 'caller-controlled' } })).toThrow();
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'project', project_id: 'not-a-project' }, citation: sourceCitation })).toThrow();
  });
});
