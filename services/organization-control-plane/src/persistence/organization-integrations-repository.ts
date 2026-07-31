import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  SLACK_DEFAULT_APPROVE_REACTION,
  SLACK_DEFAULT_REJECT_REACTION,
  SLACK_ORGANIZATION_TOOL_PROFILE,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  SLACK_PROVIDER,
  SLACK_PROVIDER_ISSUER,
  type ActiveSlackOrganizationTool,
  type BeginSlackIdentityLinkChallengeInput,
  type BegunSlackIdentityLinkChallenge,
  type LegacySlackOrganizationTool,
  type BootstrapSlackApprovalInput,
  type BootstrapSlackApprovalResult,
  type CompleteSlackIdentityLinkChallengeInput,
  type CompletedSlackIdentityLink,
  type OnboardSlackOrganizationToolInput,
  type OnboardSlackOrganizationToolResult,
  type OrganizationIntegrationsOverview,
  type RecordPermissionDecisionInput,
  type RecordedPermissionDecision,
  type SlackApprovalPermissionCandidate,
  type SlackApprovalPermissionLookup,
  type OrganizationSecretReference,
  type PendingSlackIdentityLinkChallenge,
} from "../application/contracts.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../canonical/canonical-json.js";

interface AuditTail {
  audit_sequence: number;
  entry_sha256: string;
}

interface AuditReplayRow {
  detail_json: string;
}

interface ToolConnectionOverviewRow extends Record<string, unknown> {
  public_configuration_json: string;
  public_configuration_sha256: string;
}

interface ActiveSlackOrganizationToolRow extends ToolConnectionOverviewRow {
  connection_id: string;
  verification_attempt_id: string;
  activated_at: string;
  provider_tenant_id: string;
  provider_subject_id: string;
  granted_scopes_json: string;
  granted_scopes_sha256: string;
  secret_backend_id: string;
  secret_handle_id: string;
}

interface SlackIdentityLinkAttemptRow {
  connection_attempt_id: string;
  requested_by_principal_id: string;
  requested_by_membership_id: string;
  target_principal_id: string;
  target_membership_id: string;
  provider_tenant_id: string;
  state_sha256: string;
  pkce_challenge_sha256: string;
  admin_session_sha256: string;
  status: "pending" | "succeeded" | "failed" | "expired";
  created_at: string;
  expires_at: string;
}

interface ActiveSlackIdentityLinkRow {
  identity_link_id: string;
  principal_id: string;
  membership_id: string;
  provider_subject_id: string;
}

interface ActiveSlackBindingRow {
  adapter_binding_id: string;
  installation_id: string;
  installation_key_id: string;
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  connection_id: string;
  public_configuration_json: string;
  public_configuration_sha256: string;
}

interface SlackIdentityLinkCompletionReplayKey {
  challenge_attempt_id: string;
  challenge_code_sha256: `sha256:${string}`;
  challenge_message_ts: string;
  installation: BeginSlackIdentityLinkChallengeInput["installation"];
  organization_tool: ActiveSlackOrganizationTool;
  adapter_id: "slack-reactions";
  adapter_instance_id: string;
  adapter_version: string;
}

interface CompleteSlackConnectionAttemptInput {
  attempt_id: string;
  administrator_principal_id: string;
  administrator_membership_id: string;
  purpose: "identity_link" | "tool_connection";
  owner_kind: "membership" | "organization";
  target_principal_id: string | null;
  target_membership_id: string | null;
  team_id: string;
  redirect_uri: string;
  scopes_json: string;
  scopes_sha256: string;
  subject_kind: "human_user" | "service_account";
  subject_id: string;
  evidence_sha256: string;
  command_id: string;
  digest_prefix: "" | "identity-";
  now: string;
  expires_at: string;
}

export class OrganizationIntegrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationIntegrationConflictError";
  }
}

/**
 * Strings are hashed as their own bytes rather than as canonical JSON. Live
 * `state_sha256`, `nonce_sha256`, `pkce_challenge_sha256`,
 * `admin_session_sha256` and `public_configuration_sha256` values were written
 * that way; quoting them here would break every stored digest.
 */
function digest(value: unknown): `sha256:${string}` {
  return typeof value === "string"
    ? sha256Digest(value)
    : canonicalSha256(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function addMinutes(value: string, minutes: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("organization integration timestamp is invalid");
  }
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function validatedPublicConfiguration(
  row: ToolConnectionOverviewRow,
): Record<string, unknown> {
  let parsed: unknown;
  let canonical: string;
  try {
    parsed = JSON.parse(row.public_configuration_json);
    canonical = canonicalJson(parsed);
  } catch {
    throw new Error("stored organization tool configuration is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    canonical !== row.public_configuration_json ||
    digest(row.public_configuration_json) !== row.public_configuration_sha256
  ) {
    throw new Error("stored organization tool configuration is invalid");
  }
  return parsed as Record<string, unknown>;
}

function validatedSlackToolData(
  row: ActiveSlackOrganizationToolRow,
  error: string,
): {
  configuration: Record<string, unknown>;
  scopes: readonly string[];
} {
  const configuration = validatedPublicConfiguration(row);
  let scopes: unknown;
  let canonicalScopes: string;
  try {
    scopes = JSON.parse(row.granted_scopes_json);
    canonicalScopes = canonicalJson(scopes);
  } catch {
    throw new Error(error);
  }
  if (
    row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string") ||
    canonicalScopes !== row.granted_scopes_json ||
    digest(scopes) !== row.granted_scopes_sha256
  ) {
    throw new Error(error);
  }
  return { configuration, scopes: Object.freeze(scopes) };
}

function hasSlackOrganizationToolScopes(scopes: readonly string[]): boolean {
  const observed = new Set(scopes);
  return SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.every((scope) =>
    observed.has(scope),
  );
}

function assertBootstrapUsesActiveOrganizationTool(
  input: BootstrapSlackApprovalInput,
  active: ActiveSlackOrganizationTool | null,
): asserts active is ActiveSlackOrganizationTool {
  if (
    active === null ||
    active.connection_id !== input.organization_connection_id ||
    active.team_id !== input.connection.team_id ||
    active.enterprise_id !== input.connection.enterprise_id ||
    active.bot_user_id !== input.connection.bot_user_id ||
    active.bot_id !== input.connection.bot_id ||
    active.app_id !== input.connection.app_id ||
    active.channel_id !== input.channel_id ||
    active.channel_id !== input.channel.channel_id ||
    input.channel.team_id !== active.team_id ||
    canonicalJson([...active.granted_scopes].sort()) !==
      canonicalJson([...input.connection.granted_scopes].sort())
  ) {
    throw new Error(
      "Slack bootstrap must use the active organization Slack tool",
    );
  }
}

function slackIdentityLinkSessionSha256(
  input: BeginSlackIdentityLinkChallengeInput["installation"],
): `sha256:${string}` {
  return digest({
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_key_id,
  });
}

function slackIdentityLinkToolSha256(
  challengeAttemptId: string,
  tool: ActiveSlackOrganizationTool,
): `sha256:${string}` {
  return digest({
    challenge_attempt_id: challengeAttemptId,
    connection_id: tool.connection_id,
    team_id: tool.team_id,
    enterprise_id: tool.enterprise_id,
    bot_user_id: tool.bot_user_id,
    bot_id: tool.bot_id,
    app_id: tool.app_id,
    channel_id: tool.channel_id,
    approve_reaction: tool.approve_reaction,
    reject_reaction: tool.reject_reaction,
  });
}

function slackIdentityLinkCompletionSha256(
  input: SlackIdentityLinkCompletionReplayKey,
): `sha256:${string}` {
  return digest({
    challenge_attempt_id: input.challenge_attempt_id,
    challenge_code_sha256: input.challenge_code_sha256,
    challenge_message_ts: input.challenge_message_ts,
    installation_sha256: slackIdentityLinkSessionSha256(input.installation),
    organization_tool_sha256: slackIdentityLinkToolSha256(
      input.challenge_attempt_id,
      input.organization_tool,
    ),
    adapter_id: input.adapter_id,
    adapter_instance_id: input.adapter_instance_id,
    adapter_version: input.adapter_version,
  });
}

function slackApprovalBindingConfiguration(
  tool: ActiveSlackOrganizationTool,
): Record<string, unknown> {
  return {
    approve_reaction: tool.approve_reaction,
    channel_id: tool.channel_id,
    reject_reaction: tool.reject_reaction,
    slack_app_id: tool.app_id,
    slack_bot_id: tool.bot_id,
    slack_bot_user_id: tool.bot_user_id,
    slack_enterprise_id: tool.enterprise_id,
  };
}

export class OrganizationIntegrationsRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly identity: {
      organization_id: string;
      authority_id: string;
    },
  ) {
    const metadata = database
      .prepare(
        `SELECT organization_id, authority_id
         FROM organization_control_plane_metadata
         WHERE singleton = 1`,
      )
      .get() as { organization_id: string; authority_id: string } | undefined;
    if (
      metadata === undefined ||
      metadata.organization_id !== identity.organization_id ||
      metadata.authority_id !== identity.authority_id
    ) {
      throw new Error(
        "organization integrations database identity does not match the authority",
      );
    }
  }

  bootstrapReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): BootstrapSlackApprovalResult | null {
    return this.replay<BootstrapSlackApprovalResult>(
      commandId,
      commandSha256,
      "slack_approval.bootstrap",
      "Slack bootstrap",
    );
  }

  slackOrganizationToolReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): OnboardSlackOrganizationToolResult | null {
    return this.replay<OnboardSlackOrganizationToolResult>(
      commandId,
      commandSha256,
      "organization_tool.slack.onboarded",
      "Slack organization tool",
    );
  }

  slackIdentityLinkCompletionReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): CompletedSlackIdentityLink | null {
    return this.replay<CompletedSlackIdentityLink>(
      commandId,
      commandSha256,
      "slack_identity_link.completed",
      "Slack identity link completion",
    );
  }

  slackIdentityLinkChallengeCompletionReplay(
    input: SlackIdentityLinkCompletionReplayKey,
  ): CompletedSlackIdentityLink | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM organization_integration_audit
         WHERE correlation_id = ?
           AND action = 'slack_identity_link.completed'
           AND outcome = 'succeeded'`,
      )
      .get(input.challenge_attempt_id) as AuditReplayRow | undefined;
    if (row === undefined) return null;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    if (
      detail["completion_sha256"] !==
      slackIdentityLinkCompletionSha256(input)
    ) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link challenge was completed with different input",
      );
    }
    const result = detail["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("stored Slack identity link audit result is invalid");
    }
    return result as CompletedSlackIdentityLink;
  }

  private replay<T>(
    commandId: string,
    commandSha256: `sha256:${string}`,
    action: string,
    label: string,
  ): T | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM organization_integration_audit
         WHERE command_id = ? AND action = ?`,
      )
      .get(commandId, action) as AuditReplayRow | undefined;
    if (row === undefined) return null;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    if (detail["command_sha256"] !== commandSha256) {
      throw new Error(
        "organization integration command ID was reused with different input",
      );
    }
    const result = detail["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`stored ${label} audit result is invalid`);
    }
    return result as T;
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private completeSlackConnectionAttempt(
    input: CompleteSlackConnectionAttemptInput,
  ): void {
    this.database
      .prepare(
        `INSERT INTO organization_connection_attempts (
           connection_attempt_id, organization_id,
           requested_by_principal_id, requested_by_membership_id,
           attempt_purpose, target_owner_kind, target_principal_id,
           target_membership_id, provider, provider_issuer,
           provider_tenant_kind, provider_tenant_id, redirect_uri,
           requested_scopes_json, requested_scopes_sha256, state_sha256,
           nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
           provider_subject_kind, provider_subject_id, granted_scopes_json,
           granted_scopes_sha256, verification_evidence_sha256, created_at,
           expires_at, consumed_at, outcome_reason
         ) VALUES (
           @attempt_id, @organization_id, @administrator_principal_id,
           @administrator_membership_id, @purpose, @owner_kind,
           @target_principal_id, @target_membership_id, @provider,
           @provider_issuer, 'workspace', @team_id, @redirect_uri,
           @scopes_json, @scopes_sha256, @state_sha256, @nonce_sha256,
           @pkce_sha256, @admin_session_sha256, 'pending',
           NULL, NULL, NULL, NULL, NULL, @now, @expires_at, NULL, NULL
         )`,
      )
      .run({
        ...input,
        organization_id: this.identity.organization_id,
        provider: SLACK_PROVIDER,
        provider_issuer: SLACK_PROVIDER_ISSUER,
        state_sha256: digest(
          `${input.digest_prefix}state:${input.command_id}`,
        ),
        nonce_sha256: digest(
          `${input.digest_prefix}nonce:${input.command_id}`,
        ),
        pkce_sha256: digest(`${input.digest_prefix}pkce:${input.command_id}`),
        admin_session_sha256: digest(`admin:${input.command_id}`),
      });
    this.database
      .prepare(
        `UPDATE organization_connection_attempts
         SET status = 'succeeded', provider_subject_kind = @subject_kind,
             provider_subject_id = @subject_id,
             granted_scopes_json = @scopes_json,
             granted_scopes_sha256 = @scopes_sha256,
             verification_evidence_sha256 = @evidence_sha256,
             consumed_at = @now
         WHERE connection_attempt_id = @attempt_id`,
      )
      .run(input);
  }

  private slackOrganizationToolRow():
    | ActiveSlackOrganizationToolRow
    | undefined {
    return this.database
      .prepare(
        `SELECT connection_id, verification_attempt_id, activated_at,
                provider_tenant_id, provider_subject_id, granted_scopes_json,
                granted_scopes_sha256, secret_backend_id, secret_handle_id,
                public_configuration_json, public_configuration_sha256
         FROM organization_tool_connections
         WHERE organization_id = ?
           AND provider = ?
           AND provider_issuer = ?
           AND provider_tenant_kind = 'workspace'
           AND provider_subject_kind = 'service_account'
           AND owner_kind = 'organization'
           AND status = 'active'`,
      )
      .get(
        this.identity.organization_id,
        SLACK_PROVIDER,
        SLACK_PROVIDER_ISSUER,
      ) as ActiveSlackOrganizationToolRow | undefined;
  }

  activeSlackOrganizationTool(): ActiveSlackOrganizationTool | null {
    const row = this.slackOrganizationToolRow();
    if (row === undefined) return null;
    const { configuration, scopes } = validatedSlackToolData(
      row,
      "stored Slack organization tool is invalid",
    );
    if (
      configuration["organization_tool_profile"] !==
      SLACK_ORGANIZATION_TOOL_PROFILE
    ) {
      return null;
    }
    if (
      !hasSlackOrganizationToolScopes(scopes) ||
      configuration["schema_version"] !== 1 ||
      typeof configuration["channel_id"] !== "string" ||
      typeof configuration["slack_bot_id"] !== "string" ||
      typeof configuration["approve_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["approve_reaction"]) ||
      typeof configuration["reject_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["reject_reaction"]) ||
      configuration["approve_reaction"] ===
        configuration["reject_reaction"] ||
      configuration["slack_bot_user_id"] !== row.provider_subject_id ||
      !(
        configuration["slack_enterprise_id"] === null ||
        typeof configuration["slack_enterprise_id"] === "string"
      ) ||
      !(
        configuration["slack_app_id"] === null ||
        typeof configuration["slack_app_id"] === "string"
      )
    ) {
      throw new Error("stored Slack organization tool is invalid");
    }
    return Object.freeze({
      connection_attempt_id: row.verification_attempt_id,
      connection_id: row.connection_id,
      team_id: row.provider_tenant_id,
      enterprise_id: configuration["slack_enterprise_id"],
      bot_user_id: row.provider_subject_id,
      bot_id: configuration["slack_bot_id"],
      app_id: configuration["slack_app_id"],
      channel_id: configuration["channel_id"],
      approve_reaction: configuration["approve_reaction"],
      reject_reaction: configuration["reject_reaction"],
      granted_scopes: scopes,
      secret: Object.freeze({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: row.secret_handle_id,
      }),
    });
  }

  beginSlackIdentityLinkChallenge(
    input: BeginSlackIdentityLinkChallengeInput,
  ): BegunSlackIdentityLinkChallenge {
    if (
      input.installation.organization_id !== this.identity.organization_id ||
      input.installation.authority_id !== this.identity.authority_id ||
      input.organization_tool.team_id.length === 0
    ) {
      throw new Error("Slack identity link installation is inconsistent");
    }
    const requestedScopes = ["users:read"];
    const requestedScopesJson = canonicalJson(requestedScopes);
    const requestedScopesSha256 = digest(requestedScopes);
    const expiresAt = addMinutes(input.now, 15);
    const challengeAttemptId = id("cat");
    return this.immediateTransaction(() => {
      const activeTool = this.activeSlackOrganizationTool();
      if (
        activeTool === null ||
        canonicalJson(activeTool) !==
          canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before link challenge",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT connection_attempt_id
           FROM organization_connection_attempts
           WHERE nonce_sha256 = ?`,
        )
        .get(input.request_sha256) as
        | { connection_attempt_id: string }
        | undefined;
      if (existing !== undefined) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge already started",
        );
      }
      this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'expired', consumed_at = ?,
               outcome_reason = 'superseded_by_new_challenge'
           WHERE organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND target_membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND status = 'pending'`,
        )
        .run(
          input.now,
          this.identity.organization_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        );
      this.database
        .prepare(
          `INSERT INTO organization_connection_attempts (
             connection_attempt_id, organization_id,
             requested_by_principal_id, requested_by_membership_id,
             attempt_purpose, target_owner_kind, target_principal_id,
             target_membership_id, provider, provider_issuer,
             provider_tenant_kind, provider_tenant_id, redirect_uri,
             requested_scopes_json, requested_scopes_sha256, state_sha256,
             nonce_sha256, pkce_challenge_sha256, admin_session_sha256,
             status, provider_subject_kind, provider_subject_id,
             granted_scopes_json, granted_scopes_sha256,
             verification_evidence_sha256, created_at, expires_at,
             consumed_at, outcome_reason
           ) VALUES (
             ?, ?, ?, ?, 'identity_link', 'membership', ?, ?, ?, ?,
             'workspace', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL,
             NULL, NULL, NULL, ?, ?, NULL, NULL
           )`,
        )
        .run(
          challengeAttemptId,
          this.identity.organization_id,
          input.installation.principal_id,
          input.installation.membership_id,
          input.installation.principal_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          activeTool.team_id,
          "urn:echo:organization:employee:slack-channel-link",
          requestedScopesJson,
          requestedScopesSha256,
          input.challenge_code_sha256,
          input.request_sha256,
          slackIdentityLinkToolSha256(challengeAttemptId, activeTool),
          slackIdentityLinkSessionSha256(input.installation),
          input.now,
          expiresAt,
        );
      return Object.freeze({
        challenge_attempt_id: challengeAttemptId,
        created_at: input.now,
        expires_at: expiresAt,
      });
    });
  }

  slackIdentityLinkChallenge(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    installation: BeginSlackIdentityLinkChallengeInput["installation"];
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): PendingSlackIdentityLinkChallenge {
    const challenge = this.immediateTransaction<
      PendingSlackIdentityLinkChallenge | null
    >(() => {
      const row = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (row === undefined) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge was not found",
        );
      }
      if (row.status === "pending" && input.now >= row.expires_at) {
        this.database
          .prepare(
            `UPDATE organization_connection_attempts
             SET status = 'expired', consumed_at = ?,
                 outcome_reason = 'challenge_expired'
             WHERE connection_attempt_id = ? AND status = 'pending'`,
          )
          .run(input.now, input.challenge_attempt_id);
        return null;
      }
      if (
        row.status !== "pending" ||
        row.requested_by_principal_id !== input.installation.principal_id ||
        row.requested_by_membership_id !== input.installation.membership_id ||
        row.target_principal_id !== input.installation.principal_id ||
        row.target_membership_id !== input.installation.membership_id ||
        row.provider_tenant_id !== input.organization_tool.team_id ||
        row.state_sha256 !== input.challenge_code_sha256 ||
        row.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(
            input.challenge_attempt_id,
            input.organization_tool,
          ) ||
        row.admin_session_sha256 !==
          slackIdentityLinkSessionSha256(input.installation)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge does not match this installation",
        );
      }
      return Object.freeze({
        challenge_attempt_id: row.connection_attempt_id,
        principal_id: row.target_principal_id,
        membership_id: row.target_membership_id,
        installation_id: input.installation.installation_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });
    });
    if (challenge === null) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link challenge expired",
      );
    }
    return challenge;
  }

  failSlackIdentityLinkChallenge(
    challengeAttemptId: string,
    failedAt: string,
    reason: string,
  ): void {
    this.immediateTransaction(() => {
      this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'failed', consumed_at = ?, outcome_reason = ?
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND status = 'pending'`,
        )
        .run(
          failedAt,
          reason,
          challengeAttemptId,
          this.identity.organization_id,
        );
    });
  }

  legacySlackOrganizationTool(): LegacySlackOrganizationTool | null {
    const row = this.slackOrganizationToolRow();
    if (row === undefined) return null;
    const { configuration, scopes } = validatedSlackToolData(
      row,
      "stored legacy Slack organization tool is invalid",
    );
    if (configuration["organization_tool_profile"] !== undefined) {
      return null;
    }
    if (
      Object.keys(configuration).sort().join(",") !==
        [
          "approve_reaction",
          "channel_id",
          "reject_reaction",
          "slack_app_id",
          "slack_bot_id",
          "slack_bot_user_id",
          "slack_enterprise_id",
        ].join(",") ||
      typeof configuration["channel_id"] !== "string" ||
      !/^C[A-Z0-9]{2,}$/.test(configuration["channel_id"]) ||
      typeof configuration["slack_bot_id"] !== "string" ||
      !/^B[A-Z0-9]{2,}$/.test(configuration["slack_bot_id"]) ||
      configuration["slack_bot_user_id"] !== row.provider_subject_id ||
      !/^[UW][A-Z0-9]{2,}$/.test(row.provider_subject_id) ||
      typeof configuration["approve_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["approve_reaction"]) ||
      typeof configuration["reject_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["reject_reaction"]) ||
      configuration["approve_reaction"] ===
        configuration["reject_reaction"] ||
      !(
        configuration["slack_enterprise_id"] === null ||
        (typeof configuration["slack_enterprise_id"] === "string" &&
          /^E[A-Z0-9]{2,}$/.test(configuration["slack_enterprise_id"]))
      ) ||
      !(
        configuration["slack_app_id"] === null ||
        (typeof configuration["slack_app_id"] === "string" &&
          /^A[A-Z0-9]{2,}$/.test(configuration["slack_app_id"]))
      )
    ) {
      throw new Error("stored legacy Slack organization tool is invalid");
    }
    return Object.freeze({
      connection_attempt_id: row.verification_attempt_id,
      connection_id: row.connection_id,
      activated_at: row.activated_at,
      team_id: row.provider_tenant_id,
      enterprise_id: configuration["slack_enterprise_id"],
      bot_user_id: row.provider_subject_id,
      bot_id: configuration["slack_bot_id"],
      app_id: configuration["slack_app_id"],
      channel_id: configuration["channel_id"],
      approve_reaction: configuration["approve_reaction"],
      reject_reaction: configuration["reject_reaction"],
      granted_scopes: scopes,
      secret: Object.freeze({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: row.secret_handle_id,
      }),
    });
  }

  organizationSecretReferences(): readonly Readonly<{
    reference: OrganizationSecretReference;
    active: boolean;
  }>[] {
    const rows = this.database
      .prepare(
        `SELECT secret_backend_id, secret_handle_id, status
         FROM organization_tool_connections
         ORDER BY secret_backend_id, secret_handle_id`,
      )
      .all() as {
      secret_backend_id: string;
      secret_handle_id: string;
      status: string;
    }[];
    return Object.freeze(
      rows.map((row) => {
        if (
          row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
          !/^sch_[0-9a-f-]{36}$/.test(row.secret_handle_id) ||
          (row.status !== "active" && row.status !== "revoked")
        ) {
          throw new Error("stored organization integration secret is invalid");
        }
        return Object.freeze({
          reference: Object.freeze({
            secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
            secret_handle_id: row.secret_handle_id,
          }),
          active: row.status === "active",
        });
      }),
    );
  }

  onboardSlackOrganizationTool(
    input: OnboardSlackOrganizationToolInput,
  ): OnboardSlackOrganizationToolResult {
    const legacy = this.legacySlackOrganizationTool();
    if (
      input.organization_id !== this.identity.organization_id ||
      input.authority_id !== this.identity.authority_id ||
      input.secret.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      input.channel.team_id !== input.connection.team_id ||
      !/^C[A-Z0-9]{2,}$/.test(input.channel.channel_id) ||
      !hasSlackOrganizationToolScopes(input.connection.granted_scopes) ||
      (legacy !== null &&
        (legacy.connection_id.length === 0 ||
          input.secret.secret_handle_id !==
            legacy.secret.secret_handle_id ||
          input.connection.team_id !== legacy.team_id ||
          input.connection.enterprise_id !== legacy.enterprise_id ||
          input.connection.bot_user_id !== legacy.bot_user_id ||
          input.connection.bot_id !== legacy.bot_id ||
          input.connection.app_id !== legacy.app_id ||
          input.channel.channel_id !== legacy.channel_id))
    ) {
      throw new Error("Slack organization tool identities are inconsistent");
    }
    const replay = this.slackOrganizationToolReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;

    const connectionAttemptId = id("cat");
    const connectionId = legacy?.connection_id ?? id("con");
    const expiresAt = addMinutes(input.now, 15);
    const connectionScopes = [...input.connection.granted_scopes].sort();
    const connectionScopesJson = canonicalJson(connectionScopes);
    const connectionScopesSha256 = digest(connectionScopes);
    const publicConfiguration = {
      approve_reaction:
        legacy?.approve_reaction ?? SLACK_DEFAULT_APPROVE_REACTION,
      channel_id: input.channel.channel_id,
      organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
      reject_reaction:
        legacy?.reject_reaction ?? SLACK_DEFAULT_REJECT_REACTION,
      schema_version: 1,
      slack_app_id: input.connection.app_id,
      slack_bot_id: input.connection.bot_id,
      slack_bot_user_id: input.connection.bot_user_id,
      slack_enterprise_id: input.connection.enterprise_id,
    };
    const publicConfigurationJson = canonicalJson(publicConfiguration);
    const publicConfigurationSha256 = digest(publicConfiguration);
    const verificationEvidenceSha256 = digest({
      schema_version: 1,
      connection_evidence_sha256: input.connection.verification_evidence_sha256,
      channel_evidence_sha256: input.channel.verification_evidence_sha256,
      public_configuration_sha256: publicConfigurationSha256,
    });
    const result: OnboardSlackOrganizationToolResult = {
      connection_attempt_id: connectionAttemptId,
      connection_id: connectionId,
      organization_id: input.organization_id,
      provider: SLACK_PROVIDER,
      status: "active",
      slack_team_id: input.connection.team_id,
      slack_bot_user_id: input.connection.bot_user_id,
      channel_id: input.channel.channel_id,
      granted_scopes: Object.freeze(connectionScopes),
      activated_at: legacy?.activated_at ?? input.now,
    };

    return this.immediateTransaction(() => {
      const concurrent = this.slackOrganizationToolReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const existing = this.database
        .prepare(
          `SELECT connection_id
           FROM organization_tool_connections
           WHERE organization_id = ?
             AND provider = ?
             AND owner_kind = 'organization'
             AND status = 'active'`,
        )
        .get(input.organization_id, SLACK_PROVIDER) as
        | { connection_id: string }
        | undefined;
      if (legacy === null && existing !== undefined) {
        throw new Error("Slack organization tool is already active");
      }
      if (legacy !== null && existing?.connection_id !== legacy.connection_id) {
        throw new Error("Slack organization tool state changed during onboarding");
      }

      this.completeSlackConnectionAttempt({
        attempt_id: connectionAttemptId,
        administrator_principal_id: input.administrator_principal_id,
        administrator_membership_id: input.administrator_membership_id,
        purpose: "tool_connection",
        owner_kind: "organization",
        target_principal_id: null,
        target_membership_id: null,
        team_id: input.connection.team_id,
        redirect_uri:
          "urn:echo:organization:admin:slack-tool-onboarding",
        scopes_json: connectionScopesJson,
        scopes_sha256: connectionScopesSha256,
        subject_kind: "service_account",
        subject_id: input.connection.bot_user_id,
        evidence_sha256: verificationEvidenceSha256,
        command_id: input.command_id,
        digest_prefix: "",
        now: input.now,
        expires_at: expiresAt,
      });

      if (legacy === null) {
        this.database
          .prepare(
            `INSERT INTO organization_tool_connections (
               connection_id, organization_id, connection_kind, owner_kind,
               owner_principal_id, owner_membership_id, human_identity_link_id,
               provider, provider_issuer, provider_tenant_kind,
               provider_tenant_id, provider_subject_kind, provider_subject_id,
               granted_scopes_json, granted_scopes_sha256,
               verification_attempt_id, verification_evidence_sha256,
               secret_backend_id, secret_handle_id, status,
               created_by_principal_id, created_by_membership_id, activated_at,
               revoked_at, revocation_reason, public_configuration_json,
               public_configuration_sha256
             ) VALUES (
               ?, ?, 'service_account', 'organization', NULL, NULL, NULL, ?, ?,
               'workspace', ?, 'service_account', ?, ?, ?, ?, ?, ?, ?, 'active',
               ?, ?, ?, NULL, NULL, ?, ?
             )`,
          )
          .run(
            connectionId,
            input.organization_id,
            SLACK_PROVIDER,
            SLACK_PROVIDER_ISSUER,
            input.connection.team_id,
            input.connection.bot_user_id,
            connectionScopesJson,
            connectionScopesSha256,
            connectionAttemptId,
            verificationEvidenceSha256,
            input.secret.secret_backend_id,
            input.secret.secret_handle_id,
            input.administrator_principal_id,
            input.administrator_membership_id,
            input.now,
            publicConfigurationJson,
            publicConfigurationSha256,
          );
      } else {
        const promoted = this.database
          .prepare(
            `UPDATE organization_tool_connections
             SET granted_scopes_json = ?,
                 granted_scopes_sha256 = ?,
                 verification_attempt_id = ?,
                 verification_evidence_sha256 = ?,
                 public_configuration_json = ?,
                 public_configuration_sha256 = ?
             WHERE connection_id = ?
               AND organization_id = ?
               AND status = 'active'
               AND json_type(
                 public_configuration_json,
                 '$.organization_tool_profile'
               ) IS NULL`,
          )
          .run(
            connectionScopesJson,
            connectionScopesSha256,
            connectionAttemptId,
            verificationEvidenceSha256,
            publicConfigurationJson,
            publicConfigurationSha256,
            legacy.connection_id,
            input.organization_id,
          );
        if (promoted.changes !== 1) {
          throw new Error(
            "legacy Slack organization tool could not be promoted",
          );
        }
      }
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "membership",
        actor_principal_id: input.administrator_principal_id,
        actor_membership_id: input.administrator_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: null,
        command_id: input.command_id,
        provider_event_sha256: null,
        action: "organization_tool.slack.onboarded",
        subject_kind: "tool_connection",
        subject_id: connectionId,
        membership_id: null,
        identity_link_id: null,
        connection_id: connectionId,
        adapter_binding_id: null,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code:
          legacy === null
            ? "provider_and_channel_verified"
            : "legacy_connection_reverified_and_promoted",
        idempotency_key: `organization-tool:slack:${input.command_id}`,
        authority_checked_at: input.now,
        authority_evidence_sha256: input.command_sha256,
        correlation_id: input.command_id,
        detail: {
          command_sha256: input.command_sha256,
          public_configuration_sha256: publicConfigurationSha256,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  bootstrapSlackApproval(
    input: BootstrapSlackApprovalInput,
  ): BootstrapSlackApprovalResult {
    if (
      input.organization_id !== this.identity.organization_id ||
      input.authority_id !== this.identity.authority_id ||
      input.connection.team_id !== input.human.team_id ||
      input.connection.bot_user_id === input.human.user_id ||
      input.channel.team_id !== input.connection.team_id ||
      input.channel.channel_id !== input.channel_id ||
      !/^con_[0-9a-f-]{36}$/.test(input.organization_connection_id) ||
      !/^C[A-Z0-9]{2,}$/.test(input.channel_id) ||
      !hasSlackOrganizationToolScopes(input.connection.granted_scopes)
    ) {
      throw new Error("Slack bootstrap identities are inconsistent");
    }
    const replay = this.bootstrapReplay(input.command_id, input.command_sha256);
    if (replay !== null) return replay;

    const activeOrganizationTool = this.activeSlackOrganizationTool();
    assertBootstrapUsesActiveOrganizationTool(input, activeOrganizationTool);
    const connectionAttemptId =
      activeOrganizationTool.connection_attempt_id;
    const identityAttemptId = id("cat");
    const identityLinkId = id("clm");
    const connectionId = activeOrganizationTool.connection_id;
    const bindingId = id("bnd");
    const approveGrantId = id("pgr");
    const rejectGrantId = id("pgr");
    const expiresAt = addMinutes(input.now, 15);
    const identityScopes = ["users:read"];
    const identityScopesJson = canonicalJson(identityScopes);
    const identityScopesSha256 = digest(identityScopes);
    const publicConfiguration = {
      channel_id: input.channel_id,
      organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
      schema_version: 1,
      approve_reaction: input.approve_reaction,
      reject_reaction: input.reject_reaction,
      slack_enterprise_id: input.connection.enterprise_id,
      slack_bot_id: input.connection.bot_id,
      slack_bot_user_id: input.connection.bot_user_id,
      slack_app_id: input.connection.app_id,
    };
    const publicConfigurationJson = canonicalJson(publicConfiguration);
    const publicConfigurationSha256 = digest(publicConfiguration);
    const result: BootstrapSlackApprovalResult = {
      connection_attempt_id: connectionAttemptId,
      identity_attempt_id: identityAttemptId,
      identity_link_id: identityLinkId,
      connection_id: connectionId,
      adapter_binding_id: bindingId,
      approve_permission_grant_id: approveGrantId,
      reject_permission_grant_id: rejectGrantId,
      organization_id: input.organization_id,
      membership_id: input.target_membership_id,
      installation_id: input.installation_id,
      slack_team_id: input.connection.team_id,
      slack_user_id: input.human.user_id,
      channel_id: input.channel_id,
      created_at: input.now,
    };

    return this.immediateTransaction(() => {
      const concurrent = this.bootstrapReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const currentOrganizationTool = this.activeSlackOrganizationTool();
      assertBootstrapUsesActiveOrganizationTool(
        input,
        currentOrganizationTool,
      );
      if (
        currentOrganizationTool.connection_attempt_id !==
        connectionAttemptId
      ) {
        throw new Error(
          "active organization Slack tool changed during bootstrap",
        );
      }
      this.completeSlackConnectionAttempt({
        attempt_id: identityAttemptId,
        administrator_principal_id: input.administrator_principal_id,
        administrator_membership_id: input.administrator_membership_id,
        purpose: "identity_link",
        owner_kind: "membership",
        target_principal_id: input.target_principal_id,
        target_membership_id: input.target_membership_id,
        team_id: input.connection.team_id,
        redirect_uri: "urn:echo:organization:admin:slack-bootstrap",
        scopes_json: identityScopesJson,
        scopes_sha256: identityScopesSha256,
        subject_kind: "human_user",
        subject_id: input.human.user_id,
        evidence_sha256: input.human.verification_evidence_sha256,
        command_id: input.command_id,
        digest_prefix: "identity-",
        now: input.now,
        expires_at: expiresAt,
      });

      this.database
        .prepare(
          `INSERT INTO organization_external_identity_links (
             identity_link_id, organization_id, principal_id, membership_id,
             provider, provider_issuer, provider_tenant_kind,
             provider_tenant_id, provider_subject_id, verification_attempt_id,
             verification_evidence_sha256, status, verified_at, revoked_at,
             revocation_reason
           ) VALUES (
             ?, ?, ?, ?, 'slack', 'https://slack.com', 'workspace', ?, ?, ?,
             ?, 'active', ?, NULL, NULL
           )`,
        )
        .run(
          identityLinkId,
          input.organization_id,
          input.target_principal_id,
          input.target_membership_id,
          input.connection.team_id,
          input.human.user_id,
          identityAttemptId,
          input.human.verification_evidence_sha256,
          input.now,
        );
      this.database
        .prepare(
          `INSERT INTO organization_adapter_bindings (
             adapter_binding_id, organization_id, product_namespace,
             installation_id, installation_key_id, adapter_kind, adapter_id,
             adapter_instance_id, adapter_version, connection_id,
             public_configuration_json, public_configuration_sha256, status,
             created_by_principal_id, created_by_membership_id, bound_at,
             revoked_at, revocation_reason
           ) VALUES (
             ?, ?, 'echo-brain', ?, ?, 'approval-surface', ?, ?, ?, ?, ?, ?,
             'active', ?, ?, ?, NULL, NULL
           )`,
        )
        .run(
          bindingId,
          input.organization_id,
          input.installation_id,
          input.installation_key_id,
          input.adapter_id,
          input.adapter_instance_id,
          input.adapter_version,
          connectionId,
          publicConfigurationJson,
          publicConfigurationSha256,
          input.administrator_principal_id,
          input.administrator_membership_id,
          input.now,
        );
      const insertGrant = this.database.prepare(
        `INSERT INTO organization_permission_grants (
           permission_grant_id, organization_id, adapter_binding_id,
           principal_id, membership_id, action, resource_scope_json, status,
           granted_by_principal_id, granted_by_membership_id, granted_at,
           revoked_at, revocation_reason
         ) VALUES (
           ?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, NULL, NULL
         )`,
      );
      insertGrant.run(
        approveGrantId,
        input.organization_id,
        bindingId,
        input.target_principal_id,
        input.target_membership_id,
        "approve",
        input.administrator_principal_id,
        input.administrator_membership_id,
        input.now,
      );
      insertGrant.run(
        rejectGrantId,
        input.organization_id,
        bindingId,
        input.target_principal_id,
        input.target_membership_id,
        "reject",
        input.administrator_principal_id,
        input.administrator_membership_id,
        input.now,
      );
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "membership",
        actor_principal_id: input.administrator_principal_id,
        actor_membership_id: input.administrator_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: null,
        command_id: input.command_id,
        provider_event_sha256: null,
        action: "slack_approval.bootstrap",
        subject_kind: "adapter_binding",
        subject_id: bindingId,
        membership_id: input.target_membership_id,
        identity_link_id: identityLinkId,
        connection_id: connectionId,
        adapter_binding_id: bindingId,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code: "provider_verified_and_grants_created",
        idempotency_key: `bootstrap:${input.command_id}`,
        authority_checked_at: input.now,
        authority_evidence_sha256: input.command_sha256,
        correlation_id: input.command_id,
        detail: {
          command_sha256: input.command_sha256,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  completeSlackIdentityLinkChallenge(
    input: CompleteSlackIdentityLinkChallengeInput,
  ): CompletedSlackIdentityLink {
    if (
      input.installation.organization_id !== this.identity.organization_id ||
      input.installation.authority_id !== this.identity.authority_id ||
      input.observed.team_id !== input.organization_tool.team_id ||
      input.observed.channel_id !== input.organization_tool.channel_id ||
      input.observed.challenge_message_ts !== input.challenge_message_ts
    ) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link evidence is inconsistent",
      );
    }
    const replay = this.slackIdentityLinkCompletionReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;
    const challengeReplay =
      this.slackIdentityLinkChallengeCompletionReplay(input);
    if (challengeReplay !== null) return challengeReplay;
    this.slackIdentityLinkChallenge({
      challenge_attempt_id: input.challenge_attempt_id,
      challenge_code_sha256: input.challenge_code_sha256,
      installation: input.installation,
      organization_tool: input.organization_tool,
      now: input.now,
    });

    const publicConfiguration = slackApprovalBindingConfiguration(
      input.organization_tool,
    );
    const publicConfigurationJson = canonicalJson(publicConfiguration);
    const publicConfigurationSha256 = digest(publicConfiguration);
    const identityScopes = ["users:read"];
    const identityScopesJson = canonicalJson(identityScopes);
    const identityScopesSha256 = digest(identityScopes);

    return this.immediateTransaction(() => {
      const concurrent = this.slackIdentityLinkCompletionReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const concurrentChallenge =
        this.slackIdentityLinkChallengeCompletionReplay(input);
      if (concurrentChallenge !== null) return concurrentChallenge;
      const currentTool = this.activeSlackOrganizationTool();
      if (
        currentTool === null ||
        canonicalJson(currentTool) !==
          canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before identity link completion",
        );
      }
      const attempt = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (
        attempt === undefined ||
        attempt.status !== "pending" ||
        input.now >= attempt.expires_at ||
        attempt.requested_by_principal_id !== input.installation.principal_id ||
        attempt.requested_by_membership_id !==
          input.installation.membership_id ||
        attempt.target_principal_id !== input.installation.principal_id ||
        attempt.target_membership_id !== input.installation.membership_id ||
        attempt.provider_tenant_id !== currentTool.team_id ||
        attempt.state_sha256 !== input.challenge_code_sha256 ||
        attempt.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(
            input.challenge_attempt_id,
            currentTool,
          ) ||
        attempt.admin_session_sha256 !==
          slackIdentityLinkSessionSha256(input.installation)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge cannot be completed by this installation",
        );
      }

      const memberIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const subjectIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND provider_subject_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
          input.observed.user_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const existingIdentity = memberIdentity ?? subjectIdentity;
      if (
        (memberIdentity !== undefined &&
          memberIdentity.provider_subject_id !== input.observed.user_id) ||
        (subjectIdentity !== undefined &&
          (subjectIdentity.principal_id !== input.installation.principal_id ||
            subjectIdentity.membership_id !==
              input.installation.membership_id)) ||
        (memberIdentity !== undefined &&
          subjectIdentity !== undefined &&
          memberIdentity.identity_link_id !==
            subjectIdentity.identity_link_id)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity is already linked to another active membership",
        );
      }

      const binding = this.database
        .prepare(
          `SELECT adapter_binding_id, installation_id, installation_key_id,
                  adapter_id, adapter_instance_id, adapter_version,
                  connection_id, public_configuration_json,
                  public_configuration_sha256
           FROM organization_adapter_bindings
           WHERE organization_id = ?
             AND product_namespace = 'echo-brain'
             AND installation_id = ?
             AND adapter_kind = 'approval-surface'
             AND adapter_id = ?
             AND adapter_instance_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          input.installation.installation_id,
          input.adapter_id,
          input.adapter_instance_id,
        ) as ActiveSlackBindingRow | undefined;
      if (
        binding !== undefined &&
        (binding.installation_key_id !==
          input.installation.installation_key_id ||
          binding.adapter_version !== input.adapter_version ||
          binding.connection_id !== currentTool.connection_id ||
          binding.public_configuration_json !== publicConfigurationJson ||
          binding.public_configuration_sha256 !==
            publicConfigurationSha256)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval adapter is already bound to different organization configuration",
        );
      }

      const completedAttempt = this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'succeeded', provider_subject_kind = 'human_user',
               provider_subject_id = ?, granted_scopes_json = ?,
               granted_scopes_sha256 = ?,
               verification_evidence_sha256 = ?, consumed_at = ?
           WHERE connection_attempt_id = ? AND status = 'pending'`,
        )
        .run(
          input.observed.user_id,
          identityScopesJson,
          identityScopesSha256,
          input.observed.verification_evidence_sha256,
          input.now,
          input.challenge_attempt_id,
        );
      if (completedAttempt.changes !== 1) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge lost its completion race",
        );
      }

      const identityLinkCreated = existingIdentity === undefined;
      const identityLinkId = existingIdentity?.identity_link_id ?? id("clm");
      if (identityLinkCreated) {
        this.database
          .prepare(
            `INSERT INTO organization_external_identity_links (
               identity_link_id, organization_id, principal_id, membership_id,
               provider, provider_issuer, provider_tenant_kind,
               provider_tenant_id, provider_subject_id,
               verification_attempt_id, verification_evidence_sha256, status,
               verified_at, revoked_at, revocation_reason
             ) VALUES (
               ?, ?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, 'active', ?,
               NULL, NULL
             )`,
          )
          .run(
            identityLinkId,
            this.identity.organization_id,
            input.installation.principal_id,
            input.installation.membership_id,
            SLACK_PROVIDER,
            SLACK_PROVIDER_ISSUER,
            currentTool.team_id,
            input.observed.user_id,
            input.challenge_attempt_id,
            input.observed.verification_evidence_sha256,
            input.now,
          );
      }

      const adapterBindingCreated = binding === undefined;
      const adapterBindingId = binding?.adapter_binding_id ?? id("bnd");
      if (adapterBindingCreated) {
        this.database
          .prepare(
            `INSERT INTO organization_adapter_bindings (
               adapter_binding_id, organization_id, product_namespace,
               installation_id, installation_key_id, adapter_kind,
               adapter_id, adapter_instance_id, adapter_version,
               connection_id, public_configuration_json,
               public_configuration_sha256, status, created_by_principal_id,
               created_by_membership_id, bound_at, revoked_at,
               revocation_reason
             ) VALUES (
               ?, ?, 'echo-brain', ?, ?, 'approval-surface', ?, ?, ?, ?, ?,
               ?, 'active', ?, ?, ?, NULL, NULL
             )`,
          )
          .run(
            adapterBindingId,
            this.identity.organization_id,
            input.installation.installation_id,
            input.installation.installation_key_id,
            input.adapter_id,
            input.adapter_instance_id,
            input.adapter_version,
            currentTool.connection_id,
            publicConfigurationJson,
            publicConfigurationSha256,
            input.installation.principal_id,
            input.installation.membership_id,
            input.now,
          );
      }

      const result: CompletedSlackIdentityLink = {
        schema_version: 1,
        kind: "echo-organization-slack-link-result",
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        adapter_binding_id: adapterBindingId,
        organization_id: this.identity.organization_id,
        principal_id: input.installation.principal_id,
        membership_id: input.installation.membership_id,
        installation_id: input.installation.installation_id,
        provider: SLACK_PROVIDER,
        provider_tenant_id: currentTool.team_id,
        provider_subject_id: input.observed.user_id,
        channel_id: currentTool.channel_id,
        linked_at: input.now,
        identity_link_created: identityLinkCreated,
        adapter_binding_created: adapterBindingCreated,
        permission_grants_created: 0,
      };
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "installation",
        actor_principal_id: input.installation.principal_id,
        actor_membership_id: input.installation.membership_id,
        actor_identity_link_id: identityLinkId,
        actor_installation_id: input.installation.installation_id,
        command_id: input.command_id,
        provider_event_sha256:
          input.observed.verification_evidence_sha256,
        action: "slack_identity_link.completed",
        subject_kind: "identity_link",
        subject_id: identityLinkId,
        membership_id: input.installation.membership_id,
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        adapter_binding_id: adapterBindingId,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code: identityLinkCreated
          ? "employee_proved_slack_identity"
          : "employee_reverified_slack_identity",
        idempotency_key: `slack-identity-link:${input.command_id}`,
        authority_checked_at: input.authority_checked_at,
        authority_evidence_sha256: input.command_sha256,
        correlation_id: input.challenge_attempt_id,
        detail: {
          command_sha256: input.command_sha256,
          completion_sha256: slackIdentityLinkCompletionSha256(input),
          challenge_attempt_id: input.challenge_attempt_id,
          challenge_message_ts: input.challenge_message_ts,
          reply_message_ts: input.observed.reply_message_ts,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  findSlackApprovalPermission(
    input: SlackApprovalPermissionLookup,
  ): SlackApprovalPermissionCandidate | null {
    const row = this.database
      .prepare(
        `SELECT
           identity.identity_link_id,
           identity.principal_id,
           identity.membership_id,
           connection.connection_id,
           binding.adapter_binding_id,
           grant_row.permission_grant_id,
           connection.secret_backend_id,
           connection.secret_handle_id,
           connection.provider_subject_id AS slack_bot_user_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_bot_id'
           ) AS slack_bot_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_enterprise_id'
           ) AS slack_enterprise_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_app_id'
           ) AS slack_app_id,
           json_extract(
             binding.public_configuration_json,
             '$.approve_reaction'
           ) AS approve_reaction,
           json_extract(
             binding.public_configuration_json,
             '$.reject_reaction'
           ) AS reject_reaction
         FROM organization_external_identity_links AS identity
         JOIN organization_permission_grants AS grant_row
           ON grant_row.organization_id = identity.organization_id
          AND grant_row.principal_id = identity.principal_id
          AND grant_row.membership_id = identity.membership_id
         JOIN organization_adapter_bindings AS binding
           ON binding.adapter_binding_id = grant_row.adapter_binding_id
          AND binding.organization_id = grant_row.organization_id
         JOIN organization_tool_connections AS connection
           ON connection.connection_id = binding.connection_id
          AND connection.organization_id = binding.organization_id
         WHERE identity.organization_id = ?
           AND identity.provider = ?
           AND identity.provider_issuer = ?
           AND identity.provider_tenant_kind = 'workspace'
           AND identity.provider_tenant_id = ?
           AND identity.provider_subject_id = ?
           AND identity.status = 'active'
           AND grant_row.action = ?
           AND grant_row.status = 'active'
           AND binding.product_namespace = 'echo-brain'
           AND binding.installation_id = ?
           AND binding.installation_key_id = ?
           AND binding.adapter_kind = 'approval-surface'
           AND binding.adapter_id = ?
           AND binding.adapter_instance_id = ?
           AND binding.adapter_version = ?
           AND connection.provider_subject_id = ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_bot_id'
           ) = ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_app_id'
           ) IS ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_enterprise_id'
           ) IS ?
           AND json_extract(
             binding.public_configuration_json,
             '$.channel_id'
           ) = ?
           AND (
             (
               grant_row.action = 'approve' AND
               json_extract(
                 binding.public_configuration_json,
                 '$.approve_reaction'
               ) = ?
             ) OR (
               grant_row.action = 'reject' AND
               json_extract(
                 binding.public_configuration_json,
                 '$.reject_reaction'
               ) = ?
             )
           )
           AND binding.status = 'active'
           AND connection.provider = identity.provider
           AND connection.provider_issuer = identity.provider_issuer
           AND connection.provider_tenant_kind =
             identity.provider_tenant_kind
           AND connection.provider_tenant_id = identity.provider_tenant_id
           AND connection.status = 'active'`,
      )
      .get(
        input.organization_id,
        SLACK_PROVIDER,
        SLACK_PROVIDER_ISSUER,
        input.slack_team_id,
        input.slack_user_id,
        input.action,
        input.installation_id,
        input.installation_key_id,
        input.adapter_id,
        input.adapter_instance_id,
        input.adapter_version,
        input.slack_bot_user_id,
        input.slack_bot_id,
        input.slack_app_id,
        input.slack_enterprise_id,
        input.channel_id,
        input.reaction_name,
        input.reaction_name,
      ) as SlackApprovalPermissionCandidate | undefined;
    if (row === undefined) return null;
    if (
      row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      typeof row.slack_bot_id !== "string" ||
      !(
        row.slack_enterprise_id === null ||
        typeof row.slack_enterprise_id === "string"
      ) ||
      !(row.slack_app_id === null || typeof row.slack_app_id === "string") ||
      typeof row.approve_reaction !== "string" ||
      typeof row.reject_reaction !== "string" ||
      row.approve_reaction === row.reject_reaction
    ) {
      throw new Error("stored Slack approval binding is invalid");
    }
    return Object.freeze(row);
  }

  secretReferenceIsInUse(reference: OrganizationSecretReference): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
           FROM organization_tool_connections
           WHERE secret_backend_id = ? AND secret_handle_id = ?`,
        )
        .get(reference.secret_backend_id, reference.secret_handle_id) !==
      undefined
    );
  }

  recordPermissionDecision(
    input: RecordPermissionDecisionInput,
  ): RecordedPermissionDecision {
    const evaluationId = id("pce");
    return this.immediateTransaction(() => {
      this.appendAudit({
        occurred_at: input.evaluated_at,
        actor_kind: "installation",
        actor_principal_id: input.caller_principal_id,
        actor_membership_id: input.caller_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: input.installation_id,
        command_id: evaluationId,
        provider_event_sha256: input.provider_event_sha256,
        action: `permission.${input.action}`,
        subject_kind: "approval",
        subject_id: input.approval_id,
        membership_id: input.membership_id,
        identity_link_id: input.identity_link_id,
        connection_id: input.connection_id,
        adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id,
        outcome: input.allowed ? "allowed" : "denied",
        reason_code: input.reason_code,
        idempotency_key: `permission-evaluation:${evaluationId}`,
        authority_checked_at: input.authority_checked_at,
        authority_evidence_sha256: input.authority_evidence_sha256,
        correlation_id: input.request_id,
        detail: {
          ...input.detail,
          request_sha256: input.request_sha256,
          provider_event_sha256: input.provider_event_sha256,
          principal_id: input.principal_id,
        },
      });
      return Object.freeze({
        request_sha256: input.request_sha256,
        provider_event_sha256: input.provider_event_sha256,
        action: input.action,
        allowed: input.allowed,
        reason_code: input.reason_code,
        principal_id: input.principal_id,
        membership_id: input.membership_id,
        adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id,
        evaluated_at: input.evaluated_at,
      });
    });
  }

  overview(): OrganizationIntegrationsOverview {
    const identityLinks = this.database
      .prepare(
        `SELECT identity_link_id, membership_id, provider,
                provider_tenant_id, provider_subject_id, status, verified_at,
                revoked_at
         FROM organization_external_identity_links
         ORDER BY verified_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const connections = this.database
      .prepare(
        `SELECT connection_id, owner_kind, provider, provider_tenant_id,
                provider_subject_id, granted_scopes_json, status,
                public_configuration_json, public_configuration_sha256,
                activated_at, revoked_at
         FROM organization_tool_connections
         ORDER BY activated_at DESC`,
      )
      .all() as ToolConnectionOverviewRow[];
    for (const connection of connections) {
      validatedPublicConfiguration(connection);
    }
    const bindings = this.database
      .prepare(
        `SELECT adapter_binding_id, installation_id, adapter_kind, adapter_id,
                adapter_instance_id, adapter_version, connection_id, status,
                public_configuration_json, bound_at, revoked_at
         FROM organization_adapter_bindings
         ORDER BY bound_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const grants = this.database
      .prepare(
        `SELECT permission_grant_id, adapter_binding_id, membership_id,
                action, status, granted_at, revoked_at
         FROM organization_permission_grants
         ORDER BY granted_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const audit = this.database
      .prepare(
        `SELECT audit_sequence, occurred_at, actor_kind, action, subject_kind,
                subject_id, membership_id, outcome, reason_code
         FROM organization_integration_audit
         ORDER BY audit_sequence DESC
         LIMIT 50`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    return Object.freeze({
      identity_links: Object.freeze(identityLinks),
      tool_connections: Object.freeze(connections),
      adapter_bindings: Object.freeze(bindings),
      permission_grants: Object.freeze(grants),
      recent_audit: Object.freeze(audit),
    });
  }

  close(): void {
    this.database.close();
  }

  private appendAudit(input: {
    occurred_at: string;
    actor_kind: "membership" | "provider_identity" | "installation" | "system";
    actor_principal_id: string | null;
    actor_membership_id: string | null;
    actor_identity_link_id: string | null;
    actor_installation_id: string | null;
    command_id: string;
    provider_event_sha256: string | null;
    action: string;
    subject_kind: string;
    subject_id: string;
    membership_id: string | null;
    identity_link_id: string | null;
    connection_id: string | null;
    adapter_binding_id: string | null;
    permission_grant_id: string | null;
    outcome: "allowed" | "denied" | "succeeded" | "failed";
    reason_code: string;
    idempotency_key: string;
    authority_checked_at: string | null;
    authority_evidence_sha256: string | null;
    correlation_id: string;
    detail: Readonly<Record<string, unknown>>;
  }): void {
    const tail = this.database
      .prepare(
        `SELECT audit_sequence, entry_sha256
         FROM organization_integration_audit
         ORDER BY audit_sequence DESC
         LIMIT 1`,
      )
      .get() as AuditTail | undefined;
    const auditSequence = (tail?.audit_sequence ?? 0) + 1;
    const previousEntrySha256 = tail?.entry_sha256 ?? null;
    const detailJson = canonicalJson(input.detail);
    const detailSha256 = digest(input.detail);
    const auditEventId = id("aud");
    const entrySha256 = digest({
      audit_sequence: auditSequence,
      audit_event_id: auditEventId,
      previous_entry_sha256: previousEntrySha256,
      ...input,
      detail_json: detailJson,
      detail_sha256: detailSha256,
    });
    this.database
      .prepare(
        `INSERT INTO organization_integration_audit (
           audit_sequence, audit_event_id, previous_entry_sha256,
           entry_sha256, organization_id, occurred_at, actor_kind,
           actor_principal_id, actor_membership_id, actor_identity_link_id,
           actor_installation_id, command_id, provider_event_sha256, action,
           subject_kind, subject_id, membership_id, identity_link_id,
           connection_id, adapter_binding_id, permission_grant_id, outcome,
           reason_code, idempotency_key, authority_checked_at,
           authority_evidence_sha256, correlation_id, detail_json,
           detail_sha256
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        auditSequence,
        auditEventId,
        previousEntrySha256,
        entrySha256,
        this.identity.organization_id,
        input.occurred_at,
        input.actor_kind,
        input.actor_principal_id,
        input.actor_membership_id,
        input.actor_identity_link_id,
        input.actor_installation_id,
        input.command_id,
        input.provider_event_sha256,
        input.action,
        input.subject_kind,
        input.subject_id,
        input.membership_id,
        input.identity_link_id,
        input.connection_id,
        input.adapter_binding_id,
        input.permission_grant_id,
        input.outcome,
        input.reason_code,
        input.idempotency_key,
        input.authority_checked_at,
        input.authority_evidence_sha256,
        input.correlation_id,
        detailJson,
        detailSha256,
      );
  }
}
