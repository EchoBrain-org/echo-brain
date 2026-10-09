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
