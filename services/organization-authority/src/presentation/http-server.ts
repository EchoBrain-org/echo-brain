import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import {
  isOrganizationApiValidationError,
  MAX_ORGANIZATION_API_BODY_BYTES,
  ORGANIZATION_API_ACCESS_LEASES_PATH,
  ORGANIZATION_API_ADMIN_AUDIT_PATH,
  ORGANIZATION_API_ADMIN_INTERNAL_LIVE_RELEASES_PATH,
  ORGANIZATION_API_ADMIN_INTERNAL_LIVE_ROLLOUT_PATH,
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH,
  ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH,
  ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH,
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME,
  ORGANIZATION_API_ENROLLMENTS_PATH,
  ORGANIZATION_API_INTERNAL_LIVE_DIRECTIVES_PATH,
  ORGANIZATION_API_INTERNAL_LIVE_RECEIPTS_PATH,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
  ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
  MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
  validateCompleteOrganizationEnrollmentRequest,
  validateApproveOrganizationInternalLiveReleaseRequest,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateOrganizationAccessLeaseRequest,
  validateOrganizationInternalLiveDirectiveRequest,
  validateOrganizationInternalLiveUpdateReceipt,
  validateOrganizationPermissionCheckRequest,
  validateSubmitOrganizationRecordEnvelopeRequest,
  validateOrganizationSlackLinkBeginRequest,
  validateOrganizationSlackLinkCompleteRequest,
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
import { ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH } from '../application/slack-approval-activation.js';
export { ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH } from '../application/slack-approval-activation.js';
import {
  AuthorityOperationError,
  StaleAccessStateError,
} from '../domain/errors.js';
import { OrganizationRecordIngestRejectionError } from '../application/organization-record-ingest.js';
import {
  assertAuthorityRuntimeStatusNonce,
  AUTHORITY_RUNTIME_STATUS_NONCE_HEADER,
  AUTHORITY_RUNTIME_STATUS_PATH,
  type AuthorityRuntimeStatusV1,
} from '../domain/runtime-status.js';
import type { OrganizationAuthorityHttpApplication } from './organization-authority-http-application.js';
import type { OrganizationIntegrationsHttpApplication } from './organization-integrations-http-application.js';
import type { OrganizationRecordHttpApplication } from './organization-record-http-application.js';
import { handleAdminConsoleRequest } from './admin-console/routes.js';
import type { AdminConsoleSessionStore } from './admin-console/sessions.js';
import {
  TrustedProxyIdentityError,
  type RequestClientIdentityResolver,
} from './trusted-proxy-client-identity.js';

export interface AdminRequestAuthenticator {
  authenticate(authorizationHeader: string | undefined): boolean;
}

class PayloadTooLargeError extends Error {
  constructor(readonly code: string = 'payload_too_large') {
    super('request body is too large');
  }
}

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const GRANT_ROUTE = new RegExp(
  `^${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}/(mem_${UUID_V4_SOURCE})/enrollment-grants$`,
);
const MEMBERSHIP_REVOCATION_ROUTE = new RegExp(
  `^${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}/(mem_${UUID_V4_SOURCE})/revocations$`,
);
const INSTALLATION_REVOCATION_ROUTE = new RegExp(
  `^${ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH}/(ins_${UUID_V4_SOURCE})/revocations$`,
);
export const ORGANIZATION_API_ADMIN_INTEGRATIONS_PATH =
  '/v1/admin/integrations';
export const ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH =
  '/v1/admin/integrations/slack';

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

function sendNoContent(response: ServerResponse): void {
  response.writeHead(204, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
}

function errorBody(code: string, message: string): OrganizationApiErrorV1 {
  return { error: { code, message } };
}

/**
 * `maximumBytes` is a per-route exemption, never a global raise. Only the
 * organization-record ingest route passes anything other than the shared
 * `MAX_ORGANIZATION_API_BODY_BYTES`, because an approved brief with verbatim
 * evidence spans routinely exceeds 16 KiB. Every other route keeps the shared
 * limit, and the cap is applied to raw wire bytes before any JSON parsing.
 *
 * The record route's cap measures the *wrapped* request body, so it is the
 * 256 KiB canonical-envelope contract plus the exact
 * `{"record_envelope": ... }` wrapper — see
 * `MAX_ORGANIZATION_RECORD_API_BODY_BYTES`. An envelope over the canonical cap
 * is refused by the validator, which can name the failure; this limit only
 * stops a body too large to be worth parsing.
 */
async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number = MAX_ORGANIZATION_API_BODY_BYTES,
  oversizeCode = 'payload_too_large',
): Promise<unknown> {
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
    if (parsed > maximumBytes) {
      throw new PayloadTooLargeError(oversizeCode);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) {
      throw new PayloadTooLargeError(oversizeCode);
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

/**
 * DTO validation on the record route is a *terminal* outcome, not a generic
 * bad request. Envelope validation happens once, inside record ingest.
 *
 * Everywhere else, `invalid_request` is the right answer: the caller is a human
 * or an admin tool that can fix the body and try again. The record submitter
 * cannot. Its envelope is frozen and signed before the first send, so bytes
 * that fail validation will fail identically forever — and a member that reads
 * `invalid_request` keeps the frozen envelope and resends it on every cycle.
 * Naming the exact terminal code lets the member file its permanent-rejection
 * slot once and surface the node to an operator.
 *
 * Deliberately narrow: only the API package's own validation error is mapped.
 * An oversize body already threw `record_envelope_too_large` before this runs,
 * and everything the authority application raises later — an expired lease, a
 * transient fault — keeps its own retryable code.
 */
function validateRecordEnvelopeRequest(
  body: unknown,
): ReturnType<typeof validateSubmitOrganizationRecordEnvelopeRequest> {
  try {
    return validateSubmitOrganizationRecordEnvelopeRequest(body);
  } catch (error) {
    if (!isOrganizationApiValidationError(error)) throw error;
    throw new OrganizationRecordIngestRejectionError(
      'record_envelope_invalid',
      'record envelope failed request validation',
    );
  }
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
  const match = new RegExp(
    `^${ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME} ([A-Za-z0-9_-]{43})$`,
  ).exec(header ?? '');
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

function adminPageRequest(url: URL): { cursor?: string; limit?: number } {
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== 'cursor' && key !== 'limit') ||
    keys.filter((key) => key === 'cursor').length > 1 ||
    keys.filter((key) => key === 'limit').length > 1
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'admin page query is invalid',
    );
  }
  const cursor = url.searchParams.get('cursor');
  const rawLimit = url.searchParams.get('limit');
  if (
    cursor !== null &&
    (cursor.length === 0 ||
      cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor))
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'admin page cursor is invalid',
    );
  }
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
      throw new AuthorityOperationError(
        'invalid_request',
        'admin page limit is invalid',
      );
    }
    limit = Number(rawLimit);
    if (limit > 100) {
      throw new AuthorityOperationError(
        'invalid_request',
        'admin page limit is invalid',
      );
    }
  }
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export interface OrganizationAuthorityHttpServerOptions {
  application: OrganizationAuthorityHttpApplication;
  integrations?: OrganizationIntegrationsHttpApplication;
  /** Present only when the authority process hosts the organization record. */
  records?: OrganizationRecordHttpApplication;
  adminAuthenticator: AdminRequestAuthenticator;
  clientIdentityResolver: RequestClientIdentityResolver;
  adminConsole?: {
    sessions: AdminConsoleSessionStore;
  };
  runtimeStatus?: {
    respond(nonce: string): AuthorityRuntimeStatusV1;
  };
  rateLimiter?: PostRequestRateLimiter;
  permissionGlobalIngressRateLimiter?: PostRequestRateLimiter;
  permissionIngressRateLimiter?: PostRequestRateLimiter;
  permissionRateLimiter?: PostRequestRateLimiter;
}

function consumeRateLimit(
  rateLimiter: PostRequestRateLimiter,
  key: string,
): void {
  const result = rateLimiter.consume(key);
  if (!result.allowed) {
    throw new RateLimitedError(result.retry_after_seconds);
  }
}

interface OrganizationAuthorityHttpServerLifecycle {
  readonly shutdownController: AbortController;
  readonly drainWaiters: Set<() => void>;
  inFlightRequests: number;
  shuttingDown: boolean;
}

const authorityHttpServerLifecycles = new WeakMap<
  Server,
  OrganizationAuthorityHttpServerLifecycle
>();

function authorityHttpServerLifecycle(
  server: Server,
): OrganizationAuthorityHttpServerLifecycle {
  const lifecycle = authorityHttpServerLifecycles.get(server);
  if (lifecycle === undefined) {
    throw new Error(
      'organization authority HTTP server lifecycle is unavailable',
    );
  }
  return lifecycle;
}

export function beginOrganizationAuthorityHttpServerShutdown(
  server: Server,
): void {
  const lifecycle = authorityHttpServerLifecycle(server);
  if (lifecycle.shuttingDown) return;
  lifecycle.shuttingDown = true;
  lifecycle.shutdownController.abort(
    new Error('organization authority HTTP server is shutting down'),
  );
}

export async function drainOrganizationAuthorityHttpServer(
  server: Server,
): Promise<void> {
  const lifecycle = authorityHttpServerLifecycle(server);
  if (!lifecycle.shuttingDown) {
    throw new Error(
      'organization authority HTTP shutdown must begin before draining',
    );
  }
  if (lifecycle.inFlightRequests === 0) return;
  await new Promise<void>((resolve) => {
    lifecycle.drainWaiters.add(resolve);
  });
}

export function createOrganizationAuthorityHttpServer(
  options: OrganizationAuthorityHttpServerOptions,
): Server {
  const rateLimiter =
    options.rateLimiter ?? new InMemoryPostRequestRateLimiter();
  const permissionIngressRateLimiter =
    options.permissionIngressRateLimiter ??
    new InMemoryPostRequestRateLimiter({
      maximum_requests_per_window: 600,
      window_ms: 60_000,
      maximum_keys: 4096,
    });
  const permissionGlobalIngressRateLimiter =
    options.permissionGlobalIngressRateLimiter ??
    new InMemoryPostRequestRateLimiter({
      maximum_requests_per_window: 6000,
      window_ms: 60_000,
      maximum_keys: 1,
    });
  const permissionRateLimiter =
    options.permissionRateLimiter ?? new InMemoryPostRequestRateLimiter();
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
  const requireIntegrations = (): OrganizationIntegrationsHttpApplication => {
    if (options.integrations === undefined) {
      throw new AuthorityOperationError(
        'not_found',
        'organization integrations are unavailable',
      );
    }
    return options.integrations;
  };
  const requireRecords = (): OrganizationRecordHttpApplication => {
    if (options.records === undefined) {
      throw new AuthorityOperationError(
        'not_found',
        'organization record ingest is unavailable',
      );
    }
    return options.records;
  };
  const lifecycle: OrganizationAuthorityHttpServerLifecycle = {
    shutdownController: new AbortController(),
    drainWaiters: new Set(),
    inFlightRequests: 0,
    shuttingDown: false,
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let authenticationChallenge:
      | typeof ORGANIZATION_API_ADMIN_AUTH_SCHEME
      | typeof ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME
      | undefined;
    try {
      if (lifecycle.shuttingDown) {
        throw new AuthorityOperationError(
          'unavailable',
          'organization authority is shutting down',
        );
      }
      const method = request.method ?? '';
      const url = new URL(request.url ?? '/', 'http://authority.invalid');
      if (
        method === 'GET' &&
        url.pathname === AUTHORITY_RUNTIME_STATUS_PATH
      ) {
        if (url.search !== '' || options.runtimeStatus === undefined) {
          throw new AuthorityOperationError(
            'invalid_request',
            'runtime status request is invalid',
          );
        }
        const nonce = request.headers[AUTHORITY_RUNTIME_STATUS_NONCE_HEADER];
        if (typeof nonce !== 'string') {
          throw new AuthorityOperationError(
            'invalid_request',
            'runtime status nonce is unavailable',
          );
        }
        try {
          assertAuthorityRuntimeStatusNonce(nonce);
        } catch {
          throw new AuthorityOperationError(
            'invalid_request',
            'runtime status nonce is invalid',
          );
        }
        sendJson(response, 200, options.runtimeStatus.respond(nonce));
        return;
      }
      const clientIdentity = options.clientIdentityResolver.resolve(request);
      authenticationChallenge = url.pathname.startsWith('/v1/admin/')
        ? ORGANIZATION_API_ADMIN_AUTH_SCHEME
        : method === 'POST' &&
            url.pathname === ORGANIZATION_API_ENROLLMENTS_PATH
          ? ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME
          : undefined;
      if (method === 'POST') {
        if (url.pathname === ORGANIZATION_API_PERMISSION_CHECKS_PATH) {
          consumeRateLimit(
            permissionGlobalIngressRateLimiter,
            'permission-ingress-global',
          );
          const permissionIngressKey =
            options.clientIdentityResolver.permissionIngressKey?.(
              request,
              clientIdentity,
            ) ?? clientIdentity;
          consumeRateLimit(
            permissionIngressRateLimiter,
            `${permissionIngressKey}:permission-ingress`,
          );
        } else {
          const routeClass =
            url.pathname === '/admin' || url.pathname.startsWith('/admin/')
              ? 'admin-console'
              : url.pathname.startsWith('/v1/admin/')
                ? 'admin'
                : url.pathname === ORGANIZATION_API_ENROLLMENTS_PATH
                  ? 'enrollment'
                  : url.pathname === ORGANIZATION_API_ACCESS_LEASES_PATH
                    ? 'access'
                    : url.pathname === ORGANIZATION_API_RECORD_ENVELOPES_PATH
                      ? 'record'
                      : 'other';
          consumeRateLimit(rateLimiter, `${clientIdentity}:${routeClass}`);
        }
      }

      if (
        options.adminConsole !== undefined &&
        (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
      ) {
        await handleAdminConsoleRequest({
          application: options.application,
          integrations: options.integrations,
          sessions: options.adminConsole.sessions,
          authenticateCredential: (credential) =>
            options.adminAuthenticator.authenticate(
              `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${credential}`,
            ),
          clientIdentity,
          request,
          response,
          url,
          signal: lifecycle.shutdownController.signal,
        });
        return;
      }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH
        ) {
          if (url.search !== '') {
            throw new AuthorityOperationError(
              'invalid_request',
              'query parameters are not supported',
            );
          }
          sendJson(response, 200, {
            authority_descriptor: options.application.descriptor(),
          });
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_OVERVIEW_PATH
        ) {
          requireAdmin(request);
          if (url.search !== '') {
            throw new AuthorityOperationError(
              'invalid_request',
              'overview query parameters are not supported',
            );
          }
          sendJson(response, 200, options.application.adminOverview());
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            200,
            options.application.listMemberships(adminPageRequest(url)),
          );
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            200,
            options.application.listInstallations(adminPageRequest(url)),
          );
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            200,
            options.application.listEnrollmentGrants(adminPageRequest(url)),
          );
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_AUDIT_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            200,
            options.application.listAudit(adminPageRequest(url)),
          );
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_INTERNAL_LIVE_ROLLOUT_PATH
        ) {
          requireAdmin(request);
          if (url.search !== '') {
            throw new AuthorityOperationError(
              'invalid_request',
              'internal-live rollout query parameters are not supported',
            );
          }
          sendJson(
            response,
            200,
            options.application.internalLiveRolloutStatus(),
          );
          return;
        }

        if (
          method === 'GET' &&
          url.pathname === ORGANIZATION_API_ADMIN_INTEGRATIONS_PATH
        ) {
          requireAdmin(request);
          if (url.search !== '') {
            throw new AuthorityOperationError(
              'not_found',
              'organization integrations are unavailable',
            );
          }
          sendJson(response, 200, requireIntegrations().overview());
          return;
        }

        if (url.search !== '') {
          throw new AuthorityOperationError(
            'invalid_request',
            'query parameters are not supported',
          );
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH
        ) {
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
            body,
          );
          const result: IssuedOrganizationEnrollmentGrantV1 = {
            authority_id: issued.authority_id,
            authority_pin_sha256: issued.authority_pin_sha256,
            organization_id: issued.organization_id,
            principal_id: issued.principal_id,
            membership_id: issued.membership_id,
            enrollment_grant_sha256: issued.enrollment_grant_sha256,
            issued_at: issued.issued_at,
            expires_at: issued.expires_at,
          };
          sendJson(response, 201, result);
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_ENROLLMENTS_PATH
        ) {
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

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_ACCESS_LEASES_PATH
        ) {
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

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_RECORD_ENVELOPES_PATH
        ) {
          const records = requireRecords();
          // The one route with a raised raw-body cap. The shared
          // MAX_ORGANIZATION_API_BODY_BYTES stays in force everywhere else.
          const body = await readJsonBody(
            request,
            MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
            'record_envelope_too_large',
          );
          const command = validateRecordEnvelopeRequest(body);
          sendJson(response, 200, await records.submitRecordEnvelope(command));
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_INTERNAL_LIVE_DIRECTIVES_PATH
        ) {
          const command = validateOrganizationInternalLiveDirectiveRequest(
            await readJsonBody(request),
          );
          sendJson(
            response,
            200,
            options.application.fetchInternalLiveDirective(command),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_INTERNAL_LIVE_RECEIPTS_PATH
        ) {
          const receipt = validateOrganizationInternalLiveUpdateReceipt(
            await readJsonBody(request),
          );
          options.application.recordInternalLiveUpdateReceipt(receipt);
          sendNoContent(response);
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_PERMISSION_CHECKS_PATH
        ) {
          const integrations = requireIntegrations();
          const command = validateOrganizationPermissionCheckRequest(
            await readJsonBody(request),
          );
          const authenticated =
            options.application.checkPermissionSubject(command, null);
          consumeRateLimit(
            permissionRateLimiter,
            `installation:${authenticated.installation_id}`,
          );
          sendJson(
            response,
            200,
            await integrations.checkPermission(
              command,
              lifecycle.shutdownController.signal,
            ),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH
        ) {
          const command = validateOrganizationSlackLinkBeginRequest(
            await readJsonBody(request),
          );
          sendJson(
            response,
            201,
            await requireIntegrations().beginSlackIdentityLink(
              command,
              lifecycle.shutdownController.signal,
            ),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH
        ) {
          const command = validateOrganizationSlackLinkCompleteRequest(
            await readJsonBody(request),
          );
          sendJson(
            response,
            200,
            await requireIntegrations().completeSlackIdentityLink(
              command,
              lifecycle.shutdownController.signal,
            ),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_ADMIN_SLACK_INTEGRATION_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            201,
            await requireIntegrations().onboardSlackOrganizationTool(
              await readJsonBody(request),
              lifecycle.shutdownController.signal,
            ),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname === ORGANIZATION_API_ADMIN_INTERNAL_LIVE_RELEASES_PATH
        ) {
          requireAdmin(request);
          const command = validateApproveOrganizationInternalLiveReleaseRequest(
            await readJsonBody(request),
          );
          sendJson(
            response,
            201,
            options.application.approveInternalLiveRelease(command),
          );
          return;
        }

        if (
          method === 'POST' &&
          url.pathname ===
            ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH
        ) {
          requireAdmin(request);
          sendJson(
            response,
            201,
            requireIntegrations().activateSlackApproval(
              await readJsonBody(request),
            ),
          );
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
        if (error instanceof OrganizationRecordIngestRejectionError) {
          // Terminal for the member. The code is the contract; the message
          // never carries anything the submitter did not already send.
          sendJson(
            response,
            error.code === 'record_idempotency_conflict' ? 409 : 400,
            errorBody(error.code, error.message),
          );
          return;
        }
        if (error instanceof PayloadTooLargeError) {
          sendJson(
            response,
            413,
            errorBody(error.code, 'request body is too large'),
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
                  : error.code === 'unavailable'
                    ? 503
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
        if (isOrganizationApiValidationError(error)) {
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
  };
  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      lifecycle.inFlightRequests += 1;
      void handleRequest(request, response)
        .finally(() => {
          lifecycle.inFlightRequests -= 1;
          if (lifecycle.inFlightRequests === 0) {
            for (const resolve of lifecycle.drainWaiters) resolve();
            lifecycle.drainWaiters.clear();
          }
        })
        .catch(() => {
          response.destroy();
        });
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  authorityHttpServerLifecycles.set(server, lifecycle);
  return server;
}
