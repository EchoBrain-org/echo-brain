/**
 * Reconcile a single remotely-managed Cloudflare Tunnel staging edge.
 *
 * This is a library boundary called only by the public lifecycle controller,
 * which owns the Cloudflare management-token resolution boundary. The connector
 * token is fetched only by install-token and is handed directly, in memory, to
 * an injected secret writer. Reconcile may prepare an unexposed Tunnel, but
 * never creates DNS: install-token writes the connector token before publishing
 * the owned CNAME.
 */

import { createHash } from "node:crypto";

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

async function cloudflareRequest(fetchImpl, input, stage, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  } catch {
    refuse(`cloudflare_${stage}_unavailable`);
  }
  if (!response || typeof response.ok !== "boolean" || !response.ok)
    refuse(`cloudflare_${stage}_failed`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    refuse(`cloudflare_${stage}_response_invalid`);
  }
  if (!payload || payload.success !== true || !("result" in payload))
    refuse(`cloudflare_${stage}_response_invalid`);
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
  if (
    typeof tunnel.id !== "string" ||
    !TUNNEL_ID.test(tunnel.id) ||
    !isRemotelyManagedTunnel(tunnel)
  ) {
    refuse("cloudflare_tunnel_conflict");
  }
  return Object.freeze({ id: tunnel.id });
}

function isRemotelyManagedTunnel(value) {
  if (value.config_src !== undefined && value.config_src !== "cloudflare")
    return false;
  if (value.remote_config !== undefined && value.remote_config !== true)
    return false;
  return value.config_src === "cloudflare" || value.remote_config === true;
}

async function findTunnel(fetchImpl, input) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_list",
    endpoint(`/accounts/${input.accountId}/cfd_tunnel`, {
      is_deleted: "false",
      name: input.tunnelName,
      per_page: "1000",
    }),
  );
  return tunnelFromList(result, input);
}

async function createTunnel(fetchImpl, input) {
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
  );
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.id !== "string" ||
    !TUNNEL_ID.test(result.id) ||
    result.name !== input.tunnelName ||
    !isRemotelyManagedTunnel(result)
  ) {
    refuse("cloudflare_tunnel_create_response_invalid");
  }
  return Object.freeze({ id: result.id });
}

async function ensureTunnel(fetchImpl, input, create) {
  const existing = await findTunnel(fetchImpl, input);
  if (existing !== undefined)
    return Object.freeze({ ...existing, created: false });
  if (!create) return undefined;
  const created = await createTunnel(fetchImpl, input);
  return Object.freeze({ ...created, created: true });
}

async function configureTunnel(fetchImpl, input, tunnel) {
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
  const record = matches[0];
  const target = `${tunnel.id}.cfargotunnel.com`;
  if (
    record.type !== "CNAME" ||
    record.content !== target ||
    record.proxied !== true ||
    record.comment !== ownershipComment(input.slotId)
  ) {
    refuse("cloudflare_dns_conflict");
  }
  return Object.freeze({
    id: typeof record.id === "string" ? record.id : undefined,
  });
}

async function findDnsRecord(fetchImpl, input, tunnel) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "dns_list",
    endpoint(`/zones/${input.zoneId}/dns_records`, { name: input.hostname }),
  );
  return dnsFromList(result, input, tunnel);
}

async function createDnsRecord(fetchImpl, input, tunnel) {
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
  );
  if (
    !result ||
    typeof result !== "object" ||
    result.type !== "CNAME" ||
    result.name !== input.hostname ||
    result.content !== `${tunnel.id}.cfargotunnel.com` ||
    result.proxied !== true ||
    result.comment !== ownershipComment(input.slotId)
  ) {
    refuse("cloudflare_dns_create_response_invalid");
  }
}

async function ensureDnsRecord(fetchImpl, input, tunnel, create) {
  const existing = await findDnsRecord(fetchImpl, input, tunnel);
  if (existing !== undefined) return false;
  if (!create) return undefined;
  await createDnsRecord(fetchImpl, input, tunnel);
  return true;
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

async function readTunnelConfiguration(fetchImpl, input, tunnel) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "tunnel_configuration",
    endpoint(
      `/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
    ),
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

async function tunnelConfigurationState(fetchImpl, input, tunnel) {
  if (tunnel.created) return "empty";
  return readTunnelConfiguration(fetchImpl, input, tunnel);
}

async function fetchConnectorToken(fetchImpl, input, tunnel) {
  const result = await cloudflareRequest(
    fetchImpl,
    input,
    "connector_token",
    endpoint(`/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/token`),
  );
  if (typeof result !== "string" || result.length < 16 || /[\r\n]/.test(result))
    refuse("cloudflare_connector_token_response_invalid");
  return result;
}

/**
 * Prepare the remote Tunnel and exact ingress configuration. This command never
 * creates DNS because it has no secret writer; a missing CNAME is intentionally
 * reported as incomplete until install-token writes the connector token first.
 */
export async function reconcileStagingEdge(
  rawInput,
  { fetchImpl = globalThis.fetch } = {},
) {
  const input = validateStagingEdgeInput(rawInput);
  if (typeof fetchImpl !== "function") refuse("fetch_unavailable");
  const tunnel = await ensureTunnel(fetchImpl, input, true);
  const configuration = await tunnelConfigurationState(
    fetchImpl,
    input,
    tunnel,
  );
  const dns = await ensureDnsRecord(fetchImpl, input, tunnel, false);
  if (configuration === "empty")
    await configureTunnel(fetchImpl, input, tunnel);
  return receipt(
    input,
    "reconcile",
    dns === undefined ? "incomplete" : "ready",
    {
      tunnel_created: tunnel.created,
      tunnel_configured: true,
      dns_created: false,
      dns_configured: dns !== undefined,
    },
  );
}

/** Check the edge without creating a tunnel, DNS record, or connector token. */
export async function stagingEdgeStatus(
  rawInput,
  { fetchImpl = globalThis.fetch } = {},
) {
  const input = validateStagingEdgeInput(rawInput);
  if (typeof fetchImpl !== "function") refuse("fetch_unavailable");
  const tunnel = await ensureTunnel(fetchImpl, input, false);
  if (tunnel === undefined)
    return receipt(input, "status", "absent", { ready: false });
  if ((await readTunnelConfiguration(fetchImpl, input, tunnel)) === "empty")
    return receipt(input, "status", "incomplete", { ready: false });
  const dns = await ensureDnsRecord(fetchImpl, input, tunnel, false);
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
  { fetchImpl = globalThis.fetch, putSecretValue } = {},
) {
  const input = validateStagingEdgeInput(rawInput);
  if (typeof fetchImpl !== "function") refuse("fetch_unavailable");
  if (typeof putSecretValue !== "function") refuse("secret_writer_required");
  const tunnel = await ensureTunnel(fetchImpl, input, true);
  const configuration = await tunnelConfigurationState(
    fetchImpl,
    input,
    tunnel,
  );
  const existingDns = await findDnsRecord(fetchImpl, input, tunnel);
  if (configuration === "empty")
    await configureTunnel(fetchImpl, input, tunnel);
  const token = await fetchConnectorToken(fetchImpl, input, tunnel);
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
  if (dnsCreated) await createDnsRecord(fetchImpl, input, tunnel);
  return receipt(input, "install-token", "ready", {
    tunnel_created: tunnel.created,
    tunnel_configured: true,
    dns_created: dnsCreated,
    dns_configured: true,
    connector_token_installed: true,
  });
}
