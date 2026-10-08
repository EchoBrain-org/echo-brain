import type { OrganizationPersonToolV2 } from "@echo-brain/provider-slack-client/organization-api/person-tools";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import { type ActiveSlackOrganizationTool, type BeginPersonSlackIdentityLinkChallengeInput, type BegunSlackIdentityLinkChallenge, type CompletePersonSlackIdentityLinkChallengeInput, type CompletedPersonSlackIdentityLink, type PendingPersonSlackIdentityLinkChallenge, type PersonSlackIdentityLinkSession } from "../organization-control-plane/application/slack-integration-contracts.js";
import { buildExternalHumanIdentityLinkContractV2, validateExternalHumanIdentityLinkContractV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { type SlackIdentityProviderV1 } from "../organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { readActiveSlackConnectionV1, type StoredSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import type Database from "better-sqlite3";
import { ReadableSearchAuthorizationFence } from "@echo-brain/organization-authority-kernel/application/readable-search-authorization-fence";
import { sameTool, SlackPersonIdentityLinkWorkflowV1, type SlackPersonIdentityLinkAuthenticationPort, type SlackPersonIdentityLinkRepositoryPort } from "./slack-person-identity-link-workflow-v1.js";

const CHALLENGE_LIFETIME_MS = 15 * 60 * 1000;
const DELIVERY_ADMISSION_COOLDOWN_MS = 60 * 1000;

/** Avoid loading the legacy integration repository for its error class. */
class PersonSlackIdentityLinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationIntegrationConflictError";
  }
}

export interface SlackBotTokenAccessV1 {
  /** The active connection's bot token, resolved per use (a token source may be async). */
  readActiveSlackBotToken(
    connection: StoredSlackConnectionV1,
    options?: { readonly force_refresh?: boolean },
  ): string | Promise<string>;
  /** Slack kept rejecting this connection's token after one refresh. */
  onActiveSlackBotTokenRejected(connection: StoredSlackConnectionV1): void;
  /** True while this connection is marked "needs reinstall": no refresh is tried. */
  isActiveSlackBotTokenRejected(connection: StoredSlackConnectionV1): boolean;
}

export interface CreateSqliteSlackPersonIdentityLinkWorkflowV1Input {
  readonly database: Database.Database;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly authentication: SlackPersonIdentityLinkAuthenticationPort;
  /** Current membership data remains Authority-owned, not copied into D2. */
  readonly membership_type: (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }) => "employee" | "owner";
  readonly slack: SlackIdentityProviderV1;
  readonly slack_token_access: SlackBotTokenAccessV1;
  readonly authorization_fence: ReadableSearchAuthorizationFence;
  /** Synchronously clears short-lived browser proof after a durable revoke. */
  readonly invalidate_browser_attempts?: (membershipId: string) => void;
  readonly now?: () => string;
}

interface ActiveSlackConnection {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
  readonly stored: StoredSlackConnectionV1;
  readonly tool: ActiveSlackOrganizationTool;
}

interface ChallengeRow {
  readonly dm_channel_id: string;
  readonly recipient_user_id: string;
  readonly challenge_attempt_id: string;
  readonly connection_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly challenge_code_sha256: `sha256:${string}`;
  readonly person_session_sha256: `sha256:${string}`;
  readonly organization_tool_sha256: `sha256:${string}`;
  readonly status: "pending" | "completed" | "expired";
  readonly completion_sha256: `sha256:${string}` | null;
  readonly challenge_message_ts: string | null;
  readonly reply_message_ts: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

function offsetTime(now: string, offsetMs: number): string {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid current time");
  return new Date(milliseconds + offsetMs).toISOString();
}

function personSessionSha256(
  session: PersonSlackIdentityLinkSession,
): `sha256:${string}` {
  return canonicalSha256({
    kind: "echo-organization-person-slack-link-session-v1",
    authority_id: session.authority_id,
    organization_id: session.organization_id,
    principal_id: session.principal_id,
    membership_id: session.membership_id,
    identity_binding_id: session.identity_binding_id,
    session_family_id: session.session_family_id,
  });
}

function toolSha256(
  challengeAttemptId: string,
  tool: ActiveSlackOrganizationTool,
): `sha256:${string}` {
  return canonicalSha256({
    challenge_attempt_id: challengeAttemptId,
    connection_id: tool.connection_id,
    team_id: tool.team_id,
    enterprise_id: tool.enterprise_id,
    bot_user_id: tool.bot_user_id,
    bot_id: tool.bot_id,
    app_id: tool.app_id,
  });
}

function completionSha256(input: {
  readonly challenge_attempt_id: string;
  readonly challenge_code_sha256: `sha256:${string}`;
  readonly challenge_message_ts: string;
  readonly person_session: PersonSlackIdentityLinkSession;
  readonly organization_tool: ActiveSlackOrganizationTool;
}): `sha256:${string}` {
  return canonicalSha256({
    kind: "echo-organization-person-slack-link-completion-v1",
    challenge_attempt_id: input.challenge_attempt_id,
    challenge_code_sha256: input.challenge_code_sha256,
    challenge_message_ts: input.challenge_message_ts,
    person_session_sha256: personSessionSha256(input.person_session),
    organization_tool_sha256: toolSha256(
      input.challenge_attempt_id,
      input.organization_tool,
    ),
  });
}

function identityLinkId(verificationEventId: string): string {
  if (!verificationEventId.startsWith("cat_") && !verificationEventId.startsWith("sbl_"))
    throw new Error("invalid Slack verification event ID");
  return `clm_${verificationEventId.slice(4)}`;
}

export interface CompleteBrowserSlackIdentityLinkInputV1 {
  readonly attempt_id: string;
  readonly person_session: PersonSlackIdentityLinkSession;
  readonly organization_tool: ActiveSlackOrganizationTool;
  readonly provider_subject_id: string;
  readonly verification_evidence_sha256: `sha256:${string}`;
  readonly now: string;
}

/**
 * SQLite repository adapter. It persists only challenge and identity-link
 * state in the frozen D2 baseline; authentication and token retrieval remain
 * Authority/runtime ports.
 */
export class SqliteSlackPersonIdentityLinkRepositoryV1 implements SlackPersonIdentityLinkRepositoryPort {
  constructor(
    private readonly options: CreateSqliteSlackPersonIdentityLinkWorkflowV1Input,
  ) {}

  activeSlackOrganizationTool(): ActiveSlackOrganizationTool | null {
    return this.activeConnection()?.tool ?? null;
  }

  personTools(session: PersonSlackIdentityLinkSession): readonly OrganizationPersonToolV2[] {
    const active = this.activeConnection();
    if (active === null) {
      const configured = this.options.database.prepare("SELECT 1 FROM organization_tool_connection_current_state LIMIT 1").get();
      return configured === undefined ? [] : [{ provider: "slack", availability: "unavailable", personal_status: "unavailable", workspace_id: null, account_id: null }];
    }
    const row = this.options.database.prepare(`SELECT current_status, provider_subject_id
      FROM organization_external_human_link_current WHERE principal_id = ? AND membership_id = ?
      AND provider_issuer = 'https://slack.com' AND provider_tenant_kind = 'workspace'
      AND provider_tenant_id = ? AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
      ORDER BY (current_status = 'active') DESC LIMIT 1`).get(session.principal_id, session.membership_id,
        active.tool.team_id, active.tool.enterprise_id) as { current_status: string; provider_subject_id: string } | undefined;
    const status = row === undefined ? "unlinked" : row.current_status === "active" ? "linked" : "revoked";
    return [{ provider: "slack", availability: "enabled", personal_status: status,
      workspace_id: active.tool.team_id, account_id: status === "linked" ? row!.provider_subject_id : null }];
  }

  personSlackIdentityLinkBeginReplay(input: {
    request_id: string;
    request_sha256: `sha256:${string}`;
    person_session: PersonSlackIdentityLinkSession;
    organization_tool: ActiveSlackOrganizationTool;
  }):
    | (BegunSlackIdentityLinkChallenge & {
        replayed: true;
        challenge_message_ts: string;
      })
    | null {
    if (
      !sameTool(input.organization_tool, this.activeSlackOrganizationTool())
    ) {
      throw new PersonSlackIdentityLinkConflictError(
        "active Slack connection changed",
      );
    }
    const row = this.options.database
      .prepare(
        `SELECT command.command_semantic_sha256, challenge.challenge_attempt_id,
                challenge.connection_id, challenge.person_session_sha256,
                challenge.organization_tool_sha256, challenge.created_at,
                challenge.expires_at, challenge.challenge_message_ts, challenge.dm_channel_id, challenge.recipient_user_id
         FROM organization_person_slack_link_commands AS command
         JOIN organization_person_slack_link_challenges AS challenge
           ON challenge.challenge_attempt_id = command.challenge_attempt_id
         WHERE command.command_id = ? AND command.command_kind = 'begin'`,
      )
      .get(input.request_id) as
      | {
          dm_channel_id: string;
          recipient_user_id: string;
          command_semantic_sha256: `sha256:${string}`;
          challenge_attempt_id: string;
          connection_id: string;
          person_session_sha256: `sha256:${string}`;
          organization_tool_sha256: `sha256:${string}`;
          created_at: string;
          expires_at: string;
          challenge_message_ts: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    if (row.command_semantic_sha256 !== input.request_sha256) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack begin request ID was reused with different input",
      );
    }
    if (
      row.person_session_sha256 !== personSessionSha256(input.person_session) ||
      !this.matchesChallengeTool(row, input.organization_tool)
    ) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack begin replay no longer matches the current session or tool",
      );
    }
    if (row.challenge_message_ts === null) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge is still being posted",
      );
    }
    return Object.freeze({
      challenge_attempt_id: row.challenge_attempt_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      channel_id: row.dm_channel_id,
      recipient_user_id: row.recipient_user_id,
      replayed: true,
      challenge_message_ts: row.challenge_message_ts,
    });
  }

  admitPersonSlackIdentityLinkDelivery(input: {
    person_session: PersonSlackIdentityLinkSession;
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): void {
    this.requireSameActiveTool(input.organization_tool);
    this.admitDeliveryCooldown(input.person_session.membership_id, input.now);
  }

  beginPersonSlackIdentityLinkChallenge(
    input: BeginPersonSlackIdentityLinkChallengeInput,
  ): BegunSlackIdentityLinkChallenge & {
    readonly replayed?: boolean;
    readonly challenge_message_ts?: string;
  } {
    const requestId = (
      input as BeginPersonSlackIdentityLinkChallengeInput & {
        request_id?: string;
      }
    ).request_id;
    if (requestId === undefined) {
      throw new Error("Person Slack identity-link begin requires a request ID");
    }
    return this.transaction(() => {
      const replay = this.personSlackIdentityLinkBeginReplay({
        request_id: requestId,
        request_sha256: input.request_sha256,
        person_session: input.person_session,
        organization_tool: input.organization_tool,
      });
      if (replay !== null) {
        return replay;
      }
      const active = this.requireSameActiveTool(input.organization_tool);
      this.admitDeliveryCooldown(input.person_session.membership_id, input.now);
      const challengeAttemptId = `cat_${randomUUID()}`;
      const expiresAt = offsetTime(input.now, CHALLENGE_LIFETIME_MS);
      this.options.database
        .prepare(
          `UPDATE organization_person_slack_link_challenges
           SET status = 'expired', completed_at = ?
           WHERE membership_id = ? AND status = 'pending'`,
        )
        .run(input.now, input.person_session.membership_id);
      this.options.database
        .prepare(
          `INSERT INTO organization_person_slack_link_challenges (
           dm_channel_id, recipient_user_id, challenge_attempt_id, connection_id, principal_id, membership_id,
           challenge_code_sha256, person_session_sha256, organization_tool_sha256,
           status, completion_sha256, challenge_message_ts, reply_message_ts,
           created_at, expires_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          input.channel_id,
          input.recipient_user_id,
          challengeAttemptId,
          active.connection.connection_id,
          input.person_session.principal_id,
          input.person_session.membership_id,
          input.challenge_code_sha256,
          personSessionSha256(input.person_session),
          toolSha256(challengeAttemptId, input.organization_tool),
          input.now,
          expiresAt,
        );
      this.options.database
        .prepare(
          `INSERT INTO organization_person_slack_link_commands
           (command_id, command_kind, command_semantic_sha256, challenge_attempt_id, created_at)
           VALUES (?, 'begin', ?, ?, ?)`,
        )
        .run(requestId, input.request_sha256, challengeAttemptId, input.now);
      return Object.freeze({
        challenge_attempt_id: challengeAttemptId,
        channel_id: input.channel_id,
        recipient_user_id: input.recipient_user_id,
        created_at: input.now,
        expires_at: expiresAt,
      });
    });
  }

  recordPersonSlackIdentityLinkChallengeMessage(input: {
    challenge_attempt_id: string;
    challenge_message_ts: string;
  }): void {
    const recorded = this.options.database
      .prepare(
        `UPDATE organization_person_slack_link_challenges
         SET challenge_message_ts = ?
         WHERE challenge_attempt_id = ? AND status = 'pending'
           AND challenge_message_ts IS NULL`,
      )
      .run(input.challenge_message_ts, input.challenge_attempt_id);
    if (recorded.changes !== 1) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge could not record its posted message",
      );
    }
  }

  personSlackIdentityLinkChallenge(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    person_session: PersonSlackIdentityLinkSession;
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): PendingPersonSlackIdentityLinkChallenge {
    const row = this.challenge(input.challenge_attempt_id);
    if (row.status === "pending" && input.now >= row.expires_at) {
      this.failSlackIdentityLinkChallenge(input.challenge_attempt_id, input.now);
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge expired",
      );
    }
    if (
      row.status !== "pending" ||
      row.challenge_code_sha256 !== input.challenge_code_sha256 ||
      row.person_session_sha256 !== personSessionSha256(input.person_session) ||
      row.organization_tool_sha256 !==
        toolSha256(input.challenge_attempt_id, input.organization_tool) ||
      row.principal_id !== input.person_session.principal_id ||
      row.membership_id !== input.person_session.membership_id ||
      !sameTool(input.organization_tool, this.activeSlackOrganizationTool())
    ) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge does not match this session",
      );
    }
    return Object.freeze({
      challenge_attempt_id: row.challenge_attempt_id,
      channel_id: row.dm_channel_id,
      recipient_user_id: row.recipient_user_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  }

  failSlackIdentityLinkChallenge(
    challengeAttemptId: string,
    failedAt: string,
  ): void {
    this.options.database
      .prepare(
        `UPDATE organization_person_slack_link_challenges
       SET status = 'expired', completed_at = ?
       WHERE challenge_attempt_id = ? AND status = 'pending'`,
      )
      .run(failedAt, challengeAttemptId);
  }

  personSlackIdentityLinkCompletionReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): CompletedPersonSlackIdentityLink | null {
    const command = this.options.database
      .prepare(
        `SELECT command_semantic_sha256, challenge_attempt_id
         FROM organization_person_slack_link_commands
         WHERE command_id = ? AND command_kind = 'completion'`,
      )
      .get(commandId) as
      | {
          command_semantic_sha256: `sha256:${string}`;
          challenge_attempt_id: string;
        }
      | undefined;
    if (command === undefined) return null;
    if (command.command_semantic_sha256 !== commandSha256) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack completion request ID was reused with different input",
      );
    }
    const tool = this.activeSlackOrganizationTool();
    if (tool === null) {
      throw new PersonSlackIdentityLinkConflictError(
        "Slack is not active for this organization",
      );
    }
    return this.completedResult(command.challenge_attempt_id, tool);
  }

  personSlackIdentityLinkChallengeCompletionReplay(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    challenge_message_ts: string;
    person_session: PersonSlackIdentityLinkSession;
    organization_tool: ActiveSlackOrganizationTool;
  }): CompletedPersonSlackIdentityLink | null {
    const row = this.challenge(input.challenge_attempt_id);
    if (row.status !== "completed") return null;
    if (row.completion_sha256 !== completionSha256(input)) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge was completed with different input",
      );
    }
    return this.completedResult(
      input.challenge_attempt_id,
      input.organization_tool,
    );
  }

  completePersonSlackIdentityLinkChallenge(
    input: CompletePersonSlackIdentityLinkChallengeInput,
  ): CompletedPersonSlackIdentityLink {
    const destination = this.challenge(input.challenge_attempt_id);
    if (
      input.observed.team_id !== input.organization_tool.team_id ||
      input.observed.channel_id !== destination.dm_channel_id ||
      input.observed.user_id !== destination.recipient_user_id ||
      input.challenge_message_ts !== destination.challenge_message_ts ||
      input.observed.challenge_message_ts !== input.challenge_message_ts
    ) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link evidence is inconsistent",
      );
    }
    const replay = this.personSlackIdentityLinkChallengeCompletionReplay(input);
    if (replay !== null) return replay;
    this.personSlackIdentityLinkChallenge({ ...input, now: input.now });

    return this.transaction(() => {
      const currentReplay =
        this.personSlackIdentityLinkChallengeCompletionReplay(input);
      if (currentReplay !== null) return currentReplay;
      this.requireSameActiveTool(input.organization_tool);
      const row = this.challenge(input.challenge_attempt_id);
      if (row.status !== "pending") {
        throw new PersonSlackIdentityLinkConflictError(
          "Person Slack identity link challenge cannot be completed",
        );
      }
      this.upsertExternalHumanLink({
        verification_event_id: input.challenge_attempt_id,
        person_session: input.person_session,
        organization_tool: input.organization_tool,
        provider_subject_id: input.observed.user_id,
        verification_evidence_sha256: input.observed.verification_evidence_sha256,
        now: input.now,
      });
      const completed = this.options.database
        .prepare(
          `UPDATE organization_person_slack_link_challenges
         SET status = 'completed', completion_sha256 = ?, challenge_message_ts = ?,
             reply_message_ts = ?, completed_at = ?
         WHERE challenge_attempt_id = ? AND status = 'pending'`,
        )
        .run(
          completionSha256(input),
          input.challenge_message_ts,
          input.observed.reply_message_ts,
          input.now,
          input.challenge_attempt_id,
        );
      if (completed.changes !== 1) {
        throw new PersonSlackIdentityLinkConflictError(
          "Person Slack identity link challenge lost its completion race",
        );
      }
      this.options.database
        .prepare(
          `INSERT INTO organization_person_slack_link_commands
           (command_id, command_kind, command_semantic_sha256, challenge_attempt_id, created_at)
           VALUES (?, 'completion', ?, ?, ?)`,
        )
        .run(
          input.command_id,
          input.command_sha256,
          input.challenge_attempt_id,
          input.now,
        );
      return this.completedResult(
        input.challenge_attempt_id,
        input.organization_tool,
      );
    });
  }

  /** Browser OAuth proof is ephemeral; only this established durable link is stored. */
  completeBrowserSlackIdentityLink(input: CompleteBrowserSlackIdentityLinkInputV1): void {
    this.transaction(() => {
      const active = this.requireSameActiveTool(input.organization_tool);
      if (active.connection.provider_tenant_id !== input.organization_tool.team_id) {
        throw new PersonSlackIdentityLinkConflictError("active Slack connection changed");
      }
      this.upsertExternalHumanLink({
        verification_event_id: input.attempt_id,
        person_session: input.person_session,
        organization_tool: input.organization_tool,
        provider_subject_id: input.provider_subject_id,
        verification_evidence_sha256: input.verification_evidence_sha256,
        now: input.now,
      });
    });
  }

  /** Revokes only this Person's active Slack association and pending DM proofs. */
  disconnectPersonSlackIdentity(input: {
    readonly person_session: PersonSlackIdentityLinkSession;
    readonly now: string;
  }): readonly OrganizationPersonToolV2[] {
    return this.transaction(() => {
      const active = this.activeConnection();
      if (active === null) return this.personTools(input.person_session);
      this.options.database
        .prepare(
          `UPDATE organization_external_human_link_current
           SET current_status = 'revoked', updated_at = ?
           WHERE principal_id = ? AND membership_id = ?
             AND provider_issuer = 'https://slack.com'
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
             AND current_status = 'active'`,
        )
        .run(
          input.now,
          input.person_session.principal_id,
          input.person_session.membership_id,
          active.tool.team_id,
          active.tool.enterprise_id,
        );
      this.options.database
        .prepare(
          `UPDATE organization_person_slack_link_challenges
           SET status = 'expired', completed_at = ?
           WHERE membership_id = ? AND connection_id = ? AND status = 'pending'`,
        )
        .run(input.now, input.person_session.membership_id, active.connection.connection_id);
      return this.personTools(input.person_session);
    });
  }

  async readSlackToken(
    tool: ActiveSlackOrganizationTool,
    options?: { readonly force_refresh?: boolean },
  ): Promise<string> {
    const active = this.activeConnectionFor(tool);
    if (active === null) {
      throw new Error("active Slack credential is unavailable");
    }
    return await this.options.slack_token_access.readActiveSlackBotToken(
      active.stored,
      options,
    );
  }

  /** Reports only the connection the tool still names; otherwise nothing. */
  reportSlackTokenRejected(tool: ActiveSlackOrganizationTool): void {
    const active = this.activeConnectionFor(tool);
    if (active !== null) this.options.slack_token_access.onActiveSlackBotTokenRejected(active.stored);
  }

  /** True only while the connection the tool still names is marked. */
  slackTokenRejected(tool: ActiveSlackOrganizationTool): boolean {
    const active = this.activeConnectionFor(tool);
    return active !== null && this.options.slack_token_access.isActiveSlackBotTokenRejected(active.stored);
  }

  /** The active connection, only while the tool still names it. */
  private activeConnectionFor(
    tool: ActiveSlackOrganizationTool,
  ): ActiveSlackConnection | null {
    const active = this.activeConnection();
    return active === null || tool.connection_id !== active.connection.connection_id
      ? null
      : active;
  }

  private membershipType(
    session: PersonSlackIdentityLinkSession,
  ): "employee" | "owner" {
    return this.options.membership_type({
      principal_id: session.principal_id,
      membership_id: session.membership_id,
    });
  }

  private upsertExternalHumanLink(input: {
    readonly verification_event_id: string;
    readonly person_session: PersonSlackIdentityLinkSession;
    readonly organization_tool: ActiveSlackOrganizationTool;
    readonly provider_subject_id: string;
    readonly verification_evidence_sha256: `sha256:${string}`;
    readonly now: string;
  }): void {
    const active = this.requireSameActiveTool(input.organization_tool);
    const member = this.options.database.prepare(`SELECT external_identity_link_id, principal_id, membership_id, provider_subject_id
      FROM organization_external_human_link_current WHERE membership_id = ? AND provider_issuer = 'https://slack.com'
      AND provider_tenant_kind = 'workspace' AND provider_tenant_id = ?
      AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '') AND current_status = 'active'`).get(
      input.person_session.membership_id, active.connection.provider_tenant_id, active.connection.provider_enterprise_id,
    ) as { external_identity_link_id: string; principal_id: string; membership_id: string; provider_subject_id: string } | undefined;
    const subject = this.options.database.prepare(`SELECT external_identity_link_id, principal_id, membership_id, provider_subject_id
      FROM organization_external_human_link_current WHERE provider_issuer = 'https://slack.com' AND provider_tenant_kind = 'workspace'
      AND provider_tenant_id = ? AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '') AND provider_subject_id = ?
      AND current_status = 'active'`).get(
      active.connection.provider_tenant_id, active.connection.provider_enterprise_id, input.provider_subject_id,
    ) as { external_identity_link_id: string; principal_id: string; membership_id: string; provider_subject_id: string } | undefined;
    if ((member !== undefined && member.provider_subject_id !== input.provider_subject_id) ||
      (subject !== undefined && (subject.principal_id !== input.person_session.principal_id || subject.membership_id !== input.person_session.membership_id)) ||
      (member !== undefined && subject !== undefined && member.external_identity_link_id !== subject.external_identity_link_id)) {
      throw new PersonSlackIdentityLinkConflictError("Slack identity is already linked to another active membership");
    }
    const existing = member ?? subject;
    const externalIdentityLinkId = existing?.external_identity_link_id ?? identityLinkId(input.verification_event_id);
    const contract = buildExternalHumanIdentityLinkContractV2({
      authority_id: this.options.authority_id, organization_id: this.options.organization_id, state_lineage_id: this.options.state_lineage_id,
      external_identity_link_id: externalIdentityLinkId, provider_issuer: "https://slack.com", provider_tenant_kind: "workspace",
      provider_tenant_id: active.connection.provider_tenant_id, provider_enterprise_id: active.connection.provider_enterprise_id,
      provider_subject_id: input.provider_subject_id, principal_id: input.person_session.principal_id, membership_id: input.person_session.membership_id,
      membership_type: this.membershipType(input.person_session), verification_event_id: input.verification_event_id,
      verification_evidence_sha256: input.verification_evidence_sha256, verified_at: input.now,
    });
    const contractSha256 = canonicalSha256(contract);
    this.options.database.prepare(`INSERT INTO organization_external_human_link_contracts
      (external_identity_link_id, contract_sha256, contract_json, created_at) VALUES (?, ?, ?, ?)`).run(
      externalIdentityLinkId, contractSha256, canonicalJson(contract), input.now,
    );
    if (existing === undefined) {
      this.options.database.prepare(`INSERT INTO organization_external_human_link_current
        (external_identity_link_id, contract_sha256, provider_issuer, provider_tenant_kind, provider_tenant_id,
         provider_enterprise_id, provider_subject_id, principal_id, membership_id, current_status, updated_at)
        VALUES (?, ?, 'https://slack.com', 'workspace', ?, ?, ?, ?, ?, 'active', ?)`).run(
        externalIdentityLinkId, contractSha256, active.connection.provider_tenant_id, active.connection.provider_enterprise_id,
        input.provider_subject_id, input.person_session.principal_id, input.person_session.membership_id, input.now,
      );
    } else {
      this.options.database.prepare(`UPDATE organization_external_human_link_current SET contract_sha256 = ?, updated_at = ?
        WHERE external_identity_link_id = ?`).run(contractSha256, input.now, externalIdentityLinkId);
    }
  }

  private completedResult(
    challengeAttemptId: string,
    tool: ActiveSlackOrganizationTool,
  ): CompletedPersonSlackIdentityLink {
    const challenge = this.challenge(challengeAttemptId);
    if (!this.matchesChallengeTool(challenge, tool)) {
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack replay no longer matches the current tool",
      );
    }
    const row = this.options.database
      .prepare(
        `SELECT contract_json FROM organization_external_human_link_contracts
       WHERE json_extract(contract_json, '$.verification_event_id') = ?`,
      )
      .get(challengeAttemptId) as { contract_json: string } | undefined;
    if (row === undefined)
      throw new Error(
        "stored Person Slack identity link completion is missing",
      );
    const contract = validateExternalHumanIdentityLinkContractV2(
      JSON.parse(row.contract_json),
    );
    const current = this.options.database.prepare(`SELECT 1 FROM organization_external_human_link_current
      WHERE external_identity_link_id = ? AND principal_id = ? AND membership_id = ?
      AND provider_subject_id = ? AND current_status = 'active'`).get(contract.external_identity_link_id,
        contract.principal_id, contract.membership_id, contract.provider_subject_id);
    if (current === undefined) throw new PersonSlackIdentityLinkConflictError("The Slack identity link is no longer active");
    return Object.freeze({
      schema_version: 2,
      kind: "echo-organization-person-slack-link-result",
      identity_link_id: contract.external_identity_link_id,
      connection_id: tool.connection_id,
      organization_id: contract.organization_id,
      principal_id: contract.principal_id,
      membership_id: contract.membership_id,
      provider: "slack",
      provider_tenant_id: contract.provider_tenant_id,
      provider_subject_id: contract.provider_subject_id,
      channel_id: challenge.dm_channel_id,
      linked_at: contract.verified_at,
      identity_link_created:
        contract.external_identity_link_id ===
        identityLinkId(challengeAttemptId),
    });
  }

  private challenge(challengeAttemptId: string): ChallengeRow {
    const row = this.options.database
      .prepare(
        `SELECT dm_channel_id, recipient_user_id, challenge_attempt_id, connection_id, principal_id, membership_id,
              challenge_code_sha256, person_session_sha256, organization_tool_sha256,
              status, completion_sha256, challenge_message_ts, reply_message_ts,
              created_at, expires_at
       FROM organization_person_slack_link_challenges WHERE challenge_attempt_id = ?`,
      )
      .get(challengeAttemptId) as ChallengeRow | undefined;
    if (row === undefined)
      throw new PersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge was not found",
      );
    return row;
  }

  private matchesChallengeTool(
    challenge: Pick<
      ChallengeRow,
      "challenge_attempt_id" | "connection_id" | "organization_tool_sha256"
    >,
    tool: ActiveSlackOrganizationTool,
  ): boolean {
    return (
      challenge.connection_id === tool.connection_id &&
      challenge.organization_tool_sha256 ===
        toolSha256(challenge.challenge_attempt_id, tool)
    );
  }

  private requireSameActiveTool(
    tool: ActiveSlackOrganizationTool,
  ): ActiveSlackConnection {
    const active = this.activeConnection();
    if (active === null || !sameTool(tool, active.tool)) {
      throw new PersonSlackIdentityLinkConflictError(
        "active Slack connection changed",
      );
    }
    return active;
  }

  private admitDeliveryCooldown(membershipId: string, now: string): void {
    const recent = this.options.database
      .prepare(
        `SELECT 1 FROM organization_person_slack_link_challenges
         WHERE membership_id = ? AND created_at > ? LIMIT 1`,
      )
      .get(membershipId, offsetTime(now, -DELIVERY_ADMISSION_COOLDOWN_MS));
    if (recent !== undefined) {
      throw new PersonSlackIdentityLinkConflictError(
        "A Slack identity-link challenge was requested recently; try again shortly",
      );
    }
  }

  private activeConnection(): ActiveSlackConnection | null {
    const stored = readActiveSlackConnectionV1(this.options.database, this.options);
    if (stored === undefined) return null;
    const { connection, state } = stored;
    return Object.freeze({
      connection,
      state,
      stored,
      tool: Object.freeze({
        connection_id: connection.connection_id,
        team_id: connection.provider_tenant_id,
        enterprise_id: connection.provider_enterprise_id,
        bot_user_id: connection.provider_bot_user_id,
        bot_id: connection.provider_bot_id,
        app_id: connection.provider_app_id,
      }),
    });
  }

  private transaction<T>(operation: () => T): T {
    this.options.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.options.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.options.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}

/** Creates the SQLite-backed workflow for Slack external-identity routes. */
export function createSqliteSlackPersonIdentityLinkWorkflowV1(
  input: CreateSqliteSlackPersonIdentityLinkWorkflowV1Input,
): SlackPersonIdentityLinkWorkflowV1 {
  const repository = createSqliteSlackPersonIdentityLinkRepositoryV1(input);
  return new SlackPersonIdentityLinkWorkflowV1({
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    authentication: input.authentication,
    repository,
    slack: input.slack,
    authorization_fence: input.authorization_fence,
    invalidate_browser_attempts: input.invalidate_browser_attempts,
    now: input.now,
  });
}

/** Shared durable-link repository for the DM and browser proof flows. */
export function createSqliteSlackPersonIdentityLinkRepositoryV1(
  input: CreateSqliteSlackPersonIdentityLinkWorkflowV1Input,
): SqliteSlackPersonIdentityLinkRepositoryV1 {
  return new SqliteSlackPersonIdentityLinkRepositoryV1(input);
}
