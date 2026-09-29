import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { PERSON_ANSWER_PATH_V3, PERSON_CAPABILITIES_PATH_V1 } from "@echo-brain/organization-api";

/** Retired Ask paths (ADR-0022): no route, so the canonical not-found reply. */
const RETIRED_ASK_PATHS = ["/v1/person/ask", "/v2/person/ask"] as const;
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import type { PersonAnswerV3HttpApplication } from "../src/presentation/person-answer-v3-http-application.js";

async function server(input: { readonly application?: PersonAnswerV3HttpApplication }) {
  const sessions = { authenticateAccess: vi.fn(() => ({})) };
  const instance = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: sessions as never, oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    ...(input.application === undefined ? {} : { person_answer_v3: input.application }),
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    sessions,
    async close() { const closed = once(instance, "close"); instance.close(); await closed; },
  };
}

describe("Agentic Ask HTTP capability gate", () => {
  it("without an answer model reports no agentic capability and refuses Ask instead of falling back", async () => {
    const value = await server({});
    try {
      const capabilities = await fetch(`${value.url}${PERSON_CAPABILITIES_PATH_V1}`, { headers: { authorization: "Bearer token" } });
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toEqual({ schema_version: 1, kind: "echo-person-capabilities-v1", agentic_ask_v1: false });
      expect(value.sessions.authenticateAccess).toHaveBeenCalledWith({ access_token: "token" });
      const ask = await fetch(`${value.url}${PERSON_ANSWER_PATH_V3}`, {
        method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 3, question: "What changed?" }),
      });
      expect(ask.status).toBe(503);
    } finally { await value.close(); }
  });

  it("reports agentic Ask to installed clients that still probe, and no longer serves the retired Ask paths", async () => {
    const value = await server({ application: { ask: vi.fn(), searchEvidence: vi.fn(), openEvidence: vi.fn() } as never });
    try {
      const capabilities = await fetch(`${value.url}${PERSON_CAPABILITIES_PATH_V1}`, { headers: { authorization: "Bearer token" } });
      await expect(capabilities.json()).resolves.toEqual({ schema_version: 1, kind: "echo-person-capabilities-v1", agentic_ask_v1: true });
      for (const path of RETIRED_ASK_PATHS) {
        const retired = await fetch(`${value.url}${path}`, {
          method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({ schema_version: 2, question: "What changed?" }),
        });
        expect(retired.status).toBe(404);
      }
    } finally { await value.close(); }
  });

  it("requires authentication for capability discovery", async () => {
    const value = await server({});
    try {
      const response = await fetch(`${value.url}${PERSON_CAPABILITIES_PATH_V1}`);
      expect(response.status).toBe(401);
      expect(value.sessions.authenticateAccess).not.toHaveBeenCalled();
    } finally { await value.close(); }
  });

  it("forwards a client disconnect as the V3 route abort signal", async () => {
    let started!: () => void;
    let observedAbort!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const abortedPromise = new Promise<void>((resolve) => { observedAbort = resolve; });
    const application = {
      ask: vi.fn(({ signal }) => new Promise<never>((_resolve, reject) => {
        started();
        signal?.addEventListener("abort", () => {
          observedAbort();
          reject(new Error("client disconnected"));
        }, { once: true });
      })),
      searchEvidence: vi.fn(),
      openEvidence: vi.fn(),
    } as unknown as PersonAnswerV3HttpApplication;
    const value = await server({ application });
    try {
      const request = httpRequest(`${value.url}${PERSON_ANSWER_PATH_V3}`, {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
      });
      request.on("error", () => undefined);
      request.end(JSON.stringify({ schema_version: 3, question: "What changed?" }));
      await startedPromise;
      request.destroy();
      await abortedPromise;
      expect(application.ask).toHaveBeenCalledWith(expect.objectContaining({ access_token: "token", request: { schema_version: 3, question: "What changed?" } }));
    } finally { await value.close(); }
  });
});
