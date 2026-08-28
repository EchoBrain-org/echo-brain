import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import {
  CleanSlackApprovalStagerV1,
  SlackWebApiCleanApprovalCardPosterV1,
  type CleanSlackApprovalCardFactoryV1,
  type CleanSlackApprovalCardPosterV1,
} from "../../../src/processing/clean-v1/clean-slack-approval-stager.js";
import type { SqliteCleanLiveOnlySourceStateV1 } from "../../../src/processing/clean-v1/sqlite-live-only-source-state.js";
import type { CleanApprovalStageInputV1 } from "../../../src/processing/clean-v1/live-only-source-cycle.js";
import { SlackApiError } from "../../../src/processing/adapters/shared/slack/slack-web-api-client.js";

const REVIEW_POLICY_FIELDS = {
  review_policy_id: "organization-member-readable-person-v2",
  review_policy_contract_sha256: `sha256:${"1".repeat(64)}`,
  review_policy_consequence_text: "Approving makes this review member-readable.",
  review_policy_consequence_sha256: `sha256:${"2".repeat(64)}`,
};

describe("clean Slack approval supersession", () => {
  it("keeps the earliest recovered post and tombstones every exact duplicate", async () => {
    const updates: unknown[] = [];
    let historyOldest: string | null = null;
    const poster = new SlackWebApiCleanApprovalCardPosterV1("test-token", "C123", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (url, init) => {
        const method = new URL(String(url)).pathname.split("/").at(-1);
        if (method === "auth.test") {
          return new Response(
            JSON.stringify({ ok: true, team_id: "T123", enterprise_id: null, user_id: "U123", bot_id: "B123", app_id: "A123" }),
            { headers: { "x-oauth-scopes": "users:read" } },
          );
        }
        if (method === "bots.info") {
          return new Response(JSON.stringify({ ok: true, bot: { id: "B123", user_id: "U123", app_id: "A123", deleted: false } }));
        }
        if (method === "conversations.history") {
          historyOldest = new URL(String(url)).searchParams.get("oldest");
          return new Response(
            JSON.stringify({
              ok: true,
              has_more: false,
              messages: [
                { ts: "1724292303.999999", text: "card with Slack-normalized links\n\n[approval:apr_old]", bot_id: "B123" },
                { ts: "1724292304.006000", text: "card\n\n[approval:apr_old]", bot_id: "B123" },
              ],
              response_metadata: { next_cursor: "" },
            }),
            { headers: { "x-oauth-scopes": "channels:history" } },
          );
        }
        updates.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1724292304.006000" }));
      },
    });

    await expect(
      poster.reconcile({
        approval_id: "apr_old",
        post_started_at: "2024-08-22T02:05:04.000Z",
      }),
    ).resolves.toEqual({ provider_message_ts: "1724292303.999999" });
    expect(updates).toEqual([
      expect.objectContaining({
        ts: "1724292304.006000",
        text: expect.stringContaining("Duplicate approval card"),
      }),
    ]);
    expect(historyOldest).toBe("1724292004.000000");
  });

  it("retries the exact same static tombstone presentation", async () => {
    const bodies: unknown[] = [];
    const poster = new SlackWebApiCleanApprovalCardPosterV1("test-token", "C123", {
      baseUrl: "https://slack.example.test/api",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, channel: "C123", ts: "123.000001" }),
        );
      },
    });
    const input = {
      approval_id: "apr_old",
      successor_id: "apr_new",
      provider_message_ts: "123.000001",
    };

    await poster.tombstone(input);
    await poster.tombstone(input);

    expect(bodies).toEqual([
      {
        channel: "C123",
        ts: "123.000001",
        text: [
          "Superseded",
          "A newer version of this meeting replaced this review. This card can no longer be approved or rejected.",
          "",
          "[approval:apr_old]",
          "[superseded-by:apr_new]",
        ].join("\n"),
        blocks: [],
        unfurl_links: false,
        unfurl_media: false,
      },
      {
        channel: "C123",
        ts: "123.000001",
        text: [
          "Superseded",
          "A newer version of this meeting replaced this review. This card can no longer be approved or rejected.",
          "",
          "[approval:apr_old]",
          "[superseded-by:apr_new]",
        ].join("\n"),
        blocks: [],
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
  });

  it("does no Slack work when the obsolete card was never posted", async () => {
    const tombstone = vi.fn();
    const authority = {
      listPendingSupersededApprovalCards: () => [],
      recordSupersededApprovalCardTombstoned: vi.fn(),
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      post: vi.fn(),
      reconcile: vi.fn(),
      tombstone,
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {} as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await stager.reconcileSuperseded();

    expect(tombstone).not.toHaveBeenCalled();
  });

  it("tombstones every posted obsolete card", async () => {
    const tombstone = vi.fn().mockResolvedValue(undefined);
    const recorded = vi.fn();
    const authority = {
      listPendingSupersededApprovalCards: () => [
        {
          approval_id: "apr_old_a",
          review_lineage_id: "rli_meeting",
          superseded_by_candidate_id: "cnd_current",
          provider_message_ts: "123.000001",
        },
        {
          approval_id: "apr_old_b",
          review_lineage_id: "rli_meeting",
          superseded_by_candidate_id: "cnd_current",
          provider_message_ts: "123.000002",
        },
      ],
      recordSupersededApprovalCardTombstoned: recorded,
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      post: vi.fn(),
      reconcile: vi.fn(),
      tombstone,
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {} as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await stager.reconcileSuperseded();

    expect(tombstone).toHaveBeenNthCalledWith(
      1,
      {
        approval_id: "apr_old_a",
        successor_id: "cnd_current",
        provider_message_ts: "123.000001",
      },
      undefined,
    );
    expect(tombstone).toHaveBeenNthCalledWith(
      2,
      {
        approval_id: "apr_old_b",
        successor_id: "cnd_current",
        provider_message_ts: "123.000002",
      },
      undefined,
    );
    expect(recorded).toHaveBeenCalledTimes(2);
  });

  it("tombstones the obsolete card before attempting the replacement post", async () => {
    const operations: string[] = [];
    const outbox = {
      ...REVIEW_POLICY_FIELDS,
      candidate_id: "cnd_new",
      candidate_semantic_sha256: `sha256:${"a".repeat(64)}`,
      review_lineage_id: "rli_meeting",
      review_input_sha256: `sha256:${"b".repeat(64)}`,
      review_semantic_sha256: `sha256:${"c".repeat(64)}`,
      disposition: "actionable" as const,
      approval_id: "apr_new",
      stage_command_id: "pas_new",
      state: "queued" as const,
      provider_message_ts: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
      tombstoned_at: null,
    };
    let pending = true;
    const authority = {
      readCandidateByApprovalId: () => outbox,
      prepareApprovalPost: () => ({ outbox: { ...outbox, state: "posting" as const }, created: true }),
      listPendingSupersededApprovalCards: () => pending ? [{
        approval_id: "apr_old",
        review_lineage_id: outbox.review_lineage_id,
        superseded_by_candidate_id: "apr_new",
        provider_message_ts: "123.000001",
      }] : [],
      recordSupersededApprovalCardTombstoned: () => { pending = false; },
      recordDefinitiveApprovalPostFailure: () => {
        operations.push("requeue");
        return outbox;
      },
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      tombstone: async () => {
        operations.push("tombstone");
      },
      reconcile: async () => undefined,
      post: async () => {
        operations.push("post");
        throw new SlackApiError(
          "rate_limited",
          "Slack post is rate limited",
          true,
        );
      },
    };
    const cardFactory = {
      build: () => {
        operations.push("build");
        return {
          text: "replacement",
          frozen_card_sha256: `sha256:${"d".repeat(64)}`,
          approved_snapshot: {},
        };
      },
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      cardFactory as unknown as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await expect(
      stager.stage({ candidate: outbox } as unknown as CleanApprovalStageInputV1),
    ).resolves.toEqual({ kind: "delivery_pending" });
    expect(operations).toEqual(["tombstone", "build", "post", "requeue"]);
  });

  it("drains unrelated deliveries after one post outcome remains unknown", async () => {
    const candidate = (
      suffix: string,
      state: "queued" | "posting",
    ) => ({
      ...REVIEW_POLICY_FIELDS,
      candidate_id: `cnd_${suffix}`,
      candidate_semantic_sha256: `sha256:${suffix.repeat(64)}`,
      review_lineage_id: `rli_${suffix}`,
      review_input_sha256: `sha256:${"b".repeat(64)}`,
      review_semantic_sha256: `sha256:${"c".repeat(64)}`,
      disposition: "actionable" as const,
      approval_id: `apr_${suffix}`,
      stage_command_id: `pas_${suffix}`,
      state,
      provider_message_ts: null,
      frozen_card_sha256:
        state === "posting" ? `sha256:${"d".repeat(64)}` : null,
      approved_snapshot_json: state === "posting" ? "{}" : null,
      approved_snapshot_sha256:
        state === "posting" ? `sha256:${"e".repeat(64)}` : null,
      post_started_at:
        state === "posting" ? "2026-08-22T02:05:04.000Z" : null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
      tombstoned_at: null,
      admission: {},
      meeting: {},
      decisions: {},
      approved_snapshot: state === "posting" ? {} : null,
    });
    const ambiguous = candidate("a", "posting");
    const unrelated = candidate("f", "queued");
    const requeued: string[] = [];
    const authority = {
      listPendingSupersededApprovalCards: () => [],
      listPendingApprovalDeliveries: () => [ambiguous, unrelated],
      readCandidateByApprovalId: (approvalId: string) =>
        approvalId === ambiguous.approval_id ? ambiguous : unrelated,
      prepareApprovalPost: ({ candidate_id }: { candidate_id: string }) =>
        candidate_id === ambiguous.candidate_id
          ? { outbox: ambiguous, created: false }
          : {
              outbox: {
                ...unrelated,
                state: "posting" as const,
                post_started_at: "2026-08-22T02:05:05.000Z",
              },
              created: true,
            },
      recordDefinitiveApprovalPostFailure: (candidateId: string) => {
        requeued.push(candidateId);
        return unrelated;
      },
    };
    const post = vi.fn(async () => {
      throw new SlackApiError("rate_limited", "try later", true);
    });
    const reconcile = vi.fn(async () => undefined);
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {
        build: () => ({
          text: "card",
          frozen_card_sha256: `sha256:${"d".repeat(64)}`,
          approved_snapshot: {},
        }),
      } as unknown as CleanSlackApprovalCardFactoryV1,
      { post, reconcile, tombstone: vi.fn() },
    );

    await expect(stager.reconcilePendingDeliveries()).resolves.toBeUndefined();

    expect(reconcile).toHaveBeenCalledWith(
      {
        approval_id: ambiguous.approval_id,
        post_started_at: ambiguous.post_started_at,
      },
      undefined,
    );
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      { approval_id: unrelated.approval_id, text: "card" },
      undefined,
    );
    expect(requeued).toEqual([unrelated.candidate_id]);
  });

  it("blocks every later revision in a lineage with an ambiguous ancestor post", async () => {
    const base = {
      ...REVIEW_POLICY_FIELDS,
      candidate_semantic_sha256: `sha256:${"a".repeat(64)}`,
      review_input_sha256: `sha256:${"b".repeat(64)}`,
      review_semantic_sha256: `sha256:${"c".repeat(64)}`,
      disposition: "actionable" as const,
      provider_message_ts: null,
      control_approval_sha256: null,
      tombstoned_at: null,
      admission: {},
      meeting: {},
      decisions: {},
      approved_snapshot: null,
    };
    const successor = {
      ...base,
      candidate_id: "cnd_successor",
      review_lineage_id: "rli_blocked",
      approval_id: "apr_successor",
      stage_command_id: "pas_successor",
      state: "queued" as const,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      post_started_at: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
    };
    const unrelated = {
      ...successor,
      candidate_id: "cnd_unrelated",
      review_lineage_id: "rli_unrelated",
      approval_id: "apr_unrelated",
      stage_command_id: "pas_unrelated",
    };
    const predecessor = {
      ...base,
      candidate_id: "cnd_predecessor",
      review_lineage_id: successor.review_lineage_id,
      approval_id: "apr_predecessor",
      stage_command_id: "pas_predecessor",
      state: "superseded" as const,
      frozen_card_sha256: `sha256:${"d".repeat(64)}`,
      approved_snapshot_json: "{}",
      approved_snapshot_sha256: `sha256:${"e".repeat(64)}`,
      post_started_at: "2026-08-22T02:05:04.000Z",
      // A was superseded by B, then the current head C arrived. The fence must
      // follow the lineage rather than stopping at the direct A -> B edge.
      superseded_by_candidate_id: "cnd_intermediate",
      superseded_at: "2026-08-22T02:05:05.000Z",
      approved_snapshot: {},
    };
    const post = vi.fn(async () => {
      throw new SlackApiError("rate_limited", "try later", true);
    });
    const authority = {
      listPendingSupersededApprovalCards: () => [{
        approval_id: predecessor.approval_id,
        review_lineage_id: predecessor.review_lineage_id,
        superseded_by_candidate_id: predecessor.superseded_by_candidate_id,
        provider_message_ts: null,
        post_started_at: predecessor.post_started_at,
      }],
      readFrozenCandidateForApproval: () => predecessor,
      listPendingApprovalDeliveries: () => [successor, unrelated],
      readCandidateByApprovalId: () => unrelated,
      prepareApprovalPost: ({ candidate_id }: { candidate_id: string }) =>
        candidate_id === predecessor.candidate_id
          ? { outbox: predecessor, created: false }
          : {
              outbox: {
                ...unrelated,
                state: "posting" as const,
                post_started_at: "2026-08-22T02:05:06.000Z",
              },
              created: true,
            },
      recordDefinitiveApprovalPostFailure: () => unrelated,
    };
    const reconcile = vi.fn(async () => undefined);
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {
        build: () => ({
          text: "card",
          frozen_card_sha256: `sha256:${"d".repeat(64)}`,
          approved_snapshot: {},
        }),
      } as unknown as CleanSlackApprovalCardFactoryV1,
      { post, reconcile, tombstone: vi.fn() },
    );

    await expect(stager.reconcilePendingDeliveries()).resolves.toBeUndefined();

    expect(reconcile).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      { approval_id: unrelated.approval_id, text: "card" },
      undefined,
    );
  });

  it("retains and tombstones a post that returns after its candidate is superseded", async () => {
    const operations: string[] = [];
    const queued = {
      ...REVIEW_POLICY_FIELDS,
      candidate_id: "cnd_old",
      candidate_semantic_sha256: `sha256:${"a".repeat(64)}`,
      review_lineage_id: "rli_meeting",
      review_input_sha256: `sha256:${"b".repeat(64)}`,
      review_semantic_sha256: `sha256:${"c".repeat(64)}`,
      disposition: "actionable" as const,
      approval_id: "apr_old",
      stage_command_id: "pas_old",
      state: "queued" as const,
      provider_message_ts: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
      tombstoned_at: null,
    };
    let current: Record<string, unknown> = queued;
    const authority = {
      readCandidateByApprovalId: () => current,
      prepareApprovalPost: () => ({ outbox: { ...current, state: "posting" as const }, created: true }),
      recordPostedApprovalCard: (input: {
        readonly provider_message_ts: string;
        readonly frozen_card_sha256: string;
      }) => {
        current = {
          ...current,
          provider_message_ts: input.provider_message_ts,
          frozen_card_sha256: input.frozen_card_sha256,
          approved_snapshot_json: "{}",
          approved_snapshot_sha256: `sha256:${"e".repeat(64)}`,
        };
        return current;
      },
      listPendingSupersededApprovalCards: () =>
        current.state === "superseded" &&
        current.provider_message_ts !== null &&
        current.tombstoned_at === null
          ? [{
              approval_id: "apr_old",
              review_lineage_id: "rli_meeting",
              superseded_by_candidate_id: "cnd_new",
              provider_message_ts: current.provider_message_ts as string,
            }]
          : [],
      recordSupersededApprovalCardTombstoned: () => {
        current = { ...current, tombstoned_at: "2026-08-22T02:05:04.006Z" };
      },
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      post: async () => {
        operations.push("post");
        current = {
          ...queued,
          state: "superseded",
          superseded_by_candidate_id: "cnd_new",
          superseded_at: "2026-08-22T02:05:04.005Z",
        };
        return { provider_message_ts: "123.000001" };
      },
      reconcile: async () => undefined,
      tombstone: async (input) => {
        operations.push(
          `tombstone:${input.provider_message_ts}:${input.successor_id}`,
        );
      },
    };
    const cardFactory = {
      build: () => ({
        text: "old card",
        frozen_card_sha256: `sha256:${"d".repeat(64)}`,
        approved_snapshot: {},
      }),
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      cardFactory as unknown as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await expect(
      stager.stage({ candidate: queued } as unknown as CleanApprovalStageInputV1),
    ).resolves.toEqual({ kind: "state_drift" });
    expect(operations).toEqual(["post", "tombstone:123.000001:cnd_new"]);
  });

  it("reconciles an accepted post after its response is lost without retrying", async () => {
    const frozenCardSha256 = `sha256:${"d".repeat(64)}`;
    const approvedSnapshot = { candidate_id: "cnd_old" };
    const queued = {
      ...REVIEW_POLICY_FIELDS,
      candidate_id: "cnd_old",
      candidate_semantic_sha256: `sha256:${"a".repeat(64)}`,
      review_lineage_id: "rli_meeting",
      review_input_sha256: `sha256:${"b".repeat(64)}`,
      review_semantic_sha256: `sha256:${"c".repeat(64)}`,
      disposition: "actionable" as const,
      approval_id: "apr_old",
      stage_command_id: "pas_old",
      state: "queued" as const,
      provider_message_ts: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      post_started_at: null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
      tombstoned_at: null,
    };
    let current: Record<string, unknown> = queued;
    const authority = {
      readCandidateByApprovalId: () => current,
      readFrozenCandidateForApproval: () => ({
        ...current,
        admission: {},
        meeting: {},
        decisions: {},
      }),
      prepareApprovalPost: () => {
        if (current.state === "queued") {
          current = {
            ...current,
            state: "posting",
            frozen_card_sha256: frozenCardSha256,
            approved_snapshot_json: JSON.stringify(approvedSnapshot),
            approved_snapshot_sha256: `sha256:${"e".repeat(64)}`,
            post_started_at: "2026-08-22T02:05:04.000Z",
          };
          return { outbox: current, created: true };
        }
        return { outbox: current, created: false };
      },
      recordPostedApprovalCard: (input: {
        readonly provider_message_ts: string;
      }) => {
        current = {
          ...current,
          state: "superseded",
          provider_message_ts: input.provider_message_ts,
          superseded_by_candidate_id: "cnd_new",
          superseded_at: "2026-08-22T02:05:35.000Z",
        };
        return current;
      },
      listPendingSupersededApprovalCards: () =>
        current.state === "superseded" &&
        current.post_started_at !== null &&
        current.tombstoned_at === null
          ? [{
              approval_id: "apr_old",
              review_lineage_id: "rli_meeting",
              superseded_by_candidate_id: "cnd_new",
              provider_message_ts: current.provider_message_ts as string | null,
              post_started_at: current.post_started_at as string,
            }]
          : [],
      recordSupersededApprovalCardTombstoned: () => {
        current = {
          ...current,
          tombstoned_at: "2026-08-22T02:05:36.000Z",
        };
      },
    };
    const post = vi.fn(async () => {
      throw new SlackApiError(
        "unknown_outcome",
        "Slack accepted the post but its response was lost",
        true,
      );
    });
    const reconcile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ provider_message_ts: "123.000001" });
    const poster: CleanSlackApprovalCardPosterV1 = {
      post,
      reconcile,
      tombstone: vi.fn(async () => {}),
    };
    const cardFactory = {
      build: () => ({
        text: "old card",
        frozen_card_sha256: frozenCardSha256,
        approved_snapshot: approvedSnapshot,
      }),
    };
    const first = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      cardFactory as unknown as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await expect(
      first.stage({ candidate: queued } as unknown as CleanApprovalStageInputV1),
    ).resolves.toEqual({ kind: "delivery_pending" });
    const unresolved = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      cardFactory as unknown as CleanSlackApprovalCardFactoryV1,
      poster,
    );
    await expect(
      unresolved.stage({ candidate: queued } as unknown as CleanApprovalStageInputV1),
    ).resolves.toEqual({ kind: "delivery_pending" });
    expect(post).toHaveBeenCalledTimes(1);
    current = {
      ...current,
      state: "superseded",
      superseded_by_candidate_id: "cnd_new",
      superseded_at: "2026-08-22T02:05:35.000Z",
    };

    const reconciled = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      cardFactory as unknown as CleanSlackApprovalCardFactoryV1,
      poster,
    );
    await expect(
      reconciled.reconcileSuperseded(),
    ).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(poster.tombstone).toHaveBeenCalledWith(
      {
        approval_id: "apr_old",
        successor_id: "cnd_new",
        provider_message_ts: "123.000001",
      },
      undefined,
    );
  });
});
