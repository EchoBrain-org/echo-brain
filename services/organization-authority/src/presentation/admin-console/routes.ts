import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateProvisionOrganizationMembershipRequest,
  validateRevokeOrganizationSubjectRequest,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '../../domain/errors.js';
import type { OrganizationAuthorityHttpApplication } from '../organization-authority-http-application.js';
import {
  ADMIN_CONSOLE_CSS,
  ADMIN_CONSOLE_JAVASCRIPT,
  ADMIN_CONSOLE_SCRIPT_PATH,
  ADMIN_CONSOLE_STYLESHEET_PATH,
} from './assets.js';
import type { AdminConsoleSessionStore } from './sessions.js';
import {
  renderAdminConsoleDashboard,
  renderAdminConsoleError,
  renderAdminConsoleLogin,
} from './views.js';

const ADMIN_SESSION_COOKIE = 'echo_admin_session';
const ADMIN_CSRF_COOKIE = 'echo_admin_csrf';
const ADMIN_PAGE_LIMIT = 25;
const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INVITATION_ROUTE = new RegExp(
  `^/admin/memberships/(mem_${UUID_V4_SOURCE})/enrollment-grants$`,
);
const MEMBERSHIP_REVOCATION_ROUTE = new RegExp(
  `^/admin/memberships/(mem_${UUID_V4_SOURCE})/revocations$`,
);
const INSTALLATION_REVOCATION_ROUTE = new RegExp(
  `^/admin/installations/(ins_${UUID_V4_SOURCE})/revocations$`,
);

const ADMIN_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; manifest-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

type HeaderValue = string | string[];
type ResponseHeaders = Record<string, HeaderValue>;
type BodyRecord = Record<string, unknown>;

interface ParsedBody {
  readonly kind: 'form' | 'json';
  readonly value: BodyRecord;
}

class AdminConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: ResponseHeaders = {},
  ) {
    super(message);
    this.name = 'AdminConsoleHttpError';
  }
}

export interface HandleAdminConsoleRequestOptions {
  readonly application: OrganizationAuthorityHttpApplication;
  readonly sessions: AdminConsoleSessionStore;
  readonly authenticateCredential: (
    rawToken: string,
  ) => boolean | Promise<boolean>;
  readonly clientIdentity: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
}

function responseHeaders(
  contentType: string,
  contentLength: number,
  extra: ResponseHeaders = {},
): ResponseHeaders {
  return {
    ...ADMIN_SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    ...extra,
  };
}

function writeBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  bytes: Buffer,
  extra: ResponseHeaders = {},
): void {
  response.writeHead(status, responseHeaders(contentType, bytes.length, extra));
  response.end(bytes);
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  extra: ResponseHeaders = {},
): void {
  writeBytes(
    response,
    status,
    'text/html; charset=utf-8',
    Buffer.from(html, 'utf8'),
    extra,
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extra: ResponseHeaders = {},
): void {
  writeBytes(
    response,
    status,
    'application/json; charset=utf-8',
    Buffer.from(JSON.stringify(value), 'utf8'),
    extra,
  );
}

function sendRedirect(
  response: ServerResponse,
  location: '/admin' | '/admin/login',
  extra: ResponseHeaders = {},
): void {
  response.writeHead(
    303,
    responseHeaders('text/plain; charset=utf-8', 0, {
      Location: location,
      ...extra,
    }),
  );
  response.end();
}

function sessionCookie(value: string): string {
  return `${ADMIN_SESSION_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/admin`;
}

function csrfCookie(value: string): string {
  return `${ADMIN_CSRF_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/admin`;
}

function clearedCookies(): string[] {
  const suffix =
    'Secure; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return [
    `${ADMIN_SESSION_COOKIE}=; ${suffix}`,
    `${ADMIN_CSRF_COOKIE}=; ${suffix}`,
  ];
}

function cookieValue(
  header: string | undefined,
  requestedName: string,
): string | undefined {
  if (header === undefined) return undefined;
  let found = false;
  let result: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== requestedName) continue;
    if (found) return undefined;
    found = true;
    result = part.slice(separator + 1).trim();
  }
  return result;
}

function requireSessionCookie(
  options: HandleAdminConsoleRequestOptions,
): string {
  const sessionCookieValue = cookieValue(
    options.request.headers.cookie,
    ADMIN_SESSION_COOKIE,
  );
  if (
    sessionCookieValue === undefined ||
    options.sessions.verify({
      kind: 'session',
      client_id: options.clientIdentity,
      session_cookie_value: sessionCookieValue,
    }) === null
  ) {
    throw new AdminConsoleHttpError(
      401,
      'unauthorized',
      'Your administrator session is unavailable or expired.',
    );
  }
  return sessionCookieValue;
}

function dashboardCsrfToken(
  options: HandleAdminConsoleRequestOptions,
  sessionCookieValue: string,
): string {
  const token = cookieValue(options.request.headers.cookie, ADMIN_CSRF_COOKIE);
  if (
    token === undefined ||
    options.sessions.verify({
      kind: 'mutation',
      client_id: options.clientIdentity,
      session_cookie_value: sessionCookieValue,
      csrf_token: token,
    }) === null
  ) {
    throw new AdminConsoleHttpError(
      401,
      'unauthorized',
      'Your administrator session is unavailable or expired.',
    );
  }
  return token;
}

function sameOrigin(request: IncomingMessage): boolean {
  const rawOrigin = request.headers.origin;
  const rawHost = request.headers.host;
  if (
    typeof rawOrigin !== 'string' ||
    typeof rawHost !== 'string' ||
    rawOrigin.trim() !== rawOrigin ||
    rawHost.trim() !== rawHost ||
    rawHost.length === 0 ||
    /[\s\/@?#]/.test(rawHost)
  ) {
    return false;
  }
  try {
    const origin = new URL(rawOrigin);
    const expected = new URL(`https://${rawHost}`);
    return (
      origin.protocol === 'https:' &&
      origin.username === '' &&
      origin.password === '' &&
      origin.pathname === '/' &&
      origin.search === '' &&
      origin.hash === '' &&
      expected.username === '' &&
      expected.password === '' &&
      expected.pathname === '/' &&
      expected.search === '' &&
      expected.hash === '' &&
      origin.origin === expected.origin
    );
  } catch {
    return false;
  }
}

function requireSameOrigin(request: IncomingMessage): void {
  if (!sameOrigin(request)) {
    throw new AdminConsoleHttpError(
      403,
      'forbidden',
      'The request origin did not match this organization authority.',
    );
  }
}

function contentLength(request: IncomingMessage): number | undefined {
  const declared = request.headers['content-length'];
  if (declared === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The request Content-Length was invalid.',
    );
  }
  const parsed = Number(declared);
  if (!Number.isSafeInteger(parsed)) {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The request Content-Length was invalid.',
    );
  }
  if (parsed > MAX_ORGANIZATION_API_BODY_BYTES) {
    throw new AdminConsoleHttpError(
      413,
      'payload_too_large',
      'The request body was too large.',
    );
  }
  return parsed;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The form body was invalid.',
    );
  }
}

function parseForm(text: string): BodyRecord {
  const result = Object.create(null) as BodyRecord;
  const fields = text.split('&');
  if (fields.length > 16) {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The form contained too many fields.',
    );
  }
  for (const field of fields) {
    const separator = field.indexOf('=');
    const name = decodeFormComponent(
      separator === -1 ? field : field.slice(0, separator),
    );
    const value = decodeFormComponent(
      separator === -1 ? '' : field.slice(separator + 1),
    );
    if (name.length === 0 || Object.hasOwn(result, name)) {
      throw new AdminConsoleHttpError(
        400,
        'invalid_request',
        'The form body was invalid.',
      );
    }
    result[name] = value;
  }
  return result;
}

function plainBodyRecord(value: unknown): BodyRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The JSON body must be an object.',
    );
  }
  return value as BodyRecord;
}

async function readBody(request: IncomingMessage): Promise<ParsedBody> {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') {
    throw new AdminConsoleHttpError(
      415,
      'unsupported_media_type',
      'Content-Type must be UTF-8 form data or JSON.',
    );
  }
  const match =
    /^(application\/json|application\/x-www-form-urlencoded)(?:\s*;\s*charset=utf-8)?$/i.exec(
      type,
    );
  if (match === null || request.headers['content-encoding'] !== undefined) {
    throw new AdminConsoleHttpError(
      415,
      'unsupported_media_type',
      'Content-Type must be UTF-8 form data or JSON.',
    );
  }
  const declaredLength = contentLength(request);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new AdminConsoleHttpError(
        413,
        'payload_too_large',
        'The request body was too large.',
      );
    }
    chunks.push(bytes);
  }
  if (
    total === 0 ||
    (declaredLength !== undefined && total !== declaredLength)
  ) {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The request body was empty or incomplete.',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The request body was not valid UTF-8.',
    );
  }
  if (match[1]!.toLowerCase() === 'application/x-www-form-urlencoded') {
    return { kind: 'form', value: parseForm(text) };
  }
  try {
    return { kind: 'json', value: plainBodyRecord(JSON.parse(text)) };
  } catch (error) {
    if (error instanceof AdminConsoleHttpError) throw error;
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The request body was not valid JSON.',
    );
  }
}

function withoutCsrf(body: BodyRecord): BodyRecord {
  const result = Object.create(null) as BodyRecord;
  for (const [key, value] of Object.entries(body)) {
    if (key !== '_csrf') result[key] = value;
  }
  return result;
}

function presentedCsrf(request: IncomingMessage, body: BodyRecord): string {
  const header = request.headers['x-echo-admin-csrf'];
  const field = body._csrf;
  if (
    (header !== undefined && typeof header !== 'string') ||
    (field !== undefined && typeof field !== 'string') ||
    (typeof header === 'string' &&
      typeof field === 'string' &&
      header !== field)
  ) {
    throw new AdminConsoleHttpError(
      403,
      'forbidden',
      'The administrator CSRF proof was invalid.',
    );
  }
  return typeof header === 'string'
    ? header
    : typeof field === 'string'
      ? field
      : '';
}

function authorizeMutation(
  options: HandleAdminConsoleRequestOptions,
  sessionCookieValue: string,
  body: BodyRecord,
): string {
  const csrfToken = presentedCsrf(options.request, body);
  if (
    options.sessions.verify({
      kind: 'mutation',
      client_id: options.clientIdentity,
      session_cookie_value: sessionCookieValue,
      csrf_token: csrfToken,
    }) === null
  ) {
    throw new AdminConsoleHttpError(
      403,
      'forbidden',
      'The administrator CSRF proof was invalid.',
    );
  }
  return csrfToken;
}

function requireNoQuery(url: URL): void {
  if (url.search !== '' || url.hash !== '') {
    throw new AdminConsoleHttpError(
      400,
      'invalid_request',
      'Query parameters are not supported by the administrator console.',
    );
  }
}

function methodNotAllowed(allow: string): never {
  throw new AdminConsoleHttpError(
    405,
    'method_not_allowed',
    'The request method is not supported for this route.',
    { Allow: allow },
  );
}

function validationPayload(body: ParsedBody): BodyRecord {
  const payload = withoutCsrf(body.value);
  if (
    body.kind === 'form' &&
    Object.hasOwn(payload, 'lifetime_seconds') &&
    typeof payload.lifetime_seconds === 'string' &&
    /^[1-9][0-9]{0,6}$/.test(payload.lifetime_seconds)
  ) {
    payload.lifetime_seconds = Number(payload.lifetime_seconds);
  }
  return payload;
}

function mappedError(error: unknown): AdminConsoleHttpError {
  if (error instanceof AdminConsoleHttpError) return error;
  if (error instanceof AuthorityOperationError) {
    const status =
      error.code === 'invalid_request'
        ? 400
        : error.code === 'unauthorized'
          ? 401
          : error.code === 'not_found'
            ? 404
            : 409;
    return new AdminConsoleHttpError(
      status,
      error.code,
      status === 401 ? 'Authorization failed.' : error.message,
    );
  }
  if (error instanceof Error && error.message.startsWith('organization API:')) {
    return new AdminConsoleHttpError(
      400,
      'invalid_request',
      'The submitted administrator command was invalid.',
    );
  }
  return new AdminConsoleHttpError(
    500,
    'internal_error',
    'The organization authority operation failed.',
  );
}

function sendRouteError(
  options: HandleAdminConsoleRequestOptions,
  error: AdminConsoleHttpError,
  jsonResponse: boolean,
): void {
  const clear =
    error.status === 401 ? { 'Set-Cookie': clearedCookies() } : undefined;
  const headers = { ...error.headers, ...clear };
  if (jsonResponse) {
    sendJson(
      options.response,
      error.status,
      { error: { code: error.code, message: error.message } },
      headers,
    );
    return;
  }
  sendHtml(
    options.response,
    error.status,
    renderAdminConsoleError('Administrator console error', error.message),
    headers,
  );
}

function bounded<T extends { readonly items: readonly unknown[] }>(page: T): T {
  return { ...page, items: page.items.slice(0, ADMIN_PAGE_LIMIT) } as T;
}

/**
 * Handles the browser administrator console namespace. Returns false without
 * touching the response when the supplied URL is outside `/admin`.
 */
export async function handleAdminConsoleRequest(
  options: HandleAdminConsoleRequestOptions,
): Promise<boolean> {
  const { pathname } = options.url;
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return false;

  const method = options.request.method ?? '';
  const invitationMatch = INVITATION_ROUTE.exec(pathname);
  const jsonResponse = method === 'POST' && invitationMatch !== null;

  try {
    requireNoQuery(options.url);

    if (
      pathname === ADMIN_CONSOLE_STYLESHEET_PATH ||
      pathname === ADMIN_CONSOLE_SCRIPT_PATH
    ) {
      if (method !== 'GET') methodNotAllowed('GET');
      const javascript = pathname === ADMIN_CONSOLE_SCRIPT_PATH;
      const source = javascript ? ADMIN_CONSOLE_JAVASCRIPT : ADMIN_CONSOLE_CSS;
      writeBytes(
        options.response,
        200,
        javascript
          ? 'text/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
        Buffer.from(source, 'utf8'),
      );
      return true;
    }

    if (pathname === '/admin/login') {
      if (method !== 'GET' && method !== 'POST') methodNotAllowed('GET, POST');
      if (method === 'GET') {
        try {
          const sessionCookieValue = requireSessionCookie(options);
          dashboardCsrfToken(options, sessionCookieValue);
          sendRedirect(options.response, '/admin');
        } catch (error) {
          if (
            !(error instanceof AdminConsoleHttpError) ||
            error.status !== 401
          ) {
            throw error;
          }
          sendHtml(options.response, 200, renderAdminConsoleLogin(), {
            'Set-Cookie': clearedCookies(),
          });
        }
        return true;
      }

      requireSameOrigin(options.request);
      const body = await readBody(options.request);
      const keys = Object.keys(body.value);
      const credential = body.value.credential;
      if (
        keys.length !== 1 ||
        keys[0] !== 'credential' ||
        typeof credential !== 'string' ||
        credential.length === 0 ||
        Buffer.byteLength(credential, 'utf8') > 4096
      ) {
        throw new AdminConsoleHttpError(
          400,
          'invalid_request',
          'The login request was invalid.',
        );
      }
      if ((await options.authenticateCredential(credential)) !== true) {
        sendHtml(
          options.response,
          401,
          renderAdminConsoleLogin(
            'The administrator credential was not accepted.',
          ),
          { 'Set-Cookie': clearedCookies() },
        );
        return true;
      }
      const created = options.sessions.create(options.clientIdentity);
      sendRedirect(options.response, '/admin', {
        'Set-Cookie': [
          sessionCookie(created.session_cookie_value),
          csrfCookie(created.csrf_token),
        ],
      });
      return true;
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      if (method !== 'GET') methodNotAllowed('GET');
      let sessionCookieValue: string;
      let csrfToken: string;
      try {
        sessionCookieValue = requireSessionCookie(options);
        csrfToken = dashboardCsrfToken(options, sessionCookieValue);
      } catch (error) {
        if (!(error instanceof AdminConsoleHttpError) || error.status !== 401) {
          throw error;
        }
        sendRedirect(options.response, '/admin/login', {
          'Set-Cookie': clearedCookies(),
        });
        return true;
      }
      sendHtml(
        options.response,
        200,
        renderAdminConsoleDashboard({
          overview: options.application.adminOverview(),
          memberships: bounded(
            options.application.listMemberships({ limit: ADMIN_PAGE_LIMIT }),
          ),
          installations: bounded(
            options.application.listInstallations({ limit: ADMIN_PAGE_LIMIT }),
          ),
          enrollment_grants: bounded(
            options.application.listEnrollmentGrants({
              limit: ADMIN_PAGE_LIMIT,
            }),
          ),
          audit: bounded(
            options.application.listAudit({ limit: ADMIN_PAGE_LIMIT }),
          ),
          csrf_token: csrfToken,
        }),
      );
      return true;
    }

    if (method === 'POST') requireSameOrigin(options.request);

    if (pathname === '/admin/logout') {
      if (method !== 'POST') methodNotAllowed('POST');
      const sessionCookieValue = requireSessionCookie(options);
      const body = await readBody(options.request);
      const csrfToken = authorizeMutation(
        options,
        sessionCookieValue,
        body.value,
      );
      if (Object.keys(withoutCsrf(body.value)).length !== 0) {
        throw new AdminConsoleHttpError(
          400,
          'invalid_request',
          'The logout request was invalid.',
        );
      }
      options.sessions.revoke({
        client_id: options.clientIdentity,
        session_cookie_value: sessionCookieValue,
        csrf_token: csrfToken,
      });
      sendRedirect(options.response, '/admin/login', {
        'Set-Cookie': clearedCookies(),
      });
      return true;
    }

    if (pathname === '/admin/memberships') {
      if (method !== 'POST') methodNotAllowed('POST');
      const sessionCookieValue = requireSessionCookie(options);
      const body = await readBody(options.request);
      authorizeMutation(options, sessionCookieValue, body.value);
      const command = validateProvisionOrganizationMembershipRequest(
        validationPayload(body),
      );
      options.application.provisionMembership(command);
      sendRedirect(options.response, '/admin');
      return true;
    }

    if (invitationMatch !== null) {
      if (method !== 'POST') methodNotAllowed('POST');
      const sessionCookieValue = requireSessionCookie(options);
      const body = await readBody(options.request);
      authorizeMutation(options, sessionCookieValue, body.value);
      const command = validateIssueOrganizationEnrollmentGrantRequest(
        validationPayload(body),
      );
      const issued = options.application.issueEnrollmentGrant(
        invitationMatch[1]!,
        command,
      );
      sendJson(options.response, 201, {
        invitation: issued,
        authority_pin_delivery: 'separate_secure_channel_required',
      });
      return true;
    }

    const membershipRevocationMatch =
      MEMBERSHIP_REVOCATION_ROUTE.exec(pathname);
    if (membershipRevocationMatch !== null) {
      if (method !== 'POST') methodNotAllowed('POST');
      const sessionCookieValue = requireSessionCookie(options);
      const body = await readBody(options.request);
      authorizeMutation(options, sessionCookieValue, body.value);
      const command = validateRevokeOrganizationSubjectRequest(
        validationPayload(body),
      );
      await options.application.revokeMembership(
        membershipRevocationMatch[1]!,
        command.reason,
      );
      sendRedirect(options.response, '/admin');
      return true;
    }

    const installationRevocationMatch =
      INSTALLATION_REVOCATION_ROUTE.exec(pathname);
    if (installationRevocationMatch !== null) {
      if (method !== 'POST') methodNotAllowed('POST');
      const sessionCookieValue = requireSessionCookie(options);
      const body = await readBody(options.request);
      authorizeMutation(options, sessionCookieValue, body.value);
      const command = validateRevokeOrganizationSubjectRequest(
        validationPayload(body),
      );
      await options.application.revokeInstallation(
        installationRevocationMatch[1]!,
        command.reason,
      );
      sendRedirect(options.response, '/admin');
      return true;
    }

    throw new AdminConsoleHttpError(
      404,
      'not_found',
      'The administrator console route was not found.',
    );
  } catch (error) {
    sendRouteError(options, mappedError(error), jsonResponse);
    return true;
  }
}
