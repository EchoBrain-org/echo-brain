import {
  PERSON_PROJECTS_PATH_V1, PERSON_UPDATES_PATH_V2, PROJECT_CONTEXT_RESPONSE_MAX_BYTES,
  validateProjectCreateV1, validateProjectCreateReceiptV1, validateProjectListV1,
  validateProjectPageRequestV1, validateProjectIdV1, validateProjectSummaryV1,
  validateProjectContextBrowseV1, validateProjectMembersV1,
  validateProjectDirectorySearchV1, validateProjectDirectoryV1,
  validateProjectMemberSetV1, validateProjectMemberRemoveV1, validateProjectMutationReceiptV1,
  validateProjectContextAssociateV1, validateProjectContextDissociateV1,
  validateProjectContextFeedV1, validateProjectContextSearchV1, validateProjectContextSearchResultV1,
  validateProjectContextReadV1, validatePersonUploadContextId, validatePersonUpdateRequestId,
  validatePersonUpdateSubmitV2, validatePersonUpdateReceiptV2, validatePersonUpdateStatusV2,
  validatePersonUploadSearchV2, validatePersonUploadSearchResultV2, validatePersonUploadContentV2,
} from '@echo-brain/organization-api';
import type { ProjectContextApplicationV1 } from '../application/ports/project-context-v1.js';
import type { PersonDocumentApplicationV1 } from '../application/ports/document-v1.js';
import type { PersonDocumentUploadStagingV1 } from '../application/ports/document-upload-staging-v1.js';
import { createPersonDocumentsHttpHandlerV1 } from './person-documents-http-route-v1.js';
import { PERSON_DOCUMENTS_PATH_V1 } from '@echo-brain/organization-api';
import { PERSON_UPDATES_PATH_V1, MAX_ORGANIZATION_API_BODY_BYTES } from '@echo-brain/organization-api';
import type { PersonUpdatesApplicationV1 } from '../application/person-updates.js';
import { validatePersonQueryText } from "@echo-brain/organization-api";
import { annotateCoreRuntimeV1, observeCoreRuntimeV1, type CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonSessionRefreshRequest,
} from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
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
import type { ProviderHttpApplicationV1, ProviderHttpRouteV1, ProviderHttpResponseV1 } from "@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1";
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

const MAXIMUM_BODY_BYTES = 64 * 1024;
const MAXIMUM_PROVIDER_QUERY_BYTES = 8 * 1024;
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 64 * 1024;
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
  `POST ${PERSON_UPDATES_PATH_V1}`,
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
  /** Lifecycle ingress fence, including pipelined requests on existing sockets. */
  readonly is_closing?: () => boolean;
  readonly core_runtime_observation?: CoreRuntimeObservationScopeV1;
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly sessions: PersonIdentitySessionApplication;
  readonly oidc_provider: AuthorityOidcAuthorizationUrlProvider;
  readonly expected_issuer: string;
  /** Optional: no connected external identity provider is required for login. */
  readonly person_external_identity_link?: ProviderHttpApplicationV1;
  readonly person_tools?: ProviderHttpApplicationV1;
  /** Optional only for focused identity-runtime tests. Organization Authority runtime wires it. */
  readonly person_record_read?: PersonRecordReadHttpApplicationV1;
  /** Optional only for focused identity-runtime tests. Organization Authority runtime wires it. */
  readonly person_record_search?: PersonRecordSearchHttpApplicationV1;
  /** Owner-only employee invite, reissue, and revoke. */
  readonly person_employees?: PersonEmployeeHttpApplication;
  /** Optional until the active Organization Authority runtime has a configured answer model. */
  readonly person_answer?: PersonAnswerHttpApplicationV1;
  readonly person_updates?: PersonUpdatesApplicationV1;
  /** Mounted only when the project application and V2 worker binding are composed. */
  readonly project_context?: ProjectContextApplicationV1;
  readonly person_documents?: PersonDocumentApplicationV1;
  readonly document_upload_staging?: PersonDocumentUploadStagingV1;
  /** Optional until an active private-approval surface is fully composed. */
  readonly private_approval_interaction_ingress?:
    ProviderHttpApplicationV1;
}

function providerIngressRoutes(
  options: OrganizationAuthorityHttpServerOptions,
): ReadonlyMap<string, { readonly route: ProviderHttpRouteV1; readonly accept: ProviderHttpApplicationV1["accept"] }> {
  const mounted = new Map<string, { readonly route: ProviderHttpRouteV1; readonly accept: ProviderHttpApplicationV1["accept"] }>();
  for (const application of [options.private_approval_interaction_ingress, options.person_external_identity_link, options.person_tools]) {
    if (application === undefined) continue;
    const routeIds = new Set<string>();
    for (const route of application.routes) {
      const parsed = new URL(route.path, "http://localhost");
      if (
        (route.method !== "GET" && route.method !== "POST") ||
        !route.path.startsWith("/") || route.path.startsWith("//") ||
        parsed.pathname !== route.path || parsed.search !== "" || parsed.hash !== "" ||
        route.route_id.length === 0 || routeIds.has(route.route_id)
      ) throw new Error("invalid provider ingress route");
      routeIds.add(route.route_id);
      const key = routeKey(route.method, route.path);
      if (ORGANIZATION_AUTHORITY_HTTP_ROUTES.has(key) ||
        [PERSON_UPDATES_PATH_V1, PERSON_UPDATES_PATH_V2, PERSON_PROJECTS_PATH_V1, PERSON_DOCUMENTS_PATH_V1]
          .some(path => route.path === path || route.path.startsWith(`${path}/`))) {
        throw new Error(`provider ingress route collides with Authority route: ${key}`);
      }
      if (mounted.has(key)) {
        throw new Error(`provider ingress route is configured more than once: ${key}`);
      }
      // Dispatch the same configuration that passed collision checks, even
      // if an adapter later mutates its original route array or objects.
      mounted.set(key, { route: Object.freeze({ ...route }), accept: application.accept.bind(application) });
    }
  }
  return mounted;
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

function providerResponse(response: ServerResponse, result: ProviderHttpResponseV1): void {
  if (![200, 201, 202].includes(result.status)) throw new Error("invalid provider response status");
  let bytes: Buffer;
  let contentType: string | undefined;
  let maximum = MAXIMUM_PROVIDER_RESPONSE_BYTES;
  if ("raw_body" in result) {
    if (
      !(result.raw_body instanceof Uint8Array) ||
      (result.content_type !== undefined && result.content_type !== "text/plain" && result.content_type !== "application/octet-stream") ||
      (result.raw_body.byteLength > 0 && result.content_type === undefined)
    ) throw new Error("invalid provider response bytes");
    // Bound bytes before copying them, then preserve their exact encoding.
    if (result.raw_body.byteLength > maximum) throw new Error("provider response is too large");
    bytes = Buffer.from(result.raw_body);
    contentType = result.content_type;
  } else if (result.content_type === "text/html") {
    if (typeof result.body !== "string") throw new Error("invalid provider callback page");
    maximum = 16_384;
    if (Buffer.byteLength(result.body, "utf8") > maximum) throw new Error("provider response is too large");
    bytes = Buffer.from(result.body, "utf8");
    contentType = "text/html; charset=utf-8";
  } else {
    if (result.content_type !== undefined) throw new Error("invalid provider response content type");
    bytes = Buffer.from(JSON.stringify(result.body), "utf8");
    contentType = "application/json; charset=utf-8";
  }
  if (bytes.byteLength > maximum) throw new Error("provider response is too large");
  response.writeHead(result.status, {
    ...(contentType === undefined ? {} : { "content-type": contentType }),
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
    ...(result.content_type === "text/html" ? {
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    } : "raw_body" in result && bytes.byteLength > 0 ? {
      "x-content-type-options": "nosniff",
    } : {}),
  });
  response.end(bytes);
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
    "<!doctype html><meta charset=\"utf-8\"><title>Echo sign-in expired</title><p>Sign-in expired. Return to your terminal and rerun the exact command that started sign-in.</p>",
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

async function rawBody(request: IncomingMessage, maximum = MAXIMUM_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximum)
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

function recordSha256(url: URL): `sha256:${string}` | undefined {
  const value = url.searchParams.get("record_sha256");
  if (value === null) return undefined;
  if (
    [...url.searchParams.entries()].length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return value as `sha256:${string}`;
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
  let query: string;
  try { query = validatePersonQueryText(record.query); }
  catch { throw new AuthorityOperationError("invalid_request", "request is invalid"); }
  if (
    keys.length < 1 || keys.length > 2 || !keys.includes("query") ||
    keys.some(key => key !== "query" && key !== "limit") ||
    (record.limit !== undefined &&
      (!Number.isSafeInteger(record.limit) ||
        (record.limit as number) < 1 ||
        (record.limit as number) > 10))
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return Object.freeze({
    query,
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
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "question")) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  try { return Object.freeze({ question: validatePersonQueryText(record.question) }); }
  catch { throw new AuthorityOperationError("invalid_request", "request is invalid"); }
}

/** Validate transport input without exposing codec diagnostics to the caller. */
function projectInput<T>(validate: (value: unknown) => T, value: unknown): T {
  try { return validate(value); }
  catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
}

async function projectBody(request: IncomingMessage): Promise<unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await rawBody(request, MAX_ORGANIZATION_API_BODY_BYTES),
    );
    const value: unknown = JSON.parse(text);
    // JSON.parse accepts duplicate members. Scan the already-valid JSON tokens
    // so escaped equivalent names and duplicates in nested objects also fail.
    const objects: (Set<string> | undefined)[] = [];
    for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"(\s*:)?|[{}[\]]/g)) {
      if (token[0] === '{') objects.push(new Set());
      else if (token[0] === '[') objects.push(undefined);
      else if (token[0] === '}' || token[0] === ']') objects.pop();
      else if (token[1] !== undefined) {
        const key = JSON.parse(token[0].slice(0, -token[1].length)) as string;
        const keys = objects.at(-1)!;
        if (keys.has(key)) throw new Error('duplicate JSON member');
        keys.add(key);
      }
    }
    return value;
  } catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
}

function projectPage(url: URL): unknown {
  const page: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if ((key !== 'limit' && key !== 'cursor') || Object.hasOwn(page, key)) {
      throw new AuthorityOperationError('invalid_request', 'request failed');
    }
    if (key === 'limit' && !/^(?:[1-9]|10)$/.test(value)) {
      throw new AuthorityOperationError('invalid_request', 'request failed');
    }
    page[key] = key === 'limit' ? Number(value) : value;
  }
  return projectInput(validateProjectPageRequestV1, page);
}

function projectResponse(response: ServerResponse, status: number, value: unknown, validate: (value: unknown) => unknown): void {
  try {
    validate(value);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) {
      throw new Error('project response is too large');
    }
  } catch { throw new AuthorityOperationError('invalid_output', 'request failed'); }
  // Send the application's exact committed/audited response, not a normalized
  // replacement returned by a codec. There is no await after application release.
  json(response, status, value);
}

type ProjectBodyOperation = Exclude<keyof ProjectContextApplicationV1,
  'listProjects' | 'readProject' | 'readContext' | 'uploadStatus' | 'readUpload'>;
const PROJECT_BODY_ROUTES: ReadonlyMap<string, {
  readonly operation: ProjectBodyOperation;
  readonly request: (value: unknown) => unknown;
  readonly response: (value: unknown) => unknown;
  readonly status: number;
}> = new Map([
  [PERSON_PROJECTS_PATH_V1, { operation: 'createProject', request: validateProjectCreateV1, response: validateProjectCreateReceiptV1, status: 201 }],
  [`${PERSON_PROJECTS_PATH_V1}/members`, { operation: 'listMembers', request: validateProjectContextBrowseV1, response: validateProjectMembersV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/directory`, { operation: 'searchDirectory', request: validateProjectDirectorySearchV1, response: validateProjectDirectoryV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/members/set`, { operation: 'setMember', request: validateProjectMemberSetV1, response: validateProjectMutationReceiptV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/members/remove`, { operation: 'removeMember', request: validateProjectMemberRemoveV1, response: validateProjectMutationReceiptV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/context/associate`, { operation: 'associateContext', request: validateProjectContextAssociateV1, response: validateProjectMutationReceiptV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/context/dissociate`, { operation: 'dissociateContext', request: validateProjectContextDissociateV1, response: validateProjectMutationReceiptV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/context/feed`, { operation: 'feed', request: validateProjectContextBrowseV1, response: validateProjectContextFeedV1, status: 200 }],
  [`${PERSON_PROJECTS_PATH_V1}/context/search`, { operation: 'search', request: validateProjectContextSearchV1, response: validateProjectContextSearchResultV1, status: 200 }],
  [PERSON_UPDATES_PATH_V2, { operation: 'submitUpload', request: validatePersonUpdateSubmitV2, response: validatePersonUpdateReceiptV2, status: 202 }],
  [`${PERSON_UPDATES_PATH_V2}/search`, { operation: 'searchUploads', request: validatePersonUploadSearchV2, response: validatePersonUploadSearchResultV2, status: 200 }],
]);

/** Route selection returns a synchronous release callback after all input I/O. */
async function projectRoute(
  request: IncomingMessage, url: URL, application: ProjectContextApplicationV1,
): Promise<((response: ServerResponse) => void) | undefined> {
  const method = request.method ?? 'GET';
  const route = PROJECT_BODY_ROUTES.get(url.pathname);
  if (method === 'POST' && route !== undefined) {
    const token = accessToken(request.headers.authorization);
    if (url.search !== '') throw new AuthorityOperationError('invalid_request', 'request failed');
    const input = projectInput(route.request, await projectBody(request));
    return response => projectResponse(response, route.status, application[route.operation](token, input), route.response);
  }
  if (method !== 'GET') return undefined;
  // Static POST paths cannot be misinterpreted as project/request identifiers.
  if (route !== undefined && url.pathname !== PERSON_PROJECTS_PATH_V1) return undefined;
  const projectPath = url.pathname.startsWith(`${PERSON_PROJECTS_PATH_V1}/`)
    ? url.pathname.slice(PERSON_PROJECTS_PATH_V1.length + 1).split('/') : [];
  const uploadPath = url.pathname.startsWith(`${PERSON_UPDATES_PATH_V2}/`)
    ? url.pathname.slice(PERSON_UPDATES_PATH_V2.length + 1).split('/') : [];
  const list = url.pathname === PERSON_PROJECTS_PATH_V1;
  const readProject = projectPath.length === 1;
  const readContext = projectPath.length === 3 && projectPath[1] === 'context';
  const status = uploadPath.length === 1;
  const readUpload = uploadPath.length === 2 && uploadPath[0] === 'content';
  if (!list && !readProject && !readContext && !status && !readUpload) return undefined;
  const token = accessToken(request.headers.authorization);
  if ((!list && url.search !== '') || (await rawBody(request, MAX_ORGANIZATION_API_BODY_BYTES)).length !== 0) {
    throw new AuthorityOperationError('invalid_request', 'request failed');
  }
  if (list) {
    const page = projectPage(url);
    return response => projectResponse(response, 200, application.listProjects(token, page), validateProjectListV1);
  }
  if (readProject || readContext) {
    const project = projectInput(validateProjectIdV1, projectPath[0]);
    if (readContext) {
      const context = projectInput(validatePersonUploadContextId, projectPath[2]);
      return response => projectResponse(response, 200, application.readContext(token, project, context), validateProjectContextReadV1);
    }
    return response => projectResponse(response, 200, application.readProject(token, project), validateProjectSummaryV1);
  }
  if (readUpload) {
    const context = projectInput(validatePersonUploadContextId, uploadPath[1]);
    return response => projectResponse(response, 200, application.readUpload(token, context), validatePersonUploadContentV2);
  }
  const id = projectInput(validatePersonUpdateRequestId, uploadPath[0]);
  return response => projectResponse(response, 200, application.uploadStatus(token, id), validatePersonUpdateStatusV2);
}

/** The Organization Authority Person API surface, with no machine routes. */
export function createOrganizationAuthorityHttpServer(
  options: OrganizationAuthorityHttpServerOptions,
): Server {
  const providerRoutes = providerIngressRoutes(options);
  if ((options.person_documents === undefined) !== (options.document_upload_staging === undefined)) throw new Error('Document application and transfer staging must be composed together');
  const documents = options.person_documents === undefined ? undefined : createPersonDocumentsHttpHandlerV1(
    options.person_documents, options.document_upload_staging!, options.is_closing === undefined ? {} : { isClosing: options.is_closing },
  );
  const handoffs = new Map<string, PendingLoopbackHandoff>();
  const oidcBeginWindows = new Map<string, OidcBeginClientWindow>();
  let activeHttp = 0;
  return createServer((request, response) => observeCoreRuntimeV1("http_request", async () => {
    const responseFinished = options.core_runtime_observation?.observer === undefined ? undefined :
      new Promise<void>((resolve) => { response.once("finish", resolve); response.once("close", resolve); });
    activeHttp += 1;
    annotateCoreRuntimeV1({ counts: { active_http: activeHttp } });
    try {
      if (options.is_closing?.()) {
        response.setHeader("connection", "close");
        throw new AuthorityOperationError("unavailable", "Authority is closing");
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const ingress = providerRoutes.get(routeKey(method, url.pathname));
      if (
        ingress !== undefined &&
        (url.search === "" || ingress.route.accepts_query === true)
      ) {
        if (Buffer.byteLength(url.search, "utf8") > MAXIMUM_PROVIDER_QUERY_BYTES)
          throw new AuthorityOperationError("invalid_request", "request query is too large");
        const headers = singletonHeaders(request.headers);
        const result = await ingress.accept({
          route_id: ingress.route.route_id,
          method: ingress.route.method,
          path: ingress.route.path,
          raw_body: await rawBody(request),
          content_type: headers["content-type"],
          headers,
          ...(ingress.route.accepts_query === true
            ? { query: new URLSearchParams(url.search) }
            : {}),
        });
        providerResponse(response, result);
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
            ? {
                kind: input.kind,
                login_grant: input.login_grant,
                ...(input.login_hint === undefined
                  ? {}
                  : { login_hint: input.login_hint }),
              }
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
      if (documents !== undefined) {
        try { if (await documents(request, response, url)) return; }
        catch (error) {
          if (error instanceof AuthorityOperationError) throw error;
          throw new AuthorityOperationError('unavailable', 'request failed');
        }
      }
      if (options.project_context !== undefined) {
        try {
          const release = await projectRoute(request, url, options.project_context);
          if (release !== undefined) { release(response); return; }
        } catch (error) {
          if (error instanceof AuthorityOperationError) throw error;
          // Persistence/audit failures must keep the closed project error
          // contract while withholding the response and private diagnostics.
          throw new AuthorityOperationError('unavailable', 'request failed');
        }
      }
      if (options.person_updates !== undefined && url.search === '') {
        if (method === 'POST' && url.pathname === PERSON_UPDATES_PATH_V1) {
          const token = accessToken(request.headers.authorization);
          // Reject malformed UTF-8 instead of replacing bytes before validation.
          let requestBody: unknown;
          try { requestBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await rawBody(request, MAX_ORGANIZATION_API_BODY_BYTES))); }
          catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
          json(response, 202, options.person_updates.submit(token, requestBody));
          return;
        }
        if (method === 'POST' && url.pathname === `${PERSON_UPDATES_PATH_V1}/search`) {
          const token = accessToken(request.headers.authorization);
          let requestBody: unknown;
          try { requestBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await rawBody(request, MAX_ORGANIZATION_API_BODY_BYTES))); }
          catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
          json(response, 200, options.person_updates.search(token, requestBody));
          return;
        }
        if (method === 'GET' && url.pathname.startsWith(`${PERSON_UPDATES_PATH_V1}/content/`)) {
          json(response, 200, options.person_updates.content(accessToken(request.headers.authorization), url.pathname.slice(PERSON_UPDATES_PATH_V1.length + '/content/'.length)));
          return;
        }
        if (method === 'GET' && url.pathname.startsWith(`${PERSON_UPDATES_PATH_V1}/`)) {
          json(response, 200, options.person_updates.status(accessToken(request.headers.authorization), url.pathname.slice(PERSON_UPDATES_PATH_V1.length + 1)));
          return;
        }
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
        const exactRecord = recordSha256(url);
        const limit = exactRecord === undefined ? recordLimit(url) : undefined;
        json(
          response,
          200,
          options.person_record_read.list({
            access_token: accessToken(request.headers.authorization),
            ...(request.headers["x-echo-person-record-version"] === "2"
              ? { include_source_metadata: true } : {}),
            ...(limit === undefined ? {} : { limit }),
            ...(exactRecord === undefined
              ? {}
              : { record_sha256: exactRecord }),
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
                : error.code === "invalid_output"
                  ? 502
                  : error.code === "unavailable"
                    ? 503
                    : error.code === "rate_limited"
                      ? 429
                      : 400;
        fail(response, status, error.code);
        return;
      }
      fail(response, 500, "internal");
    } finally {
      if (responseFinished !== undefined) await responseFinished;
      activeHttp -= 1;
      annotateCoreRuntimeV1({ counts: { http_status: response.statusCode, active_http: activeHttp } });
    }
  }, options.core_runtime_observation));
}
