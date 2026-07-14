import type { GranolaSignalAdapter } from '../enrich/granola-signals.js';
import type {
  ClassifyStateFilesystem,
  ProductRuntimeConfig,
  StateFilesystemClassification,
} from './config.js';
import { resolveProductStatePaths, type ProductStatePaths } from './paths.js';

export type ProductComponentName =
  | 'product-state'
  | 'granola-meeting-input'
  | 'signal-extraction'
  | 'manual-brief-approval'
  | 'product-health';

export interface ProductComponentHandle {
  stop: () => void | Promise<void>;
}

export interface ProductRuntimeContext {
  config: ProductRuntimeConfig;
  paths: ProductStatePaths;
  adapter: GranolaSignalAdapter;
}

export interface ProductRuntimeComponent {
  name: ProductComponentName;
  start: (context: ProductRuntimeContext) => ProductComponentHandle | Promise<ProductComponentHandle>;
}

export interface ProductRuntimeDeadlines {
  componentStartMs: number;
  overallStartMs: number;
  shutdownMs: number;
}

export type DeadlineRunner = <T>(operation: Promise<T>, timeoutMs: number, label: string) => Promise<T>;

export interface ProductRuntimeDependencies {
  classifyStateFilesystem: ClassifyStateFilesystem;
  brainAdapters: Readonly<Record<string, GranolaSignalAdapter>>;
  components: readonly ProductRuntimeComponent[];
  deadlines?: Partial<ProductRuntimeDeadlines>;
  withDeadline?: DeadlineRunner;
}

export interface ProductRuntimeShutdownResult {
  ok: boolean;
  errors: readonly string[];
  remaining: readonly ProductComponentName[];
}

export interface ProductRuntimeHandle {
  paths: ProductStatePaths;
  shutdown: () => Promise<ProductRuntimeShutdownResult>;
}

export type ProductRuntimeStartResult =
  | { ok: true; handle: ProductRuntimeHandle }
  | { ok: false; error: ProductRuntimeFailure };

export class ProductRuntimeFailure extends Error {
  constructor(
    public readonly code:
      | 'invalid_dependencies'
      | 'adapter_unavailable'
      | 'state_not_local'
      | 'startup_failed',
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ProductRuntimeFailure';
  }
}

class DeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'DeadlineError';
  }
}

const EXPECTED_COMPONENTS: readonly ProductComponentName[] = [
  'product-state',
  'granola-meeting-input',
  'signal-extraction',
  'manual-brief-approval',
  'product-health',
];

const DEFAULT_DEADLINES: ProductRuntimeDeadlines = {
  componentStartMs: 10_000,
  overallStartMs: 45_000,
  shutdownMs: 10_000,
};

export function withRuntimeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, timeoutMs)), timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateComponents(components: readonly ProductRuntimeComponent[]): string[] {
  const names = components.map((component) => component.name);
  const errors: string[] = [];
  for (const expected of EXPECTED_COMPONENTS) {
    const count = names.filter((name) => name === expected).length;
    if (count !== 1) errors.push(`component '${expected}' must appear exactly once`);
  }
  for (const name of names) {
    if (!EXPECTED_COMPONENTS.includes(name)) errors.push(`forbidden component '${name}'`);
  }
  if (names.join('\n') !== EXPECTED_COMPONENTS.join('\n')) {
    errors.push(`components must start in declared order: ${EXPECTED_COMPONENTS.join(', ')}`);
  }
  return errors;
}

function stateClassificationFailure(
  classification: StateFilesystemClassification,
): ProductRuntimeFailure {
  return new ProductRuntimeFailure(
    'state_not_local',
    `product state filesystem is ${classification.kind}: ${classification.raw}`,
    [`kind=${classification.kind}`, `raw=${classification.raw}`],
  );
}

export async function startProductRuntime(
  config: ProductRuntimeConfig,
  dependencies: ProductRuntimeDependencies,
): Promise<ProductRuntimeStartResult> {
  const componentErrors = validateComponents(dependencies.components);
  if (componentErrors.length > 0) {
    return {
      ok: false,
      error: new ProductRuntimeFailure(
        'invalid_dependencies',
        'product runtime dependencies are incomplete or out of scope',
        componentErrors,
      ),
    };
  }
  const adapter = dependencies.brainAdapters[config.brain_adapter.id];
  if (adapter === undefined) {
    return {
      ok: false,
      error: new ProductRuntimeFailure(
        'adapter_unavailable',
        `production brain adapter '${config.brain_adapter.id}' is unavailable`,
      ),
    };
  }
  const classification = await dependencies.classifyStateFilesystem(config.state_dir);
  if (classification.kind !== 'local') {
    return { ok: false, error: stateClassificationFailure(classification) };
  }

  const paths = resolveProductStatePaths(config.state_dir);
  const context: ProductRuntimeContext = { config, paths, adapter };
  const deadlines = { ...DEFAULT_DEADLINES, ...dependencies.deadlines };
  const withDeadline = dependencies.withDeadline ?? withRuntimeDeadline;
  const started: Array<{ component: ProductRuntimeComponent; handle: ProductComponentHandle }> = [];

  const startAll = async (): Promise<void> => {
    for (const component of dependencies.components) {
      const handle = await withDeadline(
        Promise.resolve().then(() => component.start(context)),
        deadlines.componentStartMs,
        `${component.name} start`,
      );
      if (handle === null || typeof handle !== 'object' || typeof handle.stop !== 'function') {
        throw new Error(`${component.name} returned an invalid shutdown handle`);
      }
      started.push({ component, handle });
    }
  };

  try {
    await withDeadline(startAll(), deadlines.overallStartMs, 'product runtime startup');
  } catch (error) {
    const details = [(error as Error).message];
    for (const startedComponent of [...started].reverse()) {
      try {
        await withDeadline(
          Promise.resolve().then(() => startedComponent.handle.stop()),
          deadlines.shutdownMs,
          `${startedComponent.component.name} rollback`,
        );
      } catch (rollbackError) {
        details.push((rollbackError as Error).message);
      }
    }
    return {
      ok: false,
      error: new ProductRuntimeFailure(
        'startup_failed',
        `product runtime startup failed: ${details.join('; ')}`,
        details,
      ),
    };
  }

  let shutdownPromise: Promise<ProductRuntimeShutdownResult> | null = null;
  const shutdown = (): Promise<ProductRuntimeShutdownResult> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = (async () => {
      const errors: string[] = [];
      const remaining: ProductComponentName[] = [];
      for (const startedComponent of [...started].reverse()) {
        try {
          await withDeadline(
            Promise.resolve().then(() => startedComponent.handle.stop()),
            deadlines.shutdownMs,
            `${startedComponent.component.name} shutdown`,
          );
        } catch (error) {
          errors.push((error as Error).message);
          remaining.push(startedComponent.component.name);
        }
      }
      return { ok: errors.length === 0, errors, remaining };
    })();
    return shutdownPromise;
  };
  return { ok: true, handle: { paths, shutdown } };
}
