import { AdapterError } from "@echo-brain/organization-processing/core";
import { annotateCoreRuntimeV1, observeCoreModelMetadataV1, observeCoreRuntimeSyncV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  ExtractionInputTooLongError,
  invalidProviderResponse,
  isContextWindowRefusal,
  isRecord,
  nonEmptyString,
  optionalPositiveInteger,
  providerStatusError,
  type LlmCredentialResolver,
  type LlmProviderClient,
  StructuredGenerationAttemptError,
  type StructuredGenerationFailureObservation,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "@echo-brain/organization-processing/llm/llm-provider";

import { UNBILLED_REFUSAL_STATUSES_V1 } from '../unbilled-refusal-v1.js';
import { callOpenRouterV1, OpenRouterCallFailureV1, type OpenRouterReplyV1 } from '../openrouter-stream-v1.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterClientOptions {
  readonly credentialRef: string;
  readonly credentialResolver: LlmCredentialResolver;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function generationUsageObservation(
  payload: Record<string, unknown>,
): StructuredGenerationFailureObservation {
  const usage = isRecord(payload['usage']) ? payload['usage'] : {};
  const promptTokenDetails = isRecord(usage['prompt_tokens_details'])
    ? usage['prompt_tokens_details']
    : {};
  const completionTokenDetails = isRecord(usage['completion_tokens_details'])
    ? usage['completion_tokens_details']
    : {};
  const inputTokens = optionalPositiveInteger(usage['prompt_tokens']);
  const outputTokens = optionalPositiveInteger(usage['completion_tokens']);
  const totalTokens = optionalPositiveInteger(usage['total_tokens']);
  const cachedInputTokens = optionalPositiveInteger(
    promptTokenDetails['cached_tokens'],
  );
  const reasoningTokens = optionalPositiveInteger(
    completionTokenDetails['reasoning_tokens'],
  );
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export class OpenRouterClient implements LlmProviderClient {
  readonly provider = 'openrouter' as const;
  private readonly options: OpenRouterClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One request with the resolved bearer credential: the reply's JSON (a streamed reply assembled into the same shape),
   * or the provider's refusal. The call stalls only when the model sends nothing for `requestTimeoutMs`
   * (`callOpenRouterV1`), and its reply is held to what `maxOutputTokens` can produce.
   */
  private async request(path: string, init: RequestInit, signal: AbortSignal | undefined, maxOutputTokens: number): Promise<{ readonly payload: unknown; readonly response: Response; readonly streamed: boolean }> {
    let credential: string | undefined;
    try {
      credential = this.options.credentialResolver(this.options.credentialRef);
    } catch {
      throw new AdapterError('unauthorized', 'OpenRouter credential is unreadable', false);
    }
    if (!nonEmptyString(credential)) throw new AdapterError('unauthorized', 'OpenRouter credential is unavailable', false);
    let response: Response;
    let reply: OpenRouterReplyV1;
    try {
      ({ response, reply } = await callOpenRouterV1({ fetch: this.fetchImpl, url: `${OPENROUTER_BASE_URL}${path}`,
        init: { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, ...init.headers } },
        ...(signal === undefined ? {} : { signal }), silence_ms: this.requestTimeoutMs, max_output_tokens: maxOutputTokens }));
    } catch (error) {
      if (!(error instanceof OpenRouterCallFailureV1)) throw error;
      // Every failure after sending is retryable and never unbilled: the model may have run.
      switch (error.kind) {
        case 'cancelled': throw new DOMException('OpenRouter request was cancelled', 'AbortError');
        case 'timeout': throw new AdapterError('timeout', 'OpenRouter sent nothing for the silence period', true);
        case 'too_large': throw invalidProviderResponse('OpenRouter', 'reply passed its transport capacity');
        case 'redirect': throw new AdapterError('temporarily_unavailable', `OpenRouter answered with a redirect (${error.response?.status}); the request is not re-sent`, true);
        case 'not_json': throw new AdapterError('temporarily_unavailable', 'OpenRouter returned a non-JSON response body', true);
        case 'cut': throw new AdapterError('temporarily_unavailable', 'OpenRouter stream closed in the middle of an event', true);
        default: throw new AdapterError('temporarily_unavailable', 'OpenRouter is unreachable', true);
      }
    }
    // A prompt past the model's own context window: the one real limit on how long a meeting one call can read.
    if (response.status === 400 && !reply.streamed) {
      let refusal: unknown;
      try { refusal = JSON.parse(reply.text) as unknown; } catch { refusal = undefined; }
      if (isContextWindowRefusal(response.status, refusal)) throw new ExtractionInputTooLongError('OpenRouter');
    }
    // Known unbilled only when the status says the request was refused before generation.
    if (!response.ok) throw providerStatusError('OpenRouter', response.status, UNBILLED_REFUSAL_STATUSES_V1.has(response.status));
    return this.parsed(reply, response);
  }

  private parsed(reply: OpenRouterReplyV1, response: Response): { readonly payload: unknown; readonly response: Response; readonly streamed: boolean } {
    try {
      const payload: unknown = observeCoreRuntimeSyncV1("model_parse", () => reply.streamed ? reply.payload : JSON.parse(reply.text) as unknown);
      try {
        // Usage is observational, never a business input.
        const usage = isRecord(payload) ? generationUsageObservation(payload) : {};
        annotateCoreRuntimeV1({ counts: { input_tokens: optionalPositiveInteger(usage.inputTokens) ?? null,
          output_tokens: optionalPositiveInteger(usage.outputTokens) ?? null, total_tokens: optionalPositiveInteger(usage.totalTokens) ?? null } });
      } catch { /* provider usage is not a business input */ }
      return { payload, response, streamed: reply.streamed };
    } catch {
      throw new AdapterError('temporarily_unavailable', 'OpenRouter returned a non-JSON response body', true);
    }
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    const { payload, response, streamed } = await this.request(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          // Streamed, so a long reply shows it is alive as it arrives (see `request`).
          stream: true,
          max_tokens: request.maxOutputTokens,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'echo_decision_extraction',
              strict: true,
              schema: request.schema,
            },
          },
          provider: { require_parameters: true },
        }),
      },
      request.signal,
      request.maxOutputTokens,
    );
    if (!isRecord(payload)) {
      throw invalidProviderResponse(
        'OpenRouter',
        'returned an invalid response',
      );
    }
    const attemptObservation = generationUsageObservation(payload);
    const choices = Array.isArray(payload['choices']) ? payload['choices'] : [];
    const first = choices.find(isRecord);
    const finishReason = first?.['finish_reason'];
    const message = first?.['message'];
    const requestId = response.headers.get('x-request-id') ??
      (nonEmptyString(payload['id']) ? payload['id'] : undefined);
    // Record the bounded response envelope before any rejection throws. The
    // observer hashes the request id; prompts, refusal text and error messages
    // never enter operational telemetry or the thrown error's observation.
    observeCoreModelMetadataV1({ provider: this.provider, model: request.model,
      ...(requestId === undefined ? {} : { request_id: requestId }),
      ...(nonEmptyString(finishReason) ? { finish_reason: finishReason } : {}) });
    const providerError = isRecord(payload['error']) ? payload['error'] : first?.['error'];
    const errorStatus = isRecord(providerError) ? providerError['code'] : undefined;
    annotateCoreRuntimeV1({ counts: {
      ...(isRecord(message) ? { provider_refusal: Number(nonEmptyString(message['refusal'])) } : {}),
      ...(typeof errorStatus === 'number' && Number.isInteger(errorStatus) && errorStatus >= 100 && errorStatus <= 599
        ? { provider_error_status: errorStatus } : {}),
    } });
    if (isRecord(payload['error'])) {
      throw invalidProviderResponse(
        'OpenRouter',
        'response generation failed',
      );
    }
    if (first === undefined || isRecord(first['error'])) {
      throw invalidProviderResponse(
        'OpenRouter',
        'response generation failed',
      );
    }
    // A stream that closed before the provider's terminal outcome (its finish reason) was cut off in transit: the
    // content that arrived is not a finished reply, and the call may have been billed.
    if (streamed && !nonEmptyString(finishReason)) {
      throw new StructuredGenerationAttemptError(
        'temporarily_unavailable',
        'OpenRouter stream closed before it finished',
        true,
        attemptObservation,
      );
    }
    // A reply that stopped at the model's own output limit was billed and would stop there again: never retried.
    if (finishReason === 'length') {
      throw new StructuredGenerationAttemptError(
        'permanently_rejected',
        'OpenRouter response reached the configured output-token limit',
        false,
        { ...attemptObservation, stopReason: finishReason },
      );
    }
    if (finishReason === 'content_filter') {
      throw new StructuredGenerationAttemptError(
        'permanently_rejected',
        'OpenRouter rejected the structured generation request',
        false,
        { ...attemptObservation, stopReason: finishReason },
      );
    }
    if (finishReason === 'error') {
      throw new StructuredGenerationAttemptError(
        'temporarily_unavailable',
        'response generation failed',
        true,
        { ...attemptObservation, stopReason: finishReason },
      );
    }
    if (isRecord(message) && nonEmptyString(message['refusal'])) {
      throw new StructuredGenerationAttemptError(
        'permanently_rejected',
        'OpenRouter model refused the structured generation request',
        false,
        {
          ...attemptObservation,
          ...(nonEmptyString(finishReason) ? { stopReason: finishReason } : {}),
        },
      );
    }
    const content = isRecord(message) ? message['content'] : undefined;
    if (!nonEmptyString(content)) {
      throw invalidProviderResponse(
        'OpenRouter',
        'response did not contain message content',
      );
    }
    return {
      content,
      ...(requestId === undefined ? {} : { requestId }),
      ...attemptObservation,
      ...(nonEmptyString(finishReason) ? { stopReason: finishReason } : {}),
    };
  }

  async verifyModel(model: string, signal?: AbortSignal): Promise<void> {
    const segments = model.split('/');
    if (segments.length !== 2 || segments.some((segment) => segment === '')) {
      throw new AdapterError(
        'invalid_config',
        'OpenRouter model must use the author/model-slug form',
        false,
      );
    }
    const path = segments
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const { payload } = await this.request(
      `/model/${path}`,
      { method: 'GET' },
      signal,
      // A model lookup generates nothing: its reply fits in the capacity's framing alone.
      0,
    );
    const data = isRecord(payload) ? payload['data'] : undefined;
    if (!isRecord(data) || !nonEmptyString(data['id'])) {
      throw invalidProviderResponse(
        'OpenRouter',
        'model lookup returned no model identity',
      );
    }
    const supported = Array.isArray(data['supported_parameters'])
      ? data['supported_parameters'].filter(nonEmptyString)
      : [];
    if (
      !supported.includes('structured_outputs') &&
      !supported.includes('response_format')
    ) {
      throw new AdapterError(
        'permanently_rejected',
        `OpenRouter model '${model}' does not advertise structured-output support`,
        false,
      );
    }
  }
}
