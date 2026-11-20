import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonAnswerResponseV8 } from "@echo-brain/organization-api";
import { AgenticAskOutputErrorV1 } from "./agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
import { isAbort, type AgenticModelCallV1, type AgenticModelGateV1 } from "./agentic-model-gate-v1.js";
import type { StructuredGenerationJsonSchema } from "./structured-generation-v1.js";

/**
 * A renderer (research trigger contract v1, section 3) turns the full
 * evidence bundle and its trigger's own input into that trigger's result, in
 * a fixed, code-validated shape. It never reads anything new: no desk, no
 * search, no open, only the bundle. It cites only bundle items. It calls a
 * model only through the request's shared gate, with role `answer`. When the
 * model fails it still ends with an honest result that needs no model.
 */
export interface AgenticRenderInputV1<In> {
  /** Everything research gathered, as the server holds it. */
  readonly bundle: AgenticEvidenceBundleV1;
  /** The trigger's own input, such as Ask's question. */
  readonly trigger_input: In;
  /** The request's model gate: access check, fingerprints, one repair. */
  readonly gate: AgenticModelGateV1;
  /** Bytes a user prompt may fill beside `system_prompt` and an answer reply (of `output_tokens`, else an answer's allowance) in the model's context window. */
  readonly prompt_budget: (system_prompt: string, output_tokens?: number) => number;
  /** The request's signal: aborted when the caller cancels or the request stalls. */
  readonly signal: AbortSignal;
  /**
   * Called once, before any model call, with the short ids of the bundle
   * items the renderer chose to show the model. The runner reports the
   * journey's context stage from it.
   */
  readonly on_context?: (selected: readonly string[]) => void;
}

export interface AgenticRenderOutputV1<Out> {
  readonly result: Out;
  /** Short ids of the bundle items the result cites, in citation order. */
  readonly cited: readonly string[];
  /** Only a follow-up's resolver asks which one (ADR-0047): no renderer does. */
  readonly outcome: Exclude<PersonAnswerResponseV8["outcome"], "clarify">;
  /** Model failures the renderer recovered from with its no-model fallback. */
  readonly fallbacks: number;
  /** The fingerprint of the result's answer, which the audit binds beside the release step's fingerprint of the whole result. */
  readonly answer_sha256: Sha256Digest;
}

export interface AgenticRendererV1<In, Out> {
  render(input: AgenticRenderInputV1<In>): Promise<AgenticRenderOutputV1<Out>>;
}

/**
 * A renderer's one model call through the request's gate, with its one repair.
 * Null when no call can be made: the gate has stopped after a permanent provider
 * failure. `value` is null when the replies stayed unusable, and the renderer
 * falls back to its no-model result. A cancel or a stall still throws.
 */
export async function callRendererModelV1<T>(input: AgenticRenderInputV1<unknown>, call: AgenticModelCallV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, parse: (value: unknown) => T): Promise<{ readonly value: T | null } | null> {
  const stats = input.gate.stats();
  if (stats.stopped) return null;
  try { return { value: await input.gate.withRepair(call, system, user, schema, parse) }; }
  catch (error) {
    // The request's signal is aborted exactly when the caller cancelled or the request stalled.
    if (isAbort(error, input.signal) || !(error instanceof AgenticAskOutputErrorV1)) throw error;
    return { value: null };
  }
}
