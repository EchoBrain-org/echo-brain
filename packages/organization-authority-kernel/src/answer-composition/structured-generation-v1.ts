/** The provider-neutral structured generation port shared by research and model adapters. */
import type { Sha256Digest } from '@echo-brain/federation-protocol';

/** Exact outbound request admission, including an SDK's retries and token counting. */
export interface StructuredGenerationRequestV1 {
  readonly diagnostic_input?: import('../shared/core-runtime-diagnostics-v1.js').CoreRuntimeDiagnosticModelInputV1;
  readonly model: string;
  readonly body_sha256: Sha256Digest;
  readonly operation: 'messages' | 'count_tokens';
  /** Native session/request cancellation, including expiry while waiting for a call slot. */
  readonly signal?: AbortSignal;
  readonly payload_digests?: readonly Sha256Digest[];
  readonly before_forward?: () => void;
}
/**
 * `forward` sends the admitted request. It calls `progress` at each meaningful piece of the reply that arrives (a content
 * or tool delta, not a keep-alive); the admission's silence period restarts at each call, so a reply that keeps arriving
 * is never treated as stalled.
 */
export type StructuredGenerationAdmissionV1 = <T>(request: StructuredGenerationRequestV1,
  forward: (signal: AbortSignal, progress?: () => void) => Promise<{ readonly value: T; readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: string }>) => Promise<T>;

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
  /** The silence period: how long the reply may send nothing before the call is treated as stalled. */
  readonly timeout_ms: number;
  readonly signal?: AbortSignal;
  /**
   * Called at each meaningful piece of the reply that arrives (a content or tool delta, not a keep-alive). The caller
   * restarts its silence period at each call, so a reply that keeps arriving is never treated as stalled.
   */
  readonly on_progress?: () => void;
}

export interface StructuredGenerationPort {
  /** A native harness must admit every outbound request; callers cannot wrap the session as one model call. */
  generate_with_admission?(input: StructuredGenerationInput, admit: StructuredGenerationAdmissionV1): Promise<unknown>;
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
  /**
   * True only when the provider cannot have accepted the request (it failed before the request was fully sent), so it
   * was not billed and may be sent once more. Absent means its billing is unknown, and it is never repeated.
   */
  readonly unbilled?: true;
}

/** The shape a port implementation's thrown error carries to earn retry, repair or fallback. */
export interface StructuredGenerationFailureV1 {
  readonly diagnostic: StructuredGenerationFailureDiagnosticV1;
  readonly generation_observation?: { readonly usage: StructuredGenerationUsageV1 };
}
