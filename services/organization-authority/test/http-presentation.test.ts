import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from '@echo-brain/organization-api';
import { AdminBearerAuthenticator } from '../src/adapters/security/admin-bearer-authenticator.js';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  createOrganizationAuthorityHttpServer,
  decodeOrganizationApiJsonBody,
  InMemoryPostRequestRateLimiter,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';

function clientId(label: string): string {
  return `cid_${createHash('sha256').update(label).digest('base64url')}`;
}

function proxyHeaders(identity: string): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: identity,
  };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

function testApplication(
  overrides: Partial<OrganizationAuthorityHttpApplication> = {},
): OrganizationAuthorityHttpApplication {
  const unexpectedCall = (): never => {
    throw new Error('unexpected authority application call');
  };
  return {
    descriptor: unexpectedCall,
    adminOverview: unexpectedCall,
    listMemberships: unexpectedCall,
    listInstallations: unexpectedCall,
    listEnrollmentGrants: unexpectedCall,
    listAudit: unexpectedCall,
    provisionMembership: unexpectedCall,
    issueEnrollmentGrant: unexpectedCall,
    completeEnrollment: unexpectedCall,
    issueAccessLease: unexpectedCall,
    revokeMembership: unexpectedCall,
    revokeInstallation: unexpectedCall,
    ...overrides,
  };
}

describe('authority HTTP presentation', () => {
  it('uses fatal UTF-8 decoding', () => {
    expect(() =>
      decodeOrganizationApiJsonBody(Buffer.from([0xc3, 0x28])),
    ).toThrow('not valid UTF-8');
    expect(
      decodeOrganizationApiJsonBody(Buffer.from('{"value":1}', 'utf8')),
    ).toEqual({ value: 1 });
  });

  it('rate-limits bounded remote buckets with a retry delay', () => {
    const limiter = new InMemoryPostRequestRateLimiter({
      maximum_requests_per_window: 1,
      window_ms: 60_000,
      maximum_keys: 2,
      now: () => 1_000,
    });
    expect(limiter.consume('127.0.0.1:admin')).toEqual({ allowed: true });
    expect(limiter.consume('127.0.0.1:admin')).toEqual({
      allowed: false,
      retry_after_seconds: 60,
    });
    expect(limiter.consume('127.0.0.2:admin')).toEqual({ allowed: true });
    expect(limiter.consume('127.0.0.3:admin')).toEqual({ allowed: true });
  });

  it('authenticates only the shared administrator authorization scheme', () => {
    const authenticator = new AdminBearerAuthenticator(ADMIN_TOKEN);
    expect(
      authenticator.authenticate(
        `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${ADMIN_TOKEN}`,
      ),
    ).toBe(true);
    expect(authenticator.authenticate(`Basic ${ADMIN_TOKEN}`)).toBe(false);
    expect(
      authenticator.authenticate(
        `${ORGANIZATION_API_ADMIN_AUTH_SCHEME.toLowerCase()} ${ADMIN_TOKEN}`,
      ),
    ).toBe(false);
  });

  it('authenticates canonical proxy client identities', () => {
    const resolver = new AuthenticatedProxyClientIdentityResolver(PROXY_TOKEN);
    const identity = clientId('employee-one');
    const request = {
      rawHeaders: [
        TRUSTED_PROXY_AUTHORIZATION_HEADER,
        `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
        TRUSTED_PROXY_CLIENT_ID_HEADER,
        identity,
      ],
    };
    expect(resolver.resolve(request)).toBe(identity);

    request.rawHeaders[1] = `Basic ${PROXY_TOKEN}`;
    expect(() => resolver.resolve(request)).toThrow(
      'trusted proxy identity is unavailable',
    );
    request.rawHeaders[1] =
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} wrong-token-with-at-least-32-visible-bytes`;
    expect(() => resolver.resolve(request)).toThrow(
      'trusted proxy identity is unavailable',
    );
    request.rawHeaders[1] =
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`;
    request.rawHeaders[3] = 'employee-one@example.com';
    expect(() => resolver.resolve(request)).toThrow(
      'trusted proxy identity is unavailable',
    );
  });

  it('isolates loopback proxy rate limits by authenticated client', async () => {
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
      rateLimiter: new InMemoryPostRequestRateLimiter({
        maximum_requests_per_window: 1,
        window_ms: 60_000,
        maximum_keys: 10,
      }),
    });
    const origin = await listen(server);
    try {
      const first = await fetch(`${origin}/not-found`, {
        method: 'POST',
        headers: proxyHeaders(clientId('employee-one')),
      });
      expect(first.status).toBe(404);
      await first.arrayBuffer();

      const limited = await fetch(`${origin}/not-found`, {
        method: 'POST',
        headers: proxyHeaders(clientId('employee-one')),
      });
      expect(limited.status).toBe(429);
      await limited.arrayBuffer();

      const independent = await fetch(`${origin}/not-found`, {
        method: 'POST',
        headers: proxyHeaders(clientId('employee-two')),
      });
      expect(independent.status).toBe(404);
      await independent.arrayBuffer();
    } finally {
      await close(server);
    }
  });

  it('fails closed without the trusted proxy contract', async () => {
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    try {
      const response = await fetch(`${origin}/v1/authority-descriptor`, {
        headers: { connection: 'close' },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(await response.json()).toEqual({
        error: {
          code: 'proxy_identity_unavailable',
          message: 'trusted proxy identity is unavailable',
        },
      });
    } finally {
      await close(server);
    }
  });

  it('emits only the authentication challenge owned by the route', async () => {
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication({
        descriptor: () => {
          throw new AuthorityOperationError('unauthorized', 'test failure');
        },
      }),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    const headers = proxyHeaders(clientId('employee-one'));
    try {
      const admin = await fetch(`${origin}/v1/admin/memberships`, {
        method: 'POST',
        headers,
      });
      expect(admin.status).toBe(401);
      expect(admin.headers.get('www-authenticate')).toBe('Bearer');
      await admin.arrayBuffer();

      const enrollment = await fetch(`${origin}/v1/enrollments`, {
        method: 'POST',
        headers,
      });
      expect(enrollment.status).toBe(401);
      expect(enrollment.headers.get('www-authenticate')).toBe(
        'Echo-Enrollment',
      );
      await enrollment.arrayBuffer();

      const otherUnauthorizedRoute = await fetch(
        `${origin}/v1/authority-descriptor`,
        { headers },
      );
      expect(otherUnauthorizedRoute.status).toBe(401);
      expect(otherUnauthorizedRoute.headers.get('www-authenticate')).toBeNull();
      await otherUnauthorizedRoute.arrayBuffer();
    } finally {
      await close(server);
    }
  });

  it('returns 400 for a genuinely malformed nested protocol document', async () => {
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    try {
      const response = await fetch(`${origin}/v1/enrollments`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(clientId('malformed-enrollment')),
          authorization: `Echo-Enrollment ${Buffer.alloc(32).toString('base64url')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          enrollment_request: { malformed: true },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'request body is invalid',
        },
      });
    } finally {
      await close(server);
    }
  });

  it('returns 500 when a nested protocol validator faults unexpectedly', async () => {
    const fault = new TypeError('nested protocol validator fault');
    const enrollmentRequest = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(enrollmentRequest, 'schema_version', {
      enumerable: true,
      get() {
        throw fault;
      },
    });
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue({
      enrollment_request: enrollmentRequest,
    });
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    let response: Response;
    try {
      response = await fetch(`${origin}/v1/enrollments`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(clientId('faulting-enrollment')),
          authorization: `Echo-Enrollment ${Buffer.alloc(32).toString('base64url')}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
    } finally {
      parse.mockRestore();
      await close(server);
    }
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'authority operation failed',
      },
    });
  });
});
