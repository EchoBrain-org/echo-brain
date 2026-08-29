import type { Layer4StructuredOutputPort } from "../answer-composition/lean-answer-composition.js";

/**
 * The complete non-secret selection that binds a Layer 4 answer to its
 * generation adapter and models. The answer route persists only a digest of
 * these values, never an adapter credential or request content.
 */
export interface CleanLayer4GenerationProfileV1 {
  readonly generation_adapter_id: string;
  readonly planner_model: string;
  readonly answer_model: string;
  readonly timeout_ms: number;
}

/**
 * Provider-neutral active-runtime seam for Layer 4. Provider composition owns
 * credentials and structured-output construction; Person routes receive only
 * this port and its explicit non-secret generation profile.
 */
export interface CleanLayer4RuntimeV1 {
  readonly structured_output: Layer4StructuredOutputPort;
  readonly generation: CleanLayer4GenerationProfileV1;
}

/** Defers provider access until the admitted live runtime is opened. */
export interface CleanLayer4RuntimeBundleV1 {
  open(): CleanLayer4RuntimeV1;
}
