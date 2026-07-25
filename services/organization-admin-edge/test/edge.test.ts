import { Buffer } from 'node:buffer';
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '@echo-brain/organization-api';
import type { OrganizationAdminEdgeServeConfig } from '../src/config.js';
import {
  MAX_ORGANIZATION_ADMIN_EDGE_HEADER_COUNT,
  MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES,
  organizationAdminClientCertificateIdentity,
  startOrganizationAdminEdge,
  type OrganizationAdminEdgeStartOptions,
} from '../src/edge.js';
import { createTestPki, type TestCertificate, type TestPki } from './support/pki.js';

const HOSTNAME = 'admin.edge.test';
const EMPLOYEE_AUTHORITY_URL = 'https://authority.edge.test';
const PROXY_TOKEN = 'edge-test-proxy-token-000000000000000000000001';

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface TestResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface StartedEdge {
  readonly port: number;
  readonly public_origin: string;
  active_connection_count(): Promise<number>;
}

let pki: TestPki;
let adminOnePin: `sha256:${string}`;
const closeables: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createTestPki(HOSTNAME);
  adminOnePin = organizationAdminClientCertificateIdentity(
    new X509Certificate(pki.admin_one.certificate),
  ).pin;
});

afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
});

afterAll(() => pki.cleanup());

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function startOrigin(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
  host = '127.0.0.1',
): Promise<{ readonly origin: string; readonly server: Server }> {
  const server = createHttpServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  closeables.push(() => closeServer(server));
  return {
    origin:
      host === '::1'
        ? `http://[::1]:${String(address.port)}`
        : `http://127.0.0.1:${String(address.port)}`,
    server,
  };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function startEdge(
  authorityOrigin: string,
  allowedPins: ReadonlySet<string> = new Set([adminOnePin]),
  options: OrganizationAdminEdgeStartOptions = {},
): Promise<StartedEdge> {
  const port = await reservePort();
  const publicOrigin = `https://${HOSTNAME}:${String(port)}`;
  const config: OrganizationAdminEdgeServeConfig = {
    listener: { host: '127.0.0.1', port },
    public_origin: publicOrigin,
    employee_authority_base_url: EMPLOYEE_AUTHORITY_URL,
    authority_origin: authorityOrigin,
    tls: {
      certificate_chain: pki.server.certificate,
      private_key: pki.server.private_key,
      client_ca_bundle: pki.ca_certificate,
    },
    trusted_proxy_token: PROXY_TOKEN,
    allowed_admin_client_spki_sha256: allowedPins,
  };
  const edge = await startOrganizationAdminEdge(config, options);
  closeables.push(() => edge.close());
  return {
    port,
    public_origin: publicOrigin,
    active_connection_count: () => edge.active_connection_count(),
  };
}

function edgeRequest(
  edge: StartedEdge,
  options: {
    readonly path: string;
    readonly method?: string;
    readonly body?: Buffer | string;
    readonly headers?: OutgoingHttpHeaders;
    readonly certificate?: TestCertificate | null;
    readonly servername?: string;
    readonly host?: string;
    readonly ignore_server_certificate_hostname?: boolean;
    readonly omit_origin?: boolean;
  },
): Promise<TestResponse> {
  const body =
    typeof options.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : options.body;
  const headers: OutgoingHttpHeaders = {
    host: options.host ?? new URL(edge.public_origin).host,
    ...options.headers,
  };
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.length);
  }
  if (
    options.method === 'POST' &&
    options.omit_origin !== true &&
    headers.origin === undefined &&
    headers.Origin === undefined
  ) {
    headers.origin = edge.public_origin;
  }
  const certificate =
    options.certificate === undefined ? pki.admin_one : options.certificate;
  return new Promise<TestResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: edge.port,
        servername: options.servername ?? HOSTNAME,
        method: options.method ?? 'GET',
        path: options.path,
        headers,
        ca: pki.ca_certificate,
        ...(certificate === null
          ? {}
          : {
              cert: certificate.certificate,
              key: certificate.private_key,
            }),
        rejectUnauthorized: true,
        ...(options.ignore_server_certificate_hostname === true
          ? { checkServerIdentity: () => undefined }
          : {}),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once('error', reject);
    if (body === undefined) request.end();
    else request.end(body);
  });
}

function rawTlsRequest(edge: StartedEdge, rawRequest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port: edge.port,
      servername: HOSTNAME,
      ca: pki.ca_certificate,
      cert: pki.admin_one.certificate,
      key: pki.admin_one.private_key,
      rejectUnauthorized: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let connected = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    socket.once('secureConnect', () => {
      connected = true;
      socket.end(rawRequest, 'ascii');
    });
    socket.on('data', (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', (error) => {
      if (settled) return;
      if (
        connected &&
        (error as NodeJS.ErrnoException).code === 'ECONNRESET'
      ) {
        finish();
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

function pausedResponse(edge: StartedEdge): Promise<{
  response_complete(): boolean;
  dispose(): void;
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: edge.port,
        servername: HOSTNAME,
        method: 'GET',
        path: '/admin',
        headers: { host: new URL(edge.public_origin).host },
        ca: pki.ca_certificate,
        cert: pki.admin_one.certificate,
        key: pki.admin_one.private_key,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        response.pause();
        resolve({
          response_complete: () => response.complete,
          dispose: () => {
            response.resume();
            response.destroy();
            request.destroy();
          },
        });
        response.once('error', () => {
          // The active-connection observation owns the deadline assertion.
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function respond(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: OutgoingHttpHeaders = {},
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    ...headers,
  });
  response.end(bytes);
}

describe('organization administrator HTTPS edge', () => {
  it('proxies only an allowed mTLS identity and replaces every untrusted edge header', async () => {
    const captured: CapturedRequest[] = [];
    const origin = await startOrigin(async (request, response) => {
      captured.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: await requestBody(request),
      });
      respond(response, 200, '<h1>Administrator</h1>');
    });
    const edge = await startEdge(origin.origin);
    const expectedIdentity = organizationAdminClientCertificateIdentity(
      new X509Certificate(pki.admin_one.certificate),
    );

    const get = await edgeRequest(edge, {
      path: '/admin/login',
      headers: {
        [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
          'Echo-Proxy attacker-controlled-token',
        [TRUSTED_PROXY_CLIENT_ID_HEADER]:
          'cid_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'x-echo-runtime-status-nonce': 'must-not-pass',
        'x-echo-admin-csrf': 'csrf-proof-is-allowed',
        forwarded: 'for=192.0.2.1',
        'x-forwarded-for': '192.0.2.1',
        via: 'attacker',
      },
    });
    expect(get.status).toBe(200);
    expect(get.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: 'GET',
      url: '/admin/login',
      body: Buffer.alloc(0),
    });
    expect(captured[0]!.headers.host).toBe(
      new URL(edge.public_origin).host,
    );
    expect(
      captured[0]!.headers[TRUSTED_PROXY_AUTHORIZATION_HEADER],
    ).toBe(`Echo-Proxy ${PROXY_TOKEN}`);
    expect(captured[0]!.headers[TRUSTED_PROXY_CLIENT_ID_HEADER]).toBe(
      expectedIdentity.client_id,
    );
    expect(captured[0]!.headers['x-echo-runtime-status-nonce']).toBeUndefined();
    expect(captured[0]!.headers['x-echo-admin-csrf']).toBe(
      'csrf-proof-is-allowed',
    );
    expect(captured[0]!.headers.forwarded).toBeUndefined();
    expect(captured[0]!.headers['x-forwarded-for']).toBeUndefined();
    expect(captured[0]!.headers.via).toBeUndefined();

    const postBody = 'credential=bounded-admin-credential';
    const post = await edgeRequest(edge, {
      path: '/admin/login',
      method: 'POST',
      body: postBody,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(post.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[1]).toMatchObject({
      method: 'POST',
      url: '/admin/login',
      body: Buffer.from(postBody),
    });
    expect(captured[1]!.headers.origin).toBe(edge.public_origin);
    expect(captured[1]!.headers['content-length']).toBe(
      String(Buffer.byteLength(postBody)),
    );
  });

  it('connects to a literal IPv6 loopback authority origin without DNS resolution', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 200, 'ipv6 authority');
    }, '::1');
    const edge = await startEdge(origin.origin);

    const response = await edgeRequest(edge, { path: '/admin/login' });
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('ipv6 authority');
    expect(originRequests).toBe(1);
  });

  it('serves bounded edge configuration locally without CORS, redirects, or origin traffic', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 500, 'must not be reached');
    });
    const edge = await startEdge(origin.origin);

    const response = await edgeRequest(edge, {
      path: '/admin/edge-config',
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      authority_base_url: EMPLOYEE_AUTHORITY_URL,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000',
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    expect(originRequests).toBe(0);

    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/edge-config?query=forbidden',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/edge-config',
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/edge-config',
          body: 'x',
        })
      ).status,
    ).toBe(400);
    expect(originRequests).toBe(0);
  });

  it('requires a trusted certificate, an explicit SPKI pin, exact SNI, and exact Host', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 200, 'unexpected');
    });
    const edge = await startEdge(origin.origin);

    await expect(
      edgeRequest(edge, {
        path: '/admin/login',
        certificate: null,
      }),
    ).rejects.toThrow();
    await expect(
      edgeRequest(edge, {
        path: '/admin/login',
        certificate: pki.untrusted_admin,
      }),
    ).rejects.toThrow();
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/login',
          certificate: pki.admin_two,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/login',
          host: 'attacker.edge.test',
        })
      ).status,
    ).toBe(421);
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/login',
          method: 'POST',
          body: 'credential=value',
          omit_origin: true,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/login',
          method: 'POST',
          body: 'credential=value',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://attacker.edge.test',
          },
        })
      ).status,
    ).toBe(403);
    await expect(
      edgeRequest(edge, {
        path: '/admin/login',
        servername: 'attacker.edge.test',
        ignore_server_certificate_hostname: true,
      }),
    ).rejects.toThrow();
    await expect(
      edgeRequest(edge, {
        path: '/admin/login',
        servername: '',
        ignore_server_certificate_hostname: true,
      }),
    ).rejects.toThrow();
    expect(originRequests).toBe(0);
  });

  it('snapshots the administrator pin allowlist before accepting traffic', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 200, 'allowed');
    });
    const mutablePins = new Set<string>([adminOnePin]);
    const edge = await startEdge(origin.origin, mutablePins);
    const adminTwoPin = organizationAdminClientCertificateIdentity(
      new X509Certificate(pki.admin_two.certificate),
    ).pin;
    mutablePins.delete(adminOnePin);
    mutablePins.add(adminTwoPin);

    expect((await edgeRequest(edge, { path: '/admin/login' })).status).toBe(
      200,
    );
    expect(
      (
        await edgeRequest(edge, {
          path: '/admin/login',
          certificate: pki.admin_two,
        })
      ).status,
    ).toBe(403);
    expect(originRequests).toBe(1);
  });

  it('denies private APIs and every noncanonical request target before origin traffic', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 200, 'unexpected');
    });
    const edge = await startEdge(origin.origin);
    for (const path of [
      '/v1/admin/overview',
      '/v1/enrollments',
      '/_echo/runtime-status',
      '/admin?query=forbidden',
      '/admin/../_echo/runtime-status',
      '/admin/%2e%2e/_echo/runtime-status',
      '//admin',
      '/admin/not-a-real-route',
    ]) {
      expect((await edgeRequest(edge, { path })).status, path).toBe(404);
    }
    expect(originRequests).toBe(0);
  });

  it('rejects raw-header ambiguity, invalid framing, and excessive header counts', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      respond(response, 200, 'unexpected');
    });
    const edge = await startEdge(origin.origin);
    const host = new URL(edge.public_origin).host;

    const duplicateHost = await rawTlsRequest(
      edge,
      [
        'GET /admin/login HTTP/1.1',
        `Host: ${host}`,
        `Host: ${host}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    expect(duplicateHost).toContain('400');

    await rawTlsRequest(
      edge,
      [
        'POST /admin/login HTTP/1.1',
        `Host: ${host}`,
        `Origin: ${edge.public_origin}`,
        'Content-Length: 4',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '0',
        '',
        '',
      ].join('\r\n'),
    );

    const tooManyHeaders = Array.from(
      { length: MAX_ORGANIZATION_ADMIN_EDGE_HEADER_COUNT },
      (_value, index) => `X-Test-${String(index)}: value`,
    );
    const excessive = await rawTlsRequest(
      edge,
      [
        'GET /admin/login HTTP/1.1',
        `Host: ${host}`,
        ...tooManyHeaders,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    expect(excessive === '' || excessive.includes('400')).toBe(true);
    expect(originRequests).toBe(0);
  });

  it('bounds bodies and responses, rejects upgrades, and never retries a failed POST', async () => {
    const requestCounts = new Map<string, number>();
    const origin = await startOrigin(async (request, response) => {
      await requestBody(request);
      const key = `${request.method ?? ''} ${request.url ?? ''}`;
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
      if (request.url === '/admin') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'content-length': String(
            MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES + 1,
          ),
        });
        response.end();
        return;
      }
      if (request.url === '/admin/assets/admin.js') {
        response.writeHead(101, {
          connection: 'Upgrade',
          upgrade: 'edge-test',
        });
        response.end();
        return;
      }
      request.socket.destroy();
    });
    const edge = await startEdge(origin.origin);

    const oversizedRequest = await edgeRequest(edge, {
      path: '/admin/login',
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'content-length': String(MAX_ORGANIZATION_API_BODY_BYTES + 1),
      },
    });
    expect(oversizedRequest.status).toBe(413);
    expect(requestCounts.size).toBe(0);

    expect((await edgeRequest(edge, { path: '/admin' })).status).toBe(502);
    expect(
      (await edgeRequest(edge, { path: '/admin/assets/admin.js' })).status,
    ).toBe(502);
    const failedPost = await edgeRequest(edge, {
      path: '/admin/login',
      method: 'POST',
      body: 'credential=never-retry',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(failedPost.status).toBe(502);
    expect(requestCounts.get('POST /admin/login')).toBe(1);
  });

  it('enforces an absolute upstream deadline even when the origin keeps dripping bytes', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-length': '100',
      });
      response.write('x');
      const drip = setInterval(() => response.write('x'), 25);
      response.once('close', () => clearInterval(drip));
    });
    const edge = await startEdge(
      origin.origin,
      new Set([adminOnePin]),
      {
        upstream_absolute_deadline_ms: 125,
        downstream_absolute_deadline_ms: 1_000,
      },
    );
    const startedAt = Date.now();

    const response = await edgeRequest(edge, { path: '/admin' });
    expect(response.status).toBe(502);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(originRequests).toBe(1);
  });

  it('enforces an absolute downstream deadline while the origin stalls', async () => {
    let originRequests = 0;
    const origin = await startOrigin((_request, response) => {
      originRequests += 1;
      const delayed = setTimeout(
        () => respond(response, 200, 'too late'),
        1_000,
      );
      response.once('close', () => clearTimeout(delayed));
    });
    const edge = await startEdge(
      origin.origin,
      new Set([adminOnePin]),
      {
        upstream_absolute_deadline_ms: 1_000,
        downstream_absolute_deadline_ms: 125,
      },
    );
    const startedAt = Date.now();

    await expect(edgeRequest(edge, { path: '/admin' })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(originRequests).toBe(1);
  });

  it('closes an authenticated downstream that stops reading the bounded response', async () => {
    const origin = await startOrigin((_request, response) => {
      respond(
        response,
        200,
        Buffer.alloc(MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES, 0x61),
      );
    });
    const edge = await startEdge(
      origin.origin,
      new Set([adminOnePin]),
      {
        upstream_absolute_deadline_ms: 1_000,
        downstream_absolute_deadline_ms: 200,
      },
    );

    const paused = await pausedResponse(edge);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await edge.active_connection_count()).toBe(0);
    expect(paused.response_complete()).toBe(false);
    paused.dispose();
  });
});
