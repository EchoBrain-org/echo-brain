import { canonicalJson } from '@echo-brain/federation-protocol';
import { validatePersonAnswerCitationV6 } from './person-answer-v4.js';
import type { PersonAnswerCitationV6 } from './person-answer-v6.js';
import { PERSON_IMPACT_CARD_LIMITS_V1 } from './person-impact-card-v1.js';
import { asEnumerableRecord as object, assertExactKeys, fail } from './validation.js';

/**
 * A sweep's result (open items and Home v1, section 6): for each open item a
 * sweep rechecked, in the order the sweep was given them, whether the change
 * its decision expected has landed, is still open, changed some other way, or
 * could not be read, with ECHO's one line on what the current item shows. A
 * model judges the items research could read; code lays out the result and
 * its citations. The product stores only the verdicts: the lines serve the
 * evaluation and the staging endpoint.
 */
export type PersonSweepVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';

export interface PersonSweepFindingResultV1 {
  /** The finding's position in the sweep's input. */
  readonly finding_index: number;
  /** null: not assessed (the model gave no usable reply); the item's last check stays as it is. */
  readonly verdict: PersonSweepVerdictV1 | null;
  /** ECHO's one line: what the current item shows against what was expected. For evaluation and the staging endpoint; never stored. */
  readonly line: string;
  readonly citation_indexes: readonly number[];
}

export interface PersonSweepResultV1 {
  /** One per input finding, in input order. */
  readonly findings: readonly PersonSweepFindingResultV1[];
  /** `not_assessed`: no model judged the findings research could read; their verdicts are null. */
  readonly status: 'assessed' | 'not_assessed';
  readonly citations: readonly PersonAnswerCitationV6[];
}

/**
 * Entry counts, and a line's length in characters. A sweep takes at most 20
 * findings (the sweep trigger reads this bound); a line is bounded as the
 * impact card bounds its lines.
 */
export const PERSON_SWEEP_RESULT_LIMITS_V1 = Object.freeze({ findings: 20, finding_citations: 12, line_chars: PERSON_IMPACT_CARD_LIMITS_V1.line_chars });

const VERDICTS: readonly string[] = ['landed', 'still_open', 'changed', 'unreadable'];

/** One trimmed NFC line of 1 to `maximum` characters, as the impact card's lines are. */
function line(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || [...value].length > maximum) fail(`${label} is invalid`);
  return value;
}
function list(value: unknown, label: string, maximum: number, minimum = 0): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} is invalid`);
  return value;
}
function unique(values: readonly unknown[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} repeats an entry`);
}

/**
 * The result in its fixed shape, or a validation error. With `findingCount`,
 * it must hold exactly that many findings: one per finding the sweep was given.
 */
export function validatePersonSweepResultV1(value: unknown, findingCount?: number): PersonSweepResultV1 {
  const limits = PERSON_SWEEP_RESULT_LIMITS_V1;
  const input = object(value, 'Sweep result');
  assertExactKeys(input, ['findings', 'status', 'citations'], 'Sweep result');
  if (input.status !== 'assessed' && input.status !== 'not_assessed') fail('Sweep result status is invalid');
  const assessed = input.status === 'assessed';
  const citations = list(input.citations, 'Sweep result citations', limits.findings * limits.finding_citations).map(validatePersonAnswerCitationV6);
  unique(citations.map(entry => canonicalJson(entry.citation)), 'Sweep result citations');

  const findings = list(input.findings, 'Sweep result findings', limits.findings, 1).map((raw, position) => {
    const entry = object(raw, 'Sweep finding');
    assertExactKeys(entry, ['finding_index', 'verdict', 'line', 'citation_indexes'], 'Sweep finding');
    // One per input finding, in input order.
    if (entry.finding_index !== position) fail('Sweep finding index is out of order');
    if (entry.verdict !== null && !VERDICTS.includes(entry.verdict as string)) fail('Sweep verdict is invalid');
    const indexes = list(entry.citation_indexes, 'Sweep finding citations', limits.finding_citations).map(index => {
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= citations.length) fail('Sweep finding citation index is invalid');
      return index as number;
    });
    unique(indexes, 'Sweep finding citations');
    return Object.freeze({
      finding_index: position, verdict: entry.verdict as PersonSweepVerdictV1 | null,
      line: line(entry.line, 'Sweep finding line', limits.line_chars), citation_indexes: Object.freeze(indexes),
    });
  });
  if (findingCount !== undefined && findings.length !== findingCount) fail('Sweep result does not hold one entry per finding');

  // An assessment judges every finding research could read; a not-assessed result judges none. An unreadable one is reported either way.
  const judged = (entry: PersonSweepFindingResultV1) => entry.verdict !== null && entry.verdict !== 'unreadable';
  if (findings.some(entry => (assessed ? entry.verdict === null : judged(entry)))) fail('Sweep result status is inconsistent');
  // Only a model's verdict cites what shows it, and every citation is one a verdict uses.
  if (findings.some(entry => !judged(entry) && entry.citation_indexes.length > 0)) fail('Sweep result cites an item for a finding no model judged');
  if (new Set(findings.flatMap(entry => entry.citation_indexes)).size !== citations.length) fail('Sweep result cites an item it does not use');

  return Object.freeze({ findings: Object.freeze(findings), status: input.status, citations: Object.freeze(citations) });
}
