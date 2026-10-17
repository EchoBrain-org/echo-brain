import { AgenticAskDeadlineErrorV1, AGENTIC_ASK_DEADLINE_MS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { PersonRecordSearchSnapshotChangedV1 } from './person-record-search-route.js';

/** Allow the cooperative runner to finish its terminal audit; stalled cleanup stays bounded. */
export const PERSON_ASK_TERMINAL_GRACE_MS_V1 = 1_000;

/** Restart once with a completely new desk, evidence and model state, within the original deadline. */
export async function withPersonAskSnapshotRetryV1<T>(input: {
  readonly signal?: AbortSignal;
  /** Diagnostic captures retain one attempt and its fence; never mix two attempts in a capture. */
  readonly capture?: boolean;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new AgenticAskDeadlineErrorV1()), AGENTIC_ASK_DEADLINE_MS_V1);
  timer.unref?.();
  const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await new Promise<T>((resolve, reject) => {
          let fallback: ReturnType<typeof setTimeout> | undefined;
          // Abort work at the shared deadline, then let its terminal witness finish.
          // Only a runner that does not settle during cleanup is rejected by this timer.
          const stopped = () => {
            fallback = setTimeout(() => reject(deadline.signal.reason), PERSON_ASK_TERMINAL_GRACE_MS_V1);
            fallback.unref?.();
          };
          const cleanup = () => { clearTimeout(fallback); deadline.signal.removeEventListener('abort', stopped); };
          deadline.signal.addEventListener('abort', stopped, { once: true });
          try {
            input.run(signal).then(value => { signal.throwIfAborted(); return value; }).then(resolve, reject).finally(cleanup);
          } catch (error) { cleanup(); reject(error); }
        });
      }
      catch (error) {
        signal.throwIfAborted();
        if (attempt > 0 || input.capture === true || !(error instanceof PersonRecordSearchSnapshotChangedV1)) throw error;
      }
    }
  } finally { clearTimeout(timer); }
}
