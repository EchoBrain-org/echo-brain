import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import type {
  StructuredGenerationInput,
  StructuredGenerationJsonSchema,
  StructuredGenerationPort,
  StructuredGenerationUsageV1,
} from "./structured-generation-v1.js";
import { observeCoreRuntimeV1, withoutCoreRuntimeContentV1 } from "../shared/core-runtime-observation-v1.js";
import { AgenticAskOutputErrorV1, cleanLine, repairPrompt } from "./agentic-ask-v1-model-protocol.js";

/**
 * The shared model gate (research trigger contract v1, section 3): every model
 * call a request makes, research or writer, passes through here. Before each
 * call it revalidates the person's access, enforces the request's call and time
 * budget, records the call's fingerprint and usage for the audit, and allows
 * one repair of a malformed reply.
 */

export const AGENTIC_ASK_MIN_STEP_MS_V1 = 4_000;
export const AGENTIC_ASK_MIN_ANSWER_MS_V1 = 3_000;
export const AGENTIC_MODEL_OUTPUT_TOKENS_V1 = Object.freeze({ step: 1_500, answer: 1_500 } as const);

export type AgenticAskModelRoleV1 = "step" | "answer";

export interface AgenticAskGenerationObservationV1 {
  readonly role: AgenticAskModelRoleV1;
  readonly finish_reason: string | null;
  readonly usage: StructuredGenerationUsageV1 | null;
}

/** The hard request deadline elapsed before a release-safe response could finish. */
export class AgenticAskDeadlineErrorV1 extends Error {
  constructor() {
    super("agentic Ask deadline exhausted");
    this.name = "AgenticAskDeadlineErrorV1";
  }
}

/** Recovery stays inside this request: repeat, repair the output, or use released evidence. */
export class AgenticAskGenerationFailureV1 extends AgenticAskOutputErrorV1 {
  constructor(message: string, readonly recovery: "retry" | "repair" | "fallback") { super(message); }
}

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function errorDiagnostic(error: unknown): { readonly failure_class: string | null; readonly http_status: number | null; readonly finish_reason: string | null; readonly usage: StructuredGenerationUsageV1 | null } {
  const outer = object(error); const diagnostic = object(outer?.diagnostic);
  const observation = object(outer?.generation_observation); const usage = object(observation?.usage);
  const valid = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return Object.freeze({
    failure_class: typeof diagnostic?.failure_class === "string" ? diagnostic.failure_class : null,
    http_status: typeof diagnostic?.http_status === "number" && Number.isSafeInteger(diagnostic.http_status) ? diagnostic.http_status : null,
    finish_reason: typeof diagnostic?.finish_reason === "string" ? diagnostic.finish_reason : null,
    usage: usage === null ? null : Object.freeze({ input_tokens: valid(usage.input_tokens), output_tokens: valid(usage.output_tokens), total_tokens: valid(usage.total_tokens), cached_input_tokens: valid(usage.cached_input_tokens), reasoning_tokens: valid(usage.reasoning_tokens) }),
  });
}
function finishFailure(reason: string | null): AgenticAskGenerationFailureV1 {
  if (reason === "content_filter") return new AgenticAskGenerationFailureV1("the provider declined the reply", "fallback");
  if (reason === "error") return new AgenticAskGenerationFailureV1("model was unavailable", "retry");
  return new AgenticAskGenerationFailureV1("the reply did not finish; keep notes and sentences shorter", "repair");
}
function generationFailure(error: unknown): AgenticAskGenerationFailureV1 | null {
  const diagnostic = errorDiagnostic(error);
  if (diagnostic.failure_class === "adapter_json") return new AgenticAskGenerationFailureV1("the reply was not valid JSON", "repair");
  if (diagnostic.failure_class === "adapter_finish") return finishFailure(diagnostic.finish_reason);
  if (diagnostic.failure_class === "adapter_refusal") return new AgenticAskGenerationFailureV1("the provider declined the reply", "fallback");
  if (diagnostic.failure_class === "adapter_response" && diagnostic.http_status !== null && diagnostic.http_status >= 200 && diagnostic.http_status < 300) return new AgenticAskGenerationFailureV1("the reply had no usable content", "repair");
  if (["adapter_timeout", "adapter_transport"].includes(diagnostic.failure_class ?? "")) return new AgenticAskGenerationFailureV1("model was unavailable", "retry");
  if (["adapter_http", "adapter_provider_error"].includes(diagnostic.failure_class ?? "")) {
    const status = diagnostic.http_status;
    const temporary = status === null || (status >= 200 && status < 300) || status === 408 || status === 429 || (status >= 500 && status < 600);
    return new AgenticAskGenerationFailureV1("model was unavailable", temporary ? "retry" : "fallback");
  }
  // Local configuration/contract errors and unknown failures are terminal, not a model reply to repair.
  return null;
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof AgenticAskDeadlineErrorV1 ? signal.reason : new DOMException("Ask cancelled", "AbortError");
}
export function raceAbort<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(abortReason(signal));
    signal.addEventListener("abort", cancelled, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", cancelled); resolve(value); },
      error => { signal.removeEventListener("abort", cancelled); reject(error); },
    );
  });
}
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
export function abort(): never { throw new DOMException("Ask cancelled", "AbortError"); }

/** Content-free span events: entering a call's runtime span, and its model time when it settles. */
export type AgenticModelGateSpanEventV1 =
  | { readonly role: AgenticAskModelRoleV1; readonly phase: "enter" }
  | { readonly role: AgenticAskModelRoleV1; readonly phase: "exit"; readonly elapsed_ms: number };

export interface CreateAgenticModelGateV1Options {
  /** The provider binding; every role uses answer_model. */
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly model: StructuredGenerationPort;
  /** The request's cumulative access check, run before every call. */
  readonly desk_revalidate: (input: { readonly signal: AbortSignal }) => Promise<{ readonly checked_at: string }>;
  /** Receives each pre-call check's time, for the request's audit. */
  readonly on_checked: (checked_at: string) => void;
  readonly budget: { readonly max_model_calls: number };
  readonly now: () => number;
  /** Absolute request deadline on the `now` clock. */
  readonly deadline: number;
  /** The request's active signal (caller cancel, deadline or terminal stop). */
  readonly signal: AbortSignal;
  /** The caller's own cancel signal, if any. */
  readonly input_signal?: AbortSignal;
  readonly is_deadline_expired: () => boolean;
  readonly on_span?: (event: AgenticModelGateSpanEventV1) => void;
  /** True when the prompt may carry live-provider content, which must never reach runtime content capture. */
  readonly content_sensitive: () => boolean;
  /** Runs once per admitted call, after the budget and access checks and before the provider call. */
  readonly before_call?: (role: AgenticAskModelRoleV1) => void;
}

export interface AgenticModelGateStatsV1 {
  readonly calls: number;
  readonly repairs: number;
  /** One content-free observation per admitted call, in call order. */
  readonly generations: readonly AgenticAskGenerationObservationV1[];
  readonly invocation_digests: readonly Sha256Digest[];
  /** A permanent provider failure: no further call should be attempted. */
  readonly stopped: boolean;
}

export interface AgenticModelGateV1 {
  call(role: AgenticAskModelRoleV1, system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, recovery?: boolean): Promise<unknown>;
  withRepair<T>(role: AgenticAskModelRoleV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, parse: (value: unknown) => T, on_rejection?: (reason: string) => void): Promise<T>;
  stats(): AgenticModelGateStatsV1;
}

export function createAgenticModelGateV1(options: CreateAgenticModelGateV1Options): AgenticModelGateV1 {
  const { budget, now, deadline } = options;
  const activeSignal = options.signal;
  let calls = 0; let repairs = 0; let generationStopped = false;
  const generations: AgenticAskGenerationObservationV1[] = [];
  const invocationDigests: Sha256Digest[] = [];
  const remaining = () => deadline - now();
  const assertLive = () => {
    if (options.input_signal?.aborted) abort();
    if (options.is_deadline_expired() || now() >= deadline) throw new AgenticAskDeadlineErrorV1();
    if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
  };
  const call = async (role: AgenticAskModelRoleV1, system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, recovery = false): Promise<unknown> => {
    assertLive();
    if (calls >= budget.max_model_calls) throw new AgenticAskGenerationFailureV1("call budget exhausted", "fallback");
    // Every call is preceded by a cumulative desk revalidation of what it may carry.
    const validated = await raceAbort(activeSignal, options.desk_revalidate({ signal: activeSignal }));
    options.on_checked(validated.checked_at);
    assertLive();
    // Revalidation itself spends request time. Recompute the role budget after the fence,
    // preserving the answer/finalization reserves even for a slow check before a retry.
    const timeoutMs = timeout();
    const minimum = role === "step" ? AGENTIC_ASK_MIN_STEP_MS_V1 : AGENTIC_ASK_MIN_ANSWER_MS_V1;
    if (timeoutMs < minimum) throw new AgenticAskGenerationFailureV1("no time left for generation", "fallback");
    calls += 1;
    if (recovery) repairs += 1;
    const modelInput: StructuredGenerationInput = Object.freeze({ model: options.generation.answer_model, system_prompt, user_prompt: JSON.stringify(user), schema, max_output_tokens: AGENTIC_MODEL_OUTPUT_TOKENS_V1[role], timeout_ms: Math.max(1, Math.floor(Math.min(options.generation.timeout_ms, timeoutMs, remaining()))), signal: activeSignal });
    options.before_call?.(role);
    invocationDigests.push(canonicalSha256({ role, model: modelInput.model, system_prompt: modelInput.system_prompt, user_prompt: modelInput.user_prompt, schema: modelInput.schema, max_output_tokens: modelInput.max_output_tokens, timeout_ms: modelInput.timeout_ms }));
    // Live-provider evidence must never reach runtime content capture.
    const contentSafe = <T>(operation: () => Promise<T>): Promise<T> => {
      // Each call is its own span, so provider model calls carry the step or answer purpose.
      const observed = () => observeCoreRuntimeV1(role === "step" ? "ask_planner" : "ask_answer", () => {
        options.on_span?.({ role, phase: "enter" });
        return operation();
      });
      const started = now();
      const settle = () => { options.on_span?.({ role, phase: "exit", elapsed_ms: Math.max(0, now() - started) }); };
      return (options.content_sensitive() ? withoutCoreRuntimeContentV1(observed) : observed()).then(value => { settle(); return value; }, (error: unknown) => { settle(); throw error; });
    };
    try {
      if (options.model.generate_with_observation !== undefined) {
        const generate = options.model.generate_with_observation.bind(options.model);
        const observed = await raceAbort(activeSignal, contentSafe(() => generate(modelInput)));
        generations.push(Object.freeze({ role, finish_reason: observed.finish_reason, usage: observed.usage }));
        if (observed.finish_reason !== null && observed.finish_reason !== "stop") throw finishFailure(observed.finish_reason);
        return observed.value;
      }
      const value = await raceAbort(activeSignal, contentSafe(() => options.model.generate(modelInput)));
      generations.push(Object.freeze({ role, finish_reason: null, usage: null }));
      return value;
    } catch (error) {
      if (error instanceof AgenticAskGenerationFailureV1) {
        if (error.recovery === "fallback") generationStopped = true;
        throw error;
      }
      // Every admitted call leaves exactly one content-free observation, including aborts.
      const diagnostic = errorDiagnostic(error);
      generations.push(Object.freeze({ role, finish_reason: diagnostic.finish_reason, usage: diagnostic.usage }));
      if (isAbort(error, options.input_signal) || options.is_deadline_expired()) throw error;
      const failure = generationFailure(error);
      // A permanent provider rejection must not be repeated under the writer role either.
      if (failure?.recovery === "fallback") generationStopped = true;
      throw failure ?? error;
    }
  };
  /** At most one extra call: temporary failures retry unchanged; invalid output gets repair guidance. */
  const withRepair = async <T>(role: AgenticAskModelRoleV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, parse: (value: unknown) => T, on_rejection?: (reason: string) => void): Promise<T> => {
    let reason: string | null;
    let rejected: unknown;
    try { rejected = await call(role, system, user, schema, timeout); return parse(rejected); }
    catch (error) {
      if (isAbort(error, options.input_signal) || options.is_deadline_expired() || !(error instanceof AgenticAskOutputErrorV1)) throw error;
      if (error instanceof AgenticAskGenerationFailureV1 && error.recovery === "fallback") throw error;
      reason = error instanceof AgenticAskGenerationFailureV1 && error.recovery === "retry" ? null : error.message;
    }
    if (reason !== null) on_rejection?.(reason);
    const minimum = role === "step" ? AGENTIC_ASK_MIN_STEP_MS_V1 : AGENTIC_ASK_MIN_ANSWER_MS_V1;
    if (timeout() < minimum || calls >= budget.max_model_calls) throw new AgenticAskGenerationFailureV1("no time left to repair", "fallback");
    // A repair observes the rejected proposal and concrete validation
    // failure. These are ephemeral model inputs, never audit content.
    const repairUser = reason === null ? user : {
      ...object(user), validation_error: reason,
      ...(rejected === undefined ? {} : { rejected_response: cleanLine(JSON.stringify(rejected), 4_000) }),
    };
    return parse(await call(role, reason === null ? system : repairPrompt(system, reason), repairUser, schema, timeout, true));
  };
  return Object.freeze({
    call, withRepair,
    stats: (): AgenticModelGateStatsV1 => Object.freeze({
      calls, repairs, generations: Object.freeze([...generations]), invocation_digests: Object.freeze([...invocationDigests]), stopped: generationStopped,
    }),
  });
}
