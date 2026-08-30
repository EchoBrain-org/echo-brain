import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonSessionRefreshRequest,
} from "@echo-brain/organization-api";
import { AuthorityOperationError } from "../domain/errors.js";
import {
  PERSON_SESSION_OIDC_BEGIN_PATH,
  PERSON_SESSION_OIDC_CALLBACK_PATH,
  PERSON_SESSION_REFRESH_PATH,
  PERSON_SESSION_REVOCATIONS_PATH,
} from "./person-identity-session-http-application.js";
import {
  PersonOidcIdentityNotBoundError,
  PersonOidcRetryableError,
  type PersonIdentitySessionApplication,
} from "../application/person-identity-sessions.js";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import type { PersonExternalIdentityLinkHttpApplicationV1 } from "./person-external-identity-link-http-application.js";
import {
  PERSON_RECORDS_PATH_V1,
  type PersonRecordReadHttpApplicationV1,
} from "./person-record-read-http-application.js";
import {
  PERSON_RECORD_SEARCH_PATH_V1,
  type PersonRecordSearchHttpApplicationV1,
} from "./person-record-search-http-application.js";
import {
  PERSON_EMPLOYEES_PATH_V1,
  type PersonEmployeeHttpApplication,
} from "./person-employee-http-application.js";
import {
  PERSON_ANSWER_PATH_V1,
  type PersonAnswerHttpApplicationV1,
} from "./person-answer-http-application.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "./private-approval-interaction-http-application-v1.js";

const MAXIMUM_BODY_BYTES = 64 * 1024;
const OIDC_BEGIN_CLIENT_WINDOW_MS = 60 * 1000;
const OIDC_BEGIN_CLIENT_LIMIT = 10;
const MAXIMUM_TRACKED_OIDC_BEGIN_CLIENTS = 1024;

/**
 * Provider ingress is selected at composition time, but it must never take
 * ownership of an Authority route. Keep this list beside the dispatch below:
 * a new built-in route has to be reserved before an adapter can be mounted.
 */
const ORGANIZATION_AUTHORITY_HTTP_ROUTES = new Set<string>([
  `GET ${ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH}`,
  `POST ${PERSON_SESSION_OIDC_BEGIN_PATH}`,
  `GET ${PERSON_SESSION_OIDC_CALLBACK_PATH}`,
  `POST ${PERSON_SESSION_REFRESH_PATH}`,
  `POST ${PERSON_SESSION_REVOCATIONS_PATH}`,
  `GET ${PERSON_EMPLOYEES_PATH_V1}`,
  `POST ${PERSON_EMPLOYEES_PATH_V1}`,
  `PUT ${PERSON_EMPLOYEES_PATH_V1}`,
  `DELETE ${PERSON_EMPLOYEES_PATH_V1}`,
  `GET ${PERSON_RECORDS_PATH_V1}`,
  `POST ${PERSON_RECORD_SEARCH_PATH_V1}`,
  `POST ${PERSON_ANSWER_PATH_V1}`,
]);

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}
export interface AuthorityOidcAuthorizationUrlProvider {
  buildAuthorizationUrl(
    input: ReturnType<PersonIdentitySessionApplication["beginOidcLogin"]>,
  ): string | Promise<string>;
}

export interface OrganizationAuthorityHttpServerOptions {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly sessions: PersonIdentitySessionApplication;
  readonly oidc_provider: AuthorityOidcAuthorizationUrlProvider;
  readonly expected_issuer: string;
  /** Optional: no connected external identity provider is required for login. */
  readonly person_external_identity_link?: PersonExternalIdentityLinkHttpApplicationV1;
  /** Optional only for focused identity-runtime tests. Organization Authority runtime wires it. */
  readonly person_record_read?: PersonRecordReadHttpApplicationV1;
  /** Optional only for focused identity-runtime tests. Organization Authority runtime wires it. */
  readonly person_record_search?: PersonRecordSearchHttpApplicationV1;
  /** Owner-only employee invite, reissue, and revoke. */
  readonly person_employees?: PersonEmployeeHttpApplication;
  /** Optional until the active Organization Authority runtime has a configured answer model. */
  readonly person_answer?: PersonAnswerHttpApplicationV1;
  /** Optional until an active private-approval surface is fully composed. */
  readonly private_approval_interaction_ingress?:
    PrivateApprovalInteractionHttpApplicationV1;
}

function validateProviderIngressRoutes(
  options: OrganizationAuthorityHttpServerOptions,
): void {
  const providerRoutes = [
    ...(options.private_approval_interaction_ingress === undefined
      ? []
      : [
          {
            method: options.private_approval_interaction_ingress.method,
            path: options.private_approval_interaction_ingress.path,
          },
        ]),
    ...(options.person_external_identity_link?.routes ?? []),
  ];
  const seen = new Set<string>();
  for (const route of providerRoutes) {
    const key = routeKey(route.method, route.path);
    if (ORGANIZATION_AUTHORITY_HTTP_ROUTES.has(key)) {
      throw new Error(`provider ingress route collides with Authority route: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`provider ingress route is configured more than once: ${key}`);
    }
    seen.add(key);
  }
}

interface PendingLoopbackHandoff {
  readonly url: string;
  readonly token: string;
  readonly expires_at: string;
}

interface OidcBeginClientWindow {
  readonly started_at: number;
  readonly count: number;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function oidcBeginClient(request: IncomingMessage): string {
  const peer = request.socket.remoteAddress;
  const forwarded = request.headers["x-echo-client-ip"];
  // Authority accepts its public traffic only from the local Caddy proxy.
  // Caddy writes this dedicated header as one IP, so never trust it from a
  // non-loopback peer or accept a multi-hop value.
  if (
    isLoopbackAddress(peer) &&
    typeof forwarded === "string" &&
    !forwarded.includes(",") &&
    isIP(forwarded) !== 0
  ) {
    return forwarded;
  }
  return peer ?? "unknown";
}

function admitOidcBeginClient(
  windows: Map<string, OidcBeginClientWindow>,
  client: string,
  now: number,
): boolean {
  for (const [candidate, window] of windows) {
    if (now - window.started_at >= OIDC_BEGIN_CLIENT_WINDOW_MS)
      windows.delete(candidate);
  }
  const current = windows.get(client);
  if (current === undefined) {
    if (windows.size >= MAXIMUM_TRACKED_OIDC_BEGIN_CLIENTS) return false;
    windows.set(client, { started_at: now, count: 1 });
    return true;
  }
  if (current.count >= OIDC_BEGIN_CLIENT_LIMIT) return false;
  windows.set(client, { started_at: current.started_at, count: current.count + 1 });
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function noContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function ok(response: ServerResponse): void {
  response.writeHead(200, {
    "content-length": "0",
    "cache-control": "no-store",
  });
  response.end();
}

/**
 * The credential stays out of the callback URL and browser history. The only
 * receiver is the exact, sealed localhost target created by this CLI run.
 */
function loopbackHandoffPage(input: {
  url: string;
  token: string;
  session: unknown;
}): Buffer {
  const session = Buffer.from(JSON.stringify(input.session), "utf8").toString(
    "base64url",
  );
  return Buffer.from(
    `<!doctype html><meta charset="utf-8"><title>Echo sign-in complete</title><p>Completing sign-in…</p><form id="handoff" method="post" action="${input.url}"><input type="hidden" name="token" value="${input.token}"><input type="hidden" name="session" value="${session}"></form><script>document.getElementById("handoff").submit()</script>`,
    "utf8",
  );
}

function handoffHtml(response: ServerResponse, value: {
  url: string;
  token: string;
  session: unknown;
}): void {
  const page = loopbackHandoffPage(value);
  const receiverOrigin = new URL(value.url).origin;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(page.byteLength),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; base-uri 'none'; form-action ${receiverOrigin}; script-src 'unsafe-inline'`,
  });
  response.end(page);
}

function handoffErrorHtml(
  response: ServerResponse,
  value: {
    url: string;
    token: string;
    code: "identity_not_bound" | "retryable";
  },
): void {
  const receiverOrigin = new URL(value.url).origin;
  const page = Buffer.from(
    `<!doctype html><meta charset="utf-8"><title>Echo sign-in</title><p>Completing sign-in…</p><form id="handoff" method="post" action="${value.url}"><input type="hidden" name="token" value="${value.token}"><input type="hidden" name="error" value="${value.code}"></form><script>document.getElementById("handoff").submit()</script>`,
    "utf8",
  );
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(page.byteLength),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; base-uri 'none'; form-action ${receiverOrigin}; script-src 'unsafe-inline'`,
  });
  response.end(page);
}

function expiredHandoffHtml(response: ServerResponse): void {
  const page = Buffer.from(
    "<!doctype html><meta charset=\"utf-8\"><title>Echo sign-in expired</title><p>Sign-in expired. Return to your terminal and rerun <code>echo-brain person login</code>.</p>",
    "utf8",
  );
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(page.byteLength),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; base-uri 'none'",
  });
  response.end(page);
}

function fail(response: ServerResponse, status: number, code: string): void {
  json(response, status, { error: { code, message: "request failed" } });
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAXIMUM_BODY_BYTES)
      throw new AuthorityOperationError(
        "invalid_request",
        "request body is too large",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function singletonHeaders(
  headers: IncomingMessage["headers"],
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
  }
  return Object.freeze(result);
}

async function body(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await rawBody(request)).toString("utf8")) as unknown;
  } catch {
    throw new AuthorityOperationError(
      "invalid_request",
      "request body is invalid",
    );
  }
}

function accessToken(value: string | undefined): string {
  if (value === undefined || !value.startsWith("Bearer ")) {
    throw new AuthorityOperationError(
      "unauthorized",
      "person authentication failed",
    );
  }
  return value.slice("Bearer ".length);
}

function recordLimit(url: URL): number | undefined {
  const values = [...url.searchParams.entries()];
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0]?.[0] !== "limit") {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  const raw = values[0][1];
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return limit;
}

function recordSearchInput(value: unknown): {
  readonly query: string;
  readonly limit?: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const queryTerms =
    typeof record.query === "string"
      ? new Set(
          (record.query.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
            term.toLowerCase().normalize("NFC"),
          ),
        )
      : new Set<string>();
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.includes("query") ||
    keys.some((key) => key !== "query" && key !== "limit") ||
    typeof record.query !== "string" ||
    record.query.length === 0 ||
    record.query !== record.query.normalize("NFC") ||
    record.query.trim() !== record.query ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(record.query) ||
    [...record.query].length > 240 ||
    queryTerms.size < 1 ||
    queryTerms.size > 16 ||
    [...queryTerms].some((term) => Buffer.byteLength(term, "utf8") > 64) ||
    (record.limit !== undefined &&
      (!Number.isSafeInteger(record.limit) ||
        (record.limit as number) < 1 ||
        (record.limit as number) > 10))
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return Object.freeze({
    query: record.query,
    ...(record.limit === undefined
      ? {}
      : { limit: record.limit as number }),
  });
}

function answerInput(value: unknown): { readonly question: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  const record = value as Record<string, unknown>;
  const question = record.question;
  const terms =
    typeof question === "string"
      ? new Set(
          (question.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
            term.toLowerCase().normalize("NFC"),
          ),
        )
      : new Set<string>();
  if (
    Object.keys(record).length !== 1 ||
    typeof question !== "string" ||
    question.length === 0 ||
    question !== question.normalize("NFC") ||
    question.trim() !== question ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(question) ||
    [...question].length > 240 ||
    terms.size < 1 ||
    terms.size > 16 ||
    [...terms].some((term) => Buffer.byteLength(term, "utf8") > 64)
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return Object.freeze({ question });
}

/** The Organization Authority Person API surface, with no machine routes. */
export function createOrganizationAuthorityHttpServer(
  options: OrganizationAuthorityHttpServerOptions,
): Server {
  validateProviderIngressRoutes(options);
  const handoffs = new Map<string, PendingLoopbackHandoff>();
  const oidcBeginWindows = new Map<string, OidcBeginClientWindow>();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const approvalIngress = options.private_approval_interaction_ingress;
      if (
        approvalIngress !== undefined &&
        method === approvalIngress.method &&
        url.pathname === approvalIngress.path &&
        url.search === ""
      ) {
        const headers = singletonHeaders(request.headers);
        await approvalIngress.accept({
          raw_body: await rawBody(request),
          content_type: headers["content-type"],
          headers,
        });
        ok(response);
        return;
      }
      const externalIdentityRoute =
        options.person_external_identity_link?.routes.find(
          (route) =>
            route.method === method && route.path === url.pathname,
        );
      if (externalIdentityRoute !== undefined && url.search === "") {
        const headers = singletonHeaders(request.headers);
        const result = await options.person_external_identity_link!.accept({
          route_id: externalIdentityRoute.route_id,
          raw_body: await rawBody(request),
          content_type: headers["content-type"],
          headers,
        });
        json(response, result.status, result.body);
        return;
      }
      if (
        method === "GET" &&
        url.pathname === ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH &&
        url.search === ""
      ) {
        json(response, 200, { authority_descriptor: options.descriptor });
        return;
      }
      if (
        method === "POST" &&
        url.pathname === PERSON_SESSION_OIDC_BEGIN_PATH &&
        url.search === ""
      ) {
        for (const [state, handoff] of handoffs) {
          if (Date.parse(handoff.expires_at) <= Date.now()) handoffs.delete(state);
        }
        const input = validateOrganizationPersonOidcBeginRequest(
          await body(request),
        );
        if (
          !admitOidcBeginClient(
            oidcBeginWindows,
            oidcBeginClient(request),
            Date.now(),
          )
        ) {
          throw new AuthorityOperationError(
            "rate_limited",
            "person authentication failed",
          );
        }
        const begun = options.sessions.beginOidcLogin(
          input.kind === "identity_bootstrap"
            ? { kind: input.kind, login_grant: input.login_grant }
            : { kind: input.kind },
        );
        if (input.loopback_handoff !== undefined) {
          handoffs.set(
            begun.state,
            Object.freeze({
              url: input.loopback_handoff.url,
              token: input.loopback_handoff.token,
              expires_at: begun.expires_at,
            }),
          );
        }
        json(response, 201, {
          authorization_url:
            await options.oidc_provider.buildAuthorizationUrl(begun),
          expires_at: begun.expires_at,
        });
        return;
      }
      if (
        method === "GET" &&
        url.pathname === PERSON_SESSION_OIDC_CALLBACK_PATH
      ) {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const issuer = url.searchParams.get("iss");
        if (
          state === null ||
          code === null ||
          (issuer !== null && issuer !== options.expected_issuer)
        ) {
          throw new AuthorityOperationError(
            "unauthorized",
            "person authentication failed",
          );
        }
        const handoff = handoffs.get(state);
        // Delete before completion: a retry after a delivery or process fault
        // is an explicit fresh login, never a second credential delivery.
        handoffs.delete(state);
        let completed;
        try {
          completed = await options.sessions.completeOidcLogin({
            state,
            authorization_code: code,
          });
        } catch (error) {
          if (
            handoff !== undefined &&
            Date.parse(handoff.expires_at) > Date.now() &&
            error instanceof PersonOidcIdentityNotBoundError
          ) {
            handoffErrorHtml(response, {
              ...handoff,
              code: "identity_not_bound",
            });
            return;
          }
          if (
            handoff !== undefined &&
            Date.parse(handoff.expires_at) > Date.now() &&
            error instanceof PersonOidcRetryableError
          ) {
            handoffErrorHtml(response, { ...handoff, code: "retryable" });
            return;
          }
          throw error;
        }
        if (handoff === undefined || Date.parse(handoff.expires_at) <= Date.now()) {
          // A callback can still complete the Authority-side state after a
          // process restart, but credential bytes never fall back to JSON.
          void completed;
          expiredHandoffHtml(response);
        } else {
          handoffHtml(response, {
            url: handoff.url,
            token: handoff.token,
            session: completed,
          });
        }
        return;
      }
      if (
        method === "POST" &&
        url.pathname === PERSON_SESSION_REFRESH_PATH &&
        url.search === ""
      ) {
        json(
          response,
          200,
          options.sessions.refresh(
            validateOrganizationPersonSessionRefreshRequest(
              await body(request),
            ),
          ),
        );
        return;
      }
      if (
        method === "POST" &&
        url.pathname === PERSON_SESSION_REVOCATIONS_PATH &&
        url.search === ""
      ) {
        const value = await body(request);
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 0
        ) {
          throw new AuthorityOperationError(
            "invalid_request",
            "logout request must be empty",
          );
        }
        options.sessions.revoke({
          credential_kind: "access",
          credential: accessToken(request.headers.authorization),
          reason: "person_logout",
        });
        noContent(response);
        return;
      }
      if (
        options.person_employees !== undefined &&
        url.pathname === PERSON_EMPLOYEES_PATH_V1 &&
        url.search === ""
      ) {
        const authenticated = accessToken(request.headers.authorization);
        if (method === "GET") {
          json(
            response,
            200,
            options.person_employees.list({ access_token: authenticated }),
          );
          return;
        }
        const requestBody = await body(request);
        if (method === "POST") {
          json(
            response,
            201,
            options.person_employees.invite({
              access_token: authenticated,
              body: requestBody,
            }),
          );
          return;
        }
        if (method === "PUT") {
          json(
            response,
            201,
            options.person_employees.reissue({
              access_token: authenticated,
              body: requestBody,
            }),
          );
          return;
        }
        if (method === "DELETE") {
          options.person_employees.revoke({
            access_token: authenticated,
            body: requestBody,
          });
          noContent(response);
          return;
        }
      }
      if (method === "GET" && url.pathname === PERSON_RECORDS_PATH_V1) {
        if (options.person_record_read === undefined) {
          fail(response, 503, "unavailable");
          return;
        }
        const limit = recordLimit(url);
        json(
          response,
          200,
          options.person_record_read.list({
            access_token: accessToken(request.headers.authorization),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
        return;
      }
      if (
        method === "POST" &&
        url.pathname === PERSON_RECORD_SEARCH_PATH_V1 &&
        url.search === ""
      ) {
        if (options.person_record_search === undefined) {
          fail(response, 503, "unavailable");
          return;
        }
        const input = recordSearchInput(await body(request));
        json(
          response,
          200,
          options.person_record_search.search({
            access_token: accessToken(request.headers.authorization),
            ...input,
          }),
        );
        return;
      }
      if (
        method === "POST" &&
        url.pathname === PERSON_ANSWER_PATH_V1 &&
        url.search === ""
      ) {
        if (options.person_answer === undefined) {
          fail(response, 503, "unavailable");
          return;
        }
        json(
          response,
          200,
          await options.person_answer.ask({
            access_token: accessToken(request.headers.authorization),
            ...answerInput(await body(request)),
          }),
        );
        return;
      }
      fail(response, 404, "not_found");
    } catch (error) {
      if (error instanceof AuthorityOperationError) {
        const status =
          error.code === "unauthorized"
            ? 401
            : error.code === "not_found"
              ? 404
              : error.code === "conflict"
                ? 409
                : error.code === "unavailable"
                  ? 503
                  : error.code === "rate_limited"
                    ? 429
                    : 400;
        fail(response, status, error.code);
        return;
      }
      fail(response, 500, "internal");
    }
  });
}
