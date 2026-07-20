#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AdapterInstanceConfig, CoreStateStore } from "../core/index.js";
import {
  assertConfiguredAdapterFactoriesAvailable,
  createConfiguredAdapterRegistry,
  type ProductAdapterFactoryRegistry,
} from "./adapter-factories.js";
import {
  prepareProductComposition,
  prepareProductStateRoot,
  resolveProductClock,
  type PrepareProductCompositionOptions,
  type ProductComposition,
} from "./composition.js";
import {
  classifyStateFilesystem,
  loadProductRuntimeConfig,
  type ClassifyStateFilesystem,
  type ProductRuntimeConfig,
} from "./config.js";
import { createDefaultAdapterFactories } from "./default-adapters.js";
import {
  DecisionNodeStore,
  type DecisionNodeFederationCapture,
} from "./approval/decision-node-store.js";
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
} from "./federation/identity-check.js";
import { MacOsSecureEnclaveInstallationSigner } from "./federation/macos-installation-signer.js";
import { bundledProductHelperAvailable } from "./spawn-sanitized-child.js";
import { createProductCredentialResolver } from "./credentials.js";
import {
  abortFounderBootstrap,
  beginFounderBootstrap,
  commitFounderBootstrapCeremony,
  statusFounderBootstrap,
  type FounderBootstrapCeremonyDependencies,
} from "./federation/founder-bootstrap-ceremony.js";
import { FederatedApprovalCapture } from "./federation/approval-capture.js";
import {
  openFounderFederationRuntime,
  type FounderFederationRuntime,
} from "./federation/runtime-wiring.js";
import { ActiveIdentityBundleStore } from "./federation/active-identity-bundle-store.js";
import { resolveProductStatePaths } from "./paths.js";
import { SqliteCoreStateStore } from "../storage/core-state-sqlite.js";

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
  /** Complete command-scoped federation seam for identity-active tests/hosts. */
  federationRuntime?: FounderFederationRuntime;
  founderBootstrap?: FounderBootstrapCeremonyDependencies;
  acquireLifecycleLock?: (
    stateDirectory: string,
    kind: ProductLifecycleLockKind,
    options: { timeoutMs: number },
  ) => Promise<ReleaseProductLifecycleLock>;
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
    | "identity-bootstrap"
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
  identityBootstrapAction?: "begin" | "status" | "commit" | "abort";
  organizationName?: string;
  principalName?: string;
  slackUserId?: string;
  deviceClass?: "byod" | "managed";
  bootstrapSessionId?: string;
  confirmationSha256?: string;
  renewChallenge?: boolean;
}

const PRODUCT_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;
const CLI_PATH = realpathSync(fileURLToPath(import.meta.url));

const HELP = `echo-brain ${PRODUCT_VERSION}

Usage:
  echo-brain onboard --config <new-absolute-path> --state-dir <new-absolute-path>
  echo-brain init --config <absolute-path>
  echo-brain reconfigure --config <absolute-path>
  echo-brain status --config <absolute-path>
  echo-brain doctor --config <absolute-path>
  echo-brain identity-check --config <absolute-path> [--strict]
  echo-brain identity-bootstrap begin --config <absolute-path> --organization-name <name> --principal-name <name> --slack-user-id <U...> [--device-class <byod|managed>]
  echo-brain identity-bootstrap status --config <absolute-path> --session <uuid> [--renew-challenge]
  echo-brain identity-bootstrap commit --config <absolute-path> --session <uuid> --confirm <sha256:...>
  echo-brain identity-bootstrap abort --config <absolute-path> --session <uuid> --confirm <installation-key-sha256>
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
    command !== "identity-bootstrap" &&
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
      "usage: echo-brain <onboard|init|reconfigure|status|doctor|identity-check|identity-bootstrap|service|backup|restore|validate-config|selftest|run-once|run|approvals|approve|reject> --config <absolute-path>",
    );
  }
  let serviceAction: ProductServiceAction | undefined;
  let identityBootstrapAction:
    "begin" | "status" | "commit" | "abort" | undefined;
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
  if (command === "identity-bootstrap") {
    const action = argv[1];
    if (
      action !== "begin" &&
      action !== "status" &&
      action !== "commit" &&
      action !== "abort"
    ) {
      throw new Error(
        "usage: echo-brain identity-bootstrap <begin|status|commit|abort> --config <absolute-path>",
      );
    }
    identityBootstrapAction = action;
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
      "device-class": { type: "string" },
      session: { type: "string" },
      confirm: { type: "string" },
      "renew-challenge": { type: "boolean" },
    },
  });
  if (parsed.values.config === undefined)
    throw new Error("--config is required");
  if (parsed.values.strict !== undefined && command !== "identity-check") {
    throw new Error("--strict is only valid with identity-check");
  }
  if (
    (command === "onboard" ||
      command === "init" ||
      command === "reconfigure" ||
      command === "status" ||
      command === "doctor" ||
      command === "identity-check" ||
      command === "identity-bootstrap" ||
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
  if (command === "identity-bootstrap") {
    const deviceClass = parsed.values["device-class"];
    if (
      deviceClass !== undefined &&
      deviceClass !== "byod" &&
      deviceClass !== "managed"
    ) {
      throw new Error("--device-class must be byod or managed");
    }
    if (identityBootstrapAction === "begin") {
      if (
        parsed.values["organization-name"] === undefined ||
        parsed.values["principal-name"] === undefined ||
        parsed.values["slack-user-id"] === undefined
      ) {
        throw new Error(
          "identity-bootstrap begin requires --organization-name, --principal-name, and --slack-user-id",
        );
      }
    } else if (parsed.values.session === undefined) {
      throw new Error(
        `identity-bootstrap ${identityBootstrapAction} requires --session`,
      );
    }
    if (
      (identityBootstrapAction === "commit" ||
        identityBootstrapAction === "abort") &&
      parsed.values.confirm === undefined
    ) {
      throw new Error(
        `identity-bootstrap ${identityBootstrapAction} requires --confirm`,
      );
    }
    if (
      parsed.values["renew-challenge"] === true &&
      identityBootstrapAction !== "status"
    ) {
      throw new Error(
        "--renew-challenge is only valid with identity-bootstrap status",
      );
    }
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
    ...(identityBootstrapAction === undefined
      ? {}
      : { identityBootstrapAction }),
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
    ...(parsed.values["organization-name"] === undefined
      ? {}
      : { organizationName: parsed.values["organization-name"] }),
    ...(parsed.values["principal-name"] === undefined
      ? {}
      : { principalName: parsed.values["principal-name"] }),
    ...(parsed.values["slack-user-id"] === undefined
      ? {}
      : { slackUserId: parsed.values["slack-user-id"] }),
    ...(parsed.values["device-class"] === undefined
      ? {}
      : {
          deviceClass: parsed.values["device-class"] as "byod" | "managed",
        }),
    ...(parsed.values.session === undefined
      ? {}
      : { bootstrapSessionId: parsed.values.session }),
    ...(parsed.values.confirm === undefined
      ? {}
      : { confirmationSha256: parsed.values.confirm }),
    ...(parsed.values["renew-challenge"] === true
      ? { renewChallenge: true }
      : {}),
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

function identityRequiresFederation(stateDirectory: string): boolean {
  const identity = new ActiveIdentityBundleStore(stateDirectory);
  return identity.hasActiveBundle() || identity.hasIdentityMaterial();
}

async function createCliComposition(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
  dependencies: ProductCliDependencies,
): Promise<ProductComposition> {
  const factories =
    dependencies.adapterFactories ?? createDefaultAdapterFactories();
  const now = dependencies.composition?.now ?? dependencies.now;
  const customComposition = dependencies.composition;
  const hasCustomFederationWiring =
    customComposition?.state !== undefined ||
    customComposition?.approvals !== undefined ||
    customComposition?.approvalFederationCapture !== undefined ||
    customComposition?.approvalGate !== undefined;
  const requiresFederation = identityRequiresFederation(config.state_dir);
  if (requiresFederation && customComposition?.approvalGate !== undefined) {
    throw new ProductRuntimeFailure(
      "identity_not_seed_grade",
      "identity-active mode rejects a caller-owned approval gate",
      [
        "the federation-owned approval store and capture path must observe every post-cutover resolution",
      ],
    );
  }
  if (requiresFederation && customComposition?.approvals !== undefined) {
    throw new ProductRuntimeFailure(
      "identity_not_seed_grade",
      "identity-active mode rejects a caller-owned approval store",
      [
        "the complete federation runtime must own the approval store used by projection readiness",
      ],
    );
  }
  if (
    hasCustomFederationWiring &&
    requiresFederation &&
    dependencies.federationRuntime === undefined
  ) {
    throw new ProductRuntimeFailure(
      "identity_not_seed_grade",
      "identity-active mode rejects partial custom composition wiring; supply one complete command-scoped federation runtime",
      [
        "custom state, approval store, or approval capture cannot bypass signed attribution and projection",
      ],
    );
  }
  if (
    hasCustomFederationWiring &&
    !requiresFederation &&
    dependencies.federationRuntime === undefined
  ) {
    const approvalFederationCapture = resolveApprovalFederationCapture(
      config,
      dependencies,
    );
    const registry = await createConfiguredAdapterRegistry(config, factories, {
      environment: dependencies.environment,
      now,
      approvalFederationCapture,
    });
    return await prepareProductComposition(config, registry, {
      ...customComposition,
      classifyStateFilesystem: classifier,
      identityCheck: resolveIdentityCheckDependencies(
        customComposition?.identityCheck ?? dependencies.identityCheck,
        config,
        dependencies.environment,
      ),
      approvalFederationCapture,
      ...(now === undefined ? {} : { now }),
    });
  }

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
  const identityBase = resolveIdentityCheckDependencies(
    customComposition?.identityCheck ?? dependencies.identityCheck,
    config,
    dependencies.environment,
  );
  const paths = resolveProductStatePaths(config.state_dir);
  let federation:
    Awaited<ReturnType<typeof openFounderFederationRuntime>> | undefined;
  try {
    federation =
      dependencies.federationRuntime ??
      (await openFounderFederationRuntime({
        runtimeConfig: config,
        databasePath: paths.database,
        signer: identityBase.signer,
        ...(now === undefined ? {} : { now }),
        ...(customComposition?.createId === undefined
          ? {}
          : { createId: customComposition.createId }),
      }));
    if (federation.identityEnabled !== requiresFederation) {
      throw new Error(
        "supplied federation runtime identity mode does not match the state root",
      );
    }
    if (
      customComposition?.approvalFederationCapture !== undefined &&
      customComposition.approvalFederationCapture !== federation.approvalCapture
    ) {
      throw new Error(
        "custom approval capture does not belong to the supplied complete federation runtime",
      );
    }
  } catch (error) {
    let closeFailure: unknown;
    try {
      await federation?.close();
    } catch (closeError) {
      closeFailure = closeError;
    }
    const detail = (error as Error).message;
    throw new ProductRuntimeFailure(
      "identity_not_seed_grade",
      `identity-enabled profile cannot initialize federation resources: ${detail}`,
      [
        detail,
        ...(closeFailure === undefined
          ? []
          : [
              `federation resource close failed: ${(closeFailure as Error).message}`,
            ]),
      ],
    );
  }
  if (federation === undefined) {
    throw new ProductRuntimeFailure(
      "identity_not_seed_grade",
      "identity-enabled profile did not initialize federation resources",
      ["command-scoped federation runtime is unavailable"],
    );
  }
  const identityCheck = federation.identityChecks(identityBase);
  let baseState: (CoreStateStore & { close?: () => void }) | undefined;
  let state: (CoreStateStore & { close?: () => void }) | undefined;
  try {
    // Keep adapter construction and provider contact behind the identity gate.
    await assertFounderIdentityAllowsPipeline(config.state_dir, identityCheck);
    const approvals =
      requiresFederation || customComposition?.approvals === undefined
        ? federation.createDecisionNodeStore()
        : customComposition.approvals;
    baseState =
      customComposition?.state ?? new SqliteCoreStateStore(paths.database);
    state = federation.wrapCoreState(baseState, approvals);
    const registry = await createConfiguredAdapterRegistry(config, factories, {
      environment: dependencies.environment,
      now,
      approvalFederationCapture: federation.approvalCapture,
    });
    const configuredClose = customComposition?.closeResources;
    return await prepareProductComposition(config, registry, {
      ...customComposition,
      classifyStateFilesystem: async () => classification,
      state,
      approvals,
      identityCheck,
      approvalFederationCapture: federation.approvalCapture,
      closeResources: async () => {
        let failure: unknown;
        try {
          await configuredClose?.();
        } catch (error) {
          failure = error;
        }
        try {
          await federation.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      },
      ...(now === undefined ? {} : { now }),
    });
  } catch (error) {
    try {
      if (state !== undefined) state.close?.();
      else if (baseState !== undefined) baseState.close?.();
    } finally {
      await federation.close();
    }
    throw error;
  }
}

function resolveApprovalFederationCapture(
  config: ProductRuntimeConfig,
  dependencies: ProductCliDependencies,
): DecisionNodeFederationCapture {
  return (
    dependencies.composition?.approvalFederationCapture ??
    new FederatedApprovalCapture({
      stateDirectory: config.state_dir,
      runtimeConfig: config,
    })
  );
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
  if (!bundledProductHelperAvailable("installation-signer")) {
    return {
      ...configured,
      credentialResolver,
      ...(runtimeConfig === undefined ? {} : { runtimeConfig }),
    };
  }
  return {
    ...configured,
    credentialResolver,
    ...(runtimeConfig === undefined ? {} : { runtimeConfig }),
    signer: new MacOsSecureEnclaveInstallationSigner(),
  };
}

function isOnlyTargetProjectionPending(
  error: unknown,
  approvalId: string,
): boolean {
  if (!(error instanceof FounderIdentityGateError)) return false;
  const failures = error.report.checks.filter((item) => !item.ok);
  return (
    failures.length === 1 &&
    failures[0]!.id === "signed-outbox" &&
    failures[0]!.detail ===
      `projection pending: approval ${approvalId} has no signed outbox group`
  );
}

function resolveFounderBootstrapDependencies(
  dependencies: ProductCliDependencies,
): FounderBootstrapCeremonyDependencies {
  const configured = dependencies.founderBootstrap ?? {};
  const signer =
    configured.signer ??
    dependencies.identityCheck?.signer ??
    (bundledProductHelperAvailable("installation-signer")
      ? new MacOsSecureEnclaveInstallationSigner()
      : undefined);
  return {
    ...configured,
    ...(signer === undefined ? {} : { signer }),
    credentialResolver:
      configured.credentialResolver ??
      createProductCredentialResolver(dependencies.environment ?? process.env),
    now: configured.now ?? resolveProductClock(dependencies.now),
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
  const classifier =
    dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
  if (parsed.command === "identity-bootstrap") {
    const action = parsed.identityBootstrapAction!;
    const bootstrapDependencies =
      resolveFounderBootstrapDependencies(dependencies);
    if (bootstrapDependencies.signer === undefined) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        action,
        error:
          "signer_unavailable: seed-grade bootstrap requires the verified packaged Secure Enclave helper",
      });
      return 1;
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
    let releases: readonly ReleaseProductLifecycleLock[] = [];
    let result:
      | Awaited<ReturnType<typeof beginFounderBootstrap>>
      | Awaited<ReturnType<typeof abortFounderBootstrap>>
      | undefined;
    let operationFailure: unknown;
    try {
      if (action === "commit") {
        releases = await acquireMaintenanceWindow(
          config.state_dir,
          dependencies,
          0,
        );
        const operator = createProductOperator(
          parsed.configPath,
          config,
          dependencies,
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
            "service is loaded; stop it before committing founder identity",
          );
        }
      } else {
        releases = [
          await lifecycleLock(dependencies, config.state_dir, "maintenance", 0),
        ];
      }
      result =
        action === "begin"
          ? await beginFounderBootstrap(
              config,
              {
                organizationDisplayName: parsed.organizationName!,
                principalDisplayName: parsed.principalName!,
                slackUserId: parsed.slackUserId!,
                ...(parsed.deviceClass === undefined
                  ? {}
                  : { deviceClass: parsed.deviceClass }),
              },
              bootstrapDependencies,
            )
          : action === "status"
            ? await statusFounderBootstrap(
                config,
                parsed.bootstrapSessionId!,
                { renewChallenge: parsed.renewChallenge === true },
                bootstrapDependencies,
              )
            : action === "abort"
              ? await abortFounderBootstrap(
                  config,
                  parsed.bootstrapSessionId!,
                  parsed.confirmationSha256!,
                  bootstrapDependencies,
                )
              : await commitFounderBootstrapCeremony(
                  config,
                  parsed.bootstrapSessionId!,
                  parsed.confirmationSha256!,
                  bootstrapDependencies,
                );
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
      print(stderr, {
        ok: false,
        command: parsed.command,
        action,
        ...(operationFailure instanceof ProductOperatorError
          ? { code: operationFailure.code }
          : {}),
        error: (operationFailure as Error).message,
      });
      return 1;
    }
    print(stdout, {
      ok: true,
      command: parsed.command,
      action,
      ...result!,
    });
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
    let federation:
      Awaited<ReturnType<typeof openFounderFederationRuntime>> | undefined;
    try {
      const identityBase = resolveIdentityCheckDependencies(
        dependencies.identityCheck,
        config,
        dependencies.environment,
      );
      const foundationReport = await checkFounderIdentity(
        config.state_dir,
        identityBase,
      );
      const bundleVerified =
        foundationReport.mode === "identity_enabled" &&
        foundationReport.checks.find((item) => item.id === "bundle-integrity")
          ?.ok === true;
      let report = foundationReport;
      if (bundleVerified) {
        federation = await openFounderFederationRuntime({
          runtimeConfig: config,
          databasePath: resolveProductStatePaths(config.state_dir).database,
          signer: identityBase.signer,
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        });
        report = await checkFounderIdentity(
          config.state_dir,
          federation.identityChecks(identityBase),
        );
      }
      const strictFailure =
        parsed.strictIdentityCheck === true && !report.seed_grade_ready;
      const activeFailure =
        report.mode === "identity_enabled" && !report.foundation_ok;
      const status = strictFailure || activeFailure ? 1 : 0;
      print(status === 0 ? stdout : stderr, {
        ok: status === 0,
        command: parsed.command,
        strict: parsed.strictIdentityCheck === true,
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
    } finally {
      try {
        await federation?.close();
      } catch (error) {
        print(stderr, {
          ok: false,
          command: parsed.command,
          error: `federation resource close failed: ${(error as Error).message}`,
        });
        return 1;
      }
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
      try {
        const report = await operator.doctor({
          filesystem,
          adapters,
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
      { status: "ok"; kind: "sqlite-memory"; migrations: "loaded" } | undefined;
    if (parsed.command === "selftest") {
      try {
        const { SqliteStorage } = await import("../storage/sqlite.js");
        const { SqliteCoreStateStore } =
          await import("../storage/core-state-sqlite.js");
        const sqlite = new SqliteStorage(":memory:");
        const coreState = new SqliteCoreStateStore(":memory:");
        coreState.close();
        sqlite.close();
        storage = { status: "ok", kind: "sqlite-memory", migrations: "loaded" };
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
    let federation:
      Awaited<ReturnType<typeof openFounderFederationRuntime>> | undefined;
    try {
      const release = await lifecycleLock(
        dependencies,
        config.state_dir,
        "maintenance",
        15_000,
      );
      try {
        prepareProductStateRoot(config.state_dir);
        const customFederationWiring =
          dependencies.composition?.state !== undefined ||
          dependencies.composition?.approvals !== undefined ||
          dependencies.composition?.approvalFederationCapture !== undefined;
        const identityBase = resolveIdentityCheckDependencies(
          dependencies.identityCheck,
          config,
          dependencies.environment,
        );
        const requiresFederation = identityRequiresFederation(config.state_dir);
        if (
          customFederationWiring &&
          requiresFederation &&
          dependencies.federationRuntime === undefined
        ) {
          throw new Error(
            "identity-active mode rejects partial custom approval wiring; supply one complete command-scoped federation runtime",
          );
        }
        if (
          requiresFederation &&
          dependencies.composition?.approvals !== undefined
        ) {
          throw new Error(
            "identity-active mode rejects a caller-owned approval store; the complete federation runtime must own approval projection readiness",
          );
        }
        if (
          !customFederationWiring ||
          dependencies.federationRuntime !== undefined
        ) {
          federation =
            dependencies.federationRuntime ??
            (await openFounderFederationRuntime({
              runtimeConfig: config,
              databasePath: resolveProductStatePaths(config.state_dir).database,
              signer: identityBase.signer,
              ...(dependencies.now === undefined
                ? {}
                : { now: dependencies.now }),
            }));
          if (federation.identityEnabled !== requiresFederation) {
            throw new Error(
              "supplied federation runtime identity mode does not match the state root",
            );
          }
          if (
            dependencies.composition?.approvalFederationCapture !== undefined &&
            dependencies.composition.approvalFederationCapture !==
              federation.approvalCapture
          ) {
            throw new Error(
              "custom approval capture does not belong to the supplied complete federation runtime",
            );
          }
        }
        // The CLI resolves against the shared decision node store directly, so
        // a misconfigured or unreachable approval surface (e.g. Slack) can
        // never block a manual approval or rejection.
        const approvals =
          federation?.createDecisionNodeStore() ??
          new DecisionNodeStore(config.state_dir, {
            now: dependencies.now,
            federationCapture: resolveApprovalFederationCapture(
              config,
              dependencies,
            ),
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
          let exactApprovedProjectionRetry = false;
          if (parsed.command === "approve" && federation?.identityEnabled) {
            const existing = (await approvals.listFederated()).find(
              (record) => record.approval_id === parsed.approvalId,
            );
            exactApprovedProjectionRetry =
              existing?.status === "approved" &&
              existing.reviewed_by === parsed.reviewer &&
              existing.reason === (parsed.reason ?? null);
          }
          try {
            await assertFounderIdentityAllowsPipeline(
              config.state_dir,
              federation?.identityChecks(identityBase) ?? identityBase,
            );
          } catch (error) {
            if (
              !exactApprovedProjectionRetry ||
              !isOnlyTargetProjectionPending(error, parsed.approvalId!)
            ) {
              throw error;
            }
          }
          const record = await approvals.resolve({
            approvalId: parsed.approvalId!,
            status: parsed.command === "approve" ? "approved" : "rejected",
            reviewedBy: parsed.reviewer!,
            reason: parsed.reason,
            surface: "cli",
          });
          if (record.status === "approved" && federation?.identityEnabled) {
            try {
              await federation.projectApproved(record);
            } catch (error) {
              throw new Error(
                `approval recorded; federated projection pending: ${(error as Error).message}`,
              );
            }
          }
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
        let closeFailure: unknown;
        try {
          await federation?.close();
        } catch (error) {
          closeFailure = error;
        }
        try {
          await release();
        } catch (error) {
          closeFailure ??= error;
        }
        if (closeFailure !== undefined) throw closeFailure;
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

    if (
      dependencies.runtime !== undefined &&
      identityRequiresFederation(config.state_dir)
    ) {
      signalWaiter.cancel();
      printRuntimeFailure(
        stderr,
        new ProductRuntimeFailure(
          "identity_not_seed_grade",
          "identity-active mode rejects legacy custom runtime wiring",
          [
            "use command composition with one complete command-scoped federation runtime",
          ],
        ),
      );
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
