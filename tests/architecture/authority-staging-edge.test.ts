import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  installStagingEdgeToken,
  stagingEdgeStatus,
  validateStagingEdgeInput,
} from "../../tools/authority-staging-edge.mjs";
import type {
  FetchLike,
  StagingEdgeInput,
} from "../../tools/authority-staging-edge.mjs";

const INPUT = Object.freeze({
  accountId: "a".repeat(32),
  zoneId: "b".repeat(32),
  hostname: "staging.example.com",
  secretArn:
    "arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/tunnel-abc",
  slotId: "staging-green-slot",
  operationId: "staging-green-20260826",
  apiToken: "cf-api-token-not-a-real-secret",
});
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
const CONNECTOR_TOKEN = "connector-token-not-a-real-secret";
const TUNNEL_NAME = `echo-authority-${INPUT.slotId}`;

function response(result: unknown, ok = true) {
  const payload = { success: ok, result };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
      }),
    },
    ok,
    json: async () => payload,
  };
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
    readonly tunnel?: readonly unknown[];
    readonly dns?: readonly unknown[];
    readonly configuration?: unknown;
    readonly createdTunnel?: unknown;
    readonly createdDns?: unknown;
  } = {},
) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const events: string[] = [];
  const tunnel = options.tunnel ?? [];
  const dns = options.dns ?? [];
  const configuration = Object.hasOwn(options, "configuration")
    ? options.configuration
    : expectedConfiguration();
  const createdTunnel = Object.hasOwn(options, "createdTunnel")
    ? options.createdTunnel
    : { id: TUNNEL_ID, name: TUNNEL_NAME, remote_config: true };
  const createdDns = Object.hasOwn(options, "createdDns")
    ? options.createdDns
    : ownedDns();
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    const method = (init.method as string | undefined) ?? "GET";
    const path = new URL(url).pathname;
    events.push(`${method} ${path}`);
    if (url.includes("/cfd_tunnel?") && init.method === undefined)
      return response(tunnel);
    if (url.endsWith("/cfd_tunnel") && init.method === "POST")
      return response(createdTunnel);
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
      return response(createdDns);
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, events, fetchImpl };
}

function configuredTunnel() {
  return [{ id: TUNNEL_ID, name: TUNNEL_NAME, config_src: "cloudflare" }];
}

function configuredDns() {
  return [ownedDns()];
}

function ownedDns() {
  return {
    id: "dns-record-id",
    type: "CNAME",
    name: INPUT.hostname,
    content: `${TUNNEL_ID}.cfargotunnel.com`,
    proxied: true,
    comment: `echo-brain staging edge ${INPUT.slotId}`,
  };
}

function install(input: StagingEdgeInput, fetchImpl: FetchLike) {
  return installStagingEdgeToken(input, {
    fetchImpl,
    putSecretValue: async () => {},
  });
}

function persistentRetryFetch(
  firstPut: "applied-response-lost" | "not-applied",
) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  let configuration: unknown;
  let exists = false;
  let firstPutPending = true;
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    if (url.includes("/cfd_tunnel?") && init.method === undefined)
      return response(
        exists
          ? [{ id: TUNNEL_ID, name: TUNNEL_NAME, config_src: "cloudflare" }]
          : [],
      );
    if (url.endsWith("/cfd_tunnel") && init.method === "POST") {
      exists = true;
      return response({
        id: TUNNEL_ID,
        name: TUNNEL_NAME,
        remote_config: true,
      });
    }
    if (
      url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`) &&
      init.method === "PUT"
    ) {
      if (firstPutPending) {
        firstPutPending = false;
        if (firstPut === "applied-response-lost")
          configuration = expectedConfiguration();
        return response({}, false);
      }
      configuration = expectedConfiguration();
      return response({});
    }
    if (url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`))
      return response(
        configuration === undefined ? {} : { config: configuration },
      );
    if (url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/token`))
      return response(CONNECTOR_TOKEN);
    if (url.includes("/dns_records?") && init.method === undefined)
      return response([]);
    if (url.endsWith("/dns_records") && init.method === "POST")
      return response({
        type: "CNAME",
        name: INPUT.hostname,
        content: `${TUNNEL_ID}.cfargotunnel.com`,
        proxied: true,
        comment: `echo-brain staging edge ${INPUT.slotId}`,
      });
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchImpl };
}

describe("Authority staging Cloudflare edge", () => {
  it("bounds a stalled request and an oversized response before accepting edge state", async () => {
    let nonOkSignal: AbortSignal | undefined;
    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: async (_url, init = {}) => {
          nonOkSignal = init.signal as AbortSignal;
          return { json: async () => ({ result: [], success: false }), ok: false };
        },
      }),
    ).rejects.toThrow("cloudflare_tunnel_list_failed");
    expect(nonOkSignal?.aborted).toBe(true);

    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: async () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ json: async () => ({ result: [], success: true }), ok: true }),
              25,
            );
          }),
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("cloudflare_tunnel_list_unavailable");

    const validPayload = new TextEncoder().encode(
      JSON.stringify({ result: [], success: true }),
    );
    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: async () => ({
          body: {
            getReader: () => ({
              read: async () =>
                new Promise((resolve) => {
                  setTimeout(
                    () => resolve({ done: false, value: validPayload }),
                    25,
                  );
                }),
            }),
          },
          json: async () => ({ result: [], success: true }),
          ok: true,
        }),
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("cloudflare_tunnel_list_response_invalid");

    const oversized = new TextEncoder().encode(
      JSON.stringify({ result: [], success: true }),
    );
    let oversizedSignal: AbortSignal | undefined;
    await expect(
      stagingEdgeStatus(INPUT, {
        fetchImpl: async (_url, init = {}) => {
          oversizedSignal = init.signal as AbortSignal;
          return {
            body: {
              getReader: () => ({
                read: async () => ({ done: false, value: oversized }),
              }),
            },
            json: async () => ({ result: [], success: true }),
            ok: true,
          };
        },
        maxResponseBytes: 8,
      }),
    ).rejects.toThrow("cloudflare_tunnel_list_response_invalid");
    expect(oversizedSignal?.aborted).toBe(true);
  });

  it("derives one tunnel name from a bounded slot ID and rejects direct names", () => {
    const maximumSlotId = `staging-${"a".repeat(40)}`;
    expect(maximumSlotId).toHaveLength(48);
    expect(
      validateStagingEdgeInput({ ...INPUT, slotId: maximumSlotId }).tunnelName,
    ).toBe(`echo-authority-${maximumSlotId}`);
    expect(
      validateStagingEdgeInput({ ...INPUT, slotId: maximumSlotId }).tunnelName,
    ).toHaveLength(63);
    expect(() =>
      validateStagingEdgeInput({
        ...INPUT,
        slotId: `staging-${"a".repeat(41)}`,
      }),
    ).toThrow("slot_id_invalid");
    expect(() =>
      validateStagingEdgeInput({ ...INPUT, tunnelName: "operator-chosen" }),
    ).toThrow("input_property_not_allowed");
  });

  it("retries a persisted tunnel after its first configuration request does not apply", async () => {
    const persistent = persistentRetryFetch("not-applied");
    await expect(install(INPUT, persistent.fetchImpl)).rejects.toThrow(
      "cloudflare_tunnel_configure_failed",
    );
    await expect(install(INPUT, persistent.fetchImpl)).resolves.toMatchObject({
      state: "ready",
      tunnel_created: false,
      tunnel_configured: true,
    });
    expect(
      persistent.calls.filter(
        (call) =>
          call.url.endsWith("/cfd_tunnel") && call.init.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      persistent.calls.filter(
        (call) =>
          call.url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`) &&
          call.init.method === "PUT",
      ),
    ).toHaveLength(2);
    expect(persistent.calls.some((call) => call.init.method === "DELETE")).toBe(
      false,
    );
  });

  it("accepts a persisted configuration when Cloudflare applied the first PUT but its response was lost", async () => {
    const persistent = persistentRetryFetch("applied-response-lost");
    await expect(install(INPUT, persistent.fetchImpl)).rejects.toThrow(
      "cloudflare_tunnel_configure_failed",
    );
    await expect(install(INPUT, persistent.fetchImpl)).resolves.toMatchObject({
      state: "ready",
      tunnel_created: false,
      tunnel_configured: true,
    });
    expect(
      persistent.calls.filter(
        (call) =>
          call.url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`) &&
          call.init.method === "PUT",
      ),
    ).toHaveLength(1);
  });

  it("configures only precisely empty existing configurations and reports them incomplete in status", async () => {
    for (const configuration of [{}, { ingress: [] }]) {
      const { calls, fetchImpl } = edgeFetch({
        tunnel: configuredTunnel(),
        configuration,
      });
      await expect(install(INPUT, fetchImpl)).resolves.toMatchObject({
        state: "ready",
        tunnel_created: false,
      });
      expect(calls.some((call) => call.init.method === "PUT")).toBe(true);
    }

    const absentConfig = edgeFetch({ tunnel: configuredTunnel() });
    const statusFetch = async (
      ...args: Parameters<typeof absentConfig.fetchImpl>
    ) => {
      const responseValue = await absentConfig.fetchImpl(...args);
      if (args[0].endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`))
        return response({});
      return responseValue;
    };
    await expect(
      stagingEdgeStatus(INPUT, { fetchImpl: statusFetch }),
    ).resolves.toMatchObject({ state: "incomplete", ready: false });
    expect(absentConfig.calls.some((call) => call.init.method === "PUT")).toBe(
      false,
    );

    for (const configuration of [
      null,
      { ingress: null },
      { originRequest: {} },
      { ingress: [], originRequest: {} },
    ]) {
      const drift = edgeFetch({
        tunnel: configuredTunnel(),
        configuration,
      });
      await expect(install(INPUT, drift.fetchImpl)).rejects.toThrow(
        "cloudflare_tunnel_configuration_conflict",
      );
      expect(drift.calls.some((call) => call.init.method === "PUT")).toBe(
        false,
      );
    }
  });

  it("accepts Cloudflare's current remote_config response", async () => {
    const currentResponse = edgeFetch({
      tunnel: [
        {
          id: TUNNEL_ID,
          name: TUNNEL_NAME,
          remote_config: true,
        },
      ],
      dns: configuredDns(),
    });
    await expect(
      install(INPUT, currentResponse.fetchImpl),
    ).resolves.toMatchObject({ state: "ready", tunnel_created: false });
  });

  it("retains caller-specific refusal codes for invalid ownership", async () => {
    const tunnel = {
      id: TUNNEL_ID,
      name: TUNNEL_NAME,
      config_src: "cloudflare",
      remote_config: false,
    };
    const dns = { ...ownedDns(), proxied: false };
    const cases = [
      [{ tunnel: [tunnel] }, "cloudflare_tunnel_conflict"],
      [{ createdTunnel: tunnel }, "cloudflare_tunnel_create_response_invalid"],
      [
        { tunnel: configuredTunnel(), dns: [dns] },
        "cloudflare_dns_conflict",
      ],
      [
        { tunnel: configuredTunnel(), createdDns: dns },
        "cloudflare_dns_create_response_invalid",
      ],
    ] as const;

    for (const [options, refusal] of cases)
      await expect(
        install(INPUT, edgeFetch(options).fetchImpl),
      ).rejects.toThrow(refusal);
  });

  it("refuses existing ingress drift instead of overwriting it", async () => {
    const { calls, fetchImpl } = edgeFetch({
      tunnel: configuredTunnel(),
      configuration: { ingress: [{ service: "http_status:418" }] },
    });
    await expect(install(INPUT, fetchImpl)).rejects.toThrow(
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

  it("fails closed on duplicate existing names", async () => {
    await expect(
      install(
        INPUT,
        edgeFetch({ tunnel: [...configuredTunnel(), ...configuredTunnel()] })
          .fetchImpl,
      ),
    ).rejects.toThrow("cloudflare_tunnel_duplicate");

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
      `GET /client/v4/zones/${INPUT.zoneId}/dns_records`,
      `PUT /client/v4/accounts/${INPUT.accountId}/cfd_tunnel/${TUNNEL_ID}/configurations`,
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
      install(
        { ...INPUT, apiToken: "{{resolve:secretsmanager:edge/api}}" },
        edgeFetch().fetchImpl,
      ),
    ).rejects.toThrow("cloudflare_api_token_invalid");

    const { fetchImpl } = edgeFetch();
    await expect(
      install(INPUT, async (...args) => {
        const value = await fetchImpl(...args);
        if (args[0].endsWith("/cfd_tunnel"))
          return { ok: false, json: value.json };
        return value;
      }),
    ).rejects.not.toThrow(CONNECTOR_TOKEN);

    const secretFailure = edgeFetch({ tunnel: configuredTunnel() });
    await expect(
      installStagingEdgeToken(INPUT, {
        fetchImpl: secretFailure.fetchImpl,
        putSecretValue: async () => {
          throw new Error(CONNECTOR_TOKEN);
        },
      }),
    ).rejects.not.toThrow(CONNECTOR_TOKEN);
    expect(secretFailure.events).toContain(
      `GET /client/v4/accounts/${INPUT.accountId}/cfd_tunnel/${TUNNEL_ID}/token`,
    );
    expect(
      secretFailure.events.some((event) =>
        event.startsWith(`POST /client/v4/zones/${INPUT.zoneId}/dns_records`),
      ),
    ).toBe(false);
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
