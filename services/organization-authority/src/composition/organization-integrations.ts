import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertFederationId,
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  validateOrganizationPermissionCheckDecision,
  validateOrganizationPermissionCheckRequest,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  OrganizationIntegrationsRepository,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  SlackIntegrationProviderError,
  type BootstrapSlackApprovalInput,
  type BootstrapSlackApprovalResult,
  type OnboardSlackOrganizationToolInput,
  type OnboardSlackOrganizationToolResult,
  type OrganizationIntegrationsOverview,
  type OrganizationPermissionReasonCode,
  type OrganizationSecretStore,
  type SlackApprovalPermissionCandidate,
  type SlackIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import {
  OrganizationAuthorityApplication,
  type OrganizationIntegrationAdminContext,
  type OrganizationIntegrationOwnerContext,
  type OrganizationPermissionAuthorityStatus,
} from '../application/organization-authority.js';
import { AuthorityOperationError } from '../domain/errors.js';
import type {
  BootstrapOrganizationSlackApprovalRequest,
  OnboardOrganizationSlackToolRequest,
  OrganizationIntegrationsHttpApplication,
} from '../presentation/organization-integrations-http-application.js';

const ADMIN_COMMAND_ID =
  /^adm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      `Slack bootstrap ${label} is invalid`,
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

const BOOTSTRAP_REQUEST_FIELDS = [
  ['command_id', 128],
  ['administrator_membership_id', 128],
  ['target_membership_id', 128],
  ['installation_id', 128],
  ['adapter_instance_id', 128],
  ['adapter_version', 64],
  ['channel_id', 128],
  ['approve_reaction', 64],
  ['reject_reaction', 64],
  ['slack_user_id', 128],
  ['slack_bot_token', 16 * 1024],
] as const;

function validateBootstrapRequest(
  value: unknown,
): BootstrapOrganizationSlackApprovalRequest {
  const result = stringRequest(
    value,
    BOOTSTRAP_REQUEST_FIELDS,
    'Slack bootstrap request has an unexpected shape',
  );
  try {
    if (!ADMIN_COMMAND_ID.test(result.command_id)) {
      throw new Error('invalid admin command ID');
    }
    assertFederationId(
      result.administrator_membership_id,
      'mem',
      'Slack bootstrap administrator membership',
    );
    assertFederationId(
      result.target_membership_id,
      'mem',
      'Slack bootstrap target membership',
    );
    assertFederationId(
      result.installation_id,
      'ins',
      'Slack bootstrap installation',
    );
  } catch {
    throw new AuthorityOperationError(
      'invalid_request',
      'Slack bootstrap organization identifiers are invalid',
    );
  }
  if (
    !/^[a-z][a-z0-9-]{0,127}$/.test(result.adapter_instance_id) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
      result.adapter_version,
    ) ||
    !/^C[A-Z0-9]{2,}$/.test(result.channel_id) ||
    !/^[a-z0-9_+-]{1,64}$/.test(result.approve_reaction) ||
    !/^[a-z0-9_+-]{1,64}$/.test(result.reject_reaction) ||
    result.approve_reaction === result.reject_reaction ||
    !/^U[A-Z0-9]{2,}$/.test(result.slack_user_id) ||
    !/^xoxb-[A-Za-z0-9-]{8,}$/.test(result.slack_bot_token)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'Slack bootstrap adapter or provider identifiers are invalid',
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

function sameAdminContext(
  left: OrganizationIntegrationAdminContext,
  right: OrganizationIntegrationAdminContext,
): boolean {
  return canonicalJson(left.administrator) ===
    canonicalJson(right.administrator) &&
    canonicalJson(left.target) === canonicalJson(right.target) &&
    canonicalJson(left.installation) === canonicalJson(right.installation);
}

function sameOwnerContext(
  left: OrganizationIntegrationOwnerContext,
  right: OrganizationIntegrationOwnerContext,
): boolean {
  return (
    canonicalJson(left.administrator) === canonicalJson(right.administrator)
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

  async bootstrapSlackApproval(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<BootstrapSlackApprovalResult> {
    const request = validateBootstrapRequest(value);
    const {
      slack_bot_token: slackBotToken,
      ...nonSecretRequest
    } = request;
    const commandSha256 = canonicalSha256({
      ...nonSecretRequest,
      slack_bot_token_sha256: rawSha256(slackBotToken),
    });
    const replay = this.options.repository.bootstrapReplay(
      request.command_id,
      commandSha256,
    );
    if (replay !== null) return replay;
    const activeOrganizationTool =
      this.options.repository.activeSlackOrganizationTool();
    if (activeOrganizationTool === null) {
      throw new AuthorityOperationError(
        'conflict',
        'Slack must be activated for the organization before employee approval linking',
      );
    }
    if (request.channel_id !== activeOrganizationTool.channel_id) {
      throw new AuthorityOperationError(
        'conflict',
        'Slack bootstrap channel differs from the active organization tool',
      );
    }
    let organizationSlackToken: string;
    try {
      organizationSlackToken = this.options.secrets.read(
        activeOrganizationTool.secret,
      );
    } catch {
      throw new AuthorityOperationError(
        'unavailable',
        'The active organization Slack credential is unavailable',
      );
    }
    if (!sameSecret(slackBotToken, organizationSlackToken)) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Slack bootstrap must use the active organization credential',
      );
    }

    const before = this.options.authority.integrationAdminContext(
      request.administrator_membership_id,
      request.target_membership_id,
      request.installation_id,
    );
    const { connection, channel } = await verifySlackOrganizationTool(
      this.options.slack,
      organizationSlackToken,
      request.channel_id,
      signal,
    );
    if (
      connection.team_id !== activeOrganizationTool.team_id ||
      connection.enterprise_id !== activeOrganizationTool.enterprise_id ||
      connection.bot_user_id !== activeOrganizationTool.bot_user_id ||
      connection.bot_id !== activeOrganizationTool.bot_id ||
      connection.app_id !== activeOrganizationTool.app_id ||
      channel.channel_id !== activeOrganizationTool.channel_id
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'The active organization Slack connection changed during verification',
      );
    }
    let human: Awaited<ReturnType<SlackIntegrationProvider['verifyHuman']>>;
    try {
      human = await this.options.slack.verifyHuman(
        organizationSlackToken,
        request.slack_user_id,
        signal,
      );
    } catch (error) {
      throwSlackOnboardingError(error);
    }
    if (human.team_id !== connection.team_id) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Slack reviewer belongs to another workspace',
      );
    }
    const after = this.options.authority.integrationAdminContext(
      request.administrator_membership_id,
      request.target_membership_id,
      request.installation_id,
    );
    if (!sameAdminContext(before, after)) {
      throw new AuthorityOperationError(
        'conflict',
        'organization integration authority state changed during verification',
      );
    }

    const descriptor = this.options.authority.descriptor();
    const input: BootstrapSlackApprovalInput = {
      command_id: request.command_id,
      command_sha256: commandSha256,
      organization_id: descriptor.organization_id,
      authority_id: descriptor.authority_id,
      administrator_principal_id: after.administrator.principal_id,
      administrator_membership_id: after.administrator.membership_id,
      target_principal_id: after.target.principal_id,
      target_membership_id: after.target.membership_id,
      installation_id: after.installation.installation_id,
      installation_key_id: after.installation.installation_key_id,
      adapter_id: 'slack-reactions',
      adapter_instance_id: request.adapter_instance_id,
      adapter_version: request.adapter_version,
      channel_id: request.channel_id,
      approve_reaction: request.approve_reaction,
      reject_reaction: request.reject_reaction,
      organization_connection_id: activeOrganizationTool.connection_id,
      connection,
      channel,
      human,
      now: this.now(),
    };
    return this.options.repository.bootstrapSlackApproval(input);
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
    const candidate =
      this.options.repository.findSlackApprovalPermission({
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
      });
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
    let providerObserved = false;
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
      providerObserved = await this.options.slack.verifyReaction(
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
        },
        signal,
      );
    } catch (error) {
      providerFailure =
        error instanceof SlackIntegrationProviderError &&
        error.code === 'unauthorized'
          ? 'provider_identity_mismatch'
          : 'provider_unavailable';
    }
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
    if (!providerObserved) {
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
    return this.recordDecision(
      request,
      current,
      candidate,
      true,
      'active_membership_and_direct_grant',
    );
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
