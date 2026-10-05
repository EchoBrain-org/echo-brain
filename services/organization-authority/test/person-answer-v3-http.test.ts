import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_PATH_V3,
  PERSON_CAPABILITIES_PATH_V1,
  PERSON_EVIDENCE_OPEN_PATH_V1,
  PERSON_EVIDENCE_SEARCH_PATH_V1,
  validatePersonAnswerResponseV4,
  validatePersonEvidenceDeskResponseV1,
} from "@echo-brain/organization-api";
import type { StructuredGenerationInput } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";

/** Retired Ask paths (ADR-0022): no route, so the canonical not-found reply. */
const RETIRED_ASK_PATHS = ["/v1/person/ask", "/v2/person/ask"] as const;
import type { OriginalContextDeskItemV1, PersonOriginalContextEvidenceDeskPortV1 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { PersonRecordSearchIndexLagV1, type PersonEvidenceDeskRecordsV1 } from "../src/composition/person-record-search-route.js";
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
  it("returns the existing unavailable response when Ask asks the client to try again", async () => {
    const ask = vi.fn(async () => { throw new AuthorityOperationError("unavailable", "Ask deadline exhausted"); });
    const value = await server({ application: { ask, searchEvidence: vi.fn(), openEvidence: vi.fn() } });
    try {
      const response = await fetch(`${value.url}${PERSON_ANSWER_PATH_V3}`, {
        method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 3, question: "What changed?" }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: { code: "unavailable", message: "request failed" } });
      expect(ask).toHaveBeenCalledTimes(1);
    } finally { await value.close(); }
  });

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

/**
 * The real V3 route and evidence desk behind the real HTTP server, over fake
 * stores: one only-me note of the asker's, and records still indexing.
 */
function mineFixture() {
  const checked_at = "2026-09-27T00:00:00.000Z";
  const note: OriginalContextDeskItemV1 = Object.freeze({
    kind: "note", text: "I decided to launch on Tuesday.", visibility: "only_me", label: "My launch note",
    received_at: checked_at, version: "1", ref: `note:ctx_${"a".repeat(64)}`,
    citation: {
      kind: "source_revision" as const, source_id: `source:${"d".repeat(64)}`, revision_id: "revision-1",
      source_sha256: canonicalSha256({ source: 1 }), representation_sha256: canonicalSha256({ representation: 1 }), anchor_sha256: canonicalSha256({ anchor: 1 }),
    },
  });
  const scopes: unknown[] = [];
  const release = (scope: unknown) => ({
    release: { authorization: { principal_id: "prn_asker", membership_id: "mem_asker", session_family_id: "session_asker", checked_at }, scope, authorization_revision: 0, released_atoms: [] },
    receipt: canonicalSha256({ release: scopes.length }), items: [note], truncated: false,
  });
  const originals = {
    deskAuthorize: vi.fn((input: { readonly scope: unknown }) => { scopes.push(input.scope); return { checked_at }; }),
    deskSearch: vi.fn((input: { readonly scope: unknown }) => { scopes.push(input.scope); return release(input.scope); }),
    deskOpen: vi.fn((input: { readonly scope: unknown }) => { scopes.push(input.scope); return release(input.scope); }),
    revalidateDeskRelease: vi.fn(() => ({ checked_at })),
  };
  const records = { initializeDesk: vi.fn((_input: object) => { throw new PersonRecordSearchIndexLagV1(); }) };
  // Searches once, finishes on what it found, and cites it.
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: { id: string }[] }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      return { sentences: [{ text: "You decided to launch on Tuesday.", evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    const hit = prompt.last_results?.[0]?.results?.[0]?.id;
    return hit === undefined
      ? { parts: [{ question: prompt.question, needs: [{ need: "launch day", status: "open", evidence: [] }], notes: "" }], actions: [{ tool: "search", args: { query: "launch" } }] }
      : { parts: [{ question: prompt.question, needs: [{ need: "launch day", status: "found", evidence: [hit] }], notes: "" }], actions: [{ tool: "finish", args: {} }] };
  });
  const route = createPersonAnswerV3Route({
    authority_id: "authority_fixture", organization_id: "organization_fixture", state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess: () => ({ principal_id: "prn_asker", membership_id: "mem_asker", session_family_id: "session_asker" }) } as never,
    originals: originals as unknown as PersonOriginalContextEvidenceDeskPortV1, records: records as unknown as PersonEvidenceDeskRecordsV1,
    model: { generate }, generation: { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 25_000 },
    audit: { forRequest: () => ({ append: vi.fn() }) } as never,
  });
  // The desk cites an original with its display label.
  return { note, cited: { ...note.citation, label: note.label }, scopes, originals, records, generate, route };
}

async function post(url: string, path: string, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("Ask with mine, and citation refs (ADR-0024)", () => {
  it("builds a mine desk for every store, echoes mine, and cites with a ref", async () => {
    const f = mineFixture();
    const value = await server({ application: f.route });
    try {
      const answer = await post(value.url, PERSON_ANSWER_PATH_V3, { schema_version: 3, question: "What did I decide?", mine: true });
      expect(answer.status).toBe(200);
      const validated = validatePersonAnswerResponseV4(answer.body);
      expect(validated.scope).toEqual({ kind: "mine" });
      expect(validated.citations).toEqual([{ citation: f.cited, kind: "note", label: "My launch note", visibility: "only_me", ref: f.note.ref }]);
      expect(f.scopes.length).toBeGreaterThan(1);
      for (const scope of f.scopes) expect(scope).toEqual({ kind: "mine" });
      expect(f.records.initializeDesk).toHaveBeenCalledTimes(1);
      expect(f.records.initializeDesk.mock.calls[0]![0]).toMatchObject({ mine: true });
      expect(f.records.initializeDesk.mock.calls[0]![0]).not.toHaveProperty("project_id");
      // The research and answer prompts name the mine scope and never the ref.
      for (const [input] of f.generate.mock.calls) {
        expect(JSON.parse(input.user_prompt).scope).toContain("only what the asker added");
        expect(input.user_prompt).not.toContain(f.note.ref!);
      }
      // Without mine, the same asker's Ask is global.
      f.scopes.length = 0;
      expect((await post(value.url, PERSON_ANSWER_PATH_V3, { schema_version: 3, question: "What did I decide?" })).body.scope).toEqual({ kind: "global" });
      for (const scope of f.scopes) expect(scope).toEqual({ kind: "global" });
    } finally { await value.close(); }
  });

  it("refuses mine with a project, or mine other than true, before the route runs", async () => {
    const f = mineFixture();
    const value = await server({ application: f.route });
    try {
      for (const body of [
        { schema_version: 3, question: "What did I decide?", mine: true, project_id: "prj_00000000-0000-4000-8000-000000000001" },
        { schema_version: 3, question: "What did I decide?", mine: false },
      ]) {
        expect(await post(value.url, PERSON_ANSWER_PATH_V3, body)).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "request failed" } } });
      }
      expect(f.originals.deskAuthorize).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      // A caller that skips the HTTP validator is refused too, never widened to global or a project.
      await expect(f.route.ask({ access_token: "token", request: { schema_version: 3, question: "What did I decide?", mine: true, project_id: "prj_00000000-0000-4000-8000-000000000001" } })).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.originals.deskAuthorize).not.toHaveBeenCalled();
    } finally { await value.close(); }
  });

  it("strips ref from the evidence search and open doors, whose contract carries none", async () => {
    const f = mineFixture();
    const value = await server({ application: f.route });
    try {
      const searched = await post(value.url, PERSON_EVIDENCE_SEARCH_PATH_V1, { schema_version: 1, query: "launch" });
      expect(searched.status).toBe(200);
      const opened = await post(value.url, PERSON_EVIDENCE_OPEN_PATH_V1, { schema_version: 1, citation: f.note.citation });
      expect(opened.status).toBe(200);
      for (const response of [searched, opened]) {
        const desk = validatePersonEvidenceDeskResponseV1(response.body);
        expect(desk.items.map((item) => item.citation)).toEqual([f.cited]);
        expect(desk.items[0]).not.toHaveProperty("ref");
        expect(JSON.stringify(response.body)).not.toContain(f.note.ref!);
      }
    } finally { await value.close(); }
  });
});
