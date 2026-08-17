import { AdapterError } from '@echo-brain/organization-authority/processing/core/index.js';
import {
  createHostedLlmRequester,
  invalidProviderResponse,
  isRecord,
  nonEmptyString,
  optionalPositiveInteger,
  type HostedLlmClientOptions,
  type LlmProviderClient,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from './llm-provider.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicClient implements LlmProviderClient {
  readonly provider = 'anthropic' as const;
  private readonly request;

  constructor(options: HostedLlmClientOptions) {
    this.request = createHostedLlmRequester(
      this.provider,
      ANTHROPIC_BASE_URL,
      (credential) => ({
        'x-api-key': credential,
        'anthropic-version': ANTHROPIC_VERSION,
      }),
      options,
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
