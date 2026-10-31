import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/** Completed results wait this long for their reader, then are dropped unread. */
export const RETAINED_RESULT_TTL_MS_V1 = 15 * 60_000;
/** After a result is first read it stays this long, so a lost response can be read again. */
export const RETAINED_RESULT_REREAD_MS_V1 = 60_000;

/** The closed codes a retained diagnostic capture or research evaluation fails with. */
export type RetainedResultFailureCodeV1 = 'conflict' | 'invalid_request' | 'invalid_output' | 'not_found' | 'stale_access_state'
  | 'unauthorized' | 'rate_limited' | 'quota_exceeded' | 'unavailable' | 'timed_out';
export interface RetainedResultFailureV1 { readonly code: RetainedResultFailureCodeV1; readonly message: string }

/** A deadline is timed_out, an Authority error keeps a code it names, anything else is unavailable; each code has its fixed message. */
export function retainedResultFailureV1(messages: Readonly<Record<RetainedResultFailureCodeV1, string>>, error: unknown): RetainedResultFailureV1 {
  const code = error instanceof AgenticAskDeadlineErrorV1 ? 'timed_out'
    : error instanceof AuthorityOperationError && Object.hasOwn(messages, error.code) ? error.code as RetainedResultFailureCodeV1 : 'unavailable';
  return Object.freeze({ code, message: messages[code] });
}

/**
 * The release edge of a result held in memory (person diagnostics, research
 * evaluation): the operation's own access fence, then the result still held,
 * then the reader's own session. A refused fence drops the result and answers
 * the failure to report, an access it could not check as stale_access_state;
 * a cancelled read rethrows; a result gone or expired meanwhile is not_found;
 * a changed reader is dropped and refused. Undefined means it may be released.
 */
export async function checkRetainedResultReleaseV1(input: {
  readonly fence: (signal?: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal | undefined;
  readonly held: () => boolean;
  readonly drop: () => void;
  readonly reader: () => string;
  readonly owner: string;
  readonly failure: (error: unknown) => RetainedResultFailureV1;
  readonly gone: string;
  readonly refused: string;
}): Promise<RetainedResultFailureV1 | undefined> {
  try { await input.fence(input.signal); }
  catch (error) {
    // Cancelling a read does not invalidate its source-access snapshot.
    // A concrete denial still wins if cancellation happens at the same time.
    const denied = error instanceof AuthorityOperationError && ['unauthorized', 'stale_access_state', 'not_found'].includes(error.code);
    if (!denied && input.signal?.aborted && (error === input.signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw error;
    input.drop();
    const failed = input.failure(error);
    return failed.code === 'unavailable' ? input.failure(new AuthorityOperationError('stale_access_state', 'Access cannot be checked')) : failed;
  }
  // A close or expiry while the access check was in flight must not revive a dropped result.
  if (!input.held()) {
    input.drop();
    throw new AuthorityOperationError('not_found', input.gone);
  }
  input.signal?.throwIfAborted();
  // The fence may have used the operation's own session; the reader's must still hold at the release edge.
  try {
    if (input.reader() !== input.owner) throw new AuthorityOperationError('unauthorized', input.refused);
  } catch (error) { input.drop(); throw error; }
  return undefined;
}
