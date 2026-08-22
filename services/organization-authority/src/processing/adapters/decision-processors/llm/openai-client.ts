import { AdapterError } from '../../../core/index.js';
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

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiClient implements LlmProviderClient {
  readonly provider = 'openai' as const;
  private readonly request;

  constructor(options: HostedLlmClientOptions) {
    this.request = createHostedLlmRequester(
      this.provider,
      OPENAI_BASE_URL,
      (credential) => ({ authorization: `Bearer ${credential}` }),
      options,
    );
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    const { payload, response } = await this.request(
      '/responses',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          input: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'echo_decision_extraction',
              strict: true,
              schema: request.schema,
            },
          },
          max_output_tokens: request.maxOutputTokens,
          store: false,
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
    const status = payload['status'];
    if (status === 'incomplete') {
      const details = payload['incomplete_details'];
      const reason = isRecord(details) ? details['reason'] : undefined;
      throw new AdapterError(
        'temporarily_unavailable',
        `OpenAI response was incomplete${nonEmptyString(reason) ? `: ${reason}` : ''}`,
        true,
      );
    }
    if (status === 'failed' || isRecord(payload['error'])) {
      throw invalidProviderResponse(
        this.provider,
        'response generation failed',
      );
    }
    let content: string | undefined;
    let refusal: string | undefined;
    if (Array.isArray(payload['output'])) {
      for (const output of payload['output']) {
        if (!isRecord(output) || !Array.isArray(output['content'])) continue;
        for (const part of output['content']) {
          if (!isRecord(part)) continue;
          if (part['type'] === 'output_text' && nonEmptyString(part['text'])) {
            content = part['text'];
          }
          if (part['type'] === 'refusal' && nonEmptyString(part['refusal'])) {
            refusal = part['refusal'];
          }
        }
      }
    }
    if (refusal !== undefined) {
      throw new AdapterError(
        'permanently_rejected',
        'OpenAI refused the structured generation request',
        false,
      );
    }
    if (content === undefined && nonEmptyString(payload['output_text'])) {
      content = payload['output_text'];
    }
    if (content === undefined) {
      throw invalidProviderResponse(
        this.provider,
        'response did not contain output text',
      );
    }
    const usage = isRecord(payload['usage']) ? payload['usage'] : {};
    const inputTokens = optionalPositiveInteger(usage['input_tokens']);
    const outputTokens = optionalPositiveInteger(usage['output_tokens']);
    const requestId = response.headers.get('x-request-id') ?? undefined;
    return {
      content,
      ...(requestId === undefined ? {} : { requestId }),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(nonEmptyString(status) ? { stopReason: status } : {}),
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
  }
}
