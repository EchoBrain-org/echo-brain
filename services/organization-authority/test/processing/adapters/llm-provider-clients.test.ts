import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../../src/processing/adapters/decision-processors/llm/anthropic-client.js';
import { OllamaClient } from '../../../src/processing/adapters/decision-processors/llm/ollama-client.js';
import { OpenAiClient } from '../../../src/processing/adapters/decision-processors/llm/openai-client.js';
import { OpenRouterClient } from '../../../src/processing/adapters/decision-processors/llm/openrouter-client.js';
import {
  StructuredGenerationAttemptError,
  type StructuredGenerationRequest,
} from '../../../src/processing/adapters/decision-processors/llm/llm-provider.js';

const generationRequest: StructuredGenerationRequest = {
  model: 'provider-model',
  systemPrompt: 'Extract explicit meeting decisions.',
  userPrompt: 'The team decided to ship on Friday.',
  schema: {
    type: 'object',
    properties: { signals: { type: 'array' } },
    required: ['signals'],
    additionalProperties: false,
  },
  maxOutputTokens: 4096,
};

function headers(init: RequestInit): Headers {
  return new Headers(init.headers);
}

describe('Ollama provider client', () => {
  it('posts a deterministic non-streaming chat request', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: '{"signals":[]}' },
          }),
          { status: 200 },
        );
      },
    });

    const response = await client.generateStructured({
      ...generationRequest,
      model: 'qwen3:4b',
    });

    expect(response.content).toBe('{"signals":[]}');
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      think: false,
      format: generationRequest.schema,
      options: { temperature: 0, num_ctx: 32_768, num_predict: 4096 },
    });
  });

  it('maps transport failures onto the shared adapter taxonomy', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async () => new Response('overloaded', { status: 500 }),
    });

    await expect(
      client.generateStructured({ ...generationRequest, model: 'qwen3:4b' }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('verifies installed model names from the tags endpoint', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url) => {
        expect(String(url)).toBe('http://127.0.0.1:11434/api/tags');
        return new Response(
          JSON.stringify({
            models: [{ name: 'qwen3:4b' }, { name: 'gemma2:2b' }],
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.verifyModel('qwen3:4b')).resolves.toBeUndefined();
    await expect(client.verifyModel('missing:latest')).rejects.toMatchObject({
      code: 'permanently_rejected',
    });
  });
});

describe('OpenAI provider client', () => {
  it('uses Responses structured output without provider-side storage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OpenAiClient({
      credentialRef: 'env:OPENAI_API_KEY',
      credentialResolver: () => 'openai-secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            id: 'resp_123',
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: '{"signals":[]}' }],
              },
            ],
            usage: { input_tokens: 42, output_tokens: 7 },
          }),
          { status: 200, headers: { 'x-request-id': 'req_123' } },
        );
      },
    });

    const result = await client.generateStructured(generationRequest);

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(headers(calls[0]!.init).get('authorization')).toBe(
      'Bearer openai-secret',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: 'provider-model',
      input: [
        { role: 'system', content: generationRequest.systemPrompt },
        { role: 'user', content: generationRequest.userPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'echo_decision_extraction',
          strict: true,
          schema: generationRequest.schema,
        },
      },
      max_output_tokens: 4096,
      store: false,
    });
    expect(result).toEqual({
      content: '{"signals":[]}',
      requestId: 'req_123',
      inputTokens: 42,
      outputTokens: 7,
      stopReason: 'completed',
    });
  });

  it('fails closed on refusals and never includes the credential in errors', async () => {
    const client = new OpenAiClient({
      credentialRef: 'env:OPENAI_API_KEY',
      credentialResolver: () => 'never-print-this-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'refusal', refusal: 'No.' }],
              },
            ],
          }),
          { status: 200 },
        ),
    });

    let error: (Error & { code?: string }) | undefined;
    try {
      await client.generateStructured(generationRequest);
    } catch (caught) {
      error = caught as Error & { code?: string };
    }
    expect(error).toBeDefined();
    expect(error!.code).toBe('permanently_rejected');
    expect(error!.message).not.toContain('never-print-this-key');
  });
});

describe('Anthropic provider client', () => {
  it('uses Messages with native output_config.format', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new AnthropicClient({
      credentialRef: 'env:ANTHROPIC_API_KEY',
      credentialResolver: () => 'anthropic-secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            id: 'msg_123',
            content: [{ type: 'text', text: '{"signals":[]}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 41, output_tokens: 6 },
          }),
          { status: 200, headers: { 'request-id': 'req_anthropic' } },
        );
      },
    });

    const result = await client.generateStructured(generationRequest);

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers(calls[0]!.init).get('x-api-key')).toBe('anthropic-secret');
    expect(headers(calls[0]!.init).get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'provider-model',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      system: generationRequest.systemPrompt,
      messages: [{ role: 'user', content: generationRequest.userPrompt }],
      output_config: {
        format: { type: 'json_schema', schema: generationRequest.schema },
      },
    });
    expect(result).toEqual({
      content: '{"signals":[]}',
      requestId: 'req_anthropic',
      inputTokens: 41,
      outputTokens: 6,
      stopReason: 'end_turn',
    });
  });

  it('verifies advertised structured-output support', async () => {
    const client = new AnthropicClient({
      credentialRef: 'env:ANTHROPIC_API_KEY',
      credentialResolver: () => 'anthropic-secret',
      fetchImpl: async (url) => {
        expect(String(url)).toBe(
          'https://api.anthropic.com/v1/models/claude-sonnet-test',
        );
        return new Response(
          JSON.stringify({
            id: 'claude-sonnet-test',
            capabilities: { structured_outputs: { supported: true } },
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.verifyModel('claude-sonnet-test'),
    ).resolves.toBeUndefined();
  });
});

describe('OpenRouter provider client', () => {
  it('uses stable Chat Completions with strict required-parameter routing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            id: 'gen_123',
            choices: [
              {
                message: { content: '{"signals":[]}' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 5,
              total_tokens: 45,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.generateStructured({
      ...generationRequest,
      model: 'anthropic/claude-sonnet-test',
    });

    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers(calls[0]!.init).get('authorization')).toBe(
      'Bearer openrouter-secret',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: 'anthropic/claude-sonnet-test',
      max_tokens: 4096,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'echo_decision_extraction',
          strict: true,
          schema: generationRequest.schema,
        },
      },
      provider: { require_parameters: true },
    });
    expect(result).toEqual({
      content: '{"signals":[]}',
      requestId: 'gen_123',
      inputTokens: 40,
      outputTokens: 5,
      totalTokens: 45,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      stopReason: 'stop',
    });
  });

  it('checks model identity and structured-output support', async () => {
    const client = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async (url) => {
        expect(String(url)).toBe(
          'https://openrouter.ai/api/v1/model/openai/gpt-test',
        );
        return new Response(
          JSON.stringify({
            data: {
              id: 'openai/gpt-test',
              supported_parameters: ['response_format', 'structured_outputs'],
            },
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.verifyModel('openai/gpt-test'),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      finishReason: 'length',
      code: 'temporarily_unavailable',
      retryable: true,
    },
    {
      finishReason: 'content_filter',
      code: 'permanently_rejected',
      retryable: false,
    },
    {
      finishReason: 'error',
      code: 'temporarily_unavailable',
      retryable: true,
    },
  ])(
    'retains only bounded usage when the provider finishes with $finishReason',
    async ({ finishReason, code, retryable }) => {
      const client = new OpenRouterClient({
        credentialRef: 'env:OPENROUTER_API_KEY',
        credentialResolver: () => 'openrouter-secret',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: 'generation-id-must-not-escape',
              choices: [
                {
                  message: { content: 'response-content-must-not-escape' },
                  finish_reason: finishReason,
                },
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 5,
                total_tokens: 45,
                prompt_tokens_details: { cached_tokens: 3 },
                completion_tokens_details: { reasoning_tokens: 2 },
              },
            }),
            { status: 200 },
          ),
      });

      let failure: unknown;
      try {
        await client.generateStructured({
          ...generationRequest,
          model: 'openai/gpt-test',
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(StructuredGenerationAttemptError);
      expect(failure).toMatchObject({
        code,
        retryable,
        observation: {
          inputTokens: 40,
          outputTokens: 5,
          totalTokens: 45,
          cachedInputTokens: 3,
          reasoningTokens: 2,
          stopReason: finishReason,
        },
      });
      expect(JSON.stringify(failure)).not.toContain(
        'response-content-must-not-escape',
      );
      expect(JSON.stringify(failure)).not.toContain(
        'generation-id-must-not-escape',
      );
    },
  );

  it('treats HTTP 200 provider errors as failures', async () => {
    const client = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 502,
              message: 'upstream failed',
              metadata: { error_type: 'provider_unavailable' },
            },
          }),
          { status: 200 },
        ),
    });

    await expect(
      client.generateStructured({
        ...generationRequest,
        model: 'openai/gpt-test',
      }),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });
});
