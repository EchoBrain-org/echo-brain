import { describe, expect, it } from "vitest";
import {
  createOpenRouterStructuredGenerationAdapter,
  OpenRouterStructuredGenerationError,
} from "../../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";

const structuredRequest = {
  model: "openai/gpt-4.1-mini",
  system_prompt: "system",
  user_prompt: "user",
  schema: { type: "object" },
  max_output_tokens: 300,
  timeout_ms: 1_000,
} as const;

async function caught(adapter: ReturnType<typeof createOpenRouterStructuredGenerationAdapter>) {
  try {
    await adapter.generate(structuredRequest);
  } catch (error) {
    if (error instanceof OpenRouterStructuredGenerationError) return error;
    throw error;
  }
  throw new Error("expected OpenRouter adapter to fail");
}

describe("OpenRouter structured generation", () => {
  it("uses JSON-schema output with the configured bounds", async () => {
    const calls: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"queries":[]}' } }] }),
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
    expect(request?.headers).toMatchObject({ authorization: "Bearer secret-not-in-errors" });
    expect(typeof request?.body).toBe("string");
    expect(JSON.parse(request?.body as string)).toMatchObject({
      stream: false,
      max_tokens: 300,
      response_format: { type: "json_schema" },
      provider: { require_parameters: true, data_collection: "deny" },
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
          json: async () => {
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
