import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  runCleanPersonSlackApprovalActivateCli,
  runCleanSlackConnectCli,
} from "@echo-brain/organization-control-plane/clean-founder-v1";
import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import { initializeCleanResetState } from "./clean-reset-state.js";
import { runCleanGranolaSourceCli } from "./clean-granola-source-cli.js";
import { runCleanPersonCli } from "./clean-person-cli.js";

const MANIFEST_DIRECTORY = "onboarding";
const MANIFEST_FILENAME = "clean-founder-v1.json";
const INVITATION_FILENAME = "founder-person-invitation.json";
const GRANOLA_CREDENTIAL_FILENAME = "granola-credential";
const GRANOLA_OWNER_EMAIL_FILENAME = "granola-owner-email";
const LLM_CREDENTIAL_FILENAME = "llm-credential";
const SOURCE_INSTANCE_ID = "founder-granola-v1";
const PROCESSOR_INSTANCE_ID = "founder-llm-v1";
const DEFAULT_ARTIFACT_REVISION = "clean-founder-v1";

const USAGE = `usage:
  echo-organization-authority-clean-founder bootstrap --state-dir <absolute-path> --organization-name <name> --owner-display-name <name> --owner-email <email> --authority-url <https-origin> --oidc-config <absolute-json-path> --slack-approval-channel-id <id> [--artifact-revision <revision>] < slack-bot-token
  echo-organization-authority-clean-founder finalize --state-dir <absolute-path>`;

interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly read_stdin: () => Promise<string>;
}

const PROCESS_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  read_stdin: async () => {
    process.stdin.setEncoding("utf8");
    let result = "";
    for await (const chunk of process.stdin) result += chunk;
    return result;
  },
};

export interface CleanFounderOnboardingManifestV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-founder-onboarding-manifest-v1";
  readonly state_directory: string;
  readonly created_at: string;
  readonly artifact_revision: string;
  readonly authority_url: string;
  readonly oidc_config_path: string;
  readonly pkce_key_file: string;
  readonly invitation_path: string;
  readonly slack_approval_channel_id: string;
  readonly slack_connection_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
  readonly llm_credential_file: string;
}

interface BootstrapInput {
  readonly state_directory: string;
  readonly organization_name: string;
  readonly owner_display_name: string;
  readonly owner_email: string;
  readonly authority_url: string;
  readonly oidc_config_path: string;
  readonly slack_approval_channel_id: string;
  readonly artifact_revision: string;
}

interface FinalizeInput {
  readonly state_directory: string;
}

interface ConnectedSlack {
  readonly connection_id: string;
}

export interface CleanFounderCliDependencies {
  readonly now: () => string;
  readonly reset: typeof initializeCleanResetState;
  readonly initialize_credentials: (stateDirectory: string) => Promise<void>;
  readonly connect_slack: (input: {
    readonly state_directory: string;
    readonly approval_channel_id: string;
    readonly read_stdin: () => Promise<string>;
  }) => Promise<ConnectedSlack>;
  readonly issue_invitation: (input: {
    readonly state_directory: string;
    readonly oidc_config_path: string;
    readonly pkce_key_file: string;
    readonly membership_id: string;
    readonly expected_email: string;
    readonly authority_url: string;
    readonly output_path: string;
  }) => Promise<void>;
  readonly activate_approval: (input: {
    readonly state_directory: string;
    readonly connection_id: string;
    readonly approval_channel_id: string;
  }) => Promise<void>;
  readonly admit_source: (input: {
    readonly state_directory: string;
    readonly granola_credential_file: string;
    readonly granola_owner_email_file: string;
    readonly llm_credential_file: string;
  }) => Promise<void>;
}

function captureCommand(
  run: (stdout: (value: string) => void) => number | Promise<number>,
): Promise<Record<string, unknown>> {
  let output = "";
  return Promise.resolve(run((value) => (output += value))).then((status) => {
    if (status !== 0)
      throw new Error("clean founder stopped-state command failed");
    try {
      return JSON.parse(output) as Record<string, unknown>;
    } catch {
      throw new Error(
        "clean founder stopped-state command returned invalid JSON",
      );
    }
  });
}

const DEFAULT_DEPENDENCIES: CleanFounderCliDependencies = {
  now: () => new Date().toISOString(),
  reset: initializeCleanResetState,
  initialize_credentials: async (stateDirectory) => {
    await captureCommand((stdout) =>
      runCleanPersonCli(["credentials-init", "--state-dir", stateDirectory], {
        stdout,
        stderr: () => undefined,
      }),
    );
  },
  connect_slack: async (input) => {
    const result = await captureCommand((stdout) =>
      runCleanSlackConnectCli(
        [
          "--state-dir",
          input.state_directory,
          "--approval-channel-id",
          input.approval_channel_id,
        ],
        { stdout, read_stdin: input.read_stdin },
      ),
    );
    if (typeof result.connection_id !== "string") {
      throw new Error("clean Slack connection did not return a connection ID");
    }
    return Object.freeze({ connection_id: result.connection_id });
  },
  issue_invitation: async (input) => {
    await captureCommand((stdout) =>
      runCleanPersonCli(
        [
          "invite",
          "--state-dir",
          input.state_directory,
          "--oidc-config",
          input.oidc_config_path,
          "--pkce-key-file",
          input.pkce_key_file,
          "--membership-id",
          input.membership_id,
          "--expected-email",
          input.expected_email,
          "--authority-url",
          input.authority_url,
          "--out",
          input.output_path,
        ],
        { stdout, stderr: () => undefined },
      ),
    );
  },
  activate_approval: async (input) => {
    await captureCommand((stdout) =>
      runCleanPersonSlackApprovalActivateCli(
        [
          "--state-dir",
          input.state_directory,
          "--connection-id",
          input.connection_id,
          "--approval-channel-id",
          input.approval_channel_id,
        ],
        { stdout },
      ),
    );
  },
  admit_source: async (input) => {
    await captureCommand((stdout) =>
      runCleanGranolaSourceCli(
        [
          "--state-dir",
          input.state_directory,
          "--source-instance",
          SOURCE_INSTANCE_ID,
          "--processor-instance",
          PROCESSOR_INSTANCE_ID,
          "--granola-credential-file",
          input.granola_credential_file,
          "--granola-owner-email-file",
          input.granola_owner_email_file,
          "--llm-credential-file",
          input.llm_credential_file,
        ],
        { stdout, stderr: () => undefined },
      ),
    );
  },
};

function absolutePath(value: string, label: string): string {
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve("/")
  ) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  return value;
}

function parseBootstrap(arguments_: readonly string[]): BootstrapInput {
  const accepted = new Set([
    "--state-dir",
    "--organization-name",
    "--owner-display-name",
    "--owner-email",
    "--authority-url",
    "--oidc-config",
    "--slack-approval-channel-id",
    "--artifact-revision",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      value.length === 0 ||
      !accepted.has(key) ||
      values.has(key)
    ) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(USAGE);
    return value;
  };
  const ownerEmail = required("--owner-email");
  if (!isCanonicalPersonEmail(ownerEmail)) {
    throw new Error("--owner-email must be a canonical lowercase email");
  }
  return Object.freeze({
    state_directory: absolutePath(required("--state-dir"), "state directory"),
    organization_name: required("--organization-name"),
    owner_display_name: required("--owner-display-name"),
    owner_email: ownerEmail,
    authority_url: required("--authority-url"),
    oidc_config_path: absolutePath(required("--oidc-config"), "OIDC config"),
    slack_approval_channel_id: required("--slack-approval-channel-id"),
    artifact_revision:
      values.get("--artifact-revision") ?? DEFAULT_ARTIFACT_REVISION,
  });
}

function parseFinalize(arguments_: readonly string[]): FinalizeInput {
  if (arguments_.length !== 2 || arguments_[0] !== "--state-dir") {
    throw new Error(USAGE);
  }
  return Object.freeze({
    state_directory: absolutePath(arguments_[1] ?? "", "state directory"),
  });
}

function manifestPath(stateDirectory: string): string {
  return join(stateDirectory, MANIFEST_DIRECTORY, MANIFEST_FILENAME);
}

function writeManifest(manifest: CleanFounderOnboardingManifestV1): void {
  const path = manifestPath(manifest.state_directory);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${canonicalJson(manifest as never)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function validateManifest(value: unknown): CleanFounderOnboardingManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("clean founder onboarding manifest is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "artifact_revision",
    "authority_id",
    "authority_url",
    "created_at",
    "granola_credential_file",
    "granola_owner_email_file",
    "invitation_path",
    "kind",
    "llm_credential_file",
    "oidc_config_path",
    "organization_id",
    "owner_membership_id",
    "owner_principal_id",
    "pkce_key_file",
    "schema_version",
    "slack_approval_channel_id",
    "slack_connection_id",
    "state_directory",
    "state_lineage_id",
  ];
  if (
    record.schema_version !== 1 ||
    record.kind !== "echo-clean-founder-onboarding-manifest-v1" ||
    Object.keys(record).sort().join(",") !== keys.join(",") ||
    keys
      .filter((key) => key !== "schema_version")
      .some((key) => typeof record[key] !== "string")
  ) {
    throw new Error("clean founder onboarding manifest is invalid");
  }
  const manifest = record as unknown as CleanFounderOnboardingManifestV1;
  for (const path of [
    manifest.state_directory,
    manifest.oidc_config_path,
    manifest.pkce_key_file,
    manifest.invitation_path,
    manifest.granola_credential_file,
    manifest.granola_owner_email_file,
    manifest.llm_credential_file,
  ]) {
    absolutePath(path, "clean founder manifest path");
  }
  if (
    `${canonicalJson(manifest as never)}\n` !==
    readFileSync(manifestPath(manifest.state_directory), "utf8")
  ) {
    throw new Error(
      "clean founder onboarding manifest is not canonically encoded",
    );
  }
  return Object.freeze(manifest);
}

export function readCleanFounderOnboardingManifest(
  stateDirectory: string,
): CleanFounderOnboardingManifestV1 {
  const canonicalStateDirectory = absolutePath(
    stateDirectory,
    "state directory",
  );
  const path = manifestPath(canonicalStateDirectory);
  const metadata = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUid !== undefined && metadata.uid !== currentUid) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "clean founder onboarding manifest must be current-user 0600",
    );
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) {
    throw new Error("clean founder onboarding manifest is invalid");
  }
  const manifest = validateManifest(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
  if (manifest.state_directory !== canonicalStateDirectory) {
    throw new Error(
      "clean founder onboarding manifest belongs to another state directory",
    );
  }
  return manifest;
}

async function bootstrap(
  input: BootstrapInput,
  io: CliIo,
  dependencies: CleanFounderCliDependencies,
): Promise<void> {
  const createdAt = dependencies.now();
  const reset = dependencies.reset({
    state_directory: input.state_directory,
    organization_display_name: input.organization_name,
    owner_display_name: input.owner_display_name,
    created_at: createdAt,
    creating_artifact_revision: input.artifact_revision,
  });
  await dependencies.initialize_credentials(input.state_directory);
  const slack = await dependencies.connect_slack({
    state_directory: input.state_directory,
    approval_channel_id: input.slack_approval_channel_id,
    read_stdin: io.read_stdin,
  });
  const credentialsDirectory = join(input.state_directory, "credentials");
  const invitationPath = join(
    input.state_directory,
    MANIFEST_DIRECTORY,
    INVITATION_FILENAME,
  );
  const manifest: CleanFounderOnboardingManifestV1 = Object.freeze({
    schema_version: 1,
    kind: "echo-clean-founder-onboarding-manifest-v1",
    state_directory: input.state_directory,
    created_at: createdAt,
    artifact_revision: input.artifact_revision,
    authority_url: input.authority_url,
    oidc_config_path: input.oidc_config_path,
    pkce_key_file: join(
      credentialsDirectory,
      "person-session-pkce-sealing-key",
    ),
    invitation_path: invitationPath,
    slack_approval_channel_id: input.slack_approval_channel_id,
    slack_connection_id: slack.connection_id,
    authority_id: reset.authority_id,
    organization_id: reset.organization_id,
    state_lineage_id: reset.state_lineage_id,
    owner_principal_id: reset.owner_principal_id,
    owner_membership_id: reset.owner_membership_id,
    granola_credential_file: join(
      credentialsDirectory,
      GRANOLA_CREDENTIAL_FILENAME,
    ),
    granola_owner_email_file: join(
      credentialsDirectory,
      GRANOLA_OWNER_EMAIL_FILENAME,
    ),
    llm_credential_file: join(credentialsDirectory, LLM_CREDENTIAL_FILENAME),
  });
  // The manifest is non-secret and intentionally written before the invitation:
  // the one-time 15-minute invitation is the final bootstrap operation.
  writeManifest(manifest);
  await dependencies.issue_invitation({
    state_directory: input.state_directory,
    oidc_config_path: input.oidc_config_path,
    pkce_key_file: manifest.pkce_key_file,
    membership_id: reset.owner_membership_id,
    expected_email: input.owner_email,
    authority_url: input.authority_url,
    output_path: invitationPath,
  });
  io.stdout(
    `${canonicalJson({
      ok: true,
      invitation_path: invitationPath,
      next_instruction:
        "Start echo-organization-authority-clean-live serve, then run: echo-brain person login --invitation <invitation_path>.",
    } as never)}\n`,
  );
}

async function finalize(
  input: FinalizeInput,
  io: CliIo,
  dependencies: CleanFounderCliDependencies,
): Promise<void> {
  const manifest = readCleanFounderOnboardingManifest(input.state_directory);
  await dependencies.activate_approval({
    state_directory: manifest.state_directory,
    connection_id: manifest.slack_connection_id,
    approval_channel_id: manifest.slack_approval_channel_id,
  });
  await dependencies.admit_source({
    state_directory: manifest.state_directory,
    granola_credential_file: manifest.granola_credential_file,
    granola_owner_email_file: manifest.granola_owner_email_file,
    llm_credential_file: manifest.llm_credential_file,
  });
  io.stdout(
    `${canonicalJson({
      ok: true,
      next_instruction:
        "Restart the same echo-organization-authority-clean-live serve command. The clean Granola source begins at its live-only cutoff.",
    } as never)}\n`,
  );
}

export async function runCleanFounderCli(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
  dependencies: CleanFounderCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  try {
    if (argv[0] === "bootstrap") {
      await bootstrap(parseBootstrap(argv.slice(1)), io, dependencies);
      return 0;
    }
    if (argv[0] === "finalize") {
      await finalize(parseFinalize(argv.slice(1)), io, dependencies);
      return 0;
    }
    throw new Error(USAGE);
  } catch (error) {
    io.stderr(
      `${error instanceof Error ? error.message : "clean founder command failed"}\n`,
    );
    return 1;
  }
}
