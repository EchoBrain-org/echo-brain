// An Ask on the host (ADR-0039): the client command it runs, and the reader
// of the progress lines that command prints while the Ask works. Kept apart
// from host.ts so the whole path, Authority to page, is tested as it runs.
import type { AskProgressNotice, AskScope, AskStep, Expect } from '../shared/protocol.js';
import { jsonLines } from './cli.js';
import { askStepView } from './views.js';

/**
 * Whether an Ask in `scope` streams its progress: a live one does. Mine reads
 * only retained context and must also work on older Authorities, so it never
 * streams.
 */
export function askStreams(scope: AskScope): boolean {
  return scope.kind !== 'mine';
}

/**
 * The client command for an Ask of `text` (already askText's). A live Ask
 * asks for its progress; an Authority that predates it answers as before,
 * with none.
 */
export function askArgv(text: string, scope: AskScope): string[] {
  return ['ask', `--question=${text}`, ...(askStreams(scope) ? ['--live', '--progress'] : []),
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : scope.kind === 'mine' ? ['--mine'] : [])];
}

/**
 * An Ask's progress lines: each step the page shows while the Ask runs,
 * posted tagged with the account it runs for and the page's own cancel id,
 * so the page drops a step of any other Ask or account. A line that is not a
 * valid step (`refused` hears of it), and any line once the Ask was cancelled
 * or timed out, goes nowhere.
 */
export function askProgressLines(cancelId: string, expect: Expect, abortSignal: AbortSignal, post: (notice: AskProgressNotice) => void,
  refused: () => void = () => undefined): (line: string) => void {
  const account = { authority: expect.authority, membership_id: expect.membership_id };
  return line => {
    if (abortSignal.aborted) return;
    for (const value of jsonLines(line)) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'progress')) continue;
      let step: AskStep;
      try {
        step = askStepView(value);
      } catch {
        refused();
        continue;
      }
      post({ cancel_id: cancelId, expect: account, step });
    }
  };
}
