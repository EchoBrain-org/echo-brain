import { AgenticAskDeadlineErrorV1, AGENTIC_ASK_DEADLINE_MS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { PersonRecordSearchSnapshotChangedV1 } from './person-record-search-route.js';

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
          // Let ordinary caller cancellation finish its existing audit/observation path.
          // The outer deadline also bounds a connector that ignores the supplied signal.
          const stopped = () => reject(deadline.signal.reason);
          deadline.signal.addEventListener('abort', stopped, { once: true });
          try {
            input.run(signal).then(resolve, reject).finally(() => deadline.signal.removeEventListener('abort', stopped));
          } catch (error) { deadline.signal.removeEventListener('abort', stopped); reject(error); }
        });
      }
      catch (error) {
        signal.throwIfAborted();
        if (attempt > 0 || input.capture === true || !(error instanceof PersonRecordSearchSnapshotChangedV1)) throw error;
      }
    }
  } finally { clearTimeout(timer); }
}
