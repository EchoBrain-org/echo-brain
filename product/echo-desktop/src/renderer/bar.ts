// The ask bar's own words: what it suggests asking while it is empty, and how
// it counts toward a question's limit. Pure, for the bar and its tests.
import type { AskScope } from '../shared/protocol.js';
import { clip } from './format.js';
import type { Suggestion } from './timeline.js';

/** The longest question the bar takes, as its field counts: the API's 240. */
export const MAX_QUESTION = 240;
/** From this many characters the bar counts them. */
export const COUNT_FROM = 200;
/** "Try asking" offers at most this many questions. */
export const MAX_SUGGESTIONS = 3;

/** The count at the bar's right end: none below COUNT_FROM, "212 / 240" from it, and full at the limit, where the bar says why it stops. */
export function questionCount(text: string): { words: string; full: boolean } | null {
  const length = text.length;
  if (length < COUNT_FROM) return null;
  return { words: `${Math.min(length, MAX_QUESTION)} / ${MAX_QUESTION}`, full: length >= MAX_QUESTION };
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
