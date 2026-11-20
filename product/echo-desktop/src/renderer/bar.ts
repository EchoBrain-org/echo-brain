// The ask bar's own words: what it suggests asking while it is empty.
// A question has no length of its own: the bar never counts or cuts it. Pure, for the bar and its tests.
import type { AskScope } from '../shared/protocol.js';
import type { Suggestion } from './timeline.js';

/**
 * "Try asking" offers this many questions: the rows that fit above the bar. A layout choice, not a limit on what can be
 * asked: every earlier question stays in the timeline.
 */
export const MAX_SUGGESTIONS = 3;

/** A meeting ECHO shows, as a question, its name whole: "What did we decide in THERM DVT recovery?" */
export function decidedIn(meeting: string): string {
  return `What did we decide in ${meeting.trim()}?`;
}

/** The question for any week, in the bar's scope: all context, or a project by its whole name. */
export function weekQuestion(scope: AskScope, project: string | null): string {
  if (scope.kind === 'project') return `What changed in ${project ?? 'this project'} this week?`;
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
