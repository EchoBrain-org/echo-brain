import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_API_ACCESS_LEASES_PATH,
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  ORGANIZATION_API_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH,
} from '@echo-brain/organization-api';
import type { OrganizationInstallationAccessStateV1 } from '@echo-brain/organization-protocol';
import { AdminBearerAuthenticator } from '../src/adapters/security/admin-bearer-authenticator.js';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  fixedRecentDecisionsErrorBytes,
  OrganizationRecentDecisionsError,
} from '../src/application/recent-decisions.js';
import {
  fixedReviewerRecentDecisionsErrorBytes,
  ReviewerRecentDecisionsError,
} from '../src/application/reviewer-recent-decisions.js';
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
  TRUSTED_PROXY_SOURCE_ADDRESS_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const EMPTY_RECENT_DECISIONS_RESPONSE_BYTES = Buffer.from(
  '{"items":[],"policy_id":"pilot-member-readable-v1","schema_version":1,"witness":"Readable because your active membership is one of the two memberships bound to pilot-member-readable-v1 and the returned records carry the exact two-person sharing notice."}',
  'utf8',
);
const EMPTY_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES = Buffer.from(
  '{"items":[],"policy_id":"restricted-reviewer-v1","schema_version":1,"witness":"Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active."}',
  'utf8',
);

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

function recentDecisionsWireRequest() {
  const installationKey = `sha256:${'b'.repeat(64)}`;
  return {
    schema_version: 1 as const,
    kind: 'echo-organization-recent-decisions-request' as const,
    request_id: 'rdr_00000000-0000-4000-8000-000000000001',
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    authority_key_id: `sha256:${'a'.repeat(64)}`,
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    installation_key_id: installationKey,
    http_method: 'POST' as const,
    http_path: ORGANIZATION_API_RECENT_DECISIONS_PATH,
    requested_at: '2026-08-10T08:00:00.000Z',
    integrity: {
      canonicalization: 'RFC8785' as const,
      payload_sha256: `sha256:${'c'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
      key_id: installationKey,
      signature_base64: 'AAAAAAAA',
    },
  };
}

function reviewerRecentDecisionsWireRequest() {
  const installationKey = `sha256:${'b'.repeat(64)}`;
  return {
    schema_version: 1 as const,
    kind: 'echo-organization-reviewer-recent-decisions-request' as const,
    request_id: 'rrd_00000000-0000-4000-8000-000000000001',
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    authority_key_id: `sha256:${'a'.repeat(64)}`,
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    installation_key_id: installationKey,
    http_method: 'POST' as const,
    http_path: ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH,
    requested_at: '2026-08-10T08:00:00.000Z',
    integrity: {
      canonicalization: 'RFC8785' as const,
      payload_sha256: `sha256:${'c'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
      key_id: installationKey,
      signature_base64: 'AAAAAAAA',
    },
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
    checkPermissionSubject: unexpectedCall,
    checkReviewerPermissionSubject: unexpectedCall,
    revokeMembership: unexpectedCall,
    revokeInstallation: unexpectedCall,
    recoverInstallationAccess: unexpectedCall,
    ...overrides,
  };
}

describe('authority HTTP presentation', () => {
  it.each([
    {
      label: 'legacy V1',
      schema_version: 1 as const,
      requested_active_lease_ttl_ms: undefined,
    },
    {
      label: 'opt-in V2',
      schema_version: 2 as const,
      requested_active_lease_ttl_ms: 30 * 60 * 1000,
    },
  ])(
    'admits a $label access lease request at the HTTP boundary',
    async (version) => {
      const installationKey = `sha256:${'b'.repeat(64)}`;
      const request = {
        schema_version: version.schema_version,
        kind: 'echo-organization-access-lease-request' as const,
        request_id: 'alr_00000000-0000-4000-8000-000000000001',
        authority_id: 'oau_00000000-0000-4000-8000-000000000001',
        authority_key_id: `sha256:${'a'.repeat(64)}`,
        organization_id: 'org_00000000-0000-4000-8000-000000000001',
        enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        installation_key_id: installationKey,
        previous_access_state_sha256: `sha256:${'c'.repeat(64)}`,
        ...(version.requested_active_lease_ttl_ms === undefined
          ? {}
          : {
              requested_active_lease_ttl_ms:
                version.requested_active_lease_ttl_ms,
            }),
        requested_at: '2026-08-12T08:00:00.000Z',
        integrity: {
          canonicalization: 'RFC8785' as const,
          payload_sha256: `sha256:${'d'.repeat(64)}`,
          signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
          key_id: installationKey,
          signature_base64: 'AAAAAAAA',
        },
      };
      const calls: unknown[] = [];
      const server = createOrganizationAuthorityHttpServer({
        application: testApplication({
          issueAccessLease: async (command) => {
            calls.push(command);
            return {} as OrganizationInstallationAccessStateV1;
          },
        }),
        adminAuthenticator: { authenticate: () => false },
        clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
          PROXY_TOKEN,
        ),
      });
      const origin = await listen(server);
      try {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_ACCESS_LEASES_PATH}`,
          {
            method: 'POST',
            headers: {
              ...proxyHeaders(
                clientId(`access-lease-v${version.schema_version}-test`),
              ),
              'content-type': 'application/json',
            },
            body: JSON.stringify(request),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ access_state: {} });
      } finally {
        await close(server);
      }
      expect(calls).toEqual([request]);
    },
  );

  it('requires administrator authentication and dispatches the installation access-recovery route', async () => {
    const installation = 'ins_00000000-0000-4000-8000-000000000001';
    const calls: Array<{ installation_id: string; input: unknown }> = [];
    const application = testApplication({
      recoverInstallationAccess: async (installationId, input) => {
        calls.push({ installation_id: installationId, input });
        return {
          installation_id: installationId,
          changed: true,
          local_access_state_sequence: input.local_access_state_sequence,
          access_state_sequence: 257,
          valid_until: '2026-08-09T12:05:00.000Z',
        };
      },
    });
    const server = createOrganizationAuthorityHttpServer({
      application,
      adminAuthenticator: {
        authenticate: (header) => header === `Bearer ${ADMIN_TOKEN}`,
      },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    const path = `${origin}/v1/admin/installations/${installation}/access-recoveries`;
    const headers = {
      ...proxyHeaders(clientId('access-recovery-test')),
      'content-type': 'application/json',
    };
    const body = JSON.stringify({
      local_access_state_sequence: 254,
      reason: 'Missed issued heads through lost lease responses',
    });
    try {
      const unauthorized = await fetch(path, { method: 'POST', headers, body });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
      await unauthorized.arrayBuffer();

      const recovered = await fetch(path, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${ADMIN_TOKEN}` },
        body,
      });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({
        installation_id: installation,
        changed: true,
        local_access_state_sequence: 254,
        access_state_sequence: 257,
        valid_until: '2026-08-09T12:05:00.000Z',
      });
    } finally {
      await close(server);
    }
    expect(calls).toEqual([
      {
        installation_id: installation,
        input: {
          local_access_state_sequence: 254,
          reason: 'Missed issued heads through lost lease responses',
        },
      },
    ]);
  });

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
    request.rawHeaders[1] = `${ORGANIZATION_API_PROXY_AUTH_SCHEME} wrong-token-with-at-least-32-visible-bytes`;
    expect(() => resolver.resolve(request)).toThrow(
      'trusted proxy identity is unavailable',
    );
    request.rawHeaders[1] = `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`;
    request.rawHeaders[3] = 'employee-one@example.com';
    expect(() => resolver.resolve(request)).toThrow(
      'trusted proxy identity is unavailable',
    );
  });

  it('isolates pre-authentication admission by proxy-authenticated source address', () => {
    const resolver = new AuthenticatedProxyClientIdentityResolver(PROXY_TOKEN);
    const identity = clientId('pilot-proxy');
    const request = {
      rawHeaders: [
        TRUSTED_PROXY_AUTHORIZATION_HEADER,
        `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
        TRUSTED_PROXY_CLIENT_ID_HEADER,
        identity,
        TRUSTED_PROXY_SOURCE_ADDRESS_HEADER,
        '203.0.113.10',
      ],
    };
    const first = resolver.permissionIngressKey(request, identity);
    request.rawHeaders[5] = '203.0.113.11';
    const second = resolver.permissionIngressKey(request, identity);

    expect(first).toMatch(/^cid_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^cid_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    request.rawHeaders[5] = 'not-an-ip';
    expect(() => resolver.permissionIngressKey(request, identity)).toThrow(
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

  it('sends the exact pre-serialized recent-decisions bytes with no-store', async () => {
    const exact = EMPTY_RECENT_DECISIONS_RESPONSE_BYTES;
    let calls = 0;
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      recentDecisions: {
        recentDecisions: (request) => {
          calls += 1;
          expect(request).toEqual(recentDecisionsWireRequest());
          return { status_code: 200, body: exact, item_references: [] };
        },
      },
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_RECENT_DECISIONS_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(clientId('recent-decisions')),
            'content-type': 'application/json',
          },
          body: JSON.stringify(recentDecisionsWireRequest()),
        },
      );
      const received = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-length')).toBe(String(exact.length));
      expect(received).toEqual(exact);
      expect(calls).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('sends exact reviewer bytes and only fixed reviewer route errors', async () => {
    const exact = EMPTY_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES;
    const application = vi.fn(() => ({
      status_code: 200 as const,
      body: exact,
      returned_atom_ids: [],
      returned_record_hashes: [],
    }));
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      reviewerRecentDecisions: { reviewerRecentDecisions: application },
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    });
    const origin = await listen(server);
    const send = (suffix = '', body = JSON.stringify(reviewerRecentDecisionsWireRequest())) =>
      fetch(`${origin}${ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH}${suffix}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(clientId(`reviewer-recent${suffix}`)),
          'content-type': 'application/json',
        },
        body,
      });
    try {
      const response = await send();
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(exact);
      expect(application).toHaveBeenCalledOnce();

      const query = await send('?cursor=1');
      expect(query.status).toBe(400);
      expect(Buffer.from(await query.arrayBuffer())).toEqual(
        fixedReviewerRecentDecisionsErrorBytes(400),
      );
      expect(application).toHaveBeenCalledOnce();

      const malformed = await send('', '{}');
      expect(malformed.status).toBe(400);
      expect(Buffer.from(await malformed.arrayBuffer())).toEqual(
        fixedReviewerRecentDecisionsErrorBytes(400),
      );
      expect(application).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }

    for (const [code, status] of [
      ['unauthorized', 401],
      ['unavailable', 503],
    ] as const) {
      const failing = createOrganizationAuthorityHttpServer({
        application: testApplication(),
        reviewerRecentDecisions: {
          reviewerRecentDecisions: () => {
            throw new ReviewerRecentDecisionsError(code, 'private detail');
          },
        },
        adminAuthenticator: { authenticate: () => false },
        clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
          PROXY_TOKEN,
        ),
      });
      const failingOrigin = await listen(failing);
      try {
        const response = await fetch(
          `${failingOrigin}${ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH}`,
          {
            method: 'POST',
            headers: {
              ...proxyHeaders(clientId(`reviewer-${code}`)),
              'content-type': 'application/json',
            },
            body: JSON.stringify(reviewerRecentDecisionsWireRequest()),
          },
        );
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          fixedReviewerRecentDecisionsErrorBytes(status),
        );
      } finally {
        await close(failing);
      }
    }
  });

  it('rate-limits recent decisions as outer transport without another application call', async () => {
    const recentDecisions = vi.fn(() => ({
      status_code: 200 as const,
      body: EMPTY_RECENT_DECISIONS_RESPONSE_BYTES,
      item_references: [],
    }));
    const server = createOrganizationAuthorityHttpServer({
      application: testApplication(),
      recentDecisions: { recentDecisions },
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
      rateLimiter: new InMemoryPostRequestRateLimiter({
        maximum_requests_per_window: 1,
        window_ms: 60_000,
        maximum_keys: 10,
        now: () => 1_000,
      }),
    });
    const origin = await listen(server);
    const send = (): Promise<Response> =>
      fetch(`${origin}${ORGANIZATION_API_RECENT_DECISIONS_PATH}`, {
        method: 'POST',
        headers: {
          ...proxyHeaders(clientId('rate-limited-recent-decisions')),
          'content-type': 'application/json',
        },
        body: JSON.stringify(recentDecisionsWireRequest()),
      });
    try {
      const admitted = await send();
      expect(admitted.status).toBe(200);
      await admitted.arrayBuffer();
      expect(recentDecisions).toHaveBeenCalledOnce();

      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(limited.headers.get('cache-control')).toBe('no-store');
      expect(await limited.json()).toEqual({
        error: {
          code: 'rate_limited',
          message: 'too many requests',
        },
      });
      expect(recentDecisions).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it('uses only the fixed recent-decisions error bodies', async () => {
    const request = async (
      server: Server,
      body: string,
      suffix = '',
    ): Promise<Response> => {
      const origin = await listen(server);
      return fetch(
        `${origin}${ORGANIZATION_API_RECENT_DECISIONS_PATH}${suffix}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(clientId(`recent-error-${suffix}-${body.length}`)),
            'content-type': 'application/json',
          },
          body,
        },
      );
    };
    const options = {
      application: testApplication(),
      adminAuthenticator: { authenticate: () => false },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
    };

    const inactive = createOrganizationAuthorityHttpServer(options);
    try {
      const response = await request(inactive, '{}');
      expect(response.status).toBe(404);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        fixedRecentDecisionsErrorBytes(404),
      );
    } finally {
      await close(inactive);
    }

    const malformed = createOrganizationAuthorityHttpServer({
      ...options,
      recentDecisions: {
        recentDecisions: () => {
          throw new Error('must not reach application');
        },
      },
    });
    try {
      const response = await request(malformed, '{');
      expect(response.status).toBe(400);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        fixedRecentDecisionsErrorBytes(400),
      );
    } finally {
      await close(malformed);
    }

    for (const [code, status] of [
      ['unauthorized', 401],
      ['unavailable', 503],
    ] as const) {
      const failing = createOrganizationAuthorityHttpServer({
        ...options,
        recentDecisions: {
          recentDecisions: () => {
            throw new OrganizationRecentDecisionsError(code, 'private detail');
          },
        },
      });
      try {
        const response = await request(
          failing,
          JSON.stringify(recentDecisionsWireRequest()),
        );
        expect(response.status).toBe(status);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          fixedRecentDecisionsErrorBytes(status),
        );
        expect(response.headers.get('cache-control')).toBe('no-store');
      } finally {
        await close(failing);
      }
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
