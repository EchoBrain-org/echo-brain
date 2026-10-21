import { observeCoreModelCorrectionV1, observeCoreModelMetadataV1, annotateCoreRuntimeV1, observeCoreRuntimeV1, observeCoreRuntimeSyncV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { claudeStructuredSchema } from "./claude-structured-schema.js";
import {
  type StructuredGenerationFailureClassV1,
  type StructuredGenerationFailureDiagnosticV1,
  type StructuredGenerationFailureV1,
  type StructuredGenerationInput,
  type StructuredGenerationObservedResultV1,
  type StructuredGenerationPort,
  type StructuredGenerationUsageV1,
} from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";

export const OPENROUTER_STRUCTURED_GENERATION_MAX_TIMEOUT_MS = 120_000;

export type OpenRouterFailureClass = StructuredGenerationFailureClassV1;

export type OpenRouterFinishReason =
  "stop" | "length" | "content_filter" | "error" | "other";

/**
 * Closed, safe-to-record failure metadata. It excludes request and response
 * content, provider error text, credentials, prompts, and reasoning.
 */
export interface OpenRouterFailureDiagnostic extends StructuredGenerationFailureDiagnosticV1 {
  readonly adapter_id: "openrouter";
  readonly adapter_request_id: string | null;
}

export interface OpenRouterFailureGenerationObservation {
  readonly usage: StructuredGenerationUsageV1;
  readonly provider_latency_ms: number | null;
  /** The upstream host that served the call, from a closed vocabulary ("other" when unlisted). */
  readonly upstream_provider: string | null;
  /** OpenRouter's generation id, for its generation stats. */
  readonly generation_id: string | null;
}

/** A successful call's observation, with the same routing identity as a failure's. */
export interface OpenRouterObservedResult extends StructuredGenerationObservedResultV1 {
  readonly upstream_provider: string | null;
  readonly generation_id: string | null;
}

/**
 * ADR-0037: upstream hosts that garbled this model's output in the 2026-09-30
 * per-host replay, even at temperature 0. Slugs, as provider.ignore takes them;
 * the evidence is per model, so the list is too.
 */
const OPENROUTER_IGNORED_PROVIDERS_BY_MODEL: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "deepseek/deepseek-v3.2": Object.freeze(["friendli", "atlas-cloud"]),
});

const CLAUDE_SONNET_5_5_MODEL = "anthropic/claude-sonnet-5.5";

/**
 * Sonnet 5.5 requires reasoning and does not advertise temperature support.
 * Medium effort shares the completion budget with the visible JSON. Reserve
 * 4,096 extra tokens even for small background calls, at most 8,192 combined.
 * This is headroom, not a separate provider-enforced reasoning-token budget.
 * Other models retain the byte-for-byte legacy sampling and output settings.
 */
function modelRequestCompatibility(input: StructuredGenerationInput): Readonly<Record<string, unknown>> {
  return input.model === CLAUDE_SONNET_5_5_MODEL
    ? Object.freeze({
        max_tokens: input.max_output_tokens + 4_096,
        reasoning: Object.freeze({ effort: "medium" }),
      })
    : Object.freeze({
        max_tokens: input.max_output_tokens,
        // ADR-0037: structured protocol output; sampling only adds variance.
        temperature: 0,
      });
}

/**
 * Upstream host display names recorded as themselves: the hosts OpenRouter
 * lists, or has listed, for the routed model. A response is never a source of
 * new labels; any other name is recorded as "other".
 */
const OPENROUTER_UPSTREAM_PROVIDERS: readonly string[] = Object.freeze([
  "Alibaba", "Amazon Bedrock", "Anthropic", "AtlasCloud", "Azure", "Baidu",
  "Claude Platform on AWS", "DeepInfra", "DeepSeek", "DigitalOcean", "Friendli",
  "GMICloud", "Google", "Mara", "Phala", "SambaNova", "SiliconFlow", "Venice",
]);

export class OpenRouterStructuredGenerationError extends Error implements StructuredGenerationFailureV1 {
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

// OpenRouter ids read gen-<digits>-<token>; the older single-token form is still accepted.
const OPENROUTER_GENERATION_ID = /^gen-[A-Za-z0-9]{8,64}(?:-[A-Za-z0-9]{8,64})?$/;

function generationId(value: unknown): string | null {
  return typeof value === "string" && OPENROUTER_GENERATION_ID.test(value)
    ? value
    : null;
}

function responseGenerationId(response: Response | undefined, root: Record<string, unknown> | null): string | null {
  const error = root === null ? null : object(root.error);
  const metadata = error === null ? null : object(error.metadata);
  return generationId(response?.headers.get("x-generation-id")) ??
    generationId(root?.id) ??
    generationId(metadata?.generation_id) ??
    null;
}

/**
 * The serving host: the selected endpoint in the routing metadata this
 * adapter opts into, or else the response's top-level provider name.
 */
function upstreamProvider(root: Record<string, unknown> | null): string | null {
  const endpoints = object(object(root?.openrouter_metadata)?.endpoints);
  const available = Array.isArray(endpoints?.available) ? endpoints.available : [];
  const selected = available.map(object).find(endpoint => endpoint?.selected === true);
  const name = selected?.provider ?? root?.provider;
  if (typeof name !== "string") return null;
  return OPENROUTER_UPSTREAM_PROVIDERS.includes(name) ? name : "other";
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

/**
 * Parses model content as JSON. Some routed providers wrap a schema-valid
 * object in a Markdown fence or a short preamble even under json_schema
 * mode; the enclosed object is taken only when the whole content is not JSON,
 * and each such reading is counted by name. Callers still validate the parsed
 * value against their own protocol.
 */
export function parseModelJson(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch (error) {
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu.exec(content);
    if (fenced !== null) {
      const value = JSON.parse(fenced[1]!) as unknown;
      observeCoreModelCorrectionV1("model_json_fence_stripped");
      return value;
    }
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const value = JSON.parse(content.slice(start, end + 1)) as unknown;
      observeCoreModelCorrectionV1("model_json_outer_text_dropped");
      return value;
    }
    throw error;
  }
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
  return Object.freeze({
    failure_class: input.failure_class,
    http_status: input.response?.status ?? null,
    adapter_id: "openrouter",
    finish_reason: input.finish_reason ?? null,
    adapter_request_id: responseGenerationId(input.response, input.root ?? null),
  });
}

function failureGenerationObservation(
  input: Pick<
    OpenRouterFailureInput,
    "usage" | "provider_latency_ms" | "response" | "root"
  >,
): OpenRouterFailureGenerationObservation {
  return Object.freeze({
    usage: observedUsage(input.usage),
    provider_latency_ms: nonnegativeSafeInteger(input.provider_latency_ms),
    upstream_provider: upstreamProvider(input.root ?? null),
    generation_id: responseGenerationId(input.response, input.root ?? null),
  });
}

function fail(
  message: "OpenRouter request failed" | "OpenRouter response is invalid",
  input: Parameters<typeof failureDiagnostic>[0],
): never {
  const observation = failureGenerationObservation(input);
  annotateCoreRuntimeV1({ counts: { ...observation.usage, provider_latency_ms: observation.provider_latency_ms } });
  annotateCoreRuntimeV1({ result: input.failure_class === "adapter_timeout" ? "timeout" :
    input.response?.status === 429 ? "rate_limited" : input.failure_class === "adapter_json" ? "parse_failure" :
    ["adapter_finish", "adapter_refusal", "adapter_response"].includes(input.failure_class) ? "invalid_output" : "provider_failure" });
  throw new OpenRouterStructuredGenerationError(
    message,
    failureDiagnostic(input),
    observation,
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
  async function generateWithObservation(input: StructuredGenerationInput): Promise<OpenRouterObservedResult> {
    return observeCoreRuntimeV1("model_call", async () => generateObserved(input));
  }
  async function generateObserved(
    input: StructuredGenerationInput,
  ): Promise<OpenRouterObservedResult> {
    observeCoreModelMetadataV1({ provider: "openrouter", model: input.model });
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
    const timeoutSignal = AbortSignal.timeout(input.timeout_ms);
    const signals: AbortSignal[] = [timeoutSignal];
    if (input.signal !== undefined) signals.push(input.signal);
    const ignored = OPENROUTER_IGNORED_PROVIDERS_BY_MODEL[input.model];
    const request: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        // Documented routing metadata names the endpoint that served the call.
        "x-openrouter-metadata": "enabled",
      },
      signal: AbortSignal.any(signals),
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system_prompt },
          { role: "user", content: input.user_prompt },
        ],
        stream: false,
        ...modelRequestCompatibility(input),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "echo_layer4",
            strict: true,
            schema: input.model === CLAUDE_SONNET_5_5_MODEL ? claudeStructuredSchema(input.schema) : input.schema,
          },
        },
        provider: {
          require_parameters: true,
          data_collection: "deny",
          // ADR-0022: the loop makes several sequential calls under a 90 s
          // deadline, and OpenRouter's default price-weighted routing picked
          // slow providers; route to the fastest provider that qualifies.
          sort: "throughput",
          ...(ignored === undefined ? {} : { ignore: ignored }),
        },
      }),
    };
    annotateCoreRuntimeV1({ counts: { input_bytes: Buffer.byteLength(request.body as string), input_tokens: null, output_tokens: null, total_tokens: null } });
    const providerStartedAt = safeNow(nowMs);
    let response: Response;
    try {
      response = await fetchImpl(url, request);
    } catch (error) {
      fail("OpenRouter request failed", {
        // The call's own timeout can surface as an AbortError through
        // AbortSignal.any; the timeout signal itself is the reliable witness.
        failure_class: isTimeoutFailure(error) || timeoutSignal.aborted
          ? "adapter_timeout"
          : "adapter_transport",
        provider_latency_ms: elapsed(providerStartedAt, nowMs),
      });
    }
    let providerLatency: number | null = null;
    let payloadText: string;
    try {
      annotateCoreRuntimeV1({ counts: { http_status: response.status } });
      payloadText = await response.text();
      annotateCoreRuntimeV1({ counts: { output_bytes: Buffer.byteLength(payloadText) } });
      providerLatency = elapsed(providerStartedAt, nowMs);
    } catch (error) {
      fail(
        response.ok
          ? "OpenRouter response is invalid"
          : "OpenRouter request failed",
        {
          failure_class: isTimeoutFailure(error) || timeoutSignal.aborted
            ? "adapter_timeout"
            : response.ok
              ? "adapter_transport"
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
    annotateCoreRuntimeV1({ counts: { input_tokens: generationUsage?.input_tokens ?? null, output_tokens: generationUsage?.output_tokens ?? null, total_tokens: generationUsage?.total_tokens ?? null, cached_input_tokens: generationUsage?.cached_input_tokens ?? null, reasoning_tokens: generationUsage?.reasoning_tokens ?? null, provider_latency_ms: providerLatency } });
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
    observeCoreModelMetadataV1({ provider: "openrouter", model: input.model, ...(typeof root?.id === "string" ? { request_id: root.id } : {}), ...(completed === null ? {} : { finish_reason: completed }) });
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
        value: observeCoreRuntimeSyncV1("model_parse", () => parseModelJson(content)),
        usage: generationUsage,
        finish_reason: completed,
        provider_latency_ms: providerLatency,
        upstream_provider: upstreamProvider(root),
        generation_id: responseGenerationId(response, root),
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
