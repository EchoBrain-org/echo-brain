import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AdapterConfig,
  ApprovalRequest,
  JsonObject,
} from '@echo-brain/organization-authority/processing/core/index.js';
import {
  createSlackReactionsApprovalSurface,
  type ApprovalActionAuthorizationResult,
  type ApprovalActionAuthorizer,
  type ApprovalDecisionStore,
  type ApprovalDecisionStoreView,
  type FrozenSlackApprovalPresentationContract,
  type ReviewerApprovalActionAuthorizationRequest,
  type ReviewerApprovalActionAuthorizer,
  type ReviewerApprovalPresentationRenderer,
} from '@echo-brain/organization-authority/processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import {
  assertReviewerDisplayName,
  validateReviewerAuthorizationEvidence,
} from '@echo-brain/organization-authority/processing/authorization/reviewer-authorization-evidence.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
/**
 * The product-composed adapter takes the renderer as an injected port and
 * never imports a protocol package, so this suite supplies a deterministic
 * stand-in with the same closed shape. That the production renderer and the
 * Authority's independent reconstruction agree on both digests is proved by
 * `tests/integration/reviewer-restricted-presentation-agreement.test.ts`.
 */
const CONSEQUENCE_TEXT =
  'Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.';

function stubFingerprint(token: string): string {
  return `sha256:${createHash('sha256')
    .update(`slack-credential-fingerprint-v1:${token}`)
    .digest('hex')}`;
}

const stubRenderer: ReviewerApprovalPresentationRenderer = {
  render(input) {
    const items = (
      input.brief as unknown as {
        decisions: { id: string; kind: string; text: string }[];
      }
    ).decisions;
    const rendered = items.map((item) => ({
      digest: createHash('sha256').update(item.id).digest('hex'),
      line: `${item.kind}: ${item.text}`,
      text: item.text,
      kind: item.kind,
    }));
    const title =
      (input.brief as unknown as { meeting: { title?: string; id: string } })
        .meeting.title ??
      (input.brief as unknown as { meeting: { id: string } }).meeting.id;
    const blocks = [
      {
        type: 'header',
        block_id: `echo-approval-${input.approvalId}-title-v1`,
        text: { type: 'plain_text', text: title, emoji: false },
      },
      ...rendered.map((item, index) => ({
        type: 'section',
        block_id: `echo-approval-${input.approvalId}-item-${index}-${item.digest}-v1`,
        text: { type: 'plain_text', text: item.line, emoji: false },
      })),
      {
        type: 'section',
        block_id: `echo-approval-${input.approvalId}-reviewer-policy-v1`,
        text: { type: 'plain_text', text: CONSEQUENCE_TEXT, emoji: false },
      },
      {
        type: 'context',
        block_id: `echo-approval-${input.approvalId}-reaction-v1`,
        elements: [
          {
            type: 'mrkdwn',
            text: `React :${input.approveReaction}: to approve or :${input.rejectReaction}: to reject. To record a reason, reply in this thread *before* reacting.`,
            verbatim: false,
          },
        ],
      },
    ];
    const text = [
      'Decision brief awaiting approval.',
      `Title: ${title}`,
      ...rendered.map((item) => item.line),
      CONSEQUENCE_TEXT,
      `React :${input.approveReaction}: to approve or :${input.rejectReaction}: to reject. To record a reason, reply in this thread before reacting.`,
    ].join('\n');
    return {
      text,
      blocks,
      reviewer_release_draft_sha256: `sha256:${createHash('sha256')
        .update(JSON.stringify([input.approvalId, title, rendered]))
        .digest('hex')}`,
      approval_presentation_sha256: `sha256:${createHash('sha256')
        .update(JSON.stringify([text, blocks]))
        .digest('hex')}`,
    };
  },
  credentialFingerprint: stubFingerprint,
};

/**
 * The local half of the reviewer approval proof: the exact card is frozen
 * before any Slack request, posted with `mrkdwn: false` under strict
 * acknowledgement, and every later retry, poll, and action request reads the
 * frozen contract instead of current configuration.
 */

const REVIEWER_USER = 'U012REVIEWER';
const EVALUATED_AT = '2026-08-11T12:00:00.000Z';

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

class ReviewerDecisionStore implements ApprovalDecisionStore {
  private view: ApprovalDecisionStoreView | undefined;
  private processingKey = '';
  private contract: FrozenSlackApprovalPresentationContract | null = null;
  readonly resolutions: Array<
    Parameters<ApprovalDecisionStore['resolve']>[0]
  > = [];
  readonly freezes: FrozenSlackApprovalPresentationContract[] = [];

  async ensureRequested(
    candidate: ApprovalRequest,
  ): Promise<ApprovalDecisionStoreView> {
    if (this.view === undefined) {
      this.processingKey = candidate.processing_key;
      this.view = {
        approval_id: approvalId(candidate.processing_key),
        status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        reason: null,
        brief: candidate.brief,
        published: [],
      };
    }
    return this.view;
  }

  async recordPublished(input: {
    processingKey: string;
    surface: string;
    reference: JsonObject;
  }): Promise<ApprovalDecisionStoreView> {
    const current = this.required();
    if (current.published.some((entry) => entry.surface === input.surface)) {
      return current;
    }
    this.view = {
      ...current,
      published: [
        ...current.published,
        { surface: input.surface, reference: input.reference },
      ],
    };
    return this.view;
  }

  async resolve(
    input: Parameters<ApprovalDecisionStore['resolve']>[0],
  ): Promise<ApprovalDecisionStoreView> {
    this.resolutions.push(input);
    const current = this.required();
    if (current.status !== 'pending') return current;
    this.view = {
      ...current,
      status: input.status,
      reviewed_at: input.reviewedAt ?? '2026-08-11T13:00:00.000Z',
      reviewed_by: input.reviewedBy,
      reason: input.reason ?? null,
    };
    return this.view;
  }

  async freezeApprovalPresentationContract(input: {
    approvalId: string;
    contract: FrozenSlackApprovalPresentationContract;
  }): Promise<FrozenSlackApprovalPresentationContract> {
    if (this.contract !== null) {
      if (
        JSON.stringify(this.contract) !== JSON.stringify(input.contract)
      ) {
        throw new Error(
          'decision node already froze a different approval presentation contract',
        );
      }
      return this.contract;
    }
    this.contract = input.contract;
    this.freezes.push(input.contract);
    return input.contract;
  }

  readApprovalPresentationContract(): FrozenSlackApprovalPresentationContract | null {
    return this.contract;
  }

  /** Simulates a slot frozen under an older configuration. */
  seedContract(contract: FrozenSlackApprovalPresentationContract): void {
    this.contract = contract;
  }

  private required(): ApprovalDecisionStoreView {
    if (this.view === undefined) throw new Error('approval was not requested');
    void this.processingKey;
    return this.view;
  }
}

interface FakeSlack {
  fetchImpl: typeof fetch;
  postBodies: Array<Record<string, unknown>>;
  reactions: Array<{ name: string; users: string[]; count: number }>;
  storedText: string | undefined;
  storedBlocks: readonly unknown[] | undefined;
  storeBlocks: (
    blocks: readonly unknown[],
  ) => readonly unknown[] | undefined;
  failReactionsWith?: number;
}

function fakeSlack(): FakeSlack {
  const state: FakeSlack = {
    postBodies: [],
    reactions: [],
    storedText: undefined,
    storedBlocks: undefined,
    storeBlocks: (blocks) => blocks,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.split('/').pop()!.split('?')[0]!;
      const json = (body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json', ...headers },
        });
      if (method === 'auth.test') {
        return json(
          {
            ok: true,
            team_id: 'T012ABCDEF',
            enterprise_id: null,
            user_id: 'U012BOTUSER',
            bot_id: 'B012BOTID',
          },
          { 'x-oauth-scopes': 'chat:write,users:read' },
        );
      }
      if (method === 'bots.info') {
        return json({
          ok: true,
          bot: {
            id: 'B012BOTID',
            user_id: 'U012BOTUSER',
            app_id: 'A012APPID',
            deleted: false,
          },
        });
      }
      if (method === 'chat.postMessage') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        state.postBodies.push(body);
        state.storedText = String(body['text']);
        state.storedBlocks = state.storeBlocks(
          body['blocks'] as readonly unknown[],
        );
        return json({
          ok: true,
          channel: 'C012CHANNEL',
          ts: '1700.100000',
        });
      }
      if (method === 'reactions.get') {
        if (state.failReactionsWith !== undefined) {
          return new Response('slow down', { status: state.failReactionsWith });
        }
        return json({
          ok: true,
          message: {
            ts: '1700.100000',
            ...(state.storedText === undefined
              ? {}
              : { text: state.storedText }),
            ...(state.storedBlocks === undefined
              ? {}
              : { blocks: state.storedBlocks }),
            reactions: state.reactions,
          },
        });
      }
      if (method === 'conversations.replies') {
        return json({
          ok: true,
          messages: [{ ts: '1700.100000', user: 'U012BOTUSER', text: 'card' }],
        });
      }
      return json({ ok: false, error: 'unknown_method' });
    }) as typeof fetch,
  };
  return state;
}

function surfaceWithStore(
  slack: FakeSlack,
  store: ApprovalDecisionStore,
): ReturnType<typeof createSlackReactionsApprovalSurface> {
  return createSlackReactionsApprovalSurface(surfaceConfig(), {
    store,
    approvalActionAuthorizer: {
      authorize: async () => {
        throw new Error('unexpected legacy authorization');
      },
    },
    reviewerApprovalActionAuthorizer: {
      authorizeReviewerApproval: async () => {
        throw new Error('unexpected reviewer authorization');
      },
    },
    reviewerAuthorizationEvidenceValidator:
      validateReviewerAuthorizationEvidence,
    reviewerDisplayNameValidator: assertReviewerDisplayName,
    reviewerPresentationRenderer: stubRenderer,
    environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
    now: () => '2026-08-11T13:00:00.000Z',
    fetchImpl: slack.fetchImpl,
  });
}

function surfaceConfig(
  settings: Record<string, unknown> = {},
): AdapterConfig {
  return {
    kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    instance_id: 'default',
    credential_ref: 'env:SLACK_BOT_TOKEN',
    settings: {
      channel_id: 'C012CHANNEL',
      reviewer: { slack_user_id: REVIEWER_USER, name: 'Reviewer One' },
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      presentation_mode: 'restricted-reviewer-v1',
      ...settings,
    },
  } as unknown as AdapterConfig;
}

function request(): ApprovalRequest {
  const brief = {
    schema_version: 1,
    id: 'brief-1',
    meeting: {
      id: 'meeting-1',
      title: 'Pricing review',
      participants: [],
    },
    decisions: [
      {
        id: 'signal-decision-1',
        kind: 'decision',
        text: 'Ship the reviewer pilot on the eleventh.',
        subject: null,
        confidence: null,
        evidence: [{ meeting_id: 'meeting-1', block_id: 'block-1' }],
        status: 'decided',
      },
    ],
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
      generated_at: '2026-08-11T10:30:00.000Z',
    },
  };
  return {
    processing_key: 'source:instance:item:revision:processor:instance:version',
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Pricing review',
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
        observed_at: '2026-08-11T10:15:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-11T10:15:00.000Z',
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
      generated_at: '2026-08-11T10:30:00.000Z',
      signals: [],
    },
    brief,
  } as unknown as ApprovalRequest;
}

function reviewerEvidence(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 2,
    kind: 'echo-organization-authorization-evidence',
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    approval_id: approvalId(request().processing_key),
    action: 'approve',
    request_sha256: digest('2'),
    provider_event_sha256: digest('3'),
    allowed: true,
    reason_code: 'active_reviewer_restricted_notice_v1',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
    permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
    evaluated_at: EVALUATED_AT,
    authorization_audit_event_id: 'aud_00000000-0000-4000-8000-000000000001',
    authorization_audit_entry_sha256: digest('4'),
    reviewer_release_draft_sha256: digest('5'),
    approval_presentation_sha256: digest('6'),
    semantic_intent_sha256: digest('7'),
    message_presentation_sha256: digest('8'),
    ...overrides,
  };
}

interface Harness {
  slack: FakeSlack;
  store: ReviewerDecisionStore;
  reviewerRequests: ReviewerApprovalActionAuthorizationRequest[];
  legacyRequests: Parameters<ApprovalActionAuthorizer['authorize']>[0][];
  surface: ReturnType<typeof createSlackReactionsApprovalSurface>;
}

function harness(options: {
  config?: AdapterConfig;
  environment?: NodeJS.ProcessEnv;
  reviewerResult?: ApprovalActionAuthorizationResult;
  legacyResult?: ApprovalActionAuthorizationResult;
  renderer?: ReviewerApprovalPresentationRenderer;
  store?: ReviewerDecisionStore;
} = {}): Harness {
  const slack = fakeSlack();
  const store = options.store ?? new ReviewerDecisionStore();
  const reviewerRequests: ReviewerApprovalActionAuthorizationRequest[] = [];
  const legacyRequests: Parameters<ApprovalActionAuthorizer['authorize']>[0][] =
    [];
  const reviewerAuthorizer: ReviewerApprovalActionAuthorizer = {
    async authorizeReviewerApproval(input) {
      reviewerRequests.push(input);
      return (
        options.reviewerResult ?? {
          allowed: true,
          reason: 'active reviewer restricted notice v1',
          evidence: reviewerEvidence({
            approval_id: input.approval_id,
            reviewer_release_draft_sha256:
              input.reviewer_release_draft_sha256,
            approval_presentation_sha256:
              input.approval_presentation_sha256,
          }),
        }
      );
    },
  };
  const legacyAuthorizer: ApprovalActionAuthorizer = {
    async authorize(input) {
      legacyRequests.push(input);
      return (
        options.legacyResult ?? {
          allowed: true,
          reason: 'active membership and direct grant',
          evidence: { schema_version: 1, kind: 'legacy' },
        }
      );
    },
  };
  const surface = createSlackReactionsApprovalSurface(
    options.config ?? surfaceConfig(),
    {
      store,
      approvalActionAuthorizer: legacyAuthorizer,
      reviewerApprovalActionAuthorizer: reviewerAuthorizer,
      reviewerAuthorizationEvidenceValidator:
        validateReviewerAuthorizationEvidence,
      reviewerDisplayNameValidator: assertReviewerDisplayName,
      reviewerPresentationRenderer: options.renderer ?? stubRenderer,
      environment: options.environment ?? { SLACK_BOT_TOKEN: 'xoxb-test' },
      now: () => '2026-08-11T13:00:00.000Z',
      fetchImpl: slack.fetchImpl,
    },
  );
  return { slack, store, reviewerRequests, legacyRequests, surface };
}

describe('slack reviewer publication', () => {
  it('recovers an identified post from a real store after restart without reposting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-reviewer-restart-'));
    try {
      const slack = fakeSlack();
      slack.failReactionsWith = 500;
      const firstStore = new DecisionNodeStore(root, {
        now: () => '2026-08-11T13:00:00.000Z',
      });
      await expect(
        surfaceWithStore(slack, firstStore).review(request()),
      ).rejects.toMatchObject({
        code: 'temporarily_unavailable',
        retryable: true,
      });
      const [interrupted] = await firstStore.list();
      expect(interrupted?.published).toMatchObject([
        {
          surface: 'slack-authority-v1-posted',
          reference: {
            channel_id: 'C012CHANNEL',
            message_ts: '1700.100000',
          },
        },
      ]);

      slack.failReactionsWith = undefined;
      const restartedStore = new DecisionNodeStore(root, {
        now: () => '2026-08-11T13:00:00.000Z',
      });
      await expect(
        surfaceWithStore(slack, restartedStore).review(request()),
      ).resolves.toMatchObject({ status: 'pending' });
      const [recovered] = await restartedStore.list();
      const posted = recovered?.published.find(
        (entry) => entry.surface === 'slack-authority-v1-posted',
      );
      const authority = recovered?.published.find(
        (entry) => entry.surface === 'slack-authority-v1',
      );
      expect(authority?.reference).toEqual(posted?.reference);
      expect(slack.postBodies).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('freezes the contract before posting and sends the exact closed card', async () => {
    const test = harness();
    test.slack.reactions = [];
    await test.surface.review(request());

    // The slot is frozen before any Slack request.
    expect(test.store.freezes).toHaveLength(1);
    const contract = test.store.freezes[0] as FrozenSlackApprovalPresentationContract;
    expect(contract.mode).toBe('restricted-reviewer-v1');
    expect(contract.credential_fingerprint_sha256).toBe(
      stubFingerprint('xoxb-test'),
    );

    const body = test.slack.postBodies[0] as Record<string, unknown>;
    expect(body['mrkdwn']).toBe(false);
    expect(body['unfurl_links']).toBe(false);
    expect(body['unfurl_media']).toBe(false);
    expect(body['channel']).toBe('C012CHANNEL');
    const blocks = body['blocks'] as { block_id: string; type: string }[];
    const id = approvalId(request().processing_key);
    expect(blocks.map((block) => block.block_id)).toEqual([
      `echo-approval-${id}-title-v1`,
      blocks[1]?.block_id,
      `echo-approval-${id}-reviewer-policy-v1`,
      `echo-approval-${id}-reaction-v1`,
    ]);
    expect(blocks[1]?.block_id).toMatch(
      new RegExp(`^echo-approval-${id}-item-0-[0-9a-f]{64}-v1$`),
    );
    expect(String(body['text'])).toContain(
      'Only you, the approving reviewer, may later read its decisions',
    );
    // The card carries no token bytes and the slot stores only a reference.
    expect(JSON.stringify(contract)).not.toContain('xoxb-test');
  });

  it('refuses to publish when Slack stores a different card', async () => {
    const test = harness();
    test.slack.storeBlocks = (blocks) => blocks.slice(0, 1);
    await expect(test.surface.review(request())).rejects.toThrow(
      /stored approval presentation does not match its frozen card/,
    );
  });

  it('reuses the frozen contract across a retry instead of reposting a new card', async () => {
    const test = harness();
    await test.surface.review(request());
    await test.surface.review(request());
    expect(test.store.freezes).toHaveLength(1);
    expect(test.slack.postBodies).toHaveLength(1);
  });

  it('routes an approve reaction through the schema-v2 reviewer authorizer', async () => {
    const test = harness();
    test.slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER_USER], count: 1 },
    ];
    const decision = await test.surface.review(request());
    expect(decision.status).toBe('approved');
    expect(test.legacyRequests).toHaveLength(0);
    expect(test.reviewerRequests).toHaveLength(1);
    const authorized = test.reviewerRequests[0] as ReviewerApprovalActionAuthorizationRequest;
    expect(authorized.approve_reaction).toBe('white_check_mark');
    expect(authorized.reject_reaction).toBe('x');
    const contract = test.store.freezes[0] as FrozenSlackApprovalPresentationContract;
    expect(authorized.reviewer_release_draft_sha256).toBe(
      contract.reviewer_release_draft_sha256,
    );
    expect(authorized.approval_presentation_sha256).toBe(
      contract.approval_presentation_sha256,
    );

    // The resolution is reviewer-surfaced, carries exactly the evidence, and
    // records the Authority transaction time rather than the local clock.
    const resolution = test.store.resolutions[0];
    expect(resolution?.surface).toBe('slack-reviewer-v1');
    expect(resolution?.reviewedAt).toBe(EVALUATED_AT);
    expect(Object.keys(resolution?.metadata ?? {})).toEqual(['authorization']);
  });

  it.each([
    ['schema-v1 evidence', { schema_version: 1, kind: 'legacy' }],
    [
      'partial schema-v2 evidence',
      { schema_version: 2, evaluated_at: EVALUATED_AT },
    ],
    [
      'evidence for another approval',
      reviewerEvidence({ approval_id: 'f'.repeat(64) }),
    ],
  ])('never downgrades reviewer approval with %s', async (_label, evidence) => {
    const test = harness({
      reviewerResult: {
        allowed: true,
        reason: 'malformed reviewer proof',
        evidence: evidence as JsonObject,
      },
    });
    test.slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER_USER], count: 1 },
    ];
    await expect(test.surface.review(request())).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    });
    expect(test.store.resolutions).toHaveLength(0);
    expect(test.legacyRequests).toHaveLength(0);
  });

  it('routes a reject reaction through the unchanged schema-v1 path with the frozen reaction', async () => {
    const test = harness();
    test.slack.reactions = [{ name: 'x', users: [REVIEWER_USER], count: 1 }];
    const decision = await test.surface.review(request());
    expect(decision.status).toBe('rejected');
    expect(test.reviewerRequests).toHaveLength(0);
    expect(test.legacyRequests).toHaveLength(1);
    const authorized = test.legacyRequests[0];
    expect(authorized?.action).toBe('reject');
    // Taken from the stored contract, never the current local setting.
    expect(authorized?.reaction_name).toBe('x');
    const resolution = test.store.resolutions[0];
    expect(resolution?.surface).toBe('slack');
    expect(resolution?.reviewedAt).toBeUndefined();
    expect(Object.keys(resolution?.metadata ?? {}).sort()).toEqual([
      'authorization',
      'slack',
    ]);
  });

  it('uses the frozen reaction pair after an in-place configuration rotation', async () => {
    const store = new ReviewerDecisionStore();
    const first = harness({ store });
    await first.surface.review(request());
    const frozen = store.freezes[0] as FrozenSlackApprovalPresentationContract;

    const rotated = harness({
      store,
      config: surfaceConfig({
        approve_reaction: 'heavy_check_mark',
        reject_reaction: 'no_entry',
      }),
    });
    // The reviewer reacted with the frozen approve reaction, not the new one.
    rotated.slack.reactions = [
      { name: 'white_check_mark', users: [REVIEWER_USER], count: 1 },
    ];
    const decision = await rotated.surface.review(request());
    expect(decision.status).toBe('approved');
    const authorized = rotated
      .reviewerRequests[0] as ReviewerApprovalActionAuthorizationRequest;
    expect(authorized.approve_reaction).toBe(frozen.approve_reaction);
    expect(authorized.reject_reaction).toBe(frozen.reject_reaction);
  });

  it('fails closed when the credential value rotated in place', async () => {
    const store = new ReviewerDecisionStore();
    const first = harness({ store });
    await first.surface.review(request());
    const rotated = harness({
      store,
      environment: { SLACK_BOT_TOKEN: 'xoxb-rotated' },
    });
    await expect(rotated.surface.review(request())).rejects.toThrow(
      /credential value was rotated in place/,
    );
  });

  it('fails closed when the frozen adapter identity or channel changed', async () => {
    const store = new ReviewerDecisionStore();
    await harness({ store }).surface.review(request());
    const frozen = store.freezes[0] as FrozenSlackApprovalPresentationContract;
    store.seedContract({ ...frozen, adapter_instance_id: 'second' });
    await expect(harness({ store }).surface.review(request())).rejects.toThrow(
      /frozen under a different adapter identity/,
    );
    store.seedContract({ ...frozen, credential_ref: 'env:OTHER' });
    await expect(harness({ store }).surface.review(request())).rejects.toThrow(
      /frozen against a different credential reference/,
    );
  });

  it('fails closed when the requested brief no longer reprojects to the frozen digests', async () => {
    const store = new ReviewerDecisionStore();
    await harness({ store }).surface.review(request());
    const frozen = store.freezes[0] as FrozenSlackApprovalPresentationContract;
    store.seedContract({
      ...frozen,
      reviewer_release_draft_sha256: digest('f'),
    });
    await expect(harness({ store }).surface.review(request())).rejects.toThrow(
      /no longer reprojects to its frozen presentation digests/,
    );
  });

  it('never grants a reviewer contract to an already-published card', async () => {
    const store = new ReviewerDecisionStore();
    // A card published before reviewer mode was enabled: the publication slot
    // exists, but no reviewer contract was ever frozen.
    await store.ensureRequested(request());
    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C012CHANNEL', message_ts: '1700.100000' },
    });
    const test = harness({ store });
    await expect(test.surface.review(request())).rejects.toThrow(
      /published without a reviewer presentation contract/,
    );
    expect(store.freezes).toHaveLength(0);
  });

  it('leaves the schema-v1 publication bytes unchanged', async () => {
    const slack = fakeSlack();
    const store = new ReviewerDecisionStore();
    const ordinary = createSlackReactionsApprovalSurface(
      {
        kind: 'approval-surface',
        adapter_id: 'slack-reactions',
        instance_id: 'default',
        credential_ref: 'env:SLACK_BOT_TOKEN',
        settings: {
          channel_id: 'C012CHANNEL',
          reviewer: { slack_user_id: REVIEWER_USER, name: 'Reviewer One' },
          approve_reaction: 'white_check_mark',
          reject_reaction: 'x',
        },
      } as unknown as AdapterConfig,
      {
        store,
        environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
        now: () => '2026-08-11T13:00:00.000Z',
        fetchImpl: slack.fetchImpl,
      },
    );
    await ordinary.review(request());
    const body = slack.postBodies[0] as Record<string, unknown>;
    // `mrkdwn` is an explicit reviewer-only input: the landed path must not
    // start sending a field it never sent.
    expect(Object.hasOwn(body, 'mrkdwn')).toBe(false);
    expect(store.freezes).toHaveLength(0);
  });

  it('refuses reviewer mode without its injected ports or beside the pilot notice', () => {
    const slack = fakeSlack();
    const withoutPorts = createSlackReactionsApprovalSurface(surfaceConfig(), {
      store: new ReviewerDecisionStore(),
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
      fetchImpl: slack.fetchImpl,
    });
    const verdict = withoutPorts.validateConfig(surfaceConfig());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain(
      'requires an injected reviewer presentation renderer',
    );
    expect(verdict.errors.join(' ')).toContain(
      'requires an injected reviewer approval authorizer',
    );

    const both = harness().surface.validateConfig(
      surfaceConfig({
        permission_pilot_presentation: {
          schema_version: 1,
          kind: 'echo-organization-permission-pilot-presentation',
          policy_id: 'pilot-member-readable-v1',
          presentation_policy_id: 'pilot-two-person-audience-v1',
          audience: [
            {
              membership_id: 'mem_00000000-0000-4000-8000-000000000001',
              label: 'One',
            },
            {
              membership_id: 'mem_00000000-0000-4000-8000-000000000002',
              label: 'Two',
            },
          ],
          notice_text:
            "Approving publishes this organization record's decisions, actions, and rationales to One and Two.",
          fallback_text:
            "Decision brief awaiting approval. Approving publishes this organization record's decisions, actions, and rationales to One and Two.",
        },
      }),
    );
    expect(both.ok).toBe(false);
    expect(both.errors.join(' ')).toContain(
      'excludes settings.permission_pilot_presentation',
    );
  });
});
