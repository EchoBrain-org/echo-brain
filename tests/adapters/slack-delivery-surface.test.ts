import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterConfig,
  DecisionBrief,
  DeliveryEnvelope,
} from '../../src/core/index.js';
import { AdapterError, assertDeliveryReceipt } from '../../src/core/index.js';
import {
  FileSlackDeliveryReceiptStore,
  SlackDeliverySurface,
} from '../../src/adapters/delivery-surfaces/slack/index.js';
import { adapterConformance } from '../support/adapter-conformance.js';

const roots: string[] = [];

function config(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    adapter_id: 'slack',
    instance_id: 'team-decisions',
    credential_ref: 'env:SLACK_BOT_TOKEN',
    settings: { channel_id: 'C123' },
    ...overrides,
  };
}

function brief(): DecisionBrief {
  const evidence = [
    { meeting_id: 'meeting-1', block_id: 'block-1', quote: 'Ship the wedge' },
  ];
  return {
    schema_version: 1,
    id: 'brief-1',
    meeting: {
      id: 'meeting-1',
      title: 'Planning <!channel> <@U123>',
      participants: [],
    },
    decisions: [
      {
        id: 'decision-1',
        kind: 'decision',
        text: 'Ship the founder wedge',
        subject: null,
        confidence: 0.9,
        evidence,
        status: 'decided',
      },
    ],
    actions: [
      {
        id: 'action-1',
        kind: 'action',
        text: 'Run the live test',
        subject: null,
        confidence: 0.8,
        evidence,
        owner: 'zhenye',
        due_at: null,
      },
    ],
    rationales: [],
    provenance: {
      meeting_revision: 'revision-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'llm',
        instance_id: 'ollama',
        version: '1.0.0',
      },
      generated_at: '2026-07-18T20:00:00.000Z',
    },
  };
}

function envelope(
  surface: SlackDeliverySurface,
  id = 'envelope-1',
  key = 'delivery:test:slack:team-decisions',
): DeliveryEnvelope {
  return {
    schema_version: 1,
    id,
    idempotency_key: key,
    destination: surface.destination,
    brief: brief(),
    approved_at: '2026-07-18T20:01:00.000Z',
  };
}

interface FakeSlack {
  fetchImpl: typeof fetch;
  postBodies: Array<Record<string, unknown>>;
  postCalls: number;
  postMode: 'success' | 'transport' | 'rate-limited' | 'unauthorized';
}

function fakeSlack(): FakeSlack {
  const slack: FakeSlack = {
    postBodies: [],
    postCalls: 0,
    postMode: 'success',
    fetchImpl: (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.split('/').pop();
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'auth.test') return json({ ok: true, user_id: 'B123' });
      if (method === 'chat.postMessage') {
        slack.postCalls += 1;
        if (typeof init?.body === 'string') {
          slack.postBodies.push(
            JSON.parse(init.body) as Record<string, unknown>,
          );
        }
        if (slack.postMode === 'transport') throw new Error('socket reset');
        if (slack.postMode === 'rate-limited') {
          return json({ ok: false, error: 'ratelimited' });
        }
        if (slack.postMode === 'unauthorized') {
          return json({ ok: false, error: 'invalid_auth' });
        }
        return json({ ok: true, channel: 'C123', ts: '1700.100' });
      }
      return json({ ok: false, error: 'unknown_method' });
    }) as typeof fetch,
  };
  return slack;
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echo-slack-delivery-'));
  roots.push(root);
  return root;
}

function build(root: string, slack: FakeSlack, adapterConfig = config()) {
  return new SlackDeliverySurface(adapterConfig, {
    receiptStore: new FileSlackDeliveryReceiptStore(
      root,
      adapterConfig.instance_id,
    ),
    environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
    now: () => '2026-07-18T20:02:00.000Z',
    fetchImpl: slack.fetchImpl,
  });
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

adapterConformance({
  name: 'Slack delivery surface',
  kind: 'delivery-surface',
  create: () => {
    const root = join(tmpdir(), `echo-slack-conformance-${process.pid}`);
    roots.push(root);
    return build(root, fakeSlack());
  },
  validConfig: config(),
  invalidConfig: config({
    instance_id: 'Invalid Instance',
    credential_ref: 'env:SECRET_MUST_NOT_APPEAR',
    settings: { channel_id: 'not-a-channel', unsupported: true },
  }),
});

describe('Slack delivery surface', () => {
  it('publishes an approved brief and returns a canonical receipt', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const surface = build(root, slack);
    const candidate = envelope(surface);

    const receipt = await surface.publish(candidate);

    expect(() => assertDeliveryReceipt(candidate, receipt)).not.toThrow();
    expect(receipt).toEqual({
      schema_version: 1,
      envelope_id: 'envelope-1',
      status: 'delivered',
      external_id: 'slack:message:C123:1700.100',
      recorded_at: '2026-07-18T20:02:00.000Z',
      retryable: false,
    });
    expect(slack.postCalls).toBe(1);
    const body = slack.postBodies[0];
    expect(body?.['channel']).toBe('C123');
    expect(String(body?.['text'])).toContain('&lt;!channel&gt;');
    expect(JSON.stringify(body?.['blocks'])).toContain(
      'Ship the founder wedge',
    );
    expect(JSON.stringify(body?.['blocks'])).not.toMatch(
      /awaiting approval|to approve|to reject|react :/i,
    );
  });

  it('deduplicates concurrently and across adapter restarts using durable channel/ts state', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const first = build(root, slack);
    const second = build(root, slack);
    const [one, two] = await Promise.all([
      first.publish(envelope(first, 'attempt-1')),
      second.publish(envelope(second, 'attempt-2')),
    ]);
    const restarted = build(root, slack);
    const three = await restarted.publish(envelope(restarted, 'attempt-3'));

    expect(slack.postCalls).toBe(1);
    expect(one.external_id).toBe('slack:message:C123:1700.100');
    expect(two).toMatchObject({
      envelope_id: 'attempt-2',
      external_id: one.external_id,
      recorded_at: one.recorded_at,
    });
    expect(three).toMatchObject({
      envelope_id: 'attempt-3',
      external_id: one.external_id,
      recorded_at: one.recorded_at,
    });
  });

  it('pins an ambiguous transport outcome and never reposts it', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    slack.postMode = 'transport';
    const first = build(root, slack);
    const firstReceipt = await first.publish(envelope(first, 'attempt-1'));
    slack.postMode = 'success';
    const restarted = build(root, slack);
    const retryReceipt = await restarted.publish(
      envelope(restarted, 'attempt-2'),
    );

    expect(slack.postCalls).toBe(1);
    expect(firstReceipt).toMatchObject({
      status: 'unknown',
      external_id: null,
      retryable: true,
    });
    expect(retryReceipt).toMatchObject({
      envelope_id: 'attempt-2',
      status: 'unknown',
      recorded_at: firstReceipt.recorded_at,
    });
  });

  it('pins an unexpected response channel instead of claiming delivery', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const originalFetch = slack.fetchImpl;
    slack.fetchImpl = (async (input, init) => {
      const response = await originalFetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      return url.endsWith('/chat.postMessage')
        ? new Response(
            JSON.stringify({ ok: true, channel: 'C999', ts: '1700.200' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        : response;
    }) as typeof fetch;
    const surface = build(root, slack);

    await expect(surface.publish(envelope(surface))).resolves.toMatchObject({
      status: 'unknown',
      external_id: null,
      retryable: true,
      message: expect.stringMatching(/unexpected destination/),
    });
    await expect(
      build(root, slack).publish(envelope(surface, 'attempt-2')),
    ).resolves.toMatchObject({
      status: 'unknown',
    });
    expect(slack.postCalls).toBe(1);
  });

  it('clears a known-safe API failure so a later retry can post', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    slack.postMode = 'rate-limited';
    const surface = build(root, slack);

    await expect(surface.publish(envelope(surface))).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    slack.postMode = 'success';
    await expect(
      surface.publish(envelope(surface, 'attempt-2')),
    ).resolves.toMatchObject({
      status: 'delivered',
    });
    expect(slack.postCalls).toBe(2);
  });

  it('honors cancellation before touching durable state or Slack', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const surface = build(root, slack);
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));

    await expect(
      surface.publish(envelope(surface), { signal: controller.signal }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdapterError>>({
        code: 'timeout',
        retryable: true,
      }),
    );
    expect(slack.postCalls).toBe(0);
  });

  it('rejects malformed and wrong-destination envelopes before posting', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const surface = build(root, slack);
    const malformed = envelope(surface);
    malformed.approved_at = 'not-a-date';
    await expect(surface.publish(malformed)).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });

    const wrongDestination = envelope(surface);
    wrongDestination.destination = {
      ...wrongDestination.destination,
      external_id: 'C999',
    };
    await expect(surface.publish(wrongDestination)).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });
    expect(slack.postCalls).toBe(0);
  });

  it('fails closed when the private receipt directory is a symbolic link', async () => {
    const root = await stateRoot();
    const target = await stateRoot();
    await mkdir(join(root, 'delivery-surfaces', 'slack'), { recursive: true });
    await symlink(
      target,
      join(root, 'delivery-surfaces', 'slack', 'team-decisions'),
    );
    const slack = fakeSlack();
    const surface = build(root, slack);

    await expect(surface.publish(envelope(surface))).rejects.toMatchObject({
      code: 'invalid_config',
      retryable: false,
    });
    expect(slack.postCalls).toBe(0);
  });

  it('fails closed when an intermediate receipt directory is a symbolic link', async () => {
    const root = await stateRoot();
    const target = await stateRoot();
    await symlink(target, join(root, 'delivery-surfaces'));
    const slack = fakeSlack();
    const surface = build(root, slack);

    await expect(surface.publish(envelope(surface))).rejects.toMatchObject({
      code: 'invalid_config',
      retryable: false,
    });
    expect(slack.postCalls).toBe(0);
  });

  it('validates configuration strictly and reports credential health', async () => {
    const root = await stateRoot();
    const slack = fakeSlack();
    const surface = build(root, slack);
    expect(surface.validateConfig(config())).toEqual({ ok: true, errors: [] });
    await expect(surface.healthCheck()).resolves.toMatchObject({
      status: 'healthy',
      details: { destination_capability: 'unverified_until_publish' },
    });
    for (const candidate of [
      config({ credential_ref: undefined }),
      config({ credential_ref: 'keychain:slack' }),
      config({ settings: { channel_id: 'general' } }),
      config({
        settings: { channel_id: 'C123', base_url: 'https://evil.invalid' },
      }),
      config({ settings: { channel_id: 'C123', request_timeout_ms: 1 } }),
    ]) {
      expect(surface.validateConfig(candidate).ok).toBe(false);
    }

    const missingCredential = new SlackDeliverySurface(config(), {
      receiptStore: new FileSlackDeliveryReceiptStore(root, 'team-decisions'),
      environment: {},
      fetchImpl: slack.fetchImpl,
    });
    await expect(missingCredential.healthCheck()).resolves.toMatchObject({
      status: 'unauthorized',
    });
    await expect(
      missingCredential.publish(envelope(missingCredential)),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
  });
});
