import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { PERSON_ANSWER_PATH_V3, PERSON_CAPABILITIES_PATH_V1 } from "@echo-brain/organization-api";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import type { PersonAnswerV3HttpApplication } from "../src/presentation/person-answer-v3-http-application.js";

async function server(input: { readonly enabled: boolean; readonly application?: PersonAnswerV3HttpApplication }) {
  const sessions = { authenticateAccess: vi.fn(() => ({})) };
  const instance = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: sessions as never, oidc_provider: {} as never,
    expected_issuer: "https://issuer.example", agentic_ask_v1_enabled: input.enabled,
    person_answer_v3: input.application,
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
  it("returns the authenticated explicit false capability and does not downgrade a direct V3 request", async () => {
    const value = await server({ enabled: false });
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

  it("requires authentication for capability discovery", async () => {
    const value = await server({ enabled: false });
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
    const value = await server({ enabled: true, application });
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
