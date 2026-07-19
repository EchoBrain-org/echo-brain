import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import type {
  AdapterHealth,
  AdapterIdentity,
  ApprovalGate,
  CoreCycleResult,
  CoreCycleDeadlines,
  CoreStateStore,
} from '../core/index.js';
import { runCoreCycle } from '../core/index.js';
import { SqliteCoreStateStore } from '../storage/core-state-sqlite.js';
import type {
  ClassifyStateFilesystem,
  ProductRuntimeConfig,
} from './config.js';
import { DecisionNodeStore } from './approval/decision-node-store.js';
import { StoreBackedApprovalGate } from './approval/store-backed-approval-gate.js';
import { resolveProductStatePaths, type ProductStatePaths } from './paths.js';
import {
  ProductRuntimeFailure,
  resolveConfiguredAdapters,
  type ProductRuntimeAdapters,
} from './runtime.js';
import type { AdapterRegistry } from '../core/index.js';

export interface ProductSourceCycleResult {
  source: AdapterIdentity & { kind: 'meeting-source' };
  result?: CoreCycleResult;
  error?: string;
}

export interface ProductCycleResult {
  ok: boolean;
  sources: readonly ProductSourceCycleResult[];
  meetings_seen: number;
  meetings_processed: number;
  meetings_pending: number;
  meetings_rejected: number;
  meetings_dead_lettered: number;
  deliveries: number;
}

export interface ProductComposition {
  paths: ProductStatePaths;
  adapters: ProductRuntimeAdapters;
  approvals: DecisionNodeStore;
  runOnce(options?: ProductCycleRunOptions): Promise<ProductCycleResult>;
  close(): void;
}

export interface ProductCycleRunOptions {
  signal?: AbortSignal;
}

export interface PrepareProductCompositionOptions {
  classifyStateFilesystem: ClassifyStateFilesystem;
  state?: CoreStateStore & { close?: () => void };
  approvalGate?: ApprovalGate;
  approvals?: DecisionNodeStore;
  now?: () => string;
  createId?: () => string;
  healthTimeoutMs?: number;
  operationDeadlines?: Partial<CoreCycleDeadlines>;
}

export function resolveProductClock(now?: () => string): () => string {
  return now ?? (() => new Date().toISOString());
}

function allAdapters(adapters: ProductRuntimeAdapters) {
  return [
    ...adapters.meetingSources,
    adapters.decisionProcessor,
    ...adapters.deliverySurfaces,
    ...(adapters.approvalSurface === undefined ? [] : [adapters.approvalSurface]),
  ];
}

async function healthWithTimeout(
  identity: AdapterIdentity,
  operation: (signal: AbortSignal) => Promise<AdapterHealth>,
  timeoutMs: number,
): Promise<AdapterHealth> {
  const controller = new AbortController();
  const timeout = new Error(
    `${identity.kind} adapter '${identity.adapter_id}' instance '${identity.instance_id}' health check timed out after ${timeoutMs}ms`,
  );
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertAdapterHealth(
  adapters: ProductRuntimeAdapters,
  timeoutMs: number,
): Promise<void> {
  const failures: string[] = [];
  await Promise.all(
    allAdapters(adapters).map(async (adapter) => {
      try {
        const health = await healthWithTimeout(
          adapter.identity,
          async (signal) => await adapter.healthCheck({ signal }),
          timeoutMs,
        );
        if (
          health.status === 'unavailable' ||
          health.status === 'unauthorized'
        ) {
          failures.push(
            `${adapter.identity.kind} adapter '${adapter.identity.adapter_id}' instance '${adapter.identity.instance_id}' is ${health.status}${health.message === undefined ? '' : `: ${health.message}`}`,
          );
        }
      } catch (error) {
        failures.push(
          `${adapter.identity.kind} adapter '${adapter.identity.adapter_id}' instance '${adapter.identity.instance_id}' health check failed: ${(error as Error).message}`,
        );
      }
    }),
  );
  if (failures.length > 0) {
    failures.sort();
    throw new ProductRuntimeFailure(
      'adapter_unavailable',
      `configured adapters failed health checks: ${failures.join('; ')}`,
      failures,
    );
  }
}

export function prepareProductStateRoot(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const state = lstatSync(path);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new Error('state_dir must resolve directly to a directory');
    }
    chmodSync(path, 0o700);
  } catch (error) {
    throw new ProductRuntimeFailure(
      'startup_failed',
      `cannot prepare private product state: ${(error as Error).message}`,
      [(error as Error).message],
    );
  }
}

function summarize(sources: readonly ProductSourceCycleResult[]): ProductCycleResult {
  const results = sources.flatMap((source) =>
    source.result === undefined ? [] : [source.result],
  );
  const sum = (field: keyof CoreCycleResult): number =>
    results.reduce((total, result) => {
      const value = result[field];
      return total + (typeof value === 'number' ? value : 0);
    }, 0);
  return {
    ok:
      sources.every(
        (source) => source.error === undefined && source.result?.ok === true,
      ),
    sources,
    meetings_seen: sum('meetings_seen'),
    meetings_processed: sum('meetings_processed'),
    meetings_pending: sum('meetings_pending'),
    meetings_rejected: sum('meetings_rejected'),
    meetings_dead_lettered: sum('meetings_dead_lettered'),
    deliveries: sum('deliveries'),
  };
}

export async function prepareProductComposition(
  config: ProductRuntimeConfig,
  registry: AdapterRegistry,
  options: PrepareProductCompositionOptions,
): Promise<ProductComposition> {
  const adapters = resolveConfiguredAdapters(config, registry);
  if (adapters instanceof ProductRuntimeFailure) throw adapters;

  const classification = await options.classifyStateFilesystem(config.state_dir);
  if (classification.kind !== 'local') {
    throw new ProductRuntimeFailure(
      'state_not_local',
      `product state filesystem is ${classification.kind}: ${classification.raw}`,
      [`kind=${classification.kind}`, `raw=${classification.raw}`],
    );
  }

  const paths = resolveProductStatePaths(config.state_dir);
  prepareProductStateRoot(paths.root);
  await assertAdapterHealth(adapters, options.healthTimeoutMs ?? 10_000);
  const state = options.state ?? new SqliteCoreStateStore(paths.database);
  const approvals =
    options.approvals ??
    new DecisionNodeStore(paths.root, {
      now: options.now,
      createId: options.createId,
    });
  await approvals.initialize();
  const approvalGate =
    options.approvalGate ??
    (config.approval_mode === 'adapter'
      ? (adapters.approvalSurface as ApprovalGate)
      : new StoreBackedApprovalGate(approvals));
  const now = resolveProductClock(options.now);
  const createId = options.createId ?? randomUUID;
  let closed = false;
  let active: Promise<ProductCycleResult> | null = null;

  const run = async (
    runOptions: ProductCycleRunOptions = {},
  ): Promise<ProductCycleResult> => {
    if (closed) throw new Error('product composition is closed');
    const sources: ProductSourceCycleResult[] = [];
    for (const source of adapters.meetingSources) {
      try {
        const result = await runCoreCycle({
          meetingSource: source,
          decisionProcessor: adapters.decisionProcessor,
          deliverySurfaces: adapters.deliverySurfaces,
          approvalGate,
          state,
          now,
          createId,
          signal: runOptions.signal,
          deadlines: {
            // Config-level knob for slow (e.g. model-backed) processors;
            // explicit composition options still win.
            ...(config.extraction_timeout_ms === undefined
              ? {}
              : { extractMs: config.extraction_timeout_ms }),
            ...options.operationDeadlines,
          },
        });
        sources.push({ source: source.identity, result });
      } catch (error) {
        sources.push({
          source: source.identity,
          error: (error as Error).message,
        });
      }
    }
    return summarize(sources);
  };

  return {
    paths,
    adapters,
    approvals,
    runOnce(runOptions = {}) {
      if (active !== null) return active;
      active = run(runOptions).finally(() => {
        active = null;
      });
      return active;
    },
    close() {
      if (closed) return;
      if (active !== null) {
        throw new Error('cannot close product composition during an active cycle');
      }
      closed = true;
      state.close?.();
    },
  };
}
