import { canonicalJson } from "@echo-brain/federation-protocol";
import { initializeCleanResetState } from "./clean-reset-state.js";

export interface CleanResetCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const PROCESS_IO: CleanResetCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const USAGE =
  "usage: echo-organization-authority-init-clean-state " +
  "--state-dir <absolute-path> --organization-name <name> " +
  "--owner-display-name <name> --created-at <utc-millis> " +
  "--artifact-revision <revision>";

const FLAGS = [
  "--state-dir",
  "--organization-name",
  "--owner-display-name",
  "--created-at",
  "--artifact-revision",
] as const;

function parseFlags(
  arguments_: readonly string[],
): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      !FLAGS.includes(flag as (typeof FLAGS)[number]) ||
      value === undefined ||
      value.length === 0 ||
      parsed[flag] !== undefined
    ) {
      throw new Error(USAGE);
    }
    parsed[flag] = value;
  }
  if (Object.keys(parsed).length !== FLAGS.length) throw new Error(USAGE);
  return parsed;
}

/** The standalone stopped-state command. It has no legacy CLI/runtime import. */
export function runCleanResetCli(
  arguments_: readonly string[],
  io: CleanResetCliIo = PROCESS_IO,
): number {
  const flags = parseFlags(arguments_);
  const result = initializeCleanResetState({
    state_directory: flags["--state-dir"]!,
    organization_display_name: flags["--organization-name"]!,
    owner_display_name: flags["--owner-display-name"]!,
    created_at: flags["--created-at"]!,
    creating_artifact_revision: flags["--artifact-revision"]!,
  });
  io.stdout(`${canonicalJson(result as never)}\n`);
  return 0;
}
