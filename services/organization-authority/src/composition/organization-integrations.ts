import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertFederationId,
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  organizationSlackLinkChallengeCodeSha256,
  validateOrganizationPermissionCheckDecision,
  validateOrganizationPermissionCheckRequest,
  validateOrganizationSlackLinkBeginRequest,
  validateOrganizationSlackLinkBeginResponse,
  validateOrganizationSlackLinkCompleteRequest,
  validateOrganizationReviewerPermissionCheckDecision,
  validateOrganizationReviewerPermissionCheckRequest,
  validateOrganizationSlackLinkResult,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
  type OrganizationReviewerPermissionCheckDecisionV2,
  type OrganizationReviewerPermissionCheckRequestV2,
  type OrganizationReviewerPermissionDenialReasonCodeV2,
  type OrganizationSlackLinkBeginRequestV1,
  type OrganizationSlackLinkBeginResponseV1,
  type OrganizationSlackLinkCompleteRequestV1,
  type OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  OrganizationIntegrationConflictError,
  OrganizationIntegrationsRepository,
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_POLICY_ID,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  SlackIntegrationProviderError,
  reviewerRestrictedAuditDetail,
  reviewerRestrictedSemanticPreimage,
  type ActivateExistingSlackApprovalInput,
  type ActivateExistingSlackApprovalResult,
  type BeginSlackIdentityLinkChallengeInput,
  type CompleteSlackIdentityLinkChallengeInput,
  type OnboardSlackOrganizationToolInput,
  type OnboardSlackOrganizationToolResult,
  type OrganizationIntegrationsOverview,
  type OrganizationPermissionReasonCode,
  type OrganizationSecretStore,
  type SlackApprovalPermissionCandidate,
  type SlackApprovalPermissionLookup,
  type SlackIntegrationProvider,
  type VerifiedSlackReaction,
} from '@echo-brain/organization-control-plane';
import {
  OrganizationAuthorityApplication,
  type OrganizationIntegrationInstallationContext,
  type OrganizationIntegrationOwnerContext,
  type OrganizationPermissionAuthorityStatus,
} from '../application/organization-authority.js';
import type { ActivateOrganizationSlackApprovalRequest } from '../application/slack-approval-activation.js';
import { AuthorityOperationError } from '../domain/errors.js';
import type {
  OnboardOrganizationSlackToolRequest,
  OrganizationIntegrationsHttpApplication,
} from '../presentation/organization-integrations-http-application.js';
import type { OrganizationPermissionPilotRuntimeHealth } from './organization-record.js';

const ADMIN_COMMAND_ID =
  /^adm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

interface NoticeQualifiedSlackPresentation {
  readonly presentation_policy_id: 'pilot-two-person-audience-v1';
  readonly audience_notice_sha256: `sha256:${string}`;
  readonly message_presentation_sha256: `sha256:${string}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function stringField(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      `Slack integration ${label} is invalid`,
    );
  }
  return value;
}

type StringRequest<T extends readonly (readonly [string, number])[]> = {
  [K in T[number][0]]: string;
};

function stringRequest<const T extends readonly (readonly [string, number])[]>(
  value: unknown,
  fields: T,
  shapeError: string,
): StringRequest<T> {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      fields.map(([key]) => key),
    )
  ) {
    throw new AuthorityOperationError('invalid_request', shapeError);
  }
  return Object.fromEntries(
    fields.map(([key, maximum]) => [
      key,
      stringField(value[key], key, maximum),
    ]),
  ) as StringRequest<T>;
}

const ACTIVATION_REQUEST_FIELDS = [
  ['command_id', 128],
  ['administrator_membership_id', 128],
  ['target_membership_id', 128],
  ['installation_id', 128],
  ['identity_link_id', 128],
  ['adapter_binding_id', 128],
] as const;

function validateActivationRequest(
  value: unknown,
): ActivateOrganizationSlackApprovalRequest {
  const result = stringRequest(
    value,
    ACTIVATION_REQUEST_FIELDS,
    'Slack approval activation request has an unexpected shape',
  );
  try {
    if (!ADMIN_COMMAND_ID.test(result.command_id)) {
      throw new Error('invalid admin command ID');
    }
    assertFederationId(
      result.administrator_membership_id,
      'mem',
      'Slack approval activation administrator membership',
    );
    assertFederationId(
      result.target_membership_id,
      'mem',
      'Slack approval activation target membership',
    );
    assertFederationId(
      result.installation_id,
      'ins',
      'Slack approval activation installation',
    );
    assertFederationId(
      result.identity_link_id,
      'clm',
      'Slack approval activation identity link',
    );
    assertFederationId(
      result.adapter_binding_id,
      'bnd',
      'Slack approval activation adapter binding',
    );
  } catch {
    throw new AuthorityOperationError(
      'invalid_request',
      'Slack approval activation identifiers are invalid',
    );
  }
  return result;
}

const SLACK_TOOL_REQUEST_FIELDS = [
  ['command_id', 128],
  ['administrator_membership_id', 128],
  ['channel_id', 128],
  ['slack_bot_token', 16 * 1024],
] as const;

function validateSlackOrganizationToolRequest(
  value: unknown,
): OnboardOrganizationSlackToolRequest {
  const result = stringRequest(
    value,
    SLACK_TOOL_REQUEST_FIELDS,
    'Slack organization tool request has an unexpected shape',
  );
  try {
    if (!ADMIN_COMMAND_ID.test(result.command_id)) {
      throw new Error('invalid admin command ID');
    }
    assertFederationId(
      result.administrator_membership_id,
      'mem',
      'Slack organization tool administrator membership',
    );
  } catch {
    throw new AuthorityOperationError(
      'invalid_request',
      'Slack organization tool identifiers are invalid',
    );
  }
  if (
    !/^C[A-Z0-9]{2,}$/.test(result.channel_id) ||
    !/^xoxb-[A-Za-z0-9-]{8,}$/.test(result.slack_bot_token)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'Slack organization tool provider values are invalid',
    );
  }
  return result;
}

function rawSha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function sameOwnerContext(
  left: OrganizationIntegrationOwnerContext,
  right: OrganizationIntegrationOwnerContext,
): boolean {
  return (
    canonicalJson(left.administrator) === canonicalJson(right.administrator)
  );
}

function sameInstallationContext(
  left: OrganizationIntegrationInstallationContext,
  right: OrganizationIntegrationInstallationContext,
): boolean {
  return (
    left.authority_id === right.authority_id &&
    left.organization_id === right.organization_id &&
    left.enrollment_id === right.enrollment_id &&
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id &&
    left.installation_id === right.installation_id &&
    left.installation_key_id === right.installation_key_id
  );
}

function throwSlackOnboardingError(error: unknown): never {
  if (!(error instanceof SlackIntegrationProviderError)) throw error;
  if (error.code === 'unavailable') {
    throw new AuthorityOperationError(
      'unavailable',
      'Slack organization tool verification is temporarily unavailable',
    );
  }
  throw new AuthorityOperationError(
    'invalid_request',
    'Slack could not verify the bot token and selected public channel',
  );
}

function runSlackIdentityLinkRepository<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof OrganizationIntegrationConflictError ||
      (error instanceof Error &&
        error.message ===
          'organization integration command ID was reused with different input')
    ) {
      throw new AuthorityOperationError('conflict', error.message);
    }
    throw error;
  }
}

async function verifySlackOrganizationTool(
  slack: SlackIntegrationProvider,
  token: string,
  channelId: string,
  signal?: AbortSignal,
): Promise<{
  connection: Awaited<
    ReturnType<SlackIntegrationProvider['verifyConnection']>
  >;
  channel: Awaited<ReturnType<SlackIntegrationProvider['verifyChannel']>>;
}> {
  try {
    const connection = await slack.verifyConnection(token, signal);
    for (const required of SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES) {
      if (!connection.granted_scopes.includes(required)) {
        throw new AuthorityOperationError(
          'invalid_request',
          `Slack bot token is missing required scope ${required}`,
        );
      }
    }
    const channel = await slack.verifyChannel(
      token,
      channelId,
      connection.team_id,
      signal,
    );
    if (
      channel.channel_id !== channelId ||
      channel.team_id !== connection.team_id
    ) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Slack verified a different organization channel',
      );
    }
    return { connection, channel };
  } catch (error) {
    throwSlackOnboardingError(error);
  }
}

function evidenceSha256(
  status: OrganizationPermissionAuthorityStatus,
): `sha256:${string}` {
  return canonicalSha256(status);
}

function slackApprovalPermissionLookup(
  request: OrganizationPermissionCheckRequestV1,
): SlackApprovalPermissionLookup {
  return {
    organization_id: request.organization_id,
    installation_id: request.installation_id,
    installation_key_id: request.installation_key_id,
    adapter_id: request.adapter_id,
    adapter_instance_id: request.adapter_instance_id,
    adapter_version: request.adapter_version,
    channel_id: request.channel_id,
    reaction_name: request.reaction_name,
    slack_team_id: request.provider_tenant_id,
    slack_user_id: request.provider_subject_id,
    slack_enterprise_id: request.provider_enterprise_id,
    slack_bot_user_id: request.provider_connection_subject_id,
    slack_bot_id: request.provider_connection_bot_id,
    slack_app_id: request.provider_connection_app_id,
    action: request.action,
  };
}

/**
 * The reviewer lookup uses the request's frozen `approve_reaction` as the
 * selected reaction, so the currently active binding must still carry the pair
 * the card was published with.
 */
function reviewerApprovalPermissionLookup(
  request: OrganizationReviewerPermissionCheckRequestV2,
): SlackApprovalPermissionLookup {
  return {
    organization_id: request.organization_id,
    installation_id: request.installation_id,
    installation_key_id: request.installation_key_id,
    adapter_id: request.adapter_id,
    adapter_instance_id: request.adapter_instance_id,
    adapter_version: request.adapter_version,
    channel_id: request.channel_id,
    reaction_name: request.approve_reaction,
    slack_team_id: request.provider_tenant_id,
    slack_user_id: request.provider_subject_id,
    slack_enterprise_id: request.provider_enterprise_id,
    slack_bot_user_id: request.provider_connection_subject_id,
    slack_bot_id: request.provider_connection_bot_id,
    slack_app_id: request.provider_connection_app_id,
    action: 'approve',
  };
}

export function reconcileOrganizationIntegrationSecrets(
  repository: OrganizationIntegrationsRepository,
  secrets: OrganizationSecretStore,
): void {
  const rows = repository.organizationSecretReferences();
  const referenced = new Set(
    rows.map(
      ({ reference }) =>
        `${reference.secret_backend_id}:${reference.secret_handle_id}`,
    ),
  );
  for (const { reference, active } of rows) {
    if (!active) continue;
    try {
      secrets.read(reference);
    } catch {
      throw new Error(
        'active organization integration credential is unavailable or insecure',
      );
    }
  }
  for (const reference of secrets.listReferences()) {
    const key = `${reference.secret_backend_id}:${reference.secret_handle_id}`;
    if (!referenced.has(key)) secrets.remove(reference);
  }
}

export class ComposedOrganizationIntegrationsApplication
  implements OrganizationIntegrationsHttpApplication
{
  constructor(
    private readonly options: {
      authority: OrganizationAuthorityApplication;
      repository: OrganizationIntegrationsRepository;
      secrets: OrganizationSecretStore;
      slack: SlackIntegrationProvider;
      permissionPilotHealth: OrganizationPermissionPilotRuntimeHealth;
      now?: () => string;
    },
  ) {}

  overview(): OrganizationIntegrationsOverview {
    return this.options.repository.overview();
  }

  async onboardSlackOrganizationTool(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<OnboardSlackOrganizationToolResult> {
    const request = validateSlackOrganizationToolRequest(value);
    const {
      slack_bot_token: slackBotToken,
      ...nonSecretRequest
    } = request;
    const commandSha256 = canonicalSha256({
      ...nonSecretRequest,
      slack_bot_token_sha256: rawSha256(slackBotToken),
    });
    const replay = this.options.repository.slackOrganizationToolReplay(
      request.command_id,
      commandSha256,
    );
    if (replay !== null) return replay;

    const legacy = this.options.repository.legacySlackOrganizationTool();
    let verificationToken = slackBotToken;
    if (legacy !== null) {
      if (request.channel_id !== legacy.channel_id) {
        throw new AuthorityOperationError(
          'conflict',
          'Slack onboarding channel differs from the existing organization tool',
        );
      }
      try {
        verificationToken = this.options.secrets.read(legacy.secret);
      } catch {
        throw new AuthorityOperationError(
          'unavailable',
          'The existing organization Slack credential is unavailable',
        );
      }
      if (!sameSecret(slackBotToken, verificationToken)) {
        throw new AuthorityOperationError(
          'invalid_request',
          'Slack onboarding must reverify the existing organization credential',
        );
      }
    }

    const before = this.options.authority.integrationOwnerContext(
      request.administrator_membership_id,
    );
    const { connection, channel } = await verifySlackOrganizationTool(
      this.options.slack,
      verificationToken,
      request.channel_id,
      signal,
    );
    const after = this.options.authority.integrationOwnerContext(
      request.administrator_membership_id,
    );
    if (!sameOwnerContext(before, after)) {
      throw new AuthorityOperationError(
        'conflict',
        'organization integration authority state changed during verification',
      );
    }

    const createdSecret = legacy === null;
    const secret = legacy?.secret ?? this.options.secrets.create(slackBotToken);
    try {
      const descriptor = this.options.authority.descriptor();
      const input: OnboardSlackOrganizationToolInput = {
        command_id: request.command_id,
        command_sha256: commandSha256,
        organization_id: descriptor.organization_id,
        authority_id: descriptor.authority_id,
        administrator_principal_id: after.administrator.principal_id,
        administrator_membership_id: after.administrator.membership_id,
        connection,
        channel,
        secret,
        now: this.now(),
      };
      return this.options.repository.onboardSlackOrganizationTool(input);
    } finally {
      if (
        createdSecret &&
        !this.options.repository.secretReferenceIsInUse(secret)
      ) {
        this.options.secrets.remove(secret);
      }
    }
  }

  async beginSlackIdentityLink(
    value: OrganizationSlackLinkBeginRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkBeginResponseV1> {
    const request = validateOrganizationSlackLinkBeginRequest(value);
    const before = this.options.authority.integrationInstallationContext(
      request,
      'Slack identity link begin request',
    );
    const activeTool =
      this.options.repository.activeSlackOrganizationTool();
    if (activeTool === null) {
      throw new AuthorityOperationError(
        'conflict',
        'Slack is not active for this organization',
      );
    }
    let token: string;
    try {
      token = this.options.secrets.read(activeTool.secret);
    } catch {
      throw new AuthorityOperationError(
        'unavailable',
        'The active organization Slack credential is unavailable',
      );
    }
    const { connection, channel } = await verifySlackOrganizationTool(
      this.options.slack,
      token,
      activeTool.channel_id,
      signal,
    );
    if (
      connection.team_id !== activeTool.team_id ||
      connection.enterprise_id !== activeTool.enterprise_id ||
      connection.bot_user_id !== activeTool.bot_user_id ||
      connection.bot_id !== activeTool.bot_id ||
      connection.app_id !== activeTool.app_id ||
      channel.channel_id !== activeTool.channel_id
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'The active organization Slack connection changed during employee linking',
      );
    }
    const afterVerification =
      this.options.authority.integrationInstallationContext(
        request,
        'Slack identity link begin request',
      );
    if (!sameInstallationContext(before, afterVerification)) {
      throw new AuthorityOperationError(
        'conflict',
        'organization installation state changed during Slack verification',
      );
    }
    const installation = {
      authority_id: afterVerification.authority_id,
      organization_id: afterVerification.organization_id,
      enrollment_id: afterVerification.enrollment_id,
      principal_id: afterVerification.principal_id,
      membership_id: afterVerification.membership_id,
      installation_id: afterVerification.installation_id,
      installation_key_id: afterVerification.installation_key_id,
    } satisfies BeginSlackIdentityLinkChallengeInput['installation'];
    const begun = runSlackIdentityLinkRepository(() =>
      this.options.repository.beginSlackIdentityLinkChallenge({
        request_sha256: afterVerification.request_sha256,
        challenge_code_sha256: request.challenge_code_sha256,
        installation,
        organization_tool: activeTool,
        now: afterVerification.checked_at,
      }),
    );
    let posted: Awaited<
      ReturnType<SlackIntegrationProvider['postIdentityLinkChallenge']>
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
        'provider_challenge_post_failed',
      );
      throwSlackOnboardingError(error);
    }
    const afterPost = this.options.authority.integrationInstallationContext(
      request,
      'Slack identity link begin request',
    );
    const currentTool =
      this.options.repository.activeSlackOrganizationTool();
    if (
      !sameInstallationContext(afterVerification, afterPost) ||
      afterPost.checked_at >= begun.expires_at ||
      currentTool === null ||
      canonicalJson(currentTool) !== canonicalJson(activeTool) ||
      posted.team_id !== activeTool.team_id ||
      posted.channel_id !== activeTool.channel_id
    ) {
      this.options.repository.failSlackIdentityLinkChallenge(
        begun.challenge_attempt_id,
        this.now(),
        'authority_or_tool_changed_after_challenge_post',
      );
      throw new AuthorityOperationError(
        'conflict',
        'organization authority state changed while posting the Slack challenge',
      );
    }
    runSlackIdentityLinkRepository(() =>
      this.options.repository.slackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: request.challenge_code_sha256,
        installation,
        organization_tool: currentTool,
        now: afterPost.checked_at,
      }),
    );
    return validateOrganizationSlackLinkBeginResponse({
      schema_version: 1,
      kind: 'echo-organization-slack-link-begin-response',
      challenge_attempt_id: begun.challenge_attempt_id,
      provider: 'slack',
      provider_tenant_id: activeTool.team_id,
      channel_id: activeTool.channel_id,
      challenge_message_ts: posted.challenge_message_ts,
      expires_at: begun.expires_at,
    });
  }

  async completeSlackIdentityLink(
    value: OrganizationSlackLinkCompleteRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkResultV1> {
    const request = validateOrganizationSlackLinkCompleteRequest(value);
    const before = this.options.authority.integrationInstallationContext(
      request,
      'Slack identity link complete request',
    );
    const replay = runSlackIdentityLinkRepository(() =>
      this.options.repository.slackIdentityLinkCompletionReplay(
        request.request_id,
        before.request_sha256,
      ),
    );
    if (replay !== null) {
      return validateOrganizationSlackLinkResult(replay);
    }
    const activeTool =
      this.options.repository.activeSlackOrganizationTool();
    if (activeTool === null) {
      throw new AuthorityOperationError(
        'conflict',
        'Slack is not active for this organization',
      );
    }
    const installation = {
      authority_id: before.authority_id,
      organization_id: before.organization_id,
      enrollment_id: before.enrollment_id,
      principal_id: before.principal_id,
      membership_id: before.membership_id,
      installation_id: before.installation_id,
      installation_key_id: before.installation_key_id,
    } satisfies CompleteSlackIdentityLinkChallengeInput['installation'];
    const codeSha256 = organizationSlackLinkChallengeCodeSha256(
      request.challenge_code,
    );
    const challengeReplay = runSlackIdentityLinkRepository(() =>
      this.options.repository.slackIdentityLinkChallengeCompletionReplay({
        challenge_attempt_id: request.challenge_attempt_id,
        challenge_code_sha256: codeSha256,
        challenge_message_ts: request.challenge_message_ts,
        installation,
        organization_tool: activeTool,
        adapter_id: request.adapter_id,
        adapter_instance_id: request.adapter_instance_id,
        adapter_version: request.adapter_version,
      }),
    );
    if (challengeReplay !== null) {
      if (
        challengeReplay.provider_subject_id !==
        request.expected_provider_subject_id
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'The completed Slack identity proof belongs to a different configured reviewer',
        );
      }
      return validateOrganizationSlackLinkResult(challengeReplay);
    }
    const challenge = runSlackIdentityLinkRepository(() =>
      this.options.repository.slackIdentityLinkChallenge({
        challenge_attempt_id: request.challenge_attempt_id,
        challenge_code_sha256: codeSha256,
        installation,
        organization_tool: activeTool,
        now: before.checked_at,
      }),
    );
    let token: string;
    try {
      token = this.options.secrets.read(activeTool.secret);
    } catch {
      throw new AuthorityOperationError(
        'unavailable',
        'The active organization Slack credential is unavailable',
      );
    }
    let observed: Awaited<
      ReturnType<SlackIntegrationProvider['observeIdentityLinkChallenge']>
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
      if (
        error instanceof SlackIntegrationProviderError &&
        error.code === 'not_observed'
      ) {
        throw new AuthorityOperationError(
          'unavailable',
          'The exact Slack challenge reply has not been observed yet',
        );
      }
      throwSlackOnboardingError(error);
    }
    if (observed.user_id !== request.expected_provider_subject_id) {
      throw new AuthorityOperationError(
        'conflict',
        'The Slack challenge reply came from a different configured reviewer',
      );
    }
    let currentChannel: Awaited<
      ReturnType<SlackIntegrationProvider['verifyChannel']>
    >;
    try {
      currentChannel = await this.options.slack.verifyChannel(
        token,
        activeTool.channel_id,
        activeTool.team_id,
        signal,
      );
    } catch (error) {
      throwSlackOnboardingError(error);
    }
    const after = this.options.authority.integrationInstallationContext(
      request,
      'Slack identity link complete request',
    );
    const currentTool =
      this.options.repository.activeSlackOrganizationTool();
    if (
      !sameInstallationContext(before, after) ||
      currentTool === null ||
      canonicalJson(currentTool) !== canonicalJson(activeTool) ||
      currentChannel.team_id !== activeTool.team_id ||
      currentChannel.channel_id !== activeTool.channel_id
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'organization authority state changed during Slack identity proof',
      );
    }
    return validateOrganizationSlackLinkResult(
      runSlackIdentityLinkRepository(() =>
        this.options.repository.completeSlackIdentityLinkChallenge({
          command_id: request.request_id,
          command_sha256: after.request_sha256,
          challenge_attempt_id: request.challenge_attempt_id,
          challenge_code_sha256: codeSha256,
          challenge_message_ts: request.challenge_message_ts,
          installation,
          organization_tool: currentTool,
          observed,
          adapter_id: request.adapter_id,
          adapter_instance_id: request.adapter_instance_id,
          adapter_version: request.adapter_version,
          authority_checked_at: after.checked_at,
          now: after.checked_at,
        }),
      ),
    );
  }

  activateSlackApproval(value: unknown): ActivateExistingSlackApprovalResult {
    const request = validateActivationRequest(value);
    const context = this.options.authority.integrationAdminContext(
      request.administrator_membership_id,
      request.target_membership_id,
      request.installation_id,
    );
    if (context.target.membership_id !== context.installation.membership_id) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Slack approval activation target membership must own the enrolled installation',
      );
    }

    const descriptor = this.options.authority.descriptor();
    const input: ActivateExistingSlackApprovalInput = {
      command_id: request.command_id,
      command_sha256: canonicalSha256(request),
      organization_id: descriptor.organization_id,
      authority_id: descriptor.authority_id,
      administrator_principal_id: context.administrator.principal_id,
      administrator_membership_id: context.administrator.membership_id,
      target_principal_id: context.target.principal_id,
      target_membership_id: context.target.membership_id,
      installation_id: context.installation.installation_id,
      installation_key_id: context.installation.installation_key_id,
      identity_link_id: request.identity_link_id,
      adapter_binding_id: request.adapter_binding_id,
      now: this.now(),
    };
    return runSlackIdentityLinkRepository(() =>
      this.options.repository.activateExistingSlackApproval(input),
    );
  }

  async checkPermission(
    value: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationPermissionCheckDecisionV1> {
    const request = validateOrganizationPermissionCheckRequest(value);
    const initial = this.options.authority.checkPermissionSubject(
      request,
      null,
    );
    if (!initial.installation_active) {
      return this.recordDecision(
        request,
        initial,
        null,
        false,
        'installation_inactive',
      );
    }
    const lookup = slackApprovalPermissionLookup(request);
    const candidate =
      this.options.repository.findSlackApprovalPermission(lookup);
    if (candidate === null) {
      const current = this.options.authority.checkPermissionSubject(
        request,
        null,
      );
      return this.recordDecision(
        request,
        current,
        null,
        false,
        current.installation_active
          ? 'no_active_link_binding_or_grant'
          : 'installation_inactive',
      );
    }

    const target = {
      principal_id: candidate.principal_id,
      membership_id: candidate.membership_id,
    };
    const expectedPresentation = this.permissionPilotPresentationExpectation();
    let providerVerification: VerifiedSlackReaction | null = null;
    let providerFailure:
      | Extract<
          OrganizationPermissionReasonCode,
          'provider_unavailable' | 'provider_identity_mismatch'
        >
      | null = null;
    try {
      const secret = this.options.secrets.read({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: candidate.secret_handle_id,
      });
      providerVerification = await this.options.slack.verifyReaction(
        secret,
        {
          expected_team_id: request.provider_tenant_id,
          expected_enterprise_id: candidate.slack_enterprise_id,
          expected_bot_user_id: candidate.slack_bot_user_id,
          expected_bot_id: candidate.slack_bot_id,
          expected_app_id: candidate.slack_app_id,
          approval_id: request.approval_id,
          channel_id: request.channel_id,
          message_ts: request.message_ts,
          reaction_name: request.reaction_name,
          opposite_reaction_name:
            request.action === 'approve'
              ? candidate.reject_reaction
              : candidate.approve_reaction,
          user_id: request.provider_subject_id,
          expected_presentation: expectedPresentation,
          // The parser always recognizes the reviewer namespace as an
          // extension. A reviewer card may still be rejected through this
          // unchanged schema-v1 path; the approval call is untouched.
          ...(request.action === 'reject'
            ? { parse_reviewer_card_reactions: true }
            : {}),
        },
        signal,
      );
      const human = await this.options.slack.verifyHuman(
        secret,
        request.provider_subject_id,
        signal,
      );
      if (
        human.team_id !== request.provider_tenant_id ||
        human.user_id !== request.provider_subject_id
      ) {
        throw new SlackIntegrationProviderError(
          'Slack reviewer identity changed during approval verification',
          'unauthorized',
        );
      }
    } catch (error) {
      providerFailure =
        error instanceof SlackIntegrationProviderError &&
        (error.code === 'unauthorized' || error.code === 'identity_mismatch')
          ? 'provider_identity_mismatch'
          : 'provider_unavailable';
    }
    const currentCandidate =
      this.options.repository.findSlackApprovalPermission(lookup);
    const candidateStillActive =
      currentCandidate !== null &&
      canonicalJson(currentCandidate) === canonicalJson(candidate);
    const current = this.options.authority.checkPermissionSubject(
      request,
      target,
    );
    if (!current.installation_active) {
      return this.recordDecision(
        request,
        current,
        candidate,
        false,
        'installation_inactive',
      );
    }
    if (current.target_active !== true) {
      return this.recordDecision(
        request,
        current,
        candidate,
        false,
        'target_membership_inactive',
      );
    }
    if (!candidateStillActive) {
      return this.recordDecision(
        request,
        current,
        null,
        false,
        'no_active_link_binding_or_grant',
      );
    }
    if (providerFailure !== null) {
      const decision = this.recordDecision(
        request,
        current,
        candidate,
        false,
        providerFailure,
      );
      if (providerFailure === 'provider_unavailable') {
        throw new AuthorityOperationError(
          'unavailable',
          `Slack approval verification is temporarily unavailable after ${decision.evaluated_at}`,
        );
      }
      return decision;
    }
    // A rejected reviewer card must prove both of its own frozen reaction
    // names against the current active binding pair. Any pair rotation or
    // conflicting reaction denies rather than reinterpreting the card.
    const reviewerCardReactions = providerVerification?.reviewer_card_reactions;
    if (reviewerCardReactions !== undefined) {
      if (
        request.action !== 'reject' ||
        request.reaction_name !== reviewerCardReactions.reject_reaction ||
        reviewerCardReactions.reject_reaction !== candidate.reject_reaction ||
        reviewerCardReactions.approve_reaction !== candidate.approve_reaction
      ) {
        return this.recordDecision(
          request,
          current,
          candidate,
          false,
          'provider_identity_mismatch',
        );
      }
    }
    if (providerVerification?.observed !== true) {
      const decision = this.recordDecision(
        request,
        current,
        candidate,
        false,
        'provider_reaction_not_observed',
      );
      throw new AuthorityOperationError(
        'unavailable',
        `Slack approval evidence is not yet decisive after ${decision.evaluated_at}`,
      );
    }
    if (
      request.action === 'approve' &&
      this.options.permissionPilotHealth.kind === 'degraded' &&
      providerVerification.presentation_candidate_observed
    ) {
      throw new AuthorityOperationError(
        'unavailable',
        'organization permission pilot presentation verification is temporarily unavailable',
      );
    }
    const noticeProof =
      request.action === 'approve' &&
      expectedPresentation !== null &&
      providerVerification.message_presentation_sha256 !== null &&
      SHA256_DIGEST.test(providerVerification.message_presentation_sha256)
        ? {
            presentation_policy_id:
              expectedPresentation.presentation_policy_id,
            audience_notice_sha256:
              expectedPresentation.audience_notice_sha256,
            message_presentation_sha256:
              providerVerification.message_presentation_sha256,
          }
        : null;
    return this.recordDecision(
      request,
      current,
      candidate,
      true,
      noticeProof === null
        ? 'active_membership_and_direct_grant'
        : 'active_membership_direct_grant_pilot_notice_v1',
      noticeProof,
    );
  }

  /**
   * The schema-v2 reviewer approval.
   *
   * It never consults local adapter, reaction, or credential configuration:
   * the frozen values arrive on the signed request and are matched against the
   * currently active central binding, connection, and live provider identity.
   * An allow additionally requires the Slack reactor's resolved principal and
   * membership to equal the authenticated enrollment's -- reviewer V1 is
   * self-only, so a different linked member is a `provider_identity_mismatch`
   * denial rather than a delegated approval.
   */
  async checkReviewerPermission(
    value: OrganizationReviewerPermissionCheckRequestV2,
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerPermissionCheckDecisionV2> {
    const request = validateOrganizationReviewerPermissionCheckRequest(value);
    const initial = this.options.authority.checkReviewerPermissionSubject(
      request,
      null,
    );
    if (!initial.installation_active) {
      return this.reviewerDenial(request, initial, 'installation_inactive');
    }
    const lookup = reviewerApprovalPermissionLookup(request);
    const candidate =
      this.options.repository.findSlackApprovalPermission(lookup);
    if (candidate === null) {
      const current = this.options.authority.checkReviewerPermissionSubject(
        request,
        null,
      );
      return this.reviewerDenial(
        request,
        current,
        current.installation_active
          ? 'no_active_link_binding_or_grant'
          : 'installation_inactive',
      );
    }
    if (
      candidate.approve_reaction !== request.approve_reaction ||
      candidate.reject_reaction !== request.reject_reaction
    ) {
      const current = this.options.authority.checkReviewerPermissionSubject(
        request,
        null,
      );
      return this.reviewerDenial(
        request,
        current,
        'no_active_link_binding_or_grant',
      );
    }

    const target = {
      principal_id: candidate.principal_id,
      membership_id: candidate.membership_id,
    };
    let providerVerification: VerifiedSlackReaction | null = null;
    let providerFailure:
      | 'provider_unavailable'
      | 'provider_identity_mismatch'
      | null = null;
    try {
      const secret = this.options.secrets.read({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: candidate.secret_handle_id,
      });
      providerVerification = await this.options.slack.verifyReaction(
        secret,
        {
          expected_team_id: request.provider_tenant_id,
          expected_enterprise_id: candidate.slack_enterprise_id,
          expected_bot_user_id: candidate.slack_bot_user_id,
          expected_bot_id: candidate.slack_bot_id,
          expected_app_id: candidate.slack_app_id,
          approval_id: request.approval_id,
          channel_id: request.channel_id,
          message_ts: request.message_ts,
          reaction_name: request.reaction_name,
          opposite_reaction_name: request.reject_reaction,
          user_id: request.provider_subject_id,
          expected_presentation: null,
          expected_reviewer_presentation: {
            policy_id: RESTRICTED_REVIEWER_POLICY_ID,
            approve_reaction: request.approve_reaction,
            reject_reaction: request.reject_reaction,
            reviewer_release_draft_sha256:
              request.reviewer_release_draft_sha256,
            approval_presentation_sha256:
              request.approval_presentation_sha256,
          },
          reviewer_provider_event_sha256: request.provider_event_sha256,
        },
        signal,
      );
      const human = await this.options.slack.verifyHuman(
        secret,
        request.provider_subject_id,
        signal,
      );
      if (
        human.team_id !== request.provider_tenant_id ||
        human.user_id !== request.provider_subject_id
      ) {
        throw new SlackIntegrationProviderError(
          'Slack reviewer identity changed during approval verification',
          'identity_mismatch',
        );
      }
    } catch (error) {
      providerFailure =
        error instanceof SlackIntegrationProviderError &&
        error.code === 'identity_mismatch'
          ? 'provider_identity_mismatch'
          : 'provider_unavailable';
    }
    const currentCandidate =
      this.options.repository.findSlackApprovalPermission(lookup);
    const candidateStillActive =
      currentCandidate !== null &&
      canonicalJson(currentCandidate) === canonicalJson(candidate);
    const current = this.options.authority.checkReviewerPermissionSubject(
      request,
      target,
    );
    if (!current.installation_active) {
      return this.reviewerDenial(request, current, 'installation_inactive');
    }
    if (current.target_active !== true) {
      return this.reviewerDenial(
        request,
        current,
        'target_membership_inactive',
      );
    }
    if (!candidateStillActive) {
      return this.reviewerDenial(
        request,
        current,
        'no_active_link_binding_or_grant',
      );
    }
    // Reviewer V1 is self-only: the human who reacted must be the same
    // principal and the same membership that signed this request.
    if (
      candidate.principal_id !== current.installation_principal_id ||
      candidate.membership_id !== current.installation_membership_id
    ) {
      return this.reviewerDenial(
        request,
        current,
        'provider_identity_mismatch',
      );
    }
    if (providerFailure !== null) {
      const decision = this.reviewerDenial(request, current, providerFailure);
      // `provider_identity_mismatch` is one of the six closed denial reasons:
      // it is a decided answer about who reacted, so it returns the schema-v2
      // decision DTO. Only a genuinely operational provider failure degrades
      // to the fixed unavailable body.
      if (providerFailure === 'provider_unavailable') {
        throw new AuthorityOperationError(
          'unavailable',
          `Slack reviewer approval verification is temporarily unavailable after ${decision.evaluated_at}`,
        );
      }
      return decision;
    }
    if (
      providerVerification?.observed !== true ||
      providerVerification.reviewer_presentation === undefined
    ) {
      const decision = this.reviewerDenial(
        request,
        current,
        'provider_reaction_not_observed',
      );
      throw new AuthorityOperationError(
        'unavailable',
        `Slack reviewer approval evidence is not yet decisive after ${decision.evaluated_at}`,
      );
    }
    const proof = providerVerification.reviewer_presentation;
    if (
      proof.reviewer_release_draft_sha256 !==
        request.reviewer_release_draft_sha256 ||
      proof.approval_presentation_sha256 !==
        request.approval_presentation_sha256
    ) {
      return this.reviewerDenial(
        request,
        current,
        'provider_identity_mismatch',
      );
    }
    const semanticIntentSha256 = canonicalSha256(
      reviewerRestrictedSemanticPreimage({
        authority_id: request.authority_id,
        organization_id: request.organization_id,
        approval_id: request.approval_id,
        reviewer_principal_id: candidate.principal_id,
        reviewer_membership_id: candidate.membership_id,
        reviewer_release_draft_sha256: proof.reviewer_release_draft_sha256,
        approval_presentation_sha256: proof.approval_presentation_sha256,
        evaluated_at: current.evaluated_at,
      }),
    );
    const recorded = this.options.repository.recordReviewerPermissionDecision({
      organization_id: request.organization_id,
      authority_id: request.authority_id,
      request_id: request.request_id,
      request_sha256: current.request_sha256,
      provider_event_sha256: request.provider_event_sha256,
      approval_id: request.approval_id,
      installation_id: request.installation_id,
      reviewer_principal_id: candidate.principal_id,
      reviewer_membership_id: candidate.membership_id,
      identity_link_id: candidate.identity_link_id,
      connection_id: candidate.connection_id,
      adapter_binding_id: candidate.adapter_binding_id,
      permission_grant_id: candidate.permission_grant_id,
      evaluated_at: current.evaluated_at,
      authority_evidence_sha256: evidenceSha256(current),
      detail: reviewerRestrictedAuditDetail({
        authority_id: request.authority_id,
        request_sha256: current.request_sha256,
        provider_event_sha256: request.provider_event_sha256,
        principal_id: candidate.principal_id,
        team_id: request.provider_tenant_id,
        enterprise_id: candidate.slack_enterprise_id,
        bot_user_id: candidate.slack_bot_user_id,
        bot_id: candidate.slack_bot_id,
        app_id: candidate.slack_app_id as string,
        actor_user_id: request.provider_subject_id,
        adapter_id: request.adapter_id,
        adapter_instance_id: request.adapter_instance_id,
        adapter_version: request.adapter_version,
        channel_id: request.channel_id,
        message_ts: request.message_ts,
        reaction_name: request.reaction_name,
        approve_reaction: request.approve_reaction,
        reject_reaction: request.reject_reaction,
        reviewer_release_draft_sha256: proof.reviewer_release_draft_sha256,
        approval_presentation_sha256: proof.approval_presentation_sha256,
        semantic_intent_sha256: semanticIntentSha256,
        message_presentation_sha256: proof.message_presentation_sha256,
      }),
    });
    return validateOrganizationReviewerPermissionCheckDecision({
      schema_version: 2,
      kind: 'echo-organization-permission-check-decision',
      request_sha256: current.request_sha256,
      provider_event_sha256: request.provider_event_sha256,
      allowed: true,
      reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
      principal_id: candidate.principal_id,
      membership_id: candidate.membership_id,
      adapter_binding_id: candidate.adapter_binding_id,
      permission_grant_id: candidate.permission_grant_id,
      evaluated_at: current.evaluated_at,
      authorization_audit_event_id: recorded.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        recorded.authorization_audit_entry_sha256,
      reviewer_release_draft_sha256: proof.reviewer_release_draft_sha256,
      approval_presentation_sha256: proof.approval_presentation_sha256,
      semantic_intent_sha256: semanticIntentSha256,
      message_presentation_sha256: proof.message_presentation_sha256,
    });
  }

  /**
   * A reviewer denial nulls every proof and actor field and creates no
   * integration-audit row: reviewer evidence exists only for an allow.
   */
  private reviewerDenial(
    request: OrganizationReviewerPermissionCheckRequestV2,
    status: OrganizationPermissionAuthorityStatus,
    reasonCode: OrganizationReviewerPermissionDenialReasonCodeV2,
  ): OrganizationReviewerPermissionCheckDecisionV2 {
    return validateOrganizationReviewerPermissionCheckDecision({
      schema_version: 2,
      kind: 'echo-organization-permission-check-decision',
      request_sha256: status.request_sha256,
      provider_event_sha256: request.provider_event_sha256,
      allowed: false,
      reason_code: reasonCode,
      principal_id: null,
      membership_id: null,
      adapter_binding_id: null,
      permission_grant_id: null,
      evaluated_at: status.evaluated_at,
      authorization_audit_event_id: null,
      authorization_audit_entry_sha256: null,
      reviewer_release_draft_sha256: null,
      approval_presentation_sha256: null,
      semantic_intent_sha256: null,
      message_presentation_sha256: null,
    });
  }

  private permissionPilotPresentationExpectation(): {
    readonly presentation_policy_id: 'pilot-two-person-audience-v1';
    readonly audience_notice_sha256: `sha256:${string}`;
    readonly notice_text: string;
    readonly fallback_text: string;
  } | null {
    const health = this.options.permissionPilotHealth;
    if (health.kind === 'absent') return null;
    if (health.kind === 'degraded') return null;
    const activation = health.activation;
    if (
      activation.policy_id !== 'pilot-member-readable-v1' ||
      activation.presentation_policy_id !==
        'pilot-two-person-audience-v1' ||
      !SHA256_DIGEST.test(activation.audience_notice_sha256) ||
      activation.presentation_descriptor.policy_id !== activation.policy_id ||
      activation.presentation_descriptor.presentation_policy_id !==
        activation.presentation_policy_id
    ) {
      throw new AuthorityOperationError(
        'unavailable',
        'organization permission pilot activation is invalid',
      );
    }
    return Object.freeze({
      presentation_policy_id: activation.presentation_policy_id,
      audience_notice_sha256: activation.audience_notice_sha256,
      notice_text: activation.presentation_descriptor.notice_text,
      fallback_text: activation.presentation_descriptor.fallback_text,
    });
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private recordDecision(
    request: OrganizationPermissionCheckRequestV1,
    status: OrganizationPermissionAuthorityStatus,
    candidate: SlackApprovalPermissionCandidate | null,
    allowed: boolean,
    reasonCode: OrganizationPermissionReasonCode,
    noticeProof: NoticeQualifiedSlackPresentation | null = null,
  ): OrganizationPermissionCheckDecisionV1 {
    const recorded = this.options.repository.recordPermissionDecision({
      request_id: request.request_id,
      request_sha256: status.request_sha256,
      provider_event_sha256: request.provider_event_sha256,
      action: request.action,
      allowed,
      reason_code: reasonCode,
      principal_id: candidate?.principal_id ?? null,
      membership_id: candidate?.membership_id ?? null,
      adapter_binding_id: candidate?.adapter_binding_id ?? null,
      permission_grant_id: candidate?.permission_grant_id ?? null,
      evaluated_at: status.evaluated_at,
      authority_evidence_sha256: evidenceSha256(status),
      authority_checked_at: status.evaluated_at,
      organization_id: request.organization_id,
      caller_principal_id: status.installation_principal_id,
      caller_membership_id: status.installation_membership_id,
      installation_id: request.installation_id,
      identity_link_id: candidate?.identity_link_id ?? null,
      connection_id: candidate?.connection_id ?? null,
      approval_id: request.approval_id,
      detail: {
        provider: request.provider,
        provider_tenant_id: request.provider_tenant_id,
        provider_subject_id: request.provider_subject_id,
        adapter_id: request.adapter_id,
        adapter_instance_id: request.adapter_instance_id,
        channel_id: request.channel_id,
        message_ts: request.message_ts,
        reaction_name: request.reaction_name,
        ...(noticeProof === null ? {} : noticeProof),
      },
    });
    return validateOrganizationPermissionCheckDecision({
      schema_version: 1,
      kind: 'echo-organization-permission-check-decision',
      request_sha256: recorded.request_sha256,
      provider_event_sha256: recorded.provider_event_sha256,
      allowed: recorded.allowed,
      reason_code: recorded.reason_code,
      principal_id: recorded.principal_id,
      membership_id: recorded.membership_id,
      adapter_binding_id: recorded.adapter_binding_id,
      permission_grant_id: recorded.permission_grant_id,
      evaluated_at: recorded.evaluated_at,
    });
  }
}
