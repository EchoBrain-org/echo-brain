import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from "../../../../../providers/openrouter/src/llm/openrouter-client.js";
import {
  StructuredGenerationAttemptError,
  type StructuredGenerationRequest,
} from "@echo-brain/organization-processing/llm/llm-provider";

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

  it('retains bounded token usage when the model refuses a completed generation', async () => {
    const client = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { refusal: 'private refusal text' },
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
      code: 'permanently_rejected',
      retryable: false,
      observation: {
        inputTokens: 40,
        outputTokens: 5,
        totalTokens: 45,
        cachedInputTokens: 3,
        reasoningTokens: 2,
        stopReason: 'stop',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('private refusal text');
  });

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
