import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { PERSON_SWEEP_RESULT_LIMITS_V1, personSweepResultStatusV1, validatePersonSweepResultV1 } from '../src/person-sweep-result-v1.js';

const ticketCitation = {
  citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10046', permalink: 'https://therm.example.test/browse/THERM-46', text_sha256: canonicalSha256('ticket') },
  kind: 'ticket', label: 'THERM-46: Display precision', visibility: 'only_me',
};
const pageCitation = {
  citation: { kind: 'page', tool_id: 'confluence', external_scope_id: 'cloud-1', page_id: '1441793', section_id: 's1', version: '3', permalink: 'https://therm.example.test/wiki/pages/viewpage.action?pageId=1441793', text_sha256: canonicalSha256('page') },
  kind: 'page', label: 'PRD: Display', visibility: 'only_me',
};

type Result = Record<string, unknown>;
const landed = { finding_index: 0, verdict: 'landed', line: 'THERM-46 now formats two decimals.', citation_indexes: [0] };
const stillOpen = { finding_index: 1, verdict: 'still_open', line: 'The PRD still specifies one decimal.', citation_indexes: [1, 0] };
const unreadable = { finding_index: 2, verdict: 'unreadable', line: 'ECHO could not read this item.', citation_indexes: [] };
const assessed = { findings: [landed, stillOpen, unreadable], status: 'assessed', citations: [ticketCitation, pageCitation] };
/** No usable model reply: the findings it could read have no verdict; the one it could not read is still reported. */
const notAssessed = {
  findings: [
    { finding_index: 0, verdict: null, line: 'Not assessed.', citation_indexes: [] },
    { finding_index: 1, verdict: 'unreadable', line: 'ECHO could not read this item.', citation_indexes: [] },
  ],
  status: 'not_assessed', citations: [],
};
const findingAt = (result: Result, index: number, entry: Result) => ({ ...result, findings: (result.findings as Result[]).map((value, at) => at === index ? { ...value, ...entry } : value) });

const refused = (value: unknown, label: string, findingCount?: number) => {
  expect(() => validatePersonSweepResultV1(value, findingCount), label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};

describe('sweep result', () => {
  it('accepts an assessed result and one the model could not assess, frozen', () => {
    expect(validatePersonSweepResultV1(assessed)).toEqual(assessed);
    expect(validatePersonSweepResultV1(notAssessed)).toEqual(notAssessed);
    const result = validatePersonSweepResultV1(assessed);
    for (const part of [result, result.findings, result.findings[0], result.findings[0]!.citation_indexes, result.citations]) expect(Object.isFrozen(part)).toBe(true);
  });

  it('holds exactly one finding per input finding, in input order, when it is told how many there were', () => {
    expect(validatePersonSweepResultV1(assessed, 3)).toEqual(assessed);
    refused(assessed, 'one fewer than asked', 4);
    refused(assessed, 'one more than asked', 2);
    refused({ ...assessed, findings: [stillOpen, landed, unreadable] }, 'out of order');
    refused(findingAt(assessed, 2, { finding_index: 3 }), 'a gap');
    refused(findingAt(assessed, 0, { finding_index: '0' }), 'an index that is a string');
  });

  it('bounds findings by the sweep\'s twenty and each line as the impact card bounds its lines', () => {
    const { findings, line_chars: line } = PERSON_SWEEP_RESULT_LIMITS_V1;
    expect({ findings, line }).toEqual({ findings: 20, line: 300 });
    const many = (count: number) => ({ status: 'assessed', citations: [ticketCitation], findings: Array.from({ length: count }, (_, at) => ({ finding_index: at, verdict: 'landed', line: 'Landed.', citation_indexes: [0] })) });
    expect(validatePersonSweepResultV1(many(20), 20).findings).toHaveLength(20);
    refused(many(21), 'one finding too many');
    refused({ ...assessed, findings: [], citations: [] }, 'no finding');
    expect(() => validatePersonSweepResultV1(findingAt(assessed, 0, { line: 'l'.repeat(line) }))).not.toThrow();
    for (const [label, text] of [
      ['a line over 300 characters', 'l'.repeat(line + 1)], ['two lines', 'THERM-46 now formats two decimals.\nIt shipped.'], ['an untrimmed line', ' THERM-46 landed.'],
      ['an empty line', ''], ['a line that is not a string', 7], ['a line with a line separator', 'THERM-46 landed.'],
    ] as const) refused(findingAt(assessed, 0, { line: text }), label);
  });

  it('rejects any field not in the shape, and a missing one', () => {
    for (const [label, value] of [
      ['result extra', { ...assessed, suggested_edits: [] }],
      ['result missing', { findings: assessed.findings, status: 'assessed' }],
      ['finding extra', findingAt(assessed, 0, { expected: 'two decimals' })],
      ['finding missing', { ...assessed, findings: [{ finding_index: 0, verdict: 'landed', line: 'Landed.' }], citations: [] }],
      ['citation extra', { ...assessed, citations: [{ ...ticketCitation, text: 'THERM-46 full description' }, pageCitation] }],
      ['not an object', 'assessed'],
    ] as const) refused(value, label);
  });

  it('cites each item once, only by index into its citations, and every citation it lists', () => {
    for (const [label, value] of [
      ['an index out of range', findingAt(assessed, 0, { citation_indexes: [2] })],
      ['a negative index', findingAt(assessed, 0, { citation_indexes: [-1] })],
      ['an index that is not an integer', findingAt(assessed, 0, { citation_indexes: [0.5] })],
      ['an index repeated in one finding', findingAt(assessed, 1, { citation_indexes: [1, 1] })],
      ['a repeated citation', { ...assessed, citations: [ticketCitation, ticketCitation] }],
      ['a citation no finding uses', findingAt(assessed, 1, { citation_indexes: [0] })],
      ['an invalid citation', { ...assessed, citations: [ticketCitation, { ...pageCitation, kind: 'ticket' }] }],
    ] as const) refused(value, label);
  });

  it('has one status for each set of verdicts: not assessed exactly when nothing was judged and something was left unassessed', () => {
    // A finding the model was not shown stays unassessed beside the ones it judged.
    const notShown = findingAt(assessed, 1, { verdict: null, line: 'Not assessed.', citation_indexes: [] });
    expect(validatePersonSweepResultV1({ ...notShown, citations: [ticketCitation] }, 3).findings.map(entry => entry.verdict)).toEqual(['landed', null, 'unreadable']);
    // Every finding unreadable: nothing was left for a model to judge, so the result is assessed.
    const allUnreadable = { findings: [{ ...unreadable, finding_index: 0 }], status: 'assessed', citations: [] };
    expect(validatePersonSweepResultV1(allUnreadable, 1)).toEqual(allUnreadable);
    const verdicts = (...values: (string | null)[]) => values.map(verdict => ({ verdict }));
    expect([verdicts('landed', null), verdicts('unreadable'), verdicts('still_open'), verdicts(null, 'unreadable'), verdicts(null)].map(entries => personSweepResultStatusV1(entries as never)))
      .toEqual(['assessed', 'assessed', 'assessed', 'not_assessed', 'not_assessed']);
    for (const [label, value] of [
      ['an unknown verdict', findingAt(assessed, 0, { verdict: 'drifted' })],
      ['an unknown status', { ...assessed, status: 'done' }],
      ['an assessed result that judged nothing and left a finding unassessed', { ...notAssessed, status: 'assessed' }],
      ['a not-assessed result with nothing left unassessed', { ...allUnreadable, status: 'not_assessed' }],
      ['a not-assessed result with a judgment', { ...notAssessed, findings: [{ finding_index: 0, verdict: 'landed', line: 'Landed.', citation_indexes: [0] }, notAssessed.findings[1]], citations: [ticketCitation] }],
      ['an unassessed finding that cites an item', { ...notAssessed, findings: [{ finding_index: 0, verdict: null, line: 'Not assessed.', citation_indexes: [0] }, notAssessed.findings[1]], citations: [ticketCitation] }],
      ['an unreadable finding that cites an item', { ...assessed, findings: [landed, stillOpen, { ...unreadable, citation_indexes: [0] }] }],
    ] as const) refused(value, label);
  });

  it('cites at least one item for each verdict a model gave', () => {
    for (const verdict of ['landed', 'still_open', 'changed']) {
      refused(findingAt(assessed, 0, { verdict, citation_indexes: [] }), `${verdict} citing nothing`);
      expect(validatePersonSweepResultV1(findingAt(assessed, 0, { verdict })).findings[0]!.verdict).toBe(verdict);
    }
  });
});
