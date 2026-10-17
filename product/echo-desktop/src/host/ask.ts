// An Ask on the host (ADR-0039): the client commands it runs (the Ask, and
// the reads of what it cites), and the reader of the progress lines the Ask
// prints while it works. Kept apart from host.ts so the whole path, Authority
// to page, is tested as it runs.
import type { AskProgressNotice, AskScope, AskStep, Expect, RecordRef, SourceRef } from '../shared/protocol.js';
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
 * The client command for an Ask of `text` (already askText's), for the
 * account the page shows. A live Ask asks for its progress, pinned to that
 * account: a client signed in as another by then asks nothing and prints no
 * step, so the page's account check of each step is the client's own. An
 * Authority that predates progress answers as before, with none.
 */
export function askArgv(text: string, scope: AskScope, expect: Expect): string[] {
  return ['ask', `--question=${text}`,
    ...(askStreams(scope) ? ['--live', '--progress', `--expected-membership-id=${expect.membership_id}`, `--expected-authority=${expect.authority}`] : []),
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : scope.kind === 'mine' ? ['--mine'] : [])];
}

/** The client command that reads a cited meeting's approved record, for the pane to light the cited items. */
export function askRecordArgv(record: RecordRef): string[] {
  return ['records', `--record-sha256=${record.record_sha256}`];
}

/**
 * The client command that reads one cited passage of an original, where it
 * was cited: in the project asked, or else under all you may read. What you
 * added is a part of that, so a mine answer's sources read there.
 */
export function askSourceArgv(ref: SourceRef, scope: AskScope): string[] {
  return ['ask-source', `--source-id=${ref.source_id}`, `--revision-id=${ref.revision_id}`, `--source-sha256=${ref.source_sha256}`,
    `--representation-sha256=${ref.representation_sha256}`, `--anchor-sha256=${ref.anchor_sha256}`, ...(ref.document_id ? [`--document-id=${ref.document_id}`] : []),
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : [])];
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
