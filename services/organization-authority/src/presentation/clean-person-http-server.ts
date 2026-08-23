import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  validateOrganizationPersonSlackLinkBeginRequest,
  validateOrganizationPersonSlackLinkCompleteRequest,
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
import type { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import type { PersonSlackIdentityLinkHttpApplication } from "./person-slack-identity-link-http-application.js";
import {
  CLEAN_PERSON_RECORDS_PATH_V1,
  type CleanPersonRecordReadHttpApplicationV1,
} from "./clean-person-record-read-http-application.js";
import {
  CLEAN_PERSON_RECORD_SEARCH_PATH_V1,
  type CleanPersonRecordSearchHttpApplicationV1,
} from "./clean-person-record-search-http-application.js";
import {
  CLEAN_PERSON_EMPLOYEES_PATH_V1,
  type CleanPersonEmployeeHttpApplication,
} from "./clean-person-employee-http-application.js";

const MAXIMUM_BODY_BYTES = 64 * 1024;
export interface CleanPersonOidcProvider {
  buildAuthorizationUrl(
    input: ReturnType<PersonIdentitySessionApplication["beginOidcLogin"]>,
  ): string | Promise<string>;
}

export interface CleanPersonHttpServerOptions {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly sessions: PersonIdentitySessionApplication;
  readonly oidc_provider: CleanPersonOidcProvider;
  readonly expected_issuer: string;
  /** Optional: no connected Slack bot is required to start founder login. */
  readonly person_slack_identity_link?: PersonSlackIdentityLinkHttpApplication;
  /** Optional only for focused identity-runtime tests. Clean live wires it. */
  readonly person_record_read?: CleanPersonRecordReadHttpApplicationV1;
  /** Optional only for focused identity-runtime tests. Clean live wires it. */
  readonly person_record_search?: CleanPersonRecordSearchHttpApplicationV1;
  /** Owner-only employee invite, reissue, and revoke. */
  readonly person_employees?: CleanPersonEmployeeHttpApplication;
}

interface PendingLoopbackHandoff {
  readonly url: string;
  readonly token: string;
  readonly expires_at: string;
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

async function body(request: IncomingMessage): Promise<unknown> {
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
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
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

/** Exactly the founder Person surface, with no legacy machine routes. */
export function createCleanPersonHttpServer(
  options: CleanPersonHttpServerOptions,
): Server {
  const handoffs = new Map<string, PendingLoopbackHandoff>();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
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
        const input = validateOrganizationPersonOidcBeginRequest(
          await body(request),
        );
        const begun = options.sessions.beginOidcLogin(
          input.kind === "identity_bootstrap"
            ? { kind: input.kind, login_grant: input.login_grant }
            : { kind: input.kind },
        );
        for (const [state, handoff] of handoffs) {
          if (Date.parse(handoff.expires_at) <= Date.now()) handoffs.delete(state);
        }
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
        const completed = await options.sessions.completeOidcLogin({
          state,
          authorization_code: code,
        });
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
        url.pathname === CLEAN_PERSON_EMPLOYEES_PATH_V1 &&
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
      if (method === "GET" && url.pathname === CLEAN_PERSON_RECORDS_PATH_V1) {
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
        url.pathname === CLEAN_PERSON_RECORD_SEARCH_PATH_V1 &&
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
        url.pathname === ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH &&
        url.search === ""
      ) {
        if (options.person_slack_identity_link === undefined) {
          fail(response, 503, "unavailable");
          return;
        }
        json(
          response,
          201,
          await options.person_slack_identity_link.begin(
            validateOrganizationPersonSlackLinkBeginRequest(
              await body(request),
            ),
            accessToken(request.headers.authorization),
          ),
        );
        return;
      }
      if (
        method === "POST" &&
        url.pathname === ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH &&
        url.search === ""
      ) {
        if (options.person_slack_identity_link === undefined) {
          fail(response, 503, "unavailable");
          return;
        }
        json(
          response,
          200,
          await options.person_slack_identity_link.complete(
            validateOrganizationPersonSlackLinkCompleteRequest(
              await body(request),
            ),
            accessToken(request.headers.authorization),
          ),
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
                  : 400;
        fail(response, status, error.code);
        return;
      }
      fail(response, 500, "internal");
    }
  });
}
