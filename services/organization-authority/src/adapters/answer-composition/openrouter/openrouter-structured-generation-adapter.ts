import {
  type StructuredGenerationJsonSchema,
  type StructuredGenerationInput,
  type StructuredGenerationObservedResultV1,
  type StructuredGenerationPort,
  type StructuredGenerationUsageV1,
} from "../../../answer-composition/retrieval-grounded-answer-composition.js";

export const OPENROUTER_STRUCTURED_GENERATION_TIMEOUT_MS = 30_000;
export const OPENROUTER_STRUCTURED_GENERATION_MAX_TIMEOUT_MS = 120_000;
export const STRUCTURED_GENERATION_OPERATION_CORRELATION_HEADER_V1 =
  "x-echo-operation-correlation" as const;
export const STRUCTURED_GENERATION_PREDECESSOR_TOKEN_HEADER_V1 =
  "x-echo-causal-token" as const;
export const STRUCTURED_GENERATION_CAUSAL_TOKEN_HEADER_V1 =
  "x-echo-causal-token" as const;

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
  "stop" | "length" | "content_filter" | "error" | "other";

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

export interface OpenRouterFailureGenerationObservation {
  readonly usage: StructuredGenerationUsageV1;
  readonly provider_latency_ms: number | null;
}

export class OpenRouterStructuredGenerationError extends Error {
  readonly diagnostic: OpenRouterFailureDiagnostic;
  readonly generation_observation: OpenRouterFailureGenerationObservation;

  constructor(
    message: string,
    diagnostic: OpenRouterFailureDiagnostic = failureDiagnostic({
      failure_class: "adapter_response",
    }),
    generationObservation: OpenRouterFailureGenerationObservation =
      failureGenerationObservation({}),
  ) {
    super(message);
    this.name = "OpenRouterStructuredGenerationError";
    this.diagnostic = diagnostic;
    this.generation_observation = generationObservation;
  }
}

export interface OpenRouterStructuredGenerationOptions {
  readonly credential_ref: string;
  readonly credential_resolver: (reference: string) => string | undefined;
  readonly fetch_impl?: typeof fetch;
  readonly endpoint?: string;
  readonly now_ms?: () => number;
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
    throw new OpenRouterStructuredGenerationError(
      "OpenRouter endpoint is invalid",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new OpenRouterStructuredGenerationError(
      "OpenRouter endpoint is invalid",
    );
  }
  return parsed.toString();
}

function model(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new OpenRouterStructuredGenerationError(
      "OpenRouter model is invalid",
    );
  }
}

function boundedInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new OpenRouterStructuredGenerationError(`${label} is invalid`);
  }
}

const OPAQUE_TRANSPORT_VALUE = /^[A-Za-z0-9_-]{16,128}$/;

function opaqueTransportValue(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_TRANSPORT_VALUE.test(value)
    ? value
    : undefined;
}

function transportHeaders(input: StructuredGenerationInput): Record<string, string> {
  const transport = input.transport;
  if (transport === undefined) return {};
  const operationCorrelation = opaqueTransportValue(
    transport.operation_correlation,
  );
  const predecessorToken = opaqueTransportValue(transport.predecessor_token);
  if (
    (transport.operation_correlation !== undefined && operationCorrelation === undefined) ||
    (transport.predecessor_token !== undefined && predecessorToken === undefined)
  ) {
    throw new OpenRouterStructuredGenerationError(
      "OpenRouter transport correlation is invalid",
    );
  }
  return {
    ...(operationCorrelation === undefined
      ? {}
      : { [STRUCTURED_GENERATION_OPERATION_CORRELATION_HEADER_V1]: operationCorrelation }),
    ...(predecessorToken === undefined
      ? {}
      : { [STRUCTURED_GENERATION_PREDECESSOR_TOKEN_HEADER_V1]: predecessorToken }),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function successfulUsage(
  value: unknown,
): StructuredGenerationUsageV1 {
  const usage = object(value);
  const promptDetails =
    usage === null ? null : object(usage.prompt_tokens_details);
  const completionDetails =
    usage === null ? null : object(usage.completion_tokens_details);
  return Object.freeze({
    input_tokens: nonnegativeSafeInteger(usage?.prompt_tokens),
    output_tokens: nonnegativeSafeInteger(usage?.completion_tokens),
    total_tokens: nonnegativeSafeInteger(usage?.total_tokens),
    cached_input_tokens: nonnegativeSafeInteger(promptDetails?.cached_tokens),
    reasoning_tokens: nonnegativeSafeInteger(
      completionDetails?.reasoning_tokens,
    ),
  });
}

function observedUsage(value: unknown): StructuredGenerationUsageV1 {
  const usage = object(value);
  return Object.freeze({
    input_tokens: nonnegativeSafeInteger(usage?.input_tokens),
    output_tokens: nonnegativeSafeInteger(usage?.output_tokens),
    total_tokens: nonnegativeSafeInteger(usage?.total_tokens),
    cached_input_tokens: nonnegativeSafeInteger(usage?.cached_input_tokens),
    reasoning_tokens: nonnegativeSafeInteger(usage?.reasoning_tokens),
  });
}

function safeNow(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function elapsed(startedAt: number | null, now: () => number): number | null {
  const endedAt = safeNow(now);
  if (startedAt === null || endedAt === null) return null;
  const value = Math.max(0, Math.round(endedAt - startedAt));
  return Number.isSafeInteger(value) ? value : null;
}

const OPENROUTER_GENERATION_ID = /^gen-[A-Za-z0-9]{8,64}$/;

function generationId(value: unknown): string | null {
  return typeof value === "string" && OPENROUTER_GENERATION_ID.test(value)
    ? value
    : null;
}

function finishReason(value: unknown): OpenRouterFinishReason | null {
  if (value === undefined || value === null) return null;
  if (
    value === "stop" ||
    value === "length" ||
    value === "content_filter" ||
    value === "error"
  ) {
    return value;
  }
  return typeof value === "string" ? "other" : null;
}

function isTimeoutFailure(value: unknown): boolean {
  return value instanceof Error && value.name === "TimeoutError";
}

interface OpenRouterFailureInput {
  readonly failure_class: OpenRouterFailureClass;
  readonly response?: Response;
  readonly root?: Record<string, unknown> | null;
  readonly finish_reason?: OpenRouterFinishReason | null;
  readonly usage?: StructuredGenerationUsageV1;
  readonly provider_latency_ms?: number | null;
}

function failureDiagnostic(
  input: OpenRouterFailureInput,
): OpenRouterFailureDiagnostic {
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

function failureGenerationObservation(
  input: Pick<
    OpenRouterFailureInput,
    "usage" | "provider_latency_ms"
  >,
): OpenRouterFailureGenerationObservation {
  return Object.freeze({
    usage: observedUsage(input.usage),
    provider_latency_ms: nonnegativeSafeInteger(input.provider_latency_ms),
  });
}

function fail(
  message: "OpenRouter request failed" | "OpenRouter response is invalid",
  input: Parameters<typeof failureDiagnostic>[0],
): never {
  throw new OpenRouterStructuredGenerationError(
    message,
    failureDiagnostic(input),
    failureGenerationObservation(input),
  );
}

/** A small, credential-contained OpenRouter JSON-schema adapter for answer composition. */
export function createOpenRouterStructuredGenerationAdapter(
  options: OpenRouterStructuredGenerationOptions,
): StructuredGenerationPort {
  if (!nonEmpty(options.credential_ref)) {
    throw new OpenRouterStructuredGenerationError(
      "OpenRouter credential reference is invalid",
    );
  }
  const url = endpoint(options.endpoint);
  const fetchImpl = options.fetch_impl ?? fetch;
  const nowMs = options.now_ms ?? (() => performance.now());
  async function generateWithObservation(
    input: StructuredGenerationInput,
  ): Promise<StructuredGenerationObservedResultV1> {
    model(input.model);
    boundedInteger(
      input.timeout_ms,
      "OpenRouter timeout",
      OPENROUTER_STRUCTURED_GENERATION_MAX_TIMEOUT_MS,
    );
    boundedInteger(input.max_output_tokens, "OpenRouter output limit", 4_096);
    if (!nonEmpty(input.system_prompt) || !nonEmpty(input.user_prompt)) {
      throw new OpenRouterStructuredGenerationError(
        "OpenRouter request is invalid",
      );
    }
    let apiKey: string | undefined;
    try {
      apiKey = options.credential_resolver(options.credential_ref);
    } catch {
      throw new OpenRouterStructuredGenerationError(
        "OpenRouter credential is unavailable",
      );
    }
    if (!nonEmpty(apiKey)) {
      throw new OpenRouterStructuredGenerationError(
        "OpenRouter credential is unavailable",
      );
    }
    const signals: AbortSignal[] = [AbortSignal.timeout(input.timeout_ms)];
    if (input.signal !== undefined) signals.push(input.signal);
    const request: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...transportHeaders(input),
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
          json_schema: {
            name: "echo_layer4",
            strict: true,
            schema: input.schema,
          },
        },
        provider: {
          require_parameters: true,
          data_collection: "deny",
        },
      }),
    };
    const providerStartedAt = safeNow(nowMs);
    let response: Response;
    try {
      response = await fetchImpl(url, request);
    } catch (error) {
      fail("OpenRouter request failed", {
        failure_class: isTimeoutFailure(error)
          ? "adapter_timeout"
          : "adapter_transport",
        provider_latency_ms: elapsed(providerStartedAt, nowMs),
      });
    }
    let providerLatency: number | null = null;
    let payloadText: string;
    try {
      payloadText = await response.text();
      providerLatency = elapsed(providerStartedAt, nowMs);
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
          provider_latency_ms: elapsed(providerStartedAt, nowMs),
        },
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      fail(
        response.ok
          ? "OpenRouter response is invalid"
          : "OpenRouter request failed",
        {
          failure_class: response.ok ? "adapter_response" : "adapter_http",
          response,
          provider_latency_ms: providerLatency,
        },
      );
    }
    const root = object(payload);
    const generationUsage = successfulUsage(root?.usage);
    const causalTokenHeader = response.headers.get(
      STRUCTURED_GENERATION_CAUSAL_TOKEN_HEADER_V1,
    );
    const causalToken =
      causalTokenHeader === null
        ? undefined
        : opaqueTransportValue(causalTokenHeader);
    const rootError = root === null ? null : object(root.error);
    if (!response.ok) {
      fail("OpenRouter request failed", {
        failure_class:
          rootError === null ? "adapter_http" : "adapter_provider_error",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    if (root === null || rootError !== null) {
      fail("OpenRouter response is invalid", {
        failure_class:
          rootError === null ? "adapter_response" : "adapter_provider_error",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    if (causalTokenHeader !== null && causalToken === undefined) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_response",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    const choices = Array.isArray(root?.choices) ? root.choices : [];
    const first = object(choices[0]);
    if (first === null) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_response",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    if (object(first.error) !== null) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_provider_error",
        response,
        root,
        finish_reason: finishReason(first.finish_reason),
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    const completed = finishReason(first.finish_reason);
    if (completed !== null && completed !== "stop") {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_finish",
        response,
        root,
        finish_reason: completed,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    const message = object(first?.message);
    if (message === null) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_response",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    if (nonEmpty(message.refusal)) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_refusal",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    const content = message?.content;
    if (!nonEmpty(content)) {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_response",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
    try {
      return Object.freeze({
        value: JSON.parse(content),
        usage: generationUsage,
        finish_reason: completed,
        provider_latency_ms: providerLatency,
        ...(causalToken === undefined ? {} : { causal_token: causalToken }),
      });
    } catch {
      fail("OpenRouter response is invalid", {
        failure_class: "adapter_json",
        response,
        root,
        usage: generationUsage,
        provider_latency_ms: providerLatency,
      });
    }
  }

  return Object.freeze({
    async generate(input: StructuredGenerationInput): Promise<unknown> {
      return (await generateWithObservation(input)).value;
    },
    generate_with_observation: generateWithObservation,
  });
}

export type { StructuredGenerationJsonSchema };
