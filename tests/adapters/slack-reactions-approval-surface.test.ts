import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AdapterConfig,
  ApprovalRequest,
  JsonObject,
} from '../../src/core/index.js';
import { AdapterError } from '../../src/core/index.js';
import {
  createSlackReactionsApprovalSurface,
  type ApprovalActionAuthorizationRequest,
  type ApprovalActionAuthorizer,
  type ApprovalDecisionStore,
  type ApprovalDecisionStoreView,
  type FrozenSlackApprovalPresentationContract,
  type ReviewerApprovalPresentationRenderer,
} from '../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { adapterConformance } from '../support/adapter-conformance.js';

function decisionApprovalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

class InMemoryApprovalDecisionStore implements ApprovalDecisionStore {
  private readonly byProcessingKey = new Map<
    string,
    ApprovalDecisionStoreView
  >();
  private readonly processingKeyByApprovalId = new Map<string, string>();
  readonly resolutionInputs: Array<
    Parameters<ApprovalDecisionStore['resolve']>[0]
  > = [];
  readonly publicationInputs: Array<
    Parameters<ApprovalDecisionStore['recordPublished']>[0]
  > = [];

  constructor(
    private readonly now: () => string,
    private readonly storedRequestedMetadata?: JsonObject,
  ) {}

  async ensureRequested(
    candidate: ApprovalRequest,
  ): Promise<ApprovalDecisionStoreView> {
    const existing = this.byProcessingKey.get(candidate.processing_key);
    if (existing !== undefined) return existing;
    const view: ApprovalDecisionStoreView = {
      approval_id: decisionApprovalId(candidate.processing_key),
      status: 'pending',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      brief: candidate.brief,
      ...(this.storedRequestedMetadata === undefined
        ? {}
        : { requested_metadata: this.storedRequestedMetadata }),
      published: [],
    };
    this.byProcessingKey.set(candidate.processing_key, view);
    this.processingKeyByApprovalId.set(
      view.approval_id,
      candidate.processing_key,
    );
    return view;
  }

  async recordPublished(input: {
    processingKey: string;
    surface: string;
    reference: JsonObject;
  }): Promise<ApprovalDecisionStoreView> {
    this.publicationInputs.push(input);
    const current = this.requiredByProcessingKey(input.processingKey);
    if (current.published.some((entry) => entry.surface === input.surface)) {
      return current;
    }
    const next = {
      ...current,
      published: [
        ...current.published,
        { surface: input.surface, reference: input.reference },
      ],
    };
    this.byProcessingKey.set(input.processingKey, next);
    return next;
  }

  async resolve(input: {
    approvalId: string;
    status: 'approved' | 'rejected';
    reviewedBy: string;
    reason?: string | null;
    surface: string;
    metadata?: JsonObject;
  }): Promise<ApprovalDecisionStoreView> {
    this.resolutionInputs.push(input);
    const processingKey = this.processingKeyByApprovalId.get(input.approvalId);
    if (processingKey === undefined) throw new Error('unknown approval');
    const current = this.requiredByProcessingKey(processingKey);
    if (current.status !== 'pending') return current;
    const next = {
      ...current,
      status: input.status,
      reviewed_at: this.now(),
      reviewed_by: input.reviewedBy,
      reason: input.reason ?? null,
    } satisfies ApprovalDecisionStoreView;
    this.byProcessingKey.set(processingKey, next);
    return next;
  }

  async list(): Promise<readonly ApprovalDecisionStoreView[]> {
    return [...this.byProcessingKey.values()];
  }

  private requiredByProcessingKey(
    processingKey: string,
  ): ApprovalDecisionStoreView {
    const view = this.byProcessingKey.get(processingKey);
    if (view === undefined) throw new Error('approval was not requested');
    return view;
  }
}

class IdentifiedApprovalDecisionStore extends InMemoryApprovalDecisionStore {
  private contract: FrozenSlackApprovalPresentationContract | null = null;

  async freezeApprovalPresentationContract(input: {
    approvalId: string;
    contract: FrozenSlackApprovalPresentationContract;
  }): Promise<FrozenSlackApprovalPresentationContract> {
    if (this.contract === null) this.contract = input.contract;
    return this.contract;
  }

  readApprovalPresentationContract(): FrozenSlackApprovalPresentationContract | null {
    return this.contract;
  }
}

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
const BOT_IDENTITY = {
  team_id: 'T123',
  enterprise_id: null,
  user_id: 'UBOT1',
  bot_id: 'B123',
  app_id: 'A123',
} as const;
const AUTHORIZATION_EVIDENCE = {
  schema_version: 1,
  kind: 'echo-organization-authorization-evidence',
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
  installation_id: 'ins_00000000-0000-4000-8000-000000000001',
  request_id: 'pcr_00000000-0000-4000-8000-000000000001',
  approval_id: decisionApprovalId(request().processing_key),
  request_sha256: `sha256:${'1'.repeat(64)}`,
  provider_event_sha256: `sha256:${'2'.repeat(64)}`,
  allowed: true,
  reason_code: 'active_membership_and_direct_grant',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
  permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
  evaluated_at: '2026-07-16T20:59:59.000Z',
} satisfies JsonObject;

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

const PILOT_NOTICE =
  "Approving publishes this organization record's decisions, actions, and " +
  'rationales to Audrey and Zhenye.';
const PILOT_FALLBACK = `Decision brief awaiting approval. ${PILOT_NOTICE}`;
const PILOT_PRESENTATION = {
  schema_version: 1,
  kind: 'echo-organization-permission-pilot-presentation',
  policy_id: 'pilot-member-readable-v1',
  presentation_policy_id: 'pilot-two-person-audience-v1',
  audience: [
    {
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      label: 'Audrey',
    },
    {
      membership_id: 'mem_00000000-0000-4000-8000-000000000002',
      label: 'Zhenye',
    },
  ],
  notice_text: PILOT_NOTICE,
  fallback_text: PILOT_FALLBACK,
} as const;

function pilotSurfaceConfig(): AdapterConfig {
  const config = surfaceConfig();
  return {
    ...config,
    settings: {
      ...config.settings,
      permission_pilot_presentation: {
        ...PILOT_PRESENTATION,
        audience: PILOT_PRESENTATION.audience.map((member) => ({ ...member })),
      },
    },
  };
}

function reviewerSurfaceConfig(): AdapterConfig {
  return {
    ...surfaceConfig(),
    settings: {
      ...surfaceConfig().settings,
      presentation_mode: 'restricted-reviewer-v1',
    },
  };
}

const IDENTIFIED_RENDERER: ReviewerApprovalPresentationRenderer = {
  render() {
    return {
      text: 'Decision brief awaiting approval.\nReview the stored card.',
      blocks: [{ type: 'context', block_id: 'exact-card', elements: [] }],
      reviewer_release_draft_sha256: `sha256:${'a'.repeat(64)}`,
      approval_presentation_sha256: `sha256:${'b'.repeat(64)}`,
    };
  },
  credentialFingerprint: () => `sha256:${'c'.repeat(64)}`,
};

interface FakeSlack {
  fetchImpl: typeof fetch;
  calls: string[];
  postBodies: Array<Record<string, unknown>>;
  reactions: Array<{ name: string; users: string[]; count: number }>;
  replies: Array<{
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
  }>;
  failReactionsWith?: number;
  beforeReplies?: () => void | Promise<void>;
  acknowledgeBlocks?: (
    blocks: readonly unknown[],
  ) => readonly unknown[] | undefined;
  acknowledgedBlocks?: readonly unknown[];
  storedText?: unknown;
  storedBlocks?: unknown;
  storedMessageOverride?: Record<string, unknown>;
  storedMessageOverridesByTimestamp?: Record<string, Record<string, unknown>>;
  authIdentities?: Array<{
    team_id: string;
    enterprise_id: string | null;
    user_id: string;
    bot_id: string | null;
    app_id: string | null;
  }>;
}

interface PostedTextObject {
  type: string;
  text: string;
  verbatim?: boolean;
}

interface PostedBlock {
  type: string;
  block_id?: string;
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
    acknowledgeBlocks: (blocks) => blocks,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.split('/').pop()!.split('?')[0]!;
      state.calls.push(method);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'auth.test') {
        const identity = state.authIdentities?.shift();
        return json({ ok: true, ...(identity ?? { user_id: 'B1' }) });
      }
      if (method === 'chat.postMessage') {
        if (typeof init?.body !== 'string') {
          throw new Error('expected chat.postMessage JSON body');
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        state.postBodies.push(body);
        const requestedBlocks = body['blocks'];
        if (!Array.isArray(requestedBlocks)) {
          throw new Error('expected chat.postMessage blocks');
        }
        state.acknowledgedBlocks = state.acknowledgeBlocks?.(requestedBlocks);
        state.storedText = body['text'];
        state.storedBlocks = requestedBlocks;
        return json({
          ok: true,
          channel: 'C123',
          ts: '1700.100000',
          message: {
            ts: '1700.100000',
            text: body['text'],
            ...(state.acknowledgedBlocks === undefined
              ? {}
              : { blocks: state.acknowledgedBlocks }),
          },
        });
      }
      if (method === 'reactions.get') {
        if (state.failReactionsWith !== undefined) {
          return new Response('slow down', { status: state.failReactionsWith });
        }
        const timestamp = new URL(url).searchParams.get('timestamp');
        const timestampOverride =
          timestamp === null
            ? undefined
            : state.storedMessageOverridesByTimestamp?.[timestamp];
        return json({
          ok: true,
          message: {
            ts: timestamp ?? '1700.100000',
            ...(timestampOverride ?? state.storedMessageOverride ?? {
              text: state.storedText,
              blocks: state.storedBlocks,
            }),
            reactions: state.reactions,
          },
        });
      }
      if (method === 'conversations.replies') {
        await state.beforeReplies?.();
        state.beforeReplies = undefined;
        return json({
          ok: true,
          messages: [
            { ts: '1700.100000', user: 'B1', text: 'parent message' },
            ...state.replies,
          ],
        });
      }
      return json({ ok: false, error: 'unknown_method' });
    }) as typeof fetch,
  };
  return state;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function build(
  slack: FakeSlack,
  approvalActionAuthorizer?: ApprovalActionAuthorizer,
  config: AdapterConfig = surfaceConfig(),
) {
  const store = new InMemoryApprovalDecisionStore(
    () => '2026-07-16T21:00:00.000Z',
  );
  const surface = createSlackReactionsApprovalSurface(config, {
    store,
    ...(approvalActionAuthorizer === undefined
      ? {}
      : { approvalActionAuthorizer }),
    environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
    now: () => '2026-07-16T21:00:00.000Z',
    fetchImpl: slack.fetchImpl,
  });
  return { surface, store };
}

function buildIdentifiedReviewer(slack: FakeSlack) {
  const store = new IdentifiedApprovalDecisionStore(
    () => '2026-07-16T21:00:00.000Z',
  );
  const surface = identifiedReviewerSurface(slack, store);
  return { surface, store };
}

function identifiedReviewerSurface(
  slack: FakeSlack,
  store: ApprovalDecisionStore,
) {
  const surface = createSlackReactionsApprovalSurface(reviewerSurfaceConfig(), {
    store,
    approvalActionAuthorizer: {
      authorize: async () => ({
        allowed: true,
        evidence: AUTHORIZATION_EVIDENCE,
      }),
    },
    reviewerApprovalActionAuthorizer: {
      authorizeReviewerApproval: async () => ({
        allowed: true,
        evidence: AUTHORIZATION_EVIDENCE,
      }),
    },
    reviewerAuthorizationEvidenceValidator: (value) => value as JsonObject,
    reviewerDisplayNameValidator: () => undefined,
    reviewerPresentationRenderer: IDENTIFIED_RENDERER,
    environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
    now: () => '2026-07-16T21:00:00.000Z',
    fetchImpl: slack.fetchImpl,
  });
  return surface;
}

function stageSlackAction(
  slack: FakeSlack,
  reaction = 'white_check_mark',
  replies: FakeSlack['replies'] = [],
): void {
  slack.authIdentities = [{ ...BOT_IDENTITY }];
  slack.reactions = [{ name: reaction, users: [REVIEWER], count: 1 }];
  slack.replies = replies;
}

adapterConformance({
  name: 'Slack reactions approval surface',
  kind: 'approval-surface',
  create: () => build(fakeSlack()).surface,
  validConfig: surfaceConfig(),
  invalidConfig: {
    adapter_id: 'wrong-adapter',
    instance_id: 'founder',
    credential_ref: 'env:DO_NOT_RENDER',
    settings: surfaceConfig().settings,
  },
});

describe('slack reactions approval surface', () => {
  it('accepts Slack fallback text when storage deterministically folds newlines to spaces', async () => {
    const slack = fakeSlack();
    slack.storedMessageOverride = {
      text: 'Decision brief awaiting approval. Review the stored card.',
      blocks: [{ type: 'context', block_id: 'exact-card', elements: [] }],
    };
    const { surface, store } = buildIdentifiedReviewer(slack);

    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    expect(store.publicationInputs.map((input) => input.surface)).toEqual([
      'slack-authority-v1-posted',
      'slack-authority-v1',
    ]);
    expect(
      slack.calls.filter((call) => call === 'chat.postMessage'),
    ).toHaveLength(1);
  });

  it('resumes an identified reviewer post after a read failure without reposting', async () => {
    const slack = fakeSlack();
    const { surface, store } = buildIdentifiedReviewer(slack);
    slack.failReactionsWith = 500;

    await expect(surface.review(request())).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      retryable: true,
    });
    expect(store.publicationInputs.map((input) => input.surface)).toEqual([
      'slack-authority-v1-posted',
    ]);

    slack.failReactionsWith = undefined;
    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    expect(
      slack.calls.filter((call) => call === 'chat.postMessage'),
    ).toHaveLength(1);
  });

  it('fails closed when the stored identified reviewer card does not match its frozen blocks', async () => {
    const slack = fakeSlack();
    slack.storedMessageOverride = {
      text: 'Decision brief awaiting approval.\nReview the stored card.',
      blocks: [{ type: 'context', block_id: 'mutated-card', elements: [] }],
    };
    const { surface, store } = buildIdentifiedReviewer(slack);

    await expect(surface.review(request())).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });
    expect(store.publicationInputs.map((input) => input.surface)).toEqual([
      'slack-authority-v1-posted',
    ]);
  });

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

  it('marks every Slack request body with its opaque approval ID', async () => {
    const slack = fakeSlack();
    const { surface } = build(slack);

    await surface.review(request());

    expect(postedMessage(slack)).toEqual({
      channel: 'C123',
      text: 'Decision brief awaiting approval: Planning',
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: 'header',
          block_id: `echo-approval-${decisionApprovalId(request().processing_key)}-0`,
          text: { type: 'plain_text', text: 'Planning', emoji: true },
        },
        {
          type: 'context',
          block_id: `echo-approval-${decisionApprovalId(request().processing_key)}-1`,
          elements: [
            {
              type: 'mrkdwn',
              text: 'React :white_check_mark: to approve or :x: to reject. To record a reason, reply in this thread *before* reacting.',
              verbatim: false,
            },
          ],
        },
      ],
    });
  });

  it('renders the exact activation-bound audience notice and accessibility fallback', async () => {
    const slack = fakeSlack();
    const { surface } = build(
      slack,
      {
        authorize: async () => ({
          allowed: true,
          evidence: AUTHORIZATION_EVIDENCE,
        }),
      },
      pilotSurfaceConfig(),
    );

    await surface.review(request());

    expect(postedMessage(slack)).toMatchObject({
      text: PILOT_FALLBACK,
      blocks: [
        {
          type: 'header',
          block_id: `echo-approval-${decisionApprovalId(request().processing_key)}-0`,
        },
        {
          type: 'section',
          block_id: `echo-approval-${decisionApprovalId(request().processing_key)}-audience-v1`,
          text: {
            type: 'plain_text',
            text: PILOT_NOTICE,
            emoji: false,
          },
        },
        {
          type: 'context',
          block_id: `echo-approval-${decisionApprovalId(request().processing_key)}-2`,
        },
      ],
    });
  });

  it('refuses a historical federation request before Slack traffic, publication, or resolution', async () => {
    const slack = fakeSlack();
    const store = new InMemoryApprovalDecisionStore(
      () => '2026-07-16T21:00:00.000Z',
      { federation: null },
    );
    const surface = createSlackReactionsApprovalSurface(surfaceConfig(), {
      store,
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
      fetchImpl: slack.fetchImpl,
    });

    await expect(surface.review(request())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AdapterError &&
        error.code === 'permanently_rejected' &&
        !error.retryable &&
        /retired federation metadata/.test(error.message),
    );
    expect(slack.calls).toEqual([]);
    expect(store.publicationInputs).toEqual([]);
    expect(store.resolutionInputs).toEqual([]);
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
      { user: 'USOMEONE', text: 'not the reviewer', ts: '1700.200000' },
      { user: REVIEWER, text: 'early thought', ts: '1700.300000' },
      { user: REVIEWER, text: 'ship it', ts: '1700.400000' },
    ];
    const decision = await surface.review(request());
    expect(decision).toEqual({
      status: 'approved',
      reviewed_at: '2026-07-16T21:00:00.000Z',
      reviewed_by: 'zhenye',
      reason: 'ship it',
      approved_brief: request().brief,
    });
    expect(slack.calls).not.toContain('auth.test');
  });

  it('authorizes the exact live Slack action before recording the resolution', async () => {
    const slack = fakeSlack();
    const authorizationRequests: ApprovalActionAuthorizationRequest[] = [];
    let decisionStore: InMemoryApprovalDecisionStore;
    const authorizer: ApprovalActionAuthorizer = {
      authorize: async (input) => {
        authorizationRequests.push(input);
        expect((await decisionStore.list())[0]?.status).toBe('pending');
        return { allowed: true, evidence: AUTHORIZATION_EVIDENCE };
      },
    };
    const built = build(slack, authorizer);
    decisionStore = built.store;
    const { surface } = built;
    await surface.review(request());
    stageSlackAction(slack, 'white_check_mark', [
      {
        user: REVIEWER,
        text: 'ship it',
        ts: '1700.400000',
        thread_ts: '1700.100000',
      },
    ]);

    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'approved',
      reason: 'ship it',
    });
    expect(authorizationRequests).toEqual([
      {
        approval_id: decisionApprovalId(request().processing_key),
        action: 'approve',
        adapter_identity: {
          kind: 'approval-surface',
          adapter_id: 'slack-reactions',
          instance_id: 'founder',
          version: '1.0.0',
        },
        provider_identity: {
          provider: 'slack',
          team_id: 'T123',
          enterprise_id: null,
          bot_user_id: 'UBOT1',
          bot_id: 'B123',
          app_id: 'A123',
        },
        actor: {
          provider: 'slack',
          team_id: 'T123',
          user_id: REVIEWER,
        },
        channel_id: 'C123',
        message_ts: '1700.100000',
        reaction_name: 'white_check_mark',
      },
    ]);
    expect(slack.calls.slice(-3)).toEqual([
      'reactions.get',
      'conversations.replies',
      'auth.test',
    ]);
    expect(decisionStore.resolutionInputs[0]?.metadata).toMatchObject({
      authorization: AUTHORIZATION_EVIDENCE,
    });
  });

  it('does not trust a nested chat.postMessage acknowledgement for the legacy authority path', async () => {
    const slack = fakeSlack();
    slack.acknowledgeBlocks = () => undefined;
    const { surface, store } = build(slack, {
      authorize: async () => ({
        allowed: true,
        evidence: AUTHORIZATION_EVIDENCE,
      }),
    });

    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    expect((await store.list())[0]?.published[0]?.surface).toBe(
      'slack-authority-v1',
    );

    slack.acknowledgeBlocks = (blocks) =>
      reverseObjectKeys(blocks) as readonly unknown[];
    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    expect(
      slack.calls.filter((call) => call === 'chat.postMessage'),
    ).toHaveLength(1);
    expect((await store.list())[0]?.published[0]?.surface).toBe(
      'slack-authority-v1',
    );
  });

  it('does not treat a nested chat.postMessage block mutation as stored-card evidence', async () => {
    const slack = fakeSlack();
    slack.acknowledgeBlocks = (blocks) =>
      blocks.map((block, index) =>
        index === 0 ? { ...(block as JsonObject), unexpected: true } : block,
      );
    const { surface, store } = build(slack, {
      authorize: async () => ({
        allowed: true,
        evidence: AUTHORIZATION_EVIDENCE,
      }),
    });

    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    expect((await store.list())[0]?.published[0]?.surface).toBe(
      'slack-authority-v1',
    );
  });

  it('refuses the legacy authority path when the stored card differs from the posted card', async () => {
    const slack = fakeSlack();
    slack.storedMessageOverride = {
      text: 'Decision brief awaiting approval: Planning',
      blocks: [{ type: 'context', block_id: 'mutated-card', elements: [] }],
    };
    const { surface, store } = build(slack, {
      authorize: async () => ({
        allowed: true,
        evidence: AUTHORIZATION_EVIDENCE,
      }),
    });

    await expect(surface.review(request())).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });
    expect((await store.list())[0]?.published).toEqual([]);
  });

  it('verifies a different durable Authority publication winner before polling it', async () => {
    const slack = fakeSlack();
    slack.storedMessageOverridesByTimestamp = {
      '1700.200000': {
        text: 'A different concurrent card',
        blocks: [
          { type: 'context', block_id: 'different-card', elements: [] },
        ],
      },
    };
    const durable = new InMemoryApprovalDecisionStore(
      () => '2026-07-16T21:00:00.000Z',
    );
    let concurrentWinnerInstalled = false;
    const racingStore: ApprovalDecisionStore = {
      ensureRequested: (candidate) => durable.ensureRequested(candidate),
      recordPublished: async (input) => {
        if (
          input.surface === 'slack-authority-v1' &&
          !concurrentWinnerInstalled
        ) {
          concurrentWinnerInstalled = true;
          return await durable.recordPublished({
            ...input,
            reference: {
              channel_id: 'C123',
              message_ts: '1700.200000',
            },
          });
        }
        return await durable.recordPublished(input);
      },
      resolve: (input) => durable.resolve(input),
    };
    const surface = createSlackReactionsApprovalSurface(surfaceConfig(), {
      store: racingStore,
      approvalActionAuthorizer: {
        authorize: async () => ({
          allowed: true,
          evidence: AUTHORIZATION_EVIDENCE,
        }),
      },
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
      now: () => '2026-07-16T21:00:00.000Z',
      fetchImpl: slack.fetchImpl,
    });

    await expect(surface.review(request())).rejects.toMatchObject({
      code: 'permanently_rejected',
      retryable: false,
    });
    expect((await durable.list())[0]?.published).toMatchObject([
      {
        surface: 'slack-authority-v1',
        reference: {
          channel_id: 'C123',
          message_ts: '1700.200000',
        },
      },
    ]);
    // One read verifies our post, then the second verifies the durable winner.
    // A reaction poll would ignore the mismatched card bytes and return pending.
    expect(slack.calls.filter((call) => call === 'reactions.get')).toHaveLength(
      2,
    );
    expect(slack.calls).not.toContain('conversations.replies');
    expect(durable.resolutionInputs).toEqual([]);
  });

  it('reposts and durably supersedes a stored pre-marker Slack publication before centralized authorization', async () => {
    const slack = fakeSlack();
    let authorizationCalls = 0;
    const { surface, store } = build(slack, {
      authorize: async () => {
        authorizationCalls += 1;
        return { allowed: true, evidence: AUTHORIZATION_EVIDENCE };
      },
    });
    await store.ensureRequested(request());
    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: {
        channel_id: 'C123',
        message_ts: '1600.000001',
      },
    });

    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(surface.review(request())).resolves.toMatchObject({
      status: 'pending',
    });

    expect(
      slack.calls.filter((call) => call === 'chat.postMessage'),
    ).toHaveLength(1);
    expect(postedMessage(slack).blocks.map((block) => block.block_id)).toEqual(
      postedMessage(slack).blocks.map(
        (_block, index) =>
          `echo-approval-${decisionApprovalId(request().processing_key)}-${index}`,
      ),
    );
    expect((await store.list())[0]?.published).toEqual([
      {
        surface: 'slack',
        reference: {
          channel_id: 'C123',
          message_ts: '1600.000001',
        },
      },
      {
        surface: 'slack-authority-v1',
        reference: {
          channel_id: 'C123',
          message_ts: '1700.100000',
        },
      },
    ]);
    // One read verifies the stored replacement before publication; the two
    // polls would reject if either review selected the legacy reference.
    expect(slack.calls.filter((call) => call === 'reactions.get')).toHaveLength(
      3,
    );
    expect(authorizationCalls).toBe(0);
  });

  it.each([
    {
      condition: 'denies the action',
      reaction: 'x',
      authorize: async () => ({
        allowed: false as const,
        reason: 'membership revoked',
      }),
      code: 'unauthorized',
      retryable: false,
      message: /membership revoked/,
    },
    {
      condition: 'is unavailable',
      reaction: 'white_check_mark',
      authorize: async () => {
        throw new Error('control plane offline');
      },
      code: 'temporarily_unavailable',
      retryable: true,
      message: /authorization failed: control plane offline/,
    },
  ] as const)(
    'fails closed without resolving when centralized authorization $condition',
    async ({ authorize, reaction, code, retryable, message }) => {
      const slack = fakeSlack();
      const { surface, store } = build(slack, { authorize });
      await surface.review(request());
      stageSlackAction(slack, reaction);

      await expect(surface.review(request())).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AdapterError &&
          error.code === code &&
          error.retryable === retryable &&
          message.test(error.message),
      );
      expect((await store.list())[0]?.status).toBe('pending');
    },
  );

  it('keeps the decision pending when its operation is cancelled during authorization', async () => {
    const slack = fakeSlack();
    const cancellation = new AbortController();
    const { surface, store } = build(slack, {
      authorize: async (_request, signal) => {
        expect(signal).toBe(cancellation.signal);
        cancellation.abort();
        return { allowed: true, evidence: AUTHORIZATION_EVIDENCE };
      },
    });
    await surface.review(request());
    stageSlackAction(slack);

    await expect(
      surface.review(request(), { signal: cancellation.signal }),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect((await store.list())[0]?.status).toBe('pending');
  });

  it.each([
    [
      'reaction',
      (slack: FakeSlack) => {
        slack.reactions = [
          { name: 'white_check_mark', users: [42], count: 1 },
        ] as unknown as FakeSlack['reactions'];
      },
    ],
    [
      'reply',
      (slack: FakeSlack) => {
        stageSlackAction(slack, 'white_check_mark', [
          {
            user: REVIEWER,
            text: 'missing thread identity',
            ts: '1700.400000',
          },
        ]);
      },
    ],
  ] as const)(
    'strictly validates %s evidence when centralized authorization is active',
    async (_kind, arrangeEvidence) => {
      const slack = fakeSlack();
      let authorizationCalls = 0;
      const { surface, store } = build(slack, {
        authorize: async () => {
          authorizationCalls += 1;
          return { allowed: true, evidence: AUTHORIZATION_EVIDENCE };
        },
      });
      await surface.review(request());
      arrangeEvidence(slack);

      await expect(surface.review(request())).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AdapterError &&
          error.code === 'permanently_rejected' &&
          !error.retryable,
      );
      expect(authorizationCalls).toBe(0);
      expect((await store.list())[0]?.status).toBe('pending');
    },
  );

  it('rejects a malformed allow result without evidence before resolving', async () => {
    const slack = fakeSlack();
    const { surface, store } = build(slack, {
      authorize: async () =>
        ({ allowed: true }) as Awaited<
          ReturnType<ApprovalActionAuthorizer['authorize']>
        >,
    });
    await surface.review(request());
    stageSlackAction(slack);

    await expect(surface.review(request())).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      retryable: true,
    });
    expect((await store.list())[0]?.status).toBe('pending');
    expect(store.resolutionInputs).toHaveLength(0);
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

  it('surfaces polling failures as retryable adapter errors and leaves the node pending', async () => {
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

    expect((await store.list())[0]?.status).toBe('pending');
    expect(store.resolutionInputs).toEqual([]);
  });

  it('reports a concurrent resolution winner instead of conflicting', async () => {
    const slack = fakeSlack();
    const { surface, store } = build(slack);
    await surface.review(request());
    slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER], count: 1 },
    ];
    // Resolve after this cycle observes the reaction but before it can append
    // its own resolution, exercising the concurrent review race path.
    slack.beforeReplies = async () => {
      await store.resolve({
        approvalId: decisionApprovalId(request().processing_key),
        status: 'rejected',
        reviewedBy: 'earlier review cycle',
        reason: 'earlier cycle wins',
        surface: 'slack',
      });
    };
    const decision = await surface.review(request());
    expect(decision).toMatchObject({
      status: 'rejected',
      reviewed_by: 'earlier review cycle',
      reason: 'earlier cycle wins',
    });
    // The later cycle reached the resolution race after reading the thread,
    // then reported the durable earlier winner.
    expect(
      slack.calls.filter((call) => call === 'conversations.replies'),
    ).toHaveLength(1);
  });

  it('validates its configuration strictly', () => {
    const slack = fakeSlack();
    const { surface } = build(slack);
    const valid = surfaceConfig();
    expect(surface.validateConfig(valid).ok).toBe(true);
    expect(
      surface.validateConfig({
        ...valid,
        credential_ref: 'file:/tmp/slack-token',
      }).ok,
    ).toBe(true);
    expect(surface.validateConfig(pilotSurfaceConfig()).ok).toBe(true);

    const failures: Array<
      [Partial<AdapterConfig> | Record<string, unknown>, RegExp]
    > = [
      [{ credential_ref: undefined }, /credential_ref is required/],
      [{ credential_ref: 'keychain:slack' }, /env: or file: reference/],
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
      [
        { settings: { ...valid.settings, channel_id: 'not-a-channel' } },
        /Slack channel ID/,
      ],
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
      [
        {
          settings: {
            ...valid.settings,
            permission_pilot_presentation: {
              ...PILOT_PRESENTATION,
              fallback_text: `${PILOT_FALLBACK} changed`,
            },
          },
        },
        /exact activation-emitted descriptor/,
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
