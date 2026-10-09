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

const USAGE = {
  prompt_tokens: 40,
  completion_tokens: 5,
  total_tokens: 45,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
};
const OBSERVED = {
  inputTokens: 40,
  outputTokens: 5,
  totalTokens: 45,
  cachedInputTokens: 3,
  reasoningTokens: 2,
};

function headers(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function client(
  body: unknown,
  onRequest?: (url: string, init: RequestInit) => void,
): OpenRouterClient {
  return new OpenRouterClient({
    credentialRef: 'env:OPENROUTER_API_KEY',
    credentialResolver: () => 'openrouter-secret',
    fetchImpl: async (url, init) => {
      onRequest?.(String(url), init ?? {});
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
}

describe('OpenRouter provider client', () => {
  it('uses stable Chat Completions with strict required-parameter routing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await client(
      {
        id: 'gen_123',
        choices: [
          {
            message: { content: '{"signals":[]}' },
            finish_reason: 'stop',
          },
        ],
        usage: USAGE,
      },
      (url, init) => calls.push({ url, init }),
    ).generateStructured({
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
      ...OBSERVED,
      stopReason: 'stop',
    });
  });

  it('checks model identity and structured-output support', async () => {
    const modelClient = client(
      {
        data: {
          id: 'openai/gpt-test',
          supported_parameters: ['response_format', 'structured_outputs'],
        },
      },
      (url) => {
        expect(url).toBe('https://openrouter.ai/api/v1/model/openai/gpt-test');
      },
    );

    await expect(
      modelClient.verifyModel('openai/gpt-test'),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      finishReason: 'length',
      reply: 'content',
      code: 'temporarily_unavailable',
      retryable: true,
    },
    {
      finishReason: 'content_filter',
      reply: 'content',
      code: 'permanently_rejected',
      retryable: false,
    },
    {
      finishReason: 'error',
      reply: 'content',
      code: 'temporarily_unavailable',
      retryable: true,
    },
    {
      finishReason: 'stop',
      reply: 'refusal',
      code: 'permanently_rejected',
      retryable: false,
    },
  ])(
    'retains only bounded usage when the provider finishes with $finishReason and a $reply reply',
    async ({ finishReason, reply, code, retryable }) => {
      const failure = await client({
        id: 'generation-id-must-not-escape',
        choices: [
          {
            message: { [reply]: 'model-reply-must-not-escape' },
            finish_reason: finishReason,
          },
        ],
        usage: USAGE,
      })
        .generateStructured({ ...generationRequest, model: 'openai/gpt-test' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StructuredGenerationAttemptError);
      expect(failure).toMatchObject({
        code,
        retryable,
        observation: { ...OBSERVED, stopReason: finishReason },
      });
      expect(JSON.stringify(failure)).not.toContain(
        'model-reply-must-not-escape',
      );
      expect(JSON.stringify(failure)).not.toContain(
        'generation-id-must-not-escape',
      );
    },
  );

  it('treats HTTP 200 provider errors as failures', async () => {
    await expect(
      client({
        error: {
          code: 502,
          message: 'upstream failed',
          metadata: { error_type: 'provider_unavailable' },
        },
      }).generateStructured({
        ...generationRequest,
        model: 'openai/gpt-test',
      }),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });
});
