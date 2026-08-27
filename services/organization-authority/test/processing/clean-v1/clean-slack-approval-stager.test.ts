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

const REVIEW_POLICY_FIELDS = {
  review_policy_id: "organization-member-readable-person-v2",
  review_policy_contract_sha256: `sha256:${"1".repeat(64)}`,
  review_policy_consequence_text: "Approving makes this review member-readable.",
  review_policy_consequence_sha256: `sha256:${"2".repeat(64)}`,
};

describe("clean Slack approval supersession", () => {
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
      readSupersededApprovalCard: () => ({ provider_message_ts: null }),
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      post: vi.fn(),
      tombstone,
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {} as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await stager.tombstoneSuperseded({
      superseded_approval_id: "apr_old",
      successor_id: "cnd_no_signals_revision",
    });

    expect(tombstone).not.toHaveBeenCalled();
  });

  it("uses the retained provider timestamp to tombstone a posted obsolete card", async () => {
    const tombstone = vi.fn().mockResolvedValue(undefined);
    const authority = {
      readSupersededApprovalCard: () => ({
        provider_message_ts: "123.000001",
      }),
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      post: vi.fn(),
      tombstone,
    };
    const stager = new CleanSlackApprovalStagerV1(
      authority as unknown as SqliteCleanLiveOnlySourceStateV1,
      {} as Database.Database,
      {} as CleanSlackApprovalCardFactoryV1,
      poster,
    );

    await stager.tombstoneSuperseded({
      superseded_approval_id: "apr_old",
      successor_id: "apr_new",
    });

    expect(tombstone).toHaveBeenCalledWith(
      {
        approval_id: "apr_old",
        successor_id: "apr_new",
        provider_message_ts: "123.000001",
      },
      undefined,
    );
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
      review_round: 2,
      disposition: "actionable" as const,
      approval_id: "apr_new",
      stage_command_id: "pas_new",
      state: "queued" as const,
      superseded_approval_id: "apr_old",
      provider_message_ts: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
    };
    const authority = {
      readCandidateByApprovalId: () => outbox,
      readSupersededApprovalCard: () => ({
        provider_message_ts: "123.000001",
      }),
    };
    const poster: CleanSlackApprovalCardPosterV1 = {
      tombstone: async () => {
        operations.push("tombstone");
      },
      post: async () => {
        operations.push("post");
        throw new Error("stop before control-plane staging");
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
    ).rejects.toThrow("stop before control-plane staging");
    expect(operations).toEqual(["tombstone", "build", "post"]);
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
      review_round: 1,
      disposition: "actionable" as const,
      approval_id: "apr_old",
      stage_command_id: "pas_old",
      state: "queued" as const,
      superseded_approval_id: null,
      provider_message_ts: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      approved_snapshot_sha256: null,
      control_approval_sha256: null,
      superseded_by_candidate_id: null,
      superseded_at: null,
    };
    let current: Record<string, unknown> = queued;
    const authority = {
      readCandidateByApprovalId: () => current,
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
      readSupersededApprovalCard: () => current,
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
});
