import { describe, expect, it } from 'vitest';
import {
  PERSON_MEETING_TRANSCRIPT_PATH_V1,
  PERSON_SOURCE_EVIDENCE_PATH_V1,
  validatePersonSourceEvidenceReadRequestV1,
  validatePersonSourceEvidenceV1,
  validatePersonMeetingTranscriptReadRequestV1,
  validatePersonMeetingTranscriptV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const source_id = `source:${'c'.repeat(64)}`;
const source_sha256 = `sha256:${'d'.repeat(64)}`;
const document_id = `doc_${'e'.repeat(64)}`;
const representation_sha256 = `sha256:${'f'.repeat(64)}`;
const anchor_sha256 = `sha256:${'0'.repeat(64)}`;

describe('cited original and transcript public contracts', () => {
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

  it('validates the explicit, page-bounded approved-meeting transcript contract', () => {
    const citation = {
      kind: 'approved_meeting_transcript' as const,
      approval_id: 'apr_approval_fixture',
      source_id,
      revision_id: 'r1',
      source_sha256,
    };
    expect(PERSON_MEETING_TRANSCRIPT_PATH_V1).toBe('/v1/person/meeting-transcripts/read');
    expect(validatePersonMeetingTranscriptReadRequestV1({ schema_version: 1, scope: { kind: 'project', project_id }, citation, offset: 4 }))
      .toEqual({ schema_version: 1, scope: { kind: 'project', project_id }, citation, offset: 4 });
    expect(validatePersonMeetingTranscriptV1({
      schema_version: 1,
      kind: 'echo-person-meeting-transcript-v1',
      scope: { kind: 'project', project_id },
      citation,
      text: 'Approved transcript page.',
      next_offset: 27,
    })).toMatchObject({ citation, next_offset: 27 });
    expect(() => validatePersonMeetingTranscriptReadRequestV1({ schema_version: 1, scope: { kind: 'global' }, citation, unknown: true })).toThrow();
    expect(() => validatePersonMeetingTranscriptV1({ schema_version: 1, kind: 'echo-person-meeting-transcript-v1', scope: { kind: 'global' }, citation, text: 'Page', next_offset: 0, extra: true })).toThrow();
  });

  it('never reads a cited original or a transcript page under the mine scope', () => {
    const sourceCitation = { kind: 'source_revision' as const, source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256 };
    const transcriptCitation = { kind: 'approved_meeting_transcript' as const, approval_id: 'apr_approval_fixture', source_id, revision_id: 'r1', source_sha256 };
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'mine' }, citation: sourceCitation })).toThrow('Ask response scope is invalid');
    expect(() => validatePersonSourceEvidenceV1({
      schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: { kind: 'mine' }, citation: { ...sourceCitation, label: 'MRD' }, text: 'MRD',
    })).toThrow('Ask response scope is invalid');
    expect(() => validatePersonMeetingTranscriptReadRequestV1({ schema_version: 1, scope: { kind: 'mine' }, citation: transcriptCitation })).toThrow('Meeting transcript scope is invalid');
    expect(() => validatePersonMeetingTranscriptV1({
      schema_version: 1, kind: 'echo-person-meeting-transcript-v1', scope: { kind: 'mine' }, citation: transcriptCitation, text: 'Page', next_offset: null,
    })).toThrow('Meeting transcript scope is invalid');
  });

  it('rejects a caller-controlled label or a malformed project in a source read', () => {
    const citation = { kind: 'source_revision' as const, source_id, revision_id: 'r1', source_sha256, representation_sha256, anchor_sha256 };
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'global' }, citation: { ...citation, label: 'caller-controlled' } })).toThrow();
    expect(() => validatePersonSourceEvidenceReadRequestV1({ schema_version: 1, scope: { kind: 'project', project_id: 'not-a-project' }, citation })).toThrow();
  });
});
