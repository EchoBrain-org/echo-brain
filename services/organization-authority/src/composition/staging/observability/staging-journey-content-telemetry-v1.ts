import { canonicalJson } from "@echo-brain/federation-protocol";

export const STAGING_JOURNEY_CONTENT_KIND_V1 =
  "echo-authority-journey-content-v1" as const;

export const STAGING_JOURNEY_CONTENT_STAGES_V1 = Object.freeze([
  "ask_validation",
  "ask_planner",
  "ask_context",
  "ask_answer",
] as const);
export type StagingJourneyContentStageV1 =
  (typeof STAGING_JOURNEY_CONTENT_STAGES_V1)[number];

export const STAGING_JOURNEY_CONTENT_KINDS_V1 = Object.freeze([
  "question",
  "planner_prompt",
  "planner_output",
  "planner_validation_error",
  "context_atoms",
  "answer_prompt",
  "answer_output",
  "answer_validation_error",
] as const);
export type StagingJourneyContentKindV1 =
  (typeof STAGING_JOURNEY_CONTENT_KINDS_V1)[number];

/**
 * Staging-only debugging capture. It deliberately carries prompts, released
 * source text, raw model output, and validation messages, so it must only be
 * produced behind the explicit staging content switch and never in production.
 */
export interface StagingJourneyContentRecordInputV1 {
  readonly journey_id: string;
  /** Content records keep their own sequence; stage sequence stays untouched. */
  readonly sequence: number;
  readonly observed_at: string;
  readonly release_sha: string;
  readonly build_number: number;
  readonly stage: StagingJourneyContentStageV1;
  readonly content_kind: StagingJourneyContentKindV1;
  readonly content: unknown;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function formatContentIdentity(input: Pick<StagingJourneyContentRecordInputV1,
  "journey_id" | "sequence" | "observed_at" | "release_sha" | "build_number"
>) {
  if (
    typeof input?.journey_id !== "string" ||
    !UUID_V4.test(input.journey_id) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !isCanonicalUtcTimestamp(input.observed_at) ||
    typeof input.release_sha !== "string" ||
    !GIT_COMMIT_SHA.test(input.release_sha) ||
    !Number.isSafeInteger(input.build_number) ||
    input.build_number < 1
  ) {
    return null;
  }
  return {
    kind: STAGING_JOURNEY_CONTENT_KIND_V1,
    environment: "staging" as const,
    journey_id: input.journey_id,
    sequence: input.sequence,
    observed_at: input.observed_at,
    release_sha: input.release_sha,
    build_number: input.build_number,
  };
}

/** V2 retains the existing content channel and explicitly chunks sanitized JSON. */
export interface StagingJourneyContentRecordInputV2 extends Omit<StagingJourneyContentRecordInputV1, "stage" | "content_kind"> {
  readonly stage: StagingJourneyContentStageV1 | "core_operation";
  readonly content_kind: StagingJourneyContentKindV1 | "meeting_input" | "model_request" | "model_response" | "validation_error";
  readonly span_id?: string;
}
const SECRET_KEY = /^(authorization|proxy_authorization|cookie|set_cookie|.*password.*|.*secret.*|.*credential.*|api_key|apikey|access_token|refresh_token|id_token|bearer_token|signing_key|private_key|invitation|invitation_grant|login_grant|grant|session_token)$/i;
function redactContentString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, "[REDACTED OPAQUE GRANT]")
    .replace(/(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:login[_-]?grant|invitation[_-]?grant|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)["\']?\s*[=:]\s*["\']?)[^\s&,;"'<>]+/gi, "$1[REDACTED]");
}
/** The input is a prompt/body projection, never a Request, headers, or config object. */
export function sanitizeJourneyContentV2(input: unknown): { content: unknown; truncated: boolean } {
  let truncated = false;
  let remaining = 8 * 1024 * 1024;
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (remaining <= 0 || depth > 32) { truncated = true; return null; }
    remaining -= 1;
    if (typeof value === "string") {
      const sanitized = redactContentString(value);
      if (sanitized.length > remaining) { truncated = true; remaining = 0; return null; }
      remaining -= sanitized.length;
      return sanitized;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || seen.has(value)) { truncated = true; return null; }
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value)) {
        if (remaining <= 0) { truncated = true; break; }
        const safeKey = redactContentString(key);
        result[safeKey] = SECRET_KEY.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]/g, "_")) ? "[REDACTED]" : visit((value as Record<string, unknown>)[key], depth + 1);
      }
      return result;
    } finally { seen.delete(value); }
  }
  return { content: visit(input, 0), truncated };
}

export function formatStagingJourneyContentRecordsV2(input: StagingJourneyContentRecordInputV2): readonly Record<string, unknown>[] {
  const identity = formatContentIdentity(input);
  if (identity === null ||
      ![...STAGING_JOURNEY_CONTENT_STAGES_V1, "core_operation"].includes(input.stage) ||
      ![...STAGING_JOURNEY_CONTENT_KINDS_V1, "meeting_input", "model_request", "model_response", "validation_error"].includes(input.content_kind) ||
      (input.span_id !== undefined && !UUID_V4.test(input.span_id))) return [];
  const sanitized = sanitizeJourneyContentV2(input.content);
  const serialized = canonicalJson(sanitized.content as never);
  // Array.from preserves surrogate pairs. JSON escaping still fits the record bound.
  const characters = Array.from(serialized);
  const size = 24_000;
  const chunkCount = Math.max(1, Math.ceil(characters.length / size));
  const capturedBytes = Buffer.byteLength(serialized);
  return Array.from({ length: chunkCount }, (_, index) => Object.freeze({
    ...identity, schema_version: 2, workflow: input.stage === "core_operation" ? "core_runtime" : "ask",
    stage: input.stage, content_kind: input.content_kind,
    span_id: input.span_id ?? null, capture_id: `${input.journey_id}:${input.sequence}`,
    truncated: sanitized.truncated, encoding: "json_chunks", chunk_index: index, chunk_count: chunkCount,
    captured_bytes: capturedBytes, content: characters.slice(index * size, (index + 1) * size).join(""),
  }));
}
