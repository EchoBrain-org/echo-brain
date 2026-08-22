import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  organizationSlackLinkChallengeCodeSha256,
  validateOrganizationPersonSlackLinkBeginRequest,
  validateOrganizationPersonSlackLinkBeginResponse,
  validateOrganizationPersonSlackLinkCompleteRequest,
  validateOrganizationPersonSlackLinkResult,
  type OrganizationPersonSlackLinkBeginRequestV2,
  type OrganizationPersonSlackLinkBeginResponseV2,
  type OrganizationPersonSlackLinkCompleteRequestV2,
  type OrganizationPersonSlackLinkResultV2,
} from "@echo-brain/organization-api";
import type {
  ActiveSlackOrganizationTool,
  BeginPersonSlackIdentityLinkChallengeInput,
  BegunSlackIdentityLinkChallenge,
  CompletePersonSlackIdentityLinkChallengeInput,
  CompletedPersonSlackIdentityLink,
  OrganizationSecretStore,
  PendingPersonSlackIdentityLinkChallenge,
  CleanSlackIdentityProviderV1,
} from "@echo-brain/organization-control-plane/clean-slack-identity-v1";
import {
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  CleanSlackIdentityProviderErrorV1,
} from "@echo-brain/organization-control-plane/clean-slack-identity-v1";
import { AuthorityOperationError } from "../domain/errors.js";
import type { PersonAccessAuthorization } from "../application/person-identity-sessions.js";
import { ReadableSearchAuthorizationFence } from "../application/readable-search-authorization-fence.js";

export interface PersonSlackIdentityLinkAuthenticationPort {
  authenticateAccess(input: {
    readonly access_token: string;
  }): PersonAccessAuthorization;
}

export interface PersonSlackIdentityLinkRepositoryPort {
  activeSlackOrganizationTool(): ActiveSlackOrganizationTool | null;
  personSlackIdentityLinkBeginReplay?(input: {
    readonly request_id: string;
    readonly request_sha256: `sha256:${string}`;
    readonly person_session: BeginPersonSlackIdentityLinkChallengeInput["person_session"];
    readonly organization_tool: ActiveSlackOrganizationTool;
  }):
    | (BegunSlackIdentityLinkChallenge & {
        readonly replayed: true;
        readonly challenge_message_ts: string;
      })
    | null;
  beginPersonSlackIdentityLinkChallenge(
    input: BeginPersonSlackIdentityLinkChallengeInput,
  ): BegunSlackIdentityLinkChallenge & {
    readonly replayed?: boolean;
    readonly challenge_message_ts?: string;
  };
  recordPersonSlackIdentityLinkChallengeMessage?(input: {
    readonly challenge_attempt_id: string;
    readonly challenge_message_ts: string;
  }): void;
  personSlackIdentityLinkChallenge(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    person_session: BeginPersonSlackIdentityLinkChallengeInput["person_session"];
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): PendingPersonSlackIdentityLinkChallenge;
  failSlackIdentityLinkChallenge(
    challengeAttemptId: string,
    failedAt: string,
    reason: string,
  ): void;
  personSlackIdentityLinkCompletionReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): CompletedPersonSlackIdentityLink | null;
  personSlackIdentityLinkChallengeCompletionReplay(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    challenge_message_ts: string;
    person_session: BeginPersonSlackIdentityLinkChallengeInput["person_session"];
    organization_tool: ActiveSlackOrganizationTool;
  }): CompletedPersonSlackIdentityLink | null;
  completePersonSlackIdentityLinkChallenge(
    input: CompletePersonSlackIdentityLinkChallengeInput,
  ): CompletedPersonSlackIdentityLink;
}

export interface PersonSlackIdentityLinkServiceOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authentication: PersonSlackIdentityLinkAuthenticationPort;
  readonly repository: PersonSlackIdentityLinkRepositoryPort;
  readonly secrets: OrganizationSecretStore;
  readonly slack: CleanSlackIdentityProviderV1;
  readonly authorization_fence: ReadableSearchAuthorizationFence;
  readonly now?: () => string;
}

function unauthorized(): AuthorityOperationError {
  return new AuthorityOperationError(
    "unauthorized",
    "Person Slack identity-link authorization failed",
  );
}

function personSession(
  authorization: PersonAccessAuthorization,
  authorityId: string,
) {
  return Object.freeze({
    authority_id: authorityId,
    organization_id: authorization.organization_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    identity_binding_id: authorization.identity_binding_id,
    session_family_id: authorization.session_family_id,
  });
}

function personSlackLinkRequestSha256(
  kind:
    | "echo-person-slack-link-begin-request-binding-v1"
    | "echo-person-slack-link-complete-request-binding-v1",
  session: ReturnType<typeof personSession>,
  request:
    | OrganizationPersonSlackLinkBeginRequestV2
    | OrganizationPersonSlackLinkCompleteRequestV2,
) {
  return canonicalSha256({
    schema_version: 1,
    kind,
    ...session,
    request,
  });
}

function samePersonSession(
  left: PersonAccessAuthorization,
  right: PersonAccessAuthorization,
): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id &&
    left.identity_binding_id === right.identity_binding_id &&
    left.session_family_id === right.session_family_id
  );
}

function sameTool(
  left: ActiveSlackOrganizationTool,
  right: ActiveSlackOrganizationTool | null,
): right is ActiveSlackOrganizationTool {
  return right !== null && canonicalJson(left) === canonicalJson(right);
}

type SlackProviderFailureCode =
  | "unauthorized"
  | "identity_mismatch"
  | "unavailable"
  | "invalid_response"
  | "not_observed";

function slackProviderFailureCode(
  error: unknown,
): SlackProviderFailureCode | null {
  if (error instanceof CleanSlackIdentityProviderErrorV1) return error.code;
  // Legacy composition still supplies the original provider. Preserve its
  // public error mapping without importing that provider into this clean path.
  const legacy = error as unknown as { readonly code?: unknown };
  if (
    error instanceof Error &&
    error.name === "SlackIntegrationProviderError" &&
    typeof legacy.code === "string" &&
    [
      "unauthorized",
      "identity_mismatch",
      "unavailable",
      "invalid_response",
      "not_observed",
    ].includes(legacy.code)
  ) {
    return legacy.code as SlackProviderFailureCode;
  }
  return null;
}

function providerFailure(error: unknown): never {
  const code = slackProviderFailureCode(error);
  if (code === "not_observed") {
    throw new AuthorityOperationError(
      "unavailable",
      "The exact Slack challenge reply has not been observed yet",
    );
  }
  if (code === "unavailable") {
    throw new AuthorityOperationError(
      "unavailable",
      "Slack identity verification is temporarily unavailable",
    );
  }
  if (code !== null) {
    throw new AuthorityOperationError(
      "invalid_request",
      "Slack could not verify the identity-link evidence",
    );
  }
  throw error;
}

function repositoryOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "OrganizationIntegrationConflictError" ||
        error.message ===
          "organization integration command ID was reused with different input")
    ) {
      throw new AuthorityOperationError("conflict", error.message);
    }
    throw error;
  }
}

/** Bearer-authenticated Person-to-Slack identity proof; it grants nothing. */
export class PersonSlackIdentityLinkService {
  constructor(
    private readonly options: PersonSlackIdentityLinkServiceOptions,
  ) {}

  async begin(
    input: unknown,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<OrganizationPersonSlackLinkBeginResponseV2> {
    let request: OrganizationPersonSlackLinkBeginRequestV2;
    try {
      request = validateOrganizationPersonSlackLinkBeginRequest(input);
    } catch {
      throw new AuthorityOperationError(
        "invalid_request",
        "Person Slack identity-link begin request is invalid",
      );
    }
    const before = this.authenticate(accessToken);
    const activeTool = this.requireActiveTool();
    const earlyReplay = await this.options.authorization_fence.withRead(() => {
      const current = this.authenticate(accessToken);
      if (!samePersonSession(before, current)) {
        throw new AuthorityOperationError(
          "conflict",
          "Person state changed while replaying the identity link",
        );
      }
      return repositoryOperation(
        () =>
          this.options.repository.personSlackIdentityLinkBeginReplay?.({
            request_id: request.request_id,
            request_sha256: personSlackLinkRequestSha256(
              "echo-person-slack-link-begin-request-binding-v1",
              personSession(current, this.options.authority_id),
              request,
            ),
            person_session: personSession(current, this.options.authority_id),
            organization_tool: activeTool,
          }) ?? null,
      );
    });
    if (earlyReplay !== null) {
      return validateOrganizationPersonSlackLinkBeginResponse({
        schema_version: 2,
        kind: "echo-organization-person-slack-link-begin-response",
        challenge_attempt_id: earlyReplay.challenge_attempt_id,
        provider: "slack",
        provider_tenant_id: activeTool.team_id,
        channel_id: activeTool.channel_id,
        challenge_message_ts: earlyReplay.challenge_message_ts,
        expires_at: earlyReplay.expires_at,
      });
    }
    const token = this.readToolSecret(activeTool);
    const verified = await this.verifyTool(token, activeTool, signal);
    const begun = await this.options.authorization_fence.withRead(() => {
      const current = this.authenticate(accessToken);
      if (
        !samePersonSession(before, current) ||
        !sameTool(
          activeTool,
          this.options.repository.activeSlackOrganizationTool(),
        ) ||
        !this.verifiedToolMatches(activeTool, verified)
      ) {
        throw new AuthorityOperationError(
          "conflict",
          "Person or Slack state changed while beginning the identity link",
        );
      }
      const currentSession = personSession(current, this.options.authority_id);
      return repositoryOperation(() =>
        this.options.repository.beginPersonSlackIdentityLinkChallenge({
          request_id: request.request_id,
          request_sha256: personSlackLinkRequestSha256(
            "echo-person-slack-link-begin-request-binding-v1",
            currentSession,
            request,
          ),
          challenge_code_sha256: request.challenge_code_sha256,
          person_session: currentSession,
          organization_tool: activeTool,
          now: current.checked_at,
        } as BeginPersonSlackIdentityLinkChallengeInput & {
          request_id: string;
        }),
      );
    });

    if (begun.replayed === true && begun.challenge_message_ts !== undefined) {
      return validateOrganizationPersonSlackLinkBeginResponse({
        schema_version: 2,
        kind: "echo-organization-person-slack-link-begin-response",
        challenge_attempt_id: begun.challenge_attempt_id,
        provider: "slack",
        provider_tenant_id: activeTool.team_id,
        channel_id: activeTool.channel_id,
        challenge_message_ts: begun.challenge_message_ts,
        expires_at: begun.expires_at,
      });
    }

    let posted: Awaited<
      ReturnType<CleanSlackIdentityProviderV1["postIdentityLinkChallenge"]>
    >;
    try {
      posted = await this.options.slack.postIdentityLinkChallenge(
        token,
        {
          expected_team_id: activeTool.team_id,
          expected_enterprise_id: activeTool.enterprise_id,
          expected_bot_user_id: activeTool.bot_user_id,
          expected_bot_id: activeTool.bot_id,
          expected_app_id: activeTool.app_id,
          challenge_attempt_id: begun.challenge_attempt_id,
          channel_id: activeTool.channel_id,
          issued_at: begun.created_at,
          expires_at: begun.expires_at,
        },
        signal,
      );
    } catch (error) {
      this.options.repository.failSlackIdentityLinkChallenge(
        begun.challenge_attempt_id,
        this.now(),
        "provider_challenge_post_failed",
      );
      providerFailure(error);
    }

    await this.options.authorization_fence.withRead(() => {
      const current = this.authenticate(accessToken);
      if (
        !samePersonSession(before, current) ||
        !sameTool(
          activeTool,
          this.options.repository.activeSlackOrganizationTool(),
        ) ||
        current.checked_at >= begun.expires_at ||
        posted.team_id !== activeTool.team_id ||
        posted.channel_id !== activeTool.channel_id
      ) {
        this.options.repository.failSlackIdentityLinkChallenge(
          begun.challenge_attempt_id,
          this.now(),
          "person_or_tool_changed_after_challenge_post",
        );
        throw new AuthorityOperationError(
          "conflict",
          "Person or Slack state changed while posting the identity challenge",
        );
      }
      this.options.repository.recordPersonSlackIdentityLinkChallengeMessage?.({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_message_ts: posted.challenge_message_ts,
      });
      repositoryOperation(() =>
        this.options.repository.personSlackIdentityLinkChallenge({
          challenge_attempt_id: begun.challenge_attempt_id,
          challenge_code_sha256: request.challenge_code_sha256,
          person_session: personSession(current, this.options.authority_id),
          organization_tool: activeTool,
          now: current.checked_at,
        }),
      );
    });

    return validateOrganizationPersonSlackLinkBeginResponse({
      schema_version: 2,
      kind: "echo-organization-person-slack-link-begin-response",
      challenge_attempt_id: begun.challenge_attempt_id,
      provider: "slack",
      provider_tenant_id: activeTool.team_id,
      channel_id: activeTool.channel_id,
      challenge_message_ts: posted.challenge_message_ts,
      expires_at: begun.expires_at,
    });
  }

  async complete(
    input: unknown,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<OrganizationPersonSlackLinkResultV2> {
    let request: OrganizationPersonSlackLinkCompleteRequestV2;
    try {
      request = validateOrganizationPersonSlackLinkCompleteRequest(input);
    } catch {
      throw new AuthorityOperationError(
        "invalid_request",
        "Person Slack identity-link completion request is invalid",
      );
    }
    const before = this.authenticate(accessToken);
    const session = personSession(before, this.options.authority_id);
    const commandSha256 = personSlackLinkRequestSha256(
      "echo-person-slack-link-complete-request-binding-v1",
      session,
      request,
    );
    const commandReplay = repositoryOperation(() =>
      this.options.repository.personSlackIdentityLinkCompletionReplay(
        request.request_id,
        commandSha256,
      ),
    );
    if (commandReplay !== null) {
      return validateOrganizationPersonSlackLinkResult(commandReplay);
    }

    const activeTool = this.requireActiveTool();
    const codeSha256 = organizationSlackLinkChallengeCodeSha256(
      request.challenge_code,
    );
    const replayInput = {
      challenge_attempt_id: request.challenge_attempt_id,
      challenge_code_sha256: codeSha256,
      challenge_message_ts: request.challenge_message_ts,
      person_session: session,
      organization_tool: activeTool,
    } as const;
    const challengeReplay = repositoryOperation(() =>
      this.options.repository.personSlackIdentityLinkChallengeCompletionReplay(
        replayInput,
      ),
    );
    if (challengeReplay !== null) {
      return validateOrganizationPersonSlackLinkResult(challengeReplay);
    }
    const challenge = repositoryOperation(() =>
      this.options.repository.personSlackIdentityLinkChallenge({
        challenge_attempt_id: request.challenge_attempt_id,
        challenge_code_sha256: codeSha256,
        person_session: session,
        organization_tool: activeTool,
        now: before.checked_at,
      }),
    );
    const token = this.readToolSecret(activeTool);
    let observed: Awaited<
      ReturnType<CleanSlackIdentityProviderV1["observeIdentityLinkChallenge"]>
    >;
    try {
      observed = await this.options.slack.observeIdentityLinkChallenge(
        token,
        {
          expected_team_id: activeTool.team_id,
          expected_enterprise_id: activeTool.enterprise_id,
          expected_bot_user_id: activeTool.bot_user_id,
          expected_bot_id: activeTool.bot_id,
          expected_app_id: activeTool.app_id,
          challenge_attempt_id: request.challenge_attempt_id,
          channel_id: activeTool.channel_id,
          challenge_message_ts: request.challenge_message_ts,
          challenge_code: request.challenge_code,
          issued_at: challenge.created_at,
          expires_at: challenge.expires_at,
        },
        signal,
      );
    } catch (error) {
      providerFailure(error);
    }

    let currentChannel: Awaited<
      ReturnType<CleanSlackIdentityProviderV1["verifyChannel"]>
    >;
    try {
      currentChannel = await this.options.slack.verifyChannel(
        token,
        activeTool.channel_id,
        activeTool.team_id,
        signal,
      );
    } catch (error) {
      providerFailure(error);
    }

    return await this.options.authorization_fence.withRead(() => {
      const current = this.authenticate(accessToken);
      const currentTool = this.options.repository.activeSlackOrganizationTool();
      if (
        !samePersonSession(before, current) ||
        !sameTool(activeTool, currentTool) ||
        currentChannel.team_id !== activeTool.team_id ||
        currentChannel.channel_id !== activeTool.channel_id
      ) {
        throw new AuthorityOperationError(
          "conflict",
          "Person or Slack state changed during the identity proof",
        );
      }
      return validateOrganizationPersonSlackLinkResult(
        repositoryOperation(() =>
          this.options.repository.completePersonSlackIdentityLinkChallenge({
            command_id: request.request_id,
            command_sha256: commandSha256,
            challenge_attempt_id: request.challenge_attempt_id,
            challenge_code_sha256: codeSha256,
            challenge_message_ts: request.challenge_message_ts,
            person_session: personSession(current, this.options.authority_id),
            organization_tool: currentTool,
            observed,
            authority_checked_at: current.checked_at,
            now: current.checked_at,
          }),
        ),
      );
    });
  }

  private authenticate(accessToken: string): PersonAccessAuthorization {
    const authorization = this.options.authentication.authenticateAccess({
      access_token: accessToken,
    });
    if (authorization.organization_id !== this.options.organization_id) {
      throw unauthorized();
    }
    return authorization;
  }

  private requireActiveTool(): ActiveSlackOrganizationTool {
    const tool = this.options.repository.activeSlackOrganizationTool();
    if (tool === null) {
      throw new AuthorityOperationError(
        "conflict",
        "Slack is not active for this organization",
      );
    }
    return tool;
  }

  private readToolSecret(tool: ActiveSlackOrganizationTool): string {
    try {
      return this.options.secrets.read(tool.secret);
    } catch {
      throw new AuthorityOperationError(
        "unavailable",
        "The active organization Slack credential is unavailable",
      );
    }
  }

  private async verifyTool(
    token: string,
    tool: ActiveSlackOrganizationTool,
    signal?: AbortSignal,
  ): Promise<{
    connection: Awaited<
      ReturnType<CleanSlackIdentityProviderV1["verifyConnection"]>
    >;
    channel: Awaited<ReturnType<CleanSlackIdentityProviderV1["verifyChannel"]>>;
  }> {
    try {
      const connection = await this.options.slack.verifyConnection(
        token,
        signal,
      );
      for (const required of SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES) {
        if (!connection.granted_scopes.includes(required)) {
          throw new AuthorityOperationError(
            "invalid_request",
            `Slack bot token is missing required scope ${required}`,
          );
        }
      }
      const channel = await this.options.slack.verifyChannel(
        token,
        tool.channel_id,
        connection.team_id,
        signal,
      );
      return { connection, channel };
    } catch (error) {
      providerFailure(error);
    }
  }

  private verifiedToolMatches(
    tool: ActiveSlackOrganizationTool,
    verified: {
      connection: Awaited<
        ReturnType<CleanSlackIdentityProviderV1["verifyConnection"]>
      >;
      channel: Awaited<
        ReturnType<CleanSlackIdentityProviderV1["verifyChannel"]>
      >;
    },
  ): boolean {
    return (
      verified.connection.team_id === tool.team_id &&
      verified.connection.enterprise_id === tool.enterprise_id &&
      verified.connection.bot_user_id === tool.bot_user_id &&
      verified.connection.bot_id === tool.bot_id &&
      verified.connection.app_id === tool.app_id &&
      verified.channel.team_id === tool.team_id &&
      verified.channel.channel_id === tool.channel_id
    );
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
