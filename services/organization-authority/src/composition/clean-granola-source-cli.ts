import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  HttpGranolaApiClient,
  type GranolaRecordOwnerObservationClient,
} from "../processing/adapters/meeting-sources/granola/index.js";
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

export interface CleanGranolaSourceCliDependencies {
  createGranolaRecordOwnerClient(
    credential: string,
  ): GranolaRecordOwnerObservationClient;
}

const PROCESS_IO: CleanGranolaSourceCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const DEFAULT_DEPENDENCIES: CleanGranolaSourceCliDependencies = {
  createGranolaRecordOwnerClient: (credential) =>
    new HttpGranolaApiClient(credential),
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
export async function runCleanGranolaSourceCli(
  arguments_: readonly string[],
  io: CleanGranolaSourceCliIo = PROCESS_IO,
  dependencies: CleanGranolaSourceCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const flags = parseFlags(arguments_);
  const granolaCredentialReference = `file:${flags["--granola-credential-file"]}`;
  const result = await admitCleanGranolaSource({
    state_directory: flags["--state-dir"],
    source_instance_id: flags["--source-instance"],
    processor_instance_id: flags["--processor-instance"],
    granola_credential_reference: granolaCredentialReference,
    granola_owner_email_reference: `file:${flags["--granola-owner-email-file"]}`,
    llm_credential_reference: `file:${flags["--llm-credential-file"]}`,
    create_granola_record_owner_client:
      dependencies.createGranolaRecordOwnerClient,
  });
  io.stdout(
    `${canonicalJson({
      schema_version: 1,
      kind: "echo-clean-granola-source-admission-status-v1",
      outcome: result.outcome,
      owner_observed_at: result.source.cutoff_at,
    } as never)}\n`,
  );
  return 0;
}
