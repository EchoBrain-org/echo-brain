/** The provider-neutral structured generation port shared by research and model adapters. */

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
  /**
   * A thrown error that carries StructuredGenerationFailureV1 lets the model
   * gate retry, repair or fall back; any other error ends the request.
   */
  generate(input: StructuredGenerationInput): Promise<unknown>;
  /**
   * Optional result metadata for research cost accounting and diagnostics.
   * Existing callers retain the value-only method.
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
  /** Parsed structured value. Only explicitly selected diagnostics may retain it. */
  readonly value: unknown;
  readonly usage: StructuredGenerationUsageV1;
  readonly finish_reason: StructuredGenerationFinishReasonV1 | null;
  /** Network request and response-body time, excluding structured parsing. */
  readonly provider_latency_ms: number | null;
}

/** Why a generation failed, in the port's closed vocabulary. Adapters map their wire failures onto it. */
export const STRUCTURED_GENERATION_FAILURE_CLASSES_V1 = Object.freeze([
  "adapter_timeout",
  "adapter_transport",
  "adapter_http",
  "adapter_provider_error",
  "adapter_finish",
  "adapter_refusal",
  "adapter_response",
  "adapter_json",
] as const);
export type StructuredGenerationFailureClassV1 = typeof STRUCTURED_GENERATION_FAILURE_CLASSES_V1[number];

/** Content-free failure metadata: no prompt, reply, provider error text or credential. */
export interface StructuredGenerationFailureDiagnosticV1 {
  readonly failure_class: StructuredGenerationFailureClassV1;
  readonly http_status: number | null;
  readonly finish_reason: StructuredGenerationFinishReasonV1 | null;
}

/** The shape a port implementation's thrown error carries to earn retry, repair or fallback. */
export interface StructuredGenerationFailureV1 {
  readonly diagnostic: StructuredGenerationFailureDiagnosticV1;
  readonly generation_observation?: { readonly usage: StructuredGenerationUsageV1 };
}
