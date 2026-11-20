import type { StructuredGenerationPort } from "../answer-composition/structured-generation-v1.js";
import type { AgenticResearchDriverV1 } from "../answer-composition/agentic-research-driver-v1.js";

/**
 * The complete non-secret selection that binds answer composition to its
 * generation adapter and models. The answer route persists only a digest of
 * these values, never an adapter credential or request content.
 */
export interface AnswerCompositionGenerationProfileV1 {
  readonly generation_adapter_id: string;
  readonly planner_model: string;
  readonly answer_model: string;
  /**
   * How long one model call may send nothing before it is stalled. A structured call sends nothing until its reply is
   * whole, so this is the time one call may take.
   */
  readonly timeout_ms: number;
  /** The model's own context window, in tokens: the one place Ask sizes its prompts from. */
  readonly context_tokens: number;
  /** The model's own maximum output, in tokens, reasoning included: every call's output allowance. */
  readonly max_output_tokens: number;
}

/**
 * Provider-neutral generation binding for answer composition. Provider
 * composition owns credentials and structured-output construction; Person
 * routes receive only this port and its explicit non-secret generation profile.
 */
export interface AnswerCompositionGenerationBindingV1 {
  readonly structured_output: StructuredGenerationPort;
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly research_driver?: AgenticResearchDriverV1;
}

/** Defers provider access until the admitted runtime loads its generation binding. */
export interface AnswerCompositionGenerationBundleV1 {
  load(): AnswerCompositionGenerationBindingV1;
}
