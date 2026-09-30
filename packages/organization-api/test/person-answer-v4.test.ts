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

  it('echoes a mine scope on answers and desk responses, but never a mine scope with a project', () => {
    const answer = (scope: unknown) => ({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch decision', visibility: 'team' }],
      parts: [{ question: 'What did I decide?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }] }],
    });
    const desk = (scope: unknown) => ({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope, truncated: false, items: [] });
    expect(validatePersonAnswerResponseV4(answer({ kind: 'mine' })).scope).toEqual({ kind: 'mine' });
    expect(validatePersonEvidenceDeskResponseV1(desk({ kind: 'mine' })).scope).toEqual({ kind: 'mine' });
    expect(() => validatePersonAnswerResponseV4(answer({ kind: 'mine', project_id }))).toThrow('Ask response scope has an unexpected shape');
    expect(() => validatePersonEvidenceDeskResponseV1(desk({ kind: 'mine', project_id }))).toThrow('Ask response scope has an unexpected shape');
    expect(() => validatePersonAnswerResponseV4(answer({ kind: 'everyone' }))).toThrow('Ask response scope is invalid');
  });

  it('asks with mine, but never mine with a project or mine other than true (ADR-0023)', () => {
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine: true }))
      .toEqual({ schema_version: 3, question: 'What did I decide?', mine: true });
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine: true, project_id })).toThrow('Ask request scope is invalid');
    for (const mine of [false, 'true', 1, null]) {
      expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'What did I decide?', mine })).toThrow('Ask request scope is invalid');
    }
  });

  it('carries a citation ref only when it names the cited item (ADR-0023)', () => {
    const answer = (value: Record<string, unknown>) => ({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'mine' }, outcome: 'answered',
      citations: [{ kind: 'decision', label: 'Launch decision', visibility: 'team', ...value }],
      parts: [{ question: 'What did I decide?', status: 'answered', statements: [{ text: 'The pilot is approved.', citation_indexes: [0], private: false }] }],
    });
    const document_id = `doc_${'1'.repeat(64)}`;
    const source = {
      kind: 'source_revision' as const, source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1',
      source_sha256: `sha256:${'e'.repeat(64)}`, representation_sha256: `sha256:${'f'.repeat(64)}`, anchor_sha256: `sha256:${'0'.repeat(64)}`,
    };
    const note = `note:ctx_${'2'.repeat(64)}`;
    const transcript = `transcript:${citation.record_sha256}`;
    const slack = {
      kind: 'slack_message' as const, team_id: 'T01ABCDEF', channel_id: 'C02ABCDEF', message_ts: '1758873600.000100',
      permalink: 'https://acme.slack.com/archives/C02ABCDEF/p1758873600000100', text_sha256: `sha256:${'d'.repeat(64)}`,
    };
    const accepted = [
      { citation, ref: `meeting:${citation.record_sha256}` },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: `document:${document_id}` },
      { citation: source, kind: 'note', ref: note },
      { citation: source, kind: 'note', ref: transcript },
    ];
    for (const value of accepted) expect(validatePersonAnswerResponseV4(answer(value)).citations[0]!.ref).toBe(value.ref);
    // A citation without a ref (an older server, or Slack) still validates.
    expect(validatePersonAnswerResponseV4(answer({ citation }))).not.toHaveProperty('citations.0.ref');
    const rejected = [
      { citation: slack, kind: 'slack_message', visibility: 'only_me', ref: `meeting:${citation.record_sha256}` },
      { citation, ref: `meeting:sha256:${'9'.repeat(64)}` },
      { citation, ref: transcript },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: note },
      { citation: { ...source, document_id }, kind: 'document_passage', ref: `document:doc_${'3'.repeat(64)}` },
      { citation: source, kind: 'note', ref: `document:${document_id}` },
      { citation: source, kind: 'note', ref: `meeting:${citation.record_sha256}` },
    ];
    for (const value of rejected) expect(() => validatePersonAnswerResponseV4(answer(value))).toThrow('Ask response citation ref is inconsistent');
    for (const ref of [`record:${citation.record_sha256}`, `meeting:${citation.record_sha256} `, `meeting:sha256:${'A'.repeat(64)}`, 42]) {
      expect(() => validatePersonAnswerResponseV4(answer({ citation, ref }))).toThrow('Ask response citation ref is invalid');
    }
  });

  it('keeps the evidence desk contract exact-key: a desk item never carries a ref', () => {
    const item = { id: 'desk-item-1', citation, kind: 'decision', label: 'Launch decision', visibility: 'team', receipt_sha256 };
    const desk = (value: unknown) => ({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'mine' }, truncated: false, items: [value] });
    expect(validatePersonEvidenceDeskResponseV1(desk(item)).items[0]).toEqual(item);
    expect(() => validatePersonEvidenceDeskResponseV1(desk({ ...item, ref: `meeting:${citation.record_sha256}` }))).toThrow('Evidence desk item has an unexpected shape');
  });

  it('allows up to ten statements in a part (RFC-0003) and rejects more', () => {
    const response = (count: number) => ({
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ citation, kind: 'decision', label: 'Launch review', visibility: 'team' }],
      parts: [{ question: 'What is the plan?', status: 'answered', statements: Array.from({ length: count }, (_, index) => ({ text: `Fact ${index}.`, citation_indexes: [0], private: false })) }],
    });
    expect(validatePersonAnswerResponseV4(response(10)).parts[0]!.statements).toHaveLength(10);
    expect(() => validatePersonAnswerResponseV4(response(11))).toThrow('Ask response part is invalid');
  });
});
