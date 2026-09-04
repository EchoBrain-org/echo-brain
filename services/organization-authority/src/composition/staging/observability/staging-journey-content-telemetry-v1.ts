import { canonicalJson } from "@echo-brain/federation-protocol";

export const STAGING_JOURNEY_CONTENT_SCHEMA_VERSION_V1 = 1 as const;
export const STAGING_JOURNEY_CONTENT_KIND_V1 =
  "echo-authority-journey-content-v1" as const;
/** Per-string bound. Model output and released text are sliced, never dropped. */
export const STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1 = 32_768;
/** CloudWatch Logs rejects events above 256 KiB; leave headroom for the log driver. */
export const STAGING_JOURNEY_CONTENT_MAX_RECORD_BYTES_V1 = 200_000;
const MAX_CONTENT_DEPTH = 16;

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

/**
 * Staging-only debugging record. It deliberately carries prompts, released
 * source text, raw model output, and validation messages, so it must only be
 * produced behind the explicit staging content switch and never in production.
 */
export interface StagingJourneyContentRecordV1 {
  readonly schema_version: typeof STAGING_JOURNEY_CONTENT_SCHEMA_VERSION_V1;
  readonly kind: typeof STAGING_JOURNEY_CONTENT_KIND_V1;
  readonly environment: "staging";
  readonly workflow: "ask";
  readonly journey_id: string;
  readonly sequence: number;
  readonly observed_at: string;
  readonly release_sha: string;
  readonly build_number: number;
  readonly stage: StagingJourneyContentStageV1;
  readonly content_kind: StagingJourneyContentKindV1;
  /** True when any string was sliced, a non-JSON value dropped, or content omitted. */
  readonly truncated: boolean;
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

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

interface BoundingState {
  truncated: boolean;
}

/** Projects arbitrary content into bounded plain JSON without throwing. */
function bounded(value: unknown, depth: number, state: BoundingState): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    state.truncated = true;
    return null;
  }
  if (typeof value === "string") {
    const characters = Array.from(value);
    if (characters.length <= STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1) {
      return value;
    }
    state.truncated = true;
    return characters
      .slice(0, STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1)
      .join("");
  }
  if (depth >= MAX_CONTENT_DEPTH) {
    state.truncated = true;
    return null;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => bounded(item, depth + 1, state)));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      output[key] = bounded(
        (value as Record<string, unknown>)[key],
        depth + 1,
        state,
      );
    }
    return Object.freeze(output);
  }
  // Functions, symbols, bigints, and undefined have no JSON projection.
  state.truncated = true;
  return null;
}

function serializedBytes(record: StagingJourneyContentRecordV1): number | null {
  try {
    return Buffer.byteLength(canonicalJson(record as never), "utf8");
  } catch {
    return null;
  }
}

/** Returns null for any malformed identity, so callers write nothing rather than a partial record. */
export function formatStagingJourneyContentRecordV1(
  input: StagingJourneyContentRecordInputV1,
): StagingJourneyContentRecordV1 | null {
  if (
    typeof input?.journey_id !== "string" ||
    !UUID_V4.test(input.journey_id) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !isCanonicalUtcTimestamp(input.observed_at) ||
    typeof input.release_sha !== "string" ||
    !GIT_COMMIT_SHA.test(input.release_sha) ||
    !Number.isSafeInteger(input.build_number) ||
    input.build_number < 1 ||
    !includes(STAGING_JOURNEY_CONTENT_STAGES_V1, input.stage) ||
    !includes(STAGING_JOURNEY_CONTENT_KINDS_V1, input.content_kind)
  ) {
    return null;
  }
  const state: BoundingState = { truncated: false };
  const content = bounded(input.content, 0, state);
  const base = {
    schema_version: STAGING_JOURNEY_CONTENT_SCHEMA_VERSION_V1,
    kind: STAGING_JOURNEY_CONTENT_KIND_V1,
    environment: "staging" as const,
    workflow: "ask" as const,
    journey_id: input.journey_id,
    sequence: input.sequence,
    observed_at: input.observed_at,
    release_sha: input.release_sha,
    build_number: input.build_number,
    stage: input.stage,
    content_kind: input.content_kind,
  };
  const candidate: StagingJourneyContentRecordV1 = Object.freeze({
    ...base,
    truncated: state.truncated,
    content,
  });
  const bytes = serializedBytes(candidate);
  if (bytes !== null && bytes < STAGING_JOURNEY_CONTENT_MAX_RECORD_BYTES_V1) {
    return candidate;
  }
  return Object.freeze({
    ...base,
    truncated: true,
    content: Object.freeze({ omitted: "content exceeds record bound" }),
  });
}
