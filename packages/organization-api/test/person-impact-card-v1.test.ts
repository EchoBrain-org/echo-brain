import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { PERSON_IMPACT_CARD_LIMITS_V1, validatePersonImpactCardV1 } from '../src/person-impact-card-v1.js';

const recordCitation = {
  citation: { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' },
  kind: 'decision', label: 'Gate review: display precision', visibility: 'team',
};
const ticketCitation = {
  citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10046', permalink: 'https://therm.example.test/browse/THERM-46', text_sha256: canonicalSha256('ticket') },
  kind: 'ticket', label: 'THERM-46: Display precision', visibility: 'only_me',
};
const pageCitation = {
  citation: { kind: 'page', tool_id: 'confluence', external_scope_id: 'cloud-1', page_id: '1441793', section_id: 's1', version: '3', permalink: 'https://therm.example.test/wiki/pages/viewpage.action?pageId=1441793', text_sha256: canonicalSha256('page') },
  kind: 'page', label: 'PRD: Display', visibility: 'only_me',
};

type Card = Record<string, unknown>;
const ticket: Card = { citation_index: 1, says_now: 'THERM-46 formats one decimal and is due before the DVT gate.', relation: 'conflicts', owner: 'Mara Quinn', date_at_risk: { date: '2026-10-15', milestone: 'DVT gate' } };
const page: Card = { citation_index: 2, says_now: 'The PRD specifies one decimal.', relation: 'needs_updating' };
const assessed = {
  decided: [{ text: 'Show two decimals on the display.', citation_index: 0 }],
  affected: [ticket, page],
  unconfirmed: ['owner of the PRD display section', 'The tickets list was cut short after 25 items.'],
  people: [{ name: 'Mara Quinn', items: [1] }],
  status: 'assessed',
  citations: [recordCitation, ticketCitation, pageCitation],
};
const notAssessed = {
  decided: [],
  affected: [
    { citation_index: 0, says_now: 'THERM-46: Display precision; status In Progress; due 2026-10-15', owner: 'Mara Quinn' },
    { citation_index: 1, says_now: 'PRD: Display' },
  ],
  unconfirmed: [],
  people: [{ name: 'Mara Quinn', items: [0] }],
  status: 'not_assessed',
  citations: [ticketCitation, pageCitation],
};

const refused = (value: Card, label: string) => {
  expect(() => validatePersonImpactCardV1(value), label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};
const affectedWith = (card: Card, index: number, entry: Record<string, unknown>) => ({ ...card, affected: (card.affected as Card[]).map((value, at) => at === index ? entry : value) });
/** Each card with its first affected row changed. */
const assessedCard = (row: Card) => affectedWith(assessed, 0, { ...ticket, ...row });
const notAssessedCard = (row: Card) => affectedWith(notAssessed, 0, { ...(notAssessed.affected[0] as Card), ...row });

describe('impact card', () => {
  it('accepts an assessed card and a card whose items are not yet assessed', () => {
    expect(validatePersonImpactCardV1(assessed)).toEqual(assessed);
    expect(validatePersonImpactCardV1(notAssessed)).toEqual(notAssessed);
    expect(Object.isFrozen(validatePersonImpactCardV1(assessed))).toBe(true);
  });

  it('rejects any field not in the shape, and a missing one', () => {
    for (const [label, value] of [
      ['card extra', { ...assessed, suggested_edits: [] }],
      ['card missing', { ...assessed, people: undefined }],
      ['decided extra', { ...assessed, decided: [{ ...assessed.decided[0], draft: 'Change THERM-46 in Jira.' }] }],
      ['affected extra', affectedWith(assessed, 1, { ...page, edit: 'Change the PRD to two decimals.' })],
      ['date extra', affectedWith(assessed, 0, { ...ticket, date_at_risk: { date: '2026-10-15', milestone: 'DVT gate', new_date: '2026-10-20' } })],
      ['person extra', { ...assessed, people: [{ name: 'Mara Quinn', items: [1], email: 'mara@example.test' }] }],
      ['citation extra', { ...assessed, citations: [recordCitation, { ...ticketCitation, private: true }, pageCitation] }],
    ] as const) refused(value as Card, label);
    refused(Object.fromEntries(Object.entries(assessed).filter(([key]) => key !== 'people')), 'people left out');
  });

  it('rejects any text field over its limit, and text that is not one trimmed line', () => {
    const { line_chars: line, name_chars: name, milestone_chars: milestone, expected_chars: expected } = PERSON_IMPACT_CARD_LIMITS_V1;
    expect({ line, name, milestone, expected }).toEqual({ line: 300, name: 200, milestone: 120, expected: 120 });
    // At the limit is accepted; one over is refused.
    expect(() => validatePersonImpactCardV1({ ...assessed, decided: [{ text: 'd'.repeat(line), citation_index: 0 }] })).not.toThrow();
    for (const [label, value] of [
      ['decided text', { ...assessed, decided: [{ text: 'd'.repeat(line + 1), citation_index: 0 }] }],
      ['says_now', affectedWith(assessed, 0, { ...ticket, says_now: 's'.repeat(line + 1) })],
      ['owner', { ...affectedWith(assessed, 0, { ...ticket, owner: 'o'.repeat(name + 1) }), people: [{ name: 'o'.repeat(name + 1), items: [1] }] }],
      ['milestone', affectedWith(assessed, 0, { ...ticket, date_at_risk: { date: '2026-10-15', milestone: 'm'.repeat(milestone + 1) } })],
      ['expected', assessedCard({ expected: 'e'.repeat(expected + 1) })],
      ['unconfirmed', { ...assessed, unconfirmed: ['u'.repeat(line + 1)] }],
      ['two lines', { ...assessed, decided: [{ text: 'Show two decimals.\nAlso ship.', citation_index: 0 }] }],
      ['untrimmed', affectedWith(assessed, 0, { ...ticket, says_now: ' padded' })],
      ['empty', { ...assessed, unconfirmed: [''] }],
    ] as const) refused(value as Card, label);
  });

  it('rejects inconsistent cards', () => {
    const limits = PERSON_IMPACT_CARD_LIMITS_V1;
    for (const [label, value] of [
      ['relation', affectedWith(assessed, 1, { ...page, relation: 'change_in_jira' })],
      ['status', { ...assessed, status: 'done' }],
      ['date', affectedWith(assessed, 0, { ...ticket, date_at_risk: { date: 'Oct 15', milestone: 'DVT gate' } })],
      ['impossible date', affectedWith(assessed, 0, { ...ticket, date_at_risk: { date: '2026-02-30', milestone: 'DVT gate' } })],
      ['no such month', affectedWith(assessed, 0, { ...ticket, date_at_risk: { date: '2026-13-01', milestone: 'DVT gate' } })],
      ['index out of range', { ...assessed, decided: [{ text: 'Show two decimals.', citation_index: 3 }] }],
      ['index not an integer', { ...assessed, decided: [{ text: 'Show two decimals.', citation_index: 0.5 }] }],
      ['item affected twice', affectedWith(assessed, 1, { ...page, citation_index: 1 })],
      ['decided item also affected', affectedWith(assessed, 1, { ...page, citation_index: 0 })],
      ['unused citation', { ...assessed, affected: [ticket] }],
      ['duplicate citation', { ...assessed, citations: [recordCitation, ticketCitation, ticketCitation] }],
      ['owner nobody is told', { ...assessed, people: [] }],
      ['person who owns nothing', { ...assessed, people: [{ name: 'Mara Quinn', items: [1] }, { name: 'Tobias Lund', items: [2] }] }],
      ['person repeated', { ...affectedWith(assessed, 1, { ...page, owner: 'Mara Quinn' }), people: [{ name: 'Mara Quinn', items: [1] }, { name: 'Mara Quinn', items: [2] }] }],
      ['wrong items', { ...assessed, people: [{ name: 'Mara Quinn', items: [2] }] }],
      ['assessed without a relation', affectedWith(assessed, 1, { citation_index: 2, says_now: 'The PRD specifies one decimal.' })],
      ['not assessed with a relation', affectedWith(notAssessed, 1, { citation_index: 1, says_now: 'PRD: Display', relation: 'confirms' })],
      ['not assessed with a date', affectedWith(notAssessed, 1, { citation_index: 1, says_now: 'PRD: Display', date_at_risk: { date: '2026-10-15', milestone: 'DVT gate' } })],
      ['not assessed with decisions', { ...notAssessed, decided: [{ text: 'Show two decimals.', citation_index: 1 }] }],
      ['too many decisions', { ...assessed, decided: Array.from({ length: limits.decided + 1 }, (_, index) => ({ text: `Decision ${index}.`, citation_index: 0 })) }],
      ['too many notes', { ...assessed, unconfirmed: Array.from({ length: limits.unconfirmed + 1 }, (_, index) => `Note ${index}.`) }],
      ['repeated note', { ...assessed, unconfirmed: ['Note.', 'Note.'] }],
    ] as const) refused(value as Card, label);
  });

  it('allows expected only on assessed conflicts and needs-updating rows', () => {
    expect(() => validatePersonImpactCardV1(assessedCard({ relation: 'confirms', expected: 'x' }))).toThrow();
    expect(() => validatePersonImpactCardV1(notAssessedCard({ expected: 'x' }))).toThrow();
    expect(validatePersonImpactCardV1(assessedCard({ relation: 'conflicts', expected: 'two decimals' })).affected[0]!.expected).toBe('two decimals');
  });
});
