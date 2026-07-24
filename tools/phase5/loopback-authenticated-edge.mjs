import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { TextDecoder } from "node:util";
import {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from "@echo-brain/organization-api";

export {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
};
export const MAX_PHASE5_EDGE_BUFFERED_RESPONSE_BYTES = 256 * 1024;

const DEFAULT_BUFFERED_RESPONSE_BYTES = 64 * 1024;
const UUID_V4_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ADMIN_ROUTE_RULES = Object.freeze([
  ["GET", /^\/v1\/authority-descriptor$/],
  ["GET", /^\/v1\/admin\/overview$/],
  ["POST", /^\/v1\/admin\/memberships$/],
  [
    "POST",
    new RegExp(
      `^/v1/admin/memberships/mem_${UUID_V4_SOURCE}/enrollment-grants$`,
    ),
  ],
  [
    "POST",
    new RegExp(`^/v1/admin/memberships/mem_${UUID_V4_SOURCE}/revocations$`),
  ],
  [
    "POST",
    new RegExp(`^/v1/admin/installations/ins_${UUID_V4_SOURCE}/revocations$`),
  ],
]);
const EMPLOYEE_ROUTE_RULES = Object.freeze([
  ["GET", /^\/v1\/authority-descriptor$/],
  ["POST", /^\/v1\/enrollments$/],
  ["POST", /^\/v1\/access-leases$/],
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function canonicalTarget(value) {
  const target = new URL(value);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error(
      "Phase 5 rehearsal edge target must be one bare loopback HTTP origin",
    );
  }
  return target;
}

function connectionNamedHeaders(headers) {
  const result = new Set();
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : [connection];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const name of value.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized !== "") result.add(normalized);
    }
  }
  return result;
}

function isEchoProxyCredentialHeader(name) {
  return (
    name === TRUSTED_PROXY_AUTHORIZATION_HEADER ||
    name === TRUSTED_PROXY_CLIENT_ID_HEADER ||
    name.startsWith("x-echo-proxy-") ||
    name.startsWith("x-echo-authenticated-client-")
  );
}

function forwardedHeaders(input, target, proxyToken, clientId) {
  const headers = {};
  const connectionHeaders = connectionNamedHeaders(input);
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionHeaders.has(normalized) ||
      isEchoProxyCredentialHeader(normalized)
    ) {
      continue;
    }
    headers[normalized] = value;
  }
  headers.host = target.host;
  headers[TRUSTED_PROXY_AUTHORIZATION_HEADER] = `Echo-Proxy ${proxyToken}`;
  headers[TRUSTED_PROXY_CLIENT_ID_HEADER] = clientId;
  return headers;
}

function responseHeaders(input, omitted = new Set()) {
  const headers = {};
  const connectionHeaders = connectionNamedHeaders(input);
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !connectionHeaders.has(normalized) &&
      !omitted.has(normalized)
    ) {
      headers[normalized] = value;
    }
  }
  return headers;
}

function sendNormalizedError(response, status, code, message) {
  if (response.destroyed || response.headersSent) return;
  const body = Buffer.from(
    JSON.stringify({ error: { code, message } }),
    "utf8",
  );
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function canonicalRequestTarget(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return undefined;
  }
  let target;
  try {
    target = new URL(value, "http://phase5-edge.invalid");
  } catch {
    return undefined;
  }
  if (
    target.origin !== "http://phase5-edge.invalid" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    return undefined;
  }
  return target.pathname;
}

function routeAllowed(role, method, path) {
  const rules = role === "admin" ? ADMIN_ROUTE_RULES : EMPLOYEE_ROUTE_RULES;
  return rules.some(
    ([expectedMethod, pattern]) =>
      method === expectedMethod && pattern.test(path),
  );
}

function assertVisibleProxyToken(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(value)) {
    throw new Error("Phase 5 proxy token must be 32-4096 visible ASCII bytes");
  }
}

function assertCanonicalClientId(value) {
  const match = /^cid_([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (match === null) {
    throw new Error("Phase 5 proxy client ID is not canonical");
  }
  const digest = Buffer.from(match[1], "base64url");
  if (digest.length !== 32 || digest.toString("base64url") !== match[1]) {
    throw new Error("Phase 5 proxy client ID is not canonical");
  }
}

function configuredBufferLimit(value) {
  const limit = value ?? DEFAULT_BUFFERED_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_PHASE5_EDGE_BUFFERED_RESPONSE_BYTES
  ) {
    throw new Error(
      `Phase 5 buffered response limit must be 1-${MAX_PHASE5_EDGE_BUFFERED_RESPONSE_BYTES} bytes`,
    );
  }
  return limit;
}

class OneShotFault {
  constructor(armed) {
    if (typeof armed !== "boolean") {
      throw new Error("Phase 5 one-shot fault controls must be boolean");
    }
    this.armed = armed;
    this.reserved = false;
    this.consumed = false;
  }

  reserve() {
    if (!this.armed || this.reserved || this.consumed) return undefined;
    this.reserved = true;
    let settled = false;
    return Object.freeze({
      apply: () => {
        if (settled) return;
        settled = true;
        this.reserved = false;
        this.consumed = true;
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.reserved = false;
      },
    });
  }

  snapshot() {
    return Object.freeze({
      armed: this.armed,
      reserved: this.reserved,
      consumed: this.consumed,
    });
  }
}

function accessStateTamperedBody(bytes, contentType) {
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    return undefined;
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.access_state !== "object" ||
    value.access_state === null ||
    Array.isArray(value.access_state) ||
    !Number.isSafeInteger(value.access_state.access_state_sequence) ||
    value.access_state.access_state_sequence <= 0 ||
    typeof value.access_state.integrity !== "object" ||
    value.access_state.integrity === null ||
    Array.isArray(value.access_state.integrity) ||
    typeof value.access_state.integrity.signature_base64 !== "string"
  ) {
    return undefined;
  }
  const signature = value.access_state.integrity.signature_base64;
  value.access_state.access_state_sequence =
    value.access_state.access_state_sequence === Number.MAX_SAFE_INTEGER
      ? value.access_state.access_state_sequence - 1
      : value.access_state.access_state_sequence + 1;
  if (value.access_state.integrity.signature_base64 !== signature) {
    throw new Error("Phase 5 access-state tamper changed the signature");
  }
  return Buffer.from(JSON.stringify(value), "utf8");
}

function proxyBufferedResponse({
  response,
  outgoing,
  reservation,
  fault,
  maximumBytes,
}) {
  const chunks = [];
  let total = 0;
  let settled = false;

  const fail = () => {
    if (settled) return;
    settled = true;
    reservation.release();
    response.destroy();
    sendNormalizedError(
      outgoing,
      502,
      "upstream_response_incomplete",
      "the upstream response was incomplete",
    );
  };

  const declaredLength = response.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      settled = true;
      reservation.release();
      response.destroy();
      sendNormalizedError(
        outgoing,
        502,
        "upstream_response_too_large",
        "the upstream response exceeded the edge buffer limit",
      );
      return;
    }
  }

  response.on("data", (chunk) => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) {
      settled = true;
      reservation.release();
      response.destroy();
      sendNormalizedError(
        outgoing,
        502,
        "upstream_response_too_large",
        "the upstream response exceeded the edge buffer limit",
      );
      return;
    }
    chunks.push(bytes);
  });
  response.once("aborted", fail);
  response.once("error", fail);
  response.once("end", () => {
    if (settled) return;
    if (!response.complete) {
      fail();
      return;
    }
    const body = Buffer.concat(chunks, total);
    if (fault === "drop-enrollment") {
      settled = true;
      reservation.apply();
      outgoing.destroy();
      return;
    }

    const tampered = accessStateTamperedBody(
      body,
      response.headers["content-type"],
    );
    settled = true;
    if (tampered === undefined) {
      reservation.release();
      outgoing.writeHead(
        response.statusCode ?? 502,
        responseHeaders(response.headers),
      );
      outgoing.end(body);
      return;
    }
    if (tampered.length > maximumBytes) {
      reservation.release();
      sendNormalizedError(
        outgoing,
        502,
        "upstream_response_too_large",
        "the upstream response exceeded the edge buffer limit",
      );
      return;
    }
    reservation.apply();
    const headers = responseHeaders(
      response.headers,
      new Set(["content-length", "content-md5", "digest", "etag"]),
    );
    headers["content-length"] = String(tampered.length);
    outgoing.writeHead(response.statusCode ?? 502, headers);
    outgoing.end(tampered);
  });
}

export function phase5ProxyClientId(label) {
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(label)
  ) {
    throw new Error("Phase 5 proxy identity label is invalid");
  }
  return `cid_${createHash("sha256").update(label).digest("base64url")}`;
}

export async function startLoopbackAuthenticatedEdge(options) {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new Error("Phase 5 rehearsal edge options are required");
  }
  const target = canonicalTarget(options.targetOrigin);
  if (options.role !== "admin" && options.role !== "employee") {
    throw new Error("Phase 5 rehearsal edge role must be admin or employee");
  }
  assertVisibleProxyToken(options.proxyToken);
  assertCanonicalClientId(options.clientId);
  const maximumBytes = configuredBufferLimit(
    options.maximumBufferedResponseBytes,
  );
  const faultOptions = options.faults ?? {};
  if (
    typeof faultOptions !== "object" ||
    faultOptions === null ||
    Array.isArray(faultOptions)
  ) {
    throw new Error("Phase 5 fault controls must be an object");
  }
  const dropEnrollment = new OneShotFault(
    faultOptions.dropEnrollmentResponseOnce ?? false,
  );
  const tamperAccessState = new OneShotFault(
    faultOptions.tamperAccessStateResponseOnce ?? false,
  );
  const responseCounts = new Map();
  let forwardedRequestCount = 0;
  let strippedCredentialHeaderCount = 0;
  let configuredClientIdentityForwardCount = 0;
  let spoofedClientIdentityReplacementCount = 0;
  let outboundIdentityMismatchCount = 0;

  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (incoming, outgoing) => {
      const method = incoming.method ?? "";
      const path = canonicalRequestTarget(incoming.url);
      if (path === undefined || !routeAllowed(options.role, method, path)) {
        incoming.resume();
        sendNormalizedError(
          outgoing,
          403,
          "edge_route_forbidden",
          "the route is not allowed by this authenticated edge",
        );
        return;
      }

      let fault;
      let reservation;
      if (method === "POST" && path === "/v1/enrollments") {
        reservation = dropEnrollment.reserve();
        if (reservation !== undefined) fault = "drop-enrollment";
      } else if (method === "POST" && path === "/v1/access-leases") {
        reservation = tamperAccessState.reserve();
        if (reservation !== undefined) fault = "tamper-access-state";
      }

      let responseStarted = false;
      strippedCredentialHeaderCount += Object.keys(incoming.headers).filter(
        (name) => isEchoProxyCredentialHeader(name.toLowerCase()),
      ).length;
      forwardedRequestCount += 1;
      const headers = forwardedHeaders(
        incoming.headers,
        target,
        options.proxyToken,
        options.clientId,
      );
      if (headers[TRUSTED_PROXY_CLIENT_ID_HEADER] === options.clientId) {
        configuredClientIdentityForwardCount += 1;
      } else {
        outboundIdentityMismatchCount += 1;
      }
      const incomingClientId = incoming.headers[TRUSTED_PROXY_CLIENT_ID_HEADER];
      if (
        incomingClientId !== undefined &&
        incomingClientId !== options.clientId &&
        headers[TRUSTED_PROXY_CLIENT_ID_HEADER] === options.clientId
      ) {
        spoofedClientIdentityReplacementCount += 1;
      }
      const upstream = httpRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method,
          path: incoming.url,
          headers,
        },
        (response) => {
          responseStarted = true;
          const status = response.statusCode ?? 502;
          const responseKey = `${method}\u0000${path}\u0000${String(status)}`;
          responseCounts.set(
            responseKey,
            (responseCounts.get(responseKey) ?? 0) + 1,
          );
          if (reservation !== undefined && fault !== undefined) {
            proxyBufferedResponse({
              response,
              outgoing,
              reservation,
              fault,
              maximumBytes,
            });
            return;
          }
          outgoing.writeHead(
            response.statusCode ?? 502,
            responseHeaders(response.headers),
          );
          response.once("aborted", () => outgoing.destroy());
          response.once("error", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      upstream.once("error", () => {
        reservation?.release();
        if (responseStarted) return;
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        sendNormalizedError(
          outgoing,
          502,
          "upstream_unavailable",
          "the upstream authority is unavailable",
        );
      });
      upstream.setTimeout(15_000, () =>
        upstream.destroy(new Error("Phase 5 upstream request timed out")),
      );
      incoming.once("aborted", () => upstream.destroy());
      incoming.once("error", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Phase 5 rehearsal edge did not bind a TCP address");
  }
  let closed = null;
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}/`,
    clientId: options.clientId,
    role: options.role,
    faultState: () =>
      Object.freeze({
        dropEnrollmentResponseOnce: dropEnrollment.snapshot(),
        tamperAccessStateResponseOnce: tamperAccessState.snapshot(),
      }),
    responseCount: (method, path, status) => {
      if (
        typeof method !== "string" ||
        typeof path !== "string" ||
        !Number.isSafeInteger(status) ||
        status < 100 ||
        status > 599
      ) {
        throw new Error("Phase 5 response-count query is invalid");
      }
      return (
        responseCounts.get(`${method}\u0000${path}\u0000${String(status)}`) ?? 0
      );
    },
    securityState: () =>
      Object.freeze({
        forwardedRequestCount,
        strippedCredentialHeaderCount,
        configuredClientIdentityForwardCount,
        spoofedClientIdentityReplacementCount,
        outboundIdentityMismatchCount,
      }),
    close: () => {
      if (closed !== null) return closed;
      closed = new Promise((resolve, reject) => {
        const rejectUnconfirmed = () => {
          const error = new Error(
            "Phase 5 rehearsal edge close was not confirmed",
          );
          error.code = "OWNED_PROCESS_EXIT_UNCONFIRMED";
          reject(error);
        };
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectUnconfirmed();
        }, 10_000);
        timer.unref?.();
        server.close((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error === undefined ? resolve() : rejectUnconfirmed();
        });
        server.closeAllConnections();
      });
      return closed;
    },
  });
}
