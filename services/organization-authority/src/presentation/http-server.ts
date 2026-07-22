import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  validateCompleteOrganizationEnrollmentRequest,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateOrganizationAccessLeaseRequest,
  validateProvisionOrganizationMembershipRequest,
  validateRevokeOrganizationSubjectRequest,
} from '@echo-brain/organization-api';
import type {
  CompletedOrganizationEnrollmentV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationAccessLeaseResponseV1,
  OrganizationApiErrorV1,
  ProvisionedOrganizationMembershipV1,
  RevokedOrganizationMembershipV1,
} from '@echo-brain/organization-api';
import {
  AuthorityOperationError,
  StaleAccessStateError,
} from '../domain/errors.js';
import type { OrganizationAuthorityHttpApplication } from './organization-authority-http-application.js';
import {
  TrustedProxyIdentityError,
  type RequestClientIdentityResolver,
} from './trusted-proxy-client-identity.js';

export interface AdminRequestAuthenticator {
  authenticate(authorizationHeader: string | undefined): boolean;
}

class PayloadTooLargeError extends Error {}

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const GRANT_ROUTE = new RegExp(
  `^/v1/admin/memberships/(mem_${UUID_V4_SOURCE})/enrollment-grants$`,
);
const MEMBERSHIP_REVOCATION_ROUTE = new RegExp(
  `^/v1/admin/memberships/(mem_${UUID_V4_SOURCE})/revocations$`,
);
const INSTALLATION_REVOCATION_ROUTE = new RegExp(
  `^/v1/admin/installations/(ins_${UUID_V4_SOURCE})/revocations$`,
);

class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('request rate limit exceeded');
  }
}

export interface PostRequestRateLimiter {
  consume(
    key: string,
  ): { allowed: true } | { allowed: false; retry_after_seconds: number };
}

interface RateLimitBucket {
  count: number;
  window_started_at: number;
  last_seen_at: number;
}

export class InMemoryPostRequestRateLimiter implements PostRequestRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly options: {
      maximum_requests_per_window: number;
      window_ms: number;
      maximum_keys: number;
      now?: () => number;
    } = {
      maximum_requests_per_window: 60,
      window_ms: 60_000,
      maximum_keys: 4096,
    },
  ) {
    if (
      !Number.isSafeInteger(options.maximum_requests_per_window) ||
      options.maximum_requests_per_window <= 0 ||
      !Number.isSafeInteger(options.window_ms) ||
      options.window_ms <= 0 ||
      !Number.isSafeInteger(options.maximum_keys) ||
      options.maximum_keys <= 0
    ) {
      throw new Error('HTTP rate limiter configuration is invalid');
    }
  }

  consume(
    key: string,
  ): { allowed: true } | { allowed: false; retry_after_seconds: number } {
    const now = this.options.now?.() ?? Date.now();
    let bucket = this.buckets.get(key);
    if (
      bucket === undefined ||
      now - bucket.window_started_at >= this.options.window_ms
    ) {
      if (
        bucket === undefined &&
        this.buckets.size >= this.options.maximum_keys
      ) {
        let oldestKey: string | undefined;
        let oldestSeen = Number.POSITIVE_INFINITY;
        for (const [candidateKey, candidate] of this.buckets) {
          if (candidate.last_seen_at < oldestSeen) {
            oldestSeen = candidate.last_seen_at;
            oldestKey = candidateKey;
          }
        }
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      bucket = { count: 0, window_started_at: now, last_seen_at: now };
      this.buckets.set(key, bucket);
    }
    bucket.last_seen_at = now;
    if (bucket.count >= this.options.maximum_requests_per_window) {
      return {
        allowed: false,
        retry_after_seconds: Math.max(
          1,
          Math.ceil(
            (bucket.window_started_at + this.options.window_ms - now) / 1000,
          ),
        ),
      };
    }
    bucket.count += 1;
    return { allowed: true };
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(bytes);
}

function errorBody(code: string, message: string): OrganizationApiErrorV1 {
  return { error: { code, message } };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'Content-Type must be application/json',
    );
  }
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new AuthorityOperationError(
        'invalid_request',
        'Content-Length is invalid',
      );
    }
    if (parsed > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  if (total === 0) {
    throw new AuthorityOperationError(
      'invalid_request',
      'request body is empty',
    );
  }
  return decodeOrganizationApiJsonBody(Buffer.concat(chunks));
}

export function decodeOrganizationApiJsonBody(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AuthorityOperationError(
      'invalid_request',
      'request body is not valid UTF-8',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AuthorityOperationError(
      'invalid_request',
      'request body is not valid JSON',
    );
  }
}

function decodeEnrollmentGrant(header: string | undefined): Uint8Array {
  const match = /^Echo-Enrollment ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (match === null) {
    throw new AuthorityOperationError(
      'unauthorized',
      'enrollment authorization is unavailable',
    );
  }
  const bytes = Buffer.from(match[1]!, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[1]) {
    throw new AuthorityOperationError(
      'unauthorized',
      'enrollment authorization is unavailable',
    );
  }
  return Uint8Array.from(bytes);
}

function membershipResponse(
  value: ReturnType<
    OrganizationAuthorityHttpApplication['provisionMembership']
  >,
): ProvisionedOrganizationMembershipV1 {
  return {
    organization_id: value.organization_id,
    principal_id: value.principal_id,
    membership_id: value.membership_id,
    display_name: value.display_name,
    membership_type: value.membership_type,
    status: value.status,
    provisioned_at: value.provisioned_at,
    revoked_at: value.revoked_at,
  };
}

export interface OrganizationAuthorityHttpServerOptions {
  application: OrganizationAuthorityHttpApplication;
  adminAuthenticator: AdminRequestAuthenticator;
  clientIdentityResolver: RequestClientIdentityResolver;
  rateLimiter?: PostRequestRateLimiter;
}

export function createOrganizationAuthorityHttpServer(
  options: OrganizationAuthorityHttpServerOptions,
): Server {
  const rateLimiter =
    options.rateLimiter ?? new InMemoryPostRequestRateLimiter();
  const requireAdmin = (request: IncomingMessage): void => {
    if (
      !options.adminAuthenticator.authenticate(request.headers.authorization)
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        'administrator authorization is unavailable',
      );
    }
  };

  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    async (request, response) => {
      let authenticationChallenge: 'Bearer' | 'Echo-Enrollment' | undefined;
      try {
        const method = request.method ?? '';
        const url = new URL(request.url ?? '/', 'http://authority.invalid');
        if (url.search !== '') {
          throw new AuthorityOperationError(
            'invalid_request',
            'query parameters are not supported',
          );
        }
        const clientIdentity = options.clientIdentityResolver.resolve(request);
        authenticationChallenge =
          method === 'POST' && url.pathname.startsWith('/v1/admin/')
            ? 'Bearer'
            : method === 'POST' && url.pathname === '/v1/enrollments'
              ? 'Echo-Enrollment'
              : undefined;
        if (method === 'POST') {
          const routeClass = url.pathname.startsWith('/v1/admin/')
            ? 'admin'
            : url.pathname === '/v1/enrollments'
              ? 'enrollment'
              : url.pathname === '/v1/access-leases'
                ? 'access'
                : 'other';
          const limit = rateLimiter.consume(`${clientIdentity}:${routeClass}`);
          if (!limit.allowed) {
            throw new RateLimitedError(limit.retry_after_seconds);
          }
        }

        if (method === 'GET' && url.pathname === '/v1/authority-descriptor') {
          sendJson(response, 200, {
            authority_descriptor: options.application.descriptor(),
          });
          return;
        }

        if (method === 'POST' && url.pathname === '/v1/admin/memberships') {
          requireAdmin(request);
          const body = validateProvisionOrganizationMembershipRequest(
            await readJsonBody(request),
          );
          sendJson(
            response,
            201,
            membershipResponse(options.application.provisionMembership(body)),
          );
          return;
        }

        const grantRoute = GRANT_ROUTE.exec(url.pathname);
        if (method === 'POST' && grantRoute !== null) {
          requireAdmin(request);
          const body = validateIssueOrganizationEnrollmentGrantRequest(
            await readJsonBody(request),
          );
          const issued = options.application.issueEnrollmentGrant(
            grantRoute[1]!,
            body.lifetime_seconds,
          );
          const result: IssuedOrganizationEnrollmentGrantV1 = {
            authority_id: issued.authority_id,
            authority_pin_sha256: issued.authority_pin_sha256,
            organization_id: issued.organization_id,
            principal_id: issued.principal_id,
            membership_id: issued.membership_id,
            enrollment_grant_base64url: Buffer.from(
              issued.enrollment_grant,
            ).toString('base64url'),
            issued_at: issued.issued_at,
            expires_at: issued.expires_at,
          };
          sendJson(response, 201, result);
          return;
        }

        if (method === 'POST' && url.pathname === '/v1/enrollments') {
          const grant = decodeEnrollmentGrant(request.headers.authorization);
          const body = validateCompleteOrganizationEnrollmentRequest(
            await readJsonBody(request),
          );
          const completed = await options.application.completeEnrollment({
            enrollment_grant: grant,
            enrollment_request: body.enrollment_request,
          });
          const result: CompletedOrganizationEnrollmentV1 = completed;
          sendJson(response, 201, result);
          return;
        }

        if (method === 'POST' && url.pathname === '/v1/access-leases') {
          const command = validateOrganizationAccessLeaseRequest(
            await readJsonBody(request),
          );
          const state = await options.application.issueAccessLease(command);
          const result: OrganizationAccessLeaseResponseV1 = {
            access_state: state,
          };
          sendJson(response, 200, result);
          return;
        }

        const membershipRevocationRoute = MEMBERSHIP_REVOCATION_ROUTE.exec(
          url.pathname,
        );
        if (method === 'POST' && membershipRevocationRoute !== null) {
          requireAdmin(request);
          const body = validateRevokeOrganizationSubjectRequest(
            await readJsonBody(request),
          );
          const revoked = await options.application.revokeMembership(
            membershipRevocationRoute[1]!,
            body.reason,
          );
          const result: RevokedOrganizationMembershipV1 = {
            membership: membershipResponse(revoked.membership),
            installations: revoked.installations,
          };
          sendJson(response, 200, result);
          return;
        }

        const installationRevocationRoute = INSTALLATION_REVOCATION_ROUTE.exec(
          url.pathname,
        );
        if (method === 'POST' && installationRevocationRoute !== null) {
          requireAdmin(request);
          const body = validateRevokeOrganizationSubjectRequest(
            await readJsonBody(request),
          );
          const state = await options.application.revokeInstallation(
            installationRevocationRoute[1]!,
            body.reason,
          );
          sendJson(response, 200, {
            installation_id: installationRevocationRoute[1]!,
            access_state: state,
          });
          return;
        }

        sendJson(response, 404, errorBody('not_found', 'route was not found'));
      } catch (error) {
        if (error instanceof TrustedProxyIdentityError) {
          sendJson(
            response,
            403,
            errorBody(
              'proxy_identity_unavailable',
              'trusted proxy identity is unavailable',
            ),
          );
          return;
        }
        if (error instanceof StaleAccessStateError) {
          sendJson(response, 409, { access_state: error.currentState });
          return;
        }
        if (error instanceof PayloadTooLargeError) {
          sendJson(
            response,
            413,
            errorBody('payload_too_large', 'request body is too large'),
          );
          return;
        }
        if (error instanceof RateLimitedError) {
          sendJson(
            response,
            429,
            errorBody('rate_limited', 'too many requests'),
            { 'Retry-After': String(error.retryAfterSeconds) },
          );
          return;
        }
        if (error instanceof AuthorityOperationError) {
          const status =
            error.code === 'invalid_request'
              ? 400
              : error.code === 'unauthorized'
                ? 401
                : error.code === 'not_found'
                  ? 404
                  : 409;
          const headers =
            status === 401 && authenticationChallenge !== undefined
              ? { 'WWW-Authenticate': authenticationChallenge }
              : undefined;
          sendJson(
            response,
            status,
            errorBody(
              error.code,
              status === 401 ? 'authorization failed' : error.message,
            ),
            headers,
          );
          return;
        }
        if (
          error instanceof Error &&
          error.message.startsWith('organization API:')
        ) {
          sendJson(
            response,
            400,
            errorBody('invalid_request', 'request body is invalid'),
          );
          return;
        }
        sendJson(
          response,
          500,
          errorBody('internal_error', 'authority operation failed'),
        );
      }
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
