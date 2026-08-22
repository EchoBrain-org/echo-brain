import { canonicalJson } from "@echo-brain/federation-protocol";
import { admitCleanGranolaSource } from "./clean-granola-source-admission.js";

const USAGE =
  "usage: echo-organization-authority-admit-clean-granola-source " +
  "--state-dir <absolute-path> --source-instance <id> --processor-instance <id> " +
  "--granola-credential-file <absolute-path> --granola-owner-email-file <absolute-path> " +
  "--llm-credential-file <absolute-path>";

const FLAGS = [
  "--state-dir",
  "--source-instance",
  "--processor-instance",
  "--granola-credential-file",
  "--granola-owner-email-file",
  "--llm-credential-file",
] as const;

export interface CleanGranolaSourceCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const PROCESS_IO: CleanGranolaSourceCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function parseFlags(
  arguments_: readonly string[],
): Readonly<Record<(typeof FLAGS)[number], string>> {
  const parsed: Partial<Record<(typeof FLAGS)[number], string>> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !FLAGS.includes(flag as (typeof FLAGS)[number]) ||
      value.length === 0 ||
      parsed[flag as (typeof FLAGS)[number]] !== undefined
    ) {
      throw new Error(USAGE);
    }
    parsed[flag as (typeof FLAGS)[number]] = value;
  }
  if (Object.keys(parsed).length !== FLAGS.length) throw new Error(USAGE);
  return parsed as Readonly<Record<(typeof FLAGS)[number], string>>;
}

/** Dedicated stopped-state CLI. It accepts file paths, never secret values. */
export function runCleanGranolaSourceCli(
  arguments_: readonly string[],
  io: CleanGranolaSourceCliIo = PROCESS_IO,
): number {
  const flags = parseFlags(arguments_);
  const result = admitCleanGranolaSource({
    state_directory: flags["--state-dir"],
    source_instance_id: flags["--source-instance"],
    processor_instance_id: flags["--processor-instance"],
    granola_credential_reference: `file:${flags["--granola-credential-file"]}`,
    granola_owner_email_reference: `file:${flags["--granola-owner-email-file"]}`,
    llm_credential_reference: `file:${flags["--llm-credential-file"]}`,
  });
  io.stdout(`${canonicalJson(result as never)}\n`);
  return 0;
}
