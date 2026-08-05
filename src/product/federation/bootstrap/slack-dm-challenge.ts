import { canonicalSha256 } from "../foundation/canonical-json.js";
import type { IdentityClaimV1 } from "../contracts.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";

/**
 * Persisted Slack DM challenge shapes and their validation. The challenge
 * issue/poll code that produced them is retired; stored tickets and
 * verifications are still parsed and cross-checked when old founder residue is
 * inspected.
 */

const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{2,}$/;
const SLACK_ENTERPRISE_ID_RE = /^E[A-Z0-9]{2,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{2,}$/;
const SLACK_DM_ID_RE = /^D[A-Z0-9]{2,}$/;
const SLACK_TIMESTAMP_RE = /^[0-9]{1,16}\.[0-9]{6}$/;
const REACTION_NAME_RE = /^[a-z0-9_+-]{1,64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_CHALLENGE_LIFETIME_MS = 15 * 60 * 1_000;

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
