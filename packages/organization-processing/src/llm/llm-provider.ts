import {
  AdapterError,
  type AdapterErrorCode,
  type JsonObject,
} from "../core/index.js";

export type LlmProviderId = string;

export interface StructuredGenerationRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: JsonObject;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface StructuredGenerationResult {
  content: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  stopReason?: string;
}

/**
 * The small, content-free subset of a provider response that remains useful
 * when the provider reports a completed-but-unsuccessful generation.
 *
 * Do not add request identifiers, prompts, response content, or provider error
 * detail here. This shape can cross the extraction boundary into telemetry.
 */
export interface StructuredGenerationFailureObservation {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  stopReason?: string;
}

/**
 * A provider failure that still has safe, chargeable generation metadata.
 * Consumers must treat the observation as optional because transport and
 * malformed-response failures have no trustworthy usage data.
 */
export class StructuredGenerationAttemptError extends AdapterError {
  constructor(
    code: AdapterErrorCode,
    message: string,
    retryable: boolean,
    public readonly observation: StructuredGenerationFailureObservation,
  ) {
    super(code, message, retryable);
    this.name = 'StructuredGenerationAttemptError';
  }
}

/**
 * Vendor-neutral port owned by ECHO's semantic decision processor.
 *
 * Implementations translate one schema-constrained generation request to a
 * provider wire protocol. They do not render prompts, interpret decisions, or
 * verify evidence.
 */
export interface LlmProviderClient {
  readonly provider: LlmProviderId;
  generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult>;
  verifyModel(model: string, signal?: AbortSignal): Promise<void>;
}

export type LlmCredentialResolver = (reference: string) => string | undefined;

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_LLM_REQUEST_TIMEOUT_MS = 600_000;
/** Output allowance for a configuration that sets none: room for a long meeting's items in one reply. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
export const MAX_OUTPUT_TOKENS = 131_072;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
    ? value
    : undefined;
}

function statusTaxonomy(provider: string, status: number): {
  code: AdapterErrorCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', retryable: false };
  }
  if (provider === 'OpenRouter' && status === 402) return { code: 'temporarily_unavailable', retryable: true };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status >= 500) {
    return { code: 'temporarily_unavailable', retryable: true };
  }
  return { code: 'permanently_rejected', retryable: false };
}

/** A non-2xx reply: the provider refused the request before generating anything. */
class ProviderStatusError extends AdapterError {
  constructor(provider: string, readonly http_status: number, unbilled = false) {
    super(
      statusTaxonomy(provider, http_status).code,
      `${provider} rejected the request with status ${http_status}`,
      statusTaxonomy(provider, http_status).retryable,
      { unbilled },
    );
  }
}

export function providerStatusError(
  provider: string,
  status: number,
  unbilled = false,
): AdapterError {
  return new ProviderStatusError(provider, status, unbilled);
}

/**
 * The provider refused the prompt because it, with the output allowance, passes the model's own context window: the
 * meeting is too long for one extraction call. Nothing was generated, so it is unbilled; the same prompt would be
 * refused again, so it is never retried. The window is the provider's, never an ECHO estimate.
 */
export class ExtractionInputTooLongError extends AdapterError {
  constructor(provider: string) {
    super('permanently_rejected', `${provider} refused the meeting: it is longer than the model's context window`, false, { unbilled: true });
  }
}

/** A provider's own words for a prompt past the model's context window (OpenRouter, and Anthropic through it). */
const CONTEXT_WINDOW_REFUSAL = /maximum context length|context length exceeded|prompt is too long|context window/iu;

/** True when a 400 reply's error message says the prompt is past the model's context window. */
export function isContextWindowRefusal(status: number, body: unknown): boolean {
  if (status !== 400 || !isRecord(body)) return false;
  const error = body['error'];
  const message = isRecord(error) ? error['message'] : undefined;
  return typeof message === 'string' && CONTEXT_WINDOW_REFUSAL.test(message);
}

export function invalidProviderResponse(
  provider: string,
  detail: string,
  retryable = true,
): AdapterError {
  return new AdapterError(
    retryable ? 'temporarily_unavailable' : 'permanently_rejected',
    `${provider} ${detail}`,
    retryable,
  );
}
