import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
  organizationPermissionProviderEventSha256,
  organizationMemberReadablePermissionProviderEventSha256,
  organizationReviewerPermissionProviderEventSha256,
  organizationSlackLinkChallengeCodeSha256,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
  type OrganizationMemberReadablePermissionCheckDecisionV3,
  type OrganizationMemberReadablePermissionCheckRequestV3,
  type OrganizationReviewerPermissionCheckDecisionV2,
  type OrganizationReviewerPermissionCheckRequestV2,
  type OrganizationSlackLinkBeginRequestV1,
  type OrganizationSlackLinkBeginResponseV1,
  type OrganizationSlackLinkCompleteRequestV1,
  type OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import { HttpOrganizationAuthorityClient } from '../../../src/product/organization/client/http-organization-authority-client.js';
import {
  beginOrganizationAuthorityHttpServerShutdown,
  createOrganizationAuthorityHttpServer,
  drainOrganizationAuthorityHttpServer,
  InMemoryPostRequestRateLimiter,
  ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH,
  ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/http-server.js';
import { AuthorityOperationError } from '../src/domain/errors.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationIntegrationsHttpApplication } from '../src/presentation/organization-integrations-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const AUTHORITY_ID = 'oau_11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = 'org_22222222-2222-4222-8222-222222222222';
const INSTALLATION_ID = 'ins_77777777-7777-4777-8777-777777777777';
const ENROLLMENT_ID = 'enr_88888888-8888-4888-8888-888888888888';
const INSTALLATION_KEY_ID = digest('installation-key');
const AUTHORITY_KEY_ID = digest('authority-key');
const SLACK_LINK_CODE = `${'A'.repeat(42)}E`;
const NOW = '2026-07-29T20:00:00.000Z';

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function clientId(): string {
  return `cid_${createHash('sha256').update('test-client').digest('base64url')}`;
}

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: clientId(),
  };
}

const proxyFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set(
    TRUSTED_PROXY_AUTHORIZATION_HEADER,
    `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
  );
  headers.set(TRUSTED_PROXY_CLIENT_ID_HEADER, clientId());
  return fetch(input, { ...init, headers });
};

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

function application(
  overrides: Partial<OrganizationAuthorityHttpApplication> = {},
): OrganizationAuthorityHttpApplication {
  const unexpected = (): never => {
    throw new Error('unexpected authority application call');
  };
  return {
    descriptor: unexpected,
    adminOverview: unexpected,
    listMemberships: unexpected,
    listInstallations: unexpected,
    listEnrollmentGrants: unexpected,
    listAudit: unexpected,
    internalLiveRolloutStatus: unexpected,
    approveInternalLiveRelease: unexpected,
    fetchInternalLiveDirective: unexpected,
    recordInternalLiveUpdateReceipt: unexpected,
    provisionMembership: unexpected,
    issueEnrollmentGrant: unexpected,
    completeEnrollment: unexpected,
    issueAccessLease: unexpected,
    checkPermissionSubject: unexpected,
    checkReviewerPermissionSubject: unexpected,
    revokeMembership: unexpected,
    revokeInstallation: unexpected,
    recoverInstallationAccess: unexpected,
    ...overrides,
  };
}

function integrationsApplication(
  overrides: Partial<OrganizationIntegrationsHttpApplication>,
): OrganizationIntegrationsHttpApplication {
  return {
    overview: vi.fn(() => ({
      identity_links: [],
      tool_connections: [],
      adapter_bindings: [],
      permission_grants: [],
      recent_audit: [],
    })),
    onboardSlackOrganizationTool: vi.fn(),
    activateSlackApproval: vi.fn(),
    beginSlackIdentityLink: vi.fn(),
    completeSlackIdentityLink: vi.fn(),
    checkPermission: vi.fn(),
    checkReviewerPermission: vi.fn(),
    ...overrides,
  };
}

function integrationServer(
  integrations: OrganizationIntegrationsHttpApplication,
  applicationOverrides: Partial<OrganizationAuthorityHttpApplication> = {},
  serverOverrides: Partial<OrganizationAuthorityHttpServerOptions> = {},
): Server {
  return createOrganizationAuthorityHttpServer({
    adminAuthenticator: { authenticate: () => false },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
    ...serverOverrides,
    application: application(applicationOverrides),
    integrations,
  });
}

function permissionRequest(): OrganizationPermissionCheckRequestV1 {
  const event = {
    authority_id: AUTHORITY_ID,
    authority_key_id: digest('authority-key'),
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
  return {
    schema_version: 1,
    kind: 'echo-organization-permission-check-request',
    request_id: 'pcr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ...event,
    provider_event_sha256:
      organizationPermissionProviderEventSha256(event),
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('request-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  };
}

function permissionDecision(
  request: OrganizationPermissionCheckRequestV1,
): OrganizationPermissionCheckDecisionV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: digest('request'),
    provider_event_sha256: request.provider_event_sha256,
    allowed: false,
    reason_code: 'no_active_link_binding_or_grant',
    principal_id: null,
    membership_id: null,
    adapter_binding_id: null,
    permission_grant_id: null,
    evaluated_at: NOW,
  };
}

function reviewerPermissionRequest(): OrganizationReviewerPermissionCheckRequestV2 {
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
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    policy_id: 'restricted-reviewer-v1',
    reviewer_release_draft_sha256: digest('reviewer-release'),
    approval_presentation_sha256: digest('reviewer-presentation'),
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  } as const;
  return {
    schema_version: 2,
    kind: 'echo-organization-permission-check-request',
    request_id: 'pcr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ...event,
    provider_event_sha256:
      organizationReviewerPermissionProviderEventSha256(event),
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('reviewer-request-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  };
}

function organizationMemberPermissionRequest(): OrganizationMemberReadablePermissionCheckRequestV3 {
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
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
    release_draft_sha256: digest('organization-member-release'),
    approval_presentation_sha256: digest('organization-member-presentation'),
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  } as const;
  return {
    schema_version: 3,
    kind: 'echo-organization-permission-check-request',
    request_id: 'pcr_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ...event,
    provider_event_sha256:
      organizationMemberReadablePermissionProviderEventSha256(event),
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('organization-member-request-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: INSTALLATION_KEY_ID,
      signature_base64: 'QUJDREVGR0g=',
    },
  } as OrganizationMemberReadablePermissionCheckRequestV3;
}

function organizationMemberPermissionDecision(
  request: OrganizationMemberReadablePermissionCheckRequestV3,
  allowed = false,
): OrganizationMemberReadablePermissionCheckDecisionV3 {
  return {
    schema_version: 3,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: digest('organization-member-request'),
    provider_event_sha256: request.provider_event_sha256,
    allowed,
    reason_code: allowed
      ? 'active_organization_member_readable_notice_v1'
      : 'provider_identity_mismatch',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: request.policy_contract_sha256,
    principal_id: allowed
      ? 'prn_33333333-3333-4333-8333-333333333333'
      : null,
    membership_id: allowed
      ? 'mem_44444444-4444-4444-8444-444444444444'
      : null,
    adapter_binding_id: allowed
      ? 'bnd_55555555-5555-4555-8555-555555555555'
      : null,
    permission_grant_id: allowed
      ? 'pgr_66666666-6666-4666-8666-666666666666'
      : null,
    evaluated_at: NOW,
    authorization_audit_event_id: allowed
      ? 'aud_77777777-7777-4777-8777-777777777777'
      : null,
    authorization_audit_entry_sha256: allowed
      ? digest('organization-member-audit-entry')
      : null,
    release_draft_sha256: allowed ? request.release_draft_sha256 : null,
    approval_presentation_sha256: allowed
      ? request.approval_presentation_sha256
      : null,
    semantic_intent_sha256: allowed
      ? digest('organization-member-semantic-intent')
      : null,
    message_presentation_sha256: allowed
      ? digest('organization-member-message-presentation')
      : null,
  };
}

function reviewerPermissionDecision(
  request: OrganizationReviewerPermissionCheckRequestV2,
  allowed = false,
): OrganizationReviewerPermissionCheckDecisionV2 {
  return {
    schema_version: 2,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: digest('reviewer-request'),
    provider_event_sha256: request.provider_event_sha256,
    allowed,
    reason_code: allowed
      ? 'active_reviewer_restricted_notice_v1'
      : 'provider_identity_mismatch',
    principal_id: allowed
      ? 'prn_33333333-3333-4333-8333-333333333333'
      : null,
    membership_id: allowed
      ? 'mem_44444444-4444-4444-8444-444444444444'
      : null,
    adapter_binding_id: allowed
      ? 'bnd_55555555-5555-4555-8555-555555555555'
      : null,
    permission_grant_id: allowed
      ? 'pgr_66666666-6666-4666-8666-866666666666'
      : null,
    evaluated_at: NOW,
    authorization_audit_event_id: allowed
      ? 'aud_77777777-7777-4777-8777-777777777777'
      : null,
    authorization_audit_entry_sha256: allowed ? digest('reviewer-audit') : null,
    reviewer_release_draft_sha256: allowed
      ? request.reviewer_release_draft_sha256
      : null,
    approval_presentation_sha256: allowed
      ? request.approval_presentation_sha256
      : null,
    semantic_intent_sha256: allowed ? digest('reviewer-semantic') : null,
    message_presentation_sha256: allowed ? digest('reviewer-message') : null,
  };
}

function slackLinkBeginRequest(): OrganizationSlackLinkBeginRequestV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-slack-link-begin-request',
    request_id: 'slb_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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

function slackLinkBeginResponse(): OrganizationSlackLinkBeginResponseV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-slack-link-begin-response',
    challenge_attempt_id: 'cat_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    provider: 'slack',
    provider_tenant_id: 'T123ABC',
    channel_id: 'C123ABC',
    challenge_message_ts: '1753822800.000001',
    expires_at: '2026-07-29T20:05:00.000Z',
  };
}

function slackLinkCompleteRequest(): OrganizationSlackLinkCompleteRequestV1 {
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
    challenge_attempt_id: slackLinkBeginResponse().challenge_attempt_id,
    challenge_message_ts: slackLinkBeginResponse().challenge_message_ts,
    challenge_code: SLACK_LINK_CODE,
    expected_provider_subject_id: 'U123ABC',
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

function slackLinkResult(): OrganizationSlackLinkResultV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-slack-link-result',
    identity_link_id: 'clm_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    connection_id: 'con_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    adapter_binding_id: 'bnd_ffffffff-ffff-4fff-8fff-ffffffffffff',
    organization_id: ORGANIZATION_ID,
    principal_id: 'prn_33333333-3333-4333-8333-333333333333',
    membership_id: 'mem_44444444-4444-4444-8444-444444444444',
    installation_id: INSTALLATION_ID,
    provider: 'slack',
    provider_tenant_id: 'T123ABC',
    provider_subject_id: 'U123ZHEN',
    channel_id: 'C123ABC',
    linked_at: NOW,
    identity_link_created: true,
    adapter_binding_created: true,
    permission_grants_created: 0,
  };
}

describe('organization integrations HTTP routes', () => {
  it('requires the administrator bearer before forwarding Slack organization onboarding', async () => {
    const onboardSlackOrganizationTool = vi.fn(async () => ({
      connection_attempt_id: 'cat_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connection_id: 'con_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      organization_id: ORGANIZATION_ID,
      provider: 'slack' as const,
      status: 'active' as const,
      slack_team_id: 'T123ABC',
      slack_bot_user_id: 'U123BOT',
      channel_id: 'C123ABC',
      granted_scopes: [
        'channels:read',
        'chat:write',
        'reactions:read',
        'users:read',
      ],
      activated_at: NOW,
    }));
    const integrations = integrationsApplication({
      onboardSlackOrganizationTool,
    });
    const server = integrationServer(integrations, {}, {
      adminAuthenticator: {
        authenticate: (header) =>
          header ===
          `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
      },
    });
    const origin = await listen(server);
    const body = {
      command_id: 'adm_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      administrator_membership_id:
        'mem_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      channel_id: 'C123ABC',
      slack_bot_token: 'xoxb-test-token-12345678',
    };
    try {
      const unauthorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
      expect(onboardSlackOrganizationTool).not.toHaveBeenCalled();
      await unauthorized.arrayBuffer();

      const authorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            authorization:
              `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      const result = await authorized.json();
      expect(authorized.status).toBe(201);
      expect(onboardSlackOrganizationTool).toHaveBeenCalledWith(
        body,
        expect.any(AbortSignal),
      );
      expect(JSON.stringify(result)).not.toContain(body.slack_bot_token);
      expect(result).toMatchObject({
        provider: 'slack',
        status: 'active',
        channel_id: body.channel_id,
      });
    } finally {
      await close(server);
    }
  });

  it('requires the administrator bearer before forwarding Slack approval activation', async () => {
    const activateSlackApproval = vi.fn(() => ({}) as never);
    const integrations = integrationsApplication({
      activateSlackApproval,
    });
    const server = integrationServer(integrations, {}, {
      adminAuthenticator: {
        authenticate: (header) =>
          header ===
          `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
      },
    });
    const origin = await listen(server);
    const body = {
      command_id: 'adm_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      administrator_membership_id:
        'mem_44444444-4444-4444-8444-444444444444',
      target_membership_id: 'mem_66666666-6666-4666-8666-666666666666',
      installation_id: INSTALLATION_ID,
      identity_link_id: 'clm_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      adapter_binding_id: 'bnd_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    try {
      const unauthorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
      expect(activateSlackApproval).not.toHaveBeenCalled();
      await unauthorized.arrayBuffer();

      const authorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            authorization:
              `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      expect(authorized.status).toBe(201);
      expect(activateSlackApproval).toHaveBeenCalledOnce();
      expect(activateSlackApproval).toHaveBeenCalledWith(body);
      await authorized.arrayBuffer();
    } finally {
      await close(server);
    }
  });

  it('validates and forwards the signed permission request without admin auth', async () => {
    const command = permissionRequest();
    const checkPermission = vi.fn(async () => permissionDecision(command));
    const integrations = integrationsApplication({
      checkPermission,
    });
    const server = integrationServer(
      integrations,
      {
        checkPermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);
      expect(checkPermission).toHaveBeenCalledOnce();
      expect(checkPermission).toHaveBeenCalledWith(
        command,
        expect.any(AbortSignal),
      );
      expect(responseBody).toEqual(permissionDecision(command));
    } finally {
      await close(server);
    }
  });

  it('uses one fixed 503 body for every reviewer operational failure', async () => {
    const command = reviewerPermissionRequest();
    const fixedBody =
      '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';

    for (const failure of ['subject-storage', 'integration-storage'] as const) {
      const checkReviewerPermission = vi.fn(async () => {
        throw new Error('private persistence detail at 2026-08-11T20:00:00.000Z');
      });
      const server = integrationServer(
        integrationsApplication({ checkReviewerPermission }),
        {
          checkReviewerPermissionSubject:
            failure === 'subject-storage'
              ? () => {
                  throw new Error('database is locked');
                }
              : (request) => ({ installation_id: request.installation_id }),
        },
      );
      const origin = await listen(server);
      try {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
          {
            method: 'POST',
            headers: {
              ...proxyHeaders(),
              'content-type': 'application/json',
            },
            body: JSON.stringify(command),
          },
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(fixedBody);
        expect(checkReviewerPermission).toHaveBeenCalledTimes(
          failure === 'subject-storage' ? 0 : 1,
        );
      } finally {
        await close(server);
      }
    }
  });

  it('dispatches a signed schema-v3 request and returns its closed decision unchanged', async () => {
    const command = organizationMemberPermissionRequest();
    const decision = organizationMemberPermissionDecision(command, true);
    const checkOrganizationMemberReadablePermission = vi.fn(async () =>
      decision,
    );
    const server = integrationServer(
      integrationsApplication({ checkOrganizationMemberReadablePermission }),
      {
        checkOrganizationMemberReadablePermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(canonicalJson(decision));
      expect(checkOrganizationMemberReadablePermission).toHaveBeenCalledWith(
        command,
        expect.any(AbortSignal),
      );
    } finally {
      await close(server);
    }
  });

  it('preserves both schema-v3 application method receivers', async () => {
    const command = organizationMemberPermissionRequest();
    const decision = organizationMemberPermissionDecision(command, true);
    let checkSubject!: NonNullable<
      OrganizationAuthorityHttpApplication['checkOrganizationMemberReadablePermissionSubject']
    >;
    let checkPermission!: NonNullable<
      OrganizationIntegrationsHttpApplication['checkOrganizationMemberReadablePermission']
    >;
    checkSubject = vi.fn(function (
      this: OrganizationAuthorityHttpApplication,
      request,
    ) {
      if (
        this.checkOrganizationMemberReadablePermissionSubject !== checkSubject
      ) {
        throw new Error('schema-v3 subject receiver was lost');
      }
      return { installation_id: request.installation_id };
    });
    checkPermission = vi.fn(async function (
      this: OrganizationIntegrationsHttpApplication,
    ) {
      if (this.checkOrganizationMemberReadablePermission !== checkPermission) {
        throw new Error('schema-v3 integration receiver was lost');
      }
      return decision;
    });
    const server = integrationServer(
      integrationsApplication({
        checkOrganizationMemberReadablePermission: checkPermission,
      }),
      {
        checkOrganizationMemberReadablePermissionSubject: checkSubject,
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(canonicalJson(decision));
      expect(checkSubject).toHaveBeenCalledOnce();
      expect(checkPermission).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it('round-trips exact canonical schema-v2 and schema-v3 allow and denial decisions through the HTTP server and client', async () => {
    const reviewerCommand = reviewerPermissionRequest();
    const reviewerDenial = reviewerPermissionDecision(reviewerCommand);
    const reviewerAllow = reviewerPermissionDecision(reviewerCommand, true);
    const organizationMemberCommand = organizationMemberPermissionRequest();
    const organizationMemberDenial = organizationMemberPermissionDecision(
      organizationMemberCommand,
    );
    const organizationMemberAllow = organizationMemberPermissionDecision(
      organizationMemberCommand,
      true,
    );
    const reviewerDecisions = [reviewerDenial, reviewerAllow];
    const organizationMemberDecisions = [
      organizationMemberDenial,
      organizationMemberAllow,
    ];
    const server = integrationServer(
      integrationsApplication({
        checkReviewerPermission: vi.fn(
          async () => reviewerDecisions.shift()!,
        ),
        checkOrganizationMemberReadablePermission: vi.fn(
          async () => organizationMemberDecisions.shift()!,
        ),
      }),
      {
        checkReviewerPermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
        checkOrganizationMemberReadablePermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    const observedWire: Array<{ request: string; response: string }> = [];
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: origin,
      fetch: async (input, init) => {
        const response = await proxyFetch(input, init);
        observedWire.push({
          request: String(init?.body),
          response: await response.clone().text(),
        });
        return response;
      },
      allowInsecureLoopback: true,
    });
    try {
      await expect(
        client.checkReviewerPermission(reviewerCommand),
      ).resolves.toEqual(reviewerDenial);
      await expect(
        client.checkOrganizationMemberPermission(organizationMemberCommand),
      ).resolves.toEqual(organizationMemberDenial);
      await expect(
        client.checkReviewerPermission(reviewerCommand),
      ).resolves.toEqual(reviewerAllow);
      await expect(
        client.checkOrganizationMemberPermission(organizationMemberCommand),
      ).resolves.toEqual(organizationMemberAllow);
      expect(observedWire).toEqual([
        {
          request: canonicalJson(reviewerCommand),
          response: canonicalJson(reviewerDenial),
        },
        {
          request: canonicalJson(organizationMemberCommand),
          response: canonicalJson(organizationMemberDenial),
        },
        {
          request: canonicalJson(reviewerCommand),
          response: canonicalJson(reviewerAllow),
        },
        {
          request: canonicalJson(organizationMemberCommand),
          response: canonicalJson(organizationMemberAllow),
        },
      ]);
    } finally {
      await close(server);
    }
  });

  it('keeps a schema-v3 identity/card mismatch as its closed 200 denial', async () => {
    const command = organizationMemberPermissionRequest();
    const decision = organizationMemberPermissionDecision(command);
    const server = integrationServer(
      integrationsApplication({
        checkOrganizationMemberReadablePermission: vi.fn(async () => decision),
      }),
      {
        checkOrganizationMemberReadablePermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(canonicalJson(decision));
    } finally {
      await close(server);
    }
  });

  it('uses the exact fixed 503 bytes for schema-v3 provider or storage failures', async () => {
    const command = organizationMemberPermissionRequest();
    const fixedBody =
      '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';
    for (const failure of ['subject-storage', 'provider-storage'] as const) {
      const checkOrganizationMemberReadablePermission = vi.fn(async () => {
        throw new Error('private v3 provider/storage detail');
      });
      const server = integrationServer(
        integrationsApplication({ checkOrganizationMemberReadablePermission }),
        {
          checkOrganizationMemberReadablePermissionSubject:
            failure === 'subject-storage'
              ? () => {
                  throw new Error('private current state failure');
                }
              : (request) => ({ installation_id: request.installation_id }),
        },
      );
      const origin = await listen(server);
      try {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
          {
            method: 'POST',
            headers: {
              ...proxyHeaders(),
              'content-type': 'application/json',
            },
            body: JSON.stringify(command),
          },
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(fixedBody);
        expect(checkOrganizationMemberReadablePermission).toHaveBeenCalledTimes(
          failure === 'subject-storage' ? 0 : 1,
        );
      } finally {
        await close(server);
      }
    }
  });

  it('rejects malformed schema-v3 input before application dispatch', async () => {
    const command = {
      ...organizationMemberPermissionRequest(),
      policy_contract_sha256: digest('wrong-policy-contract'),
    };
    const checkOrganizationMemberReadablePermission = vi.fn();
    const server = integrationServer(
      integrationsApplication({ checkOrganizationMemberReadablePermission }),
      {
        checkOrganizationMemberReadablePermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '{"error":{"code":"invalid_request","message":"request body is invalid"}}',
      );
      expect(checkOrganizationMemberReadablePermission).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('keeps reviewer authentication failures as the closed 401 boundary', async () => {
    const command = reviewerPermissionRequest();
    const checkReviewerPermission = vi.fn();
    const server = integrationServer(
      integrationsApplication({ checkReviewerPermission }),
      {
        checkReviewerPermissionSubject: () => {
          throw new AuthorityOperationError(
            'unauthorized',
            'private authentication detail',
          );
        },
      },
    );
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'unauthorized', message: 'authorization failed' },
      });
      expect(checkReviewerPermission).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('forwards signed Slack identity-link commands without administrator auth', async () => {
    const beginCommand = slackLinkBeginRequest();
    const completeCommand = slackLinkCompleteRequest();
    const beginResult = slackLinkBeginResponse();
    const completeResult = slackLinkResult();
    const beginSlackIdentityLink = vi.fn(async () => beginResult);
    const completeSlackIdentityLink = vi.fn(async () => completeResult);
    const integrations = integrationsApplication({
      beginSlackIdentityLink,
      completeSlackIdentityLink,
    });
    const server = integrationServer(integrations);
    const origin = await listen(server);
    const post = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    try {
      const beginResponse = await post(
        ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
        beginCommand,
      );
      const beginBody = await beginResponse.json();
      expect(beginResponse.status, JSON.stringify(beginBody)).toBe(201);
      expect(beginBody).toEqual(beginResult);
      expect(beginSlackIdentityLink).toHaveBeenCalledWith(
        beginCommand,
        expect.any(AbortSignal),
      );

      const completeResponse = await post(
        ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
        completeCommand,
      );
      const completeBody = await completeResponse.json();
      expect(completeResponse.status, JSON.stringify(completeBody)).toBe(200);
      expect(completeBody).toEqual(completeResult);
      expect(completeSlackIdentityLink).toHaveBeenCalledWith(
        completeCommand,
        expect.any(AbortSignal),
      );
    } finally {
      await close(server);
    }
  });

  it('rejects unsigned Slack identity-link commands at the HTTP boundary', async () => {
    const beginSlackIdentityLink = vi.fn();
    const completeSlackIdentityLink = vi.fn();
    const integrations = integrationsApplication({
      beginSlackIdentityLink,
      completeSlackIdentityLink,
    });
    const server = integrationServer(integrations);
    const origin = await listen(server);
    const unsignedBegin = {
      ...slackLinkBeginRequest(),
      integrity: undefined,
    };
    const unsignedComplete = {
      ...slackLinkCompleteRequest(),
      integrity: undefined,
    };
    const post = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    try {
      for (const [path, body] of [
        [ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH, unsignedBegin],
        [ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH, unsignedComplete],
      ] as const) {
        const response = await post(path, body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: 'invalid_request',
            message: 'request body is invalid',
          },
        });
      }
      expect(beginSlackIdentityLink).not.toHaveBeenCalled();
      expect(completeSlackIdentityLink).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('does not let unauthenticated permission requests consume an installation permission budget', async () => {
    const command = permissionRequest();
    const forged = {
      ...command,
      integrity: {
        ...command.integrity,
        signature_base64: 'Rk9SR0VERF9TSUdOQVRVUkU=',
      },
    } satisfies OrganizationPermissionCheckRequestV1;
    const checkPermission = vi.fn(async () => permissionDecision(command));
    const integrations = integrationsApplication({
      checkPermission,
    });
    const checkPermissionSubject = vi.fn(
      (request: OrganizationPermissionCheckRequestV1) => {
        if (
          request.integrity.signature_base64 !==
          command.integrity.signature_base64
        ) {
          throw new AuthorityOperationError(
            'unauthorized',
            'permission check request authentication failed',
          );
        }
        return { installation_id: request.installation_id };
      },
    );
    const server = integrationServer(integrations, { checkPermissionSubject }, {
      rateLimiter: new InMemoryPostRequestRateLimiter({
        maximum_requests_per_window: 1,
        window_ms: 60_000,
        maximum_keys: 10,
      }),
      permissionIngressRateLimiter: new InMemoryPostRequestRateLimiter({
        maximum_requests_per_window: 5,
        window_ms: 60_000,
        maximum_keys: 10,
      }),
      permissionRateLimiter: new InMemoryPostRequestRateLimiter({
        maximum_requests_per_window: 1,
        window_ms: 60_000,
        maximum_keys: 10,
      }),
    });
    const origin = await listen(server);
    const post = (body: OrganizationPermissionCheckRequestV1) =>
      fetch(`${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unauthorized = await post(forged);
        expect(unauthorized.status).toBe(401);
        await unauthorized.arrayBuffer();
      }
      expect(checkPermission).not.toHaveBeenCalled();

      const admitted = await post(command);
      expect(admitted.status).toBe(200);
      await admitted.arrayBuffer();
      expect(checkPermission).toHaveBeenCalledOnce();

      const exhausted = await post(command);
      expect(exhausted.status).toBe(429);
      await exhausted.arrayBuffer();
      expect(checkPermission).toHaveBeenCalledOnce();
      expect(checkPermissionSubject).toHaveBeenCalledTimes(5);

      const ingressExhausted = await post(forged);
      expect(ingressExhausted.status).toBe(429);
      await ingressExhausted.arrayBuffer();
      expect(checkPermissionSubject).toHaveBeenCalledTimes(5);
    } finally {
      await close(server);
    }
  });

  it('aborts integration work and waits for its request handler to drain during shutdown', async () => {
    const command = permissionRequest();
    let observedSignal: AbortSignal | undefined;
    let release = (): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const checkPermission = vi.fn(
      (
        _request: OrganizationPermissionCheckRequestV1,
        signal?: AbortSignal,
      ): Promise<OrganizationPermissionCheckDecisionV1> => {
        observedSignal = signal;
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve(permissionDecision(command));
        });
      },
    );
    const integrations = integrationsApplication({
      checkPermission,
    });
    const server = integrationServer(
      integrations,
      {
        checkPermissionSubject: (request) => ({
          installation_id: request.installation_id,
        }),
      },
    );
    const origin = await listen(server);
    try {
      const responsePromise = fetch(
        `${origin}${ORGANIZATION_API_PERMISSION_CHECKS_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
      await started;

      beginOrganizationAuthorityHttpServerShutdown(server);
      const drainPromise = drainOrganizationAuthorityHttpServer(server);
      let drained = false;
      void drainPromise.then(() => {
        drained = true;
      });
      await Promise.resolve();

      expect(observedSignal?.aborted).toBe(true);
      expect(drained).toBe(false);

      release();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      release();
      await close(server);
    }
  });
});
