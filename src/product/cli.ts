#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AdapterInstanceConfig } from "../core/index.js";
import {
  assertConfiguredAdapterFactoriesAvailable,
  assertConfiguredAdaptersValid,
  createConfiguredAdapterRegistry,
  type ProductAdapterFactoryRegistry,
} from "./adapter-factories.js";
import {
  assertProductAccess,
  assertRetiredFounderProvenanceRefused,
  DEFAULT_ORGANIZATION_RECORD_SWEEP_TIMEOUT_MS,
  prepareProductComposition,
  prepareProductStateRoot,
  resolveProductClock,
  type PrepareProductCompositionOptions,
  type ProductAccessGate,
  type ProductComposition,
} from "./composition.js";
import {
  classifyStateFilesystem,
  loadProductRuntimeConfig,
  type ClassifyStateFilesystem,
  type ProductRuntimeConfig,
} from "./config.js";
import { createDefaultAdapterFactories } from "./default-adapters.js";
import { DecisionNodeStore } from "./approval/decision-node-store.js";
import { projectDecisionOrganizationRecord } from "./approval/decision-node.js";
import { ProductRuntimeFailure } from "./runtime.js";
import { diagnoseConfiguredAdapters } from "./adapter-diagnostics.js";
import {
  createProductBootstrapCredential,
  createProductOnboardConfig,
  onboardProduct,
  ProductOperator,
  ProductOperatorError,
  type ProductOperatorDependencies,
  type ProductServiceAction,
} from "./operator-lifecycle.js";
import {
  acquireProductLifecycleLock,
  acquireProductMaintenanceLease,
  canonicalProductConfigSha256,
  type ProductMaintenanceLease,
  type ProductLifecycleLockKind,
  type ReleaseProductLifecycleLock,
} from "./lifecycle-lock.js";
import {
  createProductStateBackup,
  restoreProductStateBackup,
} from "./state-backup.js";
import { FileInstallationSigner } from "./machine/security/file-installation-signer.js";
import type { InstallationSigner } from "./machine/security/installation-signer.js";
import {
  createLocalOrganizationRuntime,
  createOrganizationIngestExclusion,
  DEFAULT_LOCAL_ORGANIZATION_ACCESS_CLOCK_SKEW_MS,
  MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS,
  HttpOrganizationAuthorityClient,
  HttpOrganizationRecordClient,
  OrganizationApprovalActionAuthorizer,
  OrganizationRecordSubmitter,
  OrganizationRuntimeAccessController,
  OrganizationAuthorityTransportError,
  organizationEnrollmentGrantSha256,
  ProtocolOrganizationRecordEnvelopeBuilder,
  readPrivateOrganizationEnrollmentInvitation,
  reviewerApprovalPresentationRenderer,
  SqliteOrganizationStateStore,
  validateOrganizationAuthorityDescriptorResponse,
  type HttpOrganizationAuthorityClientOptions,
  type OrganizationInstallationAccessDecisionV1,
  type OrganizationIngestExclusion,
  type OrganizationRecordSweepResult,
  type PinnedOrganizationAuthority,
  type StoredOrganizationEnrollment,
  verifyOrganizationAuthorityPin,
} from "./organization/index.js";
import {
  classifyOrganizationComposition,
  type OrganizationCompositionState,
} from './organization/state/organization-composition-state.js';
import type { OrganizationApprovalActionAuthorizerOptions } from './organization/approval-action-authorizer.js';
import type { OrganizationStateStore } from './organization/state/organization-state-store.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from "./machine/security/installation-signer.js";
import { readPrivateCredentialFile } from "./credentials.js";
import { resolveProductStatePaths } from "./paths.js";
import { readFileNoFollow } from "./secure-local-files.js";
import {
  GRANOLA_API_KEY_RE,
  HttpGranolaApiClient,
  observeGranolaRecordOwner,
  type GranolaRecordOwnerObservation,
} from "../adapters/meeting-sources/granola/index.js";
import { SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION } from "../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js";
import {
  loadPackagedBuildIdentity,
  type PackagedBuildIdentityV1,
} from "./build-identity.js";
import {
  runInternalLiveUpdate,
  type RunInternalLiveUpdateOptions,
} from "./update/internal-live-runner.js";
import { parseJson } from "../util/json.js";
import { nodeOperatorFileSystem } from "./operator-io.js";

export interface ProductCliProcess {
  once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  removeListener: (
    event: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => unknown;
}

export interface ProductCliDependencies {
  classifyStateFilesystem?: ClassifyStateFilesystem;
  process?: ProductCliProcess;
  stdout?: Pick<Writable, "write">;
  stderr?: Pick<Writable, "write">;
  adapterFactories?: ProductAdapterFactoryRegistry;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  composition?: Omit<
    PrepareProductCompositionOptions,
    "classifyStateFilesystem"
  >;
  operator?: Partial<ProductOperatorDependencies>;
  doctorHealthTimeoutMs?: number;
  acquireLifecycleLock?: (
    stateDirectory: string,
    kind: ProductLifecycleLockKind,
    options: { timeoutMs: number },
  ) => Promise<ReleaseProductLifecycleLock>;
  organization?: {
    installationSigner?: InstallationSigner;
    fetch?: typeof fetch;
    createInstallationId?: () => string;
    allowInsecureLoopback?: boolean;
  };
  internalLive?: {
    execute?: (
      options: RunInternalLiveUpdateOptions,
    ) => ReturnType<typeof runInternalLiveUpdate>;
  };
  bootstrap?: {
    /** Test/host seam; the default reads a hidden value from the controlling TTY. */
    readGranolaCredential?: () => string | Promise<string>;
    /** Test seam for the bounded, read-only Granola owner observation. */
    observeGranolaRecordOwner?: (
      credential: string,
      ownerEmail: string,
    ) => Promise<GranolaRecordOwnerObservation>;
    /** Test/host seam; the default reads a second hidden value from the TTY. */
    readSlackCredential?: () => string | Promise<string>;
  };
}

type CliCommand =
  | "bootstrap"
  | "init"
  | "reconfigure"
  | "status"
  | "doctor"
  | "organization"
  | "update"
  | "service"
  | "service-run"
  | "backup"
  | "restore"
  | "validate-config"
  | "run-once"
  | "approvals";

interface ParsedCommand {
  command: CliCommand;
  /** The validated sub-action word of `organization`, `update`, or `service`. */
  action?: string;
  configPath: string;
  stateDirectory?: string;
  backupRoot?: string;
  backupDirectory?: string;
  operationId?: string;
  allowExportableSoftwareKey: boolean;
  doctorLocalOnly: boolean;
  ownerEmail?: string;
  slackChannelId?: string;
  slackReviewerUserId?: string;
  slackReviewerName?: string;
  slackLinkAttemptId?: string;
  slackLinkMessageTs?: string;
  invitationPath?: string;
  authorityPin?: string;
  authorityUrl?: string;
  authorityCaPath?: string;
  query?: string;
}

const PRODUCT_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;
const CLI_PATH = realpathSync(fileURLToPath(import.meta.url));
let cachedBuildIdentity: PackagedBuildIdentityV1 | undefined;

function packagedBuildIdentity(): PackagedBuildIdentityV1 {
  if (cachedBuildIdentity !== undefined) return cachedBuildIdentity;
  try {
    cachedBuildIdentity = loadPackagedBuildIdentity();
  } catch (error) {
    // Tests import the TypeScript source rather than the packaged CLI, so no
    // generated build identity exists there. A distributed CLI must always
    // carry the generated identity and fails closed if it is unavailable.
    if (!CLI_PATH.endsWith(".ts")) throw error;
    cachedBuildIdentity = {
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: PRODUCT_VERSION,
      source_sha: "0".repeat(40),
      source_kind: "worktree-head-unverified",
    };
  }
  if (cachedBuildIdentity.product_version !== PRODUCT_VERSION) {
    throw new Error(
      "packaged build identity version does not match package.json",
    );
  }
  return cachedBuildIdentity;
}

const HELP = `echo-brain ${PRODUCT_VERSION}

Usage:
  echo-brain bootstrap --config <new-absolute-path> --state-dir <new-absolute-path> --owner-email <canonical-lowercase-email> --slack-channel-id <C...> --slack-reviewer-user-id <U...> --slack-reviewer-name <name> --invitation <absolute-path> --authority-pin <sha256:...> [--authority-ca <absolute-path>] --allow-exportable-software-key
  echo-brain init --config <absolute-path>
  echo-brain reconfigure --config <absolute-path>
  echo-brain status --config <absolute-path>
  echo-brain doctor --config <absolute-path> [--local-only]
  echo-brain organization enroll --config <absolute-path> --invitation <absolute-path> --authority-pin <sha256:...> [--authority-ca <absolute-path>] --allow-exportable-software-key
  echo-brain organization status --config <absolute-path>
  echo-brain organization refresh --config <absolute-path>
  echo-brain organization record-flush --config <absolute-path>
  echo-brain organization recent-decisions --config <absolute-path>
  echo-brain organization reviewer-recent-decisions --config <absolute-path>
  echo-brain organization readable-search --config <absolute-path> --query <text>
  echo-brain organization rebind --config <absolute-path> --authority-url <https-origin> --authority-pin <sha256:...> [--authority-ca <absolute-path>]
  echo-brain organization slack-link-begin --config <absolute-path>
  echo-brain organization slack-link-complete --config <absolute-path> --challenge-attempt <cat_...> --challenge-message-ts <Slack timestamp>  # reads ECHO_SLACK_LINK_CODE
  echo-brain update apply --channel internal-live --config <absolute-path>
  echo-brain service <install|start|stop|restart|status|uninstall> --config <absolute-path>
  echo-brain backup --config <absolute-path> --backup-root <absolute-path> [--id <operation-id>]
  echo-brain restore --config <absolute-path> --backup <absolute-path> --backup-root <absolute-path> --id <operation-id>
  echo-brain validate-config --config <absolute-path>
  echo-brain run-once --config <absolute-path>
  echo-brain approvals --config <absolute-path>
  echo-brain --version
  echo-brain --help
`;

function print(stream: Pick<Writable, "write">, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

const OPTIONS = {
  config: { type: "string" },
  "state-dir": { type: "string" },
  id: { type: "string" },
  "backup-root": { type: "string" },
  backup: { type: "string" },
  invitation: { type: "string" },
  "authority-pin": { type: "string" },
  "authority-url": { type: "string" },
  "authority-ca": { type: "string" },
  query: { type: "string" },
  "challenge-attempt": { type: "string" },
  "challenge-message-ts": { type: "string" },
  channel: { type: "string" },
  "owner-email": { type: "string" },
  "slack-channel-id": { type: "string" },
  "slack-reviewer-user-id": { type: "string" },
  "slack-reviewer-name": { type: "string" },
  "local-only": { type: "boolean" },
  "allow-exportable-software-key": { type: "boolean" },
} as const;

type CliOption = keyof typeof OPTIONS;

interface CommandRule {
  /** Options accepted in addition to the always-required `--config`. */
  accepts?: readonly CliOption[];
  /** Options the command cannot run without. */
  requires?: readonly CliOption[];
  /** Path options that must be absolute, in addition to `--config`. */
  absolute?: readonly CliOption[];
}

const NONE: CommandRule = {};
const SERVICE_ACTIONS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "uninstall",
] as const;

/**
 * One explicit rule per public command or command/action pair, plus the hidden
 * `service-run` the LaunchAgent invokes. Everything the parser enforces -- the
 * options a command accepts, the ones it cannot run without, and the ones that
 * must be absolute paths -- is stated here, so an unlisted or missing option is
 * refused deterministically instead of being silently ignored.
 */
const RULES: Readonly<Record<string, CommandRule>> = {
  bootstrap: {
    accepts: [
      "state-dir",
      "owner-email",
      "slack-channel-id",
      "slack-reviewer-user-id",
      "slack-reviewer-name",
      "invitation",
      "authority-pin",
      "authority-ca",
      "allow-exportable-software-key",
    ],
    requires: [
      "state-dir",
      "owner-email",
      "slack-channel-id",
      "slack-reviewer-user-id",
      "slack-reviewer-name",
      "invitation",
      "authority-pin",
    ],
    absolute: ["state-dir", "invitation", "authority-ca"],
  },
  init: NONE,
  reconfigure: NONE,
  status: NONE,
  doctor: { accepts: ["local-only"] },
  "organization enroll": {
    accepts: [
      "invitation",
      "authority-pin",
      "authority-ca",
      "allow-exportable-software-key",
    ],
    requires: ["invitation", "authority-pin"],
    absolute: ["invitation", "authority-ca"],
  },
  "organization status": NONE,
  "organization refresh": NONE,
  "organization record-flush": NONE,
  "organization recent-decisions": NONE,
  "organization reviewer-recent-decisions": NONE,
  "organization readable-search": { accepts: ["query"], requires: ["query"] },
  "organization rebind": {
    accepts: ["authority-url", "authority-pin", "authority-ca"],
    requires: ["authority-url", "authority-pin"],
    absolute: ["authority-ca"],
  },
  "organization slack-link-begin": NONE,
  "organization slack-link-complete": {
    accepts: ["challenge-attempt", "challenge-message-ts"],
    requires: ["challenge-attempt", "challenge-message-ts"],
  },
  "update apply": { accepts: ["channel"], requires: ["channel"] },
  ...Object.fromEntries(
    SERVICE_ACTIONS.map((action) => [`service ${action}`, NONE] as const),
  ),
  backup: {
    accepts: ["backup-root", "id"],
    requires: ["backup-root"],
    absolute: ["backup-root"],
  },
  restore: {
    accepts: ["backup-root", "backup", "id"],
    requires: ["backup-root", "backup", "id"],
    absolute: ["backup-root", "backup"],
  },
  "validate-config": NONE,
  "run-once": NONE,
  approvals: NONE,
  "service-run": NONE,
};

/** Commands that take a required sub-action word before their options. */
const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  organization: [
    "enroll",
    "status",
    "refresh",
    "record-flush",
    "recent-decisions",
    "reviewer-recent-decisions",
    "readable-search",
    "rebind",
    "slack-link-begin",
    "slack-link-complete",
  ],
  update: ["apply"],
  service: SERVICE_ACTIONS,
};

/** `service-run` is a launchd implementation detail and stays unadvertised. */
const HIDDEN_COMMANDS = new Set(["service-run"]);

function commandUsage(): string {
  const names = [
    ...new Set(Object.keys(RULES).map((key) => key.split(" ")[0]!)),
  ].filter((name) => !HIDDEN_COMMANDS.has(name));
  return `usage: echo-brain <${names.join("|")}> --config <absolute-path>`;
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0] ?? "";
  const actions = ACTIONS[command];
  const action = actions === undefined ? undefined : argv[1];
  if (
    actions !== undefined &&
    (action === undefined || !actions.includes(action))
  ) {
    throw new Error(
      `usage: echo-brain ${command} <${actions.join("|")}> --config <absolute-path>`,
    );
  }
  const key = action === undefined ? command : `${command} ${action}`;
  const rule = RULES[key];
  if (rule === undefined) throw new Error(commandUsage());

  const parsed = parseArgs({
    args: [...argv.slice(actions === undefined ? 1 : 2)],
    strict: true,
    allowPositionals: false,
    options: OPTIONS,
  });
  const values = parsed.values as Record<
    CliOption,
    string | boolean | undefined
  >;
  const text = (name: CliOption): string | undefined => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };

  const accepted = new Set<string>(["config", ...(rule.accepts ?? [])]);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !accepted.has(name)) {
      throw new Error(`--${name} is not valid with \`echo-brain ${key}\``);
    }
  }
  for (const name of ["config", ...(rule.requires ?? [])] as const) {
    if (values[name] === undefined) {
      throw new Error(`\`echo-brain ${key}\` requires --${name}`);
    }
  }
  for (const name of ["config", ...(rule.absolute ?? [])] as const) {
    const value = text(name);
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error(`--${name} must be an absolute path`);
    }
  }
  if (key === "update apply" && text("channel") !== "internal-live") {
    throw new Error("update apply requires --channel internal-live");
  }

  return {
    command: command as CliCommand,
    action,
    configPath: text("config")!,
    stateDirectory: text("state-dir"),
    backupRoot: text("backup-root"),
    backupDirectory: text("backup"),
    operationId: text("id"),
    allowExportableSoftwareKey:
      values["allow-exportable-software-key"] === true,
    doctorLocalOnly: values["local-only"] === true,
    ownerEmail: text("owner-email"),
    slackChannelId: text("slack-channel-id"),
    slackReviewerUserId: text("slack-reviewer-user-id"),
    slackReviewerName: text("slack-reviewer-name"),
    slackLinkAttemptId: text("challenge-attempt"),
    slackLinkMessageTs: text("challenge-message-ts"),
    invitationPath: text("invitation"),
    authorityPin: text("authority-pin"),
    authorityUrl: text("authority-url"),
    authorityCaPath: text("authority-ca"),
    query: text("query"),
  };
}

/**
 * Classify the state filesystem, or report the one shared refusal and answer
 * `null`. Every command that will not work off a local disk prints the same
 * shape, keeping its own action and command-specific fields intact.
 */
async function requireLocalState(
  parsed: ParsedCommand,
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
  stderr: Pick<Writable, "write">,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<ClassifyStateFilesystem>> | null> {
  const filesystem = await classifier(config.state_dir);
  if (filesystem.kind === "local") return filesystem;
  print(stderr, {
    ok: false,
    command: parsed.command,
    ...(parsed.action === undefined ? {} : { action: parsed.action }),
    ...extra,
    filesystem,
  });
  return null;
}

function adapterReference(config: AdapterInstanceConfig): {
  adapter_id: string;
  instance_id: string;
} {
  return { adapter_id: config.adapter_id, instance_id: config.instance_id };
}

function configuredAdapterReferences(config: ProductRuntimeConfig) {
  return {
    meeting_sources: config.meeting_sources.map(adapterReference),
    decision_processor: adapterReference(config.decision_processor),
    delivery_surfaces: config.delivery_surfaces.map(adapterReference),
    ...(config.approval_mode === "adapter"
      ? { approval_surface: adapterReference(config.approval_surface) }
      : {}),
  };
}

function shellSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function configuredSlackApprovalSurface(config: ProductRuntimeConfig): {
  instance_id: string;
  channel_id: string;
  reviewer_user_id: string;
} {
  if (
    config.approval_mode !== "adapter" ||
    config.approval_surface.adapter_id !== "slack-reactions"
  ) {
    throw new Error(
      "this installation has no organization-linkable Slack approval surface",
    );
  }
  const channelId = config.approval_surface.settings["channel_id"];
  if (typeof channelId !== "string" || !/^C[A-Z0-9]{2,}$/.test(channelId)) {
    throw new Error(
      "the configured Slack approval surface has no valid channel",
    );
  }
  const reviewer = config.approval_surface.settings["reviewer"];
  const reviewerUserId =
    typeof reviewer === "object" &&
    reviewer !== null &&
    !Array.isArray(reviewer) &&
    typeof (reviewer as Record<string, unknown>)["slack_user_id"] ===
      "string"
      ? (reviewer as Record<string, string>)["slack_user_id"]
      : undefined;
  if (
    typeof reviewerUserId !== "string" ||
    !/^[UW][A-Z0-9]{2,}$/.test(reviewerUserId)
  ) {
    throw new Error(
      "the configured Slack approval surface has no valid reviewer identity",
    );
  }
  return {
    instance_id: config.approval_surface.instance_id,
    channel_id: channelId,
    reviewer_user_id: reviewerUserId,
  };
}

interface SignalWaiter {
  readonly promise: Promise<"SIGINT" | "SIGTERM">;
  readonly received: "SIGINT" | "SIGTERM" | undefined;
  cancel(): void;
}

function createSignalWaiter(processLike: ProductCliProcess): SignalWaiter {
  let active = true;
  let received: "SIGINT" | "SIGTERM" | undefined;
  let resolveSignal: (signal: "SIGINT" | "SIGTERM") => void = () => undefined;
  const promise = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    resolveSignal = resolve;
  });
  const cleanup = () => {
    if (!active) return;
    active = false;
    processLike.removeListener("SIGINT", onInterrupt);
    processLike.removeListener("SIGTERM", onTerminate);
  };
  const receive = (signal: "SIGINT" | "SIGTERM") => {
    if (!active) return;
    received = signal;
    cleanup();
    resolveSignal(signal);
  };
  const onInterrupt = () => receive("SIGINT");
  const onTerminate = () => receive("SIGTERM");
  try {
    processLike.once("SIGINT", onInterrupt);
    processLike.once("SIGTERM", onTerminate);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    promise,
    get received() {
      return received;
    },
    cancel: cleanup,
  };
}

function printRuntimeFailure(
  stderr: Pick<Writable, "write">,
  error: unknown,
): void {
  const failure =
    error instanceof ProductRuntimeFailure
      ? error
      : new ProductRuntimeFailure(
          "adapter_unavailable",
          (error as Error).message,
          [(error as Error).message],
        );
  print(stderr, {
    ok: false,
    code: failure.code,
    error: failure.message,
    details: failure.details,
  });
}

/**
 * The CLI shares the one retirement gate with composition and the decision
 * store; it only maps the refusal onto the CLI's failure type.
 */
function refuseRetiredFounderProvenance(stateDirectory: string): void {
  assertRetiredFounderProvenanceRefused(stateDirectory);
}

/**
 * The single early dispatch policy for the retired founder-provenance fence.
 *
 * It gates product work: no product-work command, runtime start, or new
 * processing cycle resumes on a fenced profile. `runProductCli` consults this
 * once, as soon as the state path is known and before it constructs a
 * `ProductOperator`, probes or classifies the filesystem, acquires a lifecycle
 * lock, creates or chmods a directory, installs signal handlers, resolves
 * credentials, opens or migrates SQLite, contacts a provider or the Authority,
 * or invokes an injected callback.
 *
 * The listed exceptions are not "everything that does not write": several of
 * them do write. They are the commands whose whole purpose is to diagnose,
 * preserve, or quiesce a fenced profile, and each is safe only because of what
 * its own implementation already does:
 *
 * - `--help` / `--version` never touch a state path at all;
 * - `validate-config` reports on configuration;
 * - `status` reports operator/service state;
 * - `backup` preserves the profile (state files byte-for-byte, SQLite as a
 *   consistent SQLite backup), and `restore`'s own preflight refuses founder
 *   residue in the target and in the validated payload before changing any
 *   state;
 * - `service stop`, `status`, and `uninstall` quiesce a fenced machine.
 *
 * `organization status` is deliberately NOT an exception: it opens and migrates
 * writable SQLite, so it is gated with every other organization action.
 *
 * The shared fence refusal carries the recovery runbook. Its order matters:
 * `backup` refuses while the service is loaded, so `service stop` comes first.
 */
function retiredProvenanceGateApplies(parsed: ParsedCommand): boolean {
  switch (parsed.command) {
    case "validate-config":
    case "status":
    case "backup":
    case "restore":
      return false;
    case "service":
      return (
        parsed.action === "install" ||
        parsed.action === "start" ||
        parsed.action === "restart"
      );
    default:
      // init, reconfigure, doctor, update, organization (every action),
      // approvals, run-once, service-run.
      return true;
  }
}

function organizationAuthorityTransportOptions(
  organization: ProductCliDependencies["organization"],
  authorityCaPem: string | null | undefined,
): Omit<HttpOrganizationAuthorityClientOptions, "baseUrl" | "timeoutMs"> {
  return {
    ...(organization?.fetch === undefined
      ? authorityCaPem === null || authorityCaPem === undefined
        ? {}
        : { authorityCaPem }
      : { fetch: organization.fetch }),
    ...(organization?.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: organization.allowInsecureLoopback }),
  };
}

interface ResolvedOrganizationAuthorization {
  accessGate: ProductAccessGate | undefined;
  approvalActionAuthorizer: OrganizationApprovalActionAuthorizer | undefined;
  recordSubmitter: OrganizationRecordSubmitter | undefined;
}

/**
 * The Slack reviewer renderer is pure local code, so it must be present even
 * before an installation has organization authority. In particular, startup
 * preflight needs it to fingerprint an unresolved frozen card's credential
 * and distinguish a real rotation from unavailable authority wiring.
 *
 * When authority is available, the exact same authorizer handles the legacy
 * approval path and the reviewer path.
 */
function approvalSurfaceFactoryOptions(
  approvalActionAuthorizer: OrganizationApprovalActionAuthorizer | undefined,
) {
  return {
    reviewerPresentationRenderer: reviewerApprovalPresentationRenderer,
    ...(approvalActionAuthorizer === undefined
      ? {}
      : {
          approvalActionAuthorizer,
          reviewerApprovalActionAuthorizer: approvalActionAuthorizer,
        }),
  };
}

function configuredOrganizationIngestExclusion(
  config: ProductRuntimeConfig,
): OrganizationIngestExclusion {
  return createOrganizationIngestExclusion(
    config.organization_ingest?.exclude ?? { sources: [], meetings: [] },
  );
}

interface DoctorOrganizationResolution {
  approvalActionAuthorizer: OrganizationApprovalActionAuthorizer | undefined;
  diagnostic: { ok: boolean; detail: string };
}

function configuredApprovalRequiresOrganizationAuthorization(
  config: ProductRuntimeConfig,
): boolean {
  if (config.approval_mode !== 'adapter') return false;
  const mode = config.approval_surface.settings['presentation_mode'];
  return (
    mode === 'restricted-reviewer-v1' ||
    mode === 'organization-member-readable-v1'
  );
}

function organizationInstallationSigner(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): InstallationSigner {
  return (
    dependencies.organization?.installationSigner ??
    new FileInstallationSigner(join(config.state_dir, 'installation', 'keys'))
  );
}

function createApprovalActionAuthorizer(input: {
  authorityBaseUrl: string;
  authorityCaPem: string | null;
  dependencies: ProductCliDependencies;
  signer: InstallationSigner;
  now: () => string;
  openState: OrganizationApprovalActionAuthorizerOptions['openState'];
}): OrganizationApprovalActionAuthorizer {
  return new OrganizationApprovalActionAuthorizer({
    openState: input.openState,
    authorityClient: new HttpOrganizationAuthorityClient({
      baseUrl: input.authorityBaseUrl,
      ...organizationAuthorityTransportOptions(
        input.dependencies.organization,
        input.authorityCaPem,
      ),
    }),
    installationSigner: input.signer,
    now: input.now,
  });
}

function snapshotEnrollmentReader(
  enrollment: StoredOrganizationEnrollment,
): Pick<OrganizationStateStore, 'readEnrollment' | 'close'> {
  let closed = false;
  return {
    readEnrollment() {
      if (closed) throw new Error('organization state reader is closed');
      return enrollment;
    },
    close() {
      closed = true;
    },
  };
}

async function resolveDoctorOrganization(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): Promise<DoctorOrganizationResolution> {
  const databasePath = resolveProductStatePaths(config.state_dir).database;
  const state = classifyOrganizationComposition(
    SqliteOrganizationStateStore.inspectReadOnly(databasePath),
  );
  if (state.kind === 'corrupt' || state.kind === 'unavailable') {
    return {
      approvalActionAuthorizer: undefined,
      diagnostic: {
        ok: false,
        detail: `organization state is ${state.kind}: ${state.detail}`,
      },
    };
  }
  if (state.kind === 'unmanaged') {
    const required = configuredApprovalRequiresOrganizationAuthorization(config);
    return {
      approvalActionAuthorizer: undefined,
      diagnostic: {
        ok: !required,
        detail: required
          ? 'the configured approval presentation requires organization authorization, but organization state is not configured'
          : state.source === 'pre-organization-schema'
            ? `organization is not configured; database schema v${String(state.schemaVersion)} predates organization state`
            : 'organization is not configured for this installation',
      },
    };
  }
  if (state.kind === 'pinned-unenrolled') {
    return {
      approvalActionAuthorizer: undefined,
      diagnostic: {
        ok: false,
        detail: `organization authority is pinned but enrollment is ${state.phase.replaceAll('-', ' ')}`,
      },
    };
  }
  if (state.kind === 'enrolled-disconnected') {
    return {
      approvalActionAuthorizer: undefined,
      diagnostic: {
        ok: false,
        detail:
          'organization enrollment is accepted but its authority connection is unavailable',
      },
    };
  }

  const signer = organizationInstallationSigner(config, dependencies);
  try {
    const expected = state.enrollment.request.installation_signing_key;
    const descriptor = await signer.inspect(
      state.enrollment.request.installation_id,
    );
    if (descriptor === null) {
      throw new Error('organization installation signing key is unavailable');
    }
    verifyInstallationKeyDescriptor(descriptor);
    if (
      descriptor.installation_id !==
        state.enrollment.request.installation_id ||
      descriptor.key_id !== expected.key_id ||
      descriptor.algorithm !== expected.algorithm ||
      descriptor.public_key_spki_der_base64 !==
        expected.public_key_spki_der_base64
    ) {
      throw new Error(
        'organization installation signer no longer matches the enrollment',
      );
    }
  } catch (error) {
    return {
      approvalActionAuthorizer: undefined,
      diagnostic: { ok: false, detail: (error as Error).message },
    };
  }
  return {
    approvalActionAuthorizer: createApprovalActionAuthorizer({
      authorityBaseUrl: state.authorityConnection.authority_base_url,
      authorityCaPem: state.authorityConnection.authority_ca_pem,
      dependencies,
      signer,
      now: resolveProductClock(dependencies.now),
      openState: () => snapshotEnrollmentReader(state.enrollment),
    }),
    diagnostic: {
      ok: true,
      detail:
        'organization enrollment, authority connection, and installation signer are locally consistent',
    },
  };
}

function readRuntimeOrganizationCompositionState(
  databasePath: string,
): OrganizationCompositionState {
  const state = new SqliteOrganizationStateStore(databasePath);
  try {
    return classifyOrganizationComposition(
      state.readCompositionObservation(),
    );
  } finally {
    state.close();
  }
}

function resolveOrganizationAuthorization(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): ResolvedOrganizationAuthorization {
  const databasePath = resolveProductStatePaths(config.state_dir).database;
  const organizationState = readRuntimeOrganizationCompositionState(databasePath);
  if (
    organizationState.kind === 'corrupt' ||
    organizationState.kind === 'unavailable'
  ) {
    throw new Error(
      `organization state is ${organizationState.kind}: ${organizationState.detail}`,
    );
  }
  if (organizationState.kind === 'enrolled-disconnected') {
    throw new Error(
      "organization authority connection is unavailable for approval authorization",
    );
  }
  const hasPin = organizationState.kind !== 'unmanaged';
  const enrolled = organizationState.kind === 'enrolled-connected';
  const authorityConnection =
    organizationState.kind === 'enrolled-connected' ||
    organizationState.kind === 'pinned-unenrolled'
      ? organizationState.authorityConnection
      : null;
  const authorityBaseUrl =
    authorityConnection?.authority_base_url ?? null;
  const authorityCaPem = authorityConnection?.authority_ca_pem ?? null;
  const pinnedAuthority =
    organizationState.kind === 'enrolled-connected' ||
    organizationState.kind === 'pinned-unenrolled'
      ? organizationState.pinnedAuthority
      : null;
  const enrollment =
    organizationState.kind === 'enrolled-connected' ||
    organizationState.kind === 'pinned-unenrolled'
      ? organizationState.enrollment
      : null;
  const configuredAccessGate = dependencies.composition?.accessGate;
  if (!enrolled && (configuredAccessGate !== undefined || !hasPin)) {
    return {
      accessGate: configuredAccessGate,
      approvalActionAuthorizer: undefined,
      recordSubmitter: undefined,
    };
  }
  const signer = organizationInstallationSigner(config, dependencies);
  const now = resolveProductClock(dependencies.now);
  const transport = organizationAuthorityTransportOptions(
    dependencies.organization,
    authorityCaPem,
  );
  // Unenrolled profiles retain the disposable rehearsal behavior. Once an
  // authority is pinned, authorization becomes mandatory and fail-closed.
  const accessGate =
    configuredAccessGate ??
    (!hasPin
      ? undefined
      : authorityBaseUrl === null
        ? {
            async assertAuthorized() {
              throw new Error(
                "organization authority connection is unavailable for the pinned organization",
              );
            },
          }
        : new OrganizationRuntimeAccessController({
            now,
            openRuntime: () =>
              createLocalOrganizationRuntime({
                databasePath,
                authorityBaseUrl,
                installationSigner: signer,
                clock: { now },
                ...transport,
              }),
          }));
  if (!enrolled || authorityBaseUrl === null) {
    return {
      accessGate,
      approvalActionAuthorizer: undefined,
      recordSubmitter: undefined,
    };
  }
  return {
    accessGate,
    approvalActionAuthorizer: createApprovalActionAuthorizer({
      authorityBaseUrl,
      authorityCaPem,
      dependencies,
      signer,
      now,
      openState: () => new SqliteOrganizationStateStore(databasePath),
    }),
    recordSubmitter: createOrganizationRecordSubmitter({
      config,
      dependencies,
      authorityBaseUrl,
      transport,
      pinnedAuthority,
      enrollment,
      signer,
      now,
    }),
  };
}

/**
 * Composes the organization record submitter for an enrolled installation.
 *
 * The submitter has no store of its own: the decision node's write-once slot
 * files are the whole state machine, so it opens the same append-only node
 * directory the approvals CLI reads.
 */
function createOrganizationRecordSubmitter(input: {
  config: ProductRuntimeConfig;
  dependencies: ProductCliDependencies;
  authorityBaseUrl: string;
  transport: Omit<
    HttpOrganizationAuthorityClientOptions,
    "baseUrl" | "timeoutMs"
  >;
  pinnedAuthority: PinnedOrganizationAuthority | null;
  enrollment: StoredOrganizationEnrollment | null;
  signer: InstallationSigner;
  now: () => string;
}): OrganizationRecordSubmitter | undefined {
  const request = input.enrollment?.request;
  if (input.pinnedAuthority === null || request === undefined) return undefined;
  const installationId = request.installation_id;
  const installationSigningKey = request.installation_signing_key;
  return new OrganizationRecordSubmitter({
    nodes: new DecisionNodeStore(input.config.state_dir, {
      now: input.dependencies.now,
    }),
    envelopes: new ProtocolOrganizationRecordEnvelopeBuilder({
      pinnedAuthority: input.pinnedAuthority,
      installationSigningKey,
      sign: (bytes) =>
        signWithInstallationKey(
          input.signer,
          installationId,
          installationSigningKey.key_id,
          bytes,
        ),
    }),
    client: new HttpOrganizationRecordClient({
      baseUrl: input.authorityBaseUrl,
      pinnedAuthority: input.pinnedAuthority,
      installationSigningKey,
      ...input.transport,
    }),
    installationId,
    // An absent section means nothing is excluded; an invalid one already
    // failed configuration validation, so the submitter never starts on a
    // list it could not read exactly.
    exclusion: configuredOrganizationIngestExclusion(input.config),
    now: input.now,
  });
}

interface OrganizationRecordFlushTransition {
  approval_id: string;
  outcome: "published" | "rejected";
  receipt_summary?: {
    schema_version: 1;
    kind: "echo-organization-record-receipt";
    authority_id: string;
    organization_id: string;
    envelope_id: string;
    envelope_sha256: string;
    installation_id: string;
    idempotency_key: string;
    position: number;
    record_hash: string;
    recorded_at: string;
  };
  rejection?: {
    envelope_id: string;
    envelope_sha256: string;
    idempotency_key: string;
    reason_code: string;
  };
}

/**
 * Runs the narrow operator recovery path for already-resolved records.
 *
 * The candidate ids are captured before the sweep, so output describes only
 * transitions caused (or completed idempotently) by this invocation. A prior
 * published receipt can never be misreported as fresh recovery evidence.
 */
async function flushOrganizationRecords(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): Promise<{
  ok: boolean;
  candidate_records: number;
  sweep: OrganizationRecordSweepResult;
  published_records: readonly OrganizationRecordFlushTransition[];
  rejected_records: readonly OrganizationRecordFlushTransition[];
}> {
  // The early dispatch gate ran before lifecycle acquisition. Re-check inside
  // the exclusive window before opening organization SQLite, inspecting the
  // signer, refreshing access, or contacting the Authority.
  refuseRetiredFounderProvenance(config.state_dir);
  const { accessGate, recordSubmitter } = resolveOrganizationAuthorization(
    config,
    dependencies,
  );
  try {
    if (recordSubmitter === undefined) {
      throw new Error(
        "organization record flush requires an enrolled, connected organization",
      );
    }
    await assertProductAccess(accessGate);
    const nodes = new DecisionNodeStore(config.state_dir, {
      now: dependencies.now,
    });
    const before = await nodes.listForSubmission();
    const candidates = new Set(
      before.nodes
        .filter(
          (node) =>
            node.organization_record.status === "pending" ||
            node.organization_record.status === "outbound",
        )
        .map((node) => node.approval_id),
    );
    // Exactly one awaited submitter sweep. This command does not construct a
    // product composition, adapter registry, or core state store.
    const sweep = await recordSubmitter.sweep({});
    const after = await nodes.listForSubmission();
    const transitions: OrganizationRecordFlushTransition[] = [];
    for (const node of after.nodes) {
      if (!candidates.has(node.approval_id)) continue;
      const record = node.organization_record;
      if (record.status === "published" && record.receipt !== null) {
        const receipt = record.receipt;
        transitions.push({
          approval_id: node.approval_id,
          outcome: "published",
          receipt_summary: {
            schema_version: receipt.schema_version,
            kind: receipt.kind,
            authority_id: receipt.authority_id,
            organization_id: receipt.organization_id,
            envelope_id: receipt.envelope_id,
            envelope_sha256: receipt.envelope_sha256,
            installation_id: receipt.installation_id,
            idempotency_key: receipt.idempotency_key,
            position: receipt.position,
            record_hash: receipt.record_hash,
            recorded_at: receipt.recorded_at,
          },
        });
      } else if (record.status === "rejected" && record.rejection !== null) {
        const rejection = record.rejection;
        transitions.push({
          approval_id: node.approval_id,
          outcome: "rejected",
          rejection: {
            envelope_id: rejection.envelope_id,
            envelope_sha256: rejection.envelope_sha256,
            idempotency_key: rejection.idempotency_key,
            reason_code: rejection.reason_code,
          },
        });
      }
    }
    return {
      // `sweep.ok` means no alert. A retry is deliberately alert-free in the
      // submitter because it remains recoverable, but this one-shot command
      // must not call an undelivered result successful.
      ok:
        sweep.ok &&
        sweep.retried === 0 &&
        sweep.rejected === 0 &&
        transitions.filter(
          (transition) => transition.outcome === "published",
        ).length === candidates.size,
      candidate_records: candidates.size,
      sweep,
      published_records: transitions.filter(
        (transition) => transition.outcome === "published",
      ),
      rejected_records: transitions.filter(
        (transition) => transition.outcome === "rejected",
      ),
    };
  } finally {
    await accessGate?.close?.();
  }
}

/**
 * Serializes organization-record sweeps without losing an approval that
 * resolves while a service-cycle sweep is already looking at the node set.
 *
 * The first caller receives one outer batch promise. A request that arrives
 * while its first physical sweep runs adds one signal-free follow-up to that
 * same batch, so its result carries both passes and composition cannot close
 * between them. The coordinator owns a lifetime abort controller for each
 * physical pass and its `close()` drains the active batch before the runtime
 * lock is released. Requests during the follow-up share that batch instead of
 * scheduling a third pass; the next service cycle is their durable retry path.
 */
export interface OrganizationRecordSweepCoordinator {
  sweep(options: {
    signal?: AbortSignal;
  }): Promise<OrganizationRecordSweepResult>;
  close(): Promise<void>;
}

function mergeOrganizationRecordSweepResults(
  first: OrganizationRecordSweepResult,
  second: OrganizationRecordSweepResult,
): OrganizationRecordSweepResult {
  return {
    ok: first.ok && second.ok,
    examined: first.examined + second.examined,
    excluded: first.excluded + second.excluded,
    skipped: first.skipped + second.skipped,
    published: first.published + second.published,
    rejected: first.rejected + second.rejected,
    retried: first.retried + second.retried,
    alerts: [...first.alerts, ...second.alerts],
  };
}

export function createOrganizationRecordSweepCoordinator(
  sweep: (options: {
    signal?: AbortSignal;
  }) => Promise<OrganizationRecordSweepResult>,
  options: {
    timeoutMs?: number;
  } = {},
): OrganizationRecordSweepCoordinator {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_ORGANIZATION_RECORD_SWEEP_TIMEOUT_MS;
  let activeBatch: Promise<OrganizationRecordSweepResult> | null = null;
  let activeController: AbortController | null = null;
  let followUpRequested = false;
  let acceptingFollowUp = false;
  let closed = false;

  const physicalSweep = async (
    options: { signal?: AbortSignal },
  ): Promise<OrganizationRecordSweepResult> => {
    const controller = new AbortController();
    const abortForParent = (): void => {
      controller.abort(options.signal?.reason);
    };
    if (options.signal?.aborted === true) abortForParent();
    else
      options.signal?.addEventListener('abort', abortForParent, {
        once: true,
      });
    activeController = controller;
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`organization record sweep timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    try {
      return await sweep({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortForParent);
      if (activeController === controller) activeController = null;
    }
  };

  const runBatch = async (
    firstOptions: { signal?: AbortSignal },
  ): Promise<OrganizationRecordSweepResult> => {
    let first: OrganizationRecordSweepResult | undefined;
    let firstFailure: unknown;
    try {
      first = await physicalSweep(firstOptions);
    } catch (error) {
      firstFailure = error;
    }
    acceptingFollowUp = false;
    if (followUpRequested && !closed) {
      followUpRequested = false;
      let second: OrganizationRecordSweepResult | undefined;
      let secondFailure: unknown;
      try {
        // The cycle timeout belongs to its first pass only. This independent
        // pass is still bounded by the composition lifetime controller above.
        second = await physicalSweep({});
      } catch (error) {
        secondFailure = error;
      }
      if (firstFailure !== undefined) throw firstFailure;
      if (secondFailure !== undefined) throw secondFailure;
      if (first === undefined || second === undefined) {
        throw new Error('organization record sweep returned no result');
      }
      return mergeOrganizationRecordSweepResults(first, second);
    }
    followUpRequested = false;
    if (firstFailure !== undefined) throw firstFailure;
    if (first === undefined) {
      throw new Error('organization record sweep returned no result');
    }
    return first;
  };

  return {
    sweep(options) {
      if (closed) {
        return Promise.reject(
          new Error('organization record sweep coordinator is closed'),
        );
      }
      if (activeBatch !== null) {
        if (acceptingFollowUp) followUpRequested = true;
        return activeBatch;
      }
      acceptingFollowUp = true;
      const batch = runBatch(options);
      activeBatch = batch.finally(() => {
        if (activeBatch === tracked) activeBatch = null;
      });
      const tracked = activeBatch;
      return tracked;
    },
    async close() {
      closed = true;
      followUpRequested = false;
      acceptingFollowUp = false;
      activeController?.abort(
        new Error('organization record sweep coordinator is closing'),
      );
      await activeBatch?.catch(() => undefined);
    },
  };
}

async function createCliComposition(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
  dependencies: ProductCliDependencies,
): Promise<ProductComposition> {
  // The retirement gate already ran in `runProductCli`'s early dispatch, and
  // `prepareProductComposition` re-checks it as the public composition
  // boundary, so this helper does not repeat it a third time.
  const factories =
    dependencies.adapterFactories ?? createDefaultAdapterFactories();
  const now = dependencies.composition?.now ?? dependencies.now;
  const customComposition = dependencies.composition;
  const { accessGate, approvalActionAuthorizer, recordSubmitter } =
    resolveOrganizationAuthorization(config, dependencies);
  // One serialized sweep at a time. A resolution during the cycle's sweep
  // coalesces into one independent follow-up rather than disappearing behind
  // the already-active snapshot.
  const recordSweepCoordinator =
    recordSubmitter === undefined
      ? undefined
      : createOrganizationRecordSweepCoordinator((options) =>
          recordSubmitter.sweep(options),
          {
            timeoutMs:
              customComposition?.organizationRecordSweepTimeoutMs ??
              DEFAULT_ORGANIZATION_RECORD_SWEEP_TIMEOUT_MS,
          },
        );
  const sweepOrganizationRecord = recordSweepCoordinator?.sweep.bind(
    recordSweepCoordinator,
  );
  // This check precedes adapter factories and credential resolution. The
  // composition repeats it immediately before health checks and every cycle.
  await assertProductAccess(accessGate);

  // Preserve the existing "adapters first" diagnostic without constructing
  // adapters or resolving credentials before the retirement re-check.
  assertConfiguredAdapterFactoriesAvailable(config, factories);
  const classification = await classifier(config.state_dir);
  if (classification.kind !== "local") {
    throw new ProductRuntimeFailure(
      "state_not_local",
      `product state filesystem is ${classification.kind}: ${classification.raw}`,
      [`kind=${classification.kind}`, `raw=${classification.raw}`],
    );
  }
  prepareProductStateRoot(config.state_dir);
  // Close the race between early CLI dispatch and adapter construction. The
  // composition boundary checks once more after construction, and each cycle
  // checks again before product work.
  refuseRetiredFounderProvenance(config.state_dir);
  const registry = await createConfiguredAdapterRegistry(config, factories, {
    environment: dependencies.environment,
    now,
    ...approvalSurfaceFactoryOptions(approvalActionAuthorizer),
    ...(sweepOrganizationRecord === undefined
      ? {}
      : {
          // The human act remains local and immediate. The coordinator owns
          // the bounded background pass and composition close drains it.
          afterDecisionResolved: () => {
            void sweepOrganizationRecord({}).catch(() => undefined);
          },
        }),
  });
  return await prepareProductComposition(config, registry, {
    ...customComposition,
    classifyStateFilesystem: async () => classification,
    accessGate,
    ...(sweepOrganizationRecord === undefined
      ? {}
      : { organizationRecordSweep: sweepOrganizationRecord }),
    closeResources: async () => {
      try {
        await recordSweepCoordinator?.close();
      } finally {
        await customComposition?.closeResources?.();
      }
    },
    ...(now === undefined ? {} : { now }),
  });
}

function createProductOperator(
  configPath: string,
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): ProductOperator {
  const configured = dependencies.operator ?? {};
  return new ProductOperator(configPath, config, {
    ...configured,
    cliPath: configured.cliPath ?? CLI_PATH,
    productVersion: configured.productVersion ?? PRODUCT_VERSION,
    buildIdentity: configured.buildIdentity ?? packagedBuildIdentity(),
    verifyConfiguredAdapters:
      configured.verifyConfiguredAdapters ??
      ((recordedConfig) => {
        // Static factory-level proof only: no environment, credential
        // resolver, or clock is handed over, because none may be used.
        assertConfiguredAdaptersValid(
          recordedConfig,
          dependencies.adapterFactories ?? createDefaultAdapterFactories(),
        );
      }),
  });
}

function lifecycleLock(
  dependencies: ProductCliDependencies,
  stateDirectory: string,
  kind: ProductLifecycleLockKind,
  timeoutMs: number,
): Promise<ReleaseProductLifecycleLock> {
  const acquire =
    dependencies.acquireLifecycleLock ?? acquireProductLifecycleLock;
  return acquire(stateDirectory, kind, { timeoutMs });
}

async function releaseLifecycleLocks(
  releases: readonly ReleaseProductLifecycleLock[],
): Promise<void> {
  let failure: unknown;
  for (const release of [...releases].reverse()) {
    try {
      await release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function acquireMaintenanceWindow(
  stateDirectory: string,
  dependencies: ProductCliDependencies,
  timeoutMs: number,
): Promise<readonly ReleaseProductLifecycleLock[]> {
  const runtime = await lifecycleLock(
    dependencies,
    stateDirectory,
    "runtime",
    timeoutMs,
  );
  try {
    const maintenance = await lifecycleLock(
      dependencies,
      stateDirectory,
      "maintenance",
      timeoutMs,
    );
    return [runtime, maintenance];
  } catch (error) {
    await runtime();
    throw error;
  }
}

function operationId(
  prefix: "backup" | "restore" | "pre-restore",
  timestamp: string,
  requested?: string,
): string {
  if (requested !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(requested)) {
      throw new Error(
        "operation id must be 1-100 letters, numbers, dots, underscores, or hyphens",
      );
    }
    return requested;
  }
  return `${prefix}-${timestamp.replace(/[^0-9A-Za-z]/g, "")}`;
}

function printOperatorError(
  stderr: Pick<Writable, "write">,
  command: string,
  error: unknown,
): void {
  print(stderr, {
    ok: false,
    command,
    ...(error instanceof ProductOperatorError ? { code: error.code } : {}),
    error: (error as Error).message,
  });
}

function organizationAccessSummary(
  decision: OrganizationInstallationAccessDecisionV1,
): Record<string, unknown> {
  const state = decision.state;
  return {
    permitted: decision.permitted,
    status: state.status,
    authority_id: state.authority_id,
    organization_id: state.organization_id,
    principal_id: state.principal_id,
    membership_id: state.membership_id,
    membership_type: state.membership_type,
    installation_id: state.installation_id,
    enrollment_id: state.enrollment_id,
    access_state_sequence: state.access_state_sequence,
    evaluated_at: state.evaluated_at,
    valid_until: state.valid_until,
    revocation_reason: state.revocation_reason,
  };
}

function organizationConnectionSummary(
  connection: ReturnType<
    SqliteOrganizationStateStore["readAuthorityConnection"]
  >,
): Record<string, unknown> | null {
  if (connection === null) return null;
  return {
    authority_id: connection.authority_id,
    organization_id: connection.organization_id,
    authority_base_url: connection.authority_base_url,
    authority_ca_configured: connection.authority_ca_pem !== null,
    configured_at: connection.configured_at,
  };
}

function readOrganizationAuthorityCa(path: string | undefined):
  | string
  | undefined {
  if (path === undefined) return undefined;
  const bytes = readFileNoFollow(path, "organization authority CA");
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error("organization authority CA must contain 1-65536 bytes");
  }
  const value = bytes.toString("utf8");
  if (
    value.includes("\0") ||
    !value.includes("-----BEGIN CERTIFICATE-----") ||
    !value.includes("-----END CERTIFICATE-----")
  ) {
    throw new Error("organization authority CA is not a PEM certificate");
  }
  return value;
}

function capturedOutput(): {
  stream: Pick<Writable, "write">;
  read: () => string;
} {
  let value = "";
  return {
    stream: {
      write: ((chunk: string | Uint8Array) => {
        value += chunk.toString();
        return true;
      }) as Writable["write"],
    },
    read: () => value,
  };
}

function capturedRecord(value: string, label: string): Record<string, unknown> {
  const line = value.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) {
    throw new Error(`${label} returned no result`);
  }
  const parsed = parseJson(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid result`);
  }
  return parsed as Record<string, unknown>;
}

async function runCapturedCliStep(
  label: string,
  argv: readonly string[],
  dependencies: ProductCliDependencies,
): Promise<Record<string, unknown>> {
  const stdout = capturedOutput();
  const stderr = capturedOutput();
  const status = await runProductCli(argv, {
    ...dependencies,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  if (status !== 0) {
    const raw = stderr.read().trim();
    let detail = raw;
    try {
      const error = capturedRecord(raw, label)["error"];
      if (typeof error === "string") detail = error;
    } catch {
      // Preserve the raw diagnostic when a failed child did not emit JSON.
    }
    throw new Error(`${label} failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return capturedRecord(stdout.read(), label);
}

async function readHiddenCredential(
  label: string,
  stderr: Pick<Writable, "write">,
): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      `bootstrap requires an interactive terminal for the hidden ${label} prompt`,
    );
  }
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  stderr.write(`${label} (hidden): `);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error(`${label} entry was cancelled`));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
        if (value.length > 4096) {
          finish(new Error(`${label} is too long`));
          return;
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function runBootstrapCommand(
  parsed: ParsedCommand,
  dependencies: ProductCliDependencies,
  stdout: Pick<Writable, "write">,
  stderr: Pick<Writable, "write">,
): Promise<number> {
  try {
    const buildIdentity =
      dependencies.operator?.buildIdentity ?? packagedBuildIdentity();
    if (buildIdentity.source_kind !== "materialized-commit") {
      throw new Error(
        "bootstrap requires a package built from a materialized-commit",
      );
    }
    const platform = dependencies.operator?.platform ?? process.platform;
    const architecture = dependencies.operator?.architecture ?? process.arch;
    const nodeVersion = dependencies.operator?.nodeVersion ?? process.version;
    if (platform !== "darwin" || architecture !== "arm64") {
      throw new Error(
        `bootstrap requires darwin/arm64; observed ${platform}/${architecture}`,
      );
    }
    if (nodeVersion !== "v22.22.1") {
      throw new Error(
        `bootstrap requires Node v22.22.1; observed ${nodeVersion}`,
      );
    }
    if (parsed.allowExportableSoftwareKey !== true) {
      throw new Error(
        "bootstrap requires --allow-exportable-software-key for the pilot-grade installation key",
      );
    }
    const fileSystem =
      dependencies.operator?.fileSystem ?? nodeOperatorFileSystem;
    const pathExists = (path: string) => fileSystem.exists(path);
    refuseRetiredFounderProvenance(parsed.stateDirectory!);
    const classifier =
      dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
    const filesystem = await classifier(parsed.stateDirectory!);
    if (filesystem.kind !== "local") {
      throw new Error(
        `bootstrap requires a local state filesystem; observed ${filesystem.kind}: ${filesystem.raw}`,
      );
    }
    const configExists = pathExists(parsed.configPath);
    const stateExists = pathExists(parsed.stateDirectory!);
    if (configExists && !stateExists) {
      throw new Error(
        "bootstrap found an incomplete config/state pair and will not guess ownership",
      );
    }
    const invitation = readPrivateOrganizationEnrollmentInvitation(
      parsed.invitationPath!,
    );
    if (invitation.status !== "issued" || invitation.issued === null) {
      throw new Error("organization invitation has not been issued");
    }
    if (invitation.authority_pin_sha256 !== parsed.authorityPin) {
      throw new Error(
        "independently supplied authority PIN does not match the invitation",
      );
    }
    const slackApproval = {
      channelId: parsed.slackChannelId!,
      reviewerUserId: parsed.slackReviewerUserId!,
      reviewerName: parsed.slackReviewerName!,
    };
    const expectedConfig = createProductOnboardConfig(
      parsed.stateDirectory!,
      parsed.ownerEmail!,
      slackApproval,
    );
    const credentialPath = join(
      parsed.stateDirectory!,
      "credentials",
      "granola-api-key",
    );
    const slackCredentialPath = join(
      parsed.stateDirectory!,
      "credentials",
      "slack-bot-token",
    );
    const readGranolaCredential =
      dependencies.bootstrap?.readGranolaCredential ??
      (() => readHiddenCredential("Granola API token", stderr));
    const readSlackCredential =
      dependencies.bootstrap?.readSlackCredential ??
      (() => readHiddenCredential("Slack bot token", stderr));
    if (!configExists) {
      onboardProduct(
        parsed.configPath,
        parsed.stateDirectory!,
        {
          fileSystem,
          granolaOwnerEmail: parsed.ownerEmail!,
          slackApproval,
        },
      );
    } else {
      const existingConfig = loadProductRuntimeConfig(parsed.configPath);
      if (
        canonicalProductConfigSha256(existingConfig) !==
        canonicalProductConfigSha256(expectedConfig)
      ) {
        throw new Error(
          "bootstrap will resume only an exact owner-bound bootstrap profile",
        );
      }
      const existingStatus = await runCapturedCliStep(
        "bootstrap resume status",
        ["status", "--config", parsed.configPath],
        dependencies,
      );
      const service = existingStatus["service"];
      if (
        service === null ||
        typeof service !== "object" ||
        Array.isArray(service) ||
        (service as Record<string, unknown>)["installed"] !== false ||
        (service as Record<string, unknown>)["loaded"] !== false ||
        (service as Record<string, unknown>)["running"] !== false
      ) {
        throw new Error(
          "bootstrap will not resume an activated installation; use update apply",
        );
      }
    }

    const granolaCredentialExists = pathExists(credentialPath);
    const granolaCredential = granolaCredentialExists
      ? readPrivateCredentialFile(
          credentialPath,
          dependencies.operator?.uid,
        )
      : await readGranolaCredential();
    if (!GRANOLA_API_KEY_RE.test(granolaCredential)) {
      throw new ProductOperatorError(
        "installation_conflict",
        "Granola credential is not a valid API token",
      );
    }
    const granolaOwnerObservation = await (
      dependencies.bootstrap?.observeGranolaRecordOwner ??
      (async (credential: string, ownerEmail: string) =>
        await observeGranolaRecordOwner(
          new HttpGranolaApiClient(credential),
          ownerEmail,
        ))
    )(granolaCredential, parsed.ownerEmail!);
    if (!granolaCredentialExists) {
      createProductBootstrapCredential(
        credentialPath,
        granolaCredential,
        "granola",
        fileSystem,
      );
    }
    if (!pathExists(slackCredentialPath)) {
      createProductBootstrapCredential(
        slackCredentialPath,
        await readSlackCredential(),
        "slack",
        fileSystem,
      );
    }

    await runCapturedCliStep(
      "initialize",
      ["init", "--config", parsed.configPath],
      dependencies,
    );
    const initializedConfig = loadProductRuntimeConfig(parsed.configPath);
    createProductOperator(
      parsed.configPath,
      initializedConfig,
      dependencies,
    ).preflightServiceStart();
    const enrollmentArgs = [
      "organization",
      "enroll",
      "--config",
      parsed.configPath,
      "--invitation",
      parsed.invitationPath!,
      "--authority-pin",
      parsed.authorityPin!,
      "--allow-exportable-software-key",
      ...(parsed.authorityCaPath === undefined
        ? []
        : ["--authority-ca", parsed.authorityCaPath]),
    ];
    const organizationState = new SqliteOrganizationStateStore(
      resolveProductStatePaths(parsed.stateDirectory!).database,
    );
    let alreadyEnrolled = false;
    try {
      const enrollment = organizationState.readEnrollment();
      if (
        enrollment !== null &&
        enrollment.receipt !== null &&
        enrollment.accepted_access_sequence > 0
      ) {
        alreadyEnrolled = true;
        const request = enrollment.request;
        const connection = organizationState.readAuthorityConnection();
        const pinned = organizationState.readPinnedAuthority();
        if (
          request.authority_id !== invitation.authority_id ||
          request.organization_id !== invitation.organization_id ||
          request.principal_id !== invitation.issued.principal_id ||
          request.membership_id !== invitation.membership_id ||
          request.enrollment_grant_sha256 !==
            invitation.enrollment_grant_sha256 ||
          connection?.authority_base_url !== invitation.authority_base_url ||
          pinned?.authority_pin_sha256 !== invitation.authority_pin_sha256
        ) {
          throw new Error(
            "bootstrap invitation does not match the enrolled organization identity",
          );
        }
      }
    } finally {
      organizationState.close();
    }
    const organization = await runCapturedCliStep(
      alreadyEnrolled
        ? "organization access refresh"
        : "organization enrollment",
      alreadyEnrolled
        ? ["organization", "refresh", "--config", parsed.configPath]
        : enrollmentArgs,
      dependencies,
    );
    const access = organization["access"];
    if (
      access === null ||
      typeof access !== "object" ||
      Array.isArray(access) ||
      (access as Record<string, unknown>)["permitted"] !== true ||
      (access as Record<string, unknown>)["status"] !== "active"
    ) {
      throw new Error("organization enrollment did not grant active access");
    }
    const inactiveService = await runCapturedCliStep(
      "inactive service status",
      ["status", "--config", parsed.configPath],
      dependencies,
    );
    const service = inactiveService["service"];
    const issues = inactiveService["issues"];
    if (
      inactiveService["initialized"] !== true ||
      !Array.isArray(issues) ||
      issues.length !== 0 ||
      service === null ||
      typeof service !== "object" ||
      Array.isArray(service) ||
      (service as Record<string, unknown>)["installed"] !== false ||
      (service as Record<string, unknown>)["loaded"] !== false ||
      (service as Record<string, unknown>)["running"] !== false
    ) {
      throw new Error(
        "bootstrap local preflight did not leave an initialized, issue-free, stopped installation",
      );
    }
    print(stdout, {
      ok: true,
      command: "bootstrap",
      owner_email: parsed.ownerEmail,
      config_path: parsed.configPath,
      state_dir: parsed.stateDirectory,
      credential_path: credentialPath,
      slack_credential_path: slackCredentialPath,
      granola_record_owner: granolaOwnerObservation,
      organization: {
        enrolled: organization["enrolled"],
        access,
        ...(organization["key_assurance_policy"] === undefined
          ? {}
          : {
              key_assurance_policy:
                organization["key_assurance_policy"],
            }),
      },
      service,
      local_preflight: { ok: true },
      product_work_started: false,
      next_steps: [
        `echo-brain organization slack-link-begin --config ${parsed.configPath}`,
        "complete the emitted Slack identity-link instructions and give the administrator the non-secret identity_link_id and adapter_binding_id",
        "administrator activates approve/reject permission for that verified link with echo-organization-admin slack approval activate",
        "use the controlled owner-visible meeting note with explicit Decision:, Action:, and Rationale: lines",
        `echo-brain run-once --config ${parsed.configPath}`,
        "react to the pending Slack card as the configured reviewer",
        `echo-brain run-once --config ${parsed.configPath}`,
        "inspect the JSONL outbox, then run once again and confirm no duplicate delivery",
        `echo-brain service install --config ${parsed.configPath}`,
        `echo-brain doctor --config ${parsed.configPath}`,
        `echo-brain update apply --channel internal-live --config ${parsed.configPath}`,
      ],
    });
    return 0;
  } catch (error) {
    printOperatorError(stderr, "bootstrap", error);
    return 1;
  }
}

export async function runProductCli(
  argv: readonly string[],
  dependencies: ProductCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout.write(HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    stdout.write(`${PRODUCT_VERSION}\n`);
    return 0;
  }
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }
  if (parsed.command === "bootstrap") {
    return await runBootstrapCommand(
      parsed,
      dependencies,
      stdout,
      stderr,
    );
  }
  let config: ProductRuntimeConfig;
  try {
    config = loadProductRuntimeConfig(parsed.configPath);
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }
  // The state path is now known. This is the single early gate for every other
  // gated command; nothing below it may construct, probe, lock, create, or call
  // out on a fenced state root.
  if (retiredProvenanceGateApplies(parsed)) {
    try {
      refuseRetiredFounderProvenance(config.state_dir);
    } catch (error) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        ...(parsed.action === undefined ? {} : { action: parsed.action }),
        code: "retired_founder_provenance",
        error: (error as Error).message,
      });
      return 1;
    }
  }
  const classifier =
    dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
  if (parsed.command === "update") {
    if (
      (await requireLocalState(parsed, config, classifier, stderr, {
        channel: "internal-live",
      })) === null
    ) {
      return 1;
    }
    try {
      const execute =
        dependencies.internalLive?.execute ?? runInternalLiveUpdate;
      const result = await execute({
        configPath: parsed.configPath,
        config,
        cliPath: dependencies.operator?.cliPath ?? CLI_PATH,
        productVersion:
          dependencies.operator?.productVersion ?? PRODUCT_VERSION,
        buildIdentity:
          dependencies.operator?.buildIdentity === undefined
            ? packagedBuildIdentity()
            : {
                schema_version: 1,
                kind: "echo-packaged-build-identity",
                product_version:
                  dependencies.operator.productVersion ?? PRODUCT_VERSION,
                ...dependencies.operator.buildIdentity,
              },
        now: resolveProductClock(dependencies.now),
        ...(dependencies.organization?.installationSigner === undefined
          ? {}
          : {
              installationSigner:
                dependencies.organization.installationSigner,
            }),
        ...(dependencies.organization?.fetch === undefined
          ? {}
          : { authorityFetch: dependencies.organization.fetch }),
        ...(dependencies.organization?.allowInsecureLoopback === undefined
          ? {}
          : {
              allowInsecureLoopback:
                dependencies.organization.allowInsecureLoopback,
            }),
      });
      const ok = result.receipt.outcome === "healthy";
      print(ok ? stdout : stderr, {
        ok,
        command: parsed.command,
        action: parsed.action,
        channel: "internal-live",
        directive_sequence: result.directive_sequence,
        receipt: result.receipt,
      });
      return ok ? 0 : 1;
    } catch (error) {
      printOperatorError(stderr, "update apply", error);
      return 1;
    }
  }
  if (parsed.command === "organization") {
    const action = parsed.action!;
    const usesDefaultFileSigner =
      dependencies.organization?.installationSigner === undefined;
    if (
      action === "enroll" &&
      usesDefaultFileSigner &&
      !parsed.allowExportableSoftwareKey
    ) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        action,
        code: "software_key_acknowledgement_required",
        error:
          "organization enroll uses an exportable software key; repeat with --allow-exportable-software-key to acknowledge pilot-grade key assurance",
      });
      return 2;
    }
    if ((await requireLocalState(parsed, config, classifier, stderr)) === null)
      return 1;
    try {
      const initialized = await createProductOperator(
        parsed.configPath,
        config,
        dependencies,
      ).status();
      if (!initialized.initialized) {
        throw new ProductOperatorError(
          "not_initialized",
          "run `echo-brain init --config <absolute-path>` before organization enrollment",
        );
      }
    } catch (error) {
      printOperatorError(stderr, `${parsed.command} ${action}`, error);
      return 1;
    }

    let releases: readonly ReleaseProductLifecycleLock[] = [];
    let organizationResult: object | undefined;
    let organizationStatus = 0;
    let operationFailure: unknown;
    try {
      releases =
        action === "status" ||
        action === "recent-decisions" ||
        action === "reviewer-recent-decisions" ||
        action === "readable-search"
          ? [
              await lifecycleLock(
                dependencies,
                config.state_dir,
                "maintenance",
                0,
              ),
            ]
          : await acquireMaintenanceWindow(
              config.state_dir,
              dependencies,
              0,
            );
      const paths = resolveProductStatePaths(config.state_dir);
      const now = resolveProductClock(dependencies.now);

      if (action === "record-flush") {
        const flushed = await flushOrganizationRecords(config, dependencies);
        organizationStatus = flushed.ok ? 0 : 1;
        organizationResult = {
          command: parsed.command,
          action,
          ...flushed,
        };
      } else if (action === "status") {
        const state = new SqliteOrganizationStateStore(paths.database);
        try {
          const connection = state.readAuthorityConnection();
          const enrollment = state.readEnrollment();
          if (enrollment === null) {
            organizationResult = {
              ok: true,
              command: parsed.command,
              action,
              enrolled: false,
              authority_connection: organizationConnectionSummary(connection),
            };
          } else if (
            enrollment.receipt === null ||
            enrollment.accepted_access_sequence === 0
          ) {
            organizationResult = {
              ok: true,
              command: parsed.command,
              action,
              enrolled: false,
              enrollment_pending: true,
              authority_connection: organizationConnectionSummary(connection),
              installation_id: enrollment.request.installation_id,
              membership_id: enrollment.request.membership_id,
            };
          } else {
            const decision = state.verifyCurrentAccess({
              now: now(),
              maximum_active_ttl_ms:
                MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS,
              allowed_clock_skew_ms:
                DEFAULT_LOCAL_ORGANIZATION_ACCESS_CLOCK_SKEW_MS,
            });
            organizationResult = {
              ok: true,
              command: parsed.command,
              action,
              enrolled: true,
              authority_connection: organizationConnectionSummary(connection),
              access: organizationAccessSummary(decision),
            };
          }
        } finally {
          state.close();
        }
      } else if (action === "enroll") {
        const invitation = readPrivateOrganizationEnrollmentInvitation(
          parsed.invitationPath!,
        );
        if (invitation.status !== "issued" || invitation.issued === null) {
          throw new Error(
            "organization invitation has not been issued by its authority",
          );
        }
        if (invitation.authority_pin_sha256 !== parsed.authorityPin) {
          throw new Error(
            "independently supplied authority PIN does not match the invitation",
          );
        }
        const signer =
          dependencies.organization?.installationSigner ??
          new FileInstallationSigner(
            join(config.state_dir, "installation", "keys"),
          );
        const authorityCaPem = readOrganizationAuthorityCa(
          parsed.authorityCaPath,
        );
        const runtime = createLocalOrganizationRuntime({
          databasePath: paths.database,
          authorityBaseUrl: invitation.authority_base_url,
          installationSigner: signer,
          clock: { now },
          ...organizationAuthorityTransportOptions(
            dependencies.organization,
            authorityCaPem,
          ),
        });
        try {
          const descriptor =
            validateOrganizationAuthorityDescriptorResponse(
              await runtime.authorityClient.readAuthorityDescriptor(),
            ).authority_descriptor;
          if (
            descriptor.authority_id !== invitation.authority_id ||
            descriptor.organization_id !== invitation.organization_id
          ) {
            throw new Error(
              "organization invitation does not identify the authority at its configured origin",
            );
          }
          const retained = runtime.state.readEnrollment();
          // The retired active-identity reader once ran here. Re-check the
          // fence at the same point so residue appearing after early dispatch
          // still refuses before an installation identity is chosen or the
          // enrollment grant is presented to the Authority.
          refuseRetiredFounderProvenance(config.state_dir);
          const installationId =
            retained?.request.installation_id ??
            dependencies.organization?.createInstallationId?.() ??
            `ins_${randomUUID()}`;
          const grant = Buffer.from(
            invitation.enrollment_grant_base64url,
            "base64url",
          );
          try {
            const invitationExpired =
              Date.parse(invitation.issued.expires_at) <= Date.parse(now());
            const retainedMatchesInvitation =
              retained !== null &&
              retained.request.authority_id === invitation.authority_id &&
              retained.request.organization_id ===
                invitation.organization_id &&
              retained.request.principal_id ===
                invitation.issued.principal_id &&
              retained.request.membership_id === invitation.membership_id &&
              retained.request.enrollment_grant_sha256 ===
                organizationEnrollmentGrantSha256(grant);
            if (invitationExpired && !retainedMatchesInvitation) {
              throw new Error("organization invitation has expired");
            }
            let decision: OrganizationInstallationAccessDecisionV1;
            try {
              decision = await runtime.coordinator.enroll({
                authorityBaseUrl: invitation.authority_base_url,
                ...(authorityCaPem === undefined
                  ? {}
                  : { authorityCaPem }),
                authorityDescriptor: descriptor,
                independentlyTrustedAuthorityPin: parsed.authorityPin!,
                enrollmentGrant: grant,
                principalId: invitation.issued.principal_id,
                membershipId: invitation.membership_id,
                installationId,
              });
            } catch (error) {
              if (
                invitationExpired &&
                error instanceof OrganizationAuthorityTransportError &&
                error.code === "unauthorized" &&
                error.status === 401 &&
                runtime.state.abandonPendingEnrollment()
              ) {
                throw new Error(
                  "the expired invitation was not consumed by the authority; the pending local request was cleared, so obtain a fresh invitation and retry",
                );
              }
              throw error;
            }
            organizationResult = {
              ok: true,
              command: parsed.command,
              action,
              enrolled: true,
              invitation_expires_at: invitation.issued.expires_at,
              ...(usesDefaultFileSigner
                ? {
                    key_assurance_policy:
                      "software_key_development_only",
                  }
                : {}),
              access: organizationAccessSummary(decision),
              next_step: `echo-brain organization status --config ${parsed.configPath}`,
            };
          } finally {
            grant.fill(0);
          }
        } finally {
          runtime.close();
        }
      } else if (action === "rebind") {
        const authorityCaPem = readOrganizationAuthorityCa(
          parsed.authorityCaPath,
        );
        const state = new SqliteOrganizationStateStore(paths.database);
        try {
          const pinned = state.readPinnedAuthority();
          const connection = state.readAuthorityConnection();
          if (pinned === null || connection === null) {
            throw new Error(
              "organization authority connection is unavailable; enroll this machine first",
            );
          }
          if (pinned.authority_pin_sha256 !== parsed.authorityPin) {
            throw new Error(
              "independently supplied authority PIN does not match the locally pinned authority",
            );
          }
          const client = new HttpOrganizationAuthorityClient({
            baseUrl: parsed.authorityUrl!,
            ...organizationAuthorityTransportOptions(
              dependencies.organization,
              authorityCaPem,
            ),
          });
          const descriptor =
            validateOrganizationAuthorityDescriptorResponse(
              await client.readAuthorityDescriptor(),
            ).authority_descriptor;
          verifyOrganizationAuthorityPin(descriptor, parsed.authorityPin);
          if (
            descriptor.authority_id !== connection.authority_id ||
            descriptor.organization_id !== connection.organization_id
          ) {
            throw new Error(
              "new organization authority endpoint identifies a different authority",
            );
          }
          const rebound = state.rebindAuthorityConnection({
            authority_id: descriptor.authority_id,
            organization_id: descriptor.organization_id,
            authority_base_url: parsed.authorityUrl!,
            ...(authorityCaPem === undefined
              ? {}
              : { authority_ca_pem: authorityCaPem }),
          });
          organizationResult = {
            ok: true,
            command: parsed.command,
            action,
            authority_connection: organizationConnectionSummary(rebound),
          };
        } finally {
          state.close();
        }
      } else {
        const state = new SqliteOrganizationStateStore(paths.database);
        const connection = state.readAuthorityConnection();
        state.close();
        if (connection === null) {
          throw new Error(
            "organization authority connection is unavailable; enroll this machine first",
          );
        }
        const signer =
          dependencies.organization?.installationSigner ??
          new FileInstallationSigner(
            join(config.state_dir, "installation", "keys"),
          );
        const runtime = createLocalOrganizationRuntime({
          databasePath: paths.database,
          authorityBaseUrl: connection.authority_base_url,
          installationSigner: signer,
          clock: { now },
          ...organizationAuthorityTransportOptions(
            dependencies.organization,
            connection.authority_ca_pem,
          ),
        });
        try {
          if (action === "refresh") {
            const decision = await runtime.coordinator.refreshAccess();
            organizationResult = {
              ok: true,
              command: parsed.command,
              action,
              enrolled: true,
              access: organizationAccessSummary(decision),
            };
          } else if (action === "recent-decisions") {
            organizationResult = await runtime.recentDecisions.read();
          } else if (action === "reviewer-recent-decisions") {
            organizationResult = await runtime.reviewerRecentDecisions.read();
          } else if (action === "readable-search") {
            organizationResult = await runtime.readableSearch.read(
              parsed.query!,
            );
          } else {
            const approvalSurface = configuredSlackApprovalSurface(config);
            if (action === "slack-link-begin") {
              const challengeBytes = randomBytes(32);
              const challengeCode = challengeBytes.toString("base64url");
              challengeBytes.fill(0);
              const challenge =
                await runtime.slackIdentityLinks.begin(challengeCode);
              if (challenge.channel_id !== approvalSurface.channel_id) {
                throw new Error(
                  "the organization-approved Slack channel does not match this installation's Slack approval surface",
                );
              }
              organizationResult = {
                ok: true,
                command: parsed.command,
                action,
                challenge,
                challenge_code: challengeCode,
                next_steps: [
                  "reply in the Slack challenge thread with challenge_code exactly",
                  "capture challenge_attempt_id and challenge_message_ts from this output",
                  "read -r -s ECHO_SLACK_LINK_CODE",
                  `ECHO_SLACK_LINK_CODE="$ECHO_SLACK_LINK_CODE" echo-brain organization slack-link-complete --config ${shellSingleQuote(parsed.configPath)} --challenge-attempt ${challenge.challenge_attempt_id} --challenge-message-ts ${challenge.challenge_message_ts}`,
                  "unset ECHO_SLACK_LINK_CODE",
                ],
              };
            } else {
              const challengeCode =
                (dependencies.environment ?? process.env)[
                  "ECHO_SLACK_LINK_CODE"
                ];
              if (
                typeof challengeCode !== "string" ||
                challengeCode.length === 0
              ) {
                throw new Error(
                  "organization slack-link-complete requires ECHO_SLACK_LINK_CODE",
                );
              }
              const result = await runtime.slackIdentityLinks.complete({
                challenge_attempt_id: parsed.slackLinkAttemptId!,
                challenge_message_ts: parsed.slackLinkMessageTs!,
                challenge_code: challengeCode,
                expected_provider_subject_id:
                  approvalSurface.reviewer_user_id,
                adapter_instance_id: approvalSurface.instance_id,
                adapter_version:
                  SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
              });
              if (result.channel_id !== approvalSurface.channel_id) {
                throw new Error(
                  "the linked Slack channel does not match this installation's Slack approval surface",
                );
              }
              organizationResult = {
                ok: true,
                command: parsed.command,
                action,
                linked: true,
                result,
                next_steps: [
                  "unset ECHO_SLACK_LINK_CODE",
                  `echo-organization-admin slack approval activate --config '<absolute-authority-config>' --administrator-membership-id '<active-owner-membership-id>' --target-membership-id ${result.membership_id} --installation-id ${result.installation_id} --identity-link-id ${result.identity_link_id} --adapter-binding-id ${result.adapter_binding_id}`,
                ],
              };
            }
          }
        } finally {
          runtime.close();
        }
      }
    } catch (error) {
      operationFailure = error;
    }
    try {
      await releaseLifecycleLocks(releases);
    } catch (error) {
      operationFailure ??= new Error(
        `lifecycle lock release failed: ${(error as Error).message}`,
      );
    }
    if (operationFailure !== undefined) {
      printOperatorError(
        stderr,
        `${parsed.command} ${action}`,
        operationFailure,
      );
      return 1;
    }
    print(organizationStatus === 0 ? stdout : stderr, organizationResult!);
    return organizationStatus;
  }
  if (parsed.command === "service-run") {
    try {
      createProductOperator(
        parsed.configPath,
        config,
        dependencies,
      ).preflightServiceRun();
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
    return await runServiceDaemon(config, classifier, dependencies, {
      stdout,
      stderr,
    });
  }
  if (parsed.command === "backup" || parsed.command === "restore") {
    if ((await requireLocalState(parsed, config, classifier, stderr)) === null)
      return 1;
    let operator: ProductOperator;
    try {
      operator = createProductOperator(parsed.configPath, config, dependencies);
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
    let maintenanceLease: ProductMaintenanceLease | undefined;
    let maintenanceResult: Record<string, unknown> | undefined;
    try {
      maintenanceLease = await acquireProductMaintenanceLease(
        config.state_dir,
        { timeoutMs: 0 },
      );
      const status = await operator.status();
      if (!status.service.supported) {
        throw new ProductOperatorError(
          "unsupported_platform",
          "cannot prove the product service is stopped on this platform",
        );
      }
      if (status.service.loaded) {
        throw new ProductOperatorError(
          "service_command_failed",
          "service is loaded; run `echo-brain service stop --config <absolute-path>` before maintenance",
        );
      }
      if (parsed.command === "backup" && !status.initialized) {
        throw new ProductOperatorError(
          "not_initialized",
          "run `echo-brain init --config <absolute-path>` before backup",
        );
      }
      const timestamp = resolveProductClock(dependencies.now)();
      const canonicalConfigSha256 = canonicalProductConfigSha256(config);
      if (parsed.command === "backup") {
        const created = await createProductStateBackup({
          stateDir: config.state_dir,
          backupRoot: parsed.backupRoot!,
          backupId: operationId("backup", timestamp, parsed.operationId),
          createdAt: timestamp,
          canonicalConfigSha256,
          maintenanceLease,
        });
        maintenanceResult = {
          ok: true,
          command: parsed.command,
          backup_directory: created.backupDirectory,
          evidence: created.evidence,
        };
      } else {
        const restoreId = operationId("restore", timestamp, parsed.operationId);
        const restored = await restoreProductStateBackup({
          stateDir: config.state_dir,
          backupDirectory: parsed.backupDirectory!,
          automaticBackupRoot: parsed.backupRoot!,
          operationId: restoreId,
          restoredAt: timestamp,
          preRestoreBackupId: `pre-${restoreId}`,
          preRestoreBackupCreatedAt: timestamp,
          canonicalConfigSha256,
          maintenanceLease,
        });
        maintenanceResult = {
          ok: true,
          command: parsed.command,
          evidence: restored.evidence,
          next_steps: [
            `echo-brain service start --config ${parsed.configPath}`,
            `echo-brain doctor --config ${parsed.configPath}`,
          ],
        };
      }
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    } finally {
      try {
        await maintenanceLease?.release();
      } catch (error) {
        printOperatorError(stderr, `${parsed.command} lock-release`, error);
        return 1;
      }
    }
    print(stdout, maintenanceResult!);
    return 0;
  }
  if (
    parsed.command === "init" ||
    parsed.command === "reconfigure" ||
    parsed.command === "status" ||
    parsed.command === "doctor" ||
    parsed.command === "service"
  ) {
    let operator: ProductOperator;
    try {
      operator = createProductOperator(parsed.configPath, config, dependencies);
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
    if (parsed.command === "status") {
      try {
        const status = await operator.status();
        print(stdout, { ok: true, command: parsed.command, ...status });
        return 0;
      } catch (error) {
        printOperatorError(stderr, parsed.command, error);
        return 1;
      }
    }
    if (parsed.command === "doctor") {
      let filesystem: Awaited<ReturnType<ClassifyStateFilesystem>>;
      try {
        filesystem = await classifier(config.state_dir);
      } catch (error) {
        filesystem = {
          kind: "unknown",
          raw: `filesystem probe failed: ${(error as Error).message}`,
        };
      }
      let adapters: Awaited<ReturnType<typeof diagnoseConfiguredAdapters>> = [];
      let adapterError: string | undefined;
      let organizationDiagnostic:
        | DoctorOrganizationResolution['diagnostic']
        | undefined;
      if (parsed.doctorLocalOnly !== true) {
        let approvalActionAuthorizer:
          | OrganizationApprovalActionAuthorizer
          | undefined;
        try {
          const organization = await resolveDoctorOrganization(
            config,
            dependencies,
          );
          organizationDiagnostic = organization.diagnostic;
          approvalActionAuthorizer =
            organization.approvalActionAuthorizer;
        } catch (error) {
          organizationDiagnostic = {
            ok: false,
            detail: `organization state inspection failed: ${(error as Error).message}`,
          };
          adapterError =
            'adapter diagnostics were skipped because organization state inspection failed';
        }
        if (adapterError === undefined) {
          try {
          const factories =
            dependencies.adapterFactories ?? createDefaultAdapterFactories();
          const registry = await createConfiguredAdapterRegistry(
            config,
            factories,
            {
              environment: dependencies.environment,
              now: dependencies.now,
              ...approvalSurfaceFactoryOptions(
                approvalActionAuthorizer,
              ),
            },
          );
          adapters = await diagnoseConfiguredAdapters(
            config,
            registry,
            dependencies.doctorHealthTimeoutMs ?? 10_000,
          );
          } catch (error) {
            adapterError = (error as Error).message;
          }
        }
      }
      try {
        const report = await operator.doctor({
          filesystem,
          adapters,
          includeAdapters: parsed.doctorLocalOnly !== true,
          ...(organizationDiagnostic === undefined
            ? {}
            : { organizationDiagnostic }),
          ...(adapterError === undefined ? {} : { adapterError }),
        });
        print(report.ok ? stdout : stderr, {
          ...report,
          command: parsed.command,
        });
        return report.ok ? 0 : 1;
      } catch (error) {
        printOperatorError(stderr, parsed.command, error);
        return 1;
      }
    }
    if (parsed.command === "init") {
      if (
        (await requireLocalState(parsed, config, classifier, stderr)) === null
      ) {
        return 1;
      }
      try {
        const releases = await acquireMaintenanceWindow(
          config.state_dir,
          dependencies,
          0,
        );
        let result: Awaited<ReturnType<ProductOperator["init"]>>;
        try {
          prepareProductStateRoot(config.state_dir);
          result = await operator.init();
        } finally {
          await releaseLifecycleLocks(releases);
        }
        print(stdout, { ok: true, command: parsed.command, ...result });
        return 0;
      } catch (error) {
        printOperatorError(stderr, parsed.command, error);
        return 1;
      }
    }
    if (parsed.command === "reconfigure") {
      if (
        (await requireLocalState(parsed, config, classifier, stderr)) === null
      ) {
        return 1;
      }
      try {
        const releases = await acquireMaintenanceWindow(
          config.state_dir,
          dependencies,
          0,
        );
        let result: Awaited<ReturnType<ProductOperator["reconfigure"]>>;
        try {
          result = await operator.reconfigure();
        } finally {
          await releaseLifecycleLocks(releases);
        }
        print(stdout, { ok: true, command: parsed.command, ...result });
        return 0;
      } catch (error) {
        printOperatorError(stderr, parsed.command, error);
        return 1;
      }
    }
    const action = parsed.action as ProductServiceAction;
    if (
      (action === "install" || action === "start" || action === "restart") &&
      (await requireLocalState(parsed, config, classifier, stderr)) === null
    ) {
      return 1;
    }
    try {
      let result: Awaited<ReturnType<ProductOperator["service"]>>;
      if (action === "restart") {
        operator.preflightServiceStart();
        await operator.service("stop");
        const release = await lifecycleLock(
          dependencies,
          config.state_dir,
          "runtime",
          15_000,
        );
        try {
          const started = await operator.service("start");
          result = { ...started, action: "restart", changed: true };
        } finally {
          await release();
        }
      } else if (
        action === "install" ||
        action === "start"
      ) {
        const before = await operator.status();
        if (before.service.running) {
          result = await operator.service(action);
        } else {
          const release = await lifecycleLock(
            dependencies,
            config.state_dir,
            "runtime",
            15_000,
          );
          try {
            result = await operator.service(action);
          } finally {
            await release();
          }
        }
      } else if (action === "stop" || action === "uninstall") {
        result = await operator.service(action);
        const release = await lifecycleLock(
          dependencies,
          config.state_dir,
          "runtime",
          15_000,
        );
        await release();
      } else {
        result = await operator.service(action);
      }
      print(stdout, {
        ok: true,
        command: parsed.command,
        ...result,
      });
      return 0;
    } catch (error) {
      printOperatorError(stderr, `${parsed.command} ${action}`, error);
      return 1;
    }
  }
  if (parsed.command === "validate-config") {
    const filesystem = await requireLocalState(
      parsed,
      config,
      classifier,
      stderr,
    );
    if (filesystem === null) return 1;
    print(stdout, {
      ok: true,
      command: parsed.command,
      lane: config.lane,
      filesystem,
      maturity: "DEV",
      adapter_references: configuredAdapterReferences(config),
      adapters_loaded: false,
      runtime_readiness: {
        checked: false,
        detail:
          "offline validation only: configuration schema, credential reference shape, and state filesystem were checked; no adapter was constructed and no credential, provider, or service health was verified",
      },
      wedge_executed: false,
    });
    return 0;
  }

  if (parsed.command === "approvals") {
    if ((await requireLocalState(parsed, config, classifier, stderr)) === null)
      return 1;
    let approvalResult: Record<string, unknown> | undefined;
    try {
      const release = await lifecycleLock(
        dependencies,
        config.state_dir,
        "maintenance",
        15_000,
      );
      try {
        prepareProductStateRoot(config.state_dir);
        // Listing stays local and read-only. Resolution is never a CLI verb:
        // the organization Slack approval surface is the one V1 resolver, so a
        // reviewer is always centrally attributed and authorized.
        const approvals =
          dependencies.composition?.approvals ??
          new DecisionNodeStore(config.state_dir, {
            now: dependencies.now,
          });
        await approvals.initialize();
        const exclusion = configuredOrganizationIngestExclusion(config);
        approvalResult = {
          ok: true,
          command: parsed.command,
          approvals: (await approvals.list()).map((record) => {
            const organizationRecord = projectDecisionOrganizationRecord(record);
            const excluded =
              record.status !== "pending" &&
              record.source !== null &&
              organizationRecord.status !== "published" &&
              organizationRecord.status !== "rejected" &&
              exclusion.excludes(record.source);
            return {
              approval_id: record.approval_id,
              status: record.status,
              requested_at: record.requested_at,
              reviewed_at: record.reviewed_at,
              reviewed_by: record.reviewed_by,
              reason: record.reason,
              brief: record.brief,
              organization_record: excluded
                ? { ...organizationRecord, status: "excluded" }
                : organizationRecord,
            };
          }),
        };
      } finally {
        await release();
      }
    } catch (error) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        error: (error as Error).message,
      });
      return 1;
    }
    print(stdout, approvalResult!);
    return 0;
  }

  if (parsed.command === "run-once") {
    let cycleResult: Record<string, unknown> | undefined;
    let cycleStatus = 1;
    try {
      const release = await lifecycleLock(
        dependencies,
        config.state_dir,
        "runtime",
        15_000,
      );
      try {
        prepareProductStateRoot(config.state_dir);
        const composition = await createCliComposition(
          config,
          classifier,
          dependencies,
        );
        try {
          const cycle = await composition.runOnce();
          const pending = (await composition.approvals.list())
            .filter((record) => record.status === "pending")
            .map((record) => record.approval_id);
          cycleStatus = cycle.ok ? 0 : 1;
          cycleResult = {
            ok: cycle.ok,
            command: parsed.command,
            cycle,
            pending_approval_ids: pending,
          };
        } finally {
          await composition.close();
        }
      } finally {
        await release();
      }
    } catch (error) {
      printRuntimeFailure(stderr, error);
      return 1;
    }
    print(cycleStatus === 0 ? stdout : stderr, cycleResult!);
    return cycleStatus;
  }

  print(stderr, { ok: false, error: commandUsage() });
  return 2;
}

/**
 * The long-running loop the LaunchAgent's `service-run` child executes: one
 * composition, an immediate cycle, then a cycle per interval until SIGINT or
 * SIGTERM, holding the runtime lifecycle lock throughout.
 */
async function runServiceDaemon(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
  dependencies: ProductCliDependencies,
  streams: {
    stdout: Pick<Writable, "write">;
    stderr: Pick<Writable, "write">;
  },
): Promise<number> {
  const { stdout, stderr } = streams;
  let releaseRuntime: ReleaseProductLifecycleLock;
  try {
    releaseRuntime = await lifecycleLock(
      dependencies,
      config.state_dir,
      "runtime",
      15_000,
    );
  } catch (error) {
    printRuntimeFailure(stderr, error);
    return 1;
  }
  try {
    prepareProductStateRoot(config.state_dir);
    const processLike = dependencies.process ?? process;
    let signalWaiter: SignalWaiter;
    try {
      signalWaiter = createSignalWaiter(processLike);
    } catch (error) {
      printRuntimeFailure(stderr, error);
      return 1;
    }

    let composition: ProductComposition;
    try {
      composition = await createCliComposition(
        config,
        classifier,
        dependencies,
      );
    } catch (error) {
      signalWaiter.cancel();
      printRuntimeFailure(stderr, error);
      return 1;
    }

    let active: Promise<void> | null = null;
    let activeController: AbortController | null = null;
    void signalWaiter.promise.then((signal) => {
      activeController?.abort(new Error(`shutdown requested by ${signal}`));
    });
    const runCycle = (): Promise<void> => {
      if (active !== null) return active;
      const controller = new AbortController();
      activeController = controller;
      active = composition
        .runOnce({ signal: controller.signal })
        .then((cycle) => {
          print(cycle.ok ? stdout : stderr, {
            ok: cycle.ok,
            command: "service-run",
            status: "cycle-complete",
            cycle,
          });
        })
        .catch((error: unknown) => {
          print(stderr, {
            ok: false,
            command: "service-run",
            status: "cycle-failed",
            error: (error as Error).message,
          });
        })
        .finally(() => {
          if (activeController === controller) activeController = null;
          active = null;
        });
      return active;
    };

    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      if (signalWaiter.received === undefined) await runCycle();
      if (signalWaiter.received === undefined) {
        interval = setInterval(
          () => void runCycle(),
          config.cycle_interval_ms ?? 60_000,
        );
      }
      const signal = signalWaiter.received ?? (await signalWaiter.promise);
      if (interval !== undefined) clearInterval(interval);
      if (active !== null) await active;
      await composition.close();
      print(stdout, { ok: true, signal, shutdown: { ok: true } });
      return 0;
    } catch (error) {
      signalWaiter.cancel();
      if (interval !== undefined) clearInterval(interval);
      try {
        await composition.close();
      } catch {
        // Preserve the original lifecycle failure in the CLI report.
      }
      printRuntimeFailure(stderr, error);
      return 1;
    }
  } finally {
    try {
      await releaseRuntime();
    } catch (error) {
      printRuntimeFailure(stderr, error);
      return 1;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runProductCli(process.argv.slice(2));
}
