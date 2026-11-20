import { describe, expect, it } from 'vitest';
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { OpenRouterClient } from "../../src/llm/openrouter-client.js";
import {
  ExtractionInputTooLongError,
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
  it.each([
    { finish: 'content_filter', refusal: null, refused: 0 },
    { finish: 'stop', refusal: 'private refusal text', refused: 1 },
  ])('retains safe failure diagnostics for $finish with refusal=$refused', async ({ finish, refusal, refused }) => {
    const events: CoreRuntimeObservationV1[] = [];
    const promise = observeCoreRuntimeV1('model_call', () => client({
      id: 'gen-private-correlation',
      choices: [{ finish_reason: finish, message: { content: 'private response text', refusal } }],
    }).generateStructured(generationRequest), { observer: event => { events.push(event); } });
    await expect(promise).rejects.toMatchObject({ code: 'permanently_rejected', retryable: false });
    const failed = events.find(event => event.event === 'failed' && event.phase === 'model_call');
    expect(failed).toMatchObject({ finish_reason: finish, counts: { http_status: 200, provider_refusal: refused } });
    expect(failed?.provider_request).toMatch(/^[a-f0-9]{64}$/);
    for (const privateText of ['gen-private-correlation', 'private refusal text', 'private response text', generationRequest.userPrompt]) {
      expect(JSON.stringify(events)).not.toContain(privateText);
    }
  });

  it('distinguishes a JSON error inside HTTP 200 without logging its free text', async () => {
    const events: CoreRuntimeObservationV1[] = [];
    await expect(observeCoreRuntimeV1('model_call', () => client({
      id: 'gen-private-correlation', error: { code: 502, message: 'private upstream error' },
    }).generateStructured(generationRequest), { observer: event => { events.push(event); } }))
      .rejects.toMatchObject({ code: 'temporarily_unavailable', retryable: true });
    expect(events.find(event => event.event === 'failed' && event.phase === 'model_call'))
      .toMatchObject({ counts: { http_status: 200, provider_error_status: 502 } });
    expect(JSON.stringify(events)).not.toContain('private upstream error');
  });

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

  it('streams the reply, and a reply that keeps arriving is never cut off by a clock', async () => {
    const events = [': OPENROUTER PROCESSING', 'data: {"id":"gen_9","choices":[{"delta":{"content":"{\\"signals\\""}}]}',
      'data: {"id":"gen_9","choices":[{"delta":{"content":":[]}"},"finish_reason":"stop"}]}', `data: ${JSON.stringify({ id: 'gen_9', choices: [], usage: USAGE })}`, 'data: [DONE]'];
    const sent: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      const encoder = new TextEncoder();
      // Each event 40 ms apart: 200 ms in all, past the 100 ms silence period, never silent that long.
      const body = new ReadableStream<Uint8Array>({ async start(controller) {
        for (const event of events) { await new Promise(resolve => setTimeout(resolve, 40)); controller.enqueue(encoder.encode(`${event}\n\n`)); }
        controller.close();
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const streaming = new OpenRouterClient({ credentialRef: 'openrouter', credentialResolver: () => 'openrouter-secret', requestTimeoutMs: 100, fetchImpl });
    await expect(streaming.generateStructured(generationRequest)).resolves.toEqual({ content: '{"signals":[]}', requestId: 'gen_9', ...OBSERVED, stopReason: 'stop' });
    expect(JSON.parse(String(sent[0]!.body))).toMatchObject({ stream: true });
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
      // Stopped at the model's own output limit: billed, and it would stop there again, so never retried.
      finishReason: 'length',
      reply: 'content',
      code: 'permanently_rejected',
      retryable: false,
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

  // Only a status the provider documents as refused before generation is known unbilled; a 5xx such as a gateway 504
  // can arrive after the model ran.
  it.each([[429, true], [503, true], [529, true], [402, false], [500, false], [504, false], [400, false], [401, false]])(
    'declares a %i refusal unbilled: %s',
    async (status, unbilled) => {
      const refusal = new OpenRouterClient({
        credentialRef: 'env:OPENROUTER_API_KEY',
        credentialResolver: () => 'openrouter-secret',
        fetchImpl: async () => new Response('{}', { status }),
      }).generateStructured(generationRequest);
      await expect(refusal).rejects.toMatchObject({ http_status: status, unbilled, ...(status === 402 ? { code: 'temporarily_unavailable', retryable: true } : {}) });
    },
  );

  it.each([
    "This endpoint's maximum context length is 1000000 tokens. However, you requested about 1200000 tokens.",
    'prompt is too long: 1200000 tokens > 1000000 maximum',
  ])('reports a prompt past the model\'s context window as a meeting too long for one call: %s', async (message) => {
    const refusal = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 400, message } }), { status: 400 }),
    }).generateStructured(generationRequest);
    await expect(refusal).rejects.toBeInstanceOf(ExtractionInputTooLongError);
    await expect(refusal).rejects.toMatchObject({ code: 'permanently_rejected', retryable: false, unbilled: true });
  });

  it('keeps any other 400 an ordinary refusal', async () => {
    const refusal = new OpenRouterClient({
      credentialRef: 'env:OPENROUTER_API_KEY',
      credentialResolver: () => 'openrouter-secret',
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 400, message: 'invalid schema' } }), { status: 400 }),
    }).generateStructured(generationRequest);
    await expect(refusal).rejects.not.toBeInstanceOf(ExtractionInputTooLongError);
    await expect(refusal).rejects.toMatchObject({ http_status: 400, unbilled: false });
  });

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
