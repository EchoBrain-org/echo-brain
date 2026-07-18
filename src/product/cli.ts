#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
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
}

interface ParsedCommand {
  command:
    | 'validate-config'
    | 'selftest'
    | 'run-once'
    | 'run'
    | 'approvals'
    | 'approve'
    | 'reject';
  configPath: string;
  approvalId?: string;
  reviewer?: string;
  reason?: string;
}

const PRODUCT_VERSION = (
  JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  }
).version;

const HELP = `echo-brain ${PRODUCT_VERSION}

Usage:
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
    command !== 'selftest' &&
    command !== 'run-once' &&
    command !== 'approvals' &&
    command !== 'approve' &&
    command !== 'reject' &&
    command !== 'run'
  ) {
    throw new Error(
      'usage: echo-brain <validate-config|selftest|run-once|run|approvals|approve|reject> --config <absolute-path>',
    );
  }
  const parsed = parseArgs({
    args: [...argv.slice(1)],
    strict: true,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      id: { type: 'string' },
      reviewer: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  if (parsed.values.config === undefined)
    throw new Error('--config is required');
  if (command === 'approve' || command === 'reject') {
    if (parsed.values.id === undefined) throw new Error('--id is required');
    if (parsed.values.reviewer === undefined || parsed.values.reviewer.trim() === '') {
      throw new Error('--reviewer is required');
    }
  }
  return {
    command,
    configPath: parsed.values.config,
    ...(parsed.values.id === undefined
      ? {}
      : { approvalId: parsed.values.id }),
    ...(parsed.values.reviewer === undefined
      ? {}
      : { reviewer: parsed.values.reviewer }),
    ...(parsed.values.reason === undefined
      ? {}
      : { reason: parsed.values.reason }),
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
    communication_channels: config.communication_channels.map(adapterReference),
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
  let config: ProductRuntimeConfig;
  try {
    parsed = parseCommand(argv);
    config = loadProductRuntimeConfig(parsed.configPath);
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }
  const classifier =
    dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
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
        const { SqliteCoreStateStore } = await import(
          '../storage/core-state-sqlite.js'
        );
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
        print(stdout, { ok: true, command: parsed.command, approvals: records });
        return 0;
      }
      const record = await approvals.resolve({
        approvalId: parsed.approvalId!,
        status: parsed.command === 'approve' ? 'approved' : 'rejected',
        reviewedBy: parsed.reviewer!,
        reason: parsed.reason,
        surface: 'cli',
      });
      print(stdout, {
        ok: true,
        command: parsed.command,
        approval: {
          approval_id: record.approval_id,
          status: record.status,
          reviewed_at: record.reviewed_at,
          reviewed_by: record.reviewed_by,
          reason: record.reason,
        },
      });
      return 0;
    } catch (error) {
      print(stderr, {
        ok: false,
        command: parsed.command,
        error: (error as Error).message,
      });
      return 1;
    }
  }

  if (parsed.command === 'run-once') {
    let composition: ProductComposition;
    try {
      composition = await createCliComposition(config, classifier, dependencies);
    } catch (error) {
      printRuntimeFailure(stderr, error);
      return 1;
    }
    try {
      const cycle = await composition.runOnce();
      const pending = (await composition.approvals.list())
        .filter((record) => record.status === 'pending')
        .map((record) => record.approval_id);
      print(cycle.ok ? stdout : stderr, {
        ok: cycle.ok,
        command: parsed.command,
        cycle,
        pending_approval_ids: pending,
      });
      return cycle.ok ? 0 : 1;
    } finally {
      composition.close();
    }
  }

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
    print(shutdown.ok ? stdout : stderr, { ok: shutdown.ok, signal, shutdown });
    return shutdown.ok ? 0 : 1;
  }

  let composition: ProductComposition;
  try {
    composition = await createCliComposition(config, classifier, dependencies);
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
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runProductCli(process.argv.slice(2));
}
