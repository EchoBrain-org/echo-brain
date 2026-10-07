import type { PersonAnswerResponseV4 } from "@echo-brain/organization-api";
import type { AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
import type { AgenticModelGateV1 } from "./agentic-model-gate-v1.js";

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
  /** The request's model gate: access check, call and time budget, fingerprints, one repair. */
  readonly gate: AgenticModelGateV1;
  /** Milliseconds the renderer may still spend. The runner has already set aside the release step's time. */
  readonly remaining: () => number;
  /** The request's signal: aborted when the caller cancels or the deadline passes. */
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
  readonly outcome: PersonAnswerResponseV4["outcome"];
  /** Model failures the renderer recovered from with its no-model fallback. */
  readonly fallbacks: number;
}

export interface AgenticRendererV1<In, Out> {
  render(input: AgenticRenderInputV1<In>): Promise<AgenticRenderOutputV1<Out>>;
}
