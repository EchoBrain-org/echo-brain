#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  classifyStateFilesystem,
  loadProductRuntimeConfig,
  type ClassifyStateFilesystem,
  type ProductRuntimeConfig,
} from './config.js';
import {
  startProductRuntime,
  type ProductComponentName,
  type ProductRuntimeComponent,
  type ProductRuntimeDependencies,
} from './runtime.js';

export interface ProductCliProcess {
  once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  removeListener: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export interface ProductCliDependencies {
  classifyStateFilesystem?: ClassifyStateFilesystem;
  runtime?: ProductRuntimeDependencies;
  process?: ProductCliProcess;
  stdout?: Pick<Writable, 'write'>;
  stderr?: Pick<Writable, 'write'>;
}

interface ParsedCommand {
  command: 'validate-config' | 'selftest' | 'run';
  configPath: string;
}

function print(stream: Pick<Writable, 'write'>, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command !== 'validate-config' && command !== 'selftest' && command !== 'run') {
    throw new Error('usage: echo-brain <validate-config|selftest|run> --config <absolute-path>');
  }
  const parsed = parseArgs({
    args: [...argv.slice(1)],
    strict: true,
    allowPositionals: false,
    options: { config: { type: 'string' } },
  });
  if (parsed.values.config === undefined) throw new Error('--config is required');
  return { command, configPath: parsed.values.config };
}

async function probeConfig(
  config: ProductRuntimeConfig,
  classifier: ClassifyStateFilesystem,
): Promise<{ ok: boolean; filesystem: Awaited<ReturnType<ClassifyStateFilesystem>> }> {
  const filesystem = await classifier(config.state_dir);
  return { ok: filesystem.kind === 'local', filesystem };
}

const PRODUCT_COMPONENT_NAMES: readonly ProductComponentName[] = [
  'product-state',
  'granola-meeting-input',
  'signal-extraction',
  'manual-brief-approval',
  'product-health',
];

function unavailableProductionComponents(): ProductRuntimeComponent[] {
  return PRODUCT_COMPONENT_NAMES.map((name) => ({
    name,
    start: async () => {
      throw new Error(`${name} cannot start without the rank-3 production adapter`);
    },
  }));
}

export async function runProductCli(
  argv: readonly string[],
  dependencies: ProductCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let parsed: ParsedCommand;
  let config: ProductRuntimeConfig;
  try {
    parsed = parseCommand(argv);
    config = loadProductRuntimeConfig(parsed.configPath);
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }
  const classifier = dependencies.classifyStateFilesystem ?? classifyStateFilesystem;
  if (parsed.command === 'validate-config' || parsed.command === 'selftest') {
    const probe = await probeConfig(config, classifier);
    if (!probe.ok) {
      print(stderr, { ok: false, command: parsed.command, filesystem: probe.filesystem });
      return 1;
    }
    print(stdout, {
      ok: true,
      command: parsed.command,
      lane: config.lane,
      filesystem: probe.filesystem,
      maturity: 'DEV',
      brain_adapter:
        parsed.command === 'selftest'
          ? { id: config.brain_adapter.id, status: 'pending', reason: 'rank-3 adapter unavailable' }
          : { id: config.brain_adapter.id, status: 'configured-reference-only' },
      wedge_executed: false,
    });
    return 0;
  }

  const runtimeDependencies: ProductRuntimeDependencies = dependencies.runtime ?? {
    classifyStateFilesystem: classifier,
    brainAdapters: {},
    components: unavailableProductionComponents(),
  };
  const runtime = await startProductRuntime(config, {
    ...runtimeDependencies,
    classifyStateFilesystem: classifier,
  });
  if (!runtime.ok) {
    print(stderr, { ok: false, code: runtime.error.code, error: runtime.error.message });
    return 1;
  }
  const processLike = dependencies.process ?? process;
  const signal = await new Promise<'SIGINT' | 'SIGTERM'>((resolveSignal) => {
    const cleanup = () => {
      processLike.removeListener('SIGINT', onInterrupt);
      processLike.removeListener('SIGTERM', onTerminate);
    };
    const onInterrupt = () => {
      cleanup();
      resolveSignal('SIGINT');
    };
    const onTerminate = () => {
      cleanup();
      resolveSignal('SIGTERM');
    };
    processLike.once('SIGINT', onInterrupt);
    processLike.once('SIGTERM', onTerminate);
  });
  const shutdown = await runtime.handle.shutdown();
  print(shutdown.ok ? stdout : stderr, { ok: false, signal, shutdown });
  return 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runProductCli(process.argv.slice(2));
}
