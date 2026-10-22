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
  readonly timeout_ms: number;
  /** The answer model's context window in tokens, when known. Agentic Ask sizes its scratchpad from it. */
  readonly context_tokens?: number;
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
  /** Selected only by authenticated interactive Ask routes, never by a prompt or background job. */
  readonly personal_research?: {
    readonly membership_id: string;
    readonly driver: AgenticResearchDriverV1;
    readonly structured_output?: StructuredGenerationPort;
    readonly generation: AnswerCompositionGenerationProfileV1;
  };
}

/** Defers provider access until the admitted runtime loads its generation binding. */
export interface AnswerCompositionGenerationBundleV1 {
  load(): AnswerCompositionGenerationBindingV1;
}
