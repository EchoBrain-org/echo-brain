import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  createOrganizationAuthorityHttpServer,
  InMemoryPostRequestRateLimiter,
  type PostRequestRateLimiter,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import {
  PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH,
  PERSON_SESSION_OIDC_BEGIN_PATH,
  PERSON_SESSION_OIDC_CALLBACK_PATH,
  PERSON_SESSION_REFRESH_PATH,
  PERSON_SESSION_REVOCATIONS_PATH,
  type PersonIdentitySessionHttpApplication,
} from '../src/presentation/person-identity-session-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const IDENTITY_BINDING_ID = 'oib_00000000-0000-4000-8000-000000000001';
const SESSION_FAMILY_ID = 'psf_00000000-0000-4000-8000-000000000001';
const LOGIN_GRANT = 'G'.repeat(43);
const STATE = 'S'.repeat(43);
const ACCESS_TOKEN = 'A'.repeat(43);
const REFRESH_TOKEN = 'R'.repeat(43);
const EXPECTED_ISSUER = 'https://identity.example.test/';

const LOGIN_GRANT_RESULT = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'owner' as const,
  login_grant: LOGIN_GRANT,
  expected_issuer: 'https://identity.example.test/',
  issued_at: '2026-08-18T00:00:00.000Z',
  expires_at: '2026-08-18T00:15:00.000Z',
};

const SESSION_RESULT = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'owner' as const,
  identity_binding_id: IDENTITY_BINDING_ID,
  session_family_id: SESSION_FAMILY_ID,
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  access_expires_at: '2026-08-18T12:00:00.000Z',
  refresh_expires_at: '2026-08-25T00:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
};

const UNAVAILABLE_BODY =
  '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';
const UNAUTHORIZED_BODY =
  '{"error":{"code":"unauthorized","message":"authorization failed"}}';

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('person-session-http-test')
      .digest('base64url')}`,
  };
}

function createServer(options: {
  personSessions?: PersonIdentitySessionHttpApplication;
  adminToken?: string;
  rateLimiter?: PostRequestRateLimiter;
}): Server {
  return createOrganizationAuthorityHttpServer({
    application: {} as OrganizationAuthorityHttpApplication,
    ...(options.personSessions === undefined
      ? {}
      : { personSessions: options.personSessions }),
    adminAuthenticator: {
      authenticate: (header) =>
        header ===
        `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${options.adminToken ?? ADMIN_TOKEN}`,
    },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
    ...(options.rateLimiter === undefined
      ? {}
      : { rateLimiter: options.rateLimiter }),
  });
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

function facade(overrides: Partial<PersonIdentitySessionHttpApplication> = {}): PersonIdentitySessionHttpApplication {
  return {
    expected_issuer: EXPECTED_ISSUER,
    issueBootstrapLoginGrant: vi.fn(() => LOGIN_GRANT_RESULT),
    beginOidcLogin: vi.fn(() => ({
      authorization_url: `https://identity.example.test/authorize?state=${STATE}`,
      expires_at: '2026-08-18T00:10:00.000Z',
    })),
    completeOidcLogin: vi.fn(async () => SESSION_RESULT),
    refresh: vi.fn(() => SESSION_RESULT),
    revoke: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('Person identity session HTTP routes', () => {
  it('dispatches the five lean routes with no-store credential responses', async () => {
    const personSessions = facade();
    const server = createServer({ personSessions });
    const origin = await listen(server);
    const grantPath = `${PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH}/${MEMBERSHIP_ID}/person-login-grants`;
    try {
      const grant = await fetch(`${origin}${grantPath}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(),
          authorization: `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(grant.status).toBe(201);
      expect(grant.headers.get('cache-control')).toBe('no-store');
      expect(await grant.json()).toEqual(LOGIN_GRANT_RESULT);

      for (const body of [
        { kind: 'identity_bootstrap', login_grant: LOGIN_GRANT },
        { kind: 'existing_identity_login' },
      ]) {
        const begun = await fetch(`${origin}${PERSON_SESSION_OIDC_BEGIN_PATH}`, {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(begun.status).toBe(201);
        expect(begun.headers.get('cache-control')).toBe('no-store');
        expect(await begun.json()).toEqual({
          authorization_url: `https://identity.example.test/authorize?state=${STATE}`,
          expires_at: '2026-08-18T00:10:00.000Z',
        });
      }

      const callback = await fetch(
        `${origin}${PERSON_SESSION_OIDC_CALLBACK_PATH}?code=authorization-code&iss=${encodeURIComponent(EXPECTED_ISSUER)}&scope=${encodeURIComponent('openid email')}&authuser=0&hd=echobrain.org&prompt=consent&session_state=provider-session&state=${STATE}`,
        { headers: proxyHeaders() },
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get('cache-control')).toBe('no-store');
      expect(await callback.json()).toEqual(SESSION_RESULT);

      const refreshed = await fetch(`${origin}${PERSON_SESSION_REFRESH_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get('cache-control')).toBe('no-store');
      expect(await refreshed.json()).toEqual(SESSION_RESULT);

      const revoked = await fetch(`${origin}${PERSON_SESSION_REVOCATIONS_PATH}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(),
          authorization: `Bearer ${ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(revoked.status).toBe(204);
      expect(revoked.headers.get('cache-control')).toBe('no-store');
      expect(await revoked.text()).toBe('');
    } finally {
      await close(server);
    }

    expect(personSessions.issueBootstrapLoginGrant).toHaveBeenCalledWith({
      target_membership_id: MEMBERSHIP_ID,
    });
    expect(personSessions.beginOidcLogin).toHaveBeenNthCalledWith(1, {
      kind: 'identity_bootstrap',
      login_grant: LOGIN_GRANT,
    });
    expect(personSessions.beginOidcLogin).toHaveBeenNthCalledWith(2, {
      kind: 'existing_identity_login',
    });
    expect(personSessions.completeOidcLogin).toHaveBeenCalledWith({
      state: STATE,
      authorization_code: 'authorization-code',
    });
    expect(personSessions.refresh).toHaveBeenCalledWith({
      refresh_token: REFRESH_TOKEN,
    });
    expect(personSessions.revoke).toHaveBeenCalledWith({
      credential_kind: 'access',
      credential: ACCESS_TOKEN,
      reason: 'person_logout',
    });
  });

  it('returns one fixed 503 for every recognized route when sessions are unconfigured', async () => {
    const server = createServer({});
    const origin = await listen(server);
    const requests = [
      {
        path: `${PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH}/${MEMBERSHIP_ID}/person-login-grants`,
        method: 'POST',
        authorization: `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
        body: '{}',
      },
      {
        path: PERSON_SESSION_OIDC_BEGIN_PATH,
        method: 'POST',
        body: '{}',
      },
      {
        path: `${PERSON_SESSION_OIDC_CALLBACK_PATH}?code=code&state=${STATE}`,
        method: 'GET',
      },
      {
        path: PERSON_SESSION_REFRESH_PATH,
        method: 'POST',
        body: '{}',
      },
      {
        path: PERSON_SESSION_REVOCATIONS_PATH,
        method: 'POST',
        body: '{}',
      },
    ];
    try {
      for (const request of requests) {
        const response = await fetch(`${origin}${request.path}`, {
          method: request.method,
          headers: {
            ...proxyHeaders(),
            ...(request.authorization === undefined
              ? {}
              : { authorization: request.authorization }),
            ...(request.body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(UNAVAILABLE_BODY);
      }
    } finally {
      await close(server);
    }
  });

  it('protects the V2 admin grant with the existing Bearer challenge', async () => {
    const personSessions = facade();
    const server = createServer({ personSessions });
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH}/${MEMBERSHIP_ID}/person-login-grants`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: '{}',
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(UNAUTHORIZED_BODY);
      expect(personSessions.issueBootstrapLoginGrant).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('keeps DTOs closed and terminalizes a provider error before opaque denial', async () => {
    const completeOidcLogin = vi.fn(async () => SESSION_RESULT);
    const personSessions = facade({ completeOidcLogin });
    const server = createServer({ personSessions });
    const origin = await listen(server);
    try {
      const closedBodies = [
        {
          path: `${PERSON_SESSION_ADMIN_MEMBERSHIPS_PATH}/${MEMBERSHIP_ID}/person-login-grants`,
          authorization: `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
          body: { extra: true },
        },
        {
          path: PERSON_SESSION_OIDC_BEGIN_PATH,
          body: { kind: 'existing_identity_login', extra: true },
        },
        {
          path: PERSON_SESSION_REFRESH_PATH,
          body: { refresh_token: REFRESH_TOKEN, extra: true },
        },
        {
          path: PERSON_SESSION_REVOCATIONS_PATH,
          authorization: `Bearer ${ACCESS_TOKEN}`,
          body: { extra: true },
        },
      ];
      for (const request of closedBodies) {
        const response = await fetch(`${origin}${request.path}`, {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            ...(request.authorization === undefined
              ? {}
              : { authorization: request.authorization }),
            'content-type': 'application/json',
          },
          body: JSON.stringify(request.body),
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }

      const duplicate = await fetch(
        `${origin}${PERSON_SESSION_OIDC_CALLBACK_PATH}?state=${STATE}&state=${STATE}&code=code`,
        { headers: proxyHeaders() },
      );
      expect(duplicate.status).toBe(401);
      expect(await duplicate.text()).toBe(UNAUTHORIZED_BODY);
      expect(completeOidcLogin).not.toHaveBeenCalled();

      const providerError = await fetch(
        `${origin}${PERSON_SESSION_OIDC_CALLBACK_PATH}?error=access_denied&error_description=${encodeURIComponent('the person cancelled')}&error_uri=${encodeURIComponent('https://identity.example.test/errors/access-denied')}&iss=${encodeURIComponent(EXPECTED_ISSUER)}&session_state=provider-session&state=${STATE}`,
        { headers: proxyHeaders() },
      );
      expect(providerError.status).toBe(401);
      expect(providerError.headers.get('cache-control')).toBe('no-store');
      expect(await providerError.text()).toBe(UNAUTHORIZED_BODY);
      expect(completeOidcLogin).toHaveBeenCalledWith({
        state: STATE,
        authorization_code: '',
      });

      for (const invalidQuery of [
        `code=code&iss=${encodeURIComponent('https://other-issuer.example/')}&state=${STATE}`,
        `code=code&session_state=one&session_state=two&state=${STATE}`,
        `code=code&session_state=${'x'.repeat(4097)}&state=${STATE}`,
        `code=code&unknown=value&state=${STATE}`,
        `code=code&error_description=not-for-success&state=${STATE}`,
      ]) {
        const rejected = await fetch(
          `${origin}${PERSON_SESSION_OIDC_CALLBACK_PATH}?${invalidQuery}`,
          { headers: proxyHeaders() },
        );
        expect(rejected.status).toBe(401);
      }
      expect(completeOidcLogin).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it('shares the Person-session rate bucket between begin and callback', async () => {
    const personSessions = facade();
    const rateLimiter = new InMemoryPostRequestRateLimiter({
      maximum_requests_per_window: 1,
      window_ms: 60_000,
      maximum_keys: 10,
    });
    const server = createServer({ personSessions, rateLimiter });
    const origin = await listen(server);
    try {
      const begun = await fetch(`${origin}${PERSON_SESSION_OIDC_BEGIN_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'existing_identity_login' }),
      });
      expect(begun.status).toBe(201);

      const callback = await fetch(
        `${origin}${PERSON_SESSION_OIDC_CALLBACK_PATH}?code=authorization-code&state=${STATE}`,
        { headers: proxyHeaders() },
      );
      expect(callback.status).toBe(429);
      expect(callback.headers.get('retry-after')).toBe('60');
      expect(personSessions.completeOidcLogin).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('never reflects credential-specific application failures', async () => {
    const secretFailure = (): never => {
      throw new AuthorityOperationError(
        'unauthorized',
        `refresh token ${REFRESH_TOKEN} was not found`,
      );
    };
    const personSessions = facade({ refresh: vi.fn(secretFailure) });
    const server = createServer({ personSessions });
    const origin = await listen(server);
    try {
      const missingAccess = await fetch(
        `${origin}${PERSON_SESSION_REVOCATIONS_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: '{}',
        },
      );
      expect(missingAccess.status).toBe(401);
      expect(missingAccess.headers.get('www-authenticate')).toBe('Bearer');
      expect(await missingAccess.text()).toBe(UNAUTHORIZED_BODY);
      expect(personSessions.revoke).not.toHaveBeenCalled();

      const response = await fetch(`${origin}${PERSON_SESSION_REFRESH_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body).toBe(UNAUTHORIZED_BODY);
      expect(body).not.toContain(REFRESH_TOKEN);
    } finally {
      await close(server);
    }
  });
});
