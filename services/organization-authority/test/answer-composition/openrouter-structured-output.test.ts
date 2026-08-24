import { describe, expect, it } from "vitest";
import { createOpenRouterStructuredOutput } from "../../src/answer-composition/openrouter-structured-output.js";

describe("OpenRouter Layer 4 structured output", () => {
  it("uses JSON-schema output with the configured bounds", async () => {
    const calls: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"queries":[]}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = createOpenRouterStructuredOutput({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: fetchImpl,
    });
    await expect(
      adapter.generate({
        model: "openai/gpt-4.1-mini",
        system_prompt: "system",
        user_prompt: "user",
        schema: { type: "object" },
        max_output_tokens: 300,
        timeout_ms: 1_000,
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

  it("fails closed on truncation and never exposes the credential", async () => {
    const adapter = createOpenRouterStructuredOutput({
      credential_ref: "openrouter-production",
      credential_resolver: () => "secret-not-in-errors",
      fetch_impl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "length",
                message: { content: '{"queries":[]}' },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    let caught: Error | undefined;
    try {
      await adapter.generate({
        model: "openai/gpt-4.1-mini",
        system_prompt: "system",
        user_prompt: "user",
        schema: { type: "object" },
        max_output_tokens: 300,
        timeout_ms: 1_000,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain("secret-not-in-errors");
  });
});
