import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The research-loop evaluation's held-out cases measure the loop on questions
// tuning never sees: tuning sessions do not open cases/holdout.json
// (tools/evals/research-loop/world/README.md). A held-out question or case id
// in any other file hands tuning the case, and beside it its key, so the
// held-out split would measure recall. Held-out questions, ids and keys stay
// in that file; a test that needs them reads them from it and restates none.

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const HOLDOUT = 'tools/evals/research-loop/cases/holdout.json';
interface EvaluationCase { readonly id: string; readonly question?: string }
const held = (JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, HOLDOUT), 'utf8')) as { readonly cases: readonly EvaluationCase[] }).cases;

/** A text's words, lowercased, one space apart and around: a quote wrapped over lines or comment markers reads the same. */
function words(text: string): string {
  return ` ${text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean).join(' ')} `;
}
/** A tracked file's words, or undefined for one that is not text or not on disk. */
function trackedWords(path: string): string | undefined {
  try {
    const bytes = readFileSync(resolve(REPOSITORY_ROOT, path));
    return bytes.includes(0) ? undefined : words(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

describe('research-loop held-out cases stay in their file (ADR-0041)', () => {
  it('reads every held-out case, and the question of each that asks one', () => {
    expect(held.length).toBeGreaterThan(0);
    expect(held.some((entry) => entry.question !== undefined)).toBe(true);
  });

  it('no other tracked file quotes a held-out question or names a held-out case', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
      .split('\0').filter((path) => path.length > 0 && path !== HOLDOUT);
    expect(tracked.length).toBeGreaterThan(100);
    const quoted = held.flatMap((entry) => [entry.id, ...(entry.question === undefined ? [] : [entry.question])]).map(words);
    // Only paths are reported, so a failure prints no held-out case.
    const quoting = tracked.filter((path) => {
      const text = trackedWords(path);
      return text !== undefined && quoted.some((value) => text.includes(value));
    });
    expect(quoting).toEqual([]);
  });
});
