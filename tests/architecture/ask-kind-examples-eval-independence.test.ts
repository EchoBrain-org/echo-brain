import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_STEP_PROMPT } from '../../packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1-model-protocol.js';

// Ask's step prompt teaches the need kinds by example (ADR-0041), and the
// research-loop evaluation scores the kinds research declares
// (`expected_kinds`). An example that quotes a case's subject makes that score
// measure recall of the example, not rule 3, so the examples name nothing an
// evaluation question asks about: no name (a capitalized word past a
// sentence's first: a project, key, product or date) and no run of four words.

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
interface EvaluationCase { readonly id: string; readonly trigger: string; readonly question?: string }
const questions = ['development', 'holdout'].flatMap((split) =>
  (JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'tools/evals/research-loop/cases', `${split}.json`), 'utf8')) as { readonly cases: readonly EvaluationCase[] }).cases
    .flatMap((entry) => entry.trigger === 'ask' && entry.question !== undefined ? [{ id: entry.id, question: entry.question }] : []));

/** The capitalized words of a text past each sentence's first, without a possessive: "October", "BUG-412", "DVT". */
function names(text: string): ReadonlySet<string> {
  return new Set(text.split(/(?<=[.?!:])\s+/u)
    .flatMap((sentence) => sentence.split(/[\s,;()"]+/u).filter(Boolean).slice(1))
    .map((word) => word.replace(/(?:'s|[.?!:])+$/u, ''))
    .filter((word) => /^\p{Lu}/u.test(word)));
}
/** A text's runs of four words, ignoring case and punctuation. */
function phrases(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  return new Set(words.slice(3).map((_, index) => words.slice(index, index + 4).join(' ')));
}

/** What teaches the kinds: rule 3's quoted examples, and the example step's questions, needs and notes. */
const lines = ASK_STEP_PROMPT.split('\n');
const rule3 = lines.find((line) => line.startsWith('3. Give each need a kind.'))!;
const example = JSON.parse(lines.at(-1)!) as { readonly parts: readonly { readonly question: string; readonly notes: string; readonly needs: readonly { readonly need: string }[] }[] };
const examples = [
  ...[...rule3.matchAll(/\(([^()]*)\)/gu)].flatMap((group) => [...group[1]!.matchAll(/"([^"]*)"/gu)].map((quoted) => quoted[1]!)),
  ...example.parts.flatMap((part) => [part.question, part.notes, ...part.needs.map((need) => need.need)]),
];

describe('Ask need-kind examples and the research-loop evaluation (ADR-0041)', () => {
  it('quote no name and no run of four words of any evaluation question', () => {
    // It reads the examples of every kind and the evaluation questions of both splits.
    expect([/"which_items": .*"which_say": .*"content": /u.test(rule3), examples.length > 6, questions.length > 20]).toEqual([true, true, true]);
    const exampleNames = new Set(examples.flatMap((text) => [...names(text)]));
    const examplePhrases = new Set(examples.flatMap((text) => [...phrases(text)]));
    const shared = questions.flatMap(({ id, question }) => [
      ...[...names(question)].filter((name) => exampleNames.has(name)),
      ...[...phrases(question)].filter((phrase) => examplePhrases.has(phrase)),
    ].map((overlap) => `${id}: ${overlap}`));
    expect(shared).toEqual([]);
  });
});
