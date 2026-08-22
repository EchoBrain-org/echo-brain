import { type ApprovalContractSha256 } from "../../application/person-slack-approval-contracts-v2.js";
import type {
  PersonSlackApprovalObserverV2,
  PersonSlackApprovalProviderExpectationV2,
  PersonSlackApprovalProviderResultV2,
} from "../../application/person-slack-approval-finalization-v2.js";
import { canonicalSha256 } from "../../canonical/canonical-json.js";

const API_URL = "https://slack.com/api/reactions.get";
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{6}$/;

export interface CleanSlackReactionObserverFetchV1 {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CleanSlackReactionObserverV1Input {
  readonly token_reader: {
    readApprovalToken(input: {
      readonly connection_id: string;
      readonly connection_state_sha256: ApprovalContractSha256;
    }): string;
  };
  readonly now: () => string;
  readonly fetch?: CleanSlackReactionObserverFetchV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Slack ${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) {
    throw new Error("Slack approval observation request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        throw new Error("Slack approval observation response exceeds limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Slack approval observation response is not JSON");
  }
}

function expected(input: PersonSlackApprovalProviderExpectationV2): void {
  if (
    input.provider_issuer !== "https://slack.com" ||
    input.provider_tenant_kind !== "workspace" ||
    input.tool_kind !== "slack" ||
    !SLACK_TIMESTAMP.test(input.provider_message_ts) ||
    input.approve_reaction === input.reject_reaction
  ) {
    throw new Error("clean Slack approval expectation is invalid");
  }
}

function observation(
  response: unknown,
  expectation: PersonSlackApprovalProviderExpectationV2,
  expectationSha256: ApprovalContractSha256,
  observedAt: string,
): PersonSlackApprovalProviderResultV2 {
  const body = record(response, "approval observation");
  if (body.ok !== true) {
    throw new Error("Slack approval observation was rejected");
  }
  const message = record(body.message, "approval message");
  if (message.ts !== expectation.provider_message_ts) {
    return Object.freeze({ kind: "not_resolved", reason: "provider_mismatch" });
  }
  const reactions = message.reactions;
  if (!Array.isArray(reactions)) {
    return Object.freeze({ kind: "not_resolved", reason: "absent" });
  }
  const choices: Array<{
    readonly action: "approve" | "reject";
    readonly reaction: string;
    readonly users: readonly string[];
  }> = [];
  for (const raw of reactions) {
    const reaction = record(raw, "approval reaction");
    const name = reaction.name;
    if (typeof name !== "string") {
      return Object.freeze({
        kind: "not_resolved",
        reason: "provider_mismatch",
      });
    }
    const action =
      name === expectation.approve_reaction
        ? "approve"
        : name === expectation.reject_reaction
          ? "reject"
          : null;
    if (action === null) continue;
    if (
      !Array.isArray(reaction.users) ||
      reaction.users.some(
        (user) => typeof user !== "string" || !SLACK_USER_ID.test(user),
      )
    ) {
      return Object.freeze({
        kind: "not_resolved",
        reason: "provider_mismatch",
      });
    }
    const users = [...new Set(reaction.users as string[])].sort();
    if (users.length > 0) choices.push({ action, reaction: name, users });
  }
  if (choices.length === 0) {
    return Object.freeze({ kind: "not_resolved", reason: "absent" });
  }
  if (choices.length !== 1) {
    return Object.freeze({
      kind: "not_resolved",
      reason: "conflicting_reactions",
    });
  }
  const choice = choices[0];
  if (
    choice === undefined ||
    choice.users.length !== 1 ||
    choice.users[0] === undefined
  ) {
    return Object.freeze({ kind: "not_resolved", reason: "incomplete_roster" });
  }
  return Object.freeze({
    kind: "observed",
    expectation_sha256: expectationSha256,
    provider_actor_subject: choice.users[0],
    observed_reaction: choice.reaction,
    observed_action: choice.action,
    provider_response_evidence_sha256: canonicalSha256({
      approval_id: expectation.approval_id,
      approval_channel_id: expectation.approval_channel_id,
      kind: "echo-clean-slack-reaction-observation-v1",
      observed_action: choice.action,
      observed_reaction: choice.reaction,
      provider_actor_subject: choice.users[0],
      provider_message_ts: expectation.provider_message_ts,
      provider_tenant_id: expectation.provider_tenant_id,
    }),
    observed_at: observedAt,
  });
}

/**
 * Small live-only observer for the clean connection. It reads one matching
 * opaque credential from the file-secret seam and observes only one message.
 */
export class CleanSlackReactionObserverV1 implements PersonSlackApprovalObserverV2 {
  private readonly fetch: CleanSlackReactionObserverFetchV1;

  constructor(private readonly input: CleanSlackReactionObserverV1Input) {
    this.fetch = input.fetch ?? fetch;
  }

  async observeApprovalReaction(
    expectationValue: PersonSlackApprovalProviderExpectationV2,
    expectationSha256: ApprovalContractSha256,
    signal?: AbortSignal,
  ): Promise<PersonSlackApprovalProviderResultV2> {
    expected(expectationValue);
    signal?.throwIfAborted();
    const token = this.input.token_reader.readApprovalToken({
      connection_id: expectationValue.connection_id,
      connection_state_sha256: expectationValue.connection_state_sha256,
    });
    const url = new URL(API_URL);
    url.searchParams.set("channel", expectationValue.approval_channel_id);
    url.searchParams.set("timestamp", expectationValue.provider_message_ts);
    url.searchParams.set("full", "true");
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    signal?.throwIfAborted();
    return observation(
      await boundedJson(response),
      expectationValue,
      expectationSha256,
      this.input.now(),
    );
  }
}
