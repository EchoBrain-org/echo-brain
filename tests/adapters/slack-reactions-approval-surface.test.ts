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
  postBodies: Array<Record<string, unknown>>;
  reactions: Array<{ name: string; users: string[]; count: number }>;
  replies: Array<{ user: string; text: string; ts: string }>;
  failReactionsWith?: number;
  beforeReplies?: () => void | Promise<void>;
}

interface PostedTextObject {
  type: string;
  text: string;
}

interface PostedBlock {
  type: string;
  text?: PostedTextObject;
  elements?: PostedTextObject[];
}

interface PostedMessageBody extends Record<string, unknown> {
  text: string;
  blocks: PostedBlock[];
}

function postedMessage(slack: FakeSlack): PostedMessageBody {
  const body = slack.postBodies[0];
  if (body === undefined) throw new Error('expected a Slack message body');
  return body as PostedMessageBody;
}

function fakeSlack(): FakeSlack {
  const state: FakeSlack = {
    calls: [],
    postBodies: [],
    reactions: [],
    replies: [],
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
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
        if (typeof init?.body !== 'string') {
          throw new Error('expected chat.postMessage JSON body');
        }
        state.postBodies.push(JSON.parse(init.body) as Record<string, unknown>);
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
        await state.beforeReplies?.();
        state.beforeReplies = undefined;
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

    expect(await surface.review(request())).toMatchObject({
      status: 'pending',
    });
    expect(await surface.review(request())).toMatchObject({
      status: 'pending',
    });
    expect(
      slack.calls.filter((call) => call === 'chat.postMessage'),
    ).toHaveLength(1);
    expect(slack.postBodies).toHaveLength(1);
    expect(slack.calls.filter((call) => call === 'reactions.get')).toHaveLength(
      2,
    );
  });

  it('publishes the immutable staged brief when a retry recompiles the request', async () => {
    const slack = fakeSlack();
    const { surface, store } = build(slack);
    const original = request();
    original.meeting = { ...original.meeting, title: 'Original staged title' };
    original.brief = {
      ...original.brief,
      meeting: { ...original.brief.meeting, title: 'Original staged title' },
    };
    await store.ensureRequested(original);

    const retry = request();
    retry.meeting = { ...retry.meeting, title: 'Retry-only title' };
    retry.brief = {
      ...retry.brief,
      id: 'brief-from-retry',
      meeting: { ...retry.brief.meeting, title: 'Retry-only title' },
    };
    await surface.review(retry);

    const body = postedMessage(slack);
    expect(body.text).toContain('Original staged title');
    expect(body.text).not.toContain('Retry-only title');
    expect(body.blocks[0]?.text?.text).toBe('Original staged title');
  });

  it('bounds Slack blocks and keeps meeting-derived mentions out of mrkdwn', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    const candidate = request();
    const title = `Planning <!channel> <@U123> & review ${'T'.repeat(300)}`;
    const evidence = [{ meeting_id: 'meeting-1', block_id: 'block-1' }];
    const decisions = Array.from({ length: 12 }, (_, index) => ({
      id: `decision-${index}`,
      kind: 'decision' as const,
      text: `Decision ${index} <!channel> <@U123> ${'D'.repeat(300)}`,
      subject: null,
      confidence: null,
      evidence,
      status: 'decided' as const,
    }));
    const actions = Array.from({ length: 12 }, (_, index) => ({
      id: `action-${index}`,
      kind: 'action' as const,
      text: `Action ${index} <!channel> <@U123> ${'A'.repeat(300)}`,
      subject: null,
      confidence: null,
      evidence,
      owner: null,
      due_at: null,
    }));
    candidate.meeting = { ...candidate.meeting, title };
    candidate.decisions = {
      ...candidate.decisions,
      signals: [...decisions, ...actions],
    };
    candidate.brief = {
      ...candidate.brief,
      meeting: { ...candidate.brief.meeting, title },
      decisions,
      actions,
    };

    await surface.review(candidate);

    const body = postedMessage(slack);
    expect(body.text).toContain('&lt;!channel&gt;');
    expect(body.text).toContain('&lt;@U123&gt;');
    expect(body.text).not.toContain('<!channel>');
    const header = body.blocks.find((block) => block.type === 'header');
    expect(header?.text?.type).toBe('plain_text');
    expect([...(header?.text?.text ?? '')]).toHaveLength(150);
    const sections = body.blocks.filter((block) => block.type === 'section');
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.text?.type).toBe('plain_text');
      expect([...(section.text?.text ?? '')].length).toBeLessThanOrEqual(3_000);
    }
    const mrkdwn = body.blocks.flatMap((block) => [
      ...(block.text?.type === 'mrkdwn' ? [block.text.text] : []),
      ...(block.elements ?? [])
        .filter((element) => element.type === 'mrkdwn')
        .map((element) => element.text),
    ]);
    expect(mrkdwn.join('\n')).not.toContain('<!channel>');
    expect(mrkdwn.join('\n')).not.toContain('<@U123>');
  });

  it('approves on the reviewer reaction and captures the latest thread reason', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER], count: 1 },
    ];
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
    expect(await surface.review(request())).toMatchObject({
      status: 'pending',
    });
  });

  it('ignores reactions from users outside the reviewer allowlist', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    slack.reactions = [
      { name: 'white_check_mark', users: ['UIMPOSTOR'], count: 1 },
    ];
    expect(await surface.review(request())).toMatchObject({
      status: 'pending',
    });
  });

  it('stays pending when the reactor roster is incomplete', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    await surface.review(request());

    // Slack may omit reactors from `users` while `count` stays complete;
    // identity can no longer be proven, so nothing may resolve.
    slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER], count: 2 },
    ];
    expect(await surface.review(request())).toMatchObject({
      status: 'pending',
    });
  });

  it('stays pending when either decisive roster is incomplete beside a complete opposite reaction', async () => {
    const cases = [
      [
        { name: 'white_check_mark', users: [REVIEWER], count: 1 },
        { name: 'x', users: [REVIEWER], count: 2 },
      ],
      [
        { name: 'white_check_mark', users: [REVIEWER], count: 2 },
        { name: 'x', users: [REVIEWER], count: 1 },
      ],
    ];
    for (const reactions of cases) {
      const slack = fakeSlack();
      const { surface, store } = build(slack);
      await surface.review(request());
      slack.reactions = reactions;

      expect(await surface.review(request())).toMatchObject({
        status: 'pending',
      });
      expect((await store.list())[0]?.status).toBe('pending');
      expect(
        slack.calls.filter((call) => call === 'conversations.replies'),
      ).toHaveLength(0);
    }
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
    slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER], count: 1 },
    ];
    // Resolve after Slack observes the reaction but before it can append its
    // own resolution, exercising the actual cross-surface race path.
    slack.beforeReplies = async () => {
      await store.resolve({
        approvalId: decisionApprovalId(request().processing_key),
        status: 'rejected',
        reviewedBy: 'operator',
        reason: 'cli wins',
        surface: 'cli',
      });
    };
    const decision = await surface.review(request());
    expect(decision).toMatchObject({
      status: 'rejected',
      reviewed_by: 'operator',
      reason: 'cli wins',
    });
    // Slack reached the resolution race after reading the thread, then
    // reported the durable CLI winner.
    expect(
      slack.calls.filter((call) => call === 'conversations.replies'),
    ).toHaveLength(1);
  });

  it('validates its configuration strictly', () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    const valid = surfaceConfig();
    expect(surface.validateConfig(valid).ok).toBe(true);

    const failures: Array<
      [Partial<AdapterConfig> | Record<string, unknown>, RegExp]
    > = [
      [{ credential_ref: undefined }, /credential_ref is required/],
      [{ credential_ref: 'keychain:slack' }, /env: reference/],
      [
        { settings: { ...valid.settings, extra: true } },
        /settings.extra is not supported/,
      ],
      [
        {
          settings: {
            ...valid.settings,
            base_url: 'https://credential-exfiltration.invalid',
          },
        },
        /settings.base_url is not supported/,
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
      const result = surface.validateConfig({
        ...valid,
        ...override,
      } as AdapterConfig);
      expect(result.ok).toBe(false);
      expect(result.errors.join('; ')).toMatch(expected);
    }
  });
});
