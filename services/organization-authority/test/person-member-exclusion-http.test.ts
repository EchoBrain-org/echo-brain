import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const ACCESS_TOKEN = 'A'.repeat(43);
const INVALID_REQUEST_BODY =
  '{"error":{"code":"invalid_request","message":"request is invalid"}}';
const UNAUTHORIZED_BODY =
  '{"error":{"code":"unauthorized","message":"authorization failed"}}';
const UNAVAILABLE_BODY =
  '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';

const REQUEST = {
  schema_version: 2,
  kind: 'echo-organization-person-member-exclusion-change-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000001',
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  subject_principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
  excluded: true,
  selector: {
    scope: 'meeting',
    source_adapter_id: 'granola',
    source_instance_id: 'primary',
    external_id: 'provider-meeting-id',
  },
} as const;

const LIST_REQUEST = {
  schema_version: 2,
  kind: 'echo-organization-person-member-exclusion-list-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000002',
  authority_id: REQUEST.authority_id,
  organization_id: REQUEST.organization_id,
  subject_principal_id: REQUEST.subject_principal_id,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
} as const;

const ADMIN_REQUEST = {
  schema_version: 2,
  kind: 'echo-organization-admin-member-exclusion-break-glass-read-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000003',
  authority_id: REQUEST.authority_id,
  organization_id: REQUEST.organization_id,
  target_principal_id: REQUEST.subject_principal_id,
  target_membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  http_method: 'POST',
  http_path: ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
} as const;

const LIST_RESPONSE = {
  schema_version: 2,
  kind: 'echo-organization-member-exclusion-list-response',
  authority_id: REQUEST.authority_id,
  organization_id: REQUEST.organization_id,
  subject_principal_id: REQUEST.subject_principal_id,
  membership_id: ADMIN_REQUEST.target_membership_id,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
  exclusions: [
    {
      scope: 'meeting',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'sentinel-private-meeting',
    },
  ],
} as const;

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('person-member-exclusion-http-test')
      .digest('base64url')}`,
  };
}

function server(options: {
  personMemberExclusions?: OrganizationAuthorityHttpServerOptions['personMemberExclusions'];
  personMemberExclusionReads?: OrganizationAuthorityHttpServerOptions['personMemberExclusionReads'];
}): Server {
  return createOrganizationAuthorityHttpServer({
    application: {} as OrganizationAuthorityHttpApplication,
    ...options,
    adminAuthenticator: {
      authenticate: (header) => header === `Bearer ${ADMIN_TOKEN}`,
    },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
  });
}

async function listen(http: Server): Promise<string> {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function close(http: Server): Promise<void> {
  if (!http.listening) return;
  const closed = once(http, 'close');
  http.close();
  await closed;
}

function requestHeaders(): Record<string, string> {
  return {
    ...proxyHeaders(),
    authorization: `Bearer ${ACCESS_TOKEN}`,
    'content-type': 'application/json',
  };
}

function prepared(status_code: 200 | 401 | 404, body: string) {
  return {
    status_code,
    handoff(send: (value: string) => void): void {
      send(body);
    },
  };
}

describe('Person member exclusion HTTP route', () => {
  it('dispatches one canonical desired-state request and returns empty 204', async () => {
    const change = vi.fn(async () => undefined);
    const http = server({ personMemberExclusions: { change } });
    const origin = await listen(http);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(REQUEST),
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
      expect(change).toHaveBeenCalledOnce();
      expect(change).toHaveBeenCalledWith(REQUEST, ACCESS_TOKEN);
    } finally {
      await close(http);
    }
  });

  it('returns the fixed 503 when the Person valve facade is absent', async () => {
    const http = server({});
    const origin = await listen(http);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(REQUEST),
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(UNAVAILABLE_BODY);
    } finally {
      await close(http);
    }
  });

  it('rejects malformed, noncanonical, query, and wrong-method requests before dispatch', async () => {
    const change = vi.fn(async () => undefined);
    const http = server({ personMemberExclusions: { change } });
    const origin = await listen(http);
    try {
      const attempts = [
        fetch(`${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`, {
          method: 'POST',
          headers: requestHeaders(),
          body: '{',
        }),
        fetch(`${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`, {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify(REQUEST, null, 2),
        }),
        fetch(
          `${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}?include=contents`,
          {
            method: 'POST',
            headers: requestHeaders(),
            body: canonicalJson(REQUEST),
          },
        ),
        fetch(`${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`, {
          method: 'GET',
          headers: proxyHeaders(),
        }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(INVALID_REQUEST_BODY);
      }
      expect(change).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });

  it('maps application authorization failures to the fixed opaque 401', async () => {
    const change = vi.fn(async () => {
      throw new AuthorityOperationError(
        'unauthorized',
        'private source ownership detail must not escape',
      );
    });
    const http = server({ personMemberExclusions: { change } });
    const origin = await listen(http);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(REQUEST),
        },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(UNAUTHORIZED_BODY);
      expect(change).toHaveBeenCalledWith(REQUEST, ACCESS_TOKEN);
    } finally {
      await close(http);
    }
  });

  it('hands off the Person list service exact audited bytes without reserialization', async () => {
    const exactBody = canonicalJson(LIST_RESPONSE);
    const listOwn = vi.fn(async () => prepared(200, exactBody));
    const breakGlass = vi.fn();
    const http = server({
      personMemberExclusionReads: { listOwn, breakGlass },
    });
    const origin = await listen(http);
    try {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(LIST_REQUEST),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(exactBody);
      expect(listOwn).toHaveBeenCalledWith(LIST_REQUEST, ACCESS_TOKEN);
      expect(breakGlass).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });

  it('authenticates and domain-binds the explicit admin break-glass read', async () => {
    const exactBody = canonicalJson(LIST_RESPONSE);
    const listOwn = vi.fn();
    const breakGlass = vi.fn(async () => prepared(200, exactBody));
    const http = server({
      personMemberExclusionReads: { listOwn, breakGlass },
    });
    const origin = await listen(http);
    try {
      const denied = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(ADMIN_REQUEST),
        },
      );
      expect(denied.status).toBe(401);
      expect(await denied.text()).toBe(UNAUTHORIZED_BODY);
      expect(breakGlass).not.toHaveBeenCalled();

      const authorization = `Bearer ${ADMIN_TOKEN}`;
      const allowed = await fetch(
        `${origin}${ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH}`,
        {
          method: 'POST',
          headers: {
            ...proxyHeaders(),
            authorization,
            'content-type': 'application/json',
          },
          body: canonicalJson(ADMIN_REQUEST),
        },
      );
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe(exactBody);
      expect(breakGlass).toHaveBeenCalledWith(
        ADMIN_REQUEST,
        `sha256:${createHash('sha256')
          .update(
            'echo-authority-member-exclusion-break-glass-admin-v1\0',
            'utf8',
          )
          .update(authorization, 'utf8')
          .digest('hex')}`,
      );
    } finally {
      await close(http);
    }
  });

  it('does not release exclusion bytes when either read service fails before handoff', async () => {
    const auditFailure = new Error(
      'audit unavailable for sentinel-private-meeting',
    );
    const http = server({
      personMemberExclusionReads: {
        listOwn: vi.fn(async () => {
          throw auditFailure;
        }),
        breakGlass: vi.fn(async () => {
          throw auditFailure;
        }),
      },
    });
    const origin = await listen(http);
    try {
      for (const attempt of [
        {
          path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
          headers: requestHeaders(),
          body: LIST_REQUEST,
        },
        {
          path: ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
          headers: {
            ...proxyHeaders(),
            authorization: `Bearer ${ADMIN_TOKEN}`,
            'content-type': 'application/json',
          },
          body: ADMIN_REQUEST,
        },
      ]) {
        const response = await fetch(`${origin}${attempt.path}`, {
          method: 'POST',
          headers: attempt.headers,
          body: canonicalJson(attempt.body),
        });
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('sentinel-private-meeting');
      }
    } finally {
      await close(http);
    }
  });
});
