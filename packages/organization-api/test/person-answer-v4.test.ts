import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V3,
  PERSON_CAPABILITIES_PATH_V1,
  PERSON_EVIDENCE_OPEN_PATH_V1,
  PERSON_EVIDENCE_SEARCH_PATH_V1,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV4,
  validatePersonCapabilitiesV1,
  validatePersonEvidenceDeskResponseV1,
  validatePersonEvidenceOpenRequestV1,
  validatePersonEvidenceSearchRequestV1,
} from '../src/index.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
const citation = {
  kind: 'approved_record' as const,
  atom_id: `sha256:${'a'.repeat(64)}`,
  record_sha256: `sha256:${'b'.repeat(64)}`,
  policy_id: 'organization-member-readable-person-v2' as const,
};
const receipt_sha256 = `sha256:${'c'.repeat(64)}`;

describe('Agentic Ask V1 public contracts', () => {
  it('defines the additive Ask, desk, and capability endpoints', () => {
    expect(PERSON_ANSWER_PATH_V3).toBe('/v3/person/ask');
    expect(PERSON_EVIDENCE_SEARCH_PATH_V1).toBe('/v3/person/evidence/search');
    expect(PERSON_EVIDENCE_OPEN_PATH_V1).toBe('/v3/person/evidence/open');
    expect(PERSON_CAPABILITIES_PATH_V1).toBe('/v3/person/capabilities');
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'What changed?', project_id }))
      .toEqual({ schema_version: 3, question: 'What changed?', project_id });
    expect(validatePersonCapabilitiesV1({ schema_version: 1, kind: 'echo-person-capabilities-v1', agentic_ask_v1: false }))
      .toEqual({ schema_version: 1, kind: 'echo-person-capabilities-v1', agentic_ask_v1: false });
  });

  it('accepts a structured answer with cited prose and bounded deterministic fallback records', () => {
    const response = validatePersonAnswerResponseV4({
      schema_version: 4,
      kind: 'echo-clean-person-answer-v4',
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
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [1], private: false }] }],
    };
    expect(() => validatePersonAnswerResponseV4(response)).toThrow();
    response.parts[0]!.statements[0]!.citation_indexes = [];
    expect(() => validatePersonAnswerResponseV4(response)).toThrow();
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
    expect(() => validatePersonAnswerResponseV4({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: ' Prose is not trimmed.', citation_indexes: [0], private: false }] }],
    })).toThrow();
  });

  it('derives private from cited visibility and refuses evidence in no-evidence outcomes', () => {
    const privateCitation = { citation, kind: 'note' as const, label: 'Private note', visibility: 'only_me' as const };
    const base = {
      schema_version: 4 as const, kind: 'echo-clean-person-answer-v4' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const,
      citations: [privateCitation], parts: [{ question: 'What changed?', status: 'answered' as const, statements: [{ text: 'Private evidence.', citation_indexes: [0], private: false }] }],
    };
    expect(() => validatePersonAnswerResponseV4(base)).toThrow();
    base.parts[0]!.statements[0]!.private = true;
    expect(validatePersonAnswerResponseV4(base).parts[0]?.statements[0]?.private).toBe(true);
    expect(() => validatePersonAnswerResponseV4({
      ...base, outcome: 'off_scope', direct: { text: 'A direct answer.', citation_indexes: [0], private: true },
    })).toThrow();
  });

  it('requires one to five consistent parts', () => {
    expect(() => validatePersonAnswerResponseV4({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered', citations: [], parts: [],
    })).toThrow();
    expect(() => validatePersonAnswerResponseV4({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered', citations: [],
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

  it('accepts a live Slack citation, marks DM statements private, and keeps open requests V3-only', () => {
    const slack = {
      kind: 'slack_message' as const, team_id: 'T01ABCDEF', channel_id: 'D02ABCDEF', message_ts: '1758873600.000100', thread_ts: '1758873600.000100',
      permalink: 'https://acme.slack.com/archives/D02ABCDEF/p1758873600000100', text_sha256: `sha256:${'d'.repeat(64)}`,
    };
    const body = (citationValue: unknown, kind = 'slack_message', isPrivate = true) => ({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation: citationValue, kind, label: 'DM with Dana · Priya · 2025-09-26', visibility: 'only_me' }],
      parts: [{ question: 'Is DVT on track?', status: 'answered', statements: [{ text: 'The vendor said Oct 16 in a DM.', citation_indexes: [0], private: isPrivate }] }],
    });
    expect(validatePersonAnswerResponseV4(body(slack)).citations[0]!.citation).toEqual(slack);
    expect(() => validatePersonAnswerResponseV4(body(slack, 'slack_message', false))).toThrow('private is inconsistent');
    expect(() => validatePersonAnswerResponseV4(body(slack, 'decision'))).toThrow('kind is inconsistent');
    expect(() => validatePersonAnswerResponseV4(body({ ...slack, permalink: 'https://evil.example/archives/D02ABCDEF/p1' }))).toThrow('permalink is invalid');
    expect(() => validatePersonAnswerResponseV4(body({ ...slack, message_ts: '17588' }))).toThrow('message_ts is invalid');
    expect(() => validatePersonAnswerResponseV4(body({ ...slack, text: 'leaked' }))).toThrow();
    expect(() => validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation: slack })).toThrow('Ask citation kind is invalid');
    expect(validatePersonEvidenceSearchRequestV1({ schema_version: 1, query: 'fixtures', kinds: ['decision', 'action', 'rationale', 'note', 'document_passage', 'slack_message'] }).kinds).toHaveLength(6);
  });
});
