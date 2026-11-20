import { EvidenceDeskSnapshotChangedV1 } from "../shared/evidence-desk-v1.js";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import {
  STRUCTURED_GENERATION_FAILURE_CLASSES_V1,
  type StructuredGenerationFailureClassV1,
  type StructuredGenerationInput,
  type StructuredGenerationJsonSchema,
  type StructuredGenerationPort,
  type StructuredGenerationUsageV1,
  type StructuredGenerationRequestV1,
} from "./structured-generation-v1.js";
import { observeCoreModelCorrectionV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, type CoreRuntimeModelCorrectionV1, type CoreRuntimePhaseV1 } from "../shared/core-runtime-observation-v1.js";
import { AgenticAskOutputErrorV1, repairInput } from "./agentic-ask-v1-model-protocol.js";
import { coreRuntimeDiagnosticErrorKindV1, coreRuntimeModelRoutingV1 } from '../shared/core-runtime-diagnostics-v1.js';
import { observeAgenticLifecycleV1 } from './agentic-diagnostics-v1.js';
import { AuthorityOperationError } from '../domain/errors.js';

/**
 * The shared model gate (research trigger contract v1, section 3): every model
 * call a request makes, research or writer, passes through here. Before each
 * call it revalidates the person's access, records the call's fingerprint and
 * usage for the audit, and allows one repair of a malformed reply. It counts no
 * calls and keeps no clock: a call fails only when it stays silent past its
 * silence period (the generation profile's `timeout_ms`).
 */

export type AgenticAskModelRoleV1 = "step" | "answer";

/**
 * One model call as its caller names it: the role the audit records (research
 * steps are `step`, every renderer call is `answer`) and the runtime span the
 * call runs in (Ask uses `ask_planner` and `ask_answer`). Every call may write
 * up to the model's own maximum output (the generation profile's).
 */
export interface AgenticModelCallV1 {
  readonly role: AgenticAskModelRoleV1;
  readonly span: CoreRuntimePhaseV1;
}

export interface AgenticAskGenerationObservationV1 {
  /** External harness calls name their actual route; legacy writer observations remain unchanged. */
  readonly engine?: 'external_research' | 'external_writer';
  readonly model?: string;
  readonly role: AgenticAskModelRoleV1;
  readonly finish_reason: string | null;
  readonly usage: StructuredGenerationUsageV1 | null;
}

/**
 * Something the request waits on sent nothing for its silence period: an evidence read or an access check. The run
 * stops with this reason. A run that keeps making progress is never stopped by a clock.
 */
export class AgenticAskStalledErrorV1 extends Error {
  constructor(readonly stalled: "read" | "check", readonly silence_ms: number) {
    super(`${stalled === "read" ? "an evidence read" : "an access check"} sent nothing for ${Math.round(silence_ms / 1000)} s`);
    this.name = "AgenticAskStalledErrorV1";
  }
}

/** What a retry or repair corrects, as observeCoreModelCorrectionV1 counts it. */
type RecoveryCorrection = Extract<CoreRuntimeModelCorrectionV1, "model_retry" | "model_repair_json" | "model_repair_unfinished" | "model_repair_empty">;

/** Recovery stays inside this request: repeat, repair the output, or use released evidence. */
export class AgenticAskGenerationFailureV1 extends AgenticAskOutputErrorV1 {
  /** `silent`: the call sent nothing for its silence period (the adapter's timeout). */
  constructor(message: string, readonly recovery: "retry" | "repair" | "fallback", readonly correction?: RecoveryCorrection, readonly silent = false) { super(message); }
}

/** A model call sent nothing for its silence period, and its one retry did the same; the writer answers from what was released. */
export class AgenticModelStalledErrorV1 extends AgenticAskGenerationFailureV1 {
  constructor(silenceMs: number) { super(`the model sent nothing for ${Math.round(silenceMs / 1000)} s`, "fallback"); this.name = "AgenticModelStalledErrorV1"; }
}

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Reads the port's StructuredGenerationFailureV1 off a thrown error; anything else has no failure class. */
function errorDiagnostic(error: unknown): { readonly failure_class: StructuredGenerationFailureClassV1 | null; readonly http_status: number | null; readonly finish_reason: string | null; readonly usage: StructuredGenerationUsageV1 | null } {
  const outer = object(error); const diagnostic = object(outer?.diagnostic);
  const observation = object(outer?.generation_observation); const usage = object(observation?.usage);
  const valid = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const failureClass = STRUCTURED_GENERATION_FAILURE_CLASSES_V1.find(known => known === diagnostic?.failure_class);
  return Object.freeze({
    failure_class: failureClass ?? null,
    http_status: typeof diagnostic?.http_status === "number" && Number.isSafeInteger(diagnostic.http_status) ? diagnostic.http_status : null,
    finish_reason: typeof diagnostic?.finish_reason === "string" ? diagnostic.finish_reason : null,
    usage: usage === null ? null : Object.freeze({ input_tokens: valid(usage.input_tokens), output_tokens: valid(usage.output_tokens), total_tokens: valid(usage.total_tokens), cached_input_tokens: valid(usage.cached_input_tokens), reasoning_tokens: valid(usage.reasoning_tokens) }),
  });
}
function finishFailure(reason: string | null): AgenticAskGenerationFailureV1 {
  if (reason === "content_filter") return new AgenticAskGenerationFailureV1("the provider declined the reply", "fallback");
  if (reason === "error") return new AgenticAskGenerationFailureV1("model was unavailable", "retry", "model_retry");
  return new AgenticAskGenerationFailureV1("the reply did not finish; keep notes and sentences shorter", "repair", "model_repair_unfinished");
}
/** Exhaustive over the port's failure classes: a new class does not compile until it is handled here. */
function generationFailure(error: unknown): AgenticAskGenerationFailureV1 | null {
  const diagnostic = errorDiagnostic(error);
  const status = diagnostic.http_status;
  switch (diagnostic.failure_class) {
    case "adapter_json": return new AgenticAskGenerationFailureV1("the reply was not valid JSON", "repair", "model_repair_json");
    case "adapter_finish": return finishFailure(diagnostic.finish_reason);
    case "adapter_refusal": return new AgenticAskGenerationFailureV1("the provider declined the reply", "fallback");
    case "adapter_response":
      return status !== null && status >= 200 && status < 300 ? new AgenticAskGenerationFailureV1("the reply had no usable content", "repair", "model_repair_empty") : null;
    case "adapter_timeout": return new AgenticAskGenerationFailureV1("model sent nothing for its silence period", "retry", "model_retry", true);
    case "adapter_transport": return new AgenticAskGenerationFailureV1("model was unavailable", "retry", "model_retry");
    case "adapter_http": case "adapter_provider_error": {
      const temporary = status === null || (status >= 200 && status < 300) || status === 408 || status === 429 || (status >= 500 && status < 600);
      return temporary ? new AgenticAskGenerationFailureV1("model was unavailable", "retry", "model_retry") : new AgenticAskGenerationFailureV1("model was unavailable", "fallback");
    }
    // Local configuration/contract errors and unknown failures are terminal, not a model reply to repair.
    case null: return null;
  }
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof AgenticAskStalledErrorV1 ? signal.reason : new DOMException("Ask cancelled", "AbortError");
}
export function raceAbort<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  // An operation started after the abort is refused; its own later failure must not go unhandled.
  if (signal.aborted) { operation.catch(() => undefined); return Promise.reject(abortReason(signal)); }
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
export function abort(signal?: AbortSignal): never { throw signal === undefined ? new DOMException("Ask cancelled", "AbortError") : abortReason(signal); }

/** Content-free span events: entering a call's runtime span, and its model time when it settles. */
export type AgenticModelGateSpanEventV1 =
  | { readonly role: AgenticAskModelRoleV1; readonly phase: "enter" }
  | { readonly role: AgenticAskModelRoleV1; readonly phase: "exit"; readonly elapsed_ms: number };

export interface CreateAgenticModelGateV1Options {
  /** The provider binding; every role uses answer_model. */
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly model: StructuredGenerationPort;
  /**
   * The request's access check, run before every call. The gate asks for an
   * incremental check (ADR-0038): everything released since the last check,
   * plus the session, membership, grant and connection checks.
   */
  readonly desk_revalidate: (input: { readonly signal: AbortSignal; readonly mode: "incremental" }) => Promise<{ readonly checked_at: string }>;
  /** Receives each pre-call check's time, for the request's audit. */
  readonly on_checked: (checked_at: string) => void;
  readonly now: () => number;
  /** The request's active signal (caller cancel, a stall or terminal stop). */
  readonly signal: AbortSignal;
  /** The caller's own cancel signal, if any. */
  readonly input_signal?: AbortSignal;
  readonly on_span?: (event: AgenticModelGateSpanEventV1) => void;
  /** Runs once per admitted call, after the access check and before the provider call. */
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
  /** A harness transport calls this before forwarding each exact body, never once per SDK session. */
  external<T>(request: AgenticExternalModelRequestV1, forward: (signal: AbortSignal) => Promise<{ readonly value: T; readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: string }>): Promise<T>;
  call(model_call: AgenticModelCallV1, system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, recovery?: boolean): Promise<unknown>;
  withRepair<T>(model_call: AgenticModelCallV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, parse: (value: unknown) => T, on_rejection?: (reason: string) => void): Promise<T>;
  stats(): AgenticModelGateStatsV1;
}

/** Only a digest of the exact outbound bytes is retained; credentials never enter this contract. */
export type AgenticExternalModelRequestV1 = StructuredGenerationRequestV1;

/** The pause before the one retry of an access check that failed transiently. */
export const AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1 = 400;

function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, ms);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

/**
 * Runs one access check, and runs it once more after a short pause when it
 * failed with a transient code (`unavailable`, `rate_limited`). The retry is
 * a fresh check of the same evidence, so it proves what a first success
 * would. Authorization, stale-access and not-found failures, aborts and a
 * stall are never retried.
 */
export async function revalidateWithTransientRetryV1<T>(check: () => Promise<T>, options: {
  readonly signal: AbortSignal;
  readonly assert_live: () => void;
}): Promise<T> {
  try { return await check(); }
  catch (error) {
    if (error instanceof EvidenceDeskSnapshotChangedV1 || error instanceof AgenticAskStalledErrorV1) throw error;
    const transient = error instanceof AuthorityOperationError && (error.code === "unavailable" || error.code === "rate_limited");
    if (!transient || options.signal.aborted) throw error;
    await abortablePause(AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1, options.signal);
    options.assert_live();
    return check();
  }
}

export function createAgenticModelGateV1(options: CreateAgenticModelGateV1Options): AgenticModelGateV1 {
  const { now } = options;
  const activeSignal = options.signal;
  /** How long one model call may stay silent: a structured call sends nothing until it finishes. */
  const silenceMs = options.generation.timeout_ms;
  let calls = 0; let repairs = 0; let generationStopped = false;
  let externalFailure: unknown;
  let externalQueue: Promise<unknown> = Promise.resolve();
  const generations: AgenticAskGenerationObservationV1[] = [];
  const invocationDigests: Sha256Digest[] = [];
  /** The request stopped because something it waits on stalled. */
  const stalled = () => activeSignal.aborted && activeSignal.reason instanceof AgenticAskStalledErrorV1;
  const assertLive = () => {
    if (options.input_signal?.aborted) abort(options.input_signal);
    if (stalled()) throw activeSignal.reason;
    if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
  };
  const call = async ({ role, span }: AgenticModelCallV1, system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, recovery = false): Promise<unknown> => {
    assertLive();
    const maxOutputTokens = options.generation.max_output_tokens;
    if (options.model.generate_with_admission !== undefined) {
      // The SDK is a session, not one model call. Its exact HTTP requests use the same
      // access fence, accounting and diagnostics as research, with the writer's role.
      const input: StructuredGenerationInput = { model: options.generation.answer_model, system_prompt, user_prompt: JSON.stringify(user), schema,
        max_output_tokens: maxOutputTokens, timeout_ms: silenceMs, signal: activeSignal };
      try {
        return await raceAbort(activeSignal, options.model.generate_with_admission(input, (request, forward) => {
          if (request.model !== input.model) throw new Error('Unexpected structured generation model');
          return admitExternal(request, forward, { role, span }, recovery);
        }));
      } catch (error) {
        if (isAbort(error, options.input_signal) || stalled()) throw error;
        const failure = error instanceof AgenticAskGenerationFailureV1 ? error : generationFailure(error);
        if (failure?.recovery === 'fallback') generationStopped = true;
        throw failure ?? error;
      }
    }
    // Every call is preceded by a desk check of what it may carry: what was
    // released since the last check, plus the session, membership, grant and
    // connection (ADR-0038). Release runs the full cumulative check. A
    // transient failure is retried once; each attempt is its own span.
    const validated = await revalidateWithTransientRetryV1(() => observeAgenticLifecycleV1('revalidation', 'research_revalidation', { purpose: 'model', mode: 'incremental', role, next_call_id: calls + 1 },
      () => raceAbort(activeSignal, options.desk_revalidate({ signal: activeSignal, mode: "incremental" })), value => ({ checked_at: value.checked_at })),
    { signal: activeSignal, assert_live: assertLive });
    options.on_checked(validated.checked_at);
    assertLive();
    calls += 1;
    if (recovery) repairs += 1;
    const modelInput: StructuredGenerationInput = Object.freeze({ model: options.generation.answer_model, system_prompt, user_prompt: JSON.stringify(user), schema, max_output_tokens: maxOutputTokens, timeout_ms: silenceMs, signal: activeSignal });
    const callId = calls;
    options.before_call?.(role);
    invocationDigests.push(canonicalSha256({ role, model: modelInput.model, system_prompt: modelInput.system_prompt, user_prompt: modelInput.user_prompt, schema: modelInput.schema, max_output_tokens: modelInput.max_output_tokens, timeout_ms: modelInput.timeout_ms }));
    // The request boundary fences runtime content; this records only metadata timing.
    const observedModelCall = async <T>(operation: () => Promise<T>): Promise<T> => {
      // Each call is its own span, named by its caller, so provider model calls carry that purpose.
      const started = now();
      try {
        return await observeCoreRuntimeV1(span, () => {
          options.on_span?.({ role, phase: "enter" });
          return operation();
        });
      } finally { options.on_span?.({ role, phase: "exit", elapsed_ms: Math.max(0, now() - started) }); }
    };
    try {
      return await observedModelCall(async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: callId, role, recovery,
          input: { model: modelInput.model, system_prompt: modelInput.system_prompt, user_prompt: modelInput.user_prompt, schema: modelInput.schema, max_output_tokens: modelInput.max_output_tokens, timeout_ms: modelInput.timeout_ms } });
        // Only a provider failure has an error terminal. A returned value has
        // one response terminal even when its finish reason requires recovery.
        const generate = async <T>(operation: () => Promise<T>): Promise<T> => {
          // The adapter enforces the silence period too; the gate's own timer covers a port that does not.
          const silent = new AbortController();
          const timer = setTimeout(() => silent.abort(), silenceMs);
          try { return await raceAbort(AbortSignal.any([activeSignal, silent.signal]), operation()); }
          catch (error) {
            const stall = silent.signal.aborted && !activeSignal.aborted
              ? Object.assign(new Error("model sent nothing for its silence period"), { diagnostic: { failure_class: "adapter_timeout", http_status: null, finish_reason: null } })
              : error;
            observeCoreRuntimeDiagnosticV1({ kind: 'model_error', call_id: callId, role, error_kind: coreRuntimeDiagnosticErrorKindV1(stall), ...coreRuntimeModelRoutingV1(stall, 'failure') });
            throw stall;
          } finally { clearTimeout(timer); }
        };
        if (options.model.generate_with_observation !== undefined) {
          const observed = await generate(() => options.model.generate_with_observation!(modelInput));
          observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: callId, role, value: observed.value, usage: observed.usage, finish_reason: observed.finish_reason, ...coreRuntimeModelRoutingV1(observed, 'result') });
          generations.push(Object.freeze({ role, finish_reason: observed.finish_reason, usage: observed.usage }));
          if (observed.finish_reason !== null && observed.finish_reason !== "stop") throw finishFailure(observed.finish_reason);
          return observed.value;
        }
        const value = await generate(() => options.model.generate(modelInput));
        observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: callId, role, value });
        generations.push(Object.freeze({ role, finish_reason: null, usage: null }));
        return value;
      });
    } catch (error) {
      if (error instanceof AgenticAskGenerationFailureV1) {
        if (error.recovery === "fallback") generationStopped = true;
        throw error;
      }
      // Every admitted call leaves exactly one content-free observation, including aborts.
      const diagnostic = errorDiagnostic(error);
      generations.push(Object.freeze({ role, finish_reason: diagnostic.finish_reason, usage: diagnostic.usage }));
      if (isAbort(error, options.input_signal) || stalled()) throw error;
      const failure = generationFailure(error);
      // A permanent provider rejection must not be repeated under the writer role either.
      if (failure?.recovery === "fallback") generationStopped = true;
      throw failure ?? error;
    }
  };
  /**
   * At most one extra call: temporary failures retry unchanged; invalid output gets repair guidance. Each admitted extra
   * call is counted by what it corrects; a caller's rejection is model_repair_rejected.
   */
  const withRepair = async <T>(model_call: AgenticModelCallV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, parse: (value: unknown) => T, on_rejection?: (reason: string) => void): Promise<T> => {
    let reason: string | null;
    let rejected: unknown;
    let correction: CoreRuntimeModelCorrectionV1;
    let silent = false;
    try { rejected = await call(model_call, system, user, schema); return parse(rejected); }
    catch (error) {
      if (isAbort(error, options.input_signal) || stalled() || !(error instanceof AgenticAskOutputErrorV1)) throw error;
      if (error instanceof AgenticAskGenerationFailureV1 && error.recovery === "fallback") throw error;
      reason = error instanceof AgenticAskGenerationFailureV1 && error.recovery === "retry" ? null : error.message;
      silent = error instanceof AgenticAskGenerationFailureV1 && error.silent;
      correction = error instanceof AgenticAskGenerationFailureV1 ? error.correction ?? (error.recovery === "retry" ? "model_retry" : "model_repair_rejected") : "model_repair_rejected";
    }
    if (reason !== null) on_rejection?.(reason);
    // A repair observes the rejected proposal and concrete validation
    // failure. These are ephemeral model inputs, never audit content. They
    // go last: the system prompt and the rest of the user prompt stay
    // byte-identical, so the rejected call's cached prefix is reused.
    const repairUser = reason === null ? user : repairInput(user, rejected, reason);
    // Counted once the extra call is admitted past its access check, as the audit counts repairs.
    const admitted = repairs;
    try { return parse(await call(model_call, system, repairUser, schema, true)); }
    catch (error) {
      // A call silent twice is a stall, named as such, not an unavailable model.
      if (silent && error instanceof AgenticAskGenerationFailureV1 && error.silent) throw new AgenticModelStalledErrorV1(silenceMs);
      throw error;
    }
    finally { if (repairs > admitted) observeCoreModelCorrectionV1(correction); }
  };
  // SDK retries and auxiliary requests cannot share an admission. Serialize them so access
  // failures have one order, even if the harness sends concurrently.
  const admitExternal = <T>(request: StructuredGenerationRequestV1, forward: (signal: AbortSignal) => Promise<{ readonly value: T; readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: string }>, { role, span }: AgenticModelCallV1, recovery = false): Promise<T> => {
    const requestSignal = request.signal === undefined ? activeSignal : AbortSignal.any([activeSignal, request.signal]);
    const assertRequestLive = () => { assertLive(); requestSignal.throwIfAborted(); };
    const run = externalQueue.then(async () => {
      if (externalFailure !== undefined) throw externalFailure;
      assertRequestLive();
      if (!/^[a-zA-Z0-9_.:/-]{1,200}$/u.test(request.model) || !/^sha256:[a-f0-9]{64}$/u.test(request.body_sha256)) throw new Error('Invalid external model invocation');
      try {
        const validated = await revalidateWithTransientRetryV1(() => observeAgenticLifecycleV1('revalidation', 'research_revalidation',
          { purpose: 'model', mode: 'incremental', role, next_call_id: calls + 1 },
          () => raceAbort(requestSignal, options.desk_revalidate({ signal: requestSignal, mode: 'incremental' })), value => ({ checked_at: value.checked_at })),
        { signal: requestSignal, assert_live: assertRequestLive });
        options.on_checked(validated.checked_at); assertRequestLive();
      } catch (error) { if (!requestSignal.aborted) externalFailure = error; throw error; }
      // One request may stay silent for its silence period; the SDK session around it has no clock of its own.
      const timeoutMs = silenceMs;
      calls += 1;
      if (recovery) repairs += 1;
      const engine = role === 'step' ? 'external_research' : 'external_writer';
      invocationDigests.push(canonicalSha256({ engine, model: request.model, body_sha256: request.body_sha256, operation: request.operation }));
      // Count-token requests carry evidence but do not mean the reasoning model read it.
      if (request.operation === 'messages') { request.before_forward?.(); options.before_call?.(role); }
      const started = now();
      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
      const signal = AbortSignal.any([requestSignal, timeoutSignal]);
      try {
        const result = await observeCoreRuntimeV1(span, async () => {
          options.on_span?.({ role, phase: 'enter' });
          const observed = request.diagnostic_input !== undefined;
          if (observed) observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: calls, role, recovery, input: request.diagnostic_input! });
          try {
            const result = await raceAbort(signal, forward(signal));
            if (observed) observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: calls, role, value: result.value ?? null,
              ...(result.usage === undefined ? {} : { usage: result.usage }), finish_reason: result.finish_reason === 'stop' || result.finish_reason === 'length' ? result.finish_reason : 'other' });
            return result;
          } catch (error) {
            // This request sent nothing for its silence period: a stall, not a provider failure. A caller stop wins.
            if (timeoutSignal.aborted && !requestSignal.aborted) {
              try { assertLive(); error = new AgenticModelStalledErrorV1(timeoutMs); } catch (stop) { error = stop; }
            }
            if (observed) observeCoreRuntimeDiagnosticV1({ kind: 'model_error', call_id: calls, role, error_kind: error instanceof AgenticModelStalledErrorV1 ? 'adapter_timeout' : coreRuntimeDiagnosticErrorKindV1(error) });
            throw error;
          }
        });
        generations.push(Object.freeze({ role, engine, model: request.model, finish_reason: result.finish_reason ?? null, usage: result.usage ?? null }));
        return result.value;
      } catch (error) {
        generations.push(Object.freeze({ role, engine, model: request.model, finish_reason: null, usage: null }));
        throw error;
      } finally { options.on_span?.({ role, phase: 'exit', elapsed_ms: Math.max(0, now() - started) }); }
    });
    externalQueue = run.catch(() => undefined);
    return run;
  };
  const external: AgenticModelGateV1['external'] = (request, forward) => admitExternal(request, forward, { role: 'step', span: 'ask_planner' });
  return Object.freeze({
    call, withRepair, external,
    stats: (): AgenticModelGateStatsV1 => Object.freeze({
      calls, repairs, generations: Object.freeze([...generations]), invocation_digests: Object.freeze([...invocationDigests]), stopped: generationStopped,
    }),
  });
}
