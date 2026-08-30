import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  assertFederationId,
  canonicalJson,
  federationId,
} from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import {
  runCleanSlackConnectCli,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
} from "@echo-brain/organization-control-plane/clean-founder-v1";
import { assertDisplayName } from "../domain/rules.js";
import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../adapters/security/private-file-credentials.js";
import {
  readPrivateAuthorityCredential,
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
} from "../adapters/security/private-file-credentials.js";
import {
  initializeAuthorityState,
  type AuthorityStateSeedV1,
} from "./authority-state-initializer.js";
import { runCleanGranolaSourceCli } from "./clean-granola-source-cli.js";
import { readableSearchRuntimeContractV1 } from "./readable-search-runtime.js";
import {
  assertCleanPersonAuthorityCallback,
  readCleanPersonOidcConfiguration,
  runCleanPersonCli,
} from "./clean-person-cli.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";

const MANIFEST_DIRECTORY = "onboarding";
const MANIFEST_FILENAME = "clean-founder-v1.json";
const SETUP_PLAN_SUFFIX = ".clean-founder-setup-plan-v1.json";
const INVITATION_FILENAME = "founder-person-invitation.json";
const GRANOLA_CREDENTIAL_FILENAME = "granola-credential";
const GRANOLA_OWNER_EMAIL_FILENAME = "granola-owner-email";
const LLM_CREDENTIAL_FILENAME = "llm-credential";
const SOURCE_INSTANCE_ID = "founder-granola-v1";
const PROCESSOR_INSTANCE_ID = "founder-llm-v1";
const DEFAULT_ARTIFACT_REVISION = "clean-founder-v1";

const USAGE = `usage:
  echo-organization-authority-clean-founder bootstrap --state-dir <absolute-path> --organization-name <name> --owner-display-name <name> --owner-email <email> --authority-url <https-origin> --oidc-config <absolute-json-path> --slack-approval-channel-id <id> [--artifact-revision <revision>] < slack-bot-token
  echo-organization-authority-clean-founder resume --state-dir <absolute-path> < slack-bot-token
  echo-organization-authority-clean-founder credentials-install --state-dir <absolute-path> --granola-credential-file <absolute-private-path> --granola-owner-email-file <absolute-private-path> --llm-credential-file <absolute-private-path>
  echo-organization-authority-clean-founder finalize --state-dir <absolute-path>
  echo-organization-authority-clean-founder status --state-dir <absolute-path>

The legacy --slack-approval-channel-id flag names the temporary public initial-owner
identity-link channel only. Private approval cards are never sent to it.`;

// The remaining `clean-founder` filenames, command paths, instance IDs, wire
// kinds, status fields, and next-step literals are frozen V1 compatibility
// vocabulary. They do not name this component or limit setup to a founder.

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

export interface OrganizationAuthoritySetupSeedV1 extends AuthorityStateSeedV1 {
  readonly slack_connection_id: string;
}

export interface OrganizationAuthoritySetupManifestV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-founder-onboarding-manifest-v1";
  readonly state_directory: string;
  readonly created_at: string;
  readonly artifact_revision: string;
  readonly authority_url: string;
  readonly oidc_config_path: string;
  readonly pkce_key_file: string;
  readonly invitation_path: string;
  /**
   * Transitional field name. This public channel exists only for the current
   * initial-owner Person-to-Slack identity-link challenge. It is never an approval
   * destination, approval binding, or approval-readiness gate.
   */
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
  readonly setup_seed: OrganizationAuthoritySetupSeedV1;
  readonly owner_email: string;
  readonly organization_name: string;
  readonly owner_display_name: string;
}

interface BootstrapInput {
  readonly state_directory: string;
  readonly organization_name: string;
  readonly owner_display_name: string;
  readonly owner_email: string;
  readonly authority_url: string;
  readonly oidc_config_path: string;
  /** Transitional identity-link-only channel argument; see manifest field. */
  readonly slack_approval_channel_id: string;
  readonly artifact_revision: string;
}

interface FinalizeInput {
  readonly state_directory: string;
}

interface CredentialInstallInput extends FinalizeInput {
  readonly granola_credential_source: string;
  readonly granola_owner_email_source: string;
  readonly llm_credential_source: string;
}

interface SafeSlackVerification {
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly app_id: string;
  readonly bot_id: string;
  readonly bot_user_id: string;
  /** Temporary public channel used solely by initial-owner identity linking. */
  readonly identity_link_channel_id: string;
  readonly required_scopes: readonly string[];
  readonly identity_link_channel_access: "verified";
  readonly selected_channel_public: true;
  readonly selected_channel_active: true;
  readonly bot_membership_verified: true;
  readonly bot_access_verified: true;
  readonly verified_at: string;
}

interface ConnectedSlack {
  readonly connection_id: string;
  readonly verification?: SafeSlackVerification;
}

interface OrganizationAuthoritySetupStage {
  readonly credentials_ready: boolean;
  readonly slack_connected: boolean;
  readonly invitation_file_present: boolean;
}

export interface OrganizationAuthoritySetupCliDependencies {
  readonly now: () => string;
  readonly initialize_state: typeof initializeAuthorityState;
  readonly initialize_credentials: (stateDirectory: string) => Promise<void>;
  readonly connect_slack: (input: {
    readonly state_directory: string;
    /** Legacy adapter name for the temporary initial-owner identity-link channel. */
    readonly approval_channel_id: string;
    readonly connection_id?: string;
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
  readonly admit_source: (input: {
    readonly state_directory: string;
    readonly granola_credential_file: string;
    readonly granola_owner_email_file: string;
    readonly llm_credential_file: string;
  }) => Promise<void>;
  /** Test seam only; production derives these facts from durable state. */
  readonly read_initial_owner_setup_status?: (
    manifest: OrganizationAuthoritySetupManifestV1,
  ) => InitialOwnerSetupStatus;
  /** Test seam only; production derives this from immutable state. */
  readonly read_setup_canary_evidence?: (
    manifest: OrganizationAuthoritySetupManifestV1,
  ) => SetupCanaryEvidence;
  /** Test seam only; production derives these facts from durable state. */
  readonly read_setup_stage?: (
    manifest: OrganizationAuthoritySetupManifestV1,
  ) => OrganizationAuthoritySetupStage;
}

function captureCommand(
  run: (stdout: (value: string) => void) => number | Promise<number>,
): Promise<Record<string, unknown>> {
  let output = "";
  return Promise.resolve(run((value) => (output += value))).then((status) => {
    if (status !== 0)
      throw new Error("organization setup stopped-state command failed");
    try {
      return JSON.parse(output) as Record<string, unknown>;
    } catch {
      throw new Error(
        "organization setup stopped-state command returned invalid JSON",
      );
    }
  });
}

const DEFAULT_DEPENDENCIES: OrganizationAuthoritySetupCliDependencies = {
  now: () => new Date().toISOString(),
  initialize_state: initializeAuthorityState,
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
          ...(input.connection_id === undefined
            ? []
            : ["--connection-id", input.connection_id]),
        ],
        { stdout, read_stdin: input.read_stdin },
      ),
    );
    for (const field of [
      "provider_tenant_id",
      "provider_app_id",
      "provider_bot_id",
      "provider_bot_user_id",
      "approval_channel_id",
      "verified_at",
    ] as const) {
      if (typeof result[field] !== "string") {
        throw new Error("clean Slack connection did not return safe verification details");
      }
    }
    if (
      result.provider_enterprise_id !== null &&
      typeof result.provider_enterprise_id !== "string"
    ) {
      throw new Error("clean Slack connection did not return safe verification details");
    }
    if (
      !Array.isArray(result.required_scopes) ||
      result.required_scopes.length !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.length ||
      result.required_scopes.some(
        (scope, index) => scope !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES[index],
      ) ||
      result.selected_channel_public !== true ||
      result.selected_channel_active !== true ||
      result.bot_membership_verified !== true ||
      result.bot_access_verified !== true
    ) {
      throw new Error("clean Slack connection did not return complete channel verification");
    }
    if (input.connection_id === undefined) {
      throw new Error(
        "organization setup Slack connection requires a planned connection ID",
      );
    }
    return Object.freeze({
      connection_id: input.connection_id,
      verification: Object.freeze({
        workspace_id: result.provider_tenant_id as string,
        enterprise_id: result.provider_enterprise_id as string | null,
        app_id: result.provider_app_id as string,
        bot_id: result.provider_bot_id as string,
        bot_user_id: result.provider_bot_user_id as string,
        identity_link_channel_id: result.approval_channel_id as string,
        required_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
        identity_link_channel_access: "verified" as const,
        selected_channel_public: true,
        selected_channel_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
        verified_at: result.verified_at as string,
      }),
    });
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
  const parsed = Object.freeze({
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
  assertDisplayName(parsed.organization_name);
  assertDisplayName(parsed.owner_display_name);
  validateOrganizationAuthorityOrigin(parsed.authority_url);
  return parsed;
}

function parseFinalize(arguments_: readonly string[]): FinalizeInput {
  if (arguments_.length !== 2 || arguments_[0] !== "--state-dir") {
    throw new Error(USAGE);
  }
  return Object.freeze({
    state_directory: absolutePath(arguments_[1] ?? "", "state directory"),
  });
}

function parseCredentialInstall(
  arguments_: readonly string[],
): CredentialInstallInput {
  const accepted = new Set([
    "--state-dir",
    "--granola-credential-file",
    "--granola-owner-email-file",
    "--llm-credential-file",
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
  const source = (key: string, label: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(USAGE);
    return absolutePath(value, label);
  };
  return Object.freeze({
    state_directory: source("--state-dir", "state directory"),
    granola_credential_source: source(
      "--granola-credential-file",
      "Granola credential source",
    ),
    granola_owner_email_source: source(
      "--granola-owner-email-file",
      "Granola owner email source",
    ),
    llm_credential_source: source(
      "--llm-credential-file",
      "LLM credential source",
    ),
  });
}

function manifestPath(stateDirectory: string): string {
  return join(stateDirectory, MANIFEST_DIRECTORY, MANIFEST_FILENAME);
}

function siblingSetupPlanPath(stateDirectory: string): string {
  return `${stateDirectory}${SETUP_PLAN_SUFFIX}`;
}

function writeCanonicalPrivateFile(
  path: string,
  value: OrganizationAuthoritySetupManifestV1,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.installing-${randomUUID()}`;
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${canonicalJson(value as never)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    // link(2) is an exclusive no-clobber publish: unlike rename it cannot
    // overwrite another concurrent setup plan at the final path.
    linkSync(temporaryPath, path);
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    unlinkSync(temporaryPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
}

function assertSetupSeed(seed: OrganizationAuthoritySetupSeedV1): void {
  try {
    assertFederationId(seed.authority_id, "oau", "setup authority_id");
    assertFederationId(seed.organization_id, "org", "setup organization_id");
    assertFederationId(seed.owner_principal_id, "prn", "setup owner_principal_id");
    assertFederationId(seed.owner_membership_id, "mem", "setup owner_membership_id");
    assertFederationId(seed.slack_connection_id, "con", "setup slack_connection_id");
  } catch {
    throw new Error("organization setup seed is invalid");
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (
    !new RegExp(`^lineage-${uuid}$`).test(seed.state_lineage_id) ||
    !new RegExp(`^ocp_${uuid}$`).test(seed.control_plane_id)
  ) {
    throw new Error("organization setup seed is invalid");
  }
}

function validateManifest(value: unknown): OrganizationAuthoritySetupManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("organization setup manifest is invalid");
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
  const currentKeys = [
    ...keys,
    "organization_name",
    "owner_display_name",
    "owner_email",
    "setup_seed",
  ];
  const actualKeys = Object.keys(record).sort().join(",");
  if (
    record.schema_version !== 1 ||
    record.kind !== "echo-clean-founder-onboarding-manifest-v1" ||
    actualKeys !== currentKeys.sort().join(",") ||
    keys
      .filter((key) => key !== "schema_version")
      .some((key) => typeof record[key] !== "string")
  ) {
    throw new Error("organization setup manifest is invalid");
  }
  const manifest = record as unknown as OrganizationAuthoritySetupManifestV1;
  if (
    !isCanonicalPersonEmail(manifest.owner_email) ||
    typeof manifest.organization_name !== "string" ||
    typeof manifest.owner_display_name !== "string" ||
    manifest.setup_seed === undefined
  ) {
    throw new Error("organization setup manifest is invalid");
  }
  assertSetupSeed(manifest.setup_seed);
  for (const path of [
    manifest.state_directory,
    manifest.oidc_config_path,
    manifest.pkce_key_file,
    manifest.invitation_path,
    manifest.granola_credential_file,
    manifest.granola_owner_email_file,
    manifest.llm_credential_file,
  ]) {
    absolutePath(path, "organization setup manifest path");
  }
  return Object.freeze(manifest);
}

function readPrivateManifest(path: string): OrganizationAuthoritySetupManifestV1 {
  const metadata = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUid !== undefined && metadata.uid !== currentUid) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "organization setup manifest must be current-user 0600",
    );
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) {
    throw new Error("organization setup manifest is invalid");
  }
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  if (`${canonicalJson(manifest as never)}\n` !== bytes.toString("utf8")) {
    throw new Error(
      "organization setup manifest is not canonically encoded",
    );
  }
  return manifest;
}

export function readOrganizationAuthoritySetupManifest(
  stateDirectory: string,
): OrganizationAuthoritySetupManifestV1 {
  const canonicalStateDirectory = absolutePath(
    stateDirectory,
    "state directory",
  );
  const manifest = readPrivateManifest(manifestPath(canonicalStateDirectory));
  if (manifest.state_directory !== canonicalStateDirectory) {
    throw new Error(
      "organization setup manifest belongs to another state directory",
    );
  }
  return manifest;
}

function setupManifest(
  input: BootstrapInput,
  createdAt: string,
): OrganizationAuthoritySetupManifestV1 {
  const credentialsDirectory = join(input.state_directory, "credentials");
  const seed: OrganizationAuthoritySetupSeedV1 = Object.freeze({
    authority_id: federationId("oau"),
    organization_id: federationId("org"),
    state_lineage_id: `lineage-${randomUUID()}`,
    owner_principal_id: federationId("prn"),
    owner_membership_id: federationId("mem"),
    control_plane_id: `ocp_${randomUUID()}`,
    slack_connection_id: federationId("con"),
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-founder-onboarding-manifest-v1",
    state_directory: input.state_directory,
    created_at: createdAt,
    artifact_revision: input.artifact_revision,
    authority_url: input.authority_url,
    oidc_config_path: input.oidc_config_path,
    pkce_key_file: join(credentialsDirectory, "person-session-pkce-sealing-key"),
    invitation_path: join(input.state_directory, MANIFEST_DIRECTORY, INVITATION_FILENAME),
    slack_approval_channel_id: input.slack_approval_channel_id,
    slack_connection_id: seed.slack_connection_id,
    authority_id: seed.authority_id,
    organization_id: seed.organization_id,
    state_lineage_id: seed.state_lineage_id,
    owner_principal_id: seed.owner_principal_id,
    owner_membership_id: seed.owner_membership_id,
    granola_credential_file: join(credentialsDirectory, GRANOLA_CREDENTIAL_FILENAME),
    granola_owner_email_file: join(credentialsDirectory, GRANOLA_OWNER_EMAIL_FILENAME),
    llm_credential_file: join(credentialsDirectory, LLM_CREDENTIAL_FILENAME),
    organization_name: input.organization_name,
    owner_display_name: input.owner_display_name,
    owner_email: input.owner_email,
    setup_seed: seed,
  });
}

function setupInputMatches(
  manifest: OrganizationAuthoritySetupManifestV1,
  input: BootstrapInput,
): boolean {
  return (
    manifest.organization_name === input.organization_name &&
    manifest.owner_display_name === input.owner_display_name &&
    manifest.owner_email === input.owner_email &&
    manifest.authority_url === input.authority_url &&
    manifest.oidc_config_path === input.oidc_config_path &&
    manifest.slack_approval_channel_id === input.slack_approval_channel_id &&
    manifest.artifact_revision === input.artifact_revision
  );
}

function loadSetupManifest(stateDirectory: string): {
  readonly manifest: OrganizationAuthoritySetupManifestV1;
  readonly location: "sibling" | "state";
} | undefined {
  const sibling = siblingSetupPlanPath(stateDirectory);
  const state = manifestPath(stateDirectory);
  if (!existsSync(sibling) && !existsSync(state)) return undefined;
  const siblingManifest = existsSync(sibling) ? readPrivateManifest(sibling) : undefined;
  const stateManifest = existsSync(state) ? readPrivateManifest(state) : undefined;
  if (
    siblingManifest !== undefined &&
    stateManifest !== undefined &&
    canonicalJson(siblingManifest as never) !== canonicalJson(stateManifest as never)
  ) {
    throw new Error("organization setup has conflicting durable plans");
  }
  const manifest = stateManifest ?? siblingManifest!;
  if (manifest.state_directory !== stateDirectory) {
    throw new Error(
      "organization setup plan belongs to another state directory",
    );
  }
  return Object.freeze({
    manifest,
    location: stateManifest === undefined ? "sibling" : "state",
  });
}

function verifySetupGenesis(manifest: OrganizationAuthoritySetupManifestV1): void {
  const verified = verifyCleanStateLineage(manifest.state_directory);
  if (
    verified.root.authority_id !== manifest.setup_seed.authority_id ||
    verified.root.organization_id !== manifest.setup_seed.organization_id ||
    verified.root.state_lineage_id !== manifest.setup_seed.state_lineage_id
  ) {
    throw new Error(
      "organization setup plan does not match published genesis",
    );
  }
}

function publishSetupPlan(manifest: OrganizationAuthoritySetupManifestV1): void {
  const source = siblingSetupPlanPath(manifest.state_directory);
  const destination = manifestPath(manifest.state_directory);
  if (existsSync(destination)) return;
  if (!existsSync(source)) {
    throw new Error("organization setup plan is missing");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(source, destination);
  const parent = openSync(dirname(destination), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function privateFilePresent(path: string, minimumBytes = 1): boolean {
  try {
    const metadata = lstatSync(path);
    const currentUid = process.getuid?.();
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size >= minimumBytes &&
      metadata.size <= 16 * 1024 &&
      (currentUid === undefined || metadata.uid === currentUid) &&
      (metadata.mode & 0o777) === 0o600
    );
  } catch {
    return false;
  }
}

function installPrivateCredentialValue(path: string, value: string): void {
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  const currentUid = process.getuid?.();
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (currentUid !== undefined && parent.uid !== currentUid) ||
    (parent.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "organization setup credential destination must have a current-user 0700 parent",
    );
  }
  const temporaryPath = `${path}.installing-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    const parentDescriptor = openSync(parentPath, constants.O_RDONLY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
}

function validPkceKeyPresent(path: string): boolean {
  try {
    readPrivateAuthorityPersonSessionPkceKey(`file:${path}`);
    return true;
  } catch {
    return false;
  }
}

function sha256Secret(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function usableInitialOwnerInvitation(
  manifest: OrganizationAuthoritySetupManifestV1,
): boolean {
  try {
    const path = manifest.invitation_path;
    if (!privateFilePresent(path)) return false;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "authority_url,expires_at,kind,login_grant,schema_version" ||
      `${canonicalJson(parsed as never)}\n` !== raw
    ) return false;
    const invitation = parsed as {
      schema_version: unknown;
      kind: unknown;
      authority_url: unknown;
      login_grant: unknown;
      expires_at: unknown;
    };
    if (
      invitation.schema_version !== 1 ||
      invitation.kind !== "echo-person-onboarding-invitation" ||
      invitation.authority_url !== manifest.authority_url ||
      typeof invitation.login_grant !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(invitation.login_grant) ||
      typeof invitation.expires_at !== "string" ||
      new Date(invitation.expires_at).toISOString() !== invitation.expires_at ||
      invitation.expires_at <= new Date().toISOString()
    ) return false;
    const database = new Database(join(manifest.state_directory, "authority.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return database.prepare(
        `SELECT 1 FROM authority_person_login_grants
          WHERE login_grant_sha256 = ? AND organization_id = ?
            AND principal_id = ? AND membership_id = ? AND membership_type = 'owner'
            AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
          LIMIT 1`,
      ).get(
        sha256Secret(invitation.login_grant),
        manifest.organization_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
        new Date().toISOString(),
      ) !== undefined;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function discardUnusableInvitation(path: string): void {
  if (!existsSync(path)) return;
  if (!privateFilePresent(path)) {
    throw new Error(
      "unusable initial-owner invitation is not a private regular file",
    );
  }
  unlinkSync(path);
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function plannedSlackIsActive(
  manifest: OrganizationAuthoritySetupManifestV1,
): boolean {
  try {
    verifySetupGenesis(manifest);
    const database = new Database(join(manifest.state_directory, "integrations.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return database
        .prepare(
          "SELECT 1 FROM organization_tool_connection_current_state " +
            "WHERE connection_id = ? AND current_status = 'active' LIMIT 1",
        )
        .get(manifest.slack_connection_id) !== undefined;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function durableSetupStage(
  manifest: OrganizationAuthoritySetupManifestV1,
): OrganizationAuthoritySetupStage {
  return Object.freeze({
    credentials_ready: validPkceKeyPresent(manifest.pkce_key_file),
    slack_connected: plannedSlackIsActive(manifest),
    invitation_file_present: privateFilePresent(manifest.invitation_path),
  });
}

interface InitialOwnerSetupStatus {
  readonly founder_oidc_bound: boolean;
  readonly founder_slack_link_active: boolean;
  readonly granola_credentials_valid: boolean;
  readonly granola_admission_present: boolean;
  readonly slack_verification?: SafeSlackVerification;
  readonly granola_admission_proof?: {
    readonly owner_observation_assurance: "provider_record_owner_observed";
    readonly owner_observed_at: string;
  };
}

/**
 * A deliberately non-descriptive proof that the one-note setup rehearsal
 * reached the durable read boundary.  This is status output, so it must never
 * reveal a record, reader, query, source cursor, or timestamp.
 */
interface SetupCanaryEvidence {
  readonly source_progress_observed: boolean;
  readonly approved_record_present: boolean;
  readonly active_generation_current: boolean;
  readonly owner_layer1_read_after_head: boolean;
  readonly owner_layer2_read_after_generation: boolean;
  readonly complete: boolean;
}

const EMPTY_SETUP_CANARY_EVIDENCE: SetupCanaryEvidence = Object.freeze({
  source_progress_observed: false,
  approved_record_present: false,
  active_generation_current: false,
  owner_layer1_read_after_head: false,
  owner_layer2_read_after_generation: false,
  complete: false,
});

interface CurrentRecordHead {
  readonly position: number;
  readonly record_sha256: string | null;
  readonly receipt_issued_at: string | null;
}

interface CurrentGenerationPointer {
  readonly organization_id: string;
  readonly generation_id: string;
  readonly manifest_sha256: string;
  readonly retrieval_contract_sha256: string;
  readonly record_head_position: number;
  readonly record_head_hash: string | null;
  readonly published_at: string;
}

type OrganizationAuthoritySetupNextStep =
  | "resume_bootstrap"
  | "complete_founder_browser_login"
  | "complete_founder_slack_link"
  | "install_provider_credentials"
  | "run_finalize"
  | "ready_to_start"
  | "complete";

function nextOrganizationAuthoritySetupStep(input: {
  readonly genesis_published: boolean;
  readonly setup_plan_location: "sibling" | "state";
  readonly credentials_ready: boolean;
  readonly slack_connected: boolean;
  readonly founder_invitation_valid: boolean;
  readonly full: InitialOwnerSetupStatus;
}): OrganizationAuthoritySetupNextStep {
  if (
    !input.genesis_published ||
    input.setup_plan_location === "sibling" ||
    !input.credentials_ready ||
    !input.slack_connected ||
    (!input.full.founder_oidc_bound && !input.founder_invitation_valid)
  ) {
    return "resume_bootstrap";
  }
  if (!input.full.founder_oidc_bound) return "complete_founder_browser_login";
  if (!input.full.founder_slack_link_active) return "complete_founder_slack_link";
  if (!input.full.granola_credentials_valid) return "install_provider_credentials";
  if (!input.full.granola_admission_present) return "run_finalize";
  return "ready_to_start";
}

function organizationAuthoritySetupInstruction(
  step: OrganizationAuthoritySetupNextStep,
): string {
  return {
    resume_bootstrap:
      "Run echo-organization-authority-clean-founder resume --state-dir <absolute-path>.",
    complete_founder_browser_login:
      "Start the Authority and complete the initial-owner browser login.",
    complete_founder_slack_link:
      "Complete the initial-owner Slack identity link in the Authority.",
    install_provider_credentials:
      "Run the credentials-install command with the three private source files.",
    run_finalize: "Run the finalize command.",
    ready_to_start:
      "Start or restart the Authority runtime, then complete the setup canary.",
    complete: "Organization setup is complete.",
  }[step];
}

function readInitialOwnerSetupStatus(
  manifest: OrganizationAuthoritySetupManifestV1,
  dependencies?: OrganizationAuthoritySetupCliDependencies,
): InitialOwnerSetupStatus {
  return dependencies?.read_initial_owner_setup_status?.(manifest) ??
    initialOwnerSetupStatus(manifest);
}

function currentRecordHead(database: Database.Database): CurrentRecordHead {
  const row = database
    .prepare(
      `SELECT position, record_sha256, receipt_issued_at
         FROM organization_record_log
        ORDER BY position DESC
        LIMIT 1`,
    )
    .get() as
    | {
        readonly position: unknown;
        readonly record_sha256: unknown;
        readonly receipt_issued_at: unknown;
      }
    | undefined;
  if (row === undefined) {
    return Object.freeze({
      position: 0,
      record_sha256: null,
      receipt_issued_at: null,
    });
  }
  if (
    !Number.isSafeInteger(row.position) ||
    (typeof row.record_sha256 !== "string" && row.record_sha256 !== null) ||
    typeof row.receipt_issued_at !== "string"
  ) {
    throw new Error("organization setup canary record head is invalid");
  }
  return Object.freeze({
    position: row.position as number,
    record_sha256: row.record_sha256,
    receipt_issued_at: row.receipt_issued_at,
  });
}

function activeGenerationPointer(
  database: Database.Database,
): CurrentGenerationPointer | null {
  const row = database
    .prepare(
      `SELECT organization_id, generation_id, manifest_sha256,
              retrieval_contract_sha256, record_head_position,
              record_head_hash, published_at
         FROM authority_readable_search_active_generation
        WHERE singleton = 1`,
    )
    .get() as
    | {
        readonly organization_id: unknown;
        readonly generation_id: unknown;
        readonly manifest_sha256: unknown;
        readonly retrieval_contract_sha256: unknown;
        readonly record_head_position: unknown;
        readonly record_head_hash: unknown;
        readonly published_at: unknown;
      }
    | undefined;
  if (row === undefined) return null;
  if (
    typeof row.organization_id !== "string" ||
    typeof row.generation_id !== "string" ||
    typeof row.manifest_sha256 !== "string" ||
    typeof row.retrieval_contract_sha256 !== "string" ||
    !Number.isSafeInteger(row.record_head_position) ||
    (typeof row.record_head_hash !== "string" && row.record_head_hash !== null) ||
    typeof row.published_at !== "string"
  ) {
    throw new Error(
      "organization setup canary generation pointer is invalid",
    );
  }
  return Object.freeze({
    organization_id: row.organization_id,
    generation_id: row.generation_id,
    manifest_sha256: row.manifest_sha256,
    retrieval_contract_sha256: row.retrieval_contract_sha256,
    record_head_position: row.record_head_position as number,
    record_head_hash: row.record_head_hash,
    published_at: row.published_at,
  });
}

function sameRecordHead(
  left: CurrentRecordHead,
  right: CurrentRecordHead,
): boolean {
  return (
    left.position === right.position &&
    left.record_sha256 === right.record_sha256 &&
    left.receipt_issued_at === right.receipt_issued_at
  );
}

function sameGenerationPointer(
  left: CurrentGenerationPointer | null,
  right: CurrentGenerationPointer | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.organization_id === right.organization_id &&
    left.generation_id === right.generation_id &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.retrieval_contract_sha256 === right.retrieval_contract_sha256 &&
    left.record_head_position === right.record_head_position &&
    left.record_head_hash === right.record_head_hash &&
    left.published_at === right.published_at
  );
}

function pointerMatchesHead(
  pointer: CurrentGenerationPointer | null,
  head: CurrentRecordHead,
  organizationId: string,
): pointer is CurrentGenerationPointer {
  return (
    pointer !== null &&
    pointer.organization_id === organizationId &&
    pointer.record_head_position === head.position &&
    pointer.record_head_hash === head.record_sha256
  );
}

function ownerReadAfter(
  authority: Database.Database,
  manifest: OrganizationAuthoritySetupManifestV1,
  mode: "layer1" | "layer2",
  after: string,
): boolean {
  return authority
    .prepare(
      `SELECT 1
         FROM authority_person_read_decision_audit_v2
        WHERE context_kind = 'record_read'
          AND recorded_at > ?
          AND json_extract(body_json, '$.read_mode') = ?
          AND json_extract(body_json, '$.authority_id') = ?
          AND json_extract(body_json, '$.organization_id') = ?
          AND json_extract(body_json, '$.state_lineage_id') = ?
          AND json_extract(body_json, '$.principal_id') = ?
          AND json_extract(body_json, '$.membership_id') = ?
          AND json_extract(body_json, '$.result_count') > 0
        LIMIT 1`,
    )
    .get(
      after,
      mode,
      manifest.authority_id,
      manifest.organization_id,
      manifest.state_lineage_id,
      manifest.owner_principal_id,
      manifest.owner_membership_id,
    ) !== undefined;
}

/**
 * Read only durable proof. The head and active-generation pointer are read
 * before and after the proof query: any append or generation publication in
 * between makes the terminal claim fail closed until the owner reruns status.
 */
function setupCanaryEvidence(
  manifest: OrganizationAuthoritySetupManifestV1,
): SetupCanaryEvidence {
  let authority: Database.Database | undefined;
  let record: Database.Database | undefined;
  try {
    verifySetupGenesis(manifest);
    authority = new Database(join(manifest.state_directory, "authority.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    record = new Database(join(manifest.state_directory, "record-log.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    const initialHead = currentRecordHead(record);
    const initialPointer = activeGenerationPointer(authority);
    const sourceProgressObserved = authority
      .prepare(
        `SELECT 1
           FROM authority_live_source_progress_v2 AS progress
           JOIN authority_live_source_admission_v2 AS admission
             ON admission.singleton = 1
            AND admission.semantic_input_sha256 =
                progress.admission_semantic_input_sha256
          WHERE progress.singleton = 1
            AND progress.cursor_version > 0
          LIMIT 1`,
      )
      .get() !== undefined;
    const approvedRecordPresent = record
      .prepare(
        `SELECT 1 FROM organization_record_log
          WHERE event_kind = 'approved' AND action = 'approve'
          LIMIT 1`,
      )
      .get() !== undefined;
    const activeGenerationCurrent = pointerMatchesHead(
      initialPointer,
      initialHead,
      manifest.organization_id,
    ) &&
      initialPointer.retrieval_contract_sha256 ===
        readableSearchRuntimeContractV1().retrieval_contract_sha256;
    const ownerLayer1ReadAfterHead =
      activeGenerationCurrent &&
      initialHead.receipt_issued_at !== null &&
      ownerReadAfter(
        authority,
        manifest,
        "layer1",
        initialHead.receipt_issued_at,
      );
    const ownerLayer2ReadAfterGeneration =
      activeGenerationCurrent &&
      ownerReadAfter(
        authority,
        manifest,
        "layer2",
        initialPointer.published_at,
      );
    const stable =
      sameRecordHead(initialHead, currentRecordHead(record)) &&
      sameGenerationPointer(initialPointer, activeGenerationPointer(authority));
    if (!stable) return EMPTY_SETUP_CANARY_EVIDENCE;
    const complete =
      sourceProgressObserved &&
      approvedRecordPresent &&
      activeGenerationCurrent &&
      ownerLayer1ReadAfterHead &&
      ownerLayer2ReadAfterGeneration;
    return Object.freeze({
      source_progress_observed: sourceProgressObserved,
      approved_record_present: approvedRecordPresent,
      active_generation_current: activeGenerationCurrent,
      owner_layer1_read_after_head: ownerLayer1ReadAfterHead,
      owner_layer2_read_after_generation: ownerLayer2ReadAfterGeneration,
      complete,
    });
  } catch {
    return EMPTY_SETUP_CANARY_EVIDENCE;
  } finally {
    record?.close();
    authority?.close();
  }
}

function readSetupCanaryEvidence(
  manifest: OrganizationAuthoritySetupManifestV1,
  dependencies?: OrganizationAuthoritySetupCliDependencies,
): SetupCanaryEvidence {
  return dependencies?.read_setup_canary_evidence?.(manifest) ??
    setupCanaryEvidence(manifest);
}

function initialOwnerSetupStatus(
  manifest: OrganizationAuthoritySetupManifestV1,
): InitialOwnerSetupStatus {
  const empty: InitialOwnerSetupStatus = {
    founder_oidc_bound: false,
    founder_slack_link_active: false,
    granola_credentials_valid: false,
    granola_admission_present: false,
  };
  try {
    verifySetupGenesis(manifest);
    const authority = new Database(join(manifest.state_directory, "authority.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    let initialOwnerOidcBound = false;
    let granolaAdmissionProof: InitialOwnerSetupStatus["granola_admission_proof"];
    try {
      initialOwnerOidcBound = authority.prepare(
        `SELECT 1 FROM authority_oidc_identity_bindings AS binding
          JOIN authority_person_login_grants AS grant_row
            ON grant_row.login_grant_sha256 = binding.initial_login_grant_sha256
          WHERE binding.organization_id = ? AND binding.principal_id = ?
            AND binding.membership_id = ? AND binding.membership_type = 'owner'
            AND binding.status = 'active' AND grant_row.consumed_at = binding.bound_at
          LIMIT 1`,
      ).get(
        manifest.organization_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
      ) !== undefined;
      const admission = authority.prepare(
        `SELECT source_custodian_assurance, source_custodian_observed_at
           FROM authority_live_source_admission_v2
          WHERE singleton = 1 AND organization_id = ? AND principal_id = ?
            AND membership_id = ? AND membership_type = 'owner'
            AND source_adapter_id = 'granola'
            AND source_adapter_instance_id = ?
            AND processor_adapter_id = 'llm'
            AND processor_instance_id = ?
          LIMIT 1`,
      ).get(
        manifest.organization_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
        SOURCE_INSTANCE_ID,
        PROCESSOR_INSTANCE_ID,
      ) as
        | {
            readonly source_custodian_assurance: unknown;
            readonly source_custodian_observed_at: unknown;
          }
        | undefined;
      if (
        admission?.source_custodian_assurance ===
          "provider_record_owner_observed" &&
        typeof admission.source_custodian_observed_at === "string"
      ) {
        granolaAdmissionProof = Object.freeze({
          owner_observation_assurance: "provider_record_owner_observed",
          owner_observed_at: admission.source_custodian_observed_at,
        });
      }
    } finally {
      authority.close();
    }
    let granolaCredentialsValid = false;
    try {
      void readPrivateAuthorityGranolaOrganizationCredential(
        `file:${manifest.granola_credential_file}`,
      );
      const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
        `file:${manifest.granola_owner_email_file}`,
      );
      void readPrivateAuthorityCredential(`file:${manifest.llm_credential_file}`);
      granolaCredentialsValid = ownerEmail === manifest.owner_email;
    } catch {}
    const control = new Database(join(manifest.state_directory, "integrations.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const initialOwnerSlackLinkActive = control.prepare(
        `SELECT 1 FROM organization_external_human_link_current AS link
          JOIN organization_tool_connection_contracts AS connection
            ON connection.connection_id = ?
          JOIN organization_tool_connection_current_state AS connection_state
            ON connection_state.connection_id = connection.connection_id
          WHERE link.current_status = 'active' AND link.principal_id = ?
            AND link.membership_id = ? AND link.provider_issuer = 'https://slack.com'
            AND link.provider_tenant_id = json_extract(connection.contract_json, '$.provider_tenant_id')
            AND COALESCE(link.provider_enterprise_id, '') =
                COALESCE(json_extract(connection.contract_json, '$.provider_enterprise_id'), '')
            AND connection_state.current_status = 'active'
          LIMIT 1`,
      ).get(
        manifest.slack_connection_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
      ) !== undefined;
      const slackProofRow = control.prepare(
        `SELECT json_extract(connection.contract_json, '$.provider_tenant_id') AS workspace_id,
                json_extract(connection.contract_json, '$.provider_enterprise_id') AS enterprise_id,
                json_extract(connection.contract_json, '$.provider_app_id') AS app_id,
                json_extract(connection.contract_json, '$.provider_bot_id') AS bot_id,
                json_extract(connection.contract_json, '$.provider_bot_user_id') AS bot_user_id,
                json_extract(state.state_json, '$.observed_granted_scopes') AS observed_scopes_json,
                json_extract(state.state_json, '$.verified_at') AS verified_at
           FROM organization_tool_connection_contracts AS connection
           JOIN organization_tool_connection_current_state AS state
             ON state.connection_id = connection.connection_id
            AND state.connection_contract_sha256 = connection.contract_sha256
          WHERE connection.connection_id = ? AND state.current_status = 'active'
          LIMIT 1`,
      ).get(manifest.slack_connection_id) as
        | {
            readonly workspace_id: unknown;
            readonly enterprise_id: unknown;
            readonly app_id: unknown;
            readonly bot_id: unknown;
            readonly bot_user_id: unknown;
            readonly observed_scopes_json: unknown;
            readonly verified_at: unknown;
          }
        | undefined;
      let requiredScopesObserved = false;
      try {
        const scopes = JSON.parse(
          typeof slackProofRow?.observed_scopes_json === "string"
            ? slackProofRow.observed_scopes_json
            : "null",
        ) as unknown;
        requiredScopesObserved =
          Array.isArray(scopes) &&
          SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.every((scope) =>
            scopes.includes(scope),
          );
      } catch {}
      const slackVerification =
        slackProofRow !== undefined &&
        requiredScopesObserved &&
        typeof slackProofRow.workspace_id === "string" &&
        (slackProofRow.enterprise_id === null ||
          typeof slackProofRow.enterprise_id === "string") &&
        typeof slackProofRow.app_id === "string" &&
        typeof slackProofRow.bot_id === "string" &&
        typeof slackProofRow.bot_user_id === "string" &&
        typeof slackProofRow.verified_at === "string"
          ? Object.freeze({
              workspace_id: slackProofRow.workspace_id,
              enterprise_id: slackProofRow.enterprise_id,
              app_id: slackProofRow.app_id,
              bot_id: slackProofRow.bot_id,
              bot_user_id: slackProofRow.bot_user_id,
              identity_link_channel_id: manifest.slack_approval_channel_id,
              required_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
              identity_link_channel_access: "verified" as const,
              selected_channel_public: true as const,
              selected_channel_active: true as const,
              bot_membership_verified: true as const,
              bot_access_verified: true as const,
              verified_at: slackProofRow.verified_at,
            })
          : undefined;
      return Object.freeze({
        founder_oidc_bound: initialOwnerOidcBound,
        founder_slack_link_active: initialOwnerSlackLinkActive,
        granola_credentials_valid: granolaCredentialsValid,
        granola_admission_present: granolaAdmissionProof !== undefined,
        ...(slackVerification === undefined ? {} : { slack_verification: slackVerification }),
        ...(granolaAdmissionProof === undefined
          ? {}
          : { granola_admission_proof: granolaAdmissionProof }),
      });
    } finally {
      control.close();
    }
  } catch {
    return Object.freeze(empty);
  }
}

async function bootstrap(
  input: BootstrapInput,
  io: CliIo,
  dependencies: OrganizationAuthoritySetupCliDependencies,
): Promise<void> {
  // This must happen before a durable setup plan, genesis, or Slack call. The
  // same current OIDC parser and callback rule power the Person CLI.
  const oidc = readCleanPersonOidcConfiguration(input.oidc_config_path);
  assertCleanPersonAuthorityCallback(input.authority_url, oidc.configuration);
  let setup = loadSetupManifest(input.state_directory);
  if (setup === undefined) {
    if (existsSync(input.state_directory)) {
      throw new Error(
        "state directory exists without an organization setup plan",
      );
    }
    const manifest = setupManifest(input, dependencies.now());
    writeCanonicalPrivateFile(siblingSetupPlanPath(input.state_directory), manifest);
    setup = Object.freeze({ manifest, location: "sibling" as const });
  } else if (!setupInputMatches(setup.manifest, input)) {
    throw new Error("bootstrap arguments do not exactly match the durable setup plan");
  }
  const manifest = setup.manifest;
  if (!existsSync(input.state_directory)) {
    const seed = manifest.setup_seed;
    dependencies.initialize_state({
      state_directory: input.state_directory,
      organization_display_name: input.organization_name,
      owner_display_name: input.owner_display_name,
      created_at: manifest.created_at,
      creating_artifact_revision: input.artifact_revision,
      seed: {
        authority_id: seed.authority_id,
        organization_id: seed.organization_id,
        state_lineage_id: seed.state_lineage_id,
        owner_principal_id: seed.owner_principal_id,
        owner_membership_id: seed.owner_membership_id,
        control_plane_id: seed.control_plane_id,
      },
    });
  }
  // Genesis verifies its rename target. Verify it once more before the plan
  // crosses from its sibling file into the published state directory.
  verifySetupGenesis(manifest);
  publishSetupPlan(manifest);
  const stage = () =>
    dependencies.read_setup_stage?.(manifest) ?? durableSetupStage(manifest);
  if (!stage().credentials_ready) {
    await dependencies.initialize_credentials(input.state_directory);
  }
  let slack: ConnectedSlack = { connection_id: manifest.slack_connection_id };
  if (!stage().slack_connected) {
    slack = await dependencies.connect_slack({
      state_directory: input.state_directory,
      approval_channel_id: input.slack_approval_channel_id,
      connection_id: manifest.slack_connection_id,
      read_stdin: io.read_stdin,
    });
  }
  const invitationPath = manifest.invitation_path;
  if (slack.connection_id !== manifest.slack_connection_id) {
    throw new Error("clean Slack connection did not retain the setup ID");
  }
  const full = readInitialOwnerSetupStatus(manifest, dependencies);
  const initialOwnerAlreadyBound = full.founder_oidc_bound;
  const invitationIsUsable = () =>
    dependencies.read_setup_stage === undefined
      ? usableInitialOwnerInvitation(manifest)
      : stage().invitation_file_present;
  if (!initialOwnerAlreadyBound && !invitationIsUsable()) {
    discardUnusableInvitation(invitationPath);
    await dependencies.issue_invitation({
      state_directory: input.state_directory,
      oidc_config_path: input.oidc_config_path,
      pkce_key_file: manifest.pkce_key_file,
      membership_id: manifest.owner_membership_id,
      expected_email: input.owner_email,
      authority_url: input.authority_url,
      output_path: invitationPath,
    });
  }
  const completedStage = stage();
  const completedFull = readInitialOwnerSetupStatus(manifest, dependencies);
  const nextStep = nextOrganizationAuthoritySetupStep({
    genesis_published: true,
    setup_plan_location: "state",
    credentials_ready: completedStage.credentials_ready,
    slack_connected: completedStage.slack_connected,
    founder_invitation_valid: invitationIsUsable(),
    full: completedFull,
  });
  io.stdout(
    `${canonicalJson({
      ok: true,
      ...(!initialOwnerAlreadyBound ? { invitation_path: invitationPath } : {}),
      ...((completedFull.slack_verification ?? slack.verification) === undefined
        ? {}
        : { slack_verification: completedFull.slack_verification ?? slack.verification }),
      ...(completedFull.granola_admission_proof === undefined
        ? {}
        : { granola_admission_proof: completedFull.granola_admission_proof }),
      next_step: nextStep,
      next_instruction: organizationAuthoritySetupInstruction(nextStep),
    } as never)}\n`,
  );
}

async function resume(
  input: FinalizeInput,
  io: CliIo,
  dependencies: OrganizationAuthoritySetupCliDependencies,
): Promise<void> {
  const setup = loadSetupManifest(input.state_directory);
  if (setup === undefined) {
    if (existsSync(input.state_directory)) {
      throw new Error(
        "organization setup plan is missing; restore the exact setup plan or choose a new state directory",
      );
    }
    throw new Error(
      "organization setup resume requires an existing durable setup plan",
    );
  }
  const manifest = setup.manifest;
  // A terminal rehearsal is durable state, not a signal to replay setup. This
  // keeps `resume` safe to rerun after the final status check.
  let genesisPublished = false;
  try {
    verifySetupGenesis(manifest);
    genesisPublished = true;
  } catch {}
  const durable =
    dependencies.read_setup_stage?.(manifest) ?? durableSetupStage(manifest);
  const full = readInitialOwnerSetupStatus(manifest, dependencies);
  const setupStep = nextOrganizationAuthoritySetupStep({
    genesis_published: genesisPublished,
    setup_plan_location: setup.location,
    credentials_ready: genesisPublished && durable.credentials_ready,
    slack_connected: genesisPublished && durable.slack_connected,
    founder_invitation_valid:
      genesisPublished && usableInitialOwnerInvitation(manifest),
    full,
  });
  if (
    setupStep === "ready_to_start" &&
    readSetupCanaryEvidence(manifest, dependencies).complete
  ) {
    status(input, io, dependencies);
    return;
  }
  await bootstrap(
    Object.freeze({
      state_directory: manifest.state_directory,
      organization_name: manifest.organization_name,
      owner_display_name: manifest.owner_display_name,
      owner_email: manifest.owner_email,
      authority_url: manifest.authority_url,
      oidc_config_path: manifest.oidc_config_path,
      slack_approval_channel_id: manifest.slack_approval_channel_id,
      artifact_revision: manifest.artifact_revision,
    }),
    io,
    dependencies,
  );
}

function installProviderCredentials(
  input: CredentialInstallInput,
  io: CliIo,
): void {
  const manifest = readOrganizationAuthoritySetupManifest(input.state_directory);
  verifySetupGenesis(manifest);
  if (
    manifest.granola_credential_file !==
      join(input.state_directory, "credentials", GRANOLA_CREDENTIAL_FILENAME) ||
    manifest.granola_owner_email_file !==
      join(input.state_directory, "credentials", GRANOLA_OWNER_EMAIL_FILENAME) ||
    manifest.llm_credential_file !==
      join(input.state_directory, "credentials", LLM_CREDENTIAL_FILENAME)
  ) {
    throw new Error(
      "organization setup does not have fixed provider credential destinations",
    );
  }

  // Read and validate every source before replacing any destination. Values
  // are never accepted as argv text and never enter output or durable setup
  // metadata.
  const granolaCredential =
    readPrivateAuthorityGranolaOrganizationCredential(
      `file:${input.granola_credential_source}`,
    );
  const granolaOwnerEmail = readPrivateAuthorityGranolaOwnerEmail(
    `file:${input.granola_owner_email_source}`,
  );
  const llmCredential = readPrivateAuthorityCredential(
    `file:${input.llm_credential_source}`,
  );
  if (granolaOwnerEmail !== manifest.owner_email) {
    throw new Error(
      "Granola owner email does not match the initial-owner setup email",
    );
  }

  installPrivateCredentialValue(
    manifest.granola_credential_file,
    granolaCredential,
  );
  installPrivateCredentialValue(
    manifest.granola_owner_email_file,
    granolaOwnerEmail,
  );
  installPrivateCredentialValue(manifest.llm_credential_file, llmCredential);
  if (!initialOwnerSetupStatus(manifest).granola_credentials_valid) {
    throw new Error("organization setup provider credentials did not install");
  }
  io.stdout(
    `${canonicalJson({
      ok: true,
      credentials_ready: true,
      next_instruction:
        "Run echo-organization-authority-clean-founder status to continue.",
    } as never)}\n`,
  );
}

async function finalize(
  input: FinalizeInput,
  io: CliIo,
  dependencies: OrganizationAuthoritySetupCliDependencies,
): Promise<void> {
  const manifest = readOrganizationAuthoritySetupManifest(input.state_directory);
  // This is a stopped-state publication gate, not merely a convenience
  // command. Prove genesis before a dependency can admit anything.
  verifySetupGenesis(manifest);
  const full = readInitialOwnerSetupStatus(manifest, dependencies);
  const missing = [
    !full.founder_oidc_bound && "initial-owner OIDC binding",
    !full.founder_slack_link_active && "initial-owner Slack link",
    !full.granola_credentials_valid && "provider credentials",
  ].filter((value): value is string => typeof value === "string");
  if (missing.length > 0) {
    throw new Error(
      `organization setup finalize requires ${missing.join(", ")}`,
    );
  }
  if (!full.granola_admission_present) {
    await dependencies.admit_source({
      state_directory: manifest.state_directory,
      granola_credential_file: manifest.granola_credential_file,
      granola_owner_email_file: manifest.granola_owner_email_file,
      llm_credential_file: manifest.llm_credential_file,
    });
  }
  io.stdout(
    `${canonicalJson({
      ok: true,
      runtime_status: "ready_to_start",
      runtime_observation: "not_observed",
      canary_status: "not_complete",
      next_instruction:
        "Restart the same echo-organization-authority-clean-live serve command. The clean Granola source begins at its live-only cutoff.",
    } as never)}\n`,
  );
}

function status(
  input: FinalizeInput,
  io: CliIo,
  dependencies?: OrganizationAuthoritySetupCliDependencies,
): void {
  const setup = loadSetupManifest(input.state_directory);
  if (setup === undefined) {
    io.stdout(
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-founder-setup-status-v1",
        setup_plan_present: false,
        genesis_published: false,
        credentials_ready: false,
        slack_connected: false,
        invitation_file_present: false,
        founder_invitation_valid: false,
        founder_oidc_bound: false,
        founder_slack_link_active: false,
        granola_credentials_valid: false,
        granola_admission_present: false,
        source_progress_observed: false,
        approved_record_present: false,
        active_generation_current: false,
        owner_layer1_read_after_head: false,
        owner_layer2_read_after_generation: false,
        runtime_status: "not_ready",
        runtime_observation: "not_observed",
        canary_status: "not_ready",
        next_step: existsSync(input.state_directory)
          ? "recover_setup_plan"
          : "run_bootstrap",
      } as never)}\n`,
    );
    return;
  }
  let genesisPublished = false;
  try {
    verifySetupGenesis(setup.manifest);
    genesisPublished = true;
  } catch {
    genesisPublished = false;
  }
  const durable =
    dependencies?.read_setup_stage?.(setup.manifest) ??
    durableSetupStage(setup.manifest);
  const full = readInitialOwnerSetupStatus(setup.manifest, dependencies);
  const credentialsReady = genesisPublished && durable.credentials_ready;
  const slackConnected = genesisPublished && durable.slack_connected;
  const invitationFilePresent =
    genesisPublished && durable.invitation_file_present;
  const invitationValid =
    genesisPublished && usableInitialOwnerInvitation(setup.manifest);
  const nextStep = nextOrganizationAuthoritySetupStep({
    genesis_published: genesisPublished,
    setup_plan_location: setup.location,
    credentials_ready: credentialsReady,
    slack_connected: slackConnected,
    founder_invitation_valid: invitationValid,
    full,
  });
  const runtimeStatus = nextStep === "ready_to_start"
    ? "ready_to_start"
    : "not_ready";
  const canary = nextStep === "ready_to_start"
    ? readSetupCanaryEvidence(setup.manifest, dependencies)
    : EMPTY_SETUP_CANARY_EVIDENCE;
  const terminalStep: OrganizationAuthoritySetupNextStep = canary.complete
    ? "complete"
    : nextStep;
  const canaryStatus = terminalStep === "complete"
    ? "complete"
    : nextStep === "ready_to_start"
      ? "not_complete"
      : "not_ready";
  io.stdout(
    `${canonicalJson({
      schema_version: 1,
      kind: "echo-clean-founder-setup-status-v1",
      setup_plan_present: true,
      genesis_published: genesisPublished,
      credentials_ready: credentialsReady,
      slack_connected: slackConnected,
      invitation_file_present: invitationFilePresent,
      founder_invitation_valid: invitationValid,
      founder_oidc_bound: full.founder_oidc_bound,
      founder_slack_link_active: full.founder_slack_link_active,
      granola_credentials_valid: full.granola_credentials_valid,
      granola_admission_present: full.granola_admission_present,
      source_progress_observed: canary.source_progress_observed,
      approved_record_present: canary.approved_record_present,
      active_generation_current: canary.active_generation_current,
      owner_layer1_read_after_head: canary.owner_layer1_read_after_head,
      owner_layer2_read_after_generation:
        canary.owner_layer2_read_after_generation,
      next_step: terminalStep,
      runtime_status: runtimeStatus,
      runtime_observation: "not_observed",
      canary_status: canaryStatus,
    } as never)}\n`,
  );
}

export async function runOrganizationAuthoritySetupCli(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
  dependencies: OrganizationAuthoritySetupCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  try {
    if (argv[0] === "bootstrap") {
      await bootstrap(parseBootstrap(argv.slice(1)), io, dependencies);
      return 0;
    }
    if (argv[0] === "resume") {
      await resume(parseFinalize(argv.slice(1)), io, dependencies);
      return 0;
    }
    if (argv[0] === "finalize") {
      await finalize(parseFinalize(argv.slice(1)), io, dependencies);
      return 0;
    }
    if (argv[0] === "credentials-install") {
      installProviderCredentials(parseCredentialInstall(argv.slice(1)), io);
      return 0;
    }
    if (argv[0] === "status") {
      status(parseFinalize(argv.slice(1)), io, dependencies);
      return 0;
    }
    throw new Error(USAGE);
  } catch (error) {
    io.stderr(
      `${error instanceof Error ? error.message : "organization setup command failed"}\n`,
    );
    return 1;
  }
}
