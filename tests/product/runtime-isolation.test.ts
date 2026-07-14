import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProductCli, type ProductCliProcess } from '../../src/product/cli.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import {
  startProductRuntime,
  type DeadlineRunner,
  type ProductComponentName,
  type ProductRuntimeComponent,
  type ProductRuntimeDependencies,
} from '../../src/product/runtime.js';
import type { GranolaSignalAdapter } from '../../src/enrich/granola-signals.js';

const COMPONENTS: readonly ProductComponentName[] = [
  'product-state',
  'granola-meeting-input',
  'signal-extraction',
  'manual-brief-approval',
  'product-health',
];
const directories: string[] = [];

function config() {
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/tmp/echo-product-runtime/state',
    granola: {
      workspace_id: 'workspace-synthetic',
      input: 'api',
      credential_ref: 'env:GRANOLA_API_KEY',
    },
    brain_adapter: {
      id: 'fixture-memory',
      credential_ref: 'env:FIXTURE_BRAIN_KEY',
    },
    approval_mode: 'manual',
  });
}

function adapter(extractCalls: string[] = []): GranolaSignalAdapter {
  return {
    id: 'fixture-memory',
    preflight: async () => {},
    extract: async (input) => {
      extractCalls.push(input.note_id);
      return [];
    },
  };
}

function components(
  starts: string[],
  stops: string[],
  overrides: Partial<Record<ProductComponentName, ProductRuntimeComponent['start']>> = {},
): ProductRuntimeComponent[] {
  return COMPONENTS.map((name) => ({
    name,
    start: overrides[name] ??
      (async () => {
        starts.push(name);
        return { stop: async () => void stops.push(name) };
      }),
  }));
}

function dependencies(
  runtimeComponents: readonly ProductRuntimeComponent[],
  extra: Partial<ProductRuntimeDependencies> = {},
): ProductRuntimeDependencies {
  return {
    classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
    brainAdapters: { 'fixture-memory': adapter() },
    components: runtimeComponents,
    ...extra,
  };
}

function configFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-product-runtime-cli-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, `${JSON.stringify(config(), null, 2)}\n`);
  return path;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('isolated product runtime', () => {
  it('starts exactly the five wedge components in order with installation-local paths', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const extractCalls: string[] = [];
    const runtimeComponents = components(starts, stops, {
      'product-state': async (context) => {
        starts.push('product-state');
        expect(Object.values(context.paths).every((path) => path.startsWith(config().state_dir))).toBe(
          true,
        );
        expect(JSON.stringify(context.paths)).not.toMatch(/GRANOLA|ANTHROPIC|FIXTURE_BRAIN_KEY/);
        return { stop: async () => void stops.push('product-state') };
      },
      'signal-extraction': async (context) => {
        starts.push('signal-extraction');
        await context.adapter.extract(
          {
            note_id: 'synthetic-note',
            meeting_title: 'Synthetic meeting',
            updated_at: '2026-07-13T00:00:00.000Z',
            summary_text: 'Synthetic summary',
            summary_dedupe_key: 'summary',
            transcript_text: 'Synthetic transcript',
            transcript_dedupe_key: 'transcript',
            transcript_items: [],
          },
          { extractor_version: 'fixture' },
        );
        return { stop: async () => void stops.push('signal-extraction') };
      },
    });
    const result = await startProductRuntime(
      config(),
      dependencies(runtimeComponents, { brainAdapters: { 'fixture-memory': adapter(extractCalls) } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(starts).toEqual(COMPONENTS);
    expect(extractCalls).toEqual(['synthetic-note']);
    expect(result.handle.paths).toMatchObject({
      database: '/tmp/echo-product-runtime/state/echo-brain.sqlite',
      pollCheckpoint: '/tmp/echo-product-runtime/state/checkpoints/granola.json',
      signalCheckpoint: '/tmp/echo-product-runtime/state/checkpoints/granola-signals.json',
      briefs: '/tmp/echo-product-runtime/state/briefs',
      heartbeat: '/tmp/echo-product-runtime/state/health/granola-signals.json',
    });
    expect(await result.handle.shutdown()).toEqual({ ok: true, errors: [], remaining: [] });
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
      brainAdapters: {},
      components: components(starts, []),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'adapter_unavailable' } });
    expect(probes).toBe(0);
    expect(starts).toEqual([]);
  });

  it.each(COMPONENTS.map((_name, index) => index))(
    'rolls back all prior components in reverse order when start %i fails',
    async (failureIndex) => {
      const starts: string[] = [];
      const stops: string[] = [];
      const failing = COMPONENTS[failureIndex]!;
      const result = await startProductRuntime(
        config(),
        dependencies(
          components(starts, stops, {
            [failing]: async () => {
              starts.push(failing);
              throw new Error(`${failing} failed`);
            },
          }),
        ),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'startup_failed' } });
      expect(starts).toEqual(COMPONENTS.slice(0, failureIndex + 1));
      expect(stops).toEqual([...COMPONENTS.slice(0, failureIndex)].reverse());
    },
  );

  it('times out a never-settling start and aggregates rollback errors', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const deadline: DeadlineRunner = async (operation, _timeout, label) => {
      if (label === 'signal-extraction start') throw new Error('signal-extraction start timed out');
      if (label === 'granola-meeting-input rollback') throw new Error('meeting rollback failed');
      return await operation;
    };
    const result = await startProductRuntime(
      config(),
      dependencies(
        components(starts, stops, {
          'signal-extraction': () => new Promise(() => {}),
        }),
        { withDeadline: deadline },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.details).toContain('signal-extraction start timed out');
    expect(result.error.details).toContain('meeting rollback failed');
    expect(stops).toContain('product-state');
  });

  it('makes shutdown idempotent, bounded, and explicit about remaining handles', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const deadline: DeadlineRunner = async (operation, _timeout, label) => {
      if (label === 'granola-meeting-input shutdown') throw new Error('meeting shutdown timed out');
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
      remaining: ['granola-meeting-input'],
    });
    expect(stops.filter((name) => name === 'product-state')).toHaveLength(1);
  });

  it('rejects missing, duplicate, reordered, and forbidden component dependencies', async () => {
    const starts: string[] = [];
    const baseline = components(starts, []);
    const variants = [
      baseline.slice(1),
      [...baseline, baseline[0]!],
      [...baseline].reverse(),
      [...baseline, { name: 'remote-delivery' as ProductComponentName, start: async () => ({ stop() {} }) }],
    ];
    for (const variant of variants) {
      const result = await startProductRuntime(config(), dependencies(variant));
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_dependencies' } });
    }
    expect(starts).toEqual([]);
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
      expect(result).toMatchObject({ ok: false, error: { code: 'state_not_local' } });
      expect(starts).toEqual([]);
    }
  });

  it('routes SIGTERM through bounded shutdown and returns a nonzero command result', async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const emitter = new EventEmitter();
    const processLike = emitter as ProductCliProcess;
    const execution = runProductCli(['run', '--config', configFile()], {
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      runtime: dependencies(components(starts, stops)),
      process: processLike,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    while (emitter.listenerCount('SIGTERM') === 0) await new Promise(setImmediate);
    emitter.emit('SIGTERM');
    expect(await execution).toBe(1);
    expect(starts).toEqual(COMPONENTS);
    expect(stops).toEqual([...COMPONENTS].reverse());
  });
});
