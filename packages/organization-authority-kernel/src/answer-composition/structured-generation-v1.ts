/**
 * The provider-neutral structured generation port and the content-free Ask
 * stage observation shared by the agentic Ask loop (RFC-0003), the answer
 * model adapters and the staging Ask journey. The retrieval-grounded V1/V2
 * composition that first defined them was retired (ADR-0022); the shapes
 * are unchanged.
 */

export interface StructuredGenerationJsonSchema {
  readonly [key: string]: unknown;
}

/**
 * A provider-neutral structured generation port. The adapter owns credentials;
 * the core never accepts or retains a provider token.
 */
export interface StructuredGenerationInput {
  readonly model: string;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly schema: StructuredGenerationJsonSchema;
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
  readonly signal?: AbortSignal;
}

export interface StructuredGenerationPort {
  generate(input: StructuredGenerationInput): Promise<unknown>;
  /**
   * Optional content-safe result metadata used only when staging journey
   * telemetry is attached. Existing callers retain the value-only method.
   */
  generate_with_observation?(
    input: StructuredGenerationInput,
  ): Promise<StructuredGenerationObservedResultV1>;
}

export interface StructuredGenerationUsageV1 {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

export type StructuredGenerationFinishReasonV1 =
  | "stop"
  | "length"
  | "content_filter"
  | "error"
  | "other";

export interface StructuredGenerationObservedResultV1 {
  /** Parsed structured value. It is never copied into telemetry. */
  readonly value: unknown;
  readonly usage: StructuredGenerationUsageV1;
  readonly finish_reason: StructuredGenerationFinishReasonV1 | null;
  /** Network request and response-body time, excluding structured parsing. */
  readonly provider_latency_ms: number | null;
}

export type AnswerCompositionFailureClassV1 =
  | "adapter_timeout"
  | "adapter_transport"
  | "adapter_http"
  | "adapter_provider_error"
  | "adapter_finish"
  | "adapter_refusal"
  | "adapter_response"
  | "adapter_json"
  | "core_validation";

/** The Ask journey stages the loop reports, without the `ask_` prefix. */
export type AnswerCompositionObservedStageV1 =
  | "retrieval"
  | "planner"
  | "context"
  | "answer"
  | "revalidation"
  | "audit";

export type AnswerCompositionObservedEventV1 =
  | "succeeded"
  | "failed"
  | "skipped";

export interface AnswerCompositionGenerationObservationV1
  extends StructuredGenerationUsageV1 {
  /** Trusted configured adapter identifier, never a provider-returned value. */
  readonly adapter_id: string;
  /** Trusted configured model, never a provider-returned value. */
  readonly model: string;
  readonly provider_latency_ms: number;
  readonly finish_reason: StructuredGenerationFinishReasonV1 | null;
}

export interface AnswerCompositionRetrievalObservationV1 {
  readonly planned_query_count?: number;
  readonly query_hit_count?: number;
  readonly released_atom_count?: number;
  readonly context_atom_count?: number;
  readonly citation_count?: number;
}

/**
 * Content-free internal lifecycle seam. Composition translates this neutral
 * shape into the versioned journey contract; the core never imports a
 * transport or environment concern.
 */
export interface AnswerCompositionStageObservationV1 {
  readonly stage: AnswerCompositionObservedStageV1;
  readonly event: AnswerCompositionObservedEventV1;
  readonly elapsed_ms: number;
  readonly failure_class:
    | AnswerCompositionFailureClassV1
    | "audit_failure"
    | "cancelled"
    | null;
  readonly http_status: number | null;
  readonly generation_usage: AnswerCompositionGenerationObservationV1 | null;
  readonly retrieval: AnswerCompositionRetrievalObservationV1 | null;
}
