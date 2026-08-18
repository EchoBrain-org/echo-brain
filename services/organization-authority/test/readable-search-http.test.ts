import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  ORGANIZATION_API_READABLE_SEARCH_PATH,
  type OrganizationReadableSearchRequestV1,
} from '@echo-brain/organization-api';
import {
  ReadableSearchError,
  ReadableSearchService,
} from '../src/application/readable-search.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import {
  beginOrganizationAuthorityHttpServerShutdown,
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationReadableSearchHttpApplication } from '../src/presentation/organization-readable-search-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const NOW = '2026-08-12T12:00:00.000Z';
const FIXED_UNAVAILABLE =
  '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('readable-search-http-test')
      .digest('base64url')}`,
  };
}

function readableSearchRequest(): OrganizationReadableSearchRequestV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-readable-search-request',
    request_id: 'osq_11111111-1111-4111-8111-111111111111',
    authority_id: 'oau_22222222-2222-4222-8222-222222222222',
    authority_key_id: digest('authority-key'),
    organization_id: 'org_33333333-3333-4333-8333-333333333333',
    enrollment_id: 'enr_44444444-4444-4444-8444-444444444444',
    installation_id: 'ins_55555555-5555-4555-8555-555555555555',
    installation_key_id: digest('installation-key'),
    http_method: 'POST',
    http_path: ORGANIZATION_API_READABLE_SEARCH_PATH,
    query: 'quarterly planning',
    requested_at: NOW,
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('request-payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: digest('installation-key'),
      signature_base64: 'QUJDREVGR0g=',
    },
  };
}

function authorityApplication(): OrganizationAuthorityHttpApplication {
  return {} as OrganizationAuthorityHttpApplication;
}

function server(
  readableSearch?: OrganizationReadableSearchHttpApplication,
): Server {
  return createOrganizationAuthorityHttpServer({
    application: authorityApplication(),
    readableSearch,
    adminAuthenticator: { authenticate: () => false },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
  } satisfies OrganizationAuthorityHttpServerOptions);
}

function preparedResponse(
  status_code: 200 | 401 | 404,
  body: Buffer,
  release = vi.fn(),
) {
  return {
    status_code,
    handoff(send: (bytes: string) => void): void {
      try {
        send(body.toString('utf8'));
      } finally {
        release();
      }
    },
  };
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

describe('readable-search HTTP route', () => {
  it('sends the prepared canonical UTF-8 body byte-for-byte after audit', async () => {
    const command = readableSearchRequest();
    const body = Buffer.from(
      '{"contract_id":"permission-aware-readable-search-v1","items":["é"],"schema_version":1}',
      'utf8',
    );
    const committedAudit = { response_sha256: digest(body.toString('utf8')) };
    const release = vi.fn();
    const search = vi.fn(async () => preparedResponse(200, body, release));
    const http = server({ search });
    const origin = await listen(http);
    try {
      const response = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: canonicalJson(command),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-length')).toBe(
        String(Buffer.byteLength(body.toString('utf8'), 'utf8')),
      );
      const responseBytes = Buffer.from(await response.arrayBuffer());
      expect(responseBytes).toEqual(body);
      expect(digest(responseBytes.toString('utf8'))).toBe(
        committedAudit.response_sha256,
      );
      expect(search).toHaveBeenCalledWith(command, {
        signal: expect.any(AbortSignal),
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await close(http);
    }
  });

  it('hands presentation an immutable primitive and HTTP emits its exact UTF-8 bytes', async () => {
    const audited = Buffer.from('{"audited":true}', 'utf8');
    const response = preparedResponse(200, audited);
    expect('body' in response).toBe(false);
    let transportBody: string | undefined;
    response.handoff((body) => {
      transportBody = body;
      // Primitive indexed writes either throw in strict mode or are ignored;
      // either way, the handed-off string cannot alter the audited bytes.
      try {
        (body as unknown as { 0: string })[0] = '[';
      } catch {}
    });
    expect(transportBody).toBe('{"audited":true}');
    expect(audited.toString('utf8')).toBe('{"audited":true}');
  });

  it('rejects whitespace and reordered raw request bytes before application dispatch', async () => {
    const command = readableSearchRequest();
    const search = vi.fn();
    const http = server({ search });
    const origin = await listen(http);
    try {
      for (const body of [
        JSON.stringify(command, null, 2),
        JSON.stringify(Object.fromEntries(Object.entries(command).reverse())),
      ]) {
        const response = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body,
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(
          '{"error":{"code":"invalid_request","message":"request is invalid"}}',
        );
      }
      expect(search).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });

  it('uses the fixed unavailable body when the runtime is absent or audit fails', async () => {
    const command = readableSearchRequest();
    for (const readableSearch of [
      undefined,
      {
        search: vi.fn(async () => {
          throw new ReadableSearchError(
            'unavailable',
            'private audit write failure before response handoff',
          );
        }),
      },
    ]) {
      const http = server(readableSearch);
      const origin = await listen(http);
      try {
        const response = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: canonicalJson(command),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(FIXED_UNAVAILABLE);
      } finally {
        await close(http);
      }
    }
  });

  it('maps an authentication-store fault through the real service boundary to fixed 503', async () => {
    const retrieval = {
      openScope: vi.fn(() => { throw new Error('must not open'); }),
      search: vi.fn(() => []),
      fetch: vi.fn(() => []),
      finalStateStillMatches: vi.fn(() => false),
      close: vi.fn(),
    };
    const readableSearch = new ReadableSearchService({
      authority: {
        authenticate: () => { throw new Error('private repository read fault'); },
        currentPerson: () => { throw new Error('must not resolve Person'); },
        writeAtLinearization: () => { throw new Error('must not write audit'); },
      },
      retrieval,
      fence: new ReadableSearchAuthorizationFence(),
      fence_timeout_ms: 10,
      contract: {
        retrieval_contract_sha256: digest('retrieval-contract'),
        policy_contracts: [
          {
            policy_id: 'organization-member-readable-v1',
            policy_contract_sha256: digest('member-policy'),
          },
          {
            policy_id: 'restricted-reviewer-v1',
            policy_contract_sha256: digest('reviewer-policy'),
          },
        ],
      },
    });
    const http = server(readableSearch);
    const origin = await listen(http);
    try {
      const response = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: canonicalJson(readableSearchRequest()),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(FIXED_UNAVAILABLE);
      expect(retrieval.openScope).not.toHaveBeenCalled();
      expect(retrieval.search).not.toHaveBeenCalled();
      expect(retrieval.fetch).not.toHaveBeenCalled();
      expect(retrieval.close).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });

  it('aborts queued readable-search work when Authority shutdown begins', async () => {
    const command = readableSearchRequest();
    let entered!: () => void;
    const searchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const search = vi.fn(
      async (
        _request: OrganizationReadableSearchRequestV1,
        requestOptions?: { readonly signal?: AbortSignal },
      ) => {
        const signal = requestOptions?.signal;
        if (signal === undefined) throw new Error('readable-search signal is missing');
        entered();
        return await new Promise<never>((_resolve, reject) => {
          const unavailable = (): void => {
            reject(
              new ReadableSearchError(
                'unavailable',
                'readable-search fence admission was cancelled',
              ),
            );
          };
          if (signal.aborted) unavailable();
          else signal.addEventListener('abort', unavailable, { once: true });
        });
      },
    );
    const http = server({ search });
    const origin = await listen(http);
    try {
      const responsePending = fetch(
        `${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`,
        {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: canonicalJson(command),
        },
      );
      await searchEntered;
      beginOrganizationAuthorityHttpServerShutdown(http);
      const response = await responsePending;
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(FIXED_UNAVAILABLE);
    } finally {
      await close(http);
    }
  });

  it('maps readable-search authentication and resource denials plus faults to fixed complete bodies', async () => {
    const command = readableSearchRequest();
    for (const [failure, status, body] of [
      [
        new ReadableSearchError('unauthorized', 'private signature detail'),
        401,
        '{"error":{"code":"unauthorized","message":"authorization failed"}}',
      ],
      [
        new ReadableSearchError('not_found', 'private membership detail'),
        404,
        '{"error":{"code":"not_found","message":"resource was not found"}}',
      ],
      [
        new Error('private implementation failure'),
        500,
        '{"error":{"code":"internal_error","message":"authority operation failed"}}',
      ],
    ] as const) {
      const http = server({
        search: vi.fn(async () => {
          throw failure;
        }),
      });
      const origin = await listen(http);
      try {
        const response = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
          method: 'POST',
          headers: { ...proxyHeaders(), 'content-type': 'application/json' },
          body: canonicalJson(command),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(body);
      } finally {
        await close(http);
      }
    }
  });

  it('rejects method/query misuse and enforces the outer 16KiB cap', async () => {
    const http = server({ search: vi.fn() });
    const origin = await listen(http);
    try {
      const method = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
        method: 'GET',
        headers: proxyHeaders(),
      });
      expect(method.status).toBe(400);
      expect(await method.text()).toBe(
        '{"error":{"code":"invalid_request","message":"request is invalid"}}',
      );
      const query = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}?x=1`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: canonicalJson(readableSearchRequest()),
      });
      expect(query.status).toBe(400);
      const oversize = await fetch(`${origin}${ORGANIZATION_API_READABLE_SEARCH_PATH}`, {
        method: 'POST',
        headers: { ...proxyHeaders(), 'content-type': 'application/json' },
        body: 'x'.repeat(16 * 1024 + 1),
      });
      expect(oversize.status).toBe(413);
    } finally {
      await close(http);
    }
  });
});
