import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runProductCli,
  type ProductCliProcess,
} from '../../src/product/cli.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import {
  startProductRuntime,
  withRuntimeDeadline,
  type DeadlineRunner,
  type ProductComponentHandle,
  type ProductComponentName,
  type ProductRuntimeComponent,
  type ProductRuntimeDependencies,
} from '../../src/product/runtime.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import {
  AdapterRegistry,
  type DeliverySurfaceAdapter,
  type DecisionProcessorAdapter,
  type MeetingSourceAdapter,
} from '../../src/core/index.js';

const BASELINE_COMPONENTS = [
  { name: 'product-state', dependsOn: [] },
  { name: 'meeting-ingestion', dependsOn: ['product-state'] },
  { name: 'decision-processing', dependsOn: ['meeting-ingestion'] },
  { name: 'manual-approval', dependsOn: ['decision-processing'] },
  { name: 'delivery', dependsOn: ['manual-approval'] },
  { name: 'product-health', dependsOn: ['delivery'] },
] as const satisfies readonly Pick<
  ProductRuntimeComponent,
  'name' | 'dependsOn'
>[];
const COMPONENTS: readonly ProductComponentName[] = BASELINE_COMPONENTS.map(
  (component) => component.name,
);
const ROLLBACK_COMPONENTS = [
  { name: 'publication', dependsOn: ['brain'] },
  { name: 'brain', dependsOn: ['observation'] },
  { name: 'foundation', dependsOn: [] },
  { name: 'observation', dependsOn: ['foundation'] },
] as const satisfies readonly Pick<
  ProductRuntimeComponent,
  'name' | 'dependsOn'
>[];
const ROLLBACK_ORDER: readonly ProductComponentName[] = [
  'foundation',
  'observation',
  'brain',
  'publication',
];
const directories: string[] = [];

function config() {
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/tmp/echo-product-runtime/state',
    meeting_sources: [
      {
        adapter_id: 'fixture-meetings',
        instance_id: 'primary',
        credential_ref: 'env:MEETING_SOURCE_KEY',
        settings: {},
      },
    ],
    decision_processor: {
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      credential_ref: 'env:DECISION_PROCESSOR_KEY',
      settings: {},
    },
    delivery_surfaces: [
      {
        adapter_id: 'fixture-delivery',
        instance_id: 'team',
        credential_ref: 'env:DELIVERY_SURFACE_KEY',
        settings: {},
      },
    ],
    approval_mode: 'manual',
  });
}

function components(
  starts: string[],
  stops: string[],
  overrides: Partial<
    Record<ProductComponentName, ProductRuntimeComponent['start']>
  > = {},
  definitions: readonly Pick<
    ProductRuntimeComponent,
    'name' | 'dependsOn'
  >[] = BASELINE_COMPONENTS,
): ProductRuntimeComponent[] {
  return definitions.map((component) => ({
    ...component,
    start:
      overrides[component.name] ??
      (async () => {
        starts.push(component.name);
        return { stop: async () => void stops.push(component.name) };
      }),
  }));
}

interface RegisteredFixtures {
  registry: AdapterRegistry;
  meetingSource: MeetingSourceAdapter;
  decisionProcessor: DecisionProcessorAdapter;
  deliverySurface: DeliverySurfaceAdapter;
}

function registeredFixtures(): RegisteredFixtures {
  const registry = new AdapterRegistry();
  const validateConfig = () => ({ ok: true, errors: [] });
  const healthCheck = async () => ({
    status: 'healthy' as const,
    checked_at: '2026-07-16T00:00:00.000Z',
  });
  const meetingSource: MeetingSourceAdapter = {
    identity: {
      kind: 'meeting-source',
      adapter_id: 'fixture-meetings',
      instance_id: 'primary',
      version: '1.0.0',
    },
    validateConfig,
    healthCheck,
    pull: async () => ({ meetings: [] }),
  };
  const decisionProcessor: DecisionProcessorAdapter = {
    identity: {
      kind: 'decision-processor',
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      version: '1.0.0',
    },
    validateConfig,
    healthCheck,
    extract: async (meeting) => ({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: decisionProcessor.identity,
      generated_at: '2026-07-16T00:00:00.000Z',
      signals: [],
    }),
  };
  const deliverySurface: DeliverySurfaceAdapter = {
    identity: {
      kind: 'delivery-surface',
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      version: '1.0.0',
    },
    destination: {
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      external_id: 'synthetic-team',
    },
    validateConfig,
    healthCheck,
    publish: async (envelope) => ({
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: 'synthetic-message',
      recorded_at: '2026-07-16T00:00:00.000Z',
      retryable: false,
    }),
  };
  registry.register(meetingSource);
  registry.register(decisionProcessor);
  registry.register(deliverySurface);
  return { registry, meetingSource, decisionProcessor, deliverySurface };
}

function dependencies(
  runtimeComponents: readonly ProductRuntimeComponent[],
  extra: Partial<ProductRuntimeDependencies> = {},
): ProductRuntimeDependencies {
  const { registry } = registeredFixtures();
  return {
    classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
    adapterRegistry: registry,
    components: runtimeComponents,
    ...extra,
  };
}

function fixtureFactories(
  fixtures: RegisteredFixtures,
): ProductAdapterFactoryRegistry {
  const factories = new ProductAdapterFactoryRegistry();
  factories.register({
    kind: 'meeting-source',
    adapter_id: fixtures.meetingSource.identity.adapter_id,
    create: () => fixtures.meetingSource,
  });
  factories.register({
    kind: 'decision-processor',
    adapter_id: fixtures.decisionProcessor.identity.adapter_id,
    create: () => fixtures.decisionProcessor,
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: fixtures.deliverySurface.identity.adapter_id,
    create: () => fixtures.deliverySurface,
  });
  return factories;
}

function configFile(value: ReturnType<typeof config> = config()): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-product-runtime-cli-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

afterEach(() => {
  while (directories.length > 0)
    rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('isolated product runtime', () => {
  it('keeps the runtime deadline alive for a never-settling operation', async () => {
    await expect(
      withRuntimeDeadline(
        new Promise<never>(() => {}),
        5,
        'never-settling operation',
      ),
    ).rejects.toThrow('never-settling operation timed out after 5ms');
  });

  it('keeps adapter health deadlines alive for never-settling checks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-health-deadline-'));
    directories.push(directory);
    const fixtures = registeredFixtures();
    fixtures.meetingSource.healthCheck = () => new Promise(() => {});

    await expect(
      prepareProductComposition(
        { ...config(), state_dir: join(directory, 'state') },
        fixtures.registry,
        {
          classifyStateFilesystem: async () => ({
            kind: 'local',
            raw: 'apfs',
          }),
          healthTimeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject({
      code: 'adapter_unavailable',
      details: [expect.stringContaining('health check timed out after 5ms')],
    });
  });

  it('starts the baseline composition in dependency order with typed registered adapters', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const fixtures = registeredFixtures();
    const runtimeComponents = components(starts, stops, {
      'product-state': async (context) => {
        starts.push('product-state');
        expect(
          Object.values(context.paths).every((path) =>
            path.startsWith(config().state_dir),
          ),
        ).toBe(true);
        expect(JSON.stringify(context.paths)).not.toMatch(
          /MEETING_SOURCE_KEY|PROCESSOR_KEY|CHANNEL_KEY/,
        );
        return { stop: async () => void stops.push('product-state') };
      },
      'decision-processing': async (context) => {
        starts.push('decision-processing');
        expect(context.adapters.meetingSources).toEqual([
          fixtures.meetingSource,
        ]);
        expect(context.adapters.decisionProcessor).toBe(
          fixtures.decisionProcessor,
        );
        expect(context.adapters.deliverySurfaces).toEqual([
          fixtures.deliverySurface,
        ]);
        return { stop: async () => void stops.push('decision-processing') };
      },
    });
    const result = await startProductRuntime(
      config(),
      dependencies([...runtimeComponents].reverse(), {
        adapterRegistry: fixtures.registry,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(starts).toEqual(COMPONENTS);
    expect(result.handle.paths.database).toBe(
      '/tmp/echo-product-runtime/state/echo-brain.sqlite',
    );
    expect(result.handle.paths.briefs).toBe(
      '/tmp/echo-product-runtime/state/briefs',
    );
    expect(await result.handle.shutdown()).toEqual({
      ok: true,
      errors: [],
      remaining: [],
    });
    expect(stops).toEqual([...COMPONENTS].reverse());
  });

  it('fails before the filesystem probe or any component when the production adapter is absent', async () => {
    const starts: string[] = [];
    let probes = 0;
    const result = await startProductRuntime(config(), {
      classifyStateFilesystem: async () => {
        probes += 1;
        return { kind: 'local', raw: 'apfs' };
      },
      adapterRegistry: new AdapterRegistry(),
      components: components(starts, []),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' },
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.details).toEqual([
      "meeting-source adapter 'fixture-meetings' instance 'primary' is unavailable",
      "decision-processor adapter 'fixture-processor' instance 'primary' is unavailable",
      "delivery-surface adapter 'fixture-delivery' instance 'team' is unavailable",
    ]);
    expect(probes).toBe(0);
    expect(starts).toEqual([]);
  });

  it('aggregates adapter-owned config errors before filesystem or component side effects', async () => {
    const fixtures = registeredFixtures();
    fixtures.meetingSource.validateConfig = () => ({
      ok: false,
      errors: ['workspace setting is required'],
    });
    fixtures.decisionProcessor.validateConfig = () => ({
      ok: false,
      errors: ['model setting is unsupported'],
    });
    fixtures.deliverySurface.validateConfig = () => ({
      ok: false,
      errors: [],
    });
    let probes = 0;
    const starts: string[] = [];
    const result = await startProductRuntime(config(), {
      classifyStateFilesystem: async () => {
        probes += 1;
        return { kind: 'local', raw: 'apfs' };
      },
      adapterRegistry: fixtures.registry,
      components: components(starts, []),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'adapter_invalid_config' },
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.details).toEqual([
      "meeting-source adapter 'fixture-meetings' instance 'primary': workspace setting is required",
      "decision-processor adapter 'fixture-processor' instance 'primary': model setting is unsupported",
      "delivery-surface adapter 'fixture-delivery' instance 'team': configuration is invalid",
    ]);
    expect(JSON.stringify(result.error)).not.toMatch(
      /MEETING_SOURCE_KEY|DECISION_PROCESSOR_KEY|DELIVERY_SURFACE_KEY/,
    );
    expect(probes).toBe(0);
    expect(starts).toEqual([]);
  });

  it.each(ROLLBACK_ORDER.map((_name, index) => index))(
    'rolls back an arbitrary component graph in reverse actual-start order when start %i fails',
    async (failureIndex) => {
      const starts: string[] = [];
      const stops: string[] = [];
      const failing = ROLLBACK_ORDER[failureIndex]!;
      const result = await startProductRuntime(
        config(),
        dependencies(
          components(
            starts,
            stops,
            {
              [failing]: async () => {
                starts.push(failing);
                throw new Error(`${failing} failed`);
              },
            },
            ROLLBACK_COMPONENTS,
          ),
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'startup_failed' },
      });
      expect(starts).toEqual(ROLLBACK_ORDER.slice(0, failureIndex + 1));
      expect(stops).toEqual(
        [...ROLLBACK_ORDER.slice(0, failureIndex)].reverse(),
      );
    },
  );

  it('times out a never-settling start and aggregates rollback errors', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const deadline: DeadlineRunner = async (operation, _timeout, label) => {
      if (label === 'decision-processing start')
        throw new Error('decision-processing start timed out');
      if (label === 'meeting-ingestion rollback')
        throw new Error('meeting rollback failed');
      return await operation;
    };
    const result = await startProductRuntime(
      config(),
      dependencies(
        components(starts, stops, {
          'decision-processing': () => new Promise(() => {}),
        }),
        { withDeadline: deadline },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.details).toContain(
      'decision-processing start timed out',
    );
    expect(result.error.details).toContain('meeting rollback failed');
    expect(stops).toContain('product-state');
  });

  it('cancels startup after the overall deadline and cleans up a late handle once', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    let resolveLate!: (handle: ProductComponentHandle) => void;
    const lateStart = new Promise<ProductComponentHandle>((resolve) => {
      resolveLate = resolve;
    });

    const result = await startProductRuntime(
      config(),
      dependencies(
        components(starts, stops, {
          'meeting-ingestion': () => {
            starts.push('meeting-ingestion');
            return lateStart;
          },
        }),
        {
          deadlines: {
            componentStartMs: 1_000,
            overallStartMs: 5,
            shutdownMs: 1_000,
          },
        },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'startup_failed',
        details: ['product runtime startup timed out after 5ms'],
      },
    });
    expect(starts).toEqual(['product-state', 'meeting-ingestion']);
    expect(stops).toEqual(['product-state']);

    resolveLate({
      stop: () => void stops.push('meeting-ingestion'),
    });
    for (let attempt = 0; attempt < 20 && stops.length < 2; attempt += 1) {
      await new Promise(setImmediate);
    }

    expect(starts).toEqual(['product-state', 'meeting-ingestion']);
    expect(stops).toEqual(['product-state', 'meeting-ingestion']);
  });

  it('makes shutdown idempotent, bounded, and explicit about remaining handles', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const deadline: DeadlineRunner = async (operation, _timeout, label) => {
      if (label === 'meeting-ingestion shutdown')
        throw new Error('meeting shutdown timed out');
      return await operation;
    };
    const result = await startProductRuntime(
      config(),
      dependencies(components(starts, stops), { withDeadline: deadline }),
    );
    if (!result.ok) throw result.error;
    const first = result.handle.shutdown();
    const second = result.handle.shutdown();
    expect(second).toBe(first);
    expect(await first).toEqual({
      ok: false,
      errors: ['meeting shutdown timed out'],
      remaining: ['meeting-ingestion'],
    });
    expect(stops.filter((name) => name === 'product-state')).toHaveLength(1);
  });

  it('accepts arbitrary component names and uses a stable topological order', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const runtimeComponents = components(starts, stops, {}, [
      { name: 'publication', dependsOn: ['brain'] },
      { name: 'telemetry', dependsOn: ['foundation'] },
      { name: 'brain', dependsOn: ['foundation'] },
      { name: 'foundation', dependsOn: [] },
    ]);

    const result = await startProductRuntime(
      config(),
      dependencies(runtimeComponents),
    );
    if (!result.ok) throw result.error;
    expect(starts).toEqual(['foundation', 'telemetry', 'brain', 'publication']);
    expect(await result.handle.shutdown()).toEqual({
      ok: true,
      errors: [],
      remaining: [],
    });
    expect(stops).toEqual(['publication', 'brain', 'telemetry', 'foundation']);
  });

  it('rejects invalid names, duplicates, missing dependencies, and cycles before side effects', async () => {
    const starts: string[] = [];
    let filesystemProbes = 0;
    const fixture = (
      name: ProductComponentName,
      dependsOn: readonly ProductComponentName[] = [],
    ): ProductRuntimeComponent => ({
      name,
      dependsOn,
      start: async () => {
        starts.push(name);
        return { stop() {} };
      },
    });
    const variants: Array<{
      components: ProductRuntimeComponent[];
      detail: string;
    }> = [
      {
        components: [fixture('Brain Node')],
        detail: "component at index 0 has invalid name 'Brain Node'",
      },
      {
        components: [fixture('foundation'), fixture('foundation')],
        detail: "component name 'foundation' must be unique",
      },
      {
        components: [fixture('brain', ['missing-foundation'])],
        detail:
          "component 'brain' depends on missing component 'missing-foundation'",
      },
      {
        components: [
          fixture('foundation'),
          fixture('brain', ['foundation', 'foundation']),
        ],
        detail: "component 'brain' declares duplicate dependency 'foundation'",
      },
      {
        components: [
          fixture('brain', ['publication']),
          fixture('publication', ['brain']),
        ],
        detail:
          'component dependency cycle detected: brain -> publication -> brain',
      },
    ];
    for (const variant of variants) {
      const result = await startProductRuntime(
        config(),
        dependencies(variant.components, {
          classifyStateFilesystem: async () => {
            filesystemProbes += 1;
            return { kind: 'local', raw: 'apfs' };
          },
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_dependencies',
          details: expect.arrayContaining([variant.detail]),
        },
      });
    }
    expect(starts).toEqual([]);
    expect(filesystemProbes).toBe(0);
  });

  it('fails closed for network and unknown state filesystems before component startup', async () => {
    for (const classification of [
      { kind: 'network', raw: 'nfs' },
      { kind: 'unknown', raw: 'ext4' },
    ] as const) {
      const starts: string[] = [];
      const result = await startProductRuntime(
        config(),
        dependencies(components(starts, []), {
          classifyStateFilesystem: async () => classification,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'state_not_local' },
      });
      expect(starts).toEqual([]);
    }
  });

  it('captures SIGTERM during injected runtime startup and shuts down cleanly', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const emitter = new EventEmitter();
    const processLike = emitter as ProductCliProcess;
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const execution = runProductCli(['run', '--config', configFile()], {
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      runtime: dependencies(
        components(starts, stops, {
          'product-state': async () => {
            starts.push('product-state');
            await startGate;
            return {
              stop: async () => void stops.push('product-state'),
            };
          },
        }),
      ),
      process: processLike,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    while (starts.length === 0) await new Promise(setImmediate);
    expect(emitter.listenerCount('SIGTERM')).toBe(1);
    emitter.emit('SIGTERM');
    releaseStart();
    expect(await execution).toBe(0);
    expect(starts).toEqual(COMPONENTS);
    expect(stops).toEqual([...COMPONENTS].reverse());
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not run a cycle when SIGINT arrives during composition health setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-product-signal-'));
    directories.push(root);
    const configured = validateProductRuntimeConfig({
      ...config(),
      state_dir: join(root, 'state'),
    });
    const fixtures = registeredFixtures();
    let healthStarted = false;
    let releaseHealth: () => void = () => undefined;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    fixtures.meetingSource.healthCheck = async () => {
      healthStarted = true;
      await healthGate;
      return {
        status: 'healthy',
        checked_at: '2026-07-16T00:00:00.000Z',
      };
    };
    let pulls = 0;
    fixtures.meetingSource.pull = async () => {
      pulls += 1;
      return { meetings: [] };
    };
    const emitter = new EventEmitter();
    let stdout = '';
    const execution = runProductCli(
      ['run', '--config', configFile(configured)],
      {
        classifyStateFilesystem: async () => ({
          kind: 'local',
          raw: 'apfs',
        }),
        adapterFactories: fixtureFactories(fixtures),
        process: emitter as ProductCliProcess,
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: () => true },
      },
    );
    while (!healthStarted) await new Promise(setImmediate);
    expect(emitter.listenerCount('SIGINT')).toBe(1);
    emitter.emit('SIGINT');
    releaseHealth();

    expect(await execution).toBe(0);
    expect(pulls).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      signal: 'SIGINT',
      shutdown: { ok: true },
    });
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes signal handlers when composition setup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-product-signal-error-'));
    directories.push(root);
    const configured = validateProductRuntimeConfig({
      ...config(),
      state_dir: join(root, 'state'),
    });
    const fixtures = registeredFixtures();
    fixtures.meetingSource.healthCheck = async () => {
      throw new Error('health setup failed');
    };
    const emitter = new EventEmitter();

    expect(
      await runProductCli(['run', '--config', configFile(configured)], {
        classifyStateFilesystem: async () => ({
          kind: 'local',
          raw: 'apfs',
        }),
        adapterFactories: fixtureFactories(fixtures),
        process: emitter as ProductCliProcess,
        stdout: { write: () => true },
        stderr: { write: () => true },
      }),
    ).toBe(1);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes signal handlers when injected runtime startup fails', async () => {
    const emitter = new EventEmitter();
    const execution = runProductCli(['run', '--config', configFile()], {
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      runtime: dependencies(
        components([], [], {
          'product-state': async () => {
            throw new Error('startup failed');
          },
        }),
      ),
      process: emitter as ProductCliProcess,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    expect(await execution).toBe(1);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });
});
