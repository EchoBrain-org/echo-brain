import type { StructuredGenerationFailureDiagnosticV1, StructuredGenerationInput, StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import type { AgenticResearchDriverV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';

export type ModelCallPriorityV1 = "interactive" | "background";
/** Runs one model call when a slot is free. Provider code receives only this, never the limiter. */
type ModelCallLimitV1 = <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
export interface ModelCallLimiterV1 {
  run<T>(priority: ModelCallPriorityV1, signal: AbortSignal | undefined, op: () => Promise<T>): Promise<T>;
}

const MODEL_CALL_LIMITS = Object.freeze({ concurrent: 6, background: 4 });
/** Each SDK research session runs a Claude Code process (about 210 MB resident). */
export const RESEARCH_SESSION_LIMITS_V1 = Object.freeze({ concurrent: 3, background: 2 });
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;

/** The provider refused or is struggling: a 408, 429 or 5xx reply, a rate limit, a temporary failure or a timeout. */
function transient(error: unknown): boolean {
  // The port's failure diagnostic (StructuredGenerationFailureV1), or a processing AdapterError's code.
  const value = error as { readonly diagnostic?: Partial<StructuredGenerationFailureDiagnosticV1>; readonly code?: unknown } | null;
  if (typeof value !== "object" || value === null) return false;
  const status = value.diagnostic?.http_status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500) || value.diagnostic?.failure_class === "adapter_timeout"
    || value.code === "rate_limited" || value.code === "temporarily_unavailable" || value.code === "timeout";
}

/**
 * One process-wide gate for the Authority's model calls, which share one
 * OpenRouter credential. Interactive calls (Ask) are served first and may use
 * every slot; background calls (extraction, notes, trigger research)
 * use at most four. It never retries: a 429, a 5xx, a temporary failure or a
 * timeout only pauses background admission, once per episode, 5 s doubling to
 * 60 s until a call succeeds. Callers wrap the call itself, so time spent
 * queued never counts against its own timeout.
 */
export function createModelCallLimiterV1(limits: { readonly concurrent: number; readonly background: number } = MODEL_CALL_LIMITS): ModelCallLimiterV1 {
  let active = 0;
  let background = 0;
  let cooldownMs = 0;
  let pausedUntil = 0;
  /** Pauses begun. A call speaks for the provider only if admitted since the latest one began, and once it is over. */
  let pauses = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  const waiting: Record<ModelCallPriorityV1, (() => void)[]> = { interactive: [], background: [] };
  const pump = (): void => {
    while (active < limits.concurrent) {
      const next = waiting.interactive[0] ?? (background < limits.background && Date.now() >= pausedUntil ? waiting.background[0] : undefined);
      if (next === undefined) break;
      next();
    }
    if (waiting.background.length > 0 && Date.now() < pausedUntil && wake === undefined) {
      wake = setTimeout(() => { wake = undefined; pump(); }, pausedUntil - Date.now());
      wake.unref?.();
    }
  };
  return Object.freeze({
    async run<T>(priority: ModelCallPriorityV1, signal: AbortSignal | undefined, op: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      const queue = waiting[priority];
      const admittedAt = await new Promise<number>((resolve, reject) => {
        const abort = () => { const at = queue.indexOf(admit); if (at >= 0) queue.splice(at, 1); reject(signal!.reason); };
        const admit = () => {
          queue.shift();
          signal?.removeEventListener("abort", abort);
          active++;
          if (priority === "background") background++;
          resolve(pauses);
        };
        signal?.addEventListener("abort", abort, { once: true });
        queue.push(admit);
        pump();
      });
      const current = () => admittedAt === pauses && Date.now() >= pausedUntil;
      try {
        const value = await op();
        if (current()) cooldownMs = 0;
        return value;
      } catch (error) {
        if (transient(error) && current()) {
          cooldownMs = Math.min(cooldownMs === 0 ? COOLDOWN_MIN_MS : cooldownMs * 2, COOLDOWN_MAX_MS);
          pausedUntil = Date.now() + cooldownMs;
          pauses++;
        }
        throw error;
      } finally {
        active--;
        if (priority === "background") background--;
        pump();
      }
    },
  });
}

/** The same port, with each call admitted through `limit`. */
export function limitStructuredGenerationPortV1(port: StructuredGenerationPort, limit: ModelCallLimitV1, sessions: ModelCallLimitV1 = (_signal, op) => op()): StructuredGenerationPort {
  const generate = (input: StructuredGenerationInput) => limit(input.signal, () => port.generate(input));
  const observed = port.generate_with_observation;
  return Object.freeze({ generate,
    ...(observed === undefined ? {} : { generate_with_observation: (input: StructuredGenerationInput) => limit(input.signal, () => observed.call(port, input)) }),
    ...(port.generate_with_admission === undefined ? {} : { generate_with_admission: ((input, admit) => sessions(input.signal, () => {
      let queue: Promise<unknown> = Promise.resolve();
      return port.generate_with_admission!(input, (request, forward) => {
        const signal = AbortSignal.any([...(input.signal === undefined ? [] : [input.signal]), ...(request.signal === undefined ? [] : [request.signal])]);
        const next = queue.then(() => limit(signal, () => { signal.throwIfAborted(); return admit(request, forward); }));
        queue = next.catch(() => undefined);
        return next;
      });
    })) satisfies NonNullable<StructuredGenerationPort['generate_with_admission']> }),
  });
}

/**
 * Each SDK session waits for a session slot. Its requests queue one at a time before a call slot, so none holds a
 * slot behind its own session's stream, and before the access check, so waiting never makes an authorization stale.
 */
export function limitResearchDriverV1(driver: AgenticResearchDriverV1, limit: ModelCallLimitV1, sessions: ModelCallLimitV1): AgenticResearchDriverV1 {
  return { run: session => sessions(session.signal, () => {
    let queue: Promise<unknown> = Promise.resolve();
    return driver.run({ ...session, model_request: (request, forward) => {
      const next = queue.then(() => limit(session.signal, () => session.model_request(request, forward)));
      queue = next.catch(() => undefined);
      return next;
    } });
  }) };
}
