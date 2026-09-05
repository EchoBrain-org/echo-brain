import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterStructuredGenerationAdapter,
  OpenRouterStructuredGenerationError,
  STRUCTURED_GENERATION_CAUSAL_TOKEN_HEADER_V1,
  STRUCTURED_GENERATION_OPERATION_CORRELATION_HEADER_V1,
  STRUCTURED_GENERATION_PREDECESSOR_TOKEN_HEADER_V1,
} from "../../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";

const structuredRequest = {
  model: "openai/gpt-4.1-mini",
  system_prompt: "system",
  user_prompt: "user",
  schema: { type: "object" },
  max_output_tokens: 300,
  timeout_ms: 1_000,
} as const;

async function caught(
  adapter: ReturnType<typeof createOpenRouterStructuredGenerationAdapter>,
) {
  try {
    await adapter.generate(structuredRequest);
  } catch (error) {
    if (error instanceof OpenRouterStructuredGenerationError) return error;
    throw error;
  }
  throw new Error("expected OpenRouter adapter to fail");
}

async function observed(
  adapter: ReturnType<typeof createOpenRouterStructuredGenerationAdapter>,
) {
  const generate = adapter.generate_with_observation;
  if (generate === undefined)
    throw new Error("expected OpenRouter observation support");
  return generate(structuredRequest);
}

describe("OpenRouter structured generation", () => {
  it("forwards bounded transport correlation and returns an opaque causal token", async () => {
    const calls: Array<{
      readonly input: RequestInfo | URL;
      readonly init: RequestInit | undefined;
    }> = [];
    const operationCorrelation = "a".repeat(32);
    const predecessorToken = "b".repeat(32);
    const causalToken = "c".repeat(32);
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-observation",
      endpoint: "https://fixture.example/api/v1/chat/completions",
      fetch_impl: (async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{\"queries\":[]}' } }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              [STRUCTURED_GENERATION_CAUSAL_TOKEN_HEADER_V1]: causalToken,
            },
          },
        );
      }) as typeof fetch,
    });

    const result = await adapter.generate_with_observation!({
      ...structuredRequest,
      transport: {
        operation_correlation: operationCorrelation,
        predecessor_token: predecessorToken,
      },
    });
    // Verify the custom endpoint separately so request provenance cannot be
    // confused with request-body provider parameters.
    expect(calls[0]?.input).toBe("https://fixture.example/api/v1/chat/completions");
    expect(result.causal_token).toBe(causalToken);
    expect(calls[0]?.init?.headers).toMatchObject({
      [STRUCTURED_GENERATION_OPERATION_CORRELATION_HEADER_V1]: operationCorrelation,
      [STRUCTURED_GENERATION_PREDECESSOR_TOKEN_HEADER_V1]: predecessorToken,
    });
  });

  it("uses JSON-schema output with the configured bounds", async () => {
    const calls: Array<{
      readonly input: RequestInfo | URL;
      readonly init: RequestInit | undefined;
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"queries":[]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: fetchImpl,
    });
    await expect(
      adapter.generate({
        ...structuredRequest,
      }),
    ).resolves.toEqual({ queries: [] });
    expect(calls).toHaveLength(1);
    const request = calls[0]?.init;
    expect(request?.headers).toMatchObject({
      authorization: "Bearer secret-not-in-errors",
    });
    expect(typeof request?.body).toBe("string");
    expect(JSON.parse(request?.body as string)).toMatchObject({
      stream: false,
      max_tokens: 300,
      response_format: { type: "json_schema" },
      provider: { require_parameters: true, data_collection: "deny" },
    });
  });

  it("returns only safe successful generation metadata alongside the parsed value", async () => {
    const nowMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125);
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-observation",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: '{"queries":[]}',
                  reasoning: "private-reasoning-must-not-be-observed",
                },
                reasoning_details:
                  "private-reasoning-details-must-not-be-observed",
              },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
              provider_content: "private-content-must-not-be-observed",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      now_ms: nowMs,
    });

    const result = await observed(adapter);

    expect(result).toEqual({
      value: { queries: [] },
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        cached_input_tokens: 3,
        reasoning_tokens: 2,
      },
      finish_reason: "stop",
      provider_latency_ms: 25,
    });
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(
      "private-reasoning-must-not-be-observed",
    );
    expect(JSON.stringify(result)).not.toContain(
      "private-reasoning-details-must-not-be-observed",
    );
    expect(JSON.stringify(result)).not.toContain(
      "private-content-must-not-be-observed",
    );
    expect(JSON.stringify(result)).not.toContain("secret-not-in-observation");
  });

  it("normalizes missing or malformed successful usage metadata to null", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-observation",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"queries":[]}' } }],
            usage: {
              prompt_tokens: -1,
              completion_tokens: 3.5,
              total_tokens: "12",
              prompt_tokens_details: {
                cached_tokens: Number.MAX_SAFE_INTEGER + 1,
              },
              completion_tokens_details: { reasoning_tokens: null },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    await expect(observed(adapter)).resolves.toEqual({
      value: { queries: [] },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      finish_reason: null,
      provider_latency_ms: expect.any(Number),
    });
  });

  it("normalizes entirely missing successful usage metadata to null", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-observation",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"queries":[]}' } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    await expect(observed(adapter)).resolves.toEqual({
      value: { queries: [] },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      finish_reason: null,
      provider_latency_ms: expect.any(Number),
    });
  });

  it("reports only safe provider metadata for a 429 response", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            id: "gen-1234567890",
            error: {
              provider_name: "openai",
              message: "provider body secret must not be retained",
              prompt: "private prompt must not be retained",
              reasoning: "private reasoning must not be retained",
              metadata: {
                provider_name: "openai",
                generation_id: "gen-1234567890",
              },
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.message).toBe("OpenRouter request failed");
    expect(error.diagnostic).toEqual({
      failure_class: "adapter_provider_error",
      http_status: 429,
      adapter_id: "openrouter",
      finish_reason: null,
      adapter_request_id: "gen-1234567890",
    });
    expect(JSON.stringify(error)).not.toContain("secret-not-in-errors");
    expect(JSON.stringify(error)).not.toContain("provider body secret");
    expect(JSON.stringify(error)).not.toContain("private prompt");
    expect(JSON.stringify(error)).not.toContain("private reasoning");
  });

  it("reports a finish_reason:length without retaining generated content", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            id: "gen-abcdefgh12345678",
            provider: "openai",
            choices: [
              {
                finish_reason: "length",
                message: { content: "private generated content" },
              },
            ],
            usage: {
              prompt_tokens: 31,
              completion_tokens: 13,
              total_tokens: 44,
              prompt_tokens_details: { cached_tokens: 7 },
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.message).toBe("OpenRouter response is invalid");
    expect(error.diagnostic).toEqual({
      failure_class: "adapter_finish",
      http_status: 200,
      adapter_id: "openrouter",
      finish_reason: "length",
      adapter_request_id: "gen-abcdefgh12345678",
    });
    expect(error.generation_observation).toEqual({
      usage: {
        input_tokens: 31,
        output_tokens: 13,
        total_tokens: 44,
        cached_input_tokens: 7,
        reasoning_tokens: 5,
      },
      provider_latency_ms: expect.any(Number),
    });
    expect(JSON.stringify(error)).not.toContain("private generated content");
  });

  it("drops token-shaped upstream fields that are not OpenRouter metadata", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            id: "QUESTIONTOKEN79a3067",
            provider: "SOURCESECRET79a3067",
            choices: [{ finish_reason: "length", message: { content: "{}" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.diagnostic.adapter_request_id).toBeNull();
    expect(error.diagnostic.adapter_id).toBe("openrouter");
    expect(JSON.stringify(error)).not.toContain("QUESTIONTOKEN79a3067");
    expect(JSON.stringify(error)).not.toContain("SOURCESECRET79a3067");
  });

  it("reports transport failure without retaining the thrown provider error", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () => {
        throw new Error("transport body secret");
      }) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.message).toBe("OpenRouter request failed");
    expect(error.diagnostic).toEqual({
      failure_class: "adapter_transport",
      http_status: null,
      adapter_id: "openrouter",
      finish_reason: null,
      adapter_request_id: null,
    });
    expect(JSON.stringify(error)).not.toContain("transport body secret");
    expect(JSON.stringify(error)).not.toContain("secret-not-in-errors");
  });

  it("distinguishes a local timeout from another transport failure", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () => {
        throw new DOMException("private timeout detail", "TimeoutError");
      }) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.diagnostic).toEqual({
      failure_class: "adapter_timeout",
      http_status: null,
      adapter_id: "openrouter",
      finish_reason: null,
      adapter_request_id: null,
    });
    expect(JSON.stringify(error)).not.toContain("private timeout detail");
    expect(JSON.stringify(error)).not.toContain("secret-not-in-errors");
  });

  it("classifies a timeout while reading an HTTP 200 body", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => {
            throw new DOMException("private stalled body", "TimeoutError");
          },
        }) as unknown as Response) as typeof fetch,
    });

    const error = await caught(adapter);

    expect(error.diagnostic).toEqual({
      failure_class: "adapter_timeout",
      http_status: 200,
      adapter_id: "openrouter",
      finish_reason: null,
      adapter_request_id: null,
    });
    expect(JSON.stringify(error)).not.toContain("private stalled body");
  });
});
