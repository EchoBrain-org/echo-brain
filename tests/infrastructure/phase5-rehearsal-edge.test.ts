import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- the rehearsal edge is an executable plain-ESM tool.
import * as phase5Edge from "../../tools/phase5/loopback-authenticated-edge.mjs";

const { phase5ProxyClientId, startLoopbackAuthenticatedEdge } = phase5Edge;

const PROXY_TOKEN = "phase5-trusted-proxy-token-0000000000000001";
const MEMBER_ID = "mem_00000000-0000-4000-8000-000000000001";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const closeables: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
});

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startOrigin(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  closeables.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  );
  return { origin: `http://127.0.0.1:${address.port}/`, server };
}

async function edge(options: {
  targetOrigin: string;
  role: "admin" | "employee";
  label: string;
  faults?: {
    dropEnrollmentResponseOnce?: boolean;
    tamperAccessStateResponseOnce?: boolean;
  };
  maximumBufferedResponseBytes?: number;
}) {
  const runtime = await startLoopbackAuthenticatedEdge({
    targetOrigin: options.targetOrigin,
    proxyToken: PROXY_TOKEN,
    clientId: phase5ProxyClientId(options.label),
    role: options.role,
    faults: options.faults,
    maximumBufferedResponseBytes: options.maximumBufferedResponseBytes,
  });
  closeables.push(() => runtime.close());
  return runtime;
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  response.end(body);
}

describe("Phase 5 loopback authenticated rehearsal edge", () => {
  it("separates admin and employee routes and overwrites every proxy credential header", async () => {
    const captured: CapturedRequest[] = [];
    const origin = await startOrigin(async (request, response) => {
      captured.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: (await bodyOf(request)).toString("utf8"),
      });
      jsonResponse(response, 200, { ok: true });
    });
    const employee = await edge({
      targetOrigin: origin.origin,
      role: "employee",
      label: "employee-one",
    });
    const admin = await edge({
      targetOrigin: origin.origin,
      role: "admin",
      label: "organization-admin",
    });

    const rejectedAdmin = await fetch(
      new URL("/v1/admin/memberships", employee.origin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(rejectedAdmin.status).toBe(403);
    expect(await rejectedAdmin.json()).toEqual({
      error: {
        code: "edge_route_forbidden",
        message: "the route is not allowed by this authenticated edge",
      },
    });

    const rejectedEmployee = await fetch(
      new URL("/v1/enrollments", admin.origin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(rejectedEmployee.status).toBe(403);
    expect(captured).toHaveLength(0);

    const enrollmentAuthorization = `Echo-Enrollment ${"a".repeat(43)}`;
    const acceptedEmployee = await fetch(
      new URL("/v1/enrollments", employee.origin),
      {
        method: "POST",
        headers: {
          authorization: enrollmentAuthorization,
          "content-type": "application/json",
          "x-echo-proxy-authorization": `Echo-Proxy ${"z".repeat(40)}`,
          "x-echo-authenticated-client-id": phase5ProxyClientId("attacker"),
          "x-echo-proxy-token-shadow": "must-not-pass",
          "x-echo-authenticated-client-role": "admin",
        },
        body: '{"enrollment_request":{}}',
      },
    );
    expect(acceptedEmployee.status).toBe(200);

    const acceptedAdmin = await fetch(
      new URL(
        `/v1/admin/memberships/${MEMBER_ID}/enrollment-grants`,
        admin.origin,
      ),
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret-not-logged",
          "content-type": "application/json",
        },
        body: '{"lifetime_seconds":60}',
      },
    );
    expect(acceptedAdmin.status).toBe(200);
    expect(captured).toHaveLength(2);

    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "/v1/enrollments",
      body: '{"enrollment_request":{}}',
    });
    expect(captured[0]!.headers.authorization).toBe(enrollmentAuthorization);
    expect(captured[0]!.headers["x-echo-proxy-authorization"]).toBe(
      `Echo-Proxy ${PROXY_TOKEN}`,
    );
    expect(captured[0]!.headers["x-echo-authenticated-client-id"]).toBe(
      employee.clientId,
    );
    expect(captured[0]!.headers["x-echo-proxy-token-shadow"]).toBeUndefined();
    expect(
      captured[0]!.headers["x-echo-authenticated-client-role"],
    ).toBeUndefined();
    expect(captured[1]!.headers["x-echo-authenticated-client-id"]).toBe(
      admin.clientId,
    );
    expect(employee.securityState()).toEqual({
      forwardedRequestCount: 1,
      strippedCredentialHeaderCount: 4,
      configuredClientIdentityForwardCount: 1,
      spoofedClientIdentityReplacementCount: 1,
      outboundIdentityMismatchCount: 0,
    });
    expect(employee.responseCount("POST", "/v1/enrollments", 200)).toBe(1);
    expect(
      admin.responseCount(
        "POST",
        `/v1/admin/memberships/${MEMBER_ID}/enrollment-grants`,
        200,
      ),
    ).toBe(1);
  });

  it("drops exactly one enrollment response after the origin completes it", async () => {
    let requests = 0;
    let completedResponses = 0;
    const origin = await startOrigin(async (request, response) => {
      await bodyOf(request);
      requests += 1;
      response.once("finish", () => {
        completedResponses += 1;
      });
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.write('{"enrollment_receipt":{"request":');
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.end(`${requests}}}`);
    });
    const employee = await edge({
      targetOrigin: origin.origin,
      role: "employee",
      label: "employee-drop",
      faults: { dropEnrollmentResponseOnce: true },
    });

    await expect(
      fetch(new URL("/v1/enrollments", employee.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow();
    expect(requests).toBe(1);
    expect(completedResponses).toBe(1);
    expect(employee.faultState().dropEnrollmentResponseOnce).toEqual({
      armed: true,
      reserved: false,
      consumed: true,
    });

    const retry = await fetch(new URL("/v1/enrollments", employee.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({
      enrollment_receipt: { request: 2 },
    });
    expect(requests).toBe(2);
  });

  it("tamper-faults one access state without changing its signature", async () => {
    const accessState = {
      access_state_sequence: 7,
      status: "active",
      integrity: {
        payload_sha256: `sha256:${"a".repeat(64)}`,
        signature_base64: "authority-signature-is-unchanged",
      },
    };
    const origin = await startOrigin(async (request, response) => {
      await bodyOf(request);
      jsonResponse(response, 200, { access_state: accessState });
    });
    const employee = await edge({
      targetOrigin: origin.origin,
      role: "employee",
      label: "employee-tamper",
      faults: { tamperAccessStateResponseOnce: true },
    });

    const first = await fetch(new URL("/v1/access-leases", employee.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const firstBody = (await first.json()) as {
      access_state: typeof accessState;
    };
    expect(firstBody.access_state.access_state_sequence).toBe(8);
    expect(firstBody.access_state.integrity.signature_base64).toBe(
      accessState.integrity.signature_base64,
    );
    expect(employee.faultState().tamperAccessStateResponseOnce.consumed).toBe(
      true,
    );
    expect(employee.responseCount("POST", "/v1/access-leases", 200)).toBe(1);

    const second = await fetch(new URL("/v1/access-leases", employee.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await second.json()).toEqual({ access_state: accessState });
  });

  it("fails closed at the response buffer bound without consuming the fault", async () => {
    let requests = 0;
    const accessState = {
      access_state_sequence: 2,
      integrity: { signature_base64: "unchanged" },
    };
    const origin = await startOrigin(async (request, response) => {
      await bodyOf(request);
      requests += 1;
      if (requests === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"padding":"');
        response.end(`${"x".repeat(128)}"}`);
        return;
      }
      jsonResponse(response, 200, { access_state: accessState });
    });
    const employee = await edge({
      targetOrigin: origin.origin,
      role: "employee",
      label: "employee-bounded",
      faults: { tamperAccessStateResponseOnce: true },
      maximumBufferedResponseBytes: 128,
    });

    const tooLarge = await fetch(
      new URL("/v1/access-leases", employee.origin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(tooLarge.status).toBe(502);
    expect(await tooLarge.json()).toEqual({
      error: {
        code: "upstream_response_too_large",
        message: "the upstream response exceeded the edge buffer limit",
      },
    });
    expect(employee.faultState().tamperAccessStateResponseOnce).toEqual({
      armed: true,
      reserved: false,
      consumed: false,
    });

    const retry = await fetch(new URL("/v1/access-leases", employee.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const retryBody = (await retry.json()) as {
      access_state: typeof accessState;
    };
    expect(retryBody.access_state.access_state_sequence).toBe(3);
    expect(retryBody.access_state.integrity.signature_base64).toBe("unchanged");
  });

  it("rejects non-loopback targets and invalid edge roles before listening", async () => {
    await expect(
      startLoopbackAuthenticatedEdge({
        targetOrigin: "https://example.com/",
        proxyToken: PROXY_TOKEN,
        clientId: phase5ProxyClientId("invalid-target"),
        role: "employee",
      }),
    ).rejects.toThrow("bare loopback HTTP origin");
    await expect(
      startLoopbackAuthenticatedEdge({
        targetOrigin: "http://127.0.0.1:12345/",
        proxyToken: PROXY_TOKEN,
        clientId: phase5ProxyClientId("invalid-role"),
        role: "operator",
      }),
    ).rejects.toThrow("role must be admin or employee");
  });
});
