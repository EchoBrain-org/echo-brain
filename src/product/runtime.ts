import type {
  Adapter,
  AdapterInstanceConfig,
  AdapterRegistry,
  ApprovalSurfaceAdapter,
  DeliverySurfaceAdapter,
  DecisionProcessorAdapter,
  MeetingSourceAdapter,
} from '../core/index.js';
import type {
  ClassifyStateFilesystem,
  ProductRuntimeConfig,
  StateFilesystemClassification,
} from './config.js';
import { resolveProductStatePaths, type ProductStatePaths } from './paths.js';
import {
  assertFounderIdentityAllowsPipeline,
  FounderIdentityGateError,
  type IdentityCheckDependencies,
} from './federation/bootstrap/identity-check.js';
import {
  assertFounderProvenanceRetired,
  FounderProvenanceGateError,
} from './federation/cutover-fence.js';

export type ProductComponentName = string;

export interface ProductComponentHandle {
  stop: () => void | Promise<void>;
}

export interface ProductRuntimeAdapters {
  meetingSources: readonly MeetingSourceAdapter[];
  decisionProcessor: DecisionProcessorAdapter;
  deliverySurfaces: readonly DeliverySurfaceAdapter[];
  approvalSurface?: ApprovalSurfaceAdapter;
}

export interface ProductRuntimeContext {
  config: ProductRuntimeConfig;
  paths: ProductStatePaths;
  adapters: ProductRuntimeAdapters;
}

export interface ProductRuntimeComponent {
  name: ProductComponentName;
  /** Components that must finish starting before this component may start. */
  dependsOn: readonly ProductComponentName[];
  start: (
    context: ProductRuntimeContext,
  ) => ProductComponentHandle | Promise<ProductComponentHandle>;
}

export interface ProductRuntimeDeadlines {
  componentStartMs: number;
  overallStartMs: number;
  shutdownMs: number;
}

export type DeadlineRunner = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
) => Promise<T>;

export interface ProductRuntimeDependencies {
  classifyStateFilesystem: ClassifyStateFilesystem;
  adapterRegistry: AdapterRegistry;
  components: readonly ProductRuntimeComponent[];
  deadlines?: Partial<ProductRuntimeDeadlines>;
  withDeadline?: DeadlineRunner;
  identityCheck?: IdentityCheckDependencies;
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
      | 'adapter_invalid_config'
      | 'state_not_local'
      | 'identity_not_operationally_ready'
      | 'organization_access_denied'
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
    const timer = setTimeout(
      () => reject(new DeadlineError(label, timeoutMs)),
      timeoutMs,
    );
    // This may be the only active handle when an operation never settles.
    // Keeping it referenced is what makes the runtime deadline enforceable.
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

const MAX_COMPONENT_NAME_LENGTH = 64;
const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface ResolvedRuntimeComponents {
  ordered: readonly ProductRuntimeComponent[];
  errors: readonly string[];
}

function validComponentName(value: unknown): value is ProductComponentName {
  return (
    typeof value === 'string' &&
    value.length <= MAX_COMPONENT_NAME_LENGTH &&
    COMPONENT_NAME_PATTERN.test(value)
  );
}

function findDependencyCycle(
  components: readonly ProductRuntimeComponent[],
): readonly ProductComponentName[] | null {
  const byName = new Map(
    components.map((component) => [component.name, component] as const),
  );
  const states = new Map<ProductComponentName, 'visiting' | 'visited'>();
  const path: ProductComponentName[] = [];

  const visit = (
    name: ProductComponentName,
  ): readonly ProductComponentName[] | null => {
    states.set(name, 'visiting');
    path.push(name);
    for (const dependency of byName.get(name)!.dependsOn) {
      const state = states.get(dependency);
      if (state === 'visiting') {
        const cycleStart = path.lastIndexOf(dependency);
        return [...path.slice(cycleStart), dependency];
      }
      if (state === undefined) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
    }
    path.pop();
    states.set(name, 'visited');
    return null;
  };

  for (const component of components) {
    if (states.has(component.name)) continue;
    const cycle = visit(component.name);
    if (cycle !== null) return cycle;
  }
  return null;
}

function resolveComponentStartOrder(
  components: readonly ProductRuntimeComponent[],
): ResolvedRuntimeComponents {
  const errors: string[] = [];
  const nameCounts = new Map<ProductComponentName, number>();

  for (const [index, component] of components.entries()) {
    if (!validComponentName(component.name)) {
      errors.push(
        `component at index ${index} has invalid name '${component.name}'`,
      );
    } else {
      nameCounts.set(component.name, (nameCounts.get(component.name) ?? 0) + 1);
    }
    if (!Array.isArray(component.dependsOn)) {
      errors.push(
        `component '${component.name}' dependencies must be an array`,
      );
      continue;
    }
    const seenDependencies = new Set<ProductComponentName>();
    for (const dependency of component.dependsOn) {
      if (!validComponentName(dependency)) {
        errors.push(
          `component '${component.name}' has invalid dependency name '${dependency}'`,
        );
        continue;
      }
      if (seenDependencies.has(dependency)) {
        errors.push(
          `component '${component.name}' declares duplicate dependency '${dependency}'`,
        );
      }
      seenDependencies.add(dependency);
    }
  }

  for (const [name, count] of nameCounts) {
    if (count > 1) errors.push(`component name '${name}' must be unique`);
  }

  for (const component of components) {
    if (!Array.isArray(component.dependsOn)) continue;
    for (const dependency of new Set(component.dependsOn)) {
      if (validComponentName(dependency) && !nameCounts.has(dependency)) {
        errors.push(
          `component '${component.name}' depends on missing component '${dependency}'`,
        );
      }
    }
  }

  if (errors.length > 0) return { ordered: [], errors };

  const cycle = findDependencyCycle(components);
  if (cycle !== null) {
    return {
      ordered: [],
      errors: [`component dependency cycle detected: ${cycle.join(' -> ')}`],
    };
  }

  const remaining = new Set(components.map((component) => component.name));
  const ordered: ProductRuntimeComponent[] = [];
  while (remaining.size > 0) {
    const next = components.find(
      (component) =>
        remaining.has(component.name) &&
        component.dependsOn.every((dependency) => !remaining.has(dependency)),
    );
    if (next === undefined) {
      throw new Error('validated component graph could not be ordered');
    }
    ordered.push(next);
    remaining.delete(next.name);
  }
  return { ordered, errors: [] };
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

function unavailableAdapterDetail(
  kind: string,
  config: AdapterInstanceConfig,
): string {
  return `${kind} adapter '${config.adapter_id}' instance '${config.instance_id}' is unavailable`;
}

function invalidAdapterPrefix(
  kind: string,
  config: AdapterInstanceConfig,
): string {
  return `${kind} adapter '${config.adapter_id}' instance '${config.instance_id}'`;
}

function validateConfiguredAdapter(
  kind: string,
  config: AdapterInstanceConfig,
  adapter: Adapter,
): string[] {
  const prefix = invalidAdapterPrefix(kind, config);
  try {
    const result = adapter.validateConfig(config);
    if (result.ok) return [];
    if (result.errors.length === 0)
      return [`${prefix}: configuration is invalid`];
    return result.errors.map((error) => `${prefix}: ${error}`);
  } catch {
    return [`${prefix}: configuration validation failed unexpectedly`];
  }
}

export function resolveConfiguredAdapters(
  config: ProductRuntimeConfig,
  registry: AdapterRegistry,
): ProductRuntimeAdapters | ProductRuntimeFailure {
  const missing: string[] = [];
  const meetingSources = config.meeting_sources.map((adapterConfig) => {
    const adapter = registry.getMeetingSource(adapterConfig);
    if (adapter === undefined)
      missing.push(unavailableAdapterDetail('meeting-source', adapterConfig));
    return adapter;
  });
  const decisionProcessor = registry.getDecisionProcessor(
    config.decision_processor,
  );
  if (decisionProcessor === undefined) {
    missing.push(
      unavailableAdapterDetail('decision-processor', config.decision_processor),
    );
  }
  const deliverySurfaces = config.delivery_surfaces.map((adapterConfig) => {
    const adapter = registry.getDeliverySurface(adapterConfig);
    if (adapter === undefined) {
      missing.push(unavailableAdapterDetail('delivery-surface', adapterConfig));
    }
    return adapter;
  });
  let approvalSurface: ApprovalSurfaceAdapter | undefined;
  if (config.approval_mode === 'adapter') {
    approvalSurface = registry.getApprovalSurface(config.approval_surface);
    if (approvalSurface === undefined) {
      missing.push(
        unavailableAdapterDetail('approval-surface', config.approval_surface),
      );
    }
  }
  if (missing.length > 0) {
    return new ProductRuntimeFailure(
      'adapter_unavailable',
      `configured adapters are unavailable: ${missing.join('; ')}`,
      missing,
    );
  }
  const invalid = [
    ...config.meeting_sources.flatMap((adapterConfig, index) =>
      validateConfiguredAdapter(
        'meeting-source',
        adapterConfig,
        meetingSources[index] as MeetingSourceAdapter,
      ),
    ),
    ...validateConfiguredAdapter(
      'decision-processor',
      config.decision_processor,
      decisionProcessor as DecisionProcessorAdapter,
    ),
    ...config.delivery_surfaces.flatMap((adapterConfig, index) =>
      validateConfiguredAdapter(
        'delivery-surface',
        adapterConfig,
        deliverySurfaces[index] as DeliverySurfaceAdapter,
      ),
    ),
    ...(config.approval_mode === 'adapter'
      ? validateConfiguredAdapter(
          'approval-surface',
          config.approval_surface,
          approvalSurface as ApprovalSurfaceAdapter,
        )
      : []),
  ];
  if (invalid.length > 0) {
    return new ProductRuntimeFailure(
      'adapter_invalid_config',
      `configured adapters rejected their configuration: ${invalid.join('; ')}`,
      invalid,
    );
  }
  return {
    meetingSources: meetingSources as MeetingSourceAdapter[],
    decisionProcessor: decisionProcessor as DecisionProcessorAdapter,
    deliverySurfaces: deliverySurfaces as DeliverySurfaceAdapter[],
    ...(approvalSurface === undefined ? {} : { approvalSurface }),
  };
}

export async function startProductRuntime(
  config: ProductRuntimeConfig,
  dependencies: ProductRuntimeDependencies,
): Promise<ProductRuntimeStartResult> {
  // First statement: before the caller-supplied component graph is resolved or
  // started, before adapters are resolved, and before any injected identity
  // check runs.
  try {
    assertFounderProvenanceRetired(config.state_dir);
  } catch (error) {
    if (error instanceof FounderProvenanceGateError) {
      return {
        ok: false,
        error: new ProductRuntimeFailure(
          'identity_not_operationally_ready',
          error.message,
          [...error.findings],
        ),
      };
    }
    throw error;
  }
  const components = resolveComponentStartOrder(dependencies.components);
  if (components.errors.length > 0) {
    return {
      ok: false,
      error: new ProductRuntimeFailure(
        'invalid_dependencies',
        'product runtime component graph is invalid',
        components.errors,
      ),
    };
  }
  const adapters = resolveConfiguredAdapters(
    config,
    dependencies.adapterRegistry,
  );
  if (adapters instanceof ProductRuntimeFailure)
    return { ok: false, error: adapters };
  const classification = await dependencies.classifyStateFilesystem(
    config.state_dir,
  );
  if (classification.kind !== 'local') {
    return { ok: false, error: stateClassificationFailure(classification) };
  }

  try {
    await assertFounderIdentityAllowsPipeline(config.state_dir, {
      ...dependencies.identityCheck,
      runtimeConfig: config,
    });
  } catch (error) {
    if (error instanceof FounderIdentityGateError) {
      return {
        ok: false,
        error: new ProductRuntimeFailure(
          'identity_not_operationally_ready',
          error.message,
          error.report.checks
            .filter((item) => item.required_for_operation && !item.ok)
            .map((item) => `${item.id}: ${item.detail}`),
        ),
      };
    }
    return {
      ok: false,
      error: new ProductRuntimeFailure(
        'identity_not_operationally_ready',
        `identity check failed: ${(error as Error).message}`,
        [(error as Error).message],
      ),
    };
  }

  const paths = resolveProductStatePaths(config.state_dir);
  const context: ProductRuntimeContext = { config, paths, adapters };
  const deadlines = { ...DEFAULT_DEADLINES, ...dependencies.deadlines };
  const withDeadline = dependencies.withDeadline ?? withRuntimeDeadline;
  const started: Array<{
    component: ProductRuntimeComponent;
    handle: ProductComponentHandle;
  }> = [];
  const stopPromises = new WeakMap<ProductComponentHandle, Promise<void>>();
  let startupAbandoned = false;

  const stopOnce = (
    component: ProductRuntimeComponent,
    handle: ProductComponentHandle,
    phase: 'rollback' | 'late-start cleanup',
  ): Promise<void> => {
    const existing = stopPromises.get(handle);
    if (existing !== undefined) return existing;
    const stopping = Promise.resolve().then(() =>
      withDeadline(
        Promise.resolve().then(() => handle.stop()),
        deadlines.shutdownMs,
        `${component.name} ${phase}`,
      ),
    );
    stopPromises.set(handle, stopping);
    return stopping;
  };

  const startAll = async (): Promise<void> => {
    for (const component of components.ordered) {
      if (startupAbandoned) return;
      const startOperation = Promise.resolve().then(() =>
        component.start(context),
      );
      const observedStart = startOperation.then(async (handle) => {
        if (
          handle === null ||
          typeof handle !== 'object' ||
          typeof handle.stop !== 'function'
        ) {
          throw new Error(
            `${component.name} returned an invalid shutdown handle`,
          );
        }
        if (startupAbandoned) {
          await stopOnce(component, handle, 'late-start cleanup');
          throw new Error(
            `${component.name} resolved after startup was abandoned`,
          );
        }
        return handle;
      });
      const handle = await withDeadline(
        observedStart,
        deadlines.componentStartMs,
        `${component.name} start`,
      );
      // The overall deadline can expire after observedStart resolves but
      // before this continuation runs. Dispose that handle instead of
      // publishing it as started or advancing to the next component.
      if (startupAbandoned) {
        await stopOnce(component, handle, 'late-start cleanup');
        return;
      }
      started.push({ component, handle });
    }
  };

  try {
    await withDeadline(
      startAll(),
      deadlines.overallStartMs,
      'product runtime startup',
    );
  } catch (error) {
    startupAbandoned = true;
    const details = [(error as Error).message];
    for (const startedComponent of [...started].reverse()) {
      try {
        await stopOnce(
          startedComponent.component,
          startedComponent.handle,
          'rollback',
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
