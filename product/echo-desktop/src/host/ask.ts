// An Ask on the host (ADR-0039): the client commands it runs (the Ask, and
// the reads of what it cites), and the reader of the progress lines the Ask
// prints while it works. Kept apart from host.ts so the whole path, Authority
// to page, is tested as it runs.
import {
  PERSON_ASK_CHECK_REQUEST_KIND_V1, validatePersonAnswerPreviousV1, validatePersonAnswerRequestV3, validatePersonAskCheckRequestV1, validateProjectIdV1,
} from '@echo-brain/organization-api';
import type { AskPrevious, AskProgressNotice, AskScope, AskStep, AskThread, Expect, RecordRead, SourceRef } from '../shared/protocol.js';
import { askText } from '../shared/query.js';
import { jsonLines } from './cli.js';
import { askStepView } from './views.js';

/**
 * The client command for an Ask of `text` (already askText's). Every Ask,
 * global or project, asks `/v7` with its progress; the host pins it to the
 * account the page shows, as every call: a client signed in as another by
 * then asks nothing and prints no step, so the page's account check of each
 * step is the client's own. A follow-up or Ask again carries the earlier turn
 * (`previous`, ADR-0047), already checked by askPrevious, and an Ask the
 * asker's other threads (`threads`, ADR-0056), already checked by askThreads.
 */
export function askArgv(text: string, scope: AskScope, previous?: AskPrevious, threads?: readonly AskThread[]): string[] {
  return ['ask', `--question=${text}`, '--progress',
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : []),
    ...(previous === undefined ? [] : [`--previous=${JSON.stringify(previous)}`]),
    ...(threads === undefined ? [] : [`--threads=${JSON.stringify(threads)}`])];
}

/** Whether the API's own validator takes `value`. */
const checks = (validate: (value: unknown) => unknown, value: unknown): boolean => { try { validate(value); return true; } catch { return false; } };

/**
 * The earlier turn an Ask of `question` (already askText's) in `scope`
 * carries, checked as the client checks it (C3): on its own, by the API's own
 * validator, its earlier question as askText would send it. Null when that
 * refuses it. The question itself is the Authority's to judge, and a project
 * that fails on its own is the client's to report, as it does with or without
 * the earlier turn, so then the turn goes as it came.
 */
export function askPrevious(value: unknown, question: string, scope: AskScope): AskPrevious | null {
  if (scope.kind === 'project' && !checks(validateProjectIdV1, scope.project_id)) return value as AskPrevious;
  try {
    const previous = validatePersonAnswerPreviousV1(value, question);
    return askText(previous.question) === previous.question ? value as AskPrevious : null;
  } catch {
    return null;
  }
}

/**
 * The asker's other threads an Ask of `question` (already askText's) carries
 * beside `previous` (already askPrevious's, or none), checked as the request
 * will carry them (ADR-0056): by the API's own validator, the list with the
 * turn, so an Ask again carries none and the two fit the body together. Null
 * when that refuses them: they are context, so the Ask then goes without them.
 */
export function askThreads(value: unknown, question: string, previous: AskPrevious | undefined): AskThread[] | null {
  const request = { schema_version: 3, question, ...(previous === undefined ? {} : { previous }), threads: value };
  return checks(validatePersonAnswerRequestV3, request) ? value as AskThread[] : null;
}

/**
 * What an Ask of `question` (already askText's) in `scope` carries of what the
 * page sent with it: the earlier turn (askPrevious) and the asker's other
 * threads (askThreads). Both are context, not the question: one the client
 * would refuse is left out, and the Ask goes on. The page lists the threads
 * for a question that continues that turn, with the turn's own thread left
 * out. Without the turn that list would place the question among every thread
 * but the one it was typed in, so a refused turn takes the list with it, and
 * the answer then places the question nowhere. `refused`: what was left out.
 */
export function askContext(earlier: unknown, others: unknown, question: string, scope: AskScope):
  { readonly previous?: AskPrevious; readonly threads?: AskThread[]; readonly refused: readonly ('previous' | 'threads')[] } {
  const previous = earlier === undefined ? undefined : askPrevious(earlier, question, scope);
  const threads = others === undefined || previous === null ? null : askThreads(others, question, previous);
  return {
    ...(previous ? { previous } : {}), ...(threads ? { threads } : {}),
    refused: [...(previous === null ? ['previous' as const] : []), ...(others !== undefined && threads === null ? ['threads' as const] : [])],
  };
}

/** The request a check sends (C1), as the API's own validator takes it, or null when the page's items are not one. */
export function askCheckRequest(items: unknown): string | null {
  const request = { schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items };
  return checks(validatePersonAskCheckRequestV1, request) ? JSON.stringify(request) : null;
}

/** The client command for a check (C1): it validates the request, posts it, and prints the validated response last. */
export function askCheckArgv(request: string): string[] {
  return ['ask-check', `--request=${request}`];
}

/**
 * The client command that reads one approved record as Ask cites it, each item with its atom id: one an answer cites,
 * for the pane to light the cited items, or a meeting the reader opened by its ref. It names the record by its digest.
 */
export function askRecordArgv(record: RecordRead): string[] {
  return ['records', `--record-sha256=${record.record_sha256}`, '--brief'];
}

/**
 * The client command that reads one cited passage of an original, where it
 * was cited: in the project asked, or else under all you may read.
 */
export function askSourceArgv(ref: SourceRef, scope: AskScope): string[] {
  return ['ask-source', `--source-id=${ref.source_id}`, `--revision-id=${ref.revision_id}`, `--source-sha256=${ref.source_sha256}`,
    `--representation-sha256=${ref.representation_sha256}`, `--anchor-sha256=${ref.anchor_sha256}`, ...(ref.document_id ? [`--document-id=${ref.document_id}`] : []),
    ...(scope.kind === 'project' ? [`--project=${scope.project_id}`] : [])];
}

/**
 * A host call's silence: `onSilent` runs once `ms` passes without `alive()`. There is no whole-call deadline; each sign
 * of life (an Ask's printed line) starts the silence again. `stop` ends it when the call settles.
 */
export function silence(ms: number, onSilent: () => void): { alive(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { clearTimeout(timer); timer = setTimeout(onSilent, ms); };
  alive();
  return { alive, stop: () => clearTimeout(timer) };
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
