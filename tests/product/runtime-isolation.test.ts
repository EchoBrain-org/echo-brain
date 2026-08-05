import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runProductCli,
  type ProductCliDependencies,
  type ProductCliProcess,
} from '../../src/product/cli.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import type { LaunchctlRunner } from '../../src/product/launchd-service.js';
import {
  ProductRuntimeFailure,
  resolveConfiguredAdapters,
} from '../../src/product/runtime.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import {
  AdapterRegistry,
  type DeliverySurfaceAdapter,
  type DecisionProcessorAdapter,
  type MeetingSourceAdapter,
} from '../../src/core/index.js';

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

function stoppedLaunchd(): LaunchctlRunner {
  let loaded = false;
  return async (input) => {
    const args = [...input];
    if (args[0] === 'print') {
      return loaded
        ? { status: 0, stdout: 'state = running\npid = 4242\n', stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (args[0] === 'bootstrap' || args[0] === 'kickstart') loaded = true;
    return { status: 0, stdout: '', stderr: '' };
  };
}

/**
 * The daemon loop is only reachable through the hidden `service-run` the
 * LaunchAgent invokes, so its signal handling is exercised the way launchd
 * reaches it: an initialized installation with the owned plist in place.
 */
async function installedServiceFixture(
  adapterFactories: ProductAdapterFactoryRegistry,
): Promise<{ configPath: string; dependencies: ProductCliDependencies }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-service-run-')));
  directories.push(root);
  const configPath = join(root, 'runtime.json');
  const cliPath = join(root, 'echo-brain-cli.js');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      validateProductRuntimeConfig({
        ...config(),
        state_dir: join(root, 'state'),
        // launchd refuses to persist a non-file credential ref, so the service
        // profile carries none.
        meeting_sources: [
          {
            adapter_id: 'fixture-meetings',
            instance_id: 'primary',
            settings: {},
          },
        ],
        decision_processor: {
          adapter_id: 'fixture-processor',
          instance_id: 'primary',
          settings: {},
        },
        delivery_surfaces: [
          { adapter_id: 'fixture-delivery', instance_id: 'team', settings: {} },
        ],
      }),
      null,
      2,
    )}\n`,
  );
  const dependencies: ProductCliDependencies = {
    classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
    adapterFactories,
    operator: {
      launchctl: stoppedLaunchd(),
      platform: 'darwin',
      architecture: 'arm64',
      homeDirectory: join(root, 'home'),
      cliPath,
      buildIdentity: {
        source_sha: '1'.repeat(40),
        source_kind: 'materialized-commit',
      },
    },
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
  for (const argv of [
    ['init', '--config', configPath],
    ['service', 'install', '--config', configPath],
  ]) {
    expect(await runProductCli(argv, dependencies)).toBe(0);
  }
  return { configPath, dependencies };
}

afterEach(() => {
  while (directories.length > 0)
    rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('isolated product runtime', () => {
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

  it('checks organization access before contacting configured adapters', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-access-gate-'));
    directories.push(directory);
    const fixtures = registeredFixtures();
    let healthChecks = 0;
    fixtures.meetingSource.healthCheck = async () => {
      healthChecks += 1;
      return {
        status: 'healthy',
        checked_at: '2026-07-28T20:00:00.000Z',
      };
    };

    await expect(
      prepareProductComposition(
        { ...config(), state_dir: join(directory, 'state') },
        fixtures.registry,
        {
          classifyStateFilesystem: async () => ({
            kind: 'local',
            raw: 'apfs',
          }),
          accessGate: {
            async assertAuthorized() {
              throw new Error('signed organization lease expired');
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'organization_access_denied',
      message: expect.stringContaining('signed organization lease expired'),
    });
    expect(healthChecks).toBe(0);
  });

  it('reports every unavailable configured adapter', () => {
    const result = resolveConfiguredAdapters(config(), new AdapterRegistry());
    expect(result).toBeInstanceOf(ProductRuntimeFailure);
    if (!(result instanceof ProductRuntimeFailure)) {
      throw new Error('expected failure');
    }
    expect(result.code).toBe('adapter_unavailable');
    expect(result.details).toEqual([
      "meeting-source adapter 'fixture-meetings' instance 'primary' is unavailable",
      "decision-processor adapter 'fixture-processor' instance 'primary' is unavailable",
      "delivery-surface adapter 'fixture-delivery' instance 'team' is unavailable",
    ]);
  });

  it('aggregates adapter-owned config errors without leaking credential references', () => {
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
    const result = resolveConfiguredAdapters(config(), fixtures.registry);
    expect(result).toBeInstanceOf(ProductRuntimeFailure);
    if (!(result instanceof ProductRuntimeFailure)) {
      throw new Error('expected failure');
    }
    expect(result.code).toBe('adapter_invalid_config');
    expect(result.details).toEqual([
      "meeting-source adapter 'fixture-meetings' instance 'primary': workspace setting is required",
      "decision-processor adapter 'fixture-processor' instance 'primary': model setting is unsupported",
      "delivery-surface adapter 'fixture-delivery' instance 'team': configuration is invalid",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /MEETING_SOURCE_KEY|DECISION_PROCESSOR_KEY|DELIVERY_SURFACE_KEY/,
    );
  });

  it('runs no service-run cycle when SIGINT arrives during composition health setup', async () => {
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
    const service = await installedServiceFixture(fixtureFactories(fixtures));
    const emitter = new EventEmitter();
    let stdout = '';
    const execution = runProductCli(
      ['service-run', '--config', service.configPath],
      {
        ...service.dependencies,
        process: emitter as ProductCliProcess,
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
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

  it('completes its immediate service-run cycle and stops on SIGTERM', async () => {
    const fixtures = registeredFixtures();
    let pulls = 0;
    fixtures.meetingSource.pull = async () => {
      pulls += 1;
      return { meetings: [] };
    };
    let closed = 0;
    const service = await installedServiceFixture(fixtureFactories(fixtures));
    const emitter = new EventEmitter();
    let stdout = '';
    const execution = runProductCli(
      ['service-run', '--config', service.configPath],
      {
        ...service.dependencies,
        process: emitter as ProductCliProcess,
        composition: {
          closeResources: () => {
            closed += 1;
          },
        },
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
      },
    );
    while (!stdout.includes('cycle-complete')) await new Promise(setImmediate);
    emitter.emit('SIGTERM');

    expect(await execution).toBe(0);
    expect(pulls).toBe(1);
    expect(closed).toBe(1);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({
      ok: true,
      signal: 'SIGTERM',
      shutdown: { ok: true },
    });
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes service-run signal handlers when composition setup fails', async () => {
    const fixtures = registeredFixtures();
    fixtures.meetingSource.healthCheck = async () => {
      throw new Error('health setup failed');
    };
    const service = await installedServiceFixture(fixtureFactories(fixtures));
    const emitter = new EventEmitter();

    expect(
      await runProductCli(['service-run', '--config', service.configPath], {
        ...service.dependencies,
        process: emitter as ProductCliProcess,
      }),
    ).toBe(1);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });
});
