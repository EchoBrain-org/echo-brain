import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
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
}): Server {
  return createOrganizationAuthorityHttpServer({
    application: {} as OrganizationAuthorityHttpApplication,
    ...options,
    adminAuthenticator: { authenticate: () => false },
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
});
