import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  organizationPermissionProviderEventSha256,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import {
  beginOrganizationAuthorityHttpServerShutdown,
  createOrganizationAuthorityHttpServer,
  drainOrganizationAuthorityHttpServer,
  InMemoryPostRequestRateLimiter,
  ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH,
  ORGANIZATION_API_ADMIN_SLACK_APPROVAL_BOOTSTRAP_PATH,
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
    provisionMembership: unexpected,
    issueEnrollmentGrant: unexpected,
    completeEnrollment: unexpected,
    issueAccessLease: unexpected,
    checkPermissionSubject: unexpected,
    revokeMembership: unexpected,
    revokeInstallation: unexpected,
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
    bootstrapSlackApproval: vi.fn(),
    checkPermission: vi.fn(),
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

  it('requires the administrator bearer before forwarding Slack bootstrap', async () => {
    const bootstrapSlackApproval = vi.fn(async () => ({}) as never);
    const integrations = integrationsApplication({
      bootstrapSlackApproval,
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
      marker: 'exact-bootstrap-body',
      slack_bot_token: 'xoxb-test-token-12345678',
    };
    try {
      const unauthorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_APPROVAL_BOOTSTRAP_PATH}`,
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
      expect(bootstrapSlackApproval).not.toHaveBeenCalled();
      await unauthorized.arrayBuffer();

      const authorized = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_SLACK_APPROVAL_BOOTSTRAP_PATH}`,
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
      expect(bootstrapSlackApproval).toHaveBeenCalledOnce();
      expect(bootstrapSlackApproval).toHaveBeenCalledWith(
        body,
        expect.any(AbortSignal),
      );
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
