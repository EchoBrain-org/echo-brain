import { AdapterError } from '@echo-brain/organization-authority/processing/core/index.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  invalidProviderResponse,
  isRecord,
  nonEmptyString,
  requestProviderJson,
  type LlmProviderClient,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from './llm-provider.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaClient implements LlmProviderClient {
  readonly provider = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(
      /\/+$/u,
      '',
    );
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (
      await requestProviderJson(
        this.provider,
        `${this.baseUrl}${path}`,
        init,
        this.requestTimeoutMs,
        signal,
        this.fetchImpl,
      )
    ).payload;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    const payload = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          stream: false,
          // Qwen3 enables reasoning by default. Disable it so the bounded
          // response budget is reserved for the schema-constrained answer.
          think: false,
          format: request.schema,
          options: {
            temperature: 0,
            num_ctx: 32_768,
            num_predict: request.maxOutputTokens,
          },
        }),
      },
      request.signal,
    );
    const message = isRecord(payload) ? payload['message'] : undefined;
    const content = isRecord(message) ? message['content'] : undefined;
    if (!nonEmptyString(content)) {
      throw invalidProviderResponse(
        this.provider,
        'chat response did not contain message content',
      );
    }
    const promptTokens = isRecord(payload) ? payload['prompt_eval_count'] : 0;
    const outputTokens = isRecord(payload) ? payload['eval_count'] : 0;
    const doneReason = isRecord(payload) ? payload['done_reason'] : undefined;
    return {
      content,
      ...(Number.isSafeInteger(promptTokens) && typeof promptTokens === 'number'
        ? { inputTokens: promptTokens }
        : {}),
      ...(Number.isSafeInteger(outputTokens) && typeof outputTokens === 'number'
        ? { outputTokens }
        : {}),
      ...(nonEmptyString(doneReason) ? { stopReason: doneReason } : {}),
    };
  }

  async verifyModel(model: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.request('/api/tags', { method: 'GET' }, signal);
    const models =
      isRecord(payload) && Array.isArray(payload['models'])
        ? payload['models']
            .map((entry) =>
              isRecord(entry) && nonEmptyString(entry['name'])
                ? entry['name']
                : null,
            )
            .filter((name): name is string => name !== null)
        : [];
    if (!models.includes(model)) {
      throw new AdapterError(
        'permanently_rejected',
        `Model '${model}' is not installed in Ollama`,
        false,
      );
    }
  }
}
