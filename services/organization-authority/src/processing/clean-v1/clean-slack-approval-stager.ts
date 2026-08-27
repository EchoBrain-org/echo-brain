import {
  stagePersonSlackPendingApprovalV1,
  type StagePersonSlackPendingApprovalCommandV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import { SlackWebApiClient } from "../adapters/shared/slack/slack-web-api-client.js";
import type {
  CleanApprovalStageInputV1,
  CleanApprovalStagerV1,
} from "./live-only-source-cycle.js";
import {
  type CleanLiveApprovalOutboxV1,
  SqliteCleanLiveOnlySourceStateV1,
} from "./sqlite-live-only-source-state.js";

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
  readonly superseded_approval_id: string;
  /** An opaque current approval or candidate ID. */
  readonly successor_id: string;
}

function tombstoneText(input: CleanSlackApprovalSupersessionInputV1): string {
  return [
    "Superseded",
    "A newer version of this meeting replaced this review. This card can no longer be approved or rejected.",
    "",
    `[approval:${input.superseded_approval_id}]`,
    `[superseded-by:${input.successor_id}]`,
  ].join("\n");
}

/** A small concrete `chat.postMessage` adapter with no legacy policy surface. */
export class SlackWebApiCleanApprovalCardPosterV1 implements CleanSlackApprovalCardPosterV1 {
  private readonly client: SlackWebApiClient;

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
        text: `${input.text}\n\n[approval:${input.approval_id}]`,
        unfurlLinks: false,
        unfurlMedia: false,
      },
      signal,
    );
    return { provider_message_ts: posted.ts };
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
          superseded_approval_id: input.approval_id,
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
   * Make a prior Slack presentation visibly non-actionable. The Authority
   * snapshot and Control-plane approval are deliberately untouched: this is
   * only a presentation change. A not-yet-posted old card has no Slack work.
   */
  async tombstoneSuperseded(
    input: CleanSlackApprovalSupersessionInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<void> {
    const obsolete = this.authority.readSupersededApprovalCard(
      input.superseded_approval_id,
    );
    if (obsolete?.provider_message_ts === null || obsolete === undefined) {
      return;
    }
    await this.poster.tombstone(
      {
        approval_id: input.superseded_approval_id,
        successor_id: input.successor_id,
        provider_message_ts: obsolete.provider_message_ts,
      },
      context?.signal,
    );
  }

  async stage(
    input: CleanApprovalStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<
    | { readonly kind: "staged"; readonly stage_id: string }
    | { readonly kind: "state_drift" }
  > {
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
    if (outbox.state === "queued") {
      const supersededApprovalId = input.candidate.superseded_approval_id;
      if (supersededApprovalId !== null) {
        await this.tombstoneSuperseded(
          {
            superseded_approval_id: supersededApprovalId,
            successor_id: outbox.approval_id,
          },
          context,
        );
      }
      const card = this.card_factory.build(input);
      const posted = await this.poster.post(
        { approval_id: outbox.approval_id, text: card.text },
        context?.signal,
      );
      outbox = this.authority.recordPostedApprovalCard({
        candidate_id: outbox.candidate_id,
        provider_message_ts: posted.provider_message_ts,
        frozen_card_sha256: card.frozen_card_sha256,
        approved_snapshot: card.approved_snapshot,
      });
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
    await this.tombstoneSuperseded(
      {
        superseded_approval_id: outbox.approval_id,
        successor_id: outbox.superseded_by_candidate_id,
      },
      context,
    );
    return true;
  }
}
