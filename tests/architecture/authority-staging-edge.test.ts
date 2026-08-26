import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  installStagingEdgeToken,
  reconcileStagingEdge,
  stagingEdgeStatus,
} from "../../tools/authority-staging-edge.mjs";

const INPUT = Object.freeze({
  accountId: "a".repeat(32),
  zoneId: "b".repeat(32),
  hostname: "staging.example.com",
  tunnelName: "echo-staging-green",
  secretArn:
    "arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/tunnel-abc",
  slotId: "staging-green-slot",
  operationId: "staging-green-20260826",
  apiToken: "cf-api-token-not-a-real-secret",
});
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
const CONNECTOR_TOKEN = "connector-token-not-a-real-secret";

function response(result: unknown, ok = true) {
  return { ok, json: async () => ({ success: ok, result }) };
}

function expectedConfiguration() {
  return {
    ingress: [
      {
        hostname: INPUT.hostname,
        service: "http://127.0.0.1:80",
        originRequest: {},
      },
      { service: "http_status:404" },
    ],
  };
}

function edgeFetch(
  options: {
    readonly tunnel?: unknown[];
    readonly dns?: unknown[];
    readonly configuration?: unknown;
  } = {},
) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const events: string[] = [];
  const tunnel = options.tunnel ?? [];
  const dns = options.dns ?? [];
  const configuration = options.configuration ?? expectedConfiguration();
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    const method = (init.method as string | undefined) ?? "GET";
    const path = new URL(url).pathname;
    events.push(`${method} ${path}`);
    if (url.includes("/cfd_tunnel?") && init.method === undefined)
      return response(tunnel);
    if (url.endsWith("/cfd_tunnel") && init.method === "POST")
      return response({
        id: TUNNEL_ID,
        name: INPUT.tunnelName,
        remote_config: true,
      });
    if (
      url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`) &&
      init.method === "PUT"
    )
      return response({});
    if (url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`))
      return response({ config: configuration });
    if (url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/token`))
      return response(CONNECTOR_TOKEN);
    if (url.includes("/dns_records?") && init.method === undefined)
      return response(dns);
    if (url.endsWith("/dns_records") && init.method === "POST")
      return response({
        id: "dns-record-id",
        type: "CNAME",
        name: INPUT.hostname,
        content: `${TUNNEL_ID}.cfargotunnel.com`,
        proxied: true,
        comment: `echo-brain staging edge ${INPUT.slotId}`,
      });
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, events, fetchImpl };
}

function configuredTunnel() {
  return [{ id: TUNNEL_ID, name: INPUT.tunnelName, config_src: "cloudflare" }];
}

function configuredDns() {
  return [
    {
      id: "dns-record-id",
      type: "CNAME",
      name: INPUT.hostname,
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
      comment: `echo-brain staging edge ${INPUT.slotId}`,
    },
  ];
}

describe("Authority staging Cloudflare edge", () => {
  it("prepares a missing tunnel without publishing a DNS route", async () => {
    const { calls, fetchImpl } = edgeFetch();
    const result = await reconcileStagingEdge(INPUT, { fetchImpl });

    expect(result).toMatchObject({
      action: "reconcile",
      state: "incomplete",
      tunnel_created: true,
      tunnel_configured: true,
      dns_created: false,
      dns_configured: false,
    });
    expect(JSON.stringify(result)).not.toContain(INPUT.apiToken);
    expect(JSON.stringify(result)).not.toContain(CONNECTOR_TOKEN);
    expect(calls).toHaveLength(4);
    expect(new URL(calls[0]!.url).searchParams.get("name")).toBe(
      INPUT.tunnelName,
    );
    expect(calls[1]!.init.body).toBe(
      JSON.stringify({ name: INPUT.tunnelName, config_src: "cloudflare" }),
    );
    expect(calls[2]!.init.body).toBe(
      JSON.stringify({ config: expectedConfiguration() }),
    );
    expect(new URL(calls[3]!.url).pathname).toBe(
      `/client/v4/zones/${INPUT.zoneId}/dns_records`,
    );
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/dns_records") && call.init.method === "POST",
      ),
    ).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/token"))).toBe(false);
  });

  it("validates an existing edge without overwriting its remote ingress", async () => {
    const { calls, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      dns: configuredDns(),
    });
    const result = await reconcileStagingEdge(INPUT, { fetchImpl });

    expect(result).toMatchObject({ state: "ready", tunnel_created: false });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain("/configurations");
    expect(calls[1]!.init.method).toBeUndefined();
    expect(calls.some((call) => call.init.method === "PUT")).toBe(false);
    expect(calls.some((call) => call.init.method === "POST")).toBe(false);
  });

  it("accepts Cloudflare's current remote_config response and rejects contradictory management mode", async () => {
    const currentResponse = edgeFetch({
      tunnel: [
        {
          id: TUNNEL_ID,
          name: INPUT.tunnelName,
          remote_config: true,
        },
      ],
      dns: configuredDns(),
    });
    await expect(
      reconcileStagingEdge(INPUT, { fetchImpl: currentResponse.fetchImpl }),
    ).resolves.toMatchObject({ state: "ready", tunnel_created: false });

    const contradictory = edgeFetch({
      tunnel: [
        {
          id: TUNNEL_ID,
          name: INPUT.tunnelName,
          config_src: "cloudflare",
          remote_config: false,
        },
      ],
    });
    await expect(
      reconcileStagingEdge(INPUT, { fetchImpl: contradictory.fetchImpl }),
    ).rejects.toThrow("cloudflare_tunnel_conflict");
  });

  it("refuses existing ingress drift instead of overwriting it", async () => {
    const { calls, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      configuration: { ingress: [{ service: "http_status:418" }] },
    });
    await expect(reconcileStagingEdge(INPUT, { fetchImpl })).rejects.toThrow(
      "cloudflare_tunnel_configuration_conflict",
    );
    expect(calls.some((call) => call.init.method === "PUT")).toBe(false);
  });

  it("compares ingress semantically while rejecting unexpected rules and keys", async () => {
    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: edgeFetch({
          tunnel: configuredTunnel(),
          dns: configuredDns(),
          configuration: {
            ingress: [
              {
                service: "http://127.0.0.1:80",
                hostname: INPUT.hostname,
                originRequest: {},
              },
              { service: "http_status:404" },
            ],
          },
        }).fetchImpl,
      }),
    ).resolves.toMatchObject({ state: "ready" });

    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: edgeFetch({
          tunnel: configuredTunnel(),
          configuration: {
            ingress: [
              {
                hostname: INPUT.hostname,
                service: "http://127.0.0.1:80",
                originRequest: {},
                unexpected: true,
              },
              { service: "http_status:404" },
            ],
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_tunnel_configuration_conflict");
  });

  it("fails closed on duplicate or conflicting existing names", async () => {
    await expect(
      reconcileStagingEdge(INPUT, {
        fetchImpl: edgeFetch({
          tunnel: [...configuredTunnel(), ...configuredTunnel()],
        }).fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_tunnel_duplicate");

    await expect(
      reconcileStagingEdge(INPUT, {
        fetchImpl: edgeFetch({
          tunnel: configuredTunnel(),
          dns: [{ ...configuredDns()[0], proxied: false }],
        }).fetchImpl,
      }),
    ).rejects.toThrow("cloudflare_dns_conflict");
  });

  it("checks exact configuration without creating resources or fetching a connector token", async () => {
    const { calls, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      dns: configuredDns(),
    });
    const result = await stagingEdgeStatus(INPUT, { fetchImpl });

    expect(result).toMatchObject({
      action: "status",
      state: "ready",
      ready: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.url.endsWith("/token"))).toBe(false);
    expect(
      calls.some(
        (call) => call.init.method === "POST" || call.init.method === "PUT",
      ),
    ).toBe(false);
  });

  it("writes an operation-stable token before publishing DNS", async () => {
    const noWriter = edgeFetch();
    await expect(
      installStagingEdgeToken(INPUT, { fetchImpl: noWriter.fetchImpl }),
    ).rejects.toThrow("secret_writer_required");
    expect(noWriter.calls).toHaveLength(0);

    const { calls, events, fetchImpl } = edgeFetch();
    const writes: unknown[] = [];
    const result = await installStagingEdgeToken(INPUT, {
      fetchImpl,
      putSecretValue: async (value) => {
        events.push("secret write");
        writes.push(value);
      },
    });

    expect(result).toMatchObject({
      action: "install-token",
      state: "ready",
      connector_token_installed: true,
      dns_created: true,
    });
    expect(events).toEqual([
      `GET /client/v4/accounts/${INPUT.accountId}/cfd_tunnel`,
      `POST /client/v4/accounts/${INPUT.accountId}/cfd_tunnel`,
      `PUT /client/v4/accounts/${INPUT.accountId}/cfd_tunnel/${TUNNEL_ID}/configurations`,
      `GET /client/v4/zones/${INPUT.zoneId}/dns_records`,
      `GET /client/v4/accounts/${INPUT.accountId}/cfd_tunnel/${TUNNEL_ID}/token`,
      "secret write",
      `POST /client/v4/zones/${INPUT.zoneId}/dns_records`,
    ]);
    expect(writes).toEqual([
      {
        clientRequestToken: createHash("sha256")
          .update(`${TUNNEL_ID}:${INPUT.operationId}`, "utf8")
          .digest("hex"),
        secretArn: INPUT.secretArn,
        secretString: CONNECTOR_TOKEN,
      },
    ]);
    expect(calls[5]!.init.body).toBe(
      JSON.stringify({
        type: "CNAME",
        name: INPUT.hostname,
        content: `${TUNNEL_ID}.cfargotunnel.com`,
        proxied: true,
        comment: `echo-brain staging edge ${INPUT.slotId}`,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(CONNECTOR_TOKEN);
    expect(JSON.stringify(result)).not.toContain(INPUT.apiToken);
  });

  it("refuses a foreign hostname before mutating its connector secret", async () => {
    const { events, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      dns: [{ ...configuredDns()[0], comment: "owned by someone else" }],
    });
    await expect(
      installStagingEdgeToken(INPUT, {
        fetchImpl,
        putSecretValue: async () => {
          events.push("secret write");
        },
      }),
    ).rejects.toThrow("cloudflare_dns_conflict");
    expect(events.some((event) => event.endsWith("/token"))).toBe(false);
    expect(events).not.toContain("secret write");
    expect(
      events.some((event) => event.startsWith("POST /client/v4/zones/")),
    ).toBe(false);
  });

  it("uses the same request token for retries but rotates it for a later operation", async () => {
    const writes: Array<{ clientRequestToken: string }> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { fetchImpl } = edgeFetch({
        tunnel: configuredTunnel(),
        dns: configuredDns(),
      });
      await installStagingEdgeToken(INPUT, {
        fetchImpl,
        putSecretValue: async (value) => {
          writes.push(value as { clientRequestToken: string });
        },
      });
    }
    expect(
      writes.map((write) => ({ clientRequestToken: write.clientRequestToken })),
    ).toEqual([
      {
        clientRequestToken: createHash("sha256")
          .update(`${TUNNEL_ID}:${INPUT.operationId}`, "utf8")
          .digest("hex"),
      },
      {
        clientRequestToken: createHash("sha256")
          .update(`${TUNNEL_ID}:${INPUT.operationId}`, "utf8")
          .digest("hex"),
      },
    ]);

    const { fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      dns: configuredDns(),
    });
    await installStagingEdgeToken(
      { ...INPUT, operationId: "staging-green-20260827" },
      {
        fetchImpl,
        putSecretValue: async (value) => {
          writes.push(value as { clientRequestToken: string });
        },
      },
    );
    expect(writes[2]?.clientRequestToken).toBe(
      createHash("sha256")
        .update(`${TUNNEL_ID}:staging-green-20260827`, "utf8")
        .digest("hex"),
    );
    expect(writes[2]?.clientRequestToken).not.toBe(
      writes[0]?.clientRequestToken,
    );
  });

  it("rejects unresolved dynamic references and does not reflect secret-bearing failures", async () => {
    await expect(
      reconcileStagingEdge(
        { ...INPUT, apiToken: "{{resolve:secretsmanager:edge/api}}" },
        { fetchImpl: edgeFetch().fetchImpl },
      ),
    ).rejects.toThrow("cloudflare_api_token_invalid");

    const { fetchImpl } = edgeFetch();
    await expect(
      reconcileStagingEdge(INPUT, {
        fetchImpl: async (...args) => {
          const value = await fetchImpl(...args);
          if (args[0].endsWith("/cfd_tunnel"))
            return { ok: false, json: value.json };
          return value;
        },
      }),
    ).rejects.not.toThrow(CONNECTOR_TOKEN);

    await expect(
      installStagingEdgeToken(INPUT, {
        fetchImpl: edgeFetch({ tunnel: configuredTunnel() }).fetchImpl,
        putSecretValue: async () => {
          throw new Error(CONNECTOR_TOKEN);
        },
      }),
    ).rejects.not.toThrow(CONNECTOR_TOKEN);
  });

  it("uses stable slot ownership across new operation IDs", async () => {
    const { calls, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      dns: configuredDns(),
    });
    await expect(
      stagingEdgeStatus(
        { ...INPUT, operationId: "staging-green-20260827" },
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ state: "ready" });
    expect(calls).toHaveLength(3);
  });
});
