import type { PersonAnswerResponseV6, PersonAskProgressStepEventV1, PersonAskReceiptV1 } from "@echo-brain/organization-api";

/**
 * Ask progress (ADR-0039): what a live Ask run reports while it works, and
 * what it returns with its answer. Interface only; the run emits through the
 * sink it is given and never through the diagnostics observer, which would
 * replace a person's capture sink and copy full prompts.
 */

/**
 * Receives each step event of one run, in order, synchronously. The run
 * builds every event from what it ran (stages from the lifecycle and the
 * gate's call hooks, searched rows from its content-free read coverage, read
 * names at the gate's `before_call` point, after the access check before that
 * call) and never from model output. It catches and ignores what the sink
 * throws, so a sink can never change research, and it calls the sink no more
 * once the run has settled, cancelled, timed out or failed.
 */
export type AgenticAskProgressSinkV1 = (event: PersonAskProgressStepEventV1) => void;

/** One streamed Ask: today's answer input plus the sink. */
export interface AgenticAskProgressInputV1 {
  readonly question: string;
  readonly signal?: AbortSignal;
  readonly on_progress: AgenticAskProgressSinkV1;
}

/**
 * What a streamed Ask returns once the release step has passed: the same V6
 * response `answer` returns, and the receipt built after the final access
 * check from the run's own record of what it named.
 */
export interface AgenticAskAnswerWithReceiptV1 {
  readonly response: PersonAnswerResponseV6;
  readonly receipt: PersonAskReceiptV1;
}
