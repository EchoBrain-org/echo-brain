import type { StructuredGenerationInput, StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";

export type ModelCallPriorityV1 = "interactive" | "background";
/** Runs one model call when a slot is free. Provider code receives only this, never the limiter. */
export type ModelCallLimitV1 = <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
export interface ModelCallLimiterV1 {
  run<T>(priority: ModelCallPriorityV1, signal: AbortSignal | undefined, op: () => Promise<T>): Promise<T>;
}

const MAX_CONCURRENT = 6;
const MAX_BACKGROUND = 4;
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;

function rateLimited(error: unknown): boolean {
  const value = error as { readonly diagnostic?: { readonly http_status?: unknown }; readonly code?: unknown } | null;
  return typeof value === "object" && value !== null && (value.diagnostic?.http_status === 429 || value.code === "rate_limited");
}

/**
 * One process-wide gate for the Authority's model calls, which share one
 * OpenRouter credential. Interactive calls (Ask) are served first and may use
 * every slot; background calls (extraction, notes, search, trigger research)
 * use at most four. It never retries: a 429 only pauses background admission,
 * once per episode, 5 s doubling to 60 s until a call succeeds. Callers wrap
 * the call itself, so time spent queued never counts against its own timeout.
 */
export function createModelCallLimiterV1(): ModelCallLimiterV1 {
  let active = 0;
  let background = 0;
  let cooldownMs = 0;
  let pausedUntil = 0;
  /** Pauses begun. A call speaks for the provider only if admitted since the latest one began, and once it is over. */
  let pauses = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  const waiting: Record<ModelCallPriorityV1, (() => void)[]> = { interactive: [], background: [] };
  const pump = (): void => {
    while (active < MAX_CONCURRENT) {
      const next = waiting.interactive[0] ?? (background < MAX_BACKGROUND && Date.now() >= pausedUntil ? waiting.background[0] : undefined);
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
        if (rateLimited(error) && current()) {
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
export function limitStructuredGenerationPortV1(port: StructuredGenerationPort, limit: ModelCallLimitV1): StructuredGenerationPort {
  const generate = (input: StructuredGenerationInput) => limit(input.signal, () => port.generate(input));
  const observed = port.generate_with_observation;
  return Object.freeze(observed === undefined ? { generate } : {
    generate, generate_with_observation: (input: StructuredGenerationInput) => limit(input.signal, () => observed.call(port, input)),
  });
}
