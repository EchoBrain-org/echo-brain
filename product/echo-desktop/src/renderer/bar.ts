// The ask bar's own words: what it suggests asking while it is empty, and how
// it counts toward a question's limit. Pure, for the bar and its tests.
import type { AskScope } from '../shared/protocol.js';
import { clip } from './format.js';
import type { Suggestion } from './timeline.js';

/**
 * The longest question the Authority takes, in Unicode code points (the API's PERSON_QUESTION_MAX_CODE_POINTS_V1; a plain
 * number so the page's bundle leaves the API out). The bar never cuts text to it: it counts, and says so when over.
 */
export const MAX_QUESTION = 4_000;
/** From this many characters the bar counts them: only when a question is close to the limit. */
export const COUNT_FROM = 3_800;
/** "Try asking" offers at most this many questions. */
export const MAX_SUGGESTIONS = 3;

/**
 * The count at the bar's right end, in code points as the Authority counts: none below COUNT_FROM, "3,812 / 4,000" from
 * it, full at the limit, and over past it, where the question cannot be sent until it is shorter.
 */
export function questionCount(text: string): { words: string; full: boolean; over: number } | null {
  const length = [...text].length;
  if (length < COUNT_FROM) return null;
  return { words: `${length.toLocaleString('en-US')} / ${MAX_QUESTION.toLocaleString('en-US')}`, full: length >= MAX_QUESTION, over: Math.max(0, length - MAX_QUESTION) };
}

/** What the bar says at the limit: the limit, and past it by how much to shorten. */
export function questionLimitNote(count: { readonly over: number }): string {
  const limit = `Questions are up to ${MAX_QUESTION.toLocaleString('en-US')} characters`;
  return count.over === 0 ? limit : `${limit}. Shorten this one by ${count.over.toLocaleString('en-US')}.`;
}

/** A meeting ECHO shows, as a question: "What did we decide in THERM DVT recovery?" */
export function decidedIn(meeting: string): string {
  return `What did we decide in ${clip(meeting.trim(), 120)}?`;
}

/** The question for any week, in the bar's scope: all context, or a project by its name. */
export function weekQuestion(scope: AskScope, project: string | null): string {
  if (scope.kind === 'project') return `What changed in ${clip(project ?? 'this project', 120)} this week?`;
  return 'What did we decide this week?';
}

/**
 * "Try asking", for an empty bar: the questions you asked in its scope, from
 * the timeline (newest first, each reopening its turn: ADR-0047), then one for
 * each meeting ECHO shows there (newest first), then the question for any
 * week. Each once, at most three.
 */
export function suggestedQuestions(recent: readonly Suggestion[], meetings: readonly string[], week: string): Suggestion[] {
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  const asked: Suggestion[] = meetings.filter(meeting => meeting.trim() !== '').map(meeting => ({ question: decidedIn(meeting) }));
  for (const suggestion of [...recent, ...asked, { question: week }]) {
    const text = suggestion.question.replace(/\s+/gu, ' ').trim();
    const key = text.toLowerCase();
    if (text === '' || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion.turn === undefined ? { question: text } : { question: text, turn: suggestion.turn });
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions;
}
