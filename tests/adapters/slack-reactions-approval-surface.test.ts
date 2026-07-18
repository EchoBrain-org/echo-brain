import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterConfig, ApprovalRequest } from '../../src/core/index.js';
import { AdapterError } from '../../src/core/index.js';
import { createSlackReactionsApprovalSurface } from '../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import {
  DecisionNodeStore,
  decisionApprovalId,
} from '../../src/product/index.js';

const roots: string[] = [];

function request(): ApprovalRequest {
  return {
    processing_key: 'source:instance:item:revision:processor:instance:version',
    requested_at: '2026-07-16T20:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'source',
          instance_id: 'instance',
          version: '1',
        },
        external_id: 'item',
        canonical_revision: 'revision',
        observed_at: '2026-07-16T19:00:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-07-16T19:00:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-07-16T19:30:00.000Z',
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: {
        id: 'meeting-1',
        title: 'Planning',
        time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'processor',
          instance_id: 'instance',
          version: '1',
        },
        generated_at: '2026-07-16T19:30:00.000Z',
      },
    },
  };
}

const REVIEWER = 'U777';

function surfaceConfig(): AdapterConfig {
  return {
    adapter_id: 'slack-reactions',
    instance_id: 'founder',
    credential_ref: 'env:SLACK_BOT_TOKEN',
    settings: {
      channel_id: 'C123',
      reviewer: { slack_user_id: REVIEWER, name: 'zhenye' },
    },
  };
}

interface FakeSlack {
  fetchImpl: typeof fetch;
  calls: string[];
  reactions: Array<{ name: string; users: string[]; count: number }>;
  replies: Array<{ user: string; text: string; ts: string }>;
  failReactionsWith?: number;
}

function fakeSlack(): FakeSlack {
  const state: FakeSlack = {
    calls: [],
    reactions: [],
    replies: [],
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.split('/').pop()!.split('?')[0]!;
      state.calls.push(method);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'auth.test') return json({ ok: true, user_id: 'B1' });
      if (method === 'chat.postMessage') {
        return json({ ok: true, channel: 'C123', ts: '1700.100' });
      }
      if (method === 'reactions.get') {
        if (state.failReactionsWith !== undefined) {
          return new Response('slow down', { status: state.failReactionsWith });
        }
        return json({
          ok: true,
          message: { ts: '1700.100', reactions: state.reactions },
        });
      }
      if (method === 'conversations.replies') {
        return json({
          ok: true,
          messages: [
            { ts: '1700.100', user: 'B1', text: 'parent message' },
            ...state.replies,
          ],
        });
      }
      return json({ ok: false, error: 'unknown_method' });
    }) as typeof fetch,
  };
  return state;
}

function build(slack: FakeSlack) {
  const root = mkdtempSync(join(tmpdir(), 'slack-surface-'));
  roots.push(root);
  const store = new DecisionNodeStore(root, {
    now: () => '2026-07-16T21:00:00.000Z',
  });
  const surface = createSlackReactionsApprovalSurface(surfaceConfig(), {
    store,
    environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
    now: () => '2026-07-16T21:00:00.000Z',
    fetchImpl: slack.fetchImpl,
  });
  return { surface, store };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('slack reactions approval surface', () => {
  it('posts the brief exactly once and stays pending without reactions', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);

    expect(await surface.review(request())).toMatchObject({ status: 'pending' });
    expect(await surface.review(request())).toMatchObject({ status: 'pending' });
    expect(slack.calls.filter((call) => call === 'chat.postMessage')).toHaveLength(1);
    expect(slack.calls.filter((call) => call === 'reactions.get')).toHaveLength(2);
  });

  it('approves on the reviewer reaction and captures the latest thread reason', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [{ name: 'white_check_mark', users: [REVIEWER], count: 1 }];
    slack.replies = [
      { user: 'USOMEONE', text: 'not the reviewer', ts: '1700.200' },
      { user: REVIEWER, text: 'early thought', ts: '1700.300' },
      { user: REVIEWER, text: 'ship it', ts: '1700.400' },
    ];
    const decision = await surface.review(request());
    expect(decision).toEqual({
      status: 'approved',
      reviewed_at: '2026-07-16T21:00:00.000Z',
      reviewed_by: 'zhenye',
      reason: 'ship it',
      approved_brief: request().brief,
    });
  });

  it('rejects on the reject reaction with a null reason when the thread is silent', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [{ name: 'x', users: [REVIEWER], count: 1 }];
    const decision = await surface.review(request());
    expect(decision).toMatchObject({
      status: 'rejected',
      reviewed_by: 'zhenye',
      reason: null,
    });
  });

  it('fails closed while both reactions are present', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER], count: 1 },
      { name: 'x', users: [REVIEWER], count: 1 },
    ];
    expect(await surface.review(request())).toMatchObject({ status: 'pending' });
  });

  it('ignores reactions from users outside the reviewer allowlist', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [{ name: 'white_check_mark', users: ['UIMPOSTOR'], count: 1 }];
    expect(await surface.review(request())).toMatchObject({ status: 'pending' });
  });

  it('stays pending when the reactor roster is incomplete', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    // Slack may omit reactors from `users` while `count` stays complete;
    // identity can no longer be proven, so nothing may resolve.
    slack.reactions = [{ name: 'white_check_mark', users: [REVIEWER], count: 2 }];
    expect(await surface.review(request())).toMatchObject({ status: 'pending' });
  });

  it('surfaces polling failures as retryable adapter errors and leaves the node CLI-resolvable', async () => {
    const slack = fakeSlack();
    const { surface, store } = build(slack);
    await surface.review(request());

    slack.failReactionsWith = 429;
    await expect(surface.review(request())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AdapterError &&
        error.code === 'rate_limited' &&
        error.retryable,
    );

    const resolved = await store.resolve({
      approvalId: decisionApprovalId(request().processing_key),
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'cli',
    });
    expect(resolved.status).toBe('approved');
  });

  it('reports a resolution another surface already made instead of conflicting', async () => {
    const slack = fakeSlack();
    const { surface, store } = build(slack);
    await surface.review(request());
    await store.resolve({
      approvalId: decisionApprovalId(request().processing_key),
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'cli wins',
      surface: 'cli',
    });

    slack.reactions = [{ name: 'white_check_mark', users: [REVIEWER], count: 1 }];
    const decision = await surface.review(request());
    expect(decision).toMatchObject({
      status: 'rejected',
      reviewed_by: 'operator',
      reason: 'cli wins',
    });
    // The Slack surface never posted a conflicting resolution.
    expect(slack.calls.filter((call) => call === 'conversations.replies')).toHaveLength(0);
  });

  it('validates its configuration strictly', () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    const valid = surfaceConfig();
    expect(surface.validateConfig(valid).ok).toBe(true);

    const failures: Array<[Partial<AdapterConfig> | Record<string, unknown>, RegExp]> = [
      [{ credential_ref: undefined }, /credential_ref is required/],
      [{ credential_ref: 'keychain:slack' }, /env: reference/],
      [
        { settings: { ...valid.settings, extra: true } },
        /settings.extra is not supported/,
      ],
      [{ settings: { reviewer: valid.settings['reviewer'] } }, /channel_id/],
      [{ settings: { channel_id: 'C123' } }, /reviewer/],
      [
        {
          settings: {
            ...valid.settings,
            approve_reaction: 'x',
          },
        },
        /must differ/,
      ],
    ];
    for (const [override, expected] of failures) {
      const result = surface.validateConfig({ ...valid, ...override } as AdapterConfig);
      expect(result.ok).toBe(false);
      expect(result.errors.join('; ')).toMatch(expected);
    }
  });
});
