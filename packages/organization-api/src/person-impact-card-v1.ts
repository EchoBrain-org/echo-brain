import { canonicalJson } from '@echo-brain/federation-protocol';
import { validatePersonAnswerCitationV6 } from './person-answer-v4.js';
import type { PersonAnswerCitationV6 } from './person-answer-v6.js';
import { asEnumerableRecord as object, assertExactKeys, fail } from './validation.js';

/**
 * The approved record's impact card (research trigger contract v1, section
 * 5): what the record decided, which items it affects, what research could
 * not confirm and who to tell. A model writes the one-line summaries and each
 * item's relation; code builds the layout, the citations and the people,
 * whose names come only from item details. The card never holds drafted
 * ticket text or suggested edits: ECHO never writes into Jira or Confluence.
 */
export type PersonImpactRelationV1 = 'confirms' | 'conflicts' | 'needs_updating';

export interface PersonImpactDecidedV1 {
  readonly text: string;
  readonly citation_index: number;
}

export interface PersonImpactAffectedV1 {
  readonly citation_index: number;
  /** What the item says now: a one-line summary, or its details when the card is not assessed. */
  readonly says_now: string;
  /** Present exactly when the card is assessed. */
  readonly relation?: PersonImpactRelationV1;
  /**
   * What the record requires of this item, in the record's own terms ("two
   * decimals from DVT"). Present only when the card is assessed and the
   * relation is `conflicts` or `needs_updating`.
   */
  readonly expected?: string;
  /** The item's assignee or owner, from its details. */
  readonly owner?: string;
  readonly date_at_risk?: { readonly date: string; readonly milestone: string };
}

export interface PersonImpactPersonV1 {
  readonly name: string;
  /** Citation indexes of the affected items this person owns, in card order. */
  readonly items: readonly number[];
}

export interface PersonImpactCardV1 {
  readonly decided: readonly PersonImpactDecidedV1[];
  readonly affected: readonly PersonImpactAffectedV1[];
  /** Couldn't confirm: facts research did not find, and coverage notes. */
  readonly unconfirmed: readonly string[];
  /** Owners of affected items, each once. */
  readonly people: readonly PersonImpactPersonV1[];
  /** `not_assessed`: no model wrote it; the affected items are possibly affected, not yet assessed. */
  readonly status: 'assessed' | 'not_assessed';
  readonly citations: readonly PersonAnswerCitationV6[];
}

/** Entry counts, and text lengths in characters. */
export const PERSON_IMPACT_CARD_LIMITS_V1 = Object.freeze({ decided: 12, affected: 20, unconfirmed: 20, line_chars: 300, name_chars: 200, milestone_chars: 120, expected_chars: 120 });

const RELATIONS: readonly string[] = ['confirms', 'conflicts', 'needs_updating'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One trimmed NFC line of 1 to `maximum` characters. */
function line(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || [...value].length > maximum) fail(`${label} is invalid`);
  return value;
}
function list(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid`);
  return value;
}
/** A calendar date written YYYY-MM-DD. */
export function isPersonImpactCardDateV1(value: unknown): value is string {
  const time = typeof value === 'string' && DATE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function unique(values: readonly unknown[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} repeats an entry`);
}

export function validatePersonImpactCardV1(value: unknown): PersonImpactCardV1 {
  const limits = PERSON_IMPACT_CARD_LIMITS_V1;
  const input = object(value, 'Impact card');
  assertExactKeys(input, ['decided', 'affected', 'unconfirmed', 'people', 'status', 'citations'], 'Impact card');
  if (input.status !== 'assessed' && input.status !== 'not_assessed') fail('Impact card status is invalid');
  const assessed = input.status === 'assessed';
  const citations = list(input.citations, 'Impact card citations', limits.decided + limits.affected).map(validatePersonAnswerCitationV6);
  unique(citations.map(entry => canonicalJson(entry.citation)), 'Impact card citations');
  const index = (raw: unknown, label: string): number => {
    if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) >= citations.length) fail(`${label} is invalid`);
    return raw as number;
  };

  const decided = list(input.decided, 'Impact card decided', limits.decided).map(raw => {
    const entry = object(raw, 'Impact card decision');
    assertExactKeys(entry, ['text', 'citation_index'], 'Impact card decision');
    return Object.freeze({ text: line(entry.text, 'Impact card decision text', limits.line_chars), citation_index: index(entry.citation_index, 'Impact card decision citation_index') });
  });
  const affected = list(input.affected, 'Impact card affected', limits.affected).map(raw => {
    const entry = object(raw, 'Impact card affected item');
    assertExactKeys(entry, ['citation_index', 'says_now', ...['relation', 'expected', 'owner', 'date_at_risk'].filter(key => Object.hasOwn(entry, key))], 'Impact card affected item');
    if (Object.hasOwn(entry, 'relation') && !RELATIONS.includes(entry.relation as string)) fail('Impact card relation is invalid');
    let dateAtRisk: PersonImpactAffectedV1['date_at_risk'];
    if (Object.hasOwn(entry, 'date_at_risk')) {
      const risk = object(entry.date_at_risk, 'Impact card date at risk');
      assertExactKeys(risk, ['date', 'milestone'], 'Impact card date at risk');
      if (!isPersonImpactCardDateV1(risk.date)) fail('Impact card date at risk is invalid');
      dateAtRisk = Object.freeze({ date: risk.date, milestone: line(risk.milestone, 'Impact card milestone', limits.milestone_chars) });
    }
    return Object.freeze({
      citation_index: index(entry.citation_index, 'Impact card affected citation_index'), says_now: line(entry.says_now, 'Impact card says_now', limits.line_chars),
      ...(Object.hasOwn(entry, 'relation') ? { relation: entry.relation as PersonImpactRelationV1 } : {}),
      ...(Object.hasOwn(entry, 'expected') ? { expected: line(entry.expected, 'Impact card expected', limits.expected_chars) } : {}),
      ...(Object.hasOwn(entry, 'owner') ? { owner: line(entry.owner, 'Impact card owner', limits.name_chars) } : {}),
      ...(dateAtRisk === undefined ? {} : { date_at_risk: dateAtRisk }),
    });
  });
  const unconfirmed = list(input.unconfirmed, 'Impact card unconfirmed', limits.unconfirmed).map(raw => line(raw, 'Impact card unconfirmed note', limits.line_chars));
  unique(unconfirmed, 'Impact card unconfirmed');
  const people = list(input.people, 'Impact card people', limits.affected).map(raw => {
    const entry = object(raw, 'Impact card person');
    assertExactKeys(entry, ['name', 'items'], 'Impact card person');
    return Object.freeze({ name: line(entry.name, 'Impact card person name', limits.name_chars), items: Object.freeze(list(entry.items, 'Impact card person items', limits.affected).map(item => index(item, 'Impact card person item'))) });
  });

  // Only a model's assessment carries relations, dates and decisions.
  if (affected.some(entry => (entry.relation !== undefined) !== assessed) || (!assessed && (decided.length > 0 || affected.some(entry => entry.date_at_risk !== undefined)))) fail('Impact card status is inconsistent');
  // What the record requires is said only of an item it conflicts with or changes.
  if (affected.some(entry => entry.expected !== undefined && entry.relation !== 'conflicts' && entry.relation !== 'needs_updating')) fail('Impact card expected is only for an item that conflicts or needs updating');
  const affectedIndexes = affected.map(entry => entry.citation_index);
  unique(affectedIndexes, 'Impact card affected');
  if (affectedIndexes.some(at => decided.some(entry => entry.citation_index === at))) fail('Impact card lists a decided item as affected');
  if (new Set([...decided.map(entry => entry.citation_index), ...affectedIndexes]).size !== citations.length) fail('Impact card cites an item it does not use');
  // People are exactly the affected items' owners, each once, with their items in card order.
  const owners = new Map<string, number[]>();
  for (const entry of affected) if (entry.owner !== undefined) owners.set(entry.owner, [...(owners.get(entry.owner) ?? []), entry.citation_index]);
  unique(people.map(person => person.name), 'Impact card people');
  if (people.length !== owners.size || people.some(person => JSON.stringify(person.items) !== JSON.stringify(owners.get(person.name)))) fail('Impact card people do not match the affected items\' owners');

  return Object.freeze({
    decided: Object.freeze(decided), affected: Object.freeze(affected), unconfirmed: Object.freeze(unconfirmed), people: Object.freeze(people),
    status: input.status, citations: Object.freeze(citations),
  });
}
