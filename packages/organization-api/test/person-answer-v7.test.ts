import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V6,
  personFollowUpRefV1,
  validatePersonAnswerCitationV6,
  validatePersonAnswerCitationV7,
  validatePersonAnswerResponseV6,
  validatePersonAnswerResponseV7,
  validatePersonFollowUpCitationV1,
  validatePersonFollowUpEvidenceV1,
  validatePersonFollowUpRefV1,
  validatePersonOpenRefV1,
  validatePersonEvidenceDeskResponseV1,
} from '../src/index.js';

const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const followUp = { kind: 'follow_up' as const, item_id: itemId };
const ref = `follow_up:${itemId}` as const;
const cited = { citation: followUp, kind: 'follow_up' as const, label: 'THERM-48 Fan curve v2', visibility: 'team' as const, ref };
const record = `sha256:${'a'.repeat(64)}` as const;
const meeting = { citation: { kind: 'approved_record' as const, atom_id: `sha256:${'b'.repeat(64)}` as const, record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'Ship fan curve v2', visibility: 'team' as const, ref: `meeting:${record}` as const };
const response = (citations: readonly unknown[] = [cited]) => ({
  schema_version: 7 as const, kind: 'echo-clean-person-answer-v7' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations,
  parts: [{ question: 'What are my open tasks?', status: 'answered' as const, statements: [{ text: 'Mara owns the fan curve follow-up.', citation_indexes: [0], private: false }] }],
});
const evidence = {
  item_id: itemId, kind: 'ticket' as const, title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open' as const, due_at: '2026-10-20',
  check: { verdict: 'still_open' as const, checked_at: '2026-10-15T09:30:00.000Z' },
  decision: { title: 'THERM DVT recovery sync', first_line: 'Ship fan curve v2 before DVT.', ref: `meeting:${record}` as const },
  expected: 'Reflect the v2 fan curve',
};

describe('Follow-up answer V7 (ADR-0040)', () => {
  it('serves on its own route and keeps V6 closed to follow-ups', () => {
    expect(PERSON_ANSWER_PATH_V6).toBe('/v6/person/ask');
    expect(validatePersonAnswerResponseV7(response()).citations).toEqual([cited]);
    expect(validatePersonAnswerCitationV7(cited)).toEqual(cited);
    expect(() => validatePersonAnswerResponseV6({ ...response(), schema_version: 6, kind: 'echo-clean-person-answer-v6' })).toThrow();
    // Stored impact cards and open items' live parts validate V6 citations: neither ever names a follow-up.
    expect(() => validatePersonAnswerCitationV6(cited)).toThrow('Ask response citation kind is invalid');
    // The model-free evidence doors stay V4.
    expect(() => validatePersonEvidenceDeskResponseV1({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false,
      items: [{ id: 'desk_follow_up', kind: 'follow_up', citation: followUp, label: 'Follow-up', visibility: 'team', receipt_sha256: record }] })).toThrow();
  });

  it('accepts every V6 citation unchanged', () => {
    const page = { citation: { kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-1', page_id: 'p1', section_id: 's1', version: '3', permalink: 'https://knowledge.example.test/wiki/p1', text_sha256: canonicalSha256('x') }, kind: 'page' as const, label: 'Plan', visibility: 'only_me' as const };
    const both = response([meeting, page]);
    const statements = [{ text: 'The meeting decided it and the plan agrees.', citation_indexes: [0, 1], private: true }];
    const accepted = validatePersonAnswerResponseV7({ ...both, parts: [{ ...both.parts[0]!, statements }] });
    expect(accepted.citations).toEqual([meeting, page]);
  });

  it('requires the follow-up ref on a follow-up and only there', () => {
    const { ref: _ref, ...withoutRef } = cited;
    expect(() => validatePersonAnswerResponseV7(response([withoutRef]))).toThrow('Follow-up citation ref is missing');
    for (const value of [
      { ...cited, ref: `follow_up:itm_${'0'.repeat(8)}` },
      { ...cited, ref: `meeting:${record}` },
      { ...meeting, ref },
      { ...cited, kind: 'action' },
      { ...meeting, kind: 'follow_up' },
    ]) expect(() => validatePersonAnswerResponseV7(response([value]))).toThrow();
    expect(() => validatePersonAnswerResponseV7(response([cited, { ...cited, label: 'Again' }]))).toThrow('duplicate citations');
  });

  it('marks a sentence private exactly when a cited follow-up is', () => {
    const owned = { ...cited, visibility: 'only_me' as const };
    expect(() => validatePersonAnswerResponseV7(response([owned]))).toThrow('private is inconsistent');
    const answer = response([owned]);
    expect(validatePersonAnswerResponseV7({ ...answer, parts: [{ ...answer.parts[0]!, statements: [{ ...answer.parts[0]!.statements[0]!, private: true }] }] }).citations[0]).toEqual(owned);
  });
});

describe('Follow-up citation and ref V1', () => {
  it('names one item with exact keys', () => {
    expect(validatePersonFollowUpCitationV1(followUp)).toEqual(followUp);
    expect(Object.isFrozen(validatePersonFollowUpCitationV1(followUp))).toBe(true);
    for (const value of [{ ...followUp, kind: 'open_item' }, { ...followUp, label: 'THERM-48' }, { ...followUp, item_id: 'run_6b0f8a52' }, { ...followUp, item_id: `itm_${'x'.repeat(61)}` }, { kind: 'follow_up' }, null, 'follow_up']) {
      expect(() => validatePersonFollowUpCitationV1(value)).toThrow();
    }
  });

  it('opens the item page and is not a person-open ref', () => {
    expect(personFollowUpRefV1(followUp)).toBe(ref);
    expect(validatePersonFollowUpRefV1(ref)).toBe(ref);
    for (const value of [`follow_up:${itemId} `, `follow-up:${itemId}`, `follow_up:run_${itemId.slice(4)}`, itemId, 42]) expect(() => validatePersonFollowUpRefV1(value)).toThrow();
    expect(() => validatePersonOpenRefV1(ref)).toThrow();
  });
});

describe('Follow-up evidence V1', () => {
  it('carries title, owner, status, due date, latest check and decision with exact keys', () => {
    expect(validatePersonFollowUpEvidenceV1(evidence)).toEqual(evidence);
    const minimal = { item_id: itemId, kind: 'action' as const, title: 'Follow-up', owner: 'Unknown member', status: 'unsent' as const };
    expect(validatePersonFollowUpEvidenceV1(minimal)).toEqual(minimal);
    const { first_line: _line, ...decision } = evidence.decision;
    expect(validatePersonFollowUpEvidenceV1({ ...evidence, decision }).decision).toEqual(decision);
  });

  it('refuses unknown fields, out-of-range values and a repeated title', () => {
    for (const value of [
      { ...evidence, text: 'raw ticket body' },
      { ...evidence, assignee: 'Mara' },
      { ...evidence, check: { ...evidence.check, checked_by: 'Dana' } },
      { ...evidence, check: { ...evidence.check, verdict: 'closed' } },
      { ...evidence, check: { ...evidence.check, checked_at: '2026-10-15' } },
      { ...evidence, decision: { ...evidence.decision, approval_id: 'apr_1' } },
      { ...evidence, decision: { ...evidence.decision, ref: `document:doc_${'1'.repeat(64)}` } },
      { ...evidence, decision: { ...evidence.decision, ref: 'meeting:sha256:short' } },
      { ...evidence, status: 'in_progress' },
      { ...evidence, kind: 'follow_up' },
      { ...evidence, title: 'x'.repeat(301) },
      { ...evidence, title: 'Two\nlines' },
      { ...evidence, owner: '' },
      { ...evidence, expected: evidence.title },
      { ...evidence, item_id: 'itm_1' },
    ]) expect(() => validatePersonFollowUpEvidenceV1(value)).toThrow();
  });
});
