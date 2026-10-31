/**
 * What the opt-in real-model evaluation runners share (agentic-ask, ask-follow-up and ask-wording): the report's hash,
 * JSON, usage, safe-error and code-identity helpers, integer bounds, the argv loop, the private report directory, and the
 * explicit --run and private credential-file checks made before any request.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A generation's token counts: each a non-negative safe integer, else null; null for no usage at all. */
export function usage(value) {
  if (value === null || typeof value !== "object") return null;
  const integer = (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  return Object.freeze({ input_tokens: integer(value.input_tokens), output_tokens: integer(value.output_tokens), total_tokens: integer(value.total_tokens) });
}

/**
 * What a failure may keep: its class and status, never its message, payload or credential. With `withUsage`, also the
 * failed generation's token counts and provider latency.
 */
export function safeError(error, { withUsage = false } = {}) {
  const detail = error !== null && typeof error === "object" && !Array.isArray(error) ? error : null;
  const diagnostic = detail?.diagnostic !== null && typeof detail?.diagnostic === "object" ? detail.diagnostic : null;
  const failure = {
    name: error instanceof Error ? error.name : "Error",
    failure_class: typeof diagnostic?.failure_class === "string" ? diagnostic.failure_class : null,
    http_status: Number.isSafeInteger(diagnostic?.http_status) ? diagnostic.http_status : null,
    finish_reason: typeof diagnostic?.finish_reason === "string" ? diagnostic.finish_reason : null,
  };
  if (!withUsage) return Object.freeze(failure);
  const observation = detail?.generation_observation;
  const latency = observation?.provider_latency_ms;
  return Object.freeze({
    ...failure,
    usage: usage(observation?.usage),
    provider_latency_ms: typeof latency === "number" && Number.isSafeInteger(latency) && latency >= 0 ? latency : null,
  });
}

export function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

/**
 * Reads `argv` into `options`: `--run` takes no value, and every other flag takes the next argument through its setter in
 * `flags`; a missing value or an unknown flag is an error. True when --help was asked for, which stops the reading at once.
 */
export function readFlags(argv, options, flags) {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return true;
    if (flag === "--run") { options.run = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (!Object.hasOwn(flags, flag)) throw new Error(`unknown option ${flag}`);
    flags[flag](value);
  }
  return false;
}

/** Where the report goes: an absolute, private directory outside the repository at `root`, created when missing. */
export function outputDirectory(root, value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("--out must be an absolute private directory outside the repository");
  mkdirSync(value, { recursive: true, mode: 0o700 });
  const directory = realpathSync(value);
  const repository = realpathSync(root);
  if (directory === repository || directory.startsWith(`${repository}${sep}`)) throw new Error("--out must be outside the repository");
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error("--out must not be readable by group or other users");
  return directory;
}

/** The evaluated code at `root`: its commit, the digest of its uncommitted tracked changes, and each named file's digest. */
export function codeIdentity(root, files) {
  return Object.freeze({
    source_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    tracked_patch_sha256: sha256(execFileSync("git", ["diff", "--binary"], { cwd: root })),
    files_sha256: Object.freeze(Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))]))),
  });
}

/** No request without an explicit --run, and a credential file named by an absolute path to a private file, never read here. */
export function assertExplicitRun(options) {
  if (!options.run) throw new Error("this evaluator makes no network request unless --run is explicit");
  if (typeof options.credentialFile !== "string" || !isAbsolute(options.credentialFile)) throw new Error("--credential-file must be an absolute private file path");
  // stat verifies that the supplied path exists without reading its contents.
  const credentialStat = statSync(options.credentialFile);
  if (!credentialStat.isFile()) throw new Error("--credential-file must name a file");
  if ((credentialStat.mode & 0o077) !== 0) throw new Error("--credential-file must not be readable by group or other users");
}
