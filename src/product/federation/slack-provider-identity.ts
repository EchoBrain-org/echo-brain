import type { SlackAuthIdentity } from "../../adapters/shared/slack/slack-web-api-client.js";
import { canonicalSha256 } from "./canonical-json.js";
import type {
  ProviderIdentityV1,
  SlackProviderIdentitySnapshotV1,
} from "./contracts.js";
import { assertUtcMillisecondTimestamp } from "./identifiers.js";

export interface SlackAuthIdentityApi {
  authIdentity(signal?: AbortSignal): Promise<SlackAuthIdentity>;
}

export interface SlackAuthTestEvidenceInputV1 {
  schema_version: 1;
  kind: "echo-slack-auth-test-evidence-input";
  provider: "slack";
  tenant: {
    team_id: string;
    enterprise_id: string | null;
  };
  subject: {
    bot_user_id: string;
    bot_id: string;
    app_id: string | null;
  };
}

export interface CapturedSlackProviderIdentityV1 {
  snapshot: SlackProviderIdentitySnapshotV1 & { bot_id: string };
  provider_identity: ProviderIdentityV1;
  evidence_input: SlackAuthTestEvidenceInputV1;
  evidence_sha256: `sha256:${string}`;
}

const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{2,}$/;
const SLACK_ENTERPRISE_ID_RE = /^E[A-Z0-9]{2,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{2,}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function validOptionalId(value: string | null, pattern: RegExp): boolean {
  return value === null || pattern.test(value);
}

export function assertCapturedSlackProviderIdentity(
  capture: CapturedSlackProviderIdentityV1,
): void {
  const {
    snapshot,
    provider_identity: providerIdentity,
    evidence_input: evidence,
  } = capture;
  if (
    snapshot.provider !== "slack" ||
    !SLACK_TEAM_ID_RE.test(snapshot.team_id) ||
    !validOptionalId(snapshot.enterprise_id, SLACK_ENTERPRISE_ID_RE) ||
    !SLACK_USER_ID_RE.test(snapshot.bot_user_id) ||
    !SLACK_BOT_ID_RE.test(snapshot.bot_id) ||
    !validOptionalId(snapshot.app_id, SLACK_APP_ID_RE)
  ) {
    throw new Error("captured Slack provider snapshot has invalid identifiers");
  }
  if (
    evidence.schema_version !== 1 ||
    evidence.kind !== "echo-slack-auth-test-evidence-input" ||
    evidence.provider !== "slack" ||
    evidence.tenant.team_id !== snapshot.team_id ||
    evidence.tenant.enterprise_id !== snapshot.enterprise_id ||
    evidence.subject.bot_user_id !== snapshot.bot_user_id ||
    evidence.subject.bot_id !== snapshot.bot_id ||
    evidence.subject.app_id !== snapshot.app_id ||
    !DIGEST_RE.test(capture.evidence_sha256) ||
    canonicalSha256(evidence) !== capture.evidence_sha256
  ) {
    throw new Error(
      "captured Slack auth.test evidence does not match its snapshot",
    );
  }
  if (
    providerIdentity.tenant?.kind !== "slack-team" ||
    providerIdentity.tenant.id !== snapshot.team_id ||
    providerIdentity.tenant.enterprise_id !== snapshot.enterprise_id ||
    providerIdentity.subject?.kind !== "bot-installation" ||
    providerIdentity.subject.id !== snapshot.bot_user_id ||
    providerIdentity.subject.bot_id !== snapshot.bot_id ||
    providerIdentity.subject.app_id !== snapshot.app_id ||
    providerIdentity.verification.method !== "slack_auth_test" ||
    providerIdentity.verification.assurance !== "provider_verified" ||
    providerIdentity.verification.evidence_sha256 !== capture.evidence_sha256
  ) {
    throw new Error(
      "captured Slack registry identity does not match its snapshot",
    );
  }
  assertUtcMillisecondTimestamp(
    providerIdentity.verification.verified_at,
    "Slack identity verified_at",
  );
}

/**
 * Capture only stable identifiers Slack proves for the presented bot token.
 * Mutable workspace/user display names and the bearer credential never enter
 * the evidence digest.
 */
export async function captureSlackProviderIdentity(
  api: SlackAuthIdentityApi,
  verifiedAt: string | (() => string),
  signal?: AbortSignal,
): Promise<CapturedSlackProviderIdentityV1> {
  if (typeof verifiedAt === "string") {
    assertUtcMillisecondTimestamp(verifiedAt, "Slack identity verified_at");
  }
  const identity = await api.authIdentity(signal);
  const observedAt =
    typeof verifiedAt === "function" ? verifiedAt() : verifiedAt;
  assertUtcMillisecondTimestamp(observedAt, "Slack identity verified_at");
  if (identity.bot_id === null) {
    throw new Error(
      "Slack founder bootstrap requires auth.test to prove a bot installation",
    );
  }
  const snapshot: CapturedSlackProviderIdentityV1["snapshot"] = {
    provider: "slack",
    team_id: identity.team_id,
    enterprise_id: identity.enterprise_id,
    bot_user_id: identity.user_id,
    bot_id: identity.bot_id,
    app_id: identity.app_id,
  };
  const evidenceInput: SlackAuthTestEvidenceInputV1 = {
    schema_version: 1,
    kind: "echo-slack-auth-test-evidence-input",
    provider: "slack",
    tenant: {
      team_id: identity.team_id,
      enterprise_id: identity.enterprise_id,
    },
    subject: {
      bot_user_id: identity.user_id,
      bot_id: identity.bot_id,
      app_id: identity.app_id,
    },
  };
  const evidenceSha256 = canonicalSha256(evidenceInput);
  const captured = Object.freeze({
    snapshot: Object.freeze(snapshot),
    provider_identity: Object.freeze({
      tenant: Object.freeze({
        kind: "slack-team",
        id: identity.team_id,
        enterprise_id: identity.enterprise_id,
      }),
      subject: Object.freeze({
        kind: "bot-installation",
        id: identity.user_id,
        bot_id: identity.bot_id,
        app_id: identity.app_id,
      }),
      verification: Object.freeze({
        method: "slack_auth_test",
        assurance: "provider_verified",
        verified_at: observedAt,
        evidence_sha256: evidenceSha256,
      }),
    }),
    evidence_input: Object.freeze({
      ...evidenceInput,
      tenant: Object.freeze(evidenceInput.tenant),
      subject: Object.freeze(evidenceInput.subject),
    }),
    evidence_sha256: evidenceSha256,
  });
  assertCapturedSlackProviderIdentity(captured);
  return captured;
}
