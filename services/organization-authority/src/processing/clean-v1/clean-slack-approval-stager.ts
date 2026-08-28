import {
  stagePersonSlackPendingApprovalV1,
  type StagePersonSlackPendingApprovalCommandV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import {
  SlackApiError,
  SlackWebApiClient,
} from "../adapters/shared/slack/slack-web-api-client.js";
import type {
  CleanApprovalStageInputV1,
  CleanApprovalStagerV1,
} from "./live-only-source-cycle.js";
import {
  type CleanLiveApprovalOutboxV1,
  SqliteCleanLiveOnlySourceStateV1,
} from "./sqlite-live-only-source-state.js";

const POST_RECONCILIATION_LOOKBACK_MS = 5 * 60 * 1_000;
const DEFINITIVE_POST_FAILURE_CODES = new Set([
  "auth",
  "rate_limited",
  "invalid",
]);

export interface CleanSlackApprovalCardV1 {
  readonly text: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot: Readonly<Record<string, unknown>>;
}

export interface CleanSlackApprovalCardFactoryV1 {
  build(input: CleanApprovalStageInputV1): CleanSlackApprovalCardV1;
  pendingApproval(input: {
    readonly stage: CleanApprovalStageInputV1;
    readonly outbox: CleanLiveApprovalOutboxV1;
  }): StagePersonSlackPendingApprovalCommandV1["approval"];
}

export interface CleanSlackApprovalCardPosterV1 {
  post(
    input: { readonly approval_id: string; readonly text: string },
    signal?: AbortSignal,
  ): Promise<{ readonly provider_message_ts: string }>;
  /** Find a prior bot-authored post with this unique approval marker. */
  reconcile(
    input: {
      readonly approval_id: string;
      readonly post_started_at: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly provider_message_ts: string } | undefined>;
  /** Replace an obsolete bot card with deterministic non-actionable text. */
  tombstone(
    input: {
      readonly approval_id: string;
      readonly successor_id: string;
      readonly provider_message_ts: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CleanSlackApprovalSupersessionInputV1 {
  readonly approval_id: string;
  /** An opaque current approval or candidate ID. */
  readonly successor_id: string;
}

function tombstoneText(input: CleanSlackApprovalSupersessionInputV1): string {
  return [
    "Superseded",
    "A newer version of this meeting replaced this review. This card can no longer be approved or rejected.",
    "",
    `[approval:${input.approval_id}]`,
    `[superseded-by:${input.successor_id}]`,
  ].join("\n");
}

function duplicateTombstoneText(input: {
  readonly approval_id: string;
  readonly canonical_provider_message_ts: string;
}): string {
  return [
    "Duplicate approval card",
    "This duplicate card was replaced by the earliest matching approval card. This card can no longer be approved or rejected.",
    "",
    `[approval:${input.approval_id}]`,
    `[duplicate-of:${input.canonical_provider_message_ts}]`,
  ].join("\n");
}

function renderedPostText(input: { readonly approval_id: string; readonly text: string }): string {
  return `${input.text}\n\n[approval:${input.approval_id}]`;
}

function compareSlackTimestamp(left: string, right: string): number {
  const [leftSeconds, leftMicros] = left.split(".") as [string, string];
  const [rightSeconds, rightMicros] = right.split(".") as [string, string];
  const leftValue = BigInt(leftSeconds) * 1_000_000n + BigInt(leftMicros);
  const rightValue = BigInt(rightSeconds) * 1_000_000n + BigInt(rightMicros);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function slackOldestFromCanonicalUtc(value: string): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("clean approval post intent has an invalid timestamp");
  }
  // Slack timestamps use the provider clock. Search before the local intent
  // boundary so normal host/provider skew cannot turn an accepted post into
  // false absence. The exact approval marker makes an older match conclusive.
  const oldestMilliseconds = Math.max(
    0,
    milliseconds - POST_RECONCILIATION_LOOKBACK_MS,
  );
  const seconds = Math.floor(oldestMilliseconds / 1_000);
  const micros = (oldestMilliseconds % 1_000) * 1_000;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

/** A small concrete `chat.postMessage` adapter with no legacy policy surface. */
export class SlackWebApiCleanApprovalCardPosterV1 implements CleanSlackApprovalCardPosterV1 {
  private readonly client: SlackWebApiClient;
  private auth_identity:
    | Awaited<ReturnType<SlackWebApiClient["authIdentity"]>>
    | undefined;

  constructor(
    token: string,
    private readonly channel_id: string,
    options: ConstructorParameters<typeof SlackWebApiClient>[1] = {},
  ) {
    this.client = new SlackWebApiClient(token, options);
  }

  async post(
    input: { readonly approval_id: string; readonly text: string },
    signal?: AbortSignal,
  ): Promise<{ readonly provider_message_ts: string }> {
    const posted = await this.client.postMessage(
      {
        channel: this.channel_id,
        text: renderedPostText(input),
        unfurlLinks: false,
        unfurlMedia: false,
      },
      signal,
    );
    return { provider_message_ts: posted.ts };
  }

  async reconcile(
    input: {
      readonly approval_id: string;
      readonly post_started_at: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly provider_message_ts: string } | undefined> {
    if (this.auth_identity === undefined) {
      // Do not cache a pending promise: cancellation or an auth failure for
      // one reconciliation attempt must not poison every later recovery.
      this.auth_identity = await this.client.authIdentity(signal);
    }
    const identity = this.auth_identity;
    const approvalMarker = `[approval:${input.approval_id}]`;
    const matches = (await this.client.channelHistory(
      {
        channel: this.channel_id,
        oldest: slackOldestFromCanonicalUtc(input.post_started_at),
      },
      signal,
    ))
      .filter(
        (message) =>
          message.text.endsWith(approvalMarker) &&
          message.bot_id === identity.bot_id,
      )
      .sort((left, right) => compareSlackTimestamp(left.ts, right.ts));
    if (matches.length === 0) return undefined;
    const [canonical, ...duplicates] = matches;
    if (canonical === undefined) return undefined;
    for (const duplicate of duplicates) {
      await this.client.updateMessage(
        {
          channel: this.channel_id,
          ts: duplicate.ts,
          text: duplicateTombstoneText({
            approval_id: input.approval_id,
            canonical_provider_message_ts: canonical.ts,
          }),
          blocks: [],
          unfurlLinks: false,
          unfurlMedia: false,
        },
        signal,
      );
    }
    return { provider_message_ts: canonical.ts };
  }

  async tombstone(
    input: {
      readonly approval_id: string;
      readonly successor_id: string;
      readonly provider_message_ts: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.updateMessage(
      {
        channel: this.channel_id,
        ts: input.provider_message_ts,
        text: tombstoneText({
          approval_id: input.approval_id,
          successor_id: input.successor_id,
        }),
        blocks: [],
        unfurlLinks: false,
        unfurlMedia: false,
      },
      signal,
    );
  }
}

/**
 * Stages one Authority-frozen candidate into the control plane. It records
 * the provider card before the D2 commitment and reports success only after
 * both stores hold their respective durable facts.
 */
export class CleanSlackApprovalStagerV1 implements CleanApprovalStagerV1 {
  constructor(
    private readonly authority: SqliteCleanLiveOnlySourceStateV1,
    private readonly control_database: Database.Database,
    private readonly card_factory: CleanSlackApprovalCardFactoryV1,
    private readonly poster: CleanSlackApprovalCardPosterV1,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Make every prior Slack presentation visibly non-actionable. If a post
   * response was lost before supersession, recover its provider timestamp
   * from the frozen intent before tombstoning it.
   */
  async reconcileSuperseded(
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    await this.reconcileSupersededCards(context);
  }

  /**
   * Drain every current delivery independently of the source cursor. Provider
   * ambiguity is represented by the durable outbox state and is not an error
   * which may hold unrelated source work behind it.
   */
  async reconcilePendingDeliveries(
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    const blockedLineages = await this.reconcileSupersededCards(context);
    for (const frozen of this.authority.listPendingApprovalDeliveries()) {
      if (blockedLineages.has(frozen.review_lineage_id)) continue;
      await this.stageWithBlockedLineages(
        {
          admission: frozen.admission,
          candidate: frozen,
          meeting: frozen.meeting,
          decisions: frozen.decisions,
        },
        blockedLineages,
        context,
      );
    }
  }

  private async reconcileSupersededCards(
    context?: { readonly signal: AbortSignal },
  ): Promise<ReadonlySet<string>> {
    const blockedLineages = new Set<string>();
    for (const obsolete of this.authority.listPendingSupersededApprovalCards()) {
      try {
        let providerMessageTs = obsolete.provider_message_ts;
        if (providerMessageTs === null) {
          const frozen = this.authority.readFrozenCandidateForApproval(
            obsolete.approval_id,
          );
          if (
            frozen === undefined ||
            frozen.state !== "superseded" ||
            frozen.superseded_by_candidate_id !==
              obsolete.superseded_by_candidate_id ||
            frozen.post_started_at !== obsolete.post_started_at
          ) {
            throw new Error(
              "clean superseded approval post intent state drifted",
            );
          }
          const stage: CleanApprovalStageInputV1 = {
            admission: frozen.admission,
            candidate: frozen,
            meeting: frozen.meeting,
            decisions: frozen.decisions,
          };
          const card = this.card_factory.build(stage);
          this.authority.prepareApprovalPost({
            candidate_id: frozen.candidate_id,
            frozen_card_sha256: card.frozen_card_sha256,
            approved_snapshot: card.approved_snapshot,
          });
          const recovered = await this.poster.reconcile(
            {
              approval_id: obsolete.approval_id,
              post_started_at: obsolete.post_started_at,
            },
            context?.signal,
          );
          if (recovered === undefined) {
            blockedLineages.add(obsolete.review_lineage_id);
            continue;
          }
          const durable = this.authority.recordPostedApprovalCard({
            candidate_id: frozen.candidate_id,
            provider_message_ts: recovered.provider_message_ts,
            frozen_card_sha256: card.frozen_card_sha256,
            approved_snapshot: card.approved_snapshot,
          });
          providerMessageTs = durable.provider_message_ts;
          if (providerMessageTs === null) {
            throw new Error(
              "clean superseded approval recovery recorded no provider timestamp",
            );
          }
        }
        await this.poster.tombstone(
          {
            approval_id: obsolete.approval_id,
            successor_id: obsolete.superseded_by_candidate_id,
            provider_message_ts: providerMessageTs,
          },
          context?.signal,
        );
        this.authority.recordSupersededApprovalCardTombstoned({
          approval_id: obsolete.approval_id,
          provider_message_ts: providerMessageTs,
        });
      } catch (error) {
        if (context?.signal.aborted === true) throw error;
        if (error instanceof SlackApiError) {
          blockedLineages.add(obsolete.review_lineage_id);
          continue;
        }
        throw error;
      }
    }
    return blockedLineages;
  }

  async stage(
    input: CleanApprovalStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<
    | { readonly kind: "staged"; readonly stage_id: string }
    | { readonly kind: "delivery_pending" }
    | { readonly kind: "state_drift" }
  > {
    const blockedLineages = await this.reconcileSupersededCards(context);
    return this.stageWithBlockedLineages(
      input,
      blockedLineages,
      context,
    );
  }

  private async stageWithBlockedLineages(
    input: CleanApprovalStageInputV1,
    blockedLineages: ReadonlySet<string>,
    context?: { readonly signal: AbortSignal },
  ): Promise<
    | { readonly kind: "staged"; readonly stage_id: string }
    | { readonly kind: "delivery_pending" }
    | { readonly kind: "state_drift" }
  > {
    if (blockedLineages.has(input.candidate.review_lineage_id)) {
      return { kind: "delivery_pending" };
    }
    let outbox = this.authority.readCandidateByApprovalId(
      input.candidate.approval_id,
    );
    if (
      outbox === undefined ||
      outbox.candidate_id !== input.candidate.candidate_id
    ) {
      throw new Error(
        "clean Slack approval stage has no durable Authority candidate",
      );
    }
    if (await this.tombstoneIfSuperseded(outbox, context)) {
      return { kind: "state_drift" };
    }
    if (outbox.state === "queued" || outbox.state === "posting") {
      const card = this.card_factory.build(input);
      const prepared = this.authority.prepareApprovalPost({
        candidate_id: outbox.candidate_id,
        frozen_card_sha256: card.frozen_card_sha256,
        approved_snapshot: card.approved_snapshot,
      });
      outbox = prepared.outbox;
      if (await this.tombstoneIfSuperseded(outbox, context)) {
        return { kind: "state_drift" };
      }
      let posted: { readonly provider_message_ts: string } | undefined;
      if (prepared.created) {
        // The intent transaction above is the only point which permits an
        // immediate first network attempt. An unknown result leaves `posting`
        // durable so a later runner can reconcile without guessing.
        posted = await this.postCard(outbox, card.text, context?.signal);
      } else {
        if (outbox.post_started_at === null) {
          throw new Error("clean approval posting state has no durable start time");
        }
        posted = await this.reconcilePost(outbox, context?.signal);
      }
      if (posted === undefined) {
        return { kind: "delivery_pending" };
      }
      outbox = this.authority.recordPostedApprovalCard({
        candidate_id: outbox.candidate_id,
        provider_message_ts: posted.provider_message_ts,
        frozen_card_sha256: card.frozen_card_sha256,
        approved_snapshot: card.approved_snapshot,
      });
      const newlyBlocked = await this.reconcileSupersededCards(context);
      if (newlyBlocked.has(outbox.review_lineage_id)) {
        return { kind: "delivery_pending" };
      }
      if (await this.tombstoneIfSuperseded(outbox, context)) {
        return { kind: "state_drift" };
      }
    }
    outbox =
      this.authority.readCandidateByApprovalId(input.candidate.approval_id) ??
      outbox;
    if (await this.tombstoneIfSuperseded(outbox, context)) {
      return { kind: "state_drift" };
    }
    const staged = stagePersonSlackPendingApprovalV1({
      database: this.control_database,
      command: {
        command_id: outbox.stage_command_id,
        approval: this.card_factory.pendingApproval({ stage: input, outbox }),
      },
      now: this.now,
    });
    const durable = this.authority.markControlPlaneStaged({
      candidate_id: outbox.candidate_id,
      control_approval_sha256: staged.approval_sha256,
    });
    if (await this.tombstoneIfSuperseded(durable, context)) {
      return { kind: "state_drift" };
    }
    return { kind: "staged", stage_id: durable.approval_id };
  }

  private async tombstoneIfSuperseded(
    outbox: CleanLiveApprovalOutboxV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<boolean> {
    if (outbox.state !== "superseded") return false;
    if (outbox.superseded_by_candidate_id === null) {
      throw new Error("clean superseded approval has no successor candidate");
    }
    await this.reconcileSuperseded(context);
    return true;
  }

  private async postCard(
    outbox: CleanLiveApprovalOutboxV1,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly provider_message_ts: string } | undefined> {
    try {
      return await this.poster.post(
        { approval_id: outbox.approval_id, text },
        signal,
      );
    } catch (error) {
      if (
        error instanceof SlackApiError &&
        DEFINITIVE_POST_FAILURE_CODES.has(error.code)
      ) {
        this.authority.recordDefinitiveApprovalPostFailure(
          outbox.candidate_id,
        );
      }
      if (signal?.aborted !== true && error instanceof SlackApiError) {
        return undefined;
      }
      throw error;
    }
  }

  private async reconcilePost(
    outbox: CleanLiveApprovalOutboxV1,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly provider_message_ts: string } | undefined> {
    try {
      return await this.poster.reconcile(
        {
          approval_id: outbox.approval_id,
          post_started_at: outbox.post_started_at!,
        },
        signal,
      );
    } catch (error) {
      if (signal?.aborted !== true && error instanceof SlackApiError) {
        return undefined;
      }
      throw error;
    }
  }
}
