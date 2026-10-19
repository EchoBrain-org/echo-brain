import { describe, expect, it } from 'vitest';
import { validatePersonFollowUpEvidenceV1 } from '../src/index.js';

const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const evidence = {
  item_id: itemId, kind: 'ticket' as const, title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open' as const,
  created_at: '2026-10-08T09:00:00.000Z', sent_at: '2026-10-08T09:05:00.000Z', reassigned_at: '2026-10-09T14:00:00.000Z',
  check: { verdict: 'still_open' as const, checked_at: '2026-10-15T09:30:00.000Z' },
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
