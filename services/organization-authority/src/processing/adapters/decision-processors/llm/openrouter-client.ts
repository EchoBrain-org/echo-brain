import { AdapterError } from '../../../core/index.js';
import {
  createHostedLlmRequester,
  invalidProviderResponse,
  isRecord,
  nonEmptyString,
  optionalPositiveInteger,
  type HostedLlmClientOptions,
  type LlmProviderClient,
  StructuredGenerationAttemptError,
  type StructuredGenerationFailureObservation,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from './llm-provider.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
  private readonly request;

  constructor(options: HostedLlmClientOptions) {
    this.request = createHostedLlmRequester(
      this.provider,
      OPENROUTER_BASE_URL,
      (credential) => ({ authorization: `Bearer ${credential}` }),
      options,
    );
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    const { payload, response } = await this.request(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          stream: false,
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
    );
    if (!isRecord(payload)) {
      throw invalidProviderResponse(
        this.provider,
        'returned an invalid response',
      );
    }
    const attemptObservation = generationUsageObservation(payload);
    if (isRecord(payload['error'])) {
      throw invalidProviderResponse(
        this.provider,
        'response generation failed',
      );
    }
    const choices = Array.isArray(payload['choices']) ? payload['choices'] : [];
    const first = choices.find(isRecord);
    if (first === undefined || isRecord(first['error'])) {
      throw invalidProviderResponse(
        this.provider,
        'response generation failed',
      );
    }
    const finishReason = first['finish_reason'];
    if (finishReason === 'length') {
      throw new StructuredGenerationAttemptError(
        'temporarily_unavailable',
        'OpenRouter response reached the configured output-token limit',
        true,
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
    const message = first['message'];
    if (isRecord(message) && nonEmptyString(message['refusal'])) {
      throw new AdapterError(
        'permanently_rejected',
        'OpenRouter model refused the structured generation request',
        false,
      );
    }
    const content = isRecord(message) ? message['content'] : undefined;
    if (!nonEmptyString(content)) {
      throw invalidProviderResponse(
        this.provider,
        'response did not contain message content',
      );
    }
    const requestId =
      response.headers.get('x-request-id') ??
      (nonEmptyString(payload['id']) ? payload['id'] : undefined);
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
    );
    const data = isRecord(payload) ? payload['data'] : undefined;
    if (!isRecord(data) || !nonEmptyString(data['id'])) {
      throw invalidProviderResponse(
        this.provider,
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
