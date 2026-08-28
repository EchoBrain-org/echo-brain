import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** The Person CLI allows 135 seconds for an ask; leave a small local margin. */
export const RAYCAST_CLI_TIMEOUT_MS = 145_000;
/** The CLI's bounded Authority response is 64 KiB; bound the process output too. */
export const RAYCAST_CLI_MAX_OUTPUT_BYTES = 128 * 1024;

type SpawnOutput = string | Buffer | null | undefined;

export interface RaycastCliSpawnResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error & { readonly code?: string };
  readonly stdout?: SpawnOutput;
  readonly stderr?: SpawnOutput;
}

export interface RaycastCliSpawnOptions {
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type RaycastCliSpawn = (
  executable: string,
  argv: readonly string[],
  options: RaycastCliSpawnOptions,
) => RaycastCliSpawnResult;

export interface RaycastCliWrapperInput {
  /** Absolute path of the separately installed, Person-authenticated CLI. */
  readonly cli_path: string;
  readonly question: string;
}

export interface RaycastCliWrapperDependencies {
  readonly spawn_sync?: RaycastCliSpawn;
}

export interface RaycastCliWrapperSuccess {
  readonly ok: true;
  readonly fullOutput: string;
  readonly answer: string;
  readonly citation_count: number;
  readonly citation_policies: readonly RaycastCitationPolicy[];
}

export interface RaycastCliWrapperFailure {
  readonly ok: false;
  readonly fullOutput: string;
  readonly error:
    | "cli_failed"
    | "cli_timed_out"
    | "cli_output_invalid"
    | "cli_unavailable";
}

export type RaycastCliWrapperResult =
  | RaycastCliWrapperSuccess
  | RaycastCliWrapperFailure;

type RaycastCitationPolicy =
  | "organization-member-readable-person-v2"
  | "restricted-reviewer-person-v2";

interface CliCitation {
  readonly policy_id: RaycastCitationPolicy;
}

interface CliSuccessEnvelope {
  readonly ok: true;
  readonly result: {
    readonly schema_version: 1;
    readonly kind: "echo-clean-person-answer-v1";
    readonly answer: string;
    readonly citations: readonly CliCitation[];
  };
}

interface CliFailureEnvelope {
  readonly ok: false;
  readonly action: "ask";
  readonly error: string;
}

const SPAWN_OPTIONS: RaycastCliSpawnOptions = {
  shell: false,
  timeout: RAYCAST_CLI_TIMEOUT_MS,
  maxBuffer: RAYCAST_CLI_MAX_OUTPUT_BYTES,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
};

function defaultSpawnSync(
  executable: string,
  argv: readonly string[],
  options: RaycastCliSpawnOptions,
): RaycastCliSpawnResult {
  return spawnSync(executable, [...argv], options);
}

function asPlainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseJson(value: SpawnOutput): unknown | null {
  const text =
    typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseSuccess(value: unknown): CliSuccessEnvelope | null {
  const envelope = asPlainRecord(value);
  if (envelope?.ok !== true) return null;
  const result = asPlainRecord(envelope.result);
  if (
    result?.schema_version !== 1 ||
    result.kind !== "echo-clean-person-answer-v1" ||
    typeof result.answer !== "string" ||
    result.answer.length === 0 ||
    !Array.isArray(result.citations)
  ) {
    return null;
  }
  const citations: CliCitation[] = [];
  for (const value of result.citations) {
    const citation = asPlainRecord(value);
    if (
      citation === null ||
      (citation.policy_id !== "organization-member-readable-person-v2" &&
        citation.policy_id !== "restricted-reviewer-person-v2")
    ) {
      return null;
    }
    citations.push({ policy_id: citation.policy_id });
  }
  return {
    ok: true,
    result: {
      schema_version: 1,
      kind: "echo-clean-person-answer-v1",
      answer: result.answer,
      citations,
    },
  };
}

function parseFailure(value: unknown): CliFailureEnvelope | null {
  const envelope = asPlainRecord(value);
  if (
    envelope?.ok !== false ||
    envelope.action !== "ask" ||
    typeof envelope.error !== "string" ||
    envelope.error.length === 0
  ) {
    return null;
  }
  return { ok: false, action: "ask", error: envelope.error };
}

function unavailable(
  error: RaycastCliWrapperFailure["error"],
): RaycastCliWrapperFailure {
  const detail =
    error === "cli_timed_out"
      ? "The ECHO request timed out. Try again."
      : error === "cli_failed"
        ? "ECHO could not answer that question. Try again."
        : error === "cli_unavailable"
          ? "The installed ECHO client is unavailable."
          : "The installed ECHO client returned an invalid response.";
  return { ok: false, error, fullOutput: detail };
}

function formatAnswer(input: CliSuccessEnvelope): RaycastCliWrapperResult {
  const policies = [...new Set(input.result.citations.map((citation) => citation.policy_id))];
  return {
    ok: true,
    answer: input.result.answer,
    citation_count: input.result.citations.length,
    citation_policies: policies,
    fullOutput: `${input.result.answer}\n\nCitations: ${input.result.citations.length}\nPolicies: ${policies.length === 0 ? "none" : policies.join(", ")}`,
  };
}

/**
 * Machine-local adapter for a Raycast command. It deliberately has no HTTP,
 * session-store, or log access: the installed Person CLI owns those concerns.
 */
export function runRaycastCliWrapper(
  input: RaycastCliWrapperInput,
  dependencies: RaycastCliWrapperDependencies = {},
): RaycastCliWrapperResult {
  if (!isAbsolute(input.cli_path)) return unavailable("cli_unavailable");
  const spawn = dependencies.spawn_sync ?? defaultSpawnSync;
  let result: RaycastCliSpawnResult;
  try {
    result = spawn(
      input.cli_path,
      ["person", "ask", "--question", input.question],
      SPAWN_OPTIONS,
    );
  } catch {
    return unavailable("cli_unavailable");
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    return unavailable("cli_timed_out");
  }
  if (result.error !== undefined) return unavailable("cli_unavailable");

  if (result.status === 0) {
    const parsed = parseSuccess(parseJson(result.stdout));
    return parsed === null ? unavailable("cli_output_invalid") : formatAnswer(parsed);
  }

  const failure = parseFailure(parseJson(result.stderr));
  if (failure !== null) {
    return {
      ok: false,
      error: "cli_failed",
      fullOutput: `ECHO could not answer that question. ${failure.error}`,
    };
  }
  return unavailable("cli_failed");
}
