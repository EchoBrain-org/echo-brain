import { AdapterError } from '../../../core/index.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  invalidProviderResponse,
  isRecord,
  nonEmptyString,
  optionalPositiveInteger,
  requestProviderJson,
  requiredCredential,
  type HostedLlmClientOptions,
  type LlmProviderClient,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from './llm-provider.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicClient implements LlmProviderClient {
  readonly provider = 'anthropic' as const;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HostedLlmClientOptions) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal) {
    const credential = requiredCredential(
      this.provider,
      this.options.credentialRef,
      this.options.credentialResolver,
    );
    return await requestProviderJson(
      this.provider,
      `${ANTHROPIC_BASE_URL}${path}`,
      {
        ...init,
        headers: {
          'x-api-key': credential,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          ...init.headers,
        },
      },
      this.requestTimeoutMs,
      signal,
      this.fetchImpl,
    );
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    const { payload, response } = await this.request(
      '/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          // Sonnet 5 enables adaptive thinking by default and counts thinking
          // against max_tokens. Extraction needs the budget for schema-bound
          // JSON, while validation and evidence verification remain in ECHO.
          thinking: { type: 'disabled' },
          system: request.systemPrompt,
          messages: [{ role: 'user', content: request.userPrompt }],
          output_config: {
            format: { type: 'json_schema', schema: request.schema },
          },
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
    const stopReason = payload['stop_reason'];
    if (stopReason === 'refusal') {
      throw new AdapterError(
        'permanently_rejected',
        'Anthropic refused the structured generation request',
        false,
      );
    }
    if (stopReason === 'max_tokens') {
      throw new AdapterError(
        'temporarily_unavailable',
        'Anthropic response reached the configured output-token limit',
        true,
      );
    }
    const contentBlocks = Array.isArray(payload['content'])
      ? payload['content']
      : [];
    const content = contentBlocks
      .filter(
        (block): block is Record<string, unknown> =>
          isRecord(block) && block['type'] === 'text',
      )
      .map((block) => block['text'])
      .find(nonEmptyString);
    if (content === undefined) {
      throw invalidProviderResponse(
        this.provider,
        'response did not contain text content',
      );
    }
    const usage = isRecord(payload['usage']) ? payload['usage'] : {};
    const inputTokens = optionalPositiveInteger(usage['input_tokens']);
    const outputTokens = optionalPositiveInteger(usage['output_tokens']);
    const requestId =
      response.headers.get('request-id') ??
      response.headers.get('x-request-id') ??
      (nonEmptyString(payload['id']) ? payload['id'] : undefined);
    return {
      content,
      ...(requestId === undefined ? {} : { requestId }),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(nonEmptyString(stopReason) ? { stopReason } : {}),
    };
  }

  async verifyModel(model: string, signal?: AbortSignal): Promise<void> {
    const { payload } = await this.request(
      `/models/${encodeURIComponent(model)}`,
      { method: 'GET' },
      signal,
    );
    if (!isRecord(payload) || !nonEmptyString(payload['id'])) {
      throw invalidProviderResponse(
        this.provider,
        'model lookup returned no model identity',
      );
    }
    const capabilities = payload['capabilities'];
    const structuredOutputs = isRecord(capabilities)
      ? capabilities['structured_outputs']
      : undefined;
    if (
      isRecord(structuredOutputs) &&
      structuredOutputs['supported'] === false
    ) {
      throw new AdapterError(
        'permanently_rejected',
        `Anthropic model '${model}' does not support structured outputs`,
        false,
      );
    }
  }
}
