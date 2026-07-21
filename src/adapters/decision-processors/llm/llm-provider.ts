import {
  AdapterError,
  type AdapterErrorCode,
  type JsonObject,
} from '../../../core/index.js';

export type LlmProviderId = 'ollama' | 'openai' | 'anthropic' | 'openrouter';

export const LLM_PROVIDER_IDS: readonly LlmProviderId[] = Object.freeze([
  'ollama',
  'openai',
  'anthropic',
  'openrouter',
]);

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
  stopReason?: string;
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

export interface HostedLlmClientOptions {
  credentialRef: string;
  credentialResolver: LlmCredentialResolver;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ProviderJsonResponse {
  payload: unknown;
  response: Response;
}

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_LLM_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
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

export function requiredCredential(
  provider: LlmProviderId,
  reference: string,
  resolver: LlmCredentialResolver,
): string {
  let credential: string | undefined;
  try {
    credential = resolver(reference);
  } catch {
    throw new AdapterError(
      'unauthorized',
      `${providerLabel(provider)} credential is unreadable`,
      false,
    );
  }
  if (!nonEmptyString(credential)) {
    throw new AdapterError(
      'unauthorized',
      `${providerLabel(provider)} credential is unavailable`,
      false,
    );
  }
  return credential;
}

export function providerLabel(provider: LlmProviderId): string {
  switch (provider) {
    case 'ollama':
      return 'Ollama';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'openrouter':
      return 'OpenRouter';
  }
}

function statusTaxonomy(status: number): {
  code: AdapterErrorCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', retryable: false };
  }
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status >= 500) {
    return { code: 'temporarily_unavailable', retryable: true };
  }
  return { code: 'permanently_rejected', retryable: false };
}

export function providerStatusError(
  provider: LlmProviderId,
  status: number,
): AdapterError {
  const taxonomy = statusTaxonomy(status);
  return new AdapterError(
    taxonomy.code,
    `${providerLabel(provider)} rejected the request with status ${status}`,
    taxonomy.retryable,
  );
}

export async function requestProviderJson(
  provider: LlmProviderId,
  url: string,
  init: RequestInit,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<ProviderJsonResponse> {
  const signals = [AbortSignal.timeout(requestTimeoutMs)];
  if (signal !== undefined) signals.push(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (
      (error instanceof Error && error.name === 'TimeoutError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new AdapterError(
        'timeout',
        `${providerLabel(provider)} request timed out or was cancelled`,
        true,
      );
    }
    throw new AdapterError(
      'temporarily_unavailable',
      `${providerLabel(provider)} is unreachable`,
      true,
    );
  }
  if (!response.ok) throw providerStatusError(provider, response.status);
  try {
    return { payload: await response.json(), response };
  } catch {
    throw new AdapterError(
      'temporarily_unavailable',
      `${providerLabel(provider)} returned a non-JSON response body`,
      true,
    );
  }
}

export function invalidProviderResponse(
  provider: LlmProviderId,
  detail: string,
  retryable = true,
): AdapterError {
  return new AdapterError(
    retryable ? 'temporarily_unavailable' : 'permanently_rejected',
    `${providerLabel(provider)} ${detail}`,
    retryable,
  );
}
