import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  organizationSlackLinkChallengeCodeSha256,
  organizationPermissionProviderEventSha256,
  type OrganizationPermissionCheckRequestV1,
  type OrganizationSlackLinkBeginRequestV1,
  type OrganizationSlackLinkCompleteRequestV1,
} from '@echo-brain/organization-api';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  OrganizationIntegrationsRepository,
  SlackIntegrationProviderError,
  openOrganizationControlDatabase,
  type OrganizationSecretStore,
  type SlackIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import {
  OrganizationAuthorityApplication,
  type OrganizationIntegrationAdminContext,
  type OrganizationIntegrationInstallationContext,
  type OrganizationIntegrationOwnerContext,
  type OrganizationPermissionAuthorityStatus,
  type OrganizationPermissionAuthorityTarget,
} from '../src/application/organization-authority.js';
import {
  ComposedOrganizationIntegrationsApplication,
  reconcileOrganizationIntegrationSecrets,
} from '../src/composition/organization-integrations.js';

const NOW = '2026-07-29T20:00:00.000Z';
const AUTHORITY_ID = 'oau_11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = 'org_22222222-2222-4222-8222-222222222222';
const ADMIN_PRINCIPAL_ID = 'prn_33333333-3333-4333-8333-333333333333';
const ADMIN_MEMBERSHIP_ID = 'mem_44444444-4444-4444-8444-444444444444';
const TARGET_PRINCIPAL_ID = 'prn_55555555-5555-4555-8555-555555555555';
const TARGET_MEMBERSHIP_ID = 'mem_66666666-6666-4666-8666-666666666666';
const INSTALLATION_ID = 'ins_77777777-7777-4777-8777-777777777777';
const ENROLLMENT_ID = 'enr_88888888-8888-4888-8888-888888888888';
const INSTALLATION_KEY_ID = digest('installation-key');
const AUTHORITY_KEY_ID = digest('authority-key');
const SLACK_TOKEN = 'xoxb-test-token-12345678';
const SECRET_HANDLE_ID = 'sch_99999999-9999-4999-8999-999999999999';
const SLACK_LINK_CODE = `${'A'.repeat(42)}E`;

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function openRepository(): OrganizationIntegrationsRepository {
  const database = openOrganizationControlDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, digest('authority'), NOW);
  return new OrganizationIntegrationsRepository(database, {
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
  });
}

function request(
  overrides: Partial<OrganizationPermissionCheckRequestV1> = {},
): OrganizationPermissionCheckRequestV1 {
  const event = {
    authority_id: AUTHORITY_ID,
    authority_key_id: AUTHORITY_KEY_ID,
    organization_id: ORGANIZATION_ID,
    enrollment_id: ENROLLMENT_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: INSTALLATION_KEY_ID,
    provider: 'slack',
    provider_issuer: 'https://slack.com',
    provider_tenant_kind: 'workspace',
    provider_tenant_id: 'T123ABC',
    provider_enterprise_id: null,
    provider_connection_subject_id: 'U123BOT',
    provider_connection_bot_id: 'B123BOT',
    provider_connection_app_id: 'A123APP',
    provider_subject_kind: 'human_user',
    provider_subject_id: 'U123ZHEN',
    adapter_kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'primary',
    adapter_version: '1.0.0',
    action: 'approve',
    approval_id: 'f'.repeat(64),
    channel_id: 'C123ABC',
    message_ts: '1720000000.123456',
    reaction_name: 'white_check_mark',
  } as const;
  const value: OrganizationPermissionCheckRequestV1 = {
    schema_version: 1,
    kind: 'echo-organization-permission-check-request',
    request_id: 'pcr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ...event,
    provider_event_sha256:
      organizationPermissionProviderEventSha256(event),
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('permission-request-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  };
  return { ...value, ...overrides };
}

function slackLinkBeginRequest(): OrganizationSlackLinkBeginRequestV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-slack-link-begin-request',
    request_id: 'slb_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authority_id: AUTHORITY_ID,
    authority_key_id: AUTHORITY_KEY_ID,
    organization_id: ORGANIZATION_ID,
    enrollment_id: ENROLLMENT_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: INSTALLATION_KEY_ID,
    challenge_code_sha256:
      organizationSlackLinkChallengeCodeSha256(SLACK_LINK_CODE),
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('Slack-link-begin-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  };
}

function slackLinkCompleteRequest(
  challengeAttemptId: string,
  challengeMessageTs: string,
): OrganizationSlackLinkCompleteRequestV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-slack-link-complete-request',
    request_id: 'slc_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    authority_id: AUTHORITY_ID,
    authority_key_id: AUTHORITY_KEY_ID,
    organization_id: ORGANIZATION_ID,
    enrollment_id: ENROLLMENT_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: INSTALLATION_KEY_ID,
    challenge_attempt_id: challengeAttemptId,
    challenge_message_ts: challengeMessageTs,
    challenge_code: SLACK_LINK_CODE,
    expected_provider_subject_id: 'U123ZHEN',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'primary',
    adapter_version: '1.0.0',
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('Slack-link-complete-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  };
}

function adminContext(): OrganizationIntegrationAdminContext {
  return {
    administrator: {
      principal_id: ADMIN_PRINCIPAL_ID,
      membership_id: ADMIN_MEMBERSHIP_ID,
    },
    target: {
      principal_id: TARGET_PRINCIPAL_ID,
      membership_id: TARGET_MEMBERSHIP_ID,
    },
    installation: {
      principal_id: TARGET_PRINCIPAL_ID,
      membership_id: TARGET_MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: INSTALLATION_KEY_ID,
    },
    checked_at: NOW,
  };
}

function ownerContext(): OrganizationIntegrationOwnerContext {
  return {
    administrator: {
      principal_id: ADMIN_PRINCIPAL_ID,
      membership_id: ADMIN_MEMBERSHIP_ID,
    },
    checked_at: NOW,
  };
}

function installationContext(
  requestId: string,
): OrganizationIntegrationInstallationContext {
  return {
    request_sha256: digest(`Slack-link:${requestId}`),
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    enrollment_id: ENROLLMENT_ID,
    principal_id: TARGET_PRINCIPAL_ID,
    membership_id: TARGET_MEMBERSHIP_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: INSTALLATION_KEY_ID,
    checked_at: NOW,
  };
}

function permissionStatus(
  value: OrganizationPermissionCheckRequestV1,
  target: OrganizationPermissionAuthorityTarget | null,
  targetActive = true,
): OrganizationPermissionAuthorityStatus {
  return {
    request_sha256: digest(`request:${value.request_id}`),
    provider_event_sha256: value.provider_event_sha256,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    enrollment_id: ENROLLMENT_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: INSTALLATION_KEY_ID,
    installation_principal_id: TARGET_PRINCIPAL_ID,
    installation_membership_id: TARGET_MEMBERSHIP_ID,
    installation_active: true,
    target_principal_id: target?.principal_id ?? null,
    target_membership_id: target?.membership_id ?? null,
    target_active: target === null ? null : targetActive,
    evaluated_at: NOW,
  };
}

function testDependencies(options: {
  channel?: Error;
  connectionScopes?: readonly string[];
  ownerChanged?: boolean;
  targetActive?: boolean;
  reaction?: boolean | Error;
} = {}) {
  let storedSecret: string | null = null;
  const reference = {
    secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
    secret_handle_id: SECRET_HANDLE_ID,
  } as const;
  const secrets: OrganizationSecretStore = {
    create: vi.fn((secret: string) => {
      storedSecret = secret;
      return reference;
    }),
    read: vi.fn(() => {
      if (storedSecret === null) throw new Error('secret unavailable');
      return storedSecret;
    }),
    listReferences: vi.fn(() =>
      storedSecret === null ? [] : [reference],
    ),
    remove: vi.fn(() => {
      storedSecret = null;
    }),
  };
  const slack: SlackIntegrationProvider = {
    verifyConnection: vi.fn(async () => ({
      team_id: 'T123ABC',
      enterprise_id: null,
      bot_user_id: 'U123BOT',
      bot_id: 'B123BOT',
      app_id: 'A123APP',
      granted_scopes: options.connectionScopes ?? [
        'channels:history',
        'channels:read',
        'chat:write',
        'reactions:read',
        'users:read',
      ],
      verification_evidence_sha256: digest('slack-connection'),
    })),
    verifyChannel: vi.fn(async () => {
      if (options.channel instanceof Error) throw options.channel;
      return {
        channel_id: 'C123ABC',
        team_id: 'T123ABC',
        verification_evidence_sha256: digest('slack-channel'),
      };
    }),
    verifyHuman: vi.fn(async () => ({
      team_id: 'T123ABC',
      user_id: 'U123ZHEN',
      verification_evidence_sha256: digest('slack-human'),
    })),
    verifyReaction: vi.fn(async () => {
      if (options.reaction instanceof Error) throw options.reaction;
      return options.reaction ?? true;
    }),
    postIdentityLinkChallenge: vi.fn(async () => ({
      team_id: 'T123ABC',
      channel_id: 'C123ABC',
      challenge_message_ts: '1753822800.000001',
    })),
    observeIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: 'T123ABC',
      user_id: 'U123ZHEN',
      channel_id: 'C123ABC',
      challenge_message_ts: input.challenge_message_ts,
      reply_message_ts: '1753822801.000001',
      verification_evidence_sha256: digest('slack-link-observation'),
    })),
  };
  let ownerCheck = 0;
  const integrationOwnerContext = vi.fn(() => {
    ownerCheck += 1;
    if (options.ownerChanged === true && ownerCheck > 1) {
      return {
        administrator: {
          principal_id: TARGET_PRINCIPAL_ID,
          membership_id: ADMIN_MEMBERSHIP_ID,
        },
        checked_at: NOW,
      };
    }
    return ownerContext();
  });
  const integrationAdminContext = vi.fn(() => adminContext());
  const integrationInstallationContext = vi.fn(
    (value: { request_id: string }) => installationContext(value.request_id),
  );
  const checkPermissionSubject = vi.fn(
    (
      value: OrganizationPermissionCheckRequestV1,
      target: OrganizationPermissionAuthorityTarget | null,
    ) =>
      permissionStatus(
        value,
        target,
        options.targetActive ?? true,
      ),
  );
  const authority = {
    descriptor: () => ({
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
    }),
    integrationOwnerContext,
    integrationAdminContext,
    integrationInstallationContext,
    checkPermissionSubject,
  } as unknown as OrganizationAuthorityApplication;
  return {
    authority,
    integrationOwnerContext,
    integrationAdminContext,
    integrationInstallationContext,
    checkPermissionSubject,
    secrets,
    slack,
  };
}

async function onboardSlackOrganizationTool(
  application: ComposedOrganizationIntegrationsApplication,
  commandId = 'adm_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
) {
  return application.onboardSlackOrganizationTool({
    command_id: commandId,
    administrator_membership_id: ADMIN_MEMBERSHIP_ID,
    channel_id: 'C123ABC',
    slack_bot_token: SLACK_TOKEN,
  });
}

async function bootstrapRequest(
  application: ComposedOrganizationIntegrationsApplication,
) {
  return application.bootstrapSlackApproval({
    command_id: 'adm_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    administrator_membership_id: ADMIN_MEMBERSHIP_ID,
    target_membership_id: TARGET_MEMBERSHIP_ID,
    installation_id: INSTALLATION_ID,
    adapter_instance_id: 'primary',
    adapter_version: '1.0.0',
    channel_id: 'C123ABC',
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    slack_user_id: 'U123ZHEN',
    slack_bot_token: SLACK_TOKEN,
  });
}

async function bootstrap(
  application: ComposedOrganizationIntegrationsApplication,
) {
  await onboardSlackOrganizationTool(application);
  return bootstrapRequest(application);
}

function applicationFixture(
  dependencies = testDependencies(),
): {
  repository: OrganizationIntegrationsRepository;
  dependencies: ReturnType<typeof testDependencies>;
  application: ComposedOrganizationIntegrationsApplication;
} {
  const repository = openRepository();
  return {
    repository,
    dependencies,
    application: new ComposedOrganizationIntegrationsApplication({
      ...dependencies,
      repository,
      now: () => NOW,
    }),
  };
}

describe('composed organization integrations application', () => {
  it('activates one verified organization Slack tool without linking an employee or installation', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      const result = await onboardSlackOrganizationTool(application);
      const replay = await onboardSlackOrganizationTool(application);
      const publicState = JSON.stringify({
        result,
        overview: application.overview(),
      });

      expect(replay).toEqual(result);
      expect(dependencies.integrationOwnerContext).toHaveBeenCalledTimes(2);
      expect(dependencies.slack.verifyConnection).toHaveBeenCalledTimes(1);
      expect(dependencies.slack.verifyChannel).toHaveBeenCalledWith(
        SLACK_TOKEN,
        'C123ABC',
        'T123ABC',
        undefined,
      );
      expect(dependencies.slack.verifyHuman).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        organization_id: ORGANIZATION_ID,
        provider: 'slack',
        status: 'active',
        slack_team_id: 'T123ABC',
        channel_id: 'C123ABC',
      });
      expect(publicState).not.toContain(SLACK_TOKEN);
      expect(publicState).not.toContain(SECRET_HANDLE_ID);

      const overview = application.overview();
      expect(overview.identity_links).toEqual([]);
      expect(overview.adapter_bindings).toEqual([]);
      expect(overview.permission_grants).toEqual([]);
      expect(overview.tool_connections).toEqual([
        expect.objectContaining({
          owner_kind: 'organization',
          provider: 'slack',
          status: 'active',
          public_configuration_json: expect.stringContaining(
            '"channel_id":"C123ABC"',
          ),
        }),
      ]);
      expect(overview.recent_audit).toEqual([
        expect.objectContaining({
          action: 'organization_tool.slack.onboarded',
          outcome: 'succeeded',
        }),
      ]);
    } finally {
      repository.close();
    }
  });

  it('lets an enrolled installation prove its Slack human without creating grants', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await onboardSlackOrganizationTool(application);
      const challenge = await application.beginSlackIdentityLink(
        slackLinkBeginRequest(),
      );
      const completionRequest = slackLinkCompleteRequest(
        challenge.challenge_attempt_id,
        challenge.challenge_message_ts,
      );
      const result =
        await application.completeSlackIdentityLink(completionRequest);
      const replay =
        await application.completeSlackIdentityLink(completionRequest);
      const responseLossRetry =
        await application.completeSlackIdentityLink({
          ...completionRequest,
          request_id: 'slc_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          integrity: {
            ...completionRequest.integrity,
            payload_sha256: digest('Slack-link-complete-retry-payload'),
          },
        });
      await expect(
        application.completeSlackIdentityLink({
          ...completionRequest,
          request_id: 'slc_ffffffff-ffff-4fff-8fff-ffffffffffff',
          challenge_code: `${'B'.repeat(42)}E`,
          integrity: {
            ...completionRequest.integrity,
            payload_sha256: digest('Slack-link-wrong-code-payload'),
          },
        }),
      ).rejects.toMatchObject({
        name: 'AuthorityOperationError',
        code: 'conflict',
      });

      expect(challenge).toMatchObject({
        provider: 'slack',
        provider_tenant_id: 'T123ABC',
        channel_id: 'C123ABC',
      });
      expect(
        dependencies.slack.postIdentityLinkChallenge,
      ).toHaveBeenCalledWith(
        SLACK_TOKEN,
        expect.objectContaining({
          challenge_attempt_id: challenge.challenge_attempt_id,
          channel_id: 'C123ABC',
        }),
        undefined,
      );
      expect(
        dependencies.slack.observeIdentityLinkChallenge,
      ).toHaveBeenCalledWith(
        SLACK_TOKEN,
        expect.objectContaining({
          challenge_attempt_id: challenge.challenge_attempt_id,
          challenge_message_ts: challenge.challenge_message_ts,
          challenge_code: SLACK_LINK_CODE,
        }),
        undefined,
      );
      expect(result).toMatchObject({
        organization_id: ORGANIZATION_ID,
        principal_id: TARGET_PRINCIPAL_ID,
        membership_id: TARGET_MEMBERSHIP_ID,
        installation_id: INSTALLATION_ID,
        provider_subject_id: 'U123ZHEN',
        identity_link_created: true,
        adapter_binding_created: true,
        permission_grants_created: 0,
      });
      expect(replay).toEqual(result);
      expect(responseLossRetry).toEqual(result);
      expect(
        dependencies.slack.observeIdentityLinkChallenge,
      ).toHaveBeenCalledTimes(1);
      expect(application.overview().identity_links).toHaveLength(1);
      expect(application.overview().adapter_bindings).toHaveLength(1);
      expect(application.overview().permission_grants).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('refuses to link a Slack human different from the configured reviewer', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await onboardSlackOrganizationTool(application);
      vi.mocked(
        dependencies.slack.observeIdentityLinkChallenge,
      ).mockImplementationOnce(async (_token, input) => ({
        team_id: 'T123ABC',
        user_id: 'U999OTHER',
        channel_id: 'C123ABC',
        challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: '1753822801.000001',
        verification_evidence_sha256: digest(
          'other-slack-link-observation',
        ),
      }));
      const challenge = await application.beginSlackIdentityLink(
        slackLinkBeginRequest(),
      );

      await expect(
        application.completeSlackIdentityLink(
          slackLinkCompleteRequest(
            challenge.challenge_attempt_id,
            challenge.challenge_message_ts,
          ),
        ),
      ).rejects.toMatchObject({
        name: 'AuthorityOperationError',
        code: 'conflict',
      });
      expect(application.overview().identity_links).toEqual([]);
      expect(application.overview().adapter_bindings).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('does not link an employee when the Slack channel becomes ineligible during completion', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await onboardSlackOrganizationTool(application);
      const challenge = await application.beginSlackIdentityLink(
        slackLinkBeginRequest(),
      );
      vi.mocked(dependencies.slack.verifyChannel).mockRejectedValueOnce(
        new SlackIntegrationProviderError(
          'Slack channel is archived',
          'not_observed',
        ),
      );

      await expect(
        application.completeSlackIdentityLink(
          slackLinkCompleteRequest(
            challenge.challenge_attempt_id,
            challenge.challenge_message_ts,
          ),
        ),
      ).rejects.toMatchObject({
        name: 'AuthorityOperationError',
        code: 'invalid_request',
      });
      expect(
        dependencies.slack.observeIdentityLinkChallenge,
      ).toHaveBeenCalledOnce();
      expect(dependencies.slack.verifyChannel).toHaveBeenLastCalledWith(
        SLACK_TOKEN,
        'C123ABC',
        'T123ABC',
        undefined,
      );
      expect(application.overview().identity_links).toEqual([]);
      expect(application.overview().adapter_bindings).toEqual([]);
      expect(application.overview().permission_grants).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('reverifies and promotes the existing Slack credential without creating a parallel secret', async () => {
    const dependencies = testDependencies();
    const existingSecret = dependencies.secrets.create(SLACK_TOKEN);
    vi.mocked(dependencies.secrets.create).mockClear();
    const connectionId = 'con_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = {
      connection_attempt_id: 'cat_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      connection_id: connectionId,
      organization_id: ORGANIZATION_ID,
      provider: 'slack',
      status: 'active',
      slack_team_id: 'T123ABC',
      slack_bot_user_id: 'U123BOT',
      channel_id: 'C123ABC',
      granted_scopes: [
        'channels:history',
        'channels:read',
        'chat:write',
        'reactions:read',
        'users:read',
      ],
      activated_at: '2026-07-28T20:00:00.000Z',
    } as const;
    const repository = {
      slackOrganizationToolReplay: vi.fn(() => null),
      legacySlackOrganizationTool: vi.fn(() => ({
        connection_attempt_id: 'cat_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        connection_id: connectionId,
        activated_at: result.activated_at,
        team_id: 'T123ABC',
        enterprise_id: null,
        bot_user_id: 'U123BOT',
        bot_id: 'B123BOT',
        app_id: 'A123APP',
        channel_id: 'C123ABC',
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
        granted_scopes: [
          'channels:history',
          'chat:write',
          'reactions:read',
          'users:read',
        ],
        secret: existingSecret,
      })),
      onboardSlackOrganizationTool: vi.fn(() => result),
      secretReferenceIsInUse: vi.fn(() => true),
    } as unknown as OrganizationIntegrationsRepository;
    const application = new ComposedOrganizationIntegrationsApplication({
      ...dependencies,
      repository,
      now: () => NOW,
    });

    await expect(onboardSlackOrganizationTool(application)).resolves.toBe(
      result,
    );
    expect(dependencies.secrets.read).toHaveBeenCalledWith(existingSecret);
    expect(dependencies.secrets.create).not.toHaveBeenCalled();
    expect(dependencies.secrets.remove).not.toHaveBeenCalled();
    expect(dependencies.slack.verifyConnection).toHaveBeenCalledWith(
      SLACK_TOKEN,
      undefined,
    );
    expect(repository.onboardSlackOrganizationTool).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          team_id: 'T123ABC',
          bot_user_id: 'U123BOT',
        }),
        channel: expect.objectContaining({ channel_id: 'C123ABC' }),
        secret: existingSecret,
      }),
    );
  });

  it('leaves Slack inactive when provider or owner verification fails', async () => {
    for (const dependencies of [
      testDependencies({
        channel: new SlackIntegrationProviderError(
          'channel is unavailable',
          'not_observed',
        ),
      }),
      testDependencies({ ownerChanged: true }),
      testDependencies({
        connectionScopes: [
          'channels:history',
          'chat:write',
          'reactions:read',
          'users:read',
        ],
      }),
    ]) {
      const { repository, application } = applicationFixture(dependencies);
      try {
        await expect(
          onboardSlackOrganizationTool(application),
        ).rejects.toBeInstanceOf(Error);
        expect(application.overview().tool_connections).toEqual([]);
        expect(application.overview().recent_audit).toEqual([]);
        expect(dependencies.secrets.create).not.toHaveBeenCalled();
      } finally {
        repository.close();
      }
    }
  });

  it('fails readiness for a missing active credential and removes only unreferenced secrets', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await onboardSlackOrganizationTool(application);
      dependencies.secrets.remove({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: SECRET_HANDLE_ID,
      });
      expect(() =>
        reconcileOrganizationIntegrationSecrets(
          repository,
          dependencies.secrets,
        ),
      ).toThrow('active organization integration credential is unavailable');
    } finally {
      repository.close();
    }

    const emptyRepository = openRepository();
    try {
      const remove = vi.fn();
      const orphanStore: OrganizationSecretStore = {
        create: vi.fn(),
        read: vi.fn(() => SLACK_TOKEN),
        listReferences: vi.fn(() => [
          Object.freeze({
            secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
            secret_handle_id: SECRET_HANDLE_ID,
          }),
        ]),
        remove,
      };
      reconcileOrganizationIntegrationSecrets(
        emptyRepository,
        orphanStore,
      );
      expect(remove).toHaveBeenCalledWith({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: SECRET_HANDLE_ID,
      });
    } finally {
      emptyRepository.close();
    }
  });

  it('bootstraps the exact Slack membership, binding, and grants without returning the token', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      const result = await bootstrap(application);
      const serializedPublicState = JSON.stringify({
        result,
        overview: application.overview(),
      });

      expect(dependencies.integrationAdminContext).toHaveBeenCalledTimes(2);
      expect(dependencies.slack.verifyConnection).toHaveBeenCalledWith(
        SLACK_TOKEN,
        undefined,
      );
      expect(dependencies.slack.verifyChannel).toHaveBeenCalledWith(
        SLACK_TOKEN,
        'C123ABC',
        'T123ABC',
        undefined,
      );
      expect(dependencies.slack.verifyHuman).toHaveBeenCalledWith(
        SLACK_TOKEN,
        'U123ZHEN',
        undefined,
      );
      expect(result).toMatchObject({
        membership_id: TARGET_MEMBERSHIP_ID,
        installation_id: INSTALLATION_ID,
        slack_team_id: 'T123ABC',
        slack_user_id: 'U123ZHEN',
        channel_id: 'C123ABC',
      });
      expect(dependencies.secrets.create).toHaveBeenCalledTimes(1);
      expect(application.overview().tool_connections).toHaveLength(1);
      expect(application.overview().tool_connections[0]).toMatchObject({
        connection_id: result.connection_id,
      });
      expect(serializedPublicState).not.toContain(SLACK_TOKEN);
      expect(application.overview().permission_grants).toEqual([
        expect.objectContaining({
          membership_id: TARGET_MEMBERSHIP_ID,
          action: 'approve',
          status: 'active',
        }),
        expect.objectContaining({
          membership_id: TARGET_MEMBERSHIP_ID,
          action: 'reject',
          status: 'active',
        }),
      ]);
      for (const action of ['approve', 'reject'] as const) {
        expect(
          repository.findSlackApprovalPermission({
            organization_id: ORGANIZATION_ID,
            installation_id: INSTALLATION_ID,
            installation_key_id: INSTALLATION_KEY_ID,
            adapter_id: 'slack-reactions',
            adapter_instance_id: 'primary',
            adapter_version: '1.0.0',
            channel_id: 'C123ABC',
            reaction_name:
              action === 'approve' ? 'white_check_mark' : 'x',
            slack_team_id: 'T123ABC',
            slack_user_id: 'U123ZHEN',
            slack_enterprise_id: null,
            slack_bot_user_id: 'U123BOT',
            slack_bot_id: 'B123BOT',
            slack_app_id: 'A123APP',
            action,
          }),
        ).toMatchObject({
          principal_id: TARGET_PRINCIPAL_ID,
          membership_id: TARGET_MEMBERSHIP_ID,
        });
      }
    } finally {
      repository.close();
    }
  });

  it('rejects a second Slack credential instead of creating a parallel connection', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await onboardSlackOrganizationTool(application);

      await expect(
        application.bootstrapSlackApproval({
          command_id: 'adm_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          administrator_membership_id: ADMIN_MEMBERSHIP_ID,
          target_membership_id: TARGET_MEMBERSHIP_ID,
          installation_id: INSTALLATION_ID,
          adapter_instance_id: 'primary',
          adapter_version: '1.0.0',
          channel_id: 'C123ABC',
          approve_reaction: 'white_check_mark',
          reject_reaction: 'x',
          slack_user_id: 'U123ZHEN',
          slack_bot_token: 'xoxb-different-token-12345678',
        }),
      ).rejects.toThrow('active organization credential');
      expect(dependencies.slack.verifyHuman).not.toHaveBeenCalled();
      expect(dependencies.secrets.create).toHaveBeenCalledTimes(1);
      expect(application.overview().tool_connections).toHaveLength(1);
      expect(application.overview().identity_links).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('requires the organization Slack tool before employee approval linking', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await expect(bootstrapRequest(application)).rejects.toThrow(
        'Slack must be activated for the organization',
      );
      expect(dependencies.slack.verifyConnection).not.toHaveBeenCalled();
      expect(dependencies.slack.verifyChannel).not.toHaveBeenCalled();
      expect(dependencies.slack.verifyHuman).not.toHaveBeenCalled();
      expect(dependencies.secrets.create).not.toHaveBeenCalled();
      expect(application.overview().tool_connections).toEqual([]);
      expect(application.overview().identity_links).toEqual([]);
      expect(application.overview().adapter_bindings).toEqual([]);
      expect(application.overview().permission_grants).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('accepts an Enterprise Grid W user in the legacy bootstrap request', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await expect(
        application.bootstrapSlackApproval({
          command_id: 'adm_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          administrator_membership_id: ADMIN_MEMBERSHIP_ID,
          target_membership_id: TARGET_MEMBERSHIP_ID,
          installation_id: INSTALLATION_ID,
          adapter_instance_id: 'primary',
          adapter_version: '1.0.0',
          channel_id: 'C123ABC',
          approve_reaction: 'white_check_mark',
          reject_reaction: 'x',
          slack_user_id: 'W123ZHEN',
          slack_bot_token: SLACK_TOKEN,
        }),
      ).rejects.toThrow('Slack must be activated for the organization');
      expect(dependencies.integrationAdminContext).not.toHaveBeenCalled();
    } finally {
      repository.close();
    }
  });

  it('allows the exact signed request only after Slack verifies its reaction', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await bootstrap(application);

      const command = request();
      const decision = await application.checkPermission(command);

      expect(decision).toMatchObject({
        allowed: true,
        reason_code: 'active_membership_and_direct_grant',
        principal_id: TARGET_PRINCIPAL_ID,
        membership_id: TARGET_MEMBERSHIP_ID,
        provider_event_sha256: command.provider_event_sha256,
      });
      expect(dependencies.checkPermissionSubject).toHaveBeenCalledTimes(2);
      expect(dependencies.slack.verifyReaction).toHaveBeenCalledWith(
        SLACK_TOKEN,
        {
          expected_team_id: 'T123ABC',
          expected_enterprise_id: null,
          expected_bot_user_id: 'U123BOT',
          expected_bot_id: 'B123BOT',
          expected_app_id: 'A123APP',
          approval_id: 'f'.repeat(64),
          channel_id: 'C123ABC',
          message_ts: '1720000000.123456',
          reaction_name: 'white_check_mark',
          opposite_reaction_name: 'x',
          user_id: 'U123ZHEN',
        },
        undefined,
      );
      expect(dependencies.slack.verifyHuman).toHaveBeenCalledWith(
        SLACK_TOKEN,
        'U123ZHEN',
        undefined,
      );
      expect(application.overview().recent_audit[0]).toMatchObject({
        action: 'permission.approve',
        membership_id: TARGET_MEMBERSHIP_ID,
        outcome: 'allowed',
      });
    } finally {
      repository.close();
    }
  });

  it('rechecks revocation state instead of replaying an earlier allow', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await bootstrap(application);
      const command = request();

      await expect(application.checkPermission(command)).resolves.toMatchObject({
        allowed: true,
      });
      dependencies.checkPermissionSubject.mockImplementation(
        (
          value: OrganizationPermissionCheckRequestV1,
          target: OrganizationPermissionAuthorityTarget | null,
        ) => permissionStatus(value, target, false),
      );

      await expect(application.checkPermission(command)).resolves.toMatchObject({
        allowed: false,
        reason_code: 'target_membership_inactive',
      });
      expect(dependencies.slack.verifyReaction).toHaveBeenCalledTimes(2);
      expect(application.overview().recent_audit).toEqual([
        expect.objectContaining({
          action: 'permission.approve',
          outcome: 'denied',
          reason_code: 'target_membership_inactive',
        }),
        expect.objectContaining({
          action: 'permission.approve',
          outcome: 'allowed',
        }),
        expect.objectContaining({
          action: 'slack_approval.bootstrap',
        }),
        expect.objectContaining({
          action: 'organization_tool.slack.onboarded',
        }),
      ]);
    } finally {
      repository.close();
    }
  });

  it('denies when Slack no longer exposes the reacting user as an active human', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await bootstrap(application);
      vi.mocked(dependencies.slack.verifyHuman).mockRejectedValueOnce(
        new SlackIntegrationProviderError(
          'Slack reviewer is deleted',
          'unauthorized',
        ),
      );

      await expect(application.checkPermission(request())).resolves.toMatchObject({
        allowed: false,
        reason_code: 'provider_identity_mismatch',
        principal_id: TARGET_PRINCIPAL_ID,
        membership_id: TARGET_MEMBERSHIP_ID,
      });
      expect(dependencies.slack.verifyReaction).toHaveBeenCalledOnce();
      expect(dependencies.slack.verifyHuman).toHaveBeenCalledWith(
        SLACK_TOKEN,
        'U123ZHEN',
        undefined,
      );
      expect(application.overview().recent_audit[0]).toMatchObject({
        action: 'permission.approve',
        outcome: 'denied',
        reason_code: 'provider_identity_mismatch',
      });
    } finally {
      repository.close();
    }
  });

  it('denies when Slack resolves the reacting user outside the exact workspace identity', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await bootstrap(application);
      vi.mocked(dependencies.slack.verifyHuman).mockResolvedValueOnce({
        team_id: 'T999OTHER',
        user_id: 'U123ZHEN',
        verification_evidence_sha256: digest('other-workspace-human'),
      });

      await expect(application.checkPermission(request())).resolves.toMatchObject({
        allowed: false,
        reason_code: 'provider_identity_mismatch',
      });
      expect(application.overview().recent_audit[0]).toMatchObject({
        action: 'permission.approve',
        outcome: 'denied',
        reason_code: 'provider_identity_mismatch',
      });
    } finally {
      repository.close();
    }
  });

  it('denies when the exact integration candidate is revoked during Slack verification', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await bootstrap(application);
      vi.mocked(dependencies.slack.verifyHuman).mockClear();
      const lookup =
        OrganizationIntegrationsRepository.prototype
          .findSlackApprovalPermission;
      const find = vi
        .spyOn(repository, 'findSlackApprovalPermission')
        .mockImplementationOnce((input) => lookup.call(repository, input))
        .mockReturnValueOnce(null);

      await expect(application.checkPermission(request())).resolves.toMatchObject({
        allowed: false,
        reason_code: 'no_active_link_binding_or_grant',
        principal_id: null,
        membership_id: null,
        adapter_binding_id: null,
        permission_grant_id: null,
      });
      expect(find).toHaveBeenCalledTimes(2);
      expect(dependencies.slack.verifyReaction).toHaveBeenCalledOnce();
      expect(dependencies.slack.verifyHuman).toHaveBeenCalledOnce();
      expect(application.overview().recent_audit[0]).toMatchObject({
        action: 'permission.approve',
        outcome: 'denied',
        reason_code: 'no_active_link_binding_or_grant',
      });
    } finally {
      repository.close();
    }
  });

  it('denies an unlinked Slack identity without consulting Slack', async () => {
    const { repository, dependencies, application } = applicationFixture();
    try {
      await expect(application.checkPermission(request())).resolves.toMatchObject({
        allowed: false,
        reason_code: 'no_active_link_binding_or_grant',
        principal_id: null,
        membership_id: null,
      });
      expect(dependencies.slack.verifyReaction).not.toHaveBeenCalled();
    } finally {
      repository.close();
    }
  });

  it('denies when the linked target membership became inactive', async () => {
    const { repository, application } = applicationFixture(
      testDependencies({ targetActive: false }),
    );
    try {
      await bootstrap(application);

      await expect(application.checkPermission(request())).resolves.toMatchObject({
        allowed: false,
        reason_code: 'target_membership_inactive',
        principal_id: TARGET_PRINCIPAL_ID,
        membership_id: TARGET_MEMBERSHIP_ID,
      });
    } finally {
      repository.close();
    }
  });

  it('returns a retryable failure when Slack verification is unavailable', async () => {
    const { repository, application } = applicationFixture(
      testDependencies({
        reaction: new SlackIntegrationProviderError(
          'Slack is unavailable',
          'unavailable',
        ),
      }),
    );
    try {
      await bootstrap(application);

      await expect(application.checkPermission(request())).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(application.overview().recent_audit[0]).toMatchObject({
        reason_code: 'provider_unavailable',
        outcome: 'denied',
      });
    } finally {
      repository.close();
    }
  });
});
