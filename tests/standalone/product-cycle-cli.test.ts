import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MeetingSourceAdapter } from '../../src/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import { runProductCli } from '../../src/product/cli.js';
import { createDefaultAdapterFactories } from '../../src/product/default-adapters.js';

const roots: string[] = [];
const fixedTime = '2026-07-16T22:00:00.000Z';

function output() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += chunk.toString();
        return true;
      },
    },
    read: () => value,
  };
}

function factories(): ProductAdapterFactoryRegistry {
  const registry = createDefaultAdapterFactories();
  registry.register({
    kind: 'meeting-source',
    adapter_id: 'fixture-notes',
    create: (config): MeetingSourceAdapter => ({
      identity: {
        kind: 'meeting-source',
        adapter_id: config.adapter_id,
        instance_id: config.instance_id,
        version: '1.0.0',
      },
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({ status: 'healthy', checked_at: fixedTime }),
      pull: async (request) => ({
        meetings:
          request.cursor === 'cursor-1'
            ? []
            : [
                {
                  schema_version: 1,
                  id: 'meeting-1',
                  title: 'Product planning',
                  time: { actual_start_at: fixedTime },
                  capture: {
                    state: 'complete',
                    components: [{ kind: 'notes', state: 'available' }],
                  },
                  participants: [],
                  content: [
                    {
                      id: 'notes-1',
                      kind: 'note',
                      text: [
                        'Decision: Ship the adapter-composed runtime',
                        'Action: Document the approval loop',
                        'Rationale: The core must remain replaceable',
                      ].join('\n'),
                    },
                  ],
                  artifacts: [],
                  provenance: {
                    source: {
                      kind: 'meeting-source',
                      adapter_id: config.adapter_id,
                      instance_id: config.instance_id,
                      version: '1.0.0',
                    },
                    external_id: 'external-1',
                    canonical_revision: 'revision-1',
                    observed_at: fixedTime,
                    normalizer_version: '1.0.0',
                    source_updated_at: fixedTime,
                  },
                },
              ],
        next_cursor: 'cursor-1',
      }),
    }),
  });
  return registry;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('standalone composed cycle', () => {
  it('persists pending review, resumes after approval, and delivers once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-brain-cycle-'));
    roots.push(root);
    const stateDirectory = join(root, 'state');
    const outboxPath = join(stateDirectory, 'outbox.jsonl');
    const configPath = join(root, 'config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          lane: 'team-product',
          state_dir: stateDirectory,
          meeting_sources: [
            {
              adapter_id: 'fixture-notes',
              instance_id: 'primary',
              settings: {},
            },
          ],
          decision_processor: {
            adapter_id: 'structured-text',
            instance_id: 'primary',
            settings: {},
          },
          communication_channels: [
            {
              adapter_id: 'jsonl-outbox',
              instance_id: 'primary',
              settings: {
                path: outboxPath,
                destination_id: 'reviewed-briefs',
              },
            },
          ],
          approval_mode: 'manual',
        },
        null,
        2,
      )}\n`,
    );

    let id = 0;
    const dependencies = {
      adapterFactories: factories(),
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'test-local',
      }),
      now: () => fixedTime,
      composition: { createId: () => `generated-${++id}` },
    };

    const firstOut = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...dependencies,
        stdout: firstOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    const first = JSON.parse(firstOut.read()) as {
      cycle: { meetings_pending: number; deliveries: number };
      pending_approval_ids: string[];
    };
    expect(first.cycle).toMatchObject({ meetings_pending: 1, deliveries: 0 });
    expect(first.pending_approval_ids).toHaveLength(1);
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDirectory, 'echo-brain.sqlite')).mode & 0o777).toBe(
      0o600,
    );
    expect(existsSync(outboxPath)).toBe(false);

    const listedOut = output();
    expect(
      await runProductCli(['approvals', '--config', configPath], {
        ...dependencies,
        stdout: listedOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    const listed = JSON.parse(listedOut.read()) as {
      approvals: Array<{
        approval_id: string;
        status: string;
        brief: { decisions: unknown[]; actions: unknown[]; rationales: unknown[] };
      }>;
    };
    expect(listed.approvals[0]).toMatchObject({
      approval_id: first.pending_approval_ids[0],
      status: 'pending',
      brief: {
        decisions: [{ text: 'Ship the adapter-composed runtime' }],
        actions: [{ text: 'Document the approval loop' }],
        rationales: [{ text: 'The core must remain replaceable' }],
      },
    });

    expect(
      await runProductCli(
        [
          'approve',
          '--config',
          configPath,
          '--id',
          first.pending_approval_ids[0]!,
          '--reviewer',
          'operator',
        ],
        {
          ...dependencies,
          stdout: output().stream,
          stderr: output().stream,
        },
      ),
    ).toBe(0);

    const secondOut = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...dependencies,
        stdout: secondOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    expect(JSON.parse(secondOut.read()).cycle).toMatchObject({
      meetings_processed: 1,
      meetings_pending: 0,
      deliveries: 1,
    });
    expect(readFileSync(outboxPath, 'utf8').trim().split('\n')).toHaveLength(1);

    const thirdOut = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...dependencies,
        stdout: thirdOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    expect(JSON.parse(thirdOut.read()).cycle).toMatchObject({
      meetings_seen: 0,
      deliveries: 0,
    });
    expect(readFileSync(outboxPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('applies the configured extraction timeout to the processing stage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-brain-cycle-'));
    roots.push(root);
    const registry = factories();
    registry.register({
      kind: 'decision-processor',
      adapter_id: 'slow-processor',
      create: (config) => ({
        identity: {
          kind: 'decision-processor',
          adapter_id: config.adapter_id,
          instance_id: config.instance_id,
          version: '1.0.0',
        },
        validateConfig: () => ({ ok: true, errors: [] }),
        healthCheck: async () => ({ status: 'healthy', checked_at: fixedTime }),
        extract: () =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          }) as never,
      }),
    });
    const configPath = join(root, 'config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          lane: 'team-product',
          state_dir: join(root, 'state'),
          extraction_timeout_ms: 1_000,
          meeting_sources: [
            { adapter_id: 'fixture-notes', instance_id: 'primary', settings: {} },
          ],
          decision_processor: {
            adapter_id: 'slow-processor',
            instance_id: 'primary',
            settings: {},
          },
          communication_channels: [
            {
              adapter_id: 'jsonl-outbox',
              instance_id: 'primary',
              settings: {
                path: join(root, 'state', 'outbox.jsonl'),
                destination_id: 'reviewed-briefs',
              },
            },
          ],
          approval_mode: 'manual',
        },
        null,
        2,
      )}\n`,
    );

    const out = output();
    const err = output();
    await runProductCli(['run-once', '--config', configPath], {
      adapterFactories: registry,
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'test-local',
      }),
      now: () => fixedTime,
      stdout: out.stream,
      stderr: err.stream,
    });
    // A failed cycle is reported on stderr with a non-zero exit.
    const failures = JSON.parse(err.read()).cycle.sources[0].result.failures;
    expect(failures[0].message).toContain('timed out after 1000ms');
  });
});
