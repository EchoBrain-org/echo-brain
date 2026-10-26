/**
 * What the opt-in real-model evaluation runners share (agentic-ask and ask-follow-up): the report's hash, JSON and usage
 * helpers, integer bounds, the argv loop, and the explicit --run and private credential-file checks made before any
 * request.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A generation's token counts: each a non-negative safe integer, else null; null for no usage at all. */
export function usage(value) {
  if (value === null || typeof value !== "object") return null;
  const integer = (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  return Object.freeze({ input_tokens: integer(value.input_tokens), output_tokens: integer(value.output_tokens), total_tokens: integer(value.total_tokens) });
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

/** No request without an explicit --run, and a credential file named by an absolute path to a private file, never read here. */
export function assertExplicitRun(options) {
  if (!options.run) throw new Error("this evaluator makes no network request unless --run is explicit");
  if (typeof options.credentialFile !== "string" || !isAbsolute(options.credentialFile)) throw new Error("--credential-file must be an absolute private file path");
  // stat verifies that the supplied path exists without reading its contents.
  const credentialStat = statSync(options.credentialFile);
  if (!credentialStat.isFile()) throw new Error("--credential-file must name a file");
  if ((credentialStat.mode & 0o077) !== 0) throw new Error("--credential-file must not be readable by group or other users");
}
