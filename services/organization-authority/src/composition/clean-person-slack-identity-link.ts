import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  SLACK_DEFAULT_APPROVE_REACTION,
  SLACK_DEFAULT_REJECT_REACTION,
  buildExternalHumanIdentityLinkContractV2,
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type ActiveSlackOrganizationTool,
  type BeginPersonSlackIdentityLinkChallengeInput,
  type BegunSlackIdentityLinkChallenge,
  type CompletePersonSlackIdentityLinkChallengeInput,
  type CompletedPersonSlackIdentityLink,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  type PendingPersonSlackIdentityLinkChallenge,
  type PersonSlackIdentityLinkSession,
  type CleanSlackIdentityProviderV1,
} from "@echo-brain/organization-control-plane/clean-slack-identity-v1";
import type Database from "better-sqlite3";
import { ReadableSearchAuthorizationFence } from "../application/readable-search-authorization-fence.js";
import {
  PersonSlackIdentityLinkService,
  type PersonSlackIdentityLinkAuthenticationPort,
  type PersonSlackIdentityLinkRepositoryPort,
} from "./person-slack-identity-link.js";

const CHALLENGE_LIFETIME_MS = 15 * 60 * 1000;

/** Avoid loading the legacy integration repository for its error class. */
class CleanPersonSlackIdentityLinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationIntegrationConflictError";
  }
}

export interface CleanSlackTokenAccessV1 {
  readActiveSlackBotToken(input: {
    readonly connection: OrganizationToolConnectionContractV2;
    readonly state: OrganizationToolConnectionStateV2;
  }): string;
}

export interface CreateCleanPersonSlackIdentityLinkServiceV1Input {
  readonly database: Database.Database;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  /** Runtime configuration, bound to the stored public configuration digest. */
  readonly approval_channel_id: string;
  readonly authentication: PersonSlackIdentityLinkAuthenticationPort;
  /** Current membership data remains Authority-owned, not copied into D2. */
  readonly membership_type: (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }) => "employee" | "owner";
  readonly slack: CleanSlackIdentityProviderV1;
  readonly slack_token_access: CleanSlackTokenAccessV1;
  readonly authorization_fence: ReadableSearchAuthorizationFence;
  readonly now?: () => string;
}

interface ActiveCleanConnection {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
  readonly tool: ActiveSlackOrganizationTool;
}

interface ChallengeRow {
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

function parseCanonical(value: string): unknown {
  const parsed = JSON.parse(value) as unknown;
  if (canonicalJson(parsed) !== value) {
    throw new Error("stored clean Slack contract is not canonical");
  }
  return parsed;
}

function addChallengeLifetime(now: string): string {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid current time");
  return new Date(milliseconds + CHALLENGE_LIFETIME_MS).toISOString();
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
    channel_id: tool.channel_id,
    approve_reaction: tool.approve_reaction,
    reject_reaction: tool.reject_reaction,
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

function identityLinkId(challengeAttemptId: string): string {
  if (!challengeAttemptId.startsWith("cat_"))
    throw new Error("invalid challenge ID");
  return `clm_${challengeAttemptId.slice(4)}`;
}

function sameTool(
  left: ActiveSlackOrganizationTool,
  right: ActiveSlackOrganizationTool | null,
): boolean {
  return right !== null && canonicalJson(left) === canonicalJson(right);
}

/**
 * New-lineage repository adapter. It persists only challenge and identity-link
 * state in the frozen D2 baseline; authentication and token retrieval remain
 * Authority/runtime ports.
 */
class CleanPersonSlackIdentityLinkRepositoryV1 implements PersonSlackIdentityLinkRepositoryPort {
  constructor(
    private readonly options: CreateCleanPersonSlackIdentityLinkServiceV1Input,
  ) {}

  activeSlackOrganizationTool(): ActiveSlackOrganizationTool | null {
    return this.activeConnection()?.tool ?? null;
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
      throw new CleanPersonSlackIdentityLinkConflictError(
        "active clean Slack connection changed",
      );
    }
    const row = this.options.database
      .prepare(
        `SELECT command.command_semantic_sha256, challenge.challenge_attempt_id,
                challenge.connection_id, challenge.person_session_sha256,
                challenge.organization_tool_sha256, challenge.created_at,
                challenge.expires_at, challenge.challenge_message_ts
         FROM organization_person_slack_link_commands AS command
         JOIN organization_person_slack_link_challenges AS challenge
           ON challenge.challenge_attempt_id = command.challenge_attempt_id
         WHERE command.command_id = ? AND command.command_kind = 'begin'`,
      )
      .get(input.request_id) as
      | {
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
      throw new CleanPersonSlackIdentityLinkConflictError(
        "Person Slack begin request ID was reused with different input",
      );
    }
    if (
      row.person_session_sha256 !== personSessionSha256(input.person_session) ||
      !this.matchesChallengeTool(row, input.organization_tool)
    ) {
      throw new CleanPersonSlackIdentityLinkConflictError(
        "Person Slack begin replay no longer matches the current session or tool",
      );
    }
    if (row.challenge_message_ts === null) {
      throw new CleanPersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge is still being posted",
      );
    }
    return Object.freeze({
      challenge_attempt_id: row.challenge_attempt_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      replayed: true,
      challenge_message_ts: row.challenge_message_ts,
    });
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
      throw new Error("clean Person Slack begin requires a request ID");
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
      const challengeAttemptId = `cat_${randomUUID()}`;
      const expiresAt = addChallengeLifetime(input.now);
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
           challenge_attempt_id, connection_id, principal_id, membership_id,
           challenge_code_sha256, person_session_sha256, organization_tool_sha256,
           status, completion_sha256, challenge_message_ts, reply_message_ts,
           created_at, expires_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
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
      throw new CleanPersonSlackIdentityLinkConflictError(
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
      this.options.database
        .prepare(
          `UPDATE organization_person_slack_link_challenges
         SET status = 'expired', completed_at = ?
         WHERE challenge_attempt_id = ? AND status = 'pending'`,
        )
        .run(input.now, input.challenge_attempt_id);
      throw new CleanPersonSlackIdentityLinkConflictError(
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
      throw new CleanPersonSlackIdentityLinkConflictError(
        "Person Slack identity link challenge does not match this session",
      );
    }
    return Object.freeze({
      challenge_attempt_id: row.challenge_attempt_id,
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
      throw new CleanPersonSlackIdentityLinkConflictError(
        "Person Slack completion request ID was reused with different input",
      );
    }
    const tool = this.activeSlackOrganizationTool();
    if (tool === null) {
      throw new CleanPersonSlackIdentityLinkConflictError(
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
      throw new CleanPersonSlackIdentityLinkConflictError(
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
    if (
      input.observed.team_id !== input.organization_tool.team_id ||
      input.observed.channel_id !== input.organization_tool.channel_id ||
      input.observed.challenge_message_ts !== input.challenge_message_ts
    ) {
      throw new CleanPersonSlackIdentityLinkConflictError(
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
      const active = this.requireSameActiveTool(input.organization_tool);
      const row = this.challenge(input.challenge_attempt_id);
      if (row.status !== "pending") {
        throw new CleanPersonSlackIdentityLinkConflictError(
          "Person Slack identity link challenge cannot be completed",
        );
      }
      const member = this.options.database
        .prepare(
          `SELECT external_identity_link_id, principal_id, membership_id, provider_subject_id
         FROM organization_external_human_link_current
         WHERE membership_id = ? AND provider_issuer = 'https://slack.com'
           AND provider_tenant_kind = 'workspace' AND provider_tenant_id = ?
           AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
           AND current_status = 'active'`,
        )
        .get(
          input.person_session.membership_id,
          active.connection.provider_tenant_id,
          active.connection.provider_enterprise_id,
        ) as
        | {
            external_identity_link_id: string;
            principal_id: string;
            membership_id: string;
            provider_subject_id: string;
          }
        | undefined;
      const subject = this.options.database
        .prepare(
          `SELECT external_identity_link_id, principal_id, membership_id, provider_subject_id
         FROM organization_external_human_link_current
         WHERE provider_issuer = 'https://slack.com' AND provider_tenant_kind = 'workspace'
           AND provider_tenant_id = ? AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
           AND provider_subject_id = ? AND current_status = 'active'`,
        )
        .get(
          active.connection.provider_tenant_id,
          active.connection.provider_enterprise_id,
          input.observed.user_id,
        ) as
        | {
            external_identity_link_id: string;
            principal_id: string;
            membership_id: string;
            provider_subject_id: string;
          }
        | undefined;
      if (
        (member !== undefined &&
          member.provider_subject_id !== input.observed.user_id) ||
        (subject !== undefined &&
          (subject.principal_id !== input.person_session.principal_id ||
            subject.membership_id !== input.person_session.membership_id)) ||
        (member !== undefined &&
          subject !== undefined &&
          member.external_identity_link_id !==
            subject.external_identity_link_id)
      ) {
        throw new CleanPersonSlackIdentityLinkConflictError(
          "Slack identity is already linked to another active membership",
        );
      }
      const existing = member ?? subject;
      const externalIdentityLinkId =
        existing?.external_identity_link_id ??
        identityLinkId(input.challenge_attempt_id);
      const contract = buildExternalHumanIdentityLinkContractV2({
        authority_id: this.options.authority_id,
        organization_id: this.options.organization_id,
        state_lineage_id: this.options.state_lineage_id,
        external_identity_link_id: externalIdentityLinkId,
        provider_issuer: "https://slack.com",
        provider_tenant_kind: "workspace",
        provider_tenant_id: active.connection.provider_tenant_id,
        provider_enterprise_id: active.connection.provider_enterprise_id,
        provider_subject_id: input.observed.user_id,
        principal_id: input.person_session.principal_id,
        membership_id: input.person_session.membership_id,
        membership_type: this.membershipType(input.person_session),
        verification_event_id: input.challenge_attempt_id,
        verification_evidence_sha256:
          input.observed.verification_evidence_sha256,
        verified_at: input.now,
      });
      const contractSha256 = canonicalSha256(contract);
      this.options.database
        .prepare(
          `INSERT INTO organization_external_human_link_contracts
         (external_identity_link_id, contract_sha256, contract_json, created_at)
         VALUES (?, ?, ?, ?)`,
        )
        .run(
          externalIdentityLinkId,
          contractSha256,
          canonicalJson(contract),
          input.now,
        );
      if (existing === undefined) {
        this.options.database
          .prepare(
            `INSERT INTO organization_external_human_link_current
           (external_identity_link_id, contract_sha256, provider_issuer, provider_tenant_kind,
            provider_tenant_id, provider_enterprise_id, provider_subject_id, principal_id,
            membership_id, current_status, updated_at)
           VALUES (?, ?, 'https://slack.com', 'workspace', ?, ?, ?, ?, ?, 'active', ?)`,
          )
          .run(
            externalIdentityLinkId,
            contractSha256,
            active.connection.provider_tenant_id,
            active.connection.provider_enterprise_id,
            input.observed.user_id,
            input.person_session.principal_id,
            input.person_session.membership_id,
            input.now,
          );
      } else {
        this.options.database
          .prepare(
            `UPDATE organization_external_human_link_current
           SET contract_sha256 = ?, updated_at = ?
           WHERE external_identity_link_id = ?`,
          )
          .run(contractSha256, input.now, externalIdentityLinkId);
      }
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
        throw new CleanPersonSlackIdentityLinkConflictError(
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

  readSlackToken(reference: OrganizationSecretReference): string {
    const active = this.activeConnection();
    if (
      active === null ||
      reference.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      reference.secret_handle_id !== active.connection.connection_id
    ) {
      throw new Error("active clean Slack credential is unavailable");
    }
    return this.options.slack_token_access.readActiveSlackBotToken({
      connection: active.connection,
      state: active.state,
    });
  }

  private membershipType(
    session: PersonSlackIdentityLinkSession,
  ): "employee" | "owner" {
    return this.options.membership_type({
      principal_id: session.principal_id,
      membership_id: session.membership_id,
    });
  }

  private completedResult(
    challengeAttemptId: string,
    tool: ActiveSlackOrganizationTool,
  ): CompletedPersonSlackIdentityLink {
    const challenge = this.challenge(challengeAttemptId);
    if (!this.matchesChallengeTool(challenge, tool)) {
      throw new CleanPersonSlackIdentityLinkConflictError(
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
      channel_id: tool.channel_id,
      linked_at: contract.verified_at,
      identity_link_created:
        contract.external_identity_link_id ===
        identityLinkId(challengeAttemptId),
    });
  }

  private challenge(challengeAttemptId: string): ChallengeRow {
    const row = this.options.database
      .prepare(
        `SELECT challenge_attempt_id, connection_id, principal_id, membership_id,
              challenge_code_sha256, person_session_sha256, organization_tool_sha256,
              status, completion_sha256, challenge_message_ts, reply_message_ts,
              created_at, expires_at
       FROM organization_person_slack_link_challenges WHERE challenge_attempt_id = ?`,
      )
      .get(challengeAttemptId) as ChallengeRow | undefined;
    if (row === undefined)
      throw new CleanPersonSlackIdentityLinkConflictError(
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
  ): ActiveCleanConnection {
    const active = this.activeConnection();
    if (active === null || !sameTool(tool, active.tool)) {
      throw new CleanPersonSlackIdentityLinkConflictError(
        "active clean Slack connection changed",
      );
    }
    return active;
  }

  private activeConnection(): ActiveCleanConnection | null {
    const row = this.options.database
      .prepare(
        `SELECT contract.contract_json, contract.contract_sha256, current_state.state_json, current_state.state_sha256
       FROM organization_tool_connection_current_state AS current_state
       JOIN organization_tool_connection_contracts AS contract
         ON contract.connection_id = current_state.connection_id
        AND contract.contract_sha256 = current_state.connection_contract_sha256
       WHERE current_state.current_status = 'active'`,
      )
      .get() as
      | {
          contract_json: string;
          contract_sha256: `sha256:${string}`;
          state_json: string;
          state_sha256: `sha256:${string}`;
        }
      | undefined;
    if (row === undefined) return null;
    const connection = validateOrganizationToolConnectionContractV2(
      parseCanonical(row.contract_json),
    );
    const state = validateOrganizationToolConnectionStateV2(
      parseCanonical(row.state_json),
    );
    if (
      canonicalSha256(connection) !== row.contract_sha256 ||
      canonicalSha256(state) !== row.state_sha256 ||
      state.connection_contract_sha256 !== row.contract_sha256 ||
      state.connection_status !== "active" ||
      connection.authority_id !== this.options.authority_id ||
      connection.organization_id !== this.options.organization_id ||
      connection.state_lineage_id !== this.options.state_lineage_id ||
      connection.public_connection_configuration_sha256 !==
        canonicalSha256({
          approval_adapter_id: "slack-reactions",
          approval_channel_id: this.options.approval_channel_id,
          approve_reaction: "white_check_mark",
          kind: "echo-clean-slack-connection-public-configuration-v1",
          reject_reaction: "x",
        })
    ) {
      throw new Error("stored clean Slack connection is inconsistent");
    }
    return Object.freeze({
      connection,
      state,
      tool: Object.freeze({
        connection_attempt_id: state.verification_event_id,
        connection_id: connection.connection_id,
        team_id: connection.provider_tenant_id,
        enterprise_id: connection.provider_enterprise_id,
        bot_user_id: connection.provider_bot_user_id,
        bot_id: connection.provider_bot_id,
        app_id: connection.provider_app_id,
        channel_id: this.options.approval_channel_id,
        approve_reaction: SLACK_DEFAULT_APPROVE_REACTION,
        reject_reaction: SLACK_DEFAULT_REJECT_REACTION,
        granted_scopes: state.observed_granted_scopes,
        secret: Object.freeze({
          secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
          secret_handle_id: connection.connection_id,
        }),
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

/** Factory for clean runtime composition; it does not open a listener itself. */
export function createCleanPersonSlackIdentityLinkServiceV1(
  input: CreateCleanPersonSlackIdentityLinkServiceV1Input,
): PersonSlackIdentityLinkService {
  const repository = new CleanPersonSlackIdentityLinkRepositoryV1(input);
  const secrets: Pick<OrganizationSecretStore, "read"> = {
    read(reference) {
      return repository.readSlackToken(reference);
    },
  };
  return new PersonSlackIdentityLinkService({
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    authentication: input.authentication,
    repository,
    secrets: secrets as OrganizationSecretStore,
    slack: input.slack,
    authorization_fence: input.authorization_fence,
    now: input.now,
  });
}
