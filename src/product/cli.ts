#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { AdapterInstanceConfig } from '../core/index.js';
import {
  createConfiguredAdapterRegistry,
  type ProductAdapterFactoryRegistry,
} from './adapter-factories.js';
import {
  prepareProductComposition,
  prepareProductStateRoot,
  resolveProductClock,
  type PrepareProductCompositionOptions,
  type ProductComposition,
} from './composition.js';
import {
  classifyStateFilesystem,
  loadProductRuntimeConfig,
  type ClassifyStateFilesystem,
  type ProductRuntimeConfig,
} from './config.js';
import { createDefaultAdapterFactories } from './default-adapters.js';
import { DecisionNodeStore } from './approval/decision-node-store.js';
import {
  ProductRuntimeFailure,
  startProductRuntime,
  type ProductRuntimeDependencies,
} from './runtime.js';
import { diagnoseConfiguredAdapters } from './adapter-diagnostics.js';
import {
  onboardProduct,
  ProductOperator,
  ProductOperatorError,
  type ProductOperatorDependencies,
  type ProductServiceAction,
} from './operator-lifecycle.js';
import {
  acquireProductLifecycleLock,
  acquireProductMaintenanceLease,
  canonicalProductConfigSha256,
  type ProductMaintenanceLease,
  type ProductLifecycleLockKind,
  type ReleaseProductLifecycleLock,
} from './lifecycle-lock.js';
import {
  createProductStateBackup,
  restoreProductStateBackup,
} from './state-backup.js';

export interface ProductCliProcess {
  once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  removeListener: (
    event: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ) => unknown;
}

export interface ProductCliDependencies {
  classifyStateFilesystem?: ClassifyStateFilesystem;
  runtime?: ProductRuntimeDependencies;
  process?: ProductCliProcess;
  stdout?: Pick<Writable, 'write'>;
  stderr?: Pick<Writable, 'write'>;
  adapterFactories?: ProductAdapterFactoryRegistry;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  composition?: Omit<
    PrepareProductCompositionOptions,
    'classifyStateFilesystem'
  >;
  operator?: Partial<ProductOperatorDependencies>;
  doctorHealthTimeoutMs?: number;
  acquireLifecycleLock?: (
    stateDirectory: string,
    kind: ProductLifecycleLockKind,
    options: { timeoutMs: number },
  ) => Promise<ReleaseProductLifecycleLock>;
}

interface ParsedCommand {
  command:
    | 'validate-config'
    | 'selftest'
    | 'run-once'
    | 'run'
    | 'service-run'
    | 'onboard'
    | 'init'
    | 'reconfigure'
    | 'status'
    | 'doctor'
    | 'service'
    | 'backup'
    | 'restore'
    | 'approvals'
    | 'approve'
    | 'reject';
  configPath: string;
  approvalId?: string;
  reviewer?: string;
  reason?: string;
  stateDirectory?: string;
  serviceAction?: ProductServiceAction;
  backupRoot?: string;
  backupDirectory?: string;
  operationId?: string;
}

const PRODUCT_VERSION = (
  JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
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

function print(stream: Pick<Writable, 'write'>, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (
    command !== 'validate-config' &&
    command !== 'onboard' &&
    command !== 'init' &&
    command !== 'reconfigure' &&
    command !== 'status' &&
    command !== 'doctor' &&
    command !== 'service' &&
    command !== 'backup' &&
    command !== 'restore' &&
    command !== 'selftest' &&
    command !== 'run-once' &&
    command !== 'service-run' &&
    command !== 'approvals' &&
    command !== 'approve' &&
    command !== 'reject' &&
    command !== 'run'
  ) {
    throw new Error(
      'usage: echo-brain <onboard|init|reconfigure|status|doctor|service|backup|restore|validate-config|selftest|run-once|run|approvals|approve|reject> --config <absolute-path>',
    );
  }
  let serviceAction: ProductServiceAction | undefined;
  let optionOffset = 1;
  if (command === 'service') {
    const action = argv[1];
    if (
      action !== 'install' &&
      action !== 'start' &&
      action !== 'stop' &&
      action !== 'restart' &&
      action !== 'status' &&
      action !== 'uninstall'
    ) {
      throw new Error(
        'usage: echo-brain service <install|start|stop|restart|status|uninstall> --config <absolute-path>',
      );
    }
    serviceAction = action;
    optionOffset = 2;
  }
  const parsed = parseArgs({
    args: [...argv.slice(optionOffset)],
    strict: true,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      id: { type: 'string' },
      reviewer: { type: 'string' },
      reason: { type: 'string' },
      'state-dir': { type: 'string' },
      'backup-root': { type: 'string' },
      backup: { type: 'string' },
    },
  });
  if (parsed.values.config === undefined)
    throw new Error('--config is required');
  if (
    (command === 'onboard' ||
      command === 'init' ||
      command === 'reconfigure' ||
      command === 'status' ||
      command === 'doctor' ||
      command === 'service' ||
      command === 'service-run' ||
      command === 'backup' ||
      command === 'restore') &&
    !isAbsolute(parsed.values.config)
  ) {
    throw new Error('--config must be an absolute path');
  }
  if (command === 'onboard') {
    if (parsed.values['state-dir'] === undefined)
      throw new Error('--state-dir is required');
    if (!isAbsolute(parsed.values['state-dir']))
      throw new Error('--state-dir must be an absolute path');
  }
  if (command === 'approve' || command === 'reject') {
    if (parsed.values.id === undefined) throw new Error('--id is required');
    if (
      parsed.values.reviewer === undefined ||
      parsed.values.reviewer.trim() === ''
    ) {
      throw new Error('--reviewer is required');
    }
  }
  if (command === 'backup' || command === 'restore') {
    if (parsed.values['backup-root'] === undefined)
      throw new Error('--backup-root is required');
    if (!isAbsolute(parsed.values['backup-root']))
      throw new Error('--backup-root must be an absolute path');
  }
  if (command === 'restore') {
    if (parsed.values.backup === undefined)
      throw new Error('--backup is required');
    if (!isAbsolute(parsed.values.backup))
      throw new Error('--backup must be an absolute path');
    if (parsed.values.id === undefined)
      throw new Error('--id is required for crash-resumable restore');
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
    ...(parsed.values['state-dir'] === undefined
      ? {}
      : { stateDirectory: parsed.values['state-dir'] }),
    ...(serviceAction === undefined ? {} : { serviceAction }),
    ...(parsed.values['backup-root'] === undefined
      ? {}
      : { backupRoot: parsed.values['backup-root'] }),
    ...(parsed.values.backup === undefined
      ? {}
      : { backupDirectory: parsed.values.backup }),
    ...((command !== 'backup' && command !== 'restore') ||
    parsed.values.id === undefined
      ? {}
      : { operationId: parsed.values.id }),
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
  return { ok: filesystem.kind === 'local', filesystem };
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
    ...(config.approval_mode === 'adapter'
      ? { approval_surface: adapterReference(config.approval_surface) }
      : {}),
  };
}

interface SignalWaiter {
  readonly promise: Promise<'SIGINT' | 'SIGTERM'>;
  readonly received: 'SIGINT' | 'SIGTERM' | undefined;
  cancel(): void;
}

function createSignalWaiter(processLike: ProductCliProcess): SignalWaiter {
  let active = true;
  let received: 'SIGINT' | 'SIGTERM' | undefined;
  let resolveSignal: (signal: 'SIGINT' | 'SIGTERM') => void = () => undefined;
  const promise = new Promise<'SIGINT' | 'SIGTERM'>((resolve) => {
    resolveSignal = resolve;
  });
  const cleanup = () => {
    if (!active) return;
    active = false;
    processLike.removeListener('SIGINT', onInterrupt);
    processLike.removeListener('SIGTERM', onTerminate);
  };
  const receive = (signal: 'SIGINT' | 'SIGTERM') => {
    if (!active) return;
    received = signal;
    cleanup();
    resolveSignal(signal);
  };
  const onInterrupt = () => receive('SIGINT');
  const onTerminate = () => receive('SIGTERM');
  try {
    processLike.once('SIGINT', onInterrupt);
    processLike.once('SIGTERM', onTerminate);
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
  stderr: Pick<Writable, 'write'>,
  error: unknown,
): void {
  const failure =
    error instanceof ProductRuntimeFailure
      ? error
      : new ProductRuntimeFailure(
          'adapter_unavailable',
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

async function createCliComposition(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
  dependencies: ProductCliDependencies,
): Promise<ProductComposition> {
  const factories =
    dependencies.adapterFactories ?? createDefaultAdapterFactories();
  const now = dependencies.composition?.now ?? dependencies.now;
  const registry = await createConfiguredAdapterRegistry(config, factories, {
    environment: dependencies.environment,
    now,
  });
  return await prepareProductComposition(config, registry, {
    ...dependencies.composition,
    classifyStateFilesystem: classifier,
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
    'runtime',
    timeoutMs,
  );
  try {
    const maintenance = await lifecycleLock(
      dependencies,
      stateDirectory,
      'maintenance',
      timeoutMs,
    );
    return [runtime, maintenance];
  } catch (error) {
    await runtime();
    throw error;
  }
}

function operationId(
  prefix: 'backup' | 'restore' | 'pre-restore',
  timestamp: string,
  requested?: string,
): string {
  if (requested !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(requested)) {
      throw new Error(
        'operation id must be 1-100 letters, numbers, dots, underscores, or hyphens',
      );
    }
    return requested;
  }
  return `${prefix}-${timestamp.replace(/[^0-9A-Za-z]/g, '')}`;
}

function printOperatorError(
  stderr: Pick<Writable, 'write'>,
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
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
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
  if (parsed.command === 'onboard') {
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
  if (parsed.command === 'service-run') {
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
  if (parsed.command === 'backup' || parsed.command === 'restore') {
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
          'unsupported_platform',
          'cannot prove the product service is stopped on this platform',
        );
      }
      if (status.service.loaded) {
        throw new ProductOperatorError(
          'service_command_failed',
          'service is loaded; run `echo-brain service stop --config <absolute-path>` before maintenance',
        );
      }
      if (parsed.command === 'backup' && !status.initialized) {
        throw new ProductOperatorError(
          'not_initialized',
          'run `echo-brain init --config <absolute-path>` before backup',
        );
      }
      const timestamp = resolveProductClock(dependencies.now)();
      const canonicalConfigSha256 = canonicalProductConfigSha256(config);
      if (parsed.command === 'backup') {
        const created = await createProductStateBackup({
          stateDir: config.state_dir,
          backupRoot: parsed.backupRoot!,
          backupId: operationId('backup', timestamp, parsed.operationId),
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
        const restoreId = operationId('restore', timestamp, parsed.operationId);
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
    parsed.command === 'init' ||
    parsed.command === 'reconfigure' ||
    parsed.command === 'status' ||
    parsed.command === 'doctor' ||
    parsed.command === 'service'
  ) {
    let operator: ProductOperator;
    try {
      operator = createProductOperator(parsed.configPath, config, dependencies);
    } catch (error) {
      printOperatorError(stderr, parsed.command, error);
      return 1;
    }
    if (parsed.command === 'status') {
      try {
        const status = await operator.status();
        print(stdout, { ok: true, command: parsed.command, ...status });
        return 0;
      } catch (error) {
        printOperatorError(stderr, parsed.command, error);
        return 1;
      }
    }
    if (parsed.command === 'doctor') {
      let filesystem: Awaited<ReturnType<ClassifyStateFilesystem>>;
      try {
        filesystem = await classifier(config.state_dir);
      } catch (error) {
        filesystem = {
          kind: 'unknown',
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
    if (parsed.command === 'init') {
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
        let result: Awaited<ReturnType<ProductOperator['init']>>;
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
    if (parsed.command === 'reconfigure') {
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
        let result: Awaited<ReturnType<ProductOperator['reconfigure']>>;
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
    if (action === 'install' || action === 'start' || action === 'restart') {
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
      let result: Awaited<ReturnType<ProductOperator['service']>>;
      if (action === 'restart') {
        operator.preflightServiceStart();
        await operator.service('stop');
        const release = await lifecycleLock(
          dependencies,
          config.state_dir,
          'runtime',
          15_000,
        );
        try {
          const started = await operator.service('start');
          result = { ...started, action: 'restart', changed: true };
        } finally {
          await release();
        }
      } else if (action === 'install' || action === 'start') {
        const before = await operator.status();
        if (before.service.running) {
          result = await operator.service(action);
        } else {
          const release = await lifecycleLock(
            dependencies,
            config.state_dir,
            'runtime',
            15_000,
          );
          try {
            result = await operator.service(action);
          } finally {
            await release();
          }
        }
      } else if (action === 'stop' || action === 'uninstall') {
        result = await operator.service(action);
        const release = await lifecycleLock(
          dependencies,
          config.state_dir,
          'runtime',
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
  if (parsed.command === 'validate-config' || parsed.command === 'selftest') {
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
      { status: 'ok'; kind: 'sqlite-memory'; migrations: 'loaded' } | undefined;
    if (parsed.command === 'selftest') {
      try {
        const { SqliteStorage } = await import('../storage/sqlite.js');
        const { SqliteCoreStateStore } =
          await import('../storage/core-state-sqlite.js');
        const sqlite = new SqliteStorage(':memory:');
        const coreState = new SqliteCoreStateStore(':memory:');
        coreState.close();
        sqlite.close();
        storage = { status: 'ok', kind: 'sqlite-memory', migrations: 'loaded' };
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
      maturity: 'DEV',
      adapter_references: configuredAdapterReferences(config),
      adapters_loaded: false,
      ...(storage === undefined ? {} : { storage }),
      wedge_executed: false,
    });
    return 0;
  }

  if (
    parsed.command === 'approvals' ||
    parsed.command === 'approve' ||
    parsed.command === 'reject'
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
        'maintenance',
        15_000,
      );
      try {
        prepareProductStateRoot(config.state_dir);
        // The CLI resolves against the shared decision node store directly, so
        // a misconfigured or unreachable approval surface (e.g. Slack) can
        // never block a manual approval or rejection.
        const approvals = new DecisionNodeStore(config.state_dir, {
          now: dependencies.now,
        });
        await approvals.initialize();
        if (parsed.command === 'approvals') {
          const records = (await approvals.list()).map((record) => ({
            approval_id: record.approval_id,
            status: record.status,
            requested_at: record.requested_at,
            reviewed_at: record.reviewed_at,
            reviewed_by: record.reviewed_by,
            reason: record.reason,
            brief: record.brief,
          }));
          approvalResult = {
            ok: true,
            command: parsed.command,
            approvals: records,
          };
        } else {
          const record = await approvals.resolve({
            approvalId: parsed.approvalId!,
            status: parsed.command === 'approve' ? 'approved' : 'rejected',
            reviewedBy: parsed.reviewer!,
            reason: parsed.reason,
            surface: 'cli',
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

  if (parsed.command === 'run-once') {
    let cycleResult: Record<string, unknown> | undefined;
    let cycleStatus = 1;
    try {
      const release = await lifecycleLock(
        dependencies,
        config.state_dir,
        'runtime',
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
            .filter((record) => record.status === 'pending')
            .map((record) => record.approval_id);
          cycleStatus = cycle.ok ? 0 : 1;
          cycleResult = {
            ok: cycle.ok,
            command: parsed.command,
            cycle,
            pending_approval_ids: pending,
          };
        } finally {
          composition.close();
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
      'runtime',
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
            command: 'run',
            status: 'cycle-complete',
            cycle,
          });
        })
        .catch((error: unknown) => {
          print(stderr, {
            ok: false,
            command: 'run',
            status: 'cycle-failed',
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
      composition.close();
      print(stdout, { ok: true, signal, shutdown: { ok: true } });
      return 0;
    } catch (error) {
      signalWaiter.cancel();
      if (interval !== undefined) clearInterval(interval);
      try {
        composition.close();
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
