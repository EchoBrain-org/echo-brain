import { randomBytes } from "node:crypto";
import type {
  SlackAuthIdentity,
  SlackDirectMessage,
  SlackPostMessageInput,
  SlackPostedMessage,
  SlackReaction,
} from "../../../adapters/shared/slack/slack-web-api-client.js";
import { canonicalSha256, sha256Digest } from "../foundation/canonical-json.js";
import type { IdentityClaimV1 } from "../contracts.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";
import {
  assertCapturedSlackProviderIdentity,
  type CapturedSlackProviderIdentityV1,
  type SlackAuthIdentityApi,
} from "../identity/slack-provider-identity.js";

const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{2,}$/;
const SLACK_ENTERPRISE_ID_RE = /^E[A-Z0-9]{2,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{2,}$/;
const SLACK_DM_ID_RE = /^D[A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP_RE = /^[0-9]{1,16}\.[0-9]{6}$/;
const REACTION_NAME_RE = /^[a-z0-9_+-]{1,64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MIN_NONCE_BYTES = 16;
const MAX_NONCE_BYTES = 64;
const MAX_CHALLENGE_LIFETIME_MS = 15 * 60 * 1_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_REACTION_NAME = "white_check_mark";

export interface SlackDmChallengeApi extends SlackAuthIdentityApi {
  openDirectMessage(
    userId: string,
    signal?: AbortSignal,
  ): Promise<SlackDirectMessage>;
  postMessage(
    input: SlackPostMessageInput,
    signal?: AbortSignal,
  ): Promise<SlackPostedMessage>;
  reactionsGet(
    channel: string,
    timestamp: string,
    signal?: AbortSignal,
  ): Promise<readonly SlackReaction[]>;
}

function providerIdentityMatches(
  observed: SlackAuthIdentity,
  provider: CapturedSlackProviderIdentityV1,
): boolean {
  return (
    observed.team_id === provider.snapshot.team_id &&
    observed.enterprise_id === provider.snapshot.enterprise_id &&
    observed.user_id === provider.snapshot.bot_user_id &&
    observed.bot_id === provider.snapshot.bot_id &&
    observed.app_id === provider.snapshot.app_id
  );
}

function ticketProviderIdentityMatches(
  observed: SlackAuthIdentity,
  ticket: SlackDmChallengeTicketV1,
): boolean {
  return (
    observed.team_id === ticket.tenant_id &&
    observed.enterprise_id === ticket.enterprise_id &&
    observed.user_id === ticket.bot_user_id &&
    observed.bot_id === ticket.bot_id &&
    observed.app_id === ticket.app_id
  );
}

export interface SlackActorNamespaceV1 {
  provider: "slack";
  team_id: string;
  user_id: string;
}

export interface SlackDmChallengeTicketV1 {
  schema_version: 1;
  kind: "echo-slack-dm-challenge-ticket";
  provider: "slack";
  tenant_id: string;
  enterprise_id: string | null;
  subject_id: string;
  bot_user_id: string;
  bot_id: string;
  app_id: string | null;
  auth_test_evidence_sha256: `sha256:${string}`;
  channel_id: string;
  message_ts: string;
  reaction_name: string;
  challenge_sha256: `sha256:${string}`;
  issued_at: string;
  expires_at: string;
}

export interface SlackDmChallengeEvidenceInputV1 {
  schema_version: 1;
  kind: "echo-slack-dm-challenge-evidence-input";
  provider: "slack";
  tenant: {
    team_id: string;
    enterprise_id: string | null;
  };
  subject: { user_id: string };
  bot: {
    user_id: string;
    bot_id: string;
    app_id: string | null;
    auth_test_evidence_sha256: `sha256:${string}`;
  };
  challenge: {
    channel_id: string;
    message_ts: string;
    nonce_sha256: `sha256:${string}`;
    issued_at: string;
    expires_at: string;
  };
  assertion: {
    kind: "reaction";
    name: string;
    observed_at: string;
  };
}

export interface SlackDmChallengeVerificationV1 {
  evidence_input: SlackDmChallengeEvidenceInputV1;
  evidence_sha256: `sha256:${string}`;
  claim_assertion: Pick<IdentityClaimV1, "issuer" | "subject" | "verification">;
}

export type SlackDmChallengePollResult =
  | {
      status: "verified";
      attempts: number;
      verification: SlackDmChallengeVerificationV1;
    }
  | { status: "expired"; attempts: number }
  | { status: "not_observed"; attempts: number };

export interface IssueSlackDmChallengeOptions {
  issuedAt: string;
  expiresAt: string;
  reactionName?: string;
  nonceFactory?: (size: number) => Buffer;
  signal?: AbortSignal;
}

export interface PollSlackDmChallengeOptions {
  maxAttempts: number;
  pollIntervalMs: number;
  now: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Slack DM challenge was cancelled");
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Slack DM challenge was cancelled"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function timestampMilliseconds(value: string, label: string): number {
  assertUtcMillisecondTimestamp(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} cannot be represented`);
  }
  return milliseconds;
}

function assertChallengeWindow(issuedAt: string, expiresAt: string): void {
  const issued = timestampMilliseconds(issuedAt, "Slack challenge issued_at");
  const expires = timestampMilliseconds(
    expiresAt,
    "Slack challenge expires_at",
  );
  const lifetime = expires - issued;
  if (lifetime <= 0 || lifetime > MAX_CHALLENGE_LIFETIME_MS) {
    throw new Error(
      "Slack DM challenge lifetime must be between 1ms and 15 minutes",
    );
  }
}

export function assertSlackDmChallengeTicket(
  ticket: SlackDmChallengeTicketV1,
): void {
  assertChallengeWindow(ticket.issued_at, ticket.expires_at);
  if (
    ticket.schema_version !== 1 ||
    ticket.kind !== "echo-slack-dm-challenge-ticket" ||
    ticket.provider !== "slack" ||
    !SLACK_TEAM_ID_RE.test(ticket.tenant_id) ||
    (ticket.enterprise_id !== null &&
      !SLACK_ENTERPRISE_ID_RE.test(ticket.enterprise_id)) ||
    !SLACK_USER_ID_RE.test(ticket.subject_id) ||
    !SLACK_USER_ID_RE.test(ticket.bot_user_id) ||
    !SLACK_BOT_ID_RE.test(ticket.bot_id) ||
    (ticket.app_id !== null && !SLACK_APP_ID_RE.test(ticket.app_id)) ||
    ticket.subject_id === ticket.bot_user_id ||
    !SLACK_DM_ID_RE.test(ticket.channel_id) ||
    !SLACK_TIMESTAMP_RE.test(ticket.message_ts) ||
    !REACTION_NAME_RE.test(ticket.reaction_name) ||
    !DIGEST_RE.test(ticket.challenge_sha256) ||
    !DIGEST_RE.test(ticket.auth_test_evidence_sha256)
  ) {
    throw new Error("Slack DM challenge ticket is invalid or not namespaced");
  }
}

function challengeText(
  actor: SlackActorNamespaceV1,
  nonce: Buffer,
  expiresAt: string,
  reactionName: string,
): string {
  return [
    "Echo Brain identity verification",
    `Workspace/user: ${actor.team_id}/${actor.user_id}`,
    `React with :${reactionName}: to this message before ${expiresAt}.`,
    `Challenge: ${nonce.toString("base64url")}`,
    "Do not paste this challenge into the terminal.",
  ].join("\n");
}

/**
 * Send a fresh challenge into a one-person Slack DM. The returned ticket keeps
 * only the nonce digest; callers cannot satisfy the challenge through a local
 * CLI by replaying the value that was sent to Slack.
 */
export async function issueSlackDmChallenge(
  api: SlackDmChallengeApi,
  provider: CapturedSlackProviderIdentityV1,
  actor: SlackActorNamespaceV1,
  options: IssueSlackDmChallengeOptions,
): Promise<SlackDmChallengeTicketV1> {
  assertCapturedSlackProviderIdentity(provider);
  assertChallengeWindow(options.issuedAt, options.expiresAt);
  if (
    actor.provider !== "slack" ||
    !SLACK_TEAM_ID_RE.test(actor.team_id) ||
    !SLACK_USER_ID_RE.test(actor.user_id)
  ) {
    throw new Error(
      "Slack challenge actor must be a namespaced team/user pair",
    );
  }
  if (actor.team_id !== provider.snapshot.team_id) {
    throw new Error("Slack challenge actor belongs to a different workspace");
  }
  if (actor.user_id === provider.snapshot.bot_user_id) {
    throw new Error("Slack challenge actor cannot be the connected bot");
  }
  const reactionName = options.reactionName ?? DEFAULT_REACTION_NAME;
  if (!REACTION_NAME_RE.test(reactionName)) {
    throw new Error("Slack challenge reaction name is invalid");
  }
  assertNotAborted(options.signal);
  const currentProvider = await api.authIdentity(options.signal);
  if (!providerIdentityMatches(currentProvider, provider)) {
    throw new Error(
      "Slack connection identity changed before the DM challenge",
    );
  }
  const nonce = (options.nonceFactory ?? randomBytes)(32);
  if (
    !Buffer.isBuffer(nonce) ||
    nonce.byteLength < MIN_NONCE_BYTES ||
    nonce.byteLength > MAX_NONCE_BYTES
  ) {
    throw new Error("Slack challenge nonce must contain 16-64 random bytes");
  }
  const directMessage = await api.openDirectMessage(
    actor.user_id,
    options.signal,
  );
  if (
    directMessage.user_id !== actor.user_id ||
    !SLACK_DM_ID_RE.test(directMessage.channel_id)
  ) {
    throw new Error("Slack opened an invalid direct message for this user");
  }
  const posted = await api.postMessage(
    {
      channel: directMessage.channel_id,
      text: challengeText(actor, nonce, options.expiresAt, reactionName),
      unfurlLinks: false,
      unfurlMedia: false,
    },
    options.signal,
  );
  if (posted.channel !== directMessage.channel_id) {
    throw new Error("Slack posted the challenge into a different conversation");
  }
  const ticket: SlackDmChallengeTicketV1 = {
    schema_version: 1,
    kind: "echo-slack-dm-challenge-ticket",
    provider: "slack",
    tenant_id: actor.team_id,
    enterprise_id: provider.snapshot.enterprise_id,
    subject_id: actor.user_id,
    bot_user_id: provider.snapshot.bot_user_id,
    bot_id: provider.snapshot.bot_id,
    app_id: provider.snapshot.app_id,
    auth_test_evidence_sha256: provider.evidence_sha256,
    channel_id: directMessage.channel_id,
    message_ts: posted.ts,
    reaction_name: reactionName,
    challenge_sha256: sha256Digest(nonce),
    issued_at: options.issuedAt,
    expires_at: options.expiresAt,
  };
  assertSlackDmChallengeTicket(ticket);
  return Object.freeze(ticket);
}

function assertPollOptions(options: PollSlackDmChallengeOptions): void {
  if (
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > MAX_POLL_ATTEMPTS
  ) {
    throw new Error(
      `Slack challenge maxAttempts must be between 1 and ${MAX_POLL_ATTEMPTS}`,
    );
  }
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < MIN_POLL_INTERVAL_MS ||
    options.pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `Slack challenge pollIntervalMs must be between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`,
    );
  }
  if (
    (options.maxAttempts - 1) * options.pollIntervalMs >
    MAX_CHALLENGE_LIFETIME_MS
  ) {
    throw new Error("Slack challenge polling schedule exceeds 15 minutes");
  }
}

function challengeExpired(
  now: string,
  ticket: SlackDmChallengeTicketV1,
): boolean {
  const observed = timestampMilliseconds(now, "Slack challenge observed_at");
  const issued = timestampMilliseconds(
    ticket.issued_at,
    "Slack challenge issued_at",
  );
  const expires = timestampMilliseconds(
    ticket.expires_at,
    "Slack challenge expires_at",
  );
  if (observed < issued) {
    throw new Error("Slack challenge observation precedes challenge issuance");
  }
  return observed >= expires;
}

function verification(
  ticket: SlackDmChallengeTicketV1,
  observedAt: string,
): SlackDmChallengeVerificationV1 {
  const evidenceInput: SlackDmChallengeEvidenceInputV1 = {
    schema_version: 1,
    kind: "echo-slack-dm-challenge-evidence-input",
    provider: "slack",
    tenant: {
      team_id: ticket.tenant_id,
      enterprise_id: ticket.enterprise_id,
    },
    subject: { user_id: ticket.subject_id },
    bot: {
      user_id: ticket.bot_user_id,
      bot_id: ticket.bot_id,
      app_id: ticket.app_id,
      auth_test_evidence_sha256: ticket.auth_test_evidence_sha256,
    },
    challenge: {
      channel_id: ticket.channel_id,
      message_ts: ticket.message_ts,
      nonce_sha256: ticket.challenge_sha256,
      issued_at: ticket.issued_at,
      expires_at: ticket.expires_at,
    },
    assertion: {
      kind: "reaction",
      name: ticket.reaction_name,
      observed_at: observedAt,
    },
  };
  const evidenceSha256 = canonicalSha256(evidenceInput);
  const frozenEvidenceInput = Object.freeze({
    ...evidenceInput,
    tenant: Object.freeze(evidenceInput.tenant),
    subject: Object.freeze(evidenceInput.subject),
    bot: Object.freeze(evidenceInput.bot),
    challenge: Object.freeze(evidenceInput.challenge),
    assertion: Object.freeze(evidenceInput.assertion),
  });
  return Object.freeze({
    evidence_input: frozenEvidenceInput,
    evidence_sha256: evidenceSha256,
    claim_assertion: Object.freeze({
      issuer: Object.freeze({
        kind: "provider" as const,
        provider: "slack",
        tenant_id: ticket.tenant_id,
      }),
      subject: Object.freeze({ kind: "user" as const, id: ticket.subject_id }),
      verification: Object.freeze({
        method: "slack_dm_challenge" as const,
        assurance: "provider_challenge_observed" as const,
        verified_at: observedAt,
        evidence_sha256: evidenceSha256,
      }),
    }),
  });
}

export function assertSlackDmChallengeVerification(
  ticket: SlackDmChallengeTicketV1,
  value: SlackDmChallengeVerificationV1,
): void {
  assertSlackDmChallengeTicket(ticket);
  const evidence = value.evidence_input;
  if (
    evidence.schema_version !== 1 ||
    evidence.kind !== "echo-slack-dm-challenge-evidence-input" ||
    evidence.provider !== "slack" ||
    evidence.tenant.team_id !== ticket.tenant_id ||
    evidence.tenant.enterprise_id !== ticket.enterprise_id ||
    evidence.subject.user_id !== ticket.subject_id ||
    evidence.bot.user_id !== ticket.bot_user_id ||
    evidence.bot.bot_id !== ticket.bot_id ||
    evidence.bot.app_id !== ticket.app_id ||
    evidence.bot.auth_test_evidence_sha256 !==
      ticket.auth_test_evidence_sha256 ||
    evidence.challenge.channel_id !== ticket.channel_id ||
    evidence.challenge.message_ts !== ticket.message_ts ||
    evidence.challenge.nonce_sha256 !== ticket.challenge_sha256 ||
    evidence.challenge.issued_at !== ticket.issued_at ||
    evidence.challenge.expires_at !== ticket.expires_at ||
    evidence.assertion.kind !== "reaction" ||
    evidence.assertion.name !== ticket.reaction_name ||
    value.evidence_sha256 !== canonicalSha256(evidence) ||
    value.claim_assertion.issuer.kind !== "provider" ||
    value.claim_assertion.issuer.provider !== "slack" ||
    value.claim_assertion.issuer.tenant_id !== ticket.tenant_id ||
    value.claim_assertion.subject.kind !== "user" ||
    value.claim_assertion.subject.id !== ticket.subject_id ||
    value.claim_assertion.verification.method !== "slack_dm_challenge" ||
    value.claim_assertion.verification.assurance !==
      "provider_challenge_observed" ||
    value.claim_assertion.verification.evidence_sha256 !==
      value.evidence_sha256 ||
    value.claim_assertion.verification.verified_at !==
      evidence.assertion.observed_at
  ) {
    throw new Error(
      "Slack DM challenge verification does not match its ticket",
    );
  }
  assertUtcMillisecondTimestamp(
    evidence.assertion.observed_at,
    "Slack challenge assertion observed_at",
  );
  if (challengeExpired(evidence.assertion.observed_at, ticket)) {
    throw new Error(
      "Slack DM challenge verification was observed after expiry",
    );
  }
}

/** Poll one exact Slack DM message for one exact workspace-scoped user. */
export async function pollSlackDmChallenge(
  api: SlackDmChallengeApi,
  ticket: SlackDmChallengeTicketV1,
  options: PollSlackDmChallengeOptions,
): Promise<SlackDmChallengePollResult> {
  assertSlackDmChallengeTicket(ticket);
  assertPollOptions(options);
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  const preflightAt = options.now();
  if (challengeExpired(preflightAt, ticket)) {
    return { status: "expired", attempts };
  }
  const currentProvider = await api.authIdentity(options.signal);
  if (!ticketProviderIdentityMatches(currentProvider, ticket)) {
    throw new Error(
      "Slack connection identity changed before challenge polling",
    );
  }
  for (let index = 0; index < options.maxAttempts; index += 1) {
    assertNotAborted(options.signal);
    const startedAt = options.now();
    if (challengeExpired(startedAt, ticket)) {
      return { status: "expired", attempts };
    }
    const reactions = await api.reactionsGet(
      ticket.channel_id,
      ticket.message_ts,
      options.signal,
    );
    attempts += 1;
    const observedAt = options.now();
    if (challengeExpired(observedAt, ticket)) {
      return { status: "expired", attempts };
    }
    const matched = reactions.some(
      (reaction) =>
        reaction.name === ticket.reaction_name &&
        reaction.users.includes(ticket.subject_id),
    );
    if (matched) {
      return {
        status: "verified",
        attempts,
        verification: verification(ticket, observedAt),
      };
    }
    if (index + 1 < options.maxAttempts) {
      await sleep(options.pollIntervalMs, options.signal);
    }
  }
  return { status: "not_observed", attempts };
}
