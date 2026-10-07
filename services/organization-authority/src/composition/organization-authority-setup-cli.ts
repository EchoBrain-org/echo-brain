import {
  createStagingSyntheticPersonalMeetingProviderV1,
  readStagingSyntheticCheckpointV1,
  readStagingSyntheticMeetingFixturesV1,
  stagingSyntheticCanaryMeetingV1,
  stagingSyntheticCanaryReleaseV1,
  STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
  STAGING_SYNTHETIC_CUSTODIAN_ASSURANCE_V1,
  STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
} from "@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1";
/**
 * Stopped-state bootstrap for the shipped OpenRouter/Slack profile.
 * Finalization intentionally requires Slack, which an owner sets up in the
 * ECHO app while the Authority runs. This is not a swappable setup port:
 * another profile needs a versioned bootstrap design. Provider verification
 * and persisted provider facts stay in provider helpers.
 */
import { captureCommand } from '@echo-brain/organization-authority-kernel/composition/capture-stopped-state-command';
import { plannedSlackConnectionIsActiveV1, readInitialOwnerSlackSetupStatusV1 } from '@echo-brain/provider-slack-server/setup/initial-owner-slack-setup-v1';
import { randomUUID } from "node:crypto";
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
  sha256Digest,
} from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";


import { assertDisplayName } from "@echo-brain/organization-authority-kernel/domain/rules";
import { personLoginGrantExpectedEmailSha256 } from "@echo-brain/organization-authority-kernel/domain/person-email-binding";
import {
  isCanonicalPersonEmail,
  isExpectedPersonEmail,
} from "@echo-brain/organization-authority-kernel/domain/person-session-rules";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import {
  bootstrapOrganizationAuthorityState,
  type AuthorityStateSeedV1,
} from "./organization-authority-state-bootstrap.js";
import { createOpenRouterDecisionProcessorAdmissionCommitmentV1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-admission-commitment";
import { OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1, OPENROUTER_ANSWER_COMPOSITION_MODEL_V1, OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { readableSearchGenerationContractV1 } from "./readable-search-generation-composition.js";
import {
  assertPersonAuthorityCallback,
  readPersonOidcConfiguration,
  runOrganizationAuthorityPersonAdministrationCli,
} from "./organization-authority-person-administration-cli.js";
import { reissueLegacyPersonOnboardingInvitation } from "./person-onboarding-service.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";
import { queueStagingSyntheticMeetingsV1 } from "./staging/staging-synthetic-personal-canary-v1.js";

const MANIFEST_DIRECTORY = "onboarding";
const MANIFEST_FILENAME = "clean-founder-v1.json";
const SETUP_PLAN_SUFFIX = ".clean-founder-setup-plan-v1.json";
const INVITATION_FILENAME = "founder-person-invitation.json";
const LLM_CREDENTIAL_FILENAME = "llm-credential";
const PROCESSOR_INSTANCE_ID = "founder-llm-v1";
const DEFAULT_ARTIFACT_REVISION = "clean-founder-v1";
const STAGING_SYNTHETIC_CANARY_ORIGIN =
  "https://authority-staging.echobrain.org";
const STAGING_SYNTHETIC_CANARY_HOST = "authority-staging.echobrain.org";
const CLEAN_V1_RELEASE_ID = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;

const USAGE = `usage:
  echo-organization-authority-setup bootstrap --state-dir <absolute-path> --organization-name <name> --owner-display-name <name> --owner-email <email> --authority-url <https-origin> --oidc-config <absolute-json-path> [--artifact-revision <revision>]
  echo-organization-authority-setup resume --state-dir <absolute-path>
  echo-organization-authority-setup credentials-install --state-dir <absolute-path> --llm-credential-file <absolute-private-path>
  echo-organization-authority-setup finalize --state-dir <absolute-path> [--staging-synthetic-meetings-dir <absolute-path>]
  echo-organization-authority-setup status --state-dir <absolute-path>`;

// The remaining `clean-founder` filenames, command paths, instance IDs, wire
// kinds, status fields, and next-step literals are frozen V1 compatibility
// vocabulary. They do not name this component or limit setup to an initial owner.

interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const PROCESS_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

/** Slack is set up in the ECHO app, so the manifest names no Slack connection or channel. */
export interface OrganizationAuthoritySetupManifestV3 {
  readonly schema_version: 3;
  readonly kind: "echo-clean-founder-onboarding-manifest-v3";
  readonly state_directory: string;
  readonly created_at: string;
  readonly artifact_revision: string;
  readonly authority_url: string;
  readonly oidc_config_path: string;
  readonly pkce_key_file: string;
  readonly invitation_path: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly llm_credential_file: string;
  readonly setup_seed: AuthorityStateSeedV1;
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
  readonly artifact_revision: string;
}

interface FinalizeInput {
  readonly state_directory: string;
  readonly staging_synthetic_meetings_directory?: string;
}

interface CredentialInstallInput extends FinalizeInput {
  readonly llm_credential_source: string;
}





interface OrganizationAuthoritySetupStage {
  readonly credentials_ready: boolean;
  readonly slack_connected: boolean;
  readonly invitation_file_present: boolean;
}

export interface OrganizationAuthoritySetupCliDependencies {
  readonly now: () => string;
  readonly initialize_state: typeof bootstrapOrganizationAuthorityState;
  readonly initialize_credentials: (stateDirectory: string) => Promise<void>;
  readonly issue_invitation: (input: {
    readonly state_directory: string;
    readonly oidc_config_path: string;
    readonly pkce_key_file: string;
    readonly membership_id: string;
    readonly expected_email: string;
    readonly authority_url: string;
    readonly output_path: string;
  }) => Promise<void>;
  /** Test seam only; production queues into the owner's staging synthetic source. */
  readonly queue_staging_synthetic_meetings?: (input: {
    readonly state_directory: string;
    /** Absent for the release canary alone. */
    readonly meetings_directory?: string;
    readonly llm_credential_file: string;
  }) => Promise<void>;
  /** Test seam only; production derives these facts from durable state. */
  readonly read_initial_owner_setup_status?: (
    manifest: OrganizationAuthoritySetupManifestV3,
  ) => InitialOwnerSetupStatus;
  /** Test seam only; production derives this from immutable state. */
  readonly read_setup_canary_evidence?: (
    manifest: OrganizationAuthoritySetupManifestV3,
  ) => SetupCanaryEvidence;
  /** Test seam only; production derives these facts from durable state. */
  readonly read_setup_stage?: (
    manifest: OrganizationAuthoritySetupManifestV3,
  ) => OrganizationAuthoritySetupStage;
}



const DEFAULT_DEPENDENCIES: OrganizationAuthoritySetupCliDependencies = {
  now: () => new Date().toISOString(),
  initialize_state: bootstrapOrganizationAuthorityState,
  initialize_credentials: async (stateDirectory) => {
    await captureCommand((stdout) =>
      runOrganizationAuthorityPersonAdministrationCli(
        ["credentials-init", "--state-dir", stateDirectory],
        {
          stdout,
          stderr: () => undefined,
        },
      ),
    );
  },
  issue_invitation: async (input) => {
    await captureCommand((stdout) =>
      runOrganizationAuthorityPersonAdministrationCli(
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
};

/**
 * Ensures the owner's staging synthetic personal source with the current
 * OpenRouter commitments and queues each fixture meeting into it. Queueing is
 * idempotent: a retry re-queues meetings whose frozen proposals are reused.
 */
async function queueStagingSyntheticSetupMeetings(input: {
  readonly state_directory: string;
  readonly meetings_directory?: string;
  readonly llm_credential_file: string;
}): Promise<void> {
  const credentialReference = `file:${input.llm_credential_file}`;
  await createOpenRouterDecisionProcessorAdmissionCommitmentV1({ instance_id: PROCESSOR_INSTANCE_ID, credential_reference: credentialReference }).preflight();
  const meetingIds = input.meetings_directory === undefined
    ? []
    : (await readStagingSyntheticMeetingFixturesV1(input.meetings_directory)).map((meeting) => meeting.id);
  const database = openAuthorityDatabase(join(input.state_directory, "authority.sqlite"), { fileMustExist: true });
  try {
    await queueStagingSyntheticMeetingsV1({
      database,
      provider: createStagingSyntheticPersonalMeetingProviderV1(
        input.meetings_directory === undefined ? {} : { fixtures_directory: input.meetings_directory },
      ),
      meeting_ids: meetingIds,
      commitments: (instance_id) => {
        const { adapter_id, version, configuration_sha256, credential_reference_sha256 } =
          createOpenRouterDecisionProcessorAdmissionCommitmentV1({ instance_id, credential_reference: credentialReference });
        return { adapter_id, instance_id, version, configuration_sha256, credential_reference_sha256 };
      },
    });
  } finally {
    database.close();
  }
}

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

/** The setup commands accept closed, nonempty flag/value pairs and reject duplicate flags. */
function parseSetupFlags(arguments_: readonly string[], accepted: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || value.length === 0 || !accepted.includes(key) || values.has(key)) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  return values;
}

function parseBootstrap(arguments_: readonly string[]): BootstrapInput {
  const values = parseSetupFlags(arguments_, [
    "--state-dir",
    "--organization-name",
    "--owner-display-name",
    "--owner-email",
    "--authority-url",
    "--oidc-config",
    "--artifact-revision",
  ]);
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(USAGE);
    return value;
  };
  const ownerEmail = required("--owner-email");
  if (!isExpectedPersonEmail(ownerEmail)) {
    throw new Error("--owner-email must be a canonical lowercase email");
  }
  const parsed = Object.freeze({
    state_directory: absolutePath(required("--state-dir"), "state directory"),
    organization_name: required("--organization-name"),
    owner_display_name: required("--owner-display-name"),
    owner_email: ownerEmail,
    authority_url: required("--authority-url"),
    oidc_config_path: absolutePath(required("--oidc-config"), "OIDC config"),
    artifact_revision:
      values.get("--artifact-revision") ?? DEFAULT_ARTIFACT_REVISION,
  });
  assertDisplayName(parsed.organization_name);
  assertDisplayName(parsed.owner_display_name);
  validateOrganizationAuthorityOrigin(parsed.authority_url);
  return parsed;
}

function parseFinalize(arguments_: readonly string[]): FinalizeInput {
  const values = parseSetupFlags(arguments_, [
    "--state-dir",
    "--staging-synthetic-meetings-dir",
  ]);
  const stateDirectory = values.get("--state-dir");
  if (stateDirectory === undefined) throw new Error(USAGE);
  return Object.freeze({
    state_directory: absolutePath(stateDirectory, "state directory"),
    ...(values.get("--staging-synthetic-meetings-dir") === undefined
      ? {}
      : {
          staging_synthetic_meetings_directory: absolutePath(
            values.get("--staging-synthetic-meetings-dir")!,
            "staging synthetic meetings directory",
          ),
        }),
  });
}

function parseStateDirectory(arguments_: readonly string[]): FinalizeInput {
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
  const values = parseSetupFlags(arguments_, [
    "--state-dir",
    "--llm-credential-file",
  ]);
  const source = (key: string, label: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(USAGE);
    return absolutePath(value, label);
  };
  return Object.freeze({
    state_directory: source("--state-dir", "state directory"),
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
  value: OrganizationAuthoritySetupManifestV3,
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

function assertSetupSeed(seed: AuthorityStateSeedV1): void {
  try {
    if (Object.keys(seed).sort().join(",") !==
      "authority_id,control_plane_id,organization_id,owner_membership_id,owner_principal_id,state_lineage_id") {
      throw new Error("unexpected setup seed fields");
    }
    assertFederationId(seed.authority_id, "oau", "setup authority_id");
    assertFederationId(seed.organization_id, "org", "setup organization_id");
    assertFederationId(seed.owner_principal_id, "prn", "setup owner_principal_id");
    assertFederationId(seed.owner_membership_id, "mem", "setup owner_membership_id");
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

function validateManifest(value: unknown): OrganizationAuthoritySetupManifestV3 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("organization setup manifest is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "echo-clean-founder-onboarding-manifest-v1") {
    // Its Slack connection was set up before the ECHO app could; staging moves to a fresh lineage.
    throw new Error("organization setup manifest predates in-app Slack setup; install this release's host tooling, then run replace-rehearsal");
  }
  const keys = [
    "artifact_revision",
    "authority_id",
    "authority_url",
    "created_at",
    "invitation_path",
    "kind",
    "llm_credential_file",
    "oidc_config_path",
    "organization_id",
    "owner_membership_id",
    "owner_principal_id",
    "pkce_key_file",
    "schema_version",
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
    record.schema_version !== 3 ||
    record.kind !== "echo-clean-founder-onboarding-manifest-v3" ||
    actualKeys !== currentKeys.sort().join(",") ||
    keys
      .filter((key) => key !== "schema_version")
      .some((key) => typeof record[key] !== "string")
  ) {
    throw new Error("organization setup manifest is invalid");
  }
  const manifest = record as unknown as OrganizationAuthoritySetupManifestV3;
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
    manifest.llm_credential_file,
  ]) {
    absolutePath(path, "organization setup manifest path");
  }
  return Object.freeze(manifest);
}

function readPrivateManifest(path: string): OrganizationAuthoritySetupManifestV3 {
  const metadata = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUid !== undefined && metadata.uid !== currentUid) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "organization setup manifest must be current-user 0600"
    );
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) {
    throw new Error("organization setup manifest is invalid");
  }
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  if (`${canonicalJson(manifest as never)}\n` !== bytes.toString("utf8")) {
    throw new Error(
      "organization setup manifest is not canonically encoded"
    );
  }
  return manifest;
}

export function readOrganizationAuthoritySetupManifest(
  stateDirectory: string,
): OrganizationAuthoritySetupManifestV3 {
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
): OrganizationAuthoritySetupManifestV3 {
  const credentialsDirectory = join(input.state_directory, "credentials");
  const seed: AuthorityStateSeedV1 = Object.freeze({
    authority_id: federationId("oau"),
    organization_id: federationId("org"),
    state_lineage_id: `lineage-${randomUUID()}`,
    owner_principal_id: federationId("prn"),
    owner_membership_id: federationId("mem"),
    control_plane_id: `ocp_${randomUUID()}`,
  });
  return Object.freeze({
    schema_version: 3,
    kind: "echo-clean-founder-onboarding-manifest-v3",
    state_directory: input.state_directory,
    created_at: createdAt,
    artifact_revision: input.artifact_revision,
    authority_url: input.authority_url,
    oidc_config_path: input.oidc_config_path,
    pkce_key_file: join(credentialsDirectory, "person-session-pkce-sealing-key"),
    invitation_path: join(input.state_directory, MANIFEST_DIRECTORY, INVITATION_FILENAME),
    authority_id: seed.authority_id,
    organization_id: seed.organization_id,
    state_lineage_id: seed.state_lineage_id,
    owner_principal_id: seed.owner_principal_id,
    owner_membership_id: seed.owner_membership_id,
    llm_credential_file: join(credentialsDirectory, LLM_CREDENTIAL_FILENAME),
    organization_name: input.organization_name,
    owner_display_name: input.owner_display_name,
    owner_email: input.owner_email,
    setup_seed: seed,
  });
}

function setupInputMatches(
  manifest: OrganizationAuthoritySetupManifestV3,
  input: BootstrapInput,
): boolean {
  return (
    manifest.organization_name === input.organization_name &&
    manifest.owner_display_name === input.owner_display_name &&
    manifest.owner_email === input.owner_email &&
    manifest.authority_url === input.authority_url &&
    manifest.oidc_config_path === input.oidc_config_path &&
    manifest.artifact_revision === input.artifact_revision
  );
}

function loadSetupManifest(stateDirectory: string): |{
  readonly manifest: OrganizationAuthoritySetupManifestV3;
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

function verifySetupGenesis(manifest: OrganizationAuthoritySetupManifestV3): void {
  const verified = verifyAuthorityStateLineage(manifest.state_directory);
  if (
    verified.root.authority_id !== manifest.setup_seed.authority_id ||
    verified.root.organization_id !== manifest.setup_seed.organization_id ||
    verified.root.state_lineage_id !== manifest.setup_seed.state_lineage_id
  ) {
    throw new Error(
      "organization setup plan does not match published genesis"
    );
  }
}

function publishSetupPlan(manifest: OrganizationAuthoritySetupManifestV3): void {
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

function usableInitialOwnerInvitation(
  manifest: OrganizationAuthoritySetupManifestV3,
): boolean {
  try {
    const path = manifest.invitation_path;
    if (!privateFilePresent(path)) return false;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const keys =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed).sort().join(",")
        : undefined;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !(
        keys === "authority_url,expires_at,kind,login_grant,schema_version" ||
        keys ===
          "authority_url,expected_email,expires_at,kind,login_grant,schema_version"
      ) ||
      `${canonicalJson(parsed as never)}\n` !== raw
    ) return false;
    const invitation = parsed as {
      schema_version: unknown;
      kind: unknown;
      authority_url: unknown;
      login_grant: unknown;
      expires_at: unknown;
      expected_email?: unknown;
    };
    if (
      !(
        (invitation.schema_version === 1 &&
          keys === "authority_url,expires_at,kind,login_grant,schema_version") ||
        (invitation.schema_version === 2 &&
          keys ===
            "authority_url,expected_email,expires_at,kind,login_grant,schema_version" &&
          isExpectedPersonEmail(invitation.expected_email) &&
          invitation.expected_email === manifest.owner_email)
      ) ||
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
      return (database.prepare(
        `SELECT 1 FROM authority_person_login_grants
          WHERE login_grant_sha256 = ? AND organization_id = ?
            AND principal_id = ? AND membership_id = ? AND membership_type = 'owner'
            AND expected_email_sha256 = ?
            AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
          LIMIT 1`,
      ).get(
        sha256Digest(invitation.login_grant),
        manifest.organization_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
        personLoginGrantExpectedEmailSha256(manifest.owner_email),
        new Date().toISOString(),
      ) !== undefined);
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
  manifest: OrganizationAuthoritySetupManifestV3,
): boolean {
  try {
    verifySetupGenesis(manifest);
    return plannedSlackConnectionIsActiveV1(manifest.state_directory);
  } catch {
    return false;
  }
}

function durableSetupStage(
  manifest: OrganizationAuthoritySetupManifestV3,
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
  readonly llm_credential_valid: boolean;
  readonly source_admission_present: boolean;
  readonly source_mode?: "staging_synthetic" | "staging_canary";
}

function llmCredentialValid(full: InitialOwnerSetupStatus): boolean {
  return full.llm_credential_valid;
}

function sourceAdmissionPresent(full: InitialOwnerSetupStatus): boolean {
  return full.source_admission_present;
}

function sourceMode(full: InitialOwnerSetupStatus):
  | "staging_synthetic"
  | "staging_canary"
  | "none" {
  return full.source_mode ?? "none";
}

/**
 * A deliberately non-descriptive proof that the one-note setup rehearsal
 * reached the durable read boundary.  This is status output, so it must never
 * reveal a record, reader, query, source cursor, or timestamp.
 */
interface SetupCanaryEvidence {
  readonly source_progress_observed: boolean;
  /** A release-bound synthetic rehearsal is accepted only on the exact staging origin. */
  readonly synthetic_staging_canary_observed?: boolean;
  readonly approved_record_present: boolean;
  readonly active_generation_current: boolean;
  readonly owner_layer1_read_after_head: boolean;
  readonly owner_layer2_read_after_generation: boolean;
  readonly complete: boolean;
}

const EMPTY_SETUP_CANARY_EVIDENCE: SetupCanaryEvidence = Object.freeze({
  source_progress_observed: false,
  synthetic_staging_canary_observed: false,
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
  | "connect_slack_in_app"
  | "complete_founder_slack_link"
  | "install_provider_credentials"
  | "run_finalize"
  | "ready_to_start"
  | "complete";

function nextOrganizationAuthoritySetupStep(input: {
  readonly authority_url: string;
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
    (!input.full.founder_oidc_bound && !input.founder_invitation_valid)
  ) {
    return "resume_bootstrap";
  }
  if (!input.full.founder_oidc_bound) return "complete_founder_browser_login";
  if (!input.slack_connected) return "connect_slack_in_app";
  if (!input.full.founder_slack_link_active) return "complete_founder_slack_link";
  if (!llmCredentialValid(input.full)) return "install_provider_credentials";
  if (input.authority_url === STAGING_SYNTHETIC_CANARY_ORIGIN && !sourceAdmissionPresent(input.full)) return "run_finalize";
  return "ready_to_start";
}

function organizationAuthoritySetupInstruction(
  step: OrganizationAuthoritySetupNextStep,
): string {
  return {
    resume_bootstrap:
      "Run echo-organization-authority-setup resume --state-dir <absolute-path>.",
    complete_founder_browser_login:
      "Start the Authority and complete the initial-owner browser login.",
    connect_slack_in_app:
      "An owner runs person tools setup --tool slack and pastes a Slack app configuration token.",
    complete_founder_slack_link:
      "The owner runs person tools connect --tool slack to link their own Slack.",
    install_provider_credentials:
      "Run credentials-install with the private LLM credential file.",
    run_finalize: "Run finalize to set up the owner's staging synthetic meeting source.",
    ready_to_start:
      "Start or restart the Authority runtime, then check setup status.",
    complete: "Organization setup is complete.",
  }[step];
}

function readInitialOwnerSetupStatus(
  manifest: OrganizationAuthoritySetupManifestV3,
  dependencies?: OrganizationAuthoritySetupCliDependencies,
): InitialOwnerSetupStatus {
  return (dependencies?.read_initial_owner_setup_status?.(manifest) ??
    initialOwnerSetupStatus(manifest));
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
      "organization setup canary generation pointer is invalid"
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

/** Derive the runtime's fixed projector contract without reading credentials. */
function expectedSetupCanaryRetrievalContract() {
  return readableSearchGenerationContractV1({
    related_atom_projector: Object.freeze({
      generation_adapter_id: OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1,
      model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
      timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
    }),
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
  manifest: OrganizationAuthoritySetupManifestV3,
  mode: "layer1" | "layer2",
  after: string,
): boolean {
  return (authority
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
    ) !== undefined);
}

interface StagingSyntheticSourceState {
  /** Fixture meetings queued into the owner's synthetic source, still pending or already proposed. */
  readonly fixtures: ReadonlySet<string>;
  readonly fixture_pending: boolean;
  readonly proposals: readonly { readonly meeting_id: string; readonly revision: unknown; readonly approval_id: string }[];
}

/**
 * The owner's staging synthetic personal source as setup finalize and the
 * release canary leave it, on the exact staging origin only.
 */
function readStagingSyntheticSource(
  manifest: OrganizationAuthoritySetupManifestV3,
  authority: Database.Database,
): StagingSyntheticSourceState | undefined {
  if (manifest.authority_url !== STAGING_SYNTHETIC_CANARY_ORIGIN) return undefined;
  const sources = authority
    .prepare(
      `SELECT admission.semantic_input_sha256, progress.cursor
         FROM authority_live_source_admission_v2 AS admission
         JOIN authority_person_meeting_sources_v1 AS person_source
           ON person_source.source_key = admission.source_key
         JOIN authority_live_source_progress_v2 AS progress
           ON progress.source_key = admission.source_key
        WHERE admission.organization_id = ? AND admission.principal_id = ?
          AND admission.membership_id = ? AND admission.membership_type = 'owner'
          AND admission.source_adapter_id = ? AND admission.source_custodian_assurance = ?
        ORDER BY admission.source_key`,
    )
    .all(
      manifest.organization_id,
      manifest.owner_principal_id,
      manifest.owner_membership_id,
      STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
      STAGING_SYNTHETIC_CUSTODIAN_ASSURANCE_V1,
    ) as readonly { readonly semantic_input_sha256: string; readonly cursor: string }[];
  if (sources.length === 0) return undefined;
  const proposalsOf = authority.prepare(
    `SELECT json_extract(candidate.meeting_json, '$.id') AS meeting_id,
            json_extract(candidate.meeting_json, '$.provenance.canonical_revision') AS revision, outbox.approval_id
       FROM authority_live_source_candidates_v2 AS candidate
       JOIN authority_live_approval_outbox_v2 AS outbox
         ON outbox.candidate_id = candidate.candidate_id
      WHERE candidate.admission_semantic_input_sha256 = ?
        AND candidate.disposition = 'actionable'`,
  );
  const fixtures = new Set<string>();
  const proposals: { meeting_id: string; revision: unknown; approval_id: string }[] = [];
  let fixturePending = false;
  for (const source of sources) {
    for (const id of readStagingSyntheticCheckpointV1(source.cursor).manual) {
      if (stagingSyntheticCanaryReleaseV1(id) !== undefined) continue;
      fixtures.add(id);
      fixturePending = true;
    }
    for (const row of proposalsOf.all(source.semantic_input_sha256) as readonly { readonly meeting_id: unknown; readonly revision: unknown; readonly approval_id: string }[]) {
      if (typeof row.meeting_id !== "string") continue;
      if (row.meeting_id !== STAGING_SYNTHETIC_CANARY_MEETING_ID_V1) fixtures.add(row.meeting_id);
      proposals.push({ meeting_id: row.meeting_id, revision: row.revision, approval_id: row.approval_id });
    }
  }
  return Object.freeze({ fixtures, fixture_pending: fixturePending, proposals });
}

/**
 * Durable synthetic-source evidence: the owner's proposals and the published
 * records that approved them. With fixture meetings, every one must be
 * approved and none still queued; otherwise the release canary must be. Only
 * the canary revision for the release running on the exact staging host counts.
 */
function stagingSyntheticSourceEvidence(
  manifest: OrganizationAuthoritySetupManifestV3,
  authority: Database.Database,
  record: Database.Database,
): { readonly fixture_mode: boolean; readonly fixtures_approved: boolean; readonly canary_approved: boolean } | undefined {
  const source = readStagingSyntheticSource(manifest, authority);
  if (source === undefined) return undefined;
  const approved = record.prepare(
    `SELECT 1 FROM organization_record_log
      WHERE event_kind = 'approved' AND action = 'approve' AND approval_id = ?
      LIMIT 1`,
  );
  const approvedProposals = source.proposals.filter((proposal) => approved.get(proposal.approval_id) !== undefined);
  const approvedMeetings = new Set(approvedProposals.map((proposal) => proposal.meeting_id));
  const releaseId = process.env.ECHO_CLEAN_RELEASE_ID;
  const currentCanaryRevision =
    process.env.ECHO_CLEAN_AUTHORITY_HOST === STAGING_SYNTHETIC_CANARY_HOST && releaseId !== undefined && CLEAN_V1_RELEASE_ID.test(releaseId)
      ? stagingSyntheticCanaryMeetingV1(releaseId).provenance.canonical_revision
      : undefined;
  return Object.freeze({
    fixture_mode: source.fixtures.size > 0,
    fixtures_approved: source.fixtures.size > 0 && !source.fixture_pending && [...source.fixtures].every((id) => approvedMeetings.has(id)),
    canary_approved: currentCanaryRevision !== undefined && approvedProposals.some((proposal) =>
      proposal.meeting_id === STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 && proposal.revision === currentCanaryRevision),
  });
}

/**
 * Read only durable proof. The head and active-generation pointer are read
 * before and after the proof query: any append or generation publication in
 * between makes the terminal claim fail closed until the owner reruns status.
 */
function setupCanaryEvidence(
  manifest: OrganizationAuthoritySetupManifestV3,
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
             ON admission.source_key = 1
            AND admission.semantic_input_sha256 =
                progress.admission_semantic_input_sha256
          WHERE progress.source_key = 1
            AND progress.cursor_version > 0
          LIMIT 1`,
      )
      .get() !== undefined;
    const synthetic = stagingSyntheticSourceEvidence(manifest, authority, record);
    const syntheticStagingCanaryObserved = synthetic?.canary_approved ?? false;
    const approvedRecordPresent = record
      .prepare(
        `SELECT 1 FROM organization_record_log
          WHERE event_kind = 'approved' AND action = 'approve'
          LIMIT 1`,
      )
      .get() !== undefined;
    const expectedRetrievalContract =
      expectedSetupCanaryRetrievalContract();
    const activeGenerationCurrent = pointerMatchesHead(
      initialPointer,
      initialHead,
      manifest.organization_id,
    ) &&
      initialPointer.retrieval_contract_sha256 ===
        expectedRetrievalContract.retrieval_contract_sha256;
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
    const sourceEvidence = synthetic === undefined
      ? sourceProgressObserved
      : synthetic.fixture_mode ? synthetic.fixtures_approved : synthetic.canary_approved;
    const complete =
      sourceEvidence &&
      approvedRecordPresent &&
      activeGenerationCurrent &&
      ownerLayer1ReadAfterHead &&
      ownerLayer2ReadAfterGeneration;
    return Object.freeze({
      source_progress_observed: sourceProgressObserved,
      synthetic_staging_canary_observed: syntheticStagingCanaryObserved,
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
  manifest: OrganizationAuthoritySetupManifestV3,
  dependencies?: OrganizationAuthoritySetupCliDependencies,
): SetupCanaryEvidence {
  return (dependencies?.read_setup_canary_evidence?.(manifest) ??
    setupCanaryEvidence(manifest));
}

function initialOwnerSetupStatus(
  manifest: OrganizationAuthoritySetupManifestV3,
): InitialOwnerSetupStatus {
  const empty: InitialOwnerSetupStatus = {
    founder_oidc_bound: false,
    founder_slack_link_active: false,
    llm_credential_valid: false,
    source_admission_present: false,
  };
  try {
    verifySetupGenesis(manifest);
    const authority = new Database(join(manifest.state_directory, "authority.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    let initialOwnerOidcBound = false;
    let admittedSourceMode: InitialOwnerSetupStatus["source_mode"];
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
      const synthetic = readStagingSyntheticSource(manifest, authority);
      if (synthetic !== undefined) {
        admittedSourceMode = synthetic.fixtures.size > 0 ? "staging_synthetic" : "staging_canary";
      }
    } finally {
      authority.close();
    }
    let llmCredentialValid = false;
    try {
      void readPrivateAuthorityCredential(`file:${manifest.llm_credential_file}`);
      llmCredentialValid = true;
    } catch {}
    const slackStatus = readInitialOwnerSlackSetupStatusV1({
      state_directory: manifest.state_directory,
      principal_id: manifest.owner_principal_id, membership_id: manifest.owner_membership_id,
    });
      return Object.freeze({
        founder_oidc_bound: initialOwnerOidcBound,
        founder_slack_link_active: slackStatus.identity_link_active,
        llm_credential_valid: llmCredentialValid,
        source_admission_present: admittedSourceMode !== undefined,
        ...(admittedSourceMode === undefined
          ? {}
          : { source_mode: admittedSourceMode }),
      });
  } catch {
    return Object.freeze(empty);
  }
}

async function bootstrap(
  input: BootstrapInput,
  io: CliIo,
  dependencies: OrganizationAuthoritySetupCliDependencies,
): Promise<void> {
  // This must happen before a durable setup plan or genesis. The same current
  // OIDC parser and callback rule power the Person CLI. Bootstrap never touches
  // Slack: an owner sets it up in the ECHO app once the Authority runs.
  const oidc = readPersonOidcConfiguration(input.oidc_config_path);
  assertPersonAuthorityCallback(input.authority_url, oidc.configuration);
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
  const invitationPath = manifest.invitation_path;
  const full = readInitialOwnerSetupStatus(manifest, dependencies);
  const initialOwnerAlreadyBound = full.founder_oidc_bound;
  const invitationIsUsable = () =>
    dependencies.read_setup_stage === undefined
      ? usableInitialOwnerInvitation(manifest)
      : stage().invitation_file_present;
  if (!initialOwnerAlreadyBound && !invitationIsUsable()) {
    discardUnusableInvitation(invitationPath);
    if (isExpectedPersonEmail(manifest.owner_email)) {
      await dependencies.issue_invitation({
        state_directory: input.state_directory,
        oidc_config_path: input.oidc_config_path,
        pkce_key_file: manifest.pkce_key_file,
        membership_id: manifest.owner_membership_id,
        expected_email: input.owner_email,
        authority_url: input.authority_url,
        output_path: invitationPath,
      });
    } else {
      const oidc = readPersonOidcConfiguration(manifest.oidc_config_path);
      reissueLegacyPersonOnboardingInvitation({
        state_directory: manifest.state_directory,
        oidc: oidc.configuration,
        pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
          `file:${manifest.pkce_key_file}`,
        ),
        organization_id: manifest.organization_id,
        principal_id: manifest.owner_principal_id,
        membership_id: manifest.owner_membership_id,
        expected_email: manifest.owner_email,
        authority_url: manifest.authority_url,
        output_path: invitationPath,
      });
    }
  }
  const completedStage = stage();
  const completedFull = readInitialOwnerSetupStatus(manifest, dependencies);
  const nextStep = nextOrganizationAuthoritySetupStep({
    authority_url: manifest.authority_url,
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
    authority_url: manifest.authority_url,
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
    ((manifest.authority_url !== STAGING_SYNTHETIC_CANARY_ORIGIN && !sourceAdmissionPresent(full)) ||
      readSetupCanaryEvidence(manifest, dependencies).complete)
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
  if (manifest.llm_credential_file !== join(input.state_directory, "credentials", LLM_CREDENTIAL_FILENAME)) {
    throw new Error("organization setup does not have the fixed LLM credential destination");
  }
  const llmCredential = readPrivateAuthorityCredential(`file:${input.llm_credential_source}`);
  installPrivateCredentialValue(manifest.llm_credential_file, llmCredential);
  if (!llmCredentialValid(initialOwnerSetupStatus(manifest))) {
    throw new Error("organization setup LLM credential did not install");
  }
  io.stdout(`${canonicalJson({ ok: true, credentials_ready: true, next_instruction: "Run echo-organization-authority-setup status to continue." } as never)}\n`);
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
  const stage = dependencies.read_setup_stage?.(manifest) ?? durableSetupStage(manifest);
  const missing = [
    !full.founder_oidc_bound && "initial-owner OIDC binding",
    !stage.slack_connected && "organization Slack connection",
    !full.founder_slack_link_active && "initial-owner Slack identity link",
    !llmCredentialValid(full) && "LLM credential",
  ].filter((value): value is string => typeof value === "string");
  if (missing.length > 0) {
    throw new Error(
      `organization setup finalize requires ${missing.join(", ")}`,
    );
  }
  const stagingSyntheticMeetingsDirectory =
    input.staging_synthetic_meetings_directory === undefined
      ? undefined
      : assertStagingSyntheticMeetingSourceSelectionV1({
          authority_url: manifest.authority_url,
          meetings_directory: input.staging_synthetic_meetings_directory,
        });
  const staging = manifest.authority_url === STAGING_SYNTHETIC_CANARY_ORIGIN;
  if (staging) {
    // Staging admits no organization source: the owner's synthetic personal
    // source carries the release canary and, when selected, the fixture meetings.
    await (dependencies.queue_staging_synthetic_meetings ?? queueStagingSyntheticSetupMeetings)({
      state_directory: manifest.state_directory,
      ...(stagingSyntheticMeetingsDirectory === undefined ? {} : { meetings_directory: stagingSyntheticMeetingsDirectory }),
      llm_credential_file: manifest.llm_credential_file,
    });
  }
  io.stdout(
    `${canonicalJson({
      ok: true,
      runtime_status: "ready_to_start",
      runtime_observation: "not_observed",
      canary_status: staging ? "not_complete" : "not_required",
      source_mode: !staging ? "none" : stagingSyntheticMeetingsDirectory === undefined ? "staging_canary" : "staging_synthetic",
      source_admission_present: staging,
      next_instruction:
        !staging
          ? "Start or restart the Authority runtime. Meeting intake remains idle until a personal source is connected."
          : stagingSyntheticMeetingsDirectory === undefined
            ? "Restart the Authority runtime, then run the synthetic canary."
            : "Restart the same echo-organization-authority-serve serve command with the same staging synthetic fixture selector.",
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
        schema_version: 2,
        kind: "echo-organization-authority-setup-status-v2",
        setup_plan_present: false,
        genesis_published: false,
        credentials_ready: false,
        slack_connected: false,
        invitation_file_present: false,
        founder_invitation_valid: false,
        founder_oidc_bound: false,
        founder_slack_link_active: false,
        llm_credential_valid: false,
        source_mode: "none",
        source_admission_present: false,
        source_progress_observed: false,
        synthetic_staging_canary_observed: false,
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
    authority_url: setup.manifest.authority_url,
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
  const ordinarySourceFree = nextStep === "ready_to_start" &&
    setup.manifest.authority_url !== STAGING_SYNTHETIC_CANARY_ORIGIN && !sourceAdmissionPresent(full);
  const terminalStep: OrganizationAuthoritySetupNextStep = canary.complete || ordinarySourceFree
    ? "complete"
    : nextStep;
  const canaryStatus = ordinarySourceFree ? "not_required" : terminalStep === "complete"
    ? "complete"
    : nextStep === "ready_to_start"
      ? "not_complete"
      : "not_ready";
  io.stdout(
    `${canonicalJson({
      schema_version: 2,
      kind: "echo-organization-authority-setup-status-v2",
      setup_plan_present: true,
      genesis_published: genesisPublished,
      credentials_ready: credentialsReady,
      slack_connected: slackConnected,
      invitation_file_present: invitationFilePresent,
      founder_invitation_valid: invitationValid,
      founder_oidc_bound: full.founder_oidc_bound,
      founder_slack_link_active: full.founder_slack_link_active,
      llm_credential_valid: llmCredentialValid(full),
      source_mode: sourceMode(full),
      source_admission_present: sourceAdmissionPresent(full),
      source_progress_observed: canary.source_progress_observed,
      synthetic_staging_canary_observed:
        canary.synthetic_staging_canary_observed ?? false,
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
      await resume(parseStateDirectory(argv.slice(1)), io, dependencies);
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
      status(parseStateDirectory(argv.slice(1)), io, dependencies);
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
