import { describe, expect, it } from 'vitest';
import {
  personFollowUpRefV1, validatePersonFollowUpCitationV1, validatePersonFollowUpEvidenceV1, validatePersonFollowUpRefV1, validatePersonItemRefV1,
} from '../src/index.js';

const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const followUp = { kind: 'follow_up' as const, item_id: itemId };
const ref = `follow_up:${itemId}` as const;
const record = `sha256:${'a'.repeat(64)}` as const;
const decided = {
  item_id: itemId, kind: 'ticket' as const, title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open' as const, due_at: '2026-10-20',
  decision: { title: 'THERM DVT recovery sync', first_line: 'Ship fan curve v2 before DVT.', ref: `meeting:${record}` as const },
  expected: 'Reflect the v2 fan curve',
};
const evidence = {
  item_id: itemId, kind: 'ticket' as const, title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open' as const,
  created_at: '2026-10-08T09:00:00.000Z', sent_at: '2026-10-08T09:05:00.000Z', reassigned_at: '2026-10-09T14:00:00.000Z',
};

describe("Follow-up evidence V1: ECHO's own dates (research tool contract v1)", () => {
  it('carries when the follow-up was created, sent and reassigned, each once it happened', () => {
    expect(validatePersonFollowUpEvidenceV1(evidence)).toEqual(evidence);
    const unsent = { item_id: itemId, kind: 'action' as const, title: 'Follow-up', owner: 'Unknown member', status: 'unsent' as const, created_at: '2026-10-08T09:00:00.000Z' };
    expect(validatePersonFollowUpEvidenceV1(unsent)).toEqual(unsent);
    // Evidence built without dates, as before the contract, still validates.
    const { created_at: _created, sent_at: _sent, reassigned_at: _reassigned, ...undated } = evidence;
    expect(validatePersonFollowUpEvidenceV1(undated)).toEqual(undated);
  });

  it('refuses a date that is not a UTC millisecond timestamp, and dates it does not name', () => {
    for (const value of [
      { ...evidence, created_at: '2026-10-08' },
      { ...evidence, sent_at: 'yesterday' },
      { ...evidence, reassigned_at: null },
      { ...evidence, created_at: 1_728_378_000_000 },
      { ...evidence, state_set_at: '2026-10-10T09:00:00.000Z' },
      { ...evidence, owner_set_at: '2026-10-09T14:00:00.000Z' },
    ]) expect(() => validatePersonFollowUpEvidenceV1(value)).toThrow();
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
    expect(() => validatePersonItemRefV1(ref)).toThrow();
  });
});

describe('Follow-up evidence V1', () => {
  it('carries title, owner, status, due date and decision with exact keys', () => {
    expect(validatePersonFollowUpEvidenceV1(decided)).toEqual(decided);
    const minimal = { item_id: itemId, kind: 'action' as const, title: 'Follow-up', owner: 'Unknown member', status: 'unsent' as const };
    expect(validatePersonFollowUpEvidenceV1(minimal)).toEqual(minimal);
    const { first_line: _line, ...decision } = decided.decision;
    expect(validatePersonFollowUpEvidenceV1({ ...decided, decision }).decision).toEqual(decision);
  });

  it('refuses unknown fields, out-of-range values and a repeated title', () => {
    for (const value of [
      { ...decided, text: 'raw ticket body' },
      { ...decided, assignee: 'Mara' },
      // A sweep's check is no follow-up evidence now (SVC-2).
      { ...decided, check: { verdict: 'still_open', checked_at: '2026-10-15T09:30:00.000Z' } },
      { ...decided, decision: { ...decided.decision, approval_id: 'apr_1' } },
      { ...decided, decision: { ...decided.decision, ref: `document:doc_${'1'.repeat(64)}` } },
      { ...decided, decision: { ...decided.decision, ref: 'meeting:sha256:short' } },
      { ...decided, status: 'in_progress' },
      { ...decided, kind: 'follow_up' },
      { ...decided, title: 'x'.repeat(301) },
      { ...decided, title: 'Two\nlines' },
      { ...decided, owner: '' },
      { ...decided, expected: decided.title },
      { ...decided, item_id: 'itm_1' },
    ]) expect(() => validatePersonFollowUpEvidenceV1(value)).toThrow();
  });
});
