/**
 * Install and inspect one remotely-managed Cloudflare Tunnel staging edge.
 *
 * This is a library boundary called only by the public lifecycle controller,
 * which owns the Cloudflare management-token resolution boundary. The connector
 * token is fetched only by install-token and is handed directly, in memory, to
 * an injected secret writer. Install-token prepares the Tunnel, writes the
 * connector token, then publishes the owned CNAME in one crash-safe operation.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const API_BASE = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TUNNEL_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const OPERATION_ID = /^staging-[a-z0-9][a-z0-9-]{7,63}$/;
const SLOT_ID = /^staging-[a-z0-9][a-z0-9-]{7,39}$/;
const SECRET_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const TUNNEL_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ORIGIN = "http://127.0.0.1:80";
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000;
const CLOUDFLARE_RESPONSE_MAX_BYTES = 256 * 1024;
const CLOUDFLARE_REQUEST_TIMEOUT_MAX_MS = 60_000;
const CLOUDFLARE_RESPONSE_MAX_MAX_BYTES = 4 * 1024 * 1024;

class EdgeError extends Error {
  constructor(code) {
    super(`authority staging edge refused: ${code}`);
    this.code = code;
  }
}

function refuse(code) {
  throw new EdgeError(code);
}

function exactString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) refuse(code);
  return value;
}

function safeApiToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4096 ||
    /[\r\n]/.test(value) ||
    value.includes("{{resolve:")
  ) {
    refuse("cloudflare_api_token_invalid");
  }
  return value;
}

export function validateStagingEdgeInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    refuse("input_invalid");
  const value = input;
  const allowedKeys = new Set([
    "accountId",
    "apiToken",
    "hostname",
    "operationId",
    "secretArn",
    "slotId",
    "zoneId",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    refuse("input_property_not_allowed");
  const accountId = exactString(
    value.accountId,
    ACCOUNT_ID,
    "account_id_invalid",
  ).toLowerCase();
  const zoneId = exactString(
    value.zoneId,
    ACCOUNT_ID,
    "zone_id_invalid",
  ).toLowerCase();
  const hostname = exactString(
    value.hostname,
    DNS_NAME,
    "hostname_invalid",
  ).toLowerCase();
  const operationId = exactString(
    value.operationId,
    OPERATION_ID,
    "operation_id_invalid",
  );
  const slotId = exactString(value.slotId, SLOT_ID, "slot_id_invalid");
  const tunnelName = exactString(
    `echo-authority-${slotId}`,
    TUNNEL_NAME,
    "tunnel_name_invalid",
  );
  const secretArn = exactString(
    value.secretArn,
    SECRET_ARN,
    "secret_arn_invalid",
  );
  const apiToken = safeApiToken(value.apiToken);
  return Object.freeze({
    accountId,
    apiToken,
    hostname,
    operationId,
    secretArn,
    slotId,
    tunnelName,
    zoneId,
  });
}

function ownershipComment(slotId) {
  return `echo-brain staging edge ${slotId}`;
}

function secretWriteRequestToken(tunnelId, operationId) {
  return createHash("sha256")
    .update(`${tunnelId}:${operationId}`, "utf8")
    .digest("hex");
}

function expectedIngress(hostname) {
  return [
    { hostname, service: ORIGIN, originRequest: {} },
    { service: "http_status:404" },
  ];
}

function hasExactlyKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasExpectedIngress(value, hostname) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [origin, fallback] = value;
  return (
    hasExactlyKeys(origin, ["hostname", "originRequest", "service"]) &&
    origin.hostname === hostname &&
    origin.service === ORIGIN &&
    hasExactlyKeys(origin.originRequest, []) &&
    hasExactlyKeys(fallback, ["service"]) &&
    fallback.service === "http_status:404"
  );
}

function receipt(input, action, state, extra = {}) {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-authority-staging-edge-v1",
    action,
    state,
    hostname: input.hostname,
    tunnel_name: input.tunnelName,
    operation_id: input.operationId,
    ...extra,
  });
}

function endpoint(path, query = undefined) {
  const url = new URL(`${API_BASE}${path}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
  }
  return url.toString();
}

function boundedLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    refuse("request_limit_invalid");
  return value;
}

function requestBounds({ maxResponseBytes, requestTimeoutMs } = {}) {
  return Object.freeze({
    maxResponseBytes: boundedLimit(
      maxResponseBytes,
      CLOUDFLARE_RESPONSE_MAX_BYTES,
      CLOUDFLARE_RESPONSE_MAX_MAX_BYTES,
    ),
    requestTimeoutMs: boundedLimit(
      requestTimeoutMs,
      CLOUDFLARE_REQUEST_TIMEOUT_MS,
      CLOUDFLARE_REQUEST_TIMEOUT_MAX_MS,
    ),
  });
}

function requestWithinDeadline(promise, timeoutMs, controller) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        controller.abort();
        rejectPromise(new EdgeError("request_deadline_exceeded"));
      },
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function boundedJsonResponse(response, maxResponseBytes, signal) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    typeof contentLength === "string" &&
    /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > maxResponseBytes
  ) {
    throw new EdgeError("response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) throw new EdgeError("response_nonstreaming");
  const chunks = [];
  let total = 0;
  let complete = false;
  let cancellation;
  const cancelReader = () => {
    cancellation ??= Promise.resolve(reader.cancel?.()).catch(() => {});
    return cancellation;
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next?.done === true) break;
      if (!(next?.value instanceof Uint8Array))
        throw new EdgeError("response_invalid");
      total += next.value.byteLength;
      if (total > maxResponseBytes) throw new EdgeError("response_too_large");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!complete) await cancelReader();
    try {
      reader.releaseLock?.();
    } catch {
      // The reader is no longer used after this request.
    }
  }
}

async function cloudflareRequest(
  fetchImpl,
  input,
  stage,
  url,
  options = {},
  bounds = requestBounds(),
) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const remaining = () =>
    Math.max(1, bounds.requestTimeoutMs - (performance.now() - startedAt));
  let response;
  try {
    response = await requestWithinDeadline(
      Promise.resolve().then(() =>
        fetchImpl(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${input.apiToken}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
        }),
      ),
      remaining(),
      controller,
    );
  } catch {
    controller.abort();
    refuse(`cloudflare_${stage}_unavailable`);
  }
  if (!response || typeof response.ok !== "boolean" || !response.ok) {
    controller.abort();
    refuse(`cloudflare_${stage}_failed`);
  }
  let payload;
  try {
    payload = await requestWithinDeadline(
      boundedJsonResponse(response, bounds.maxResponseBytes, controller.signal),
      remaining(),
      controller,
    );
  } catch {
    controller.abort();
    refuse(`cloudflare_${stage}_response_invalid`);
  }
  if (!payload || payload.success !== true || !("result" in payload)) {
    controller.abort();
    refuse(`cloudflare_${stage}_response_invalid`);
  }
  return payload.result;
}

function tunnelFromList(result, input) {
  if (!Array.isArray(result)) refuse("cloudflare_tunnel_list_response_invalid");
  const matches = result.filter(
    (entry) =>
      entry && typeof entry === "object" && entry.name === input.tunnelName,
  );
  if (matches.length > 1) refuse("cloudflare_tunnel_duplicate");
  if (matches.length === 0) return undefined;
  const tunnel = matches[0];
  if (!isOwnedTunnel(tunnel, input)) refuse("cloudflare_tunnel_conflict");
  return Object.freeze({ id: tunnel.id });
}

function isRemotelyManagedTunnel(value) {
  if (value.config_src !== undefined && value.config_src !== "cloudflare")
    return false;
  if (value.remote_config !== undefined && value.remote_config !== true)
    return false;
  return value.config_src === "cloudflare" || value.remote_config === true;
}

function isOwnedTunnel(value, input) {
  return (
    value &&
    typeof value === "object" &&
    value.name === input.tunnelName &&
    typeof value.id === "string" &&
    TUNNEL_ID.test(value.id) &&
    isRemotelyManagedTunnel(value)
  );
}

async function findTunnel(fetchImpl, input, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_list",
    endpoint(`/accounts/${input.accountId}/cfd_tunnel`, {
      is_deleted: "false",
      name: input.tunnelName,
      per_page: "1000",
    }),
    {},
    bounds,
  );
  return tunnelFromList(result, input);
}

async function createTunnel(fetchImpl, input, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_create",
    endpoint(`/accounts/${input.accountId}/cfd_tunnel`),
    {
      method: "POST",
      body: JSON.stringify({
        name: input.tunnelName,
        config_src: "cloudflare",
      }),
    },
    bounds,
  );
  if (!isOwnedTunnel(result, input))
    refuse("cloudflare_tunnel_create_response_invalid");
  return Object.freeze({ id: result.id });
}

async function ensureTunnel(fetchImpl, input, create, bounds) {
  const existing = await findTunnel(fetchImpl, input, bounds);
  if (existing !== undefined)
    return Object.freeze({ ...existing, created: false });
  if (!create) return undefined;
  const created = await createTunnel(fetchImpl, input, bounds);
  return Object.freeze({ ...created, created: true });
}

async function configureTunnel(fetchImpl, input, tunnel, bounds) {
  await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_configure",
    endpoint(
      `/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
    ),
    {
      method: "PUT",
      body: JSON.stringify({
        config: { ingress: expectedIngress(input.hostname) },
      }),
    },
    bounds,
  );
}

function dnsFromList(result, input, tunnel) {
  if (!Array.isArray(result)) refuse("cloudflare_dns_list_response_invalid");
  const matches = result.filter(
    (entry) =>
      entry && typeof entry === "object" && entry.name === input.hostname,
  );
  if (matches.length > 1) refuse("cloudflare_dns_duplicate");
  if (matches.length === 0) return undefined;
  if (!isOwnedDnsRecord(matches[0], input, tunnel))
    refuse("cloudflare_dns_conflict");
  return true;
}

function isOwnedDnsRecord(value, input, tunnel) {
  return (
    value &&
    typeof value === "object" &&
    value.type === "CNAME" &&
    value.name === input.hostname &&
    value.content === `${tunnel.id}.cfargotunnel.com` &&
    value.proxied === true &&
    value.comment === ownershipComment(input.slotId)
  );
}

async function findDnsRecord(fetchImpl, input, tunnel, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "dns_list",
    endpoint(`/zones/${input.zoneId}/dns_records`, { name: input.hostname }),
    {},
    bounds,
  );
  return dnsFromList(result, input, tunnel);
}

async function createDnsRecord(fetchImpl, input, tunnel, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "dns_create",
    endpoint(`/zones/${input.zoneId}/dns_records`),
    {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: input.hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
        comment: ownershipComment(input.slotId),
      }),
    },
    bounds,
  );
  if (!isOwnedDnsRecord(result, input, tunnel))
    refuse("cloudflare_dns_create_response_invalid");
}

function isEmptyTunnelConfiguration(result) {
  if (!Object.hasOwn(result, "config")) return true;
  const config = result.config;
  return (
    hasExactlyKeys(config, []) ||
    (hasExactlyKeys(config, ["ingress"]) &&
      Array.isArray(config.ingress) &&
      config.ingress.length === 0)
  );
}

async function readTunnelConfiguration(fetchImpl, input, tunnel, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_configuration",
    endpoint(
      `/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
    ),
    {},
    bounds,
  );
  if (!result || typeof result !== "object")
    refuse("cloudflare_tunnel_configuration_conflict");
  if (
    result.config &&
    typeof result.config === "object" &&
    hasExpectedIngress(result.config.ingress, input.hostname)
  ) {
    return "exact";
  }
  if (isEmptyTunnelConfiguration(result)) return "empty";
  refuse("cloudflare_tunnel_configuration_conflict");
}

async function tunnelConfigurationState(fetchImpl, input, tunnel, bounds) {
  if (tunnel.created) return "empty";
  return readTunnelConfiguration(fetchImpl, input, tunnel, bounds);
}

async function fetchConnectorToken(fetchImpl, input, tunnel, bounds) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "connector_token",
    endpoint(`/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/token`),
    {},
    bounds,
  );
  if (typeof result !== "string" || result.length < 16 || /[\r\n]/.test(result))
    refuse("cloudflare_connector_token_response_invalid");
  return result;
}

/** Check the edge without creating a tunnel, DNS record, or connector token. */
export async function stagingEdgeStatus(
  rawInput,
  { fetchImpl = globalThis.fetch, maxResponseBytes, requestTimeoutMs } = {},
) {
  const input = validateStagingEdgeInput(rawInput);
  if (typeof fetchImpl !== "function") refuse("fetch_unavailable");
  const bounds = requestBounds({ maxResponseBytes, requestTimeoutMs });
  const tunnel = await ensureTunnel(fetchImpl, input, false, bounds);
  if (tunnel === undefined)
    return receipt(input, "status", "absent", { ready: false });
  if (
    (await readTunnelConfiguration(fetchImpl, input, tunnel, bounds)) === "empty"
  )
    return receipt(input, "status", "incomplete", { ready: false });
  const dns = await findDnsRecord(fetchImpl, input, tunnel, bounds);
  if (dns === undefined)
    return receipt(input, "status", "incomplete", { ready: false });
  return receipt(input, "status", "ready", { ready: true });
}

/**
 * Fetch the connector token, hand it directly to a supplied write-only secret
 * adapter, then publish the owned CNAME. Existing tunnel configuration is
 * validated and never overwritten. This module intentionally ships no AWS SDK
 * dependency; the production adapter belongs to the later host slice.
 */
export async function installStagingEdgeToken(
  rawInput,
  {
    fetchImpl = globalThis.fetch,
    maxResponseBytes,
    putSecretValue,
    requestTimeoutMs,
  } = {},
) {
  const input = validateStagingEdgeInput(rawInput);
  if (typeof fetchImpl !== "function") refuse("fetch_unavailable");
  if (typeof putSecretValue !== "function") refuse("secret_writer_required");
  const bounds = requestBounds({ maxResponseBytes, requestTimeoutMs });
  const tunnel = await ensureTunnel(fetchImpl, input, true, bounds);
  const configuration = await tunnelConfigurationState(
    fetchImpl,
    input,
    tunnel,
    bounds,
  );
  const existingDns = await findDnsRecord(fetchImpl, input, tunnel, bounds);
  if (configuration === "empty")
    await configureTunnel(fetchImpl, input, tunnel, bounds);
  const token = await fetchConnectorToken(fetchImpl, input, tunnel, bounds);
  try {
    await putSecretValue({
      clientRequestToken: secretWriteRequestToken(tunnel.id, input.operationId),
      secretArn: input.secretArn,
      secretString: token,
    });
  } catch {
    refuse("secret_write_failed");
  }
  const dnsCreated = existingDns === undefined;
  if (dnsCreated) await createDnsRecord(fetchImpl, input, tunnel, bounds);
  return receipt(input, "install-token", "ready", {
    tunnel_created: tunnel.created,
    tunnel_configured: true,
    dns_created: dnsCreated,
    dns_configured: true,
    connector_token_installed: true,
  });
}
