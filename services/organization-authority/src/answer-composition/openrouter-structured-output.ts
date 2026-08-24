import {
  type Layer4JsonSchema,
  type Layer4StructuredGenerationInput,
  type Layer4StructuredOutputPort,
} from "./lean-answer-composition.js";

export const OPENROUTER_STRUCTURED_OUTPUT_TIMEOUT_MS = 30_000;
export const OPENROUTER_STRUCTURED_OUTPUT_MAX_TIMEOUT_MS = 120_000;

export class OpenRouterStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterStructuredOutputError";
  }
}

export interface OpenRouterStructuredOutputOptions {
  readonly credential_ref: string;
  readonly credential_resolver: (reference: string) => string | undefined;
  readonly fetch_impl?: typeof fetch;
  readonly endpoint?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function endpoint(value: string | undefined): string {
  const selected = value ?? "https://openrouter.ai/api/v1/chat/completions";
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch {
    throw new OpenRouterStructuredOutputError("OpenRouter endpoint is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new OpenRouterStructuredOutputError("OpenRouter endpoint is invalid");
  }
  return parsed.toString();
}

function model(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new OpenRouterStructuredOutputError("OpenRouter model is invalid");
  }
}

function boundedInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new OpenRouterStructuredOutputError(`${label} is invalid`);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A small, credential-contained OpenRouter JSON-schema adapter for Layer 4. */
export function createOpenRouterStructuredOutput(
  options: OpenRouterStructuredOutputOptions,
): Layer4StructuredOutputPort {
  if (!nonEmpty(options.credential_ref)) {
    throw new OpenRouterStructuredOutputError("OpenRouter credential reference is invalid");
  }
  const url = endpoint(options.endpoint);
  const fetchImpl = options.fetch_impl ?? fetch;
  return Object.freeze({
    async generate(input: Layer4StructuredGenerationInput): Promise<unknown> {
      model(input.model);
      boundedInteger(input.timeout_ms, "OpenRouter timeout", OPENROUTER_STRUCTURED_OUTPUT_MAX_TIMEOUT_MS);
      boundedInteger(input.max_output_tokens, "OpenRouter output limit", 4_096);
      if (!nonEmpty(input.system_prompt) || !nonEmpty(input.user_prompt)) {
        throw new OpenRouterStructuredOutputError("OpenRouter request is invalid");
      }
      let apiKey: string | undefined;
      try {
        apiKey = options.credential_resolver(options.credential_ref);
      } catch {
        throw new OpenRouterStructuredOutputError("OpenRouter credential is unavailable");
      }
      if (!nonEmpty(apiKey)) {
        throw new OpenRouterStructuredOutputError("OpenRouter credential is unavailable");
      }
      const signals: AbortSignal[] = [AbortSignal.timeout(input.timeout_ms)];
      if (input.signal !== undefined) signals.push(input.signal);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.any(signals),
          body: JSON.stringify({
            model: input.model,
            messages: [
              { role: "system", content: input.system_prompt },
              { role: "user", content: input.user_prompt },
            ],
            stream: false,
            max_tokens: input.max_output_tokens,
            response_format: {
              type: "json_schema",
              json_schema: { name: "echo_layer4", strict: true, schema: input.schema },
            },
            provider: {
              require_parameters: true,
              data_collection: "deny",
            },
          }),
        });
      } catch {
        throw new OpenRouterStructuredOutputError("OpenRouter request failed");
      }
      if (!response.ok) {
        throw new OpenRouterStructuredOutputError("OpenRouter request failed");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
      const root = object(payload);
      if (root === null || object(root.error) !== null) {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
      const choices = Array.isArray(root?.choices) ? root.choices : [];
      const first = object(choices[0]);
      if (
        first === null ||
        object(first.error) !== null ||
        first.finish_reason === "length" ||
        first.finish_reason === "content_filter" ||
        first.finish_reason === "error"
      ) {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
      const message = object(first?.message);
      if (message === null || nonEmpty(message.refusal)) {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
      const content = message?.content;
      if (!nonEmpty(content)) {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new OpenRouterStructuredOutputError("OpenRouter response is invalid");
      }
    },
  });
}

export type { Layer4JsonSchema };
