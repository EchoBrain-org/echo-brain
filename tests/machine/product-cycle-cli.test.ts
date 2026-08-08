import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('standalone composed cycle', () => {
  it('wires Slack adapter approval from pending reaction through delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-brain-slack-cycle-'));
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
          delivery_surfaces: [
            {
              adapter_id: 'jsonl-outbox',
              instance_id: 'primary',
              settings: {
                path: outboxPath,
                destination_id: 'reviewed-briefs',
              },
            },
          ],
          approval_mode: 'adapter',
          approval_surface: {
            adapter_id: 'slack-reactions',
            instance_id: 'founder',
            credential_ref: 'env:SLACK_BOT_TOKEN',
            settings: {
              channel_id: 'C123',
              reviewer: { slack_user_id: 'U123', name: 'founder' },
            },
          },
          organization_ingest: {
            exclude: {
              sources: [
                { adapter_id: 'fixture-notes', instance_id: 'primary' },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    let reviewerApproved = false;
    const calls: string[] = [];
    const postedBodies: Array<Record<string, unknown>> = [];
    const slackFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = url.split('/').pop()!.split('?')[0]!;
        calls.push(method);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (method === 'auth.test') return json({ ok: true, user_id: 'B123' });
        if (method === 'chat.postMessage') {
          postedBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return json({ ok: true, channel: 'C123', ts: '1700.100' });
        }
        if (method === 'reactions.get') {
          return json({
            ok: true,
            message: {
              ts: '1700.100',
              reactions: reviewerApproved
                ? [{ name: 'white_check_mark', users: ['U123'], count: 1 }]
                : [],
            },
          });
        }
        if (method === 'conversations.replies') {
          return json({
            ok: true,
            messages: [
              { ts: '1700.100', user: 'B123', text: 'approval request' },
              { ts: '1700.200', user: 'U123', text: 'ship it' },
            ],
          });
        }
        return json({ ok: false, error: 'unknown_method' });
      },
    );
    vi.stubGlobal('fetch', slackFetch);

    let id = 0;
    const dependencies = {
      adapterFactories: factories(),
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'test-local',
      }),
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
      now: () => fixedTime,
      composition: { createId: () => `slack-generated-${++id}` },
    };

    const firstOut = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...dependencies,
        stdout: firstOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    expect(JSON.parse(firstOut.read()).cycle).toMatchObject({
      meetings_pending: 1,
      deliveries: 0,
    });
    expect(postedBodies).toHaveLength(1);
    expect(calls.filter((call) => call === 'chat.postMessage')).toHaveLength(1);
    expect(existsSync(outboxPath)).toBe(false);

    reviewerApproved = true;
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
    expect(calls.filter((call) => call === 'chat.postMessage')).toHaveLength(1);
    expect(calls).toContain('conversations.replies');
    expect(readFileSync(outboxPath, 'utf8').trim().split('\n')).toHaveLength(1);

    // A third cycle over the same still-approved reaction is a no-op: the
    // approval is not re-applied and the delivery is not repeated.
    const thirdOut = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...dependencies,
        stdout: thirdOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    expect(JSON.parse(thirdOut.read()).cycle).toMatchObject({
      meetings_processed: 0,
      meetings_pending: 0,
      deliveries: 0,
    });
    expect(readFileSync(outboxPath, 'utf8').trim().split('\n')).toHaveLength(1);

    const listedOut = output();
    expect(
      await runProductCli(['approvals', '--config', configPath], {
        ...dependencies,
        stdout: listedOut.stream,
        stderr: output().stream,
      }),
    ).toBe(0);
    expect(JSON.parse(listedOut.read()).approvals[0]).toMatchObject({
      status: 'approved',
      reviewed_by: 'founder',
      reason: 'ship it',
      // The projection shows organization-record state beside the local
      // decision. Before this existed an operator could not tell a decision
      // that reached the organization from one that never left the machine.
      organization_record: {
        status: 'excluded',
        position: null,
        record_hash: null,
        rejection_reason_code: null,
      },
    });
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
            {
              adapter_id: 'fixture-notes',
              instance_id: 'primary',
              settings: {},
            },
          ],
          decision_processor: {
            adapter_id: 'slow-processor',
            instance_id: 'primary',
            settings: {},
          },
          delivery_surfaces: [
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
