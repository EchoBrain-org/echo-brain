import type {
  PersonAnswerResponseV7, PersonAnswerResponseV8, PersonAskProgressStepEventV2, PersonAskProgressStepEventV3, PersonAskReceiptV2, PersonAskReceiptV3,
} from "@echo-brain/organization-api";

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
 * once the run has settled, cancelled, timed out or failed. This is the V7
 * Ask's sink (ADR-0040): progress V2, so a read may name a follow-up. The V6
 * Ask's progress V1 was retired on 2026-10-19.
 */
export type AgenticAskProgressSinkV2 = (event: PersonAskProgressStepEventV2) => void;
/** The V8 Ask's sink (research tool contract v1): progress V3, so a read may name a workspace item or tool container. */
export type AgenticAskProgressSinkV3 = (event: PersonAskProgressStepEventV3) => void;

/**
 * One streamed request across the attempts it runs. The Authority restarts an
 * Ask once when its record snapshot advances, and every attempt sends on the
 * one stream: an item an earlier attempt named is not named again, and the
 * named bound counts the whole request. Each attempt still audits only what it
 * named itself. Only the released attempt's receipt is sent, and its
 * `elapsed_ms` counts from the request's start.
 */
export interface AgenticAskProgressRequestV1 {
  /** Every item an attempt of this request named, by its citation's canonical JSON; a run adds each item it names. */
  readonly named: Set<string>;
  /** Milliseconds since the request started. */
  elapsed(): number;
}

/** One streamed V7 Ask: today's answer input plus the V2 sink. */
export interface AgenticAskProgressInputV2 {
  readonly question: string;
  readonly signal?: AbortSignal;
  readonly on_progress: AgenticAskProgressSinkV2;
  /** The request this run is an attempt of; without it, the run is the whole request. */
  readonly request?: AgenticAskProgressRequestV1;
}
/** One streamed V8 Ask: the V2 input with the V3 sink. */
export interface AgenticAskProgressInputV3 extends Omit<AgenticAskProgressInputV2, "on_progress"> {
  readonly on_progress: AgenticAskProgressSinkV3;
}

/**
 * What a streamed V7 Ask returns once the release step has passed: the same V7
 * response `answer` returns, and its V2 receipt, built after the final access
 * check from the run's own record of what it named.
 */
export interface AgenticAskAnswerWithReceiptV2 {
  readonly response: PersonAnswerResponseV7;
  readonly receipt: PersonAskReceiptV2;
}
/** What a streamed V8 Ask returns: the V8 response `answer` returns, and its V3 receipt. */
export interface AgenticAskAnswerWithReceiptV3 {
  readonly response: PersonAnswerResponseV8;
  readonly receipt: PersonAskReceiptV3;
}
