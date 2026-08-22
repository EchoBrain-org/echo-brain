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

  async stage(
    input: CleanApprovalStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<{ readonly kind: "staged"; readonly stage_id: string }> {
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
    if (outbox.state === "queued") {
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
    return { kind: "staged", stage_id: durable.approval_id };
  }
}
