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
  createConfiguredAdapterRegistry,
  type ProductAdapterFactoryRegistry,
} from "./adapter-factories.js";
import {
  assertProductAccess,
  assertRetiredFounderProvenanceRefused,
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
import {
  ProductRuntimeFailure,
  startProductRuntime,
  type ProductRuntimeDependencies,
} from "./runtime.js";
import { diagnoseConfiguredAdapters } from "./adapter-diagnostics.js";
import {
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
import {
  assertFounderIdentityAllowsPipeline,
  checkFounderIdentity,
  FounderIdentityGateError,
  type IdentityCheckDependencies,
} from "./federation/bootstrap/identity-check.js";
import { FileInstallationSigner } from "./machine/security/file-installation-signer.js";
import type { InstallationSigner } from "./machine/security/installation-signer.js";
import {
  createLocalOrganizationRuntime,
  DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS,
  HttpOrganizationAuthorityClient,
  OrganizationApprovalActionAuthorizer,
  organizationApprovalResolutionRequiresAuthority,
  OrganizationRuntimeAccessController,
  OrganizationAuthorityTransportError,
  organizationEnrollmentGrantSha256,
  readPrivateOrganizationEnrollmentInvitation,
  SqliteOrganizationStateStore,
  validateOrganizationAuthorityDescriptorResponse,
  type HttpOrganizationAuthorityClientOptions,
  type OrganizationInstallationAccessDecisionV1,
  verifyOrganizationAuthorityPin,
} from "./organization/index.js";
import { createProductCredentialResolver } from "./credentials.js";
import { ActiveIdentityBundleStore } from "./federation/identity/active-identity-bundle-store.js";
import { RETIRED_FOUNDER_PROVENANCE_MESSAGE } from "./federation/cutover-fence.js";
import { resolveProductStatePaths } from "./paths.js";
import { SqliteCoreStateStore } from "./storage/sqlite-core-state-store.js";
import { readFileNoFollow } from "./secure-local-files.js";
import { SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION } from "../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js";
import {
  loadPackagedBuildIdentity,
  type PackagedBuildIdentityV1,
} from "./federation/build-identity.js";
import {
  runInternalLiveUpdate,
  type RunInternalLiveUpdateOptions,
} from "./update/internal-live-runner.js";
import type { InternalLiveCommandRunner } from "./update/internal-live-node-operations.js";

export interface ProductCliProcess {
  once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  removeListener: (
    event: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => unknown;
}

export interface ProductCliDependencies {
  classifyStateFilesystem?: ClassifyStateFilesystem;
  runtime?: ProductRuntimeDependencies;
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
  identityCheck?: IdentityCheckDependencies;
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
    publicFetch?: typeof fetch;
    commandRunner?: InternalLiveCommandRunner;
    npmPath?: string;
    nextDirectiveRequestId?: () => string;
    nextTransactionId?: () => string;
  };
}

interface ParsedCommand {
  command:
    | "validate-config"
    | "selftest"
    | "run-once"
    | "run"
    | "service-run"
    | "onboard"
    | "init"
    | "reconfigure"
    | "status"
    | "doctor"
    | "identity-check"
    | "organization"
    | "update"
    | "service"
    | "backup"
    | "restore"
    | "approvals"
    | "approve"
    | "reject";
  configPath: string;
  approvalId?: string;
  reviewer?: string;
  reason?: string;
  stateDirectory?: string;
  serviceAction?: ProductServiceAction;
  backupRoot?: string;
  backupDirectory?: string;
  operationId?: string;
  strictIdentityCheck?: boolean;
  allowExportableSoftwareKey?: boolean;
  organizationAction?:
    | "enroll"
    | "status"
    | "refresh"
    | "rebind"
    | "slack-link-begin"
    | "slack-link-complete";
  updateAction?: "apply";
  updateChannel?: "internal-live";
  doctorLocalOnly?: boolean;
  slackLinkAttemptId?: string;
  slackLinkMessageTs?: string;
  invitationPath?: string;
  authorityPin?: string;
  authorityUrl?: string;
  authorityCaPath?: string;
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
  echo-brain onboard --config <new-absolute-path> --state-dir <new-absolute-path>
  echo-brain init --config <absolute-path>
  echo-brain reconfigure --config <absolute-path>
  echo-brain status --config <absolute-path>
  echo-brain doctor --config <absolute-path> [--local-only]
  echo-brain identity-check --config <absolute-path> [--strict]
  echo-brain organization enroll --config <absolute-path> --invitation <absolute-path> --authority-pin <sha256:...> [--authority-ca <absolute-path>] --allow-exportable-software-key
  echo-brain organization status --config <absolute-path>
  echo-brain organization refresh --config <absolute-path>
  echo-brain organization rebind --config <absolute-path> --authority-url <https-origin> --authority-pin <sha256:...> [--authority-ca <absolute-path>]
  echo-brain organization slack-link-begin --config <absolute-path>
  echo-brain organization slack-link-complete --config <absolute-path> --challenge-attempt <cat_...> --challenge-message-ts <Slack timestamp>  # reads ECHO_SLACK_LINK_CODE
  echo-brain update apply --channel internal-live --config <absolute-path>
  echo-brain service <install|start|stop|restart|status|uninstall> --config <absolute-path>
  echo-brain backup --config <absolute-path> --backup-root <absolute-path> [--id <operation-id>]
  echo-brain restore --config <absolute-path> --backup <absolute-path> --backup-root <absolute-path> --id <operation-id>
  echo-brain validate-config --config <absolute-path>
  echo-brain selftest --config <absolute-path>
  echo-brain run-once --config <absolute-path>
  echo-brain run --config <absolute-path>
  echo-brain approvals --config <absolute-path>
  echo-brain approve --config <absolute-path> --id <approval-id> --reviewer <name>
  echo-brain reject --config <absolute-path> --id <approval-id> --reviewer <name> [--reason <text>]
  echo-brain --version
  echo-brain --help
`;

function print(stream: Pick<Writable, "write">, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (
    command !== "validate-config" &&
    command !== "onboard" &&
    command !== "init" &&
    command !== "reconfigure" &&
    command !== "status" &&
    command !== "doctor" &&
    command !== "identity-check" &&
    command !== "organization" &&
    command !== "update" &&
    command !== "service" &&
    command !== "backup" &&
    command !== "restore" &&
    command !== "selftest" &&
    command !== "run-once" &&
    command !== "service-run" &&
    command !== "approvals" &&
    command !== "approve" &&
    command !== "reject" &&
    command !== "run"
  ) {
    throw new Error(
      "usage: echo-brain <onboard|init|reconfigure|status|doctor|identity-check|organization|update|service|backup|restore|validate-config|selftest|run-once|run|approvals|approve|reject> --config <absolute-path>",
    );
  }
  let serviceAction: ProductServiceAction | undefined;
  let organizationAction:
    | "enroll"
    | "status"
    | "refresh"
    | "rebind"
    | "slack-link-begin"
    | "slack-link-complete"
    | undefined;
  let updateAction: "apply" | undefined;
  let optionOffset = 1;
  if (command === "service") {
    const action = argv[1];
    if (
      action !== "install" &&
      action !== "start" &&
      action !== "stop" &&
      action !== "restart" &&
      action !== "status" &&
      action !== "uninstall"
    ) {
      throw new Error(
        "usage: echo-brain service <install|start|stop|restart|status|uninstall> --config <absolute-path>",
      );
    }
    serviceAction = action;
    optionOffset = 2;
  }
  if (command === "organization") {
    const action = argv[1];
    if (
      action !== "enroll" &&
      action !== "status" &&
      action !== "refresh" &&
      action !== "rebind" &&
      action !== "slack-link-begin" &&
      action !== "slack-link-complete"
    ) {
      throw new Error(
        "usage: echo-brain organization <enroll|status|refresh|rebind|slack-link-begin|slack-link-complete> --config <absolute-path>",
      );
    }
    organizationAction = action;
    optionOffset = 2;
  }
  if (command === "update") {
    if (argv[1] !== "apply") {
      throw new Error(
        "usage: echo-brain update apply --channel internal-live --config <absolute-path>",
      );
    }
    updateAction = "apply";
    optionOffset = 2;
  }
  const parsed = parseArgs({
    args: [...argv.slice(optionOffset)],
    strict: true,
    allowPositionals: false,
    options: {
      config: { type: "string" },
      id: { type: "string" },
      reviewer: { type: "string" },
      reason: { type: "string" },
      "state-dir": { type: "string" },
      "backup-root": { type: "string" },
      backup: { type: "string" },
      strict: { type: "boolean" },
      "organization-name": { type: "string" },
      "principal-name": { type: "string" },
      "slack-user-id": { type: "string" },
      "allow-exportable-software-key": { type: "boolean" },
      invitation: { type: "string" },
      "authority-pin": { type: "string" },
      "authority-url": { type: "string" },
      "authority-ca": { type: "string" },
      "challenge-attempt": { type: "string" },
      "challenge-message-ts": { type: "string" },
      channel: { type: "string" },
      "local-only": { type: "boolean" },
    },
  });
  if (parsed.values.config === undefined)
    throw new Error("--config is required");
  if (parsed.values.strict !== undefined && command !== "identity-check") {
    throw new Error("--strict is only valid with identity-check");
  }
  if (
    parsed.values["local-only"] !== undefined &&
    command !== "doctor"
  ) {
    throw new Error("--local-only is only valid with doctor");
  }
  if (
    (command === "onboard" ||
      command === "init" ||
      command === "reconfigure" ||
      command === "status" ||
      command === "doctor" ||
      command === "identity-check" ||
      command === "organization" ||
      command === "update" ||
      command === "service" ||
      command === "service-run" ||
      command === "backup" ||
      command === "restore") &&
    !isAbsolute(parsed.values.config)
  ) {
    throw new Error("--config must be an absolute path");
  }
  if (command === "onboard") {
    if (parsed.values["state-dir"] === undefined)
      throw new Error("--state-dir is required");
    if (!isAbsolute(parsed.values["state-dir"]))
      throw new Error("--state-dir must be an absolute path");
  }
  if (
    command !== "organization" &&
    parsed.values["allow-exportable-software-key"] === true
  ) {
    throw new Error(
      "--allow-exportable-software-key is only valid with organization enroll",
    );
  }
  if (command === "organization") {
    if (organizationAction === "enroll") {
      if (parsed.values.invitation === undefined) {
        throw new Error("organization enroll requires --invitation");
      }
      if (!isAbsolute(parsed.values.invitation)) {
        throw new Error("--invitation must be an absolute path");
      }
      if (parsed.values["authority-pin"] === undefined) {
        throw new Error(
          "organization enroll requires --authority-pin from an independent trusted channel",
        );
      }
      if (parsed.values["authority-url"] !== undefined) {
        throw new Error("--authority-url is only valid with organization rebind");
      }
      if (
        parsed.values["authority-ca"] !== undefined &&
        !isAbsolute(parsed.values["authority-ca"])
      ) {
        throw new Error("--authority-ca must be an absolute path");
      }
    } else if (organizationAction === "rebind") {
      if (
        parsed.values["authority-url"] === undefined ||
        parsed.values["authority-pin"] === undefined
      ) {
        throw new Error(
          "organization rebind requires --authority-url and --authority-pin",
        );
      }
      if (parsed.values.invitation !== undefined) {
        throw new Error("--invitation is only valid with organization enroll");
      }
      if (parsed.values["allow-exportable-software-key"] === true) {
        throw new Error(
          "--allow-exportable-software-key is only valid with organization enroll",
        );
      }
      if (
        parsed.values["authority-ca"] !== undefined &&
        !isAbsolute(parsed.values["authority-ca"])
      ) {
        throw new Error("--authority-ca must be an absolute path");
      }
    } else {
      if (parsed.values.invitation !== undefined) {
        throw new Error(
          "--invitation is only valid with organization enroll",
        );
      }
      if (parsed.values["authority-pin"] !== undefined) {
        throw new Error(
          "--authority-pin is only valid with organization enroll or rebind",
        );
      }
      if (parsed.values["authority-url"] !== undefined) {
        throw new Error("--authority-url is only valid with organization rebind");
      }
      if (parsed.values["authority-ca"] !== undefined) {
        throw new Error(
          "--authority-ca is only valid with organization enroll or rebind",
        );
      }
      if (parsed.values["allow-exportable-software-key"] === true) {
        throw new Error(
          "--allow-exportable-software-key is only valid with organization enroll",
        );
      }
    }
    if (organizationAction === "slack-link-complete") {
      if (
        parsed.values["challenge-attempt"] === undefined ||
        parsed.values["challenge-message-ts"] === undefined
      ) {
        throw new Error(
          "organization slack-link-complete requires --challenge-attempt and --challenge-message-ts",
        );
      }
    } else if (
      parsed.values["challenge-attempt"] !== undefined ||
      parsed.values["challenge-message-ts"] !== undefined
    ) {
      throw new Error(
        "--challenge-attempt and --challenge-message-ts are only valid with organization slack-link-complete",
      );
    }
  } else {
    if (parsed.values.invitation !== undefined) {
      throw new Error("--invitation is only valid with organization enroll");
    }
    if (parsed.values["authority-pin"] !== undefined) {
      throw new Error(
        "--authority-pin is only valid with organization enroll or rebind",
      );
    }
    if (parsed.values["authority-url"] !== undefined) {
      throw new Error("--authority-url is only valid with organization rebind");
    }
    if (parsed.values["authority-ca"] !== undefined) {
      throw new Error(
        "--authority-ca is only valid with organization enroll or rebind",
      );
    }
    if (
      parsed.values["challenge-attempt"] !== undefined ||
      parsed.values["challenge-message-ts"] !== undefined
    ) {
      throw new Error(
        "--challenge-attempt and --challenge-message-ts are only valid with organization slack-link-complete",
      );
    }
  }
  if (command === "update") {
    if (parsed.values.channel !== "internal-live") {
      throw new Error(
        "update apply requires --channel internal-live",
      );
    }
  } else if (parsed.values.channel !== undefined) {
    throw new Error("--channel is only valid with update apply");
  }
  if (command === "approve" || command === "reject") {
    if (parsed.values.id === undefined) throw new Error("--id is required");
    if (
      parsed.values.reviewer === undefined ||
      parsed.values.reviewer.trim() === ""
    ) {
      throw new Error("--reviewer is required");
    }
  }
  if (command === "backup" || command === "restore") {
    if (parsed.values["backup-root"] === undefined)
      throw new Error("--backup-root is required");
    if (!isAbsolute(parsed.values["backup-root"]))
      throw new Error("--backup-root must be an absolute path");
  }
  if (command === "restore") {
    if (parsed.values.backup === undefined)
      throw new Error("--backup is required");
    if (!isAbsolute(parsed.values.backup))
      throw new Error("--backup must be an absolute path");
    if (parsed.values.id === undefined)
      throw new Error("--id is required for crash-resumable restore");
  }
  return {
    command,
    configPath: parsed.values.config,
    ...(parsed.values.id === undefined ? {} : { approvalId: parsed.values.id }),
    ...(parsed.values.reviewer === undefined
      ? {}
      : { reviewer: parsed.values.reviewer }),
    ...(parsed.values.reason === undefined
      ? {}
      : { reason: parsed.values.reason }),
    ...(parsed.values["state-dir"] === undefined
      ? {}
      : { stateDirectory: parsed.values["state-dir"] }),
    ...(serviceAction === undefined ? {} : { serviceAction }),
    ...(parsed.values["backup-root"] === undefined
      ? {}
      : { backupRoot: parsed.values["backup-root"] }),
    ...(parsed.values.backup === undefined
      ? {}
      : { backupDirectory: parsed.values.backup }),
    ...((command !== "backup" && command !== "restore") ||
    parsed.values.id === undefined
      ? {}
      : { operationId: parsed.values.id }),
    ...(parsed.values.strict === true ? { strictIdentityCheck: true } : {}),
    ...(parsed.values["allow-exportable-software-key"] === true
      ? { allowExportableSoftwareKey: true }
      : {}),
    ...(organizationAction === undefined ? {} : { organizationAction }),
    ...(updateAction === undefined
      ? {}
      : { updateAction, updateChannel: "internal-live" as const }),
    ...(parsed.values["local-only"] === true
      ? { doctorLocalOnly: true }
      : {}),
    ...(parsed.values["challenge-attempt"] === undefined
      ? {}
      : { slackLinkAttemptId: parsed.values["challenge-attempt"] }),
    ...(parsed.values["challenge-message-ts"] === undefined
      ? {}
      : { slackLinkMessageTs: parsed.values["challenge-message-ts"] }),
    ...(parsed.values.invitation === undefined
      ? {}
      : { invitationPath: parsed.values.invitation }),
    ...(parsed.values["authority-pin"] === undefined
      ? {}
      : { authorityPin: parsed.values["authority-pin"] }),
    ...(parsed.values["authority-url"] === undefined
      ? {}
      : { authorityUrl: parsed.values["authority-url"] }),
    ...(parsed.values["authority-ca"] === undefined
      ? {}
      : { authorityCaPath: parsed.values["authority-ca"] }),
  };
}

async function probeConfig(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
): Promise<{
  ok: boolean;
  filesystem: Awaited<ReturnType<ClassifyStateFilesystem>>;
}> {
  const filesystem = await classifier(config.state_dir);
  return { ok: filesystem.kind === "local", filesystem };
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
      : error instanceof FounderIdentityGateError
        ? new ProductRuntimeFailure(
            "identity_not_operationally_ready",
            error.message,
            error.report.checks
              .filter((item) => item.required_for_operation && !item.ok)
              .map((item) => `${item.id}: ${item.detail}`),
          )
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
 * The CLI shares the one retirement gate with composition, the runtime, and the
 * decision store; it only maps the refusal onto the CLI's failure type.
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
 * - `validate-config` and `selftest` report on configuration;
 * - `status` reports operator/service state;
 * - `identity-check` is the diagnostic that names the retirement;
 * - `backup` and `restore` preserve and recover the profile, and keep their own
 *   cutover-fence downgrade protection;
 * - `service stop`, `status`, and `uninstall` quiesce a fenced machine.
 *
 * `organization status` is deliberately NOT an exception: it opens and migrates
 * writable SQLite, so it is gated with every other organization action.
 *
 * `RETIRED_FOUNDER_PROVENANCE_MESSAGE` carries the recovery runbook. Its order
 * matters: `backup` refuses while the service is loaded, so `service stop`
 * comes first.
 */
function retiredProvenanceGateApplies(parsed: ParsedCommand): boolean {
  switch (parsed.command) {
    case "validate-config":
    case "selftest":
    case "status":
    case "identity-check":
    case "backup":
    case "restore":
      return false;
    case "service":
      return (
        parsed.serviceAction === "install" ||
        parsed.serviceAction === "start" ||
        parsed.serviceAction === "restart"
      );
    default:
      // onboard, init, reconfigure, doctor, organization (every action),
      // approvals, approve, reject, run-once, run, service-run.
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

function resolveOrganizationAuthorization(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): {
  accessGate: ProductAccessGate | undefined;
  approvalActionAuthorizer: OrganizationApprovalActionAuthorizer | undefined;
} {
  const databasePath = resolveProductStatePaths(config.state_dir).database;
  const state = new SqliteOrganizationStateStore(databasePath);
  let hasPin = false;
  let enrolled = false;
  let authorityBaseUrl: string | null = null;
  let authorityCaPem: string | null = null;
  try {
    hasPin = state.readPinnedAuthority() !== null;
    const enrollment = state.readEnrollment();
    enrolled =
      enrollment?.receipt !== null &&
      enrollment?.receipt !== undefined &&
      enrollment.accepted_access_sequence > 0;
    const connection = state.readAuthorityConnection();
    authorityBaseUrl = connection?.authority_base_url ?? null;
    authorityCaPem = connection?.authority_ca_pem ?? null;
  } finally {
    state.close();
  }
  if (enrolled && authorityBaseUrl === null) {
    throw new Error(
      "organization authority connection is unavailable for approval authorization",
    );
  }
  const configuredAccessGate = dependencies.composition?.accessGate;
  if (!enrolled && (configuredAccessGate !== undefined || !hasPin)) {
    return {
      accessGate: configuredAccessGate,
      approvalActionAuthorizer: undefined,
    };
  }
  const signer =
    dependencies.organization?.installationSigner ??
    new FileInstallationSigner(
      join(config.state_dir, "installation", "keys"),
    );
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
  return {
    accessGate,
    approvalActionAuthorizer:
      !enrolled || authorityBaseUrl === null
        ? undefined
        : new OrganizationApprovalActionAuthorizer({
            openState: () => new SqliteOrganizationStateStore(databasePath),
            authorityClient: new HttpOrganizationAuthorityClient({
              baseUrl: authorityBaseUrl,
              ...transport,
            }),
            installationSigner: signer,
            now,
          }),
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
  const { accessGate, approvalActionAuthorizer } =
    resolveOrganizationAuthorization(config, dependencies);
  // This check precedes adapter factories and credential resolution. The
  // composition repeats it immediately before health checks and every cycle.
  await assertProductAccess(accessGate);

  // Preserve the existing "adapters first" diagnostic without constructing
  // adapters or resolving credentials before the strict identity gate.
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
  const identityCheck = resolveIdentityCheckDependencies(
    customComposition?.identityCheck ?? dependencies.identityCheck,
    config,
    dependencies.environment,
  );
  // Keep adapter construction and provider contact behind the identity gate.
  await assertFounderIdentityAllowsPipeline(config.state_dir, identityCheck);
  const registry = await createConfiguredAdapterRegistry(config, factories, {
    environment: dependencies.environment,
    now,
    // No default capture exists in this build. A pristine profile composes the
    // decision store with no federation capture at all, which is what keeps the
    // store's own fail-closed guard meaningful; a permissive stub would defeat
    // it. Hosts extending capture supply their own through this seam.
    ...(customComposition?.approvalFederationCapture === undefined
      ? {}
      : {
          approvalFederationCapture:
            customComposition.approvalFederationCapture,
        }),
    ...(approvalActionAuthorizer === undefined
      ? {}
      : { approvalActionAuthorizer }),
  });
  return await prepareProductComposition(config, registry, {
    ...customComposition,
    classifyStateFilesystem: async () => classification,
    accessGate,
    identityCheck,
    ...(now === undefined ? {} : { now }),
  });
}

function resolveIdentityCheckDependencies(
  configured: IdentityCheckDependencies | undefined,
  runtimeConfig?: ProductRuntimeConfig,
  environment?: NodeJS.ProcessEnv,
): IdentityCheckDependencies {
  const credentialResolver =
    configured?.credentialResolver ??
    createProductCredentialResolver(environment ?? process.env);
  if (configured?.signer !== undefined) {
    return {
      ...configured,
      credentialResolver,
      ...(runtimeConfig === undefined ? {} : { runtimeConfig }),
    };
  }
  if (runtimeConfig === undefined) {
    return {
      ...configured,
      credentialResolver,
    };
  }
  return {
    ...configured,
    credentialResolver,
    runtimeConfig,
    signer: new FileInstallationSigner(
      join(runtimeConfig.state_dir, "installation", "keys"),
    ),
  };
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
  if (parsed.command === "onboard") {
    // `onboard` learns its state path from `--state-dir`, not from a config
    // file, and it is the one gated command whose target may not exist yet. An
    // absent root whose adjacent external cutover guard survived is still
    // fenced, so this runs before `onboardProduct` can create anything.
    try {
      refuseRetiredFounderProvenance(parsed.stateDirectory!);
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
    try {
      const result = onboardProduct(parsed.configPath, parsed.stateDirectory!, {
        fileSystem: dependencies.operator?.fileSystem,
      });
      print(stdout, { ok: true, command: parsed.command, ...result });
      return 0;
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
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
        ...(parsed.serviceAction === undefined
          ? {}
          : { action: parsed.serviceAction }),
        ...(parsed.organizationAction === undefined
          ? {}
          : { action: parsed.organizationAction }),
        code: "identity_not_operationally_ready",
        error: (error as Error).message,
      });
      return 1;
    }
  }
  const classifier =
    dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
  if (parsed.command === "update") {
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        action: parsed.updateAction,
        channel: parsed.updateChannel,
        filesystem: probe.filesystem,
      });
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
        ...(dependencies.internalLive?.publicFetch === undefined
          ? {}
          : { publicFetch: dependencies.internalLive.publicFetch }),
        ...(dependencies.internalLive?.commandRunner === undefined
          ? {}
          : { commandRunner: dependencies.internalLive.commandRunner }),
        ...(dependencies.internalLive?.npmPath === undefined
          ? {}
          : { npmPath: dependencies.internalLive.npmPath }),
        ...(dependencies.internalLive?.nextDirectiveRequestId === undefined
          ? {}
          : {
              nextDirectiveRequestId:
                dependencies.internalLive.nextDirectiveRequestId,
            }),
        ...(dependencies.internalLive?.nextTransactionId === undefined
          ? {}
          : {
              nextTransactionId:
                dependencies.internalLive.nextTransactionId,
            }),
      });
      const ok = result.receipt.outcome === "healthy";
      print(ok ? stdout : stderr, {
        ok,
        command: parsed.command,
        action: parsed.updateAction,
        channel: parsed.updateChannel,
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
    const action = parsed.organizationAction!;
    const usesDefaultFileSigner =
      dependencies.organization?.installationSigner === undefined;
    if (
      action === "enroll" &&
      usesDefaultFileSigner &&
      parsed.allowExportableSoftwareKey !== true
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
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        action,
        filesystem: probe.filesystem,
      });
      return 1;
    }
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
    let organizationResult: Record<string, unknown> | undefined;
    let operationFailure: unknown;
    try {
      releases =
        action === "status"
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

      if (action === "status") {
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
                DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS,
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
          const activeIdentity = new ActiveIdentityBundleStore(
            config.state_dir,
          ).loadVerified(config);
          if (
            activeIdentity !== null &&
            (activeIdentity.manifest.organization.organization_id !==
              invitation.organization_id ||
              activeIdentity.manifest.principal.principal_id !==
                invitation.issued.principal_id ||
              activeIdentity.manifest.membership.membership_id !==
                invitation.membership_id)
          ) {
            throw new Error(
              "organization invitation does not match the active product identity",
            );
          }
          const installationId =
            activeIdentity?.manifest.installation.installation_id ??
            retained?.request.installation_id ??
            (dependencies.organization?.createInstallationId?.() ??
              `ins_${randomUUID()}`);
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
                next_step: "unset ECHO_SLACK_LINK_CODE",
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
    print(stdout, organizationResult!);
    return 0;
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
  }
  if (parsed.command === "identity-check") {
    try {
      // Reporting, not enabling. A state root holding founder identity or
      // cutover material still reports `identity_enabled` and fails its
      // required checks, so the retired mode stays visible and refused rather
      // than silently downgraded to an unattributed local profile.
      const report = await checkFounderIdentity(
        config.state_dir,
        resolveIdentityCheckDependencies(
          dependencies.identityCheck,
          config,
          dependencies.environment,
        ),
      );
      const strictFailure =
        parsed.strictIdentityCheck === true && !report.seed_grade_ready;
      const activeFailure =
        report.mode === "identity_enabled" && !report.operational_ready;
      const status = strictFailure || activeFailure ? 1 : 0;
      print(status === 0 ? stdout : stderr, {
        ok: status === 0,
        command: parsed.command,
        strict: parsed.strictIdentityCheck === true,
        ...(report.mode === "identity_enabled"
          ? { unsupported_mode: RETIRED_FOUNDER_PROVENANCE_MESSAGE }
          : {}),
        ...report,
      });
      return status;
    } catch (error) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        error: (error as Error).message,
      });
      return 1;
    }
  }
  if (parsed.command === "backup" || parsed.command === "restore") {
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        filesystem: probe.filesystem,
      });
      return 1;
    }
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
      if (parsed.doctorLocalOnly !== true) {
        try {
          const factories =
            dependencies.adapterFactories ?? createDefaultAdapterFactories();
          const registry = await createConfiguredAdapterRegistry(
            config,
            factories,
            {
              environment: dependencies.environment,
              now: dependencies.now,
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
      try {
        const report = await operator.doctor({
          filesystem,
          adapters,
          includeAdapters: parsed.doctorLocalOnly !== true,
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
      const probe = await probeConfig(config, classifier);
      if (!probe.ok) {
        print(stderr, {
          ok: false,
          command: parsed.command,
          filesystem: probe.filesystem,
        });
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
      const probe = await probeConfig(config, classifier);
      if (!probe.ok) {
        print(stderr, {
          ok: false,
          command: parsed.command,
          filesystem: probe.filesystem,
        });
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
    const action = parsed.serviceAction!;
    if (action === "install" || action === "start" || action === "restart") {
      const probe = await probeConfig(config, classifier);
      if (!probe.ok) {
        print(stderr, {
          ok: false,
          command: parsed.command,
          action,
          filesystem: probe.filesystem,
        });
        return 1;
      }
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
      } else if (action === "install" || action === "start") {
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
  if (parsed.command === "validate-config" || parsed.command === "selftest") {
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        filesystem: probe.filesystem,
      });
      return 1;
    }
    let storage:
      | {
          status: "ok";
          kind: "product-state-sqlite-memory";
          migrations: "loaded";
        }
      | undefined;
    if (parsed.command === "selftest") {
      try {
        const coreState = new SqliteCoreStateStore(":memory:");
        coreState.close();
        storage = {
          status: "ok",
          kind: "product-state-sqlite-memory",
          migrations: "loaded",
        };
      } catch (error) {
        print(stderr, {
          ok: false,
          command: parsed.command,
          error: `SQLite selftest failed: ${(error as Error).message}`,
        });
        return 1;
      }
    }
    print(stdout, {
      ok: true,
      command: parsed.command,
      lane: config.lane,
      filesystem: probe.filesystem,
      maturity: "DEV",
      adapter_references: configuredAdapterReferences(config),
      adapters_loaded: false,
      ...(storage === undefined ? {} : { storage }),
      wedge_executed: false,
    });
    return 0;
  }

  if (
    parsed.command === "approvals" ||
    parsed.command === "approve" ||
    parsed.command === "reject"
  ) {
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        filesystem: probe.filesystem,
      });
      return 1;
    }
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
        const identityBase = resolveIdentityCheckDependencies(
          dependencies.identityCheck,
          config,
          dependencies.environment,
        );
        // Listing remains local. Resolution is local only for standalone
        // profiles; an enrolled organization must attribute and authorize the
        // human through a centrally governed approval surface.
        const approvals =
          dependencies.composition?.approvals ??
          new DecisionNodeStore(config.state_dir, {
            now: dependencies.now,
            // No capture: the store's own guard refuses to mutate or even read
            // a federated node without one, which is the fail-closed behavior
            // a permissive stub would silently remove.
            ...(dependencies.composition?.approvalFederationCapture === undefined
              ? {}
              : {
                  federationCapture:
                    dependencies.composition.approvalFederationCapture,
                }),
          });
        await approvals.initialize();
        if (parsed.command === "approvals") {
          const records = (await approvals.list()).map((record) => ({
            approval_id: record.approval_id,
            status: record.status,
            requested_at: record.requested_at,
            reviewed_at: record.reviewed_at,
            reviewed_by: record.reviewed_by,
            reason: record.reason,
            brief: record.brief,
            ...(Object.hasOwn(record.requested_metadata, "federation")
              ? {
                  federation: {
                    requested: record.requested_metadata["federation"],
                    resolved: record.resolved_metadata?.["federation"] ?? null,
                  },
                }
              : {}),
          }));
          approvalResult = {
            ok: true,
            command: parsed.command,
            approvals: records,
          };
        } else {
          const organizationState = new SqliteOrganizationStateStore(
            resolveProductStatePaths(config.state_dir).database,
          );
          let organizationManaged = false;
          try {
            organizationManaged =
              organizationApprovalResolutionRequiresAuthority(
                organizationState,
              );
          } finally {
            organizationState.close();
          }
          if (organizationManaged) {
            throw new Error(
              "CLI approval resolution is disabled after an organization Authority is pinned; use an organization-authorized approval surface",
            );
          }
          await assertFounderIdentityAllowsPipeline(
            config.state_dir,
            identityBase,
          );
          const record = await approvals.resolve({
            approvalId: parsed.approvalId!,
            status: parsed.command === "approve" ? "approved" : "rejected",
            reviewedBy: parsed.reviewer!,
            reason: parsed.reason,
            surface: "cli",
          });
          approvalResult = {
            ok: true,
            command: parsed.command,
            approval: {
              approval_id: record.approval_id,
              status: record.status,
              reviewed_at: record.reviewed_at,
              reviewed_by: record.reviewed_by,
              reason: record.reason,
            },
          };
        }
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

    if (dependencies.runtime !== undefined) {
      let runtime: Awaited<ReturnType<typeof startProductRuntime>>;
      try {
        runtime = await startProductRuntime(config, {
          ...dependencies.runtime,
          classifyStateFilesystem: classifier,
          identityCheck: resolveIdentityCheckDependencies(
            dependencies.runtime.identityCheck ?? dependencies.identityCheck,
            config,
            dependencies.environment,
          ),
        });
      } catch (error) {
        signalWaiter.cancel();
        printRuntimeFailure(stderr, error);
        return 1;
      }
      if (!runtime.ok) {
        signalWaiter.cancel();
        printRuntimeFailure(stderr, runtime.error);
        return 1;
      }
      const signal = signalWaiter.received ?? (await signalWaiter.promise);
      const shutdown = await runtime.handle.shutdown();
      print(shutdown.ok ? stdout : stderr, {
        ok: shutdown.ok,
        signal,
        shutdown,
      });
      return shutdown.ok ? 0 : 1;
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
            command: "run",
            status: "cycle-complete",
            cycle,
          });
        })
        .catch((error: unknown) => {
          print(stderr, {
            ok: false,
            command: "run",
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
