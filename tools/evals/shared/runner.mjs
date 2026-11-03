/**
 * What the opt-in real-model evaluation runners share (agentic-ask, ask-follow-up, ask-wording and ask-blocks): the
 * report's hash, JSON, usage, safe-error and code-identity helpers, one generation through any model port and the
 * metadata a report keeps of it, integer bounds, the argv loop, the writer route (the OpenRouter bundle or the personal
 * Claude account), the private report directory, and the explicit --run and private credential-file checks made before
 * any request.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A generation's token counts: each a non-negative safe integer, else null; null for no usage at all. */
export function usage(value) {
  if (value === null || typeof value !== "object") return null;
  const integer = (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  return Object.freeze({ input_tokens: integer(value.input_tokens), output_tokens: integer(value.output_tokens), total_tokens: integer(value.total_tokens) });
}

/**
 * One structured generation as an observation (its value, finish reason, usage and provider latency), through whichever
 * method the port offers: its own observation; for a port that admits each outbound request (the personal Claude account
 * writer), every request admitted at once and the usage of all of them added up; or the bare value.
 */
export async function observedGeneration(structuredOutput, input) {
  if (typeof structuredOutput.generate_with_observation === "function") return structuredOutput.generate_with_observation(input);
  if (typeof structuredOutput.generate_with_admission !== "function") return { value: await structuredOutput.generate(input), finish_reason: null, usage: null, provider_latency_ms: null };
  const usages = [];
  let finishReason = null;
  const value = await structuredOutput.generate_with_admission(input, async (request, forward) => {
    const result = await forward(request.signal ?? AbortSignal.timeout(input.timeout_ms));
    usages.push(result.usage ?? null);
    finishReason = result.finish_reason ?? finishReason;
    return result.value;
  });
  const sum = (name) => usages.reduce((total, entry) => total + (Number.isSafeInteger(entry?.[name]) ? entry[name] : 0), 0);
  return { value, finish_reason: finishReason, usage: usages.every((entry) => entry === null) ? null : { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), total_tokens: sum("input_tokens") + sum("output_tokens") }, provider_latency_ms: null };
}

/** What a report keeps of an observed generation: its finish reason, its usage, and its provider latency when that is a safe integer; each else null. */
export const generationMetadata = (observed) => ({ finish_reason: observed.finish_reason ?? null, usage: usage(observed.usage),
  provider_latency_ms: Number.isSafeInteger(observed.provider_latency_ms) ? observed.provider_latency_ms : null });

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

/** The readFlags setters of a runner that writes through either route: --writer (openrouter or claude-account) and --claude-executable. */
export const writerFlags = (options) => ({
  "--writer": (value) => { if (value !== "openrouter" && value !== "claude-account") throw new Error("--writer must be openrouter or claude-account"); options.writer = value; },
  "--claude-executable": (value) => { options.claudeExecutable = value; },
});

/** With --writer claude-account, the signed-in claude binary is named by an absolute path that exists. */
export function assertWriterRoute(options) {
  if (options.writer === "claude-account" && (options.claudeExecutable === null || !isAbsolute(options.claudeExecutable) || !existsSync(options.claudeExecutable))) throw new Error("--writer claude-account needs --claude-executable, the absolute path of the signed-in claude binary");
}

/**
 * The route a run writes through and what it loaded (`structured_output` and `generation`): the bundle `createBundle`
 * makes from the credential file, or with --writer claude-account its personal Claude account writer, the product's own
 * path (providers/openrouter/src/claude-research), under `membershipId` with this machine's home directory and signed-in
 * claude binary. Native Claude Code owns the sign-in; nothing here reads it. `loaded`, a test's, replaces the bundle.
 */
export function writerRoute(options, membershipId, createBundle, loaded) {
  const route = options.writer ?? "openrouter";
  const bundled = loaded ?? createBundle({ credential_file: options.credentialFile,
    ...(route === "claude-account" ? { personal_claude_research: { membership_id: membershipId, home_directory: homedir(), executable_path: realpathSync(options.claudeExecutable) } } : {}) }).load();
  const writer = route === "claude-account" ? bundled.personal_research : bundled;
  if (writer === undefined) throw new Error("the claude-account writer is not available from this bundle");
  return Object.freeze({ route, loaded: writer });
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

/** A static import or re-export, or a dynamic import of a literal specifier. */
const IMPORTS = /(?:^|[\s;])(?:import|export)(?:\s+|(?=[{*"']))(?:[\w$*{},\s]+?from\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;

/**
 * Every repository module the modules `entries` (relative to `root`) load, themselves included, relative to `root` and in
 * a stable order, found by following their imports: relative ones and the workspaces' (`@echo-brain/`), never Node's own
 * or an installed package's. A report fingerprints the code that produced it, wherever it lives and whatever its files
 * are named.
 */
export function importedModules(root, entries) {
  const repository = realpathSync(root);
  const files = new Set();
  const visit = (url) => {
    const file = realpathSync(fileURLToPath(url));
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORTS)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith(".")) visit(new URL(specifier, pathToFileURL(file)));
      else if (specifier.startsWith("@echo-brain/")) visit(import.meta.resolve(specifier));
    }
  };
  for (const entry of entries) visit(pathToFileURL(join(repository, entry)));
  return Object.freeze([...files].map((file) => relative(repository, file).split(sep).join("/")).sort());
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
