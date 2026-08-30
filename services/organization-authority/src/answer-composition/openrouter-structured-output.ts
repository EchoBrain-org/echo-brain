import {
  type Layer4JsonSchema,
  type Layer4StructuredGenerationInput,
  type Layer4StructuredOutputPort,
} from "./retrieval-grounded-answer-composition.js";

export const OPENROUTER_STRUCTURED_OUTPUT_TIMEOUT_MS = 30_000;
export const OPENROUTER_STRUCTURED_OUTPUT_MAX_TIMEOUT_MS = 120_000;

export type OpenRouterFailureClass =
  | "adapter_timeout"
  | "adapter_transport"
  | "adapter_http"
  | "adapter_provider_error"
  | "adapter_finish"
  | "adapter_refusal"
  | "adapter_response"
  | "adapter_json";

export type OpenRouterFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "error"
  | "other";

/**
 * Closed, safe-to-record failure metadata. It excludes request and response
 * content, provider error text, credentials, prompts, and reasoning.
 */
export interface OpenRouterFailureDiagnostic {
  readonly failure_class: OpenRouterFailureClass;
  readonly http_status: number | null;
  readonly adapter_id: "openrouter";
  readonly finish_reason: OpenRouterFinishReason | null;
  readonly adapter_request_id: string | null;
}

export class OpenRouterStructuredOutputError extends Error {
  readonly diagnostic: OpenRouterFailureDiagnostic;

  constructor(
    message: string,
    diagnostic: OpenRouterFailureDiagnostic = failureDiagnostic({
      failure_class: "adapter_response",
    }),
  ) {
    super(message);
    this.name = "OpenRouterStructuredOutputError";
    this.diagnostic = diagnostic;
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

const OPENROUTER_GENERATION_ID = /^gen-[A-Za-z0-9]{8,64}$/;

function generationId(value: unknown): string | null {
  return typeof value === "string" && OPENROUTER_GENERATION_ID.test(value)
    ? value
    : null;
}

function finishReason(value: unknown): OpenRouterFinishReason | null {
  if (value === undefined || value === null) return null;
  if (value === "stop" || value === "length" || value === "content_filter" || value === "error") {
    return value;
  }
  return typeof value === "string" ? "other" : null;
}

function isTimeoutFailure(value: unknown): boolean {
  return value instanceof Error && value.name === "TimeoutError";
}

function failureDiagnostic(input: {
  readonly failure_class: OpenRouterFailureClass;
  readonly response?: Response;
  readonly root?: Record<string, unknown> | null;
  readonly finish_reason?: OpenRouterFinishReason | null;
}): OpenRouterFailureDiagnostic {
  const root = input.root ?? null;
  const error = root === null ? null : object(root.error);
  const metadata = error === null ? null : object(error.metadata);
  const providerGenerationId =
    generationId(input.response?.headers.get("x-generation-id")) ??
    generationId(root?.id) ??
    generationId(metadata?.generation_id) ??
    null;
  return Object.freeze({
    failure_class: input.failure_class,
    http_status: input.response?.status ?? null,
    adapter_id: "openrouter",
    finish_reason: input.finish_reason ?? null,
    adapter_request_id: providerGenerationId,
  });
}

function fail(
  message: "OpenRouter request failed" | "OpenRouter response is invalid",
  input: Parameters<typeof failureDiagnostic>[0],
): never {
  throw new OpenRouterStructuredOutputError(message, failureDiagnostic(input));
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
      } catch (error) {
        fail("OpenRouter request failed", {
          failure_class: isTimeoutFailure(error)
            ? "adapter_timeout"
            : "adapter_transport",
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        fail(
          response.ok
            ? "OpenRouter response is invalid"
            : "OpenRouter request failed",
          {
            failure_class: isTimeoutFailure(error)
              ? "adapter_timeout"
              : response.ok
                ? "adapter_response"
                : "adapter_http",
            response,
          },
        );
      }
      const root = object(payload);
      const rootError = root === null ? null : object(root.error);
      if (!response.ok) {
        fail("OpenRouter request failed", {
          failure_class:
            rootError === null ? "adapter_http" : "adapter_provider_error",
          response,
          root,
        });
      }
      if (root === null || rootError !== null) {
        fail("OpenRouter response is invalid", {
          failure_class:
            rootError === null ? "adapter_response" : "adapter_provider_error",
          response,
          root,
        });
      }
      const choices = Array.isArray(root?.choices) ? root.choices : [];
      const first = object(choices[0]);
      if (first === null) {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_response",
          response,
          root,
        });
      }
      if (object(first.error) !== null) {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_provider_error",
          response,
          root,
          finish_reason: finishReason(first.finish_reason),
        });
      }
      const completed = finishReason(first.finish_reason);
      if (completed !== null && completed !== "stop") {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_finish",
          response,
          root,
          finish_reason: completed,
        });
      }
      const message = object(first?.message);
      if (message === null) {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_response",
          response,
          root,
        });
      }
      if (nonEmpty(message.refusal)) {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_refusal",
          response,
          root,
        });
      }
      const content = message?.content;
      if (!nonEmpty(content)) {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_response",
          response,
          root,
        });
      }
      try {
        return JSON.parse(content);
      } catch {
        fail("OpenRouter response is invalid", {
          failure_class: "adapter_json",
          response,
          root,
        });
      }
    },
  });
}

export type { Layer4JsonSchema };
