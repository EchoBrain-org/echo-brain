import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_PATH_V7,
  PERSON_EVIDENCE_OPEN_PATH_V1,
  PERSON_EVIDENCE_SEARCH_PATH_V1,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceDeskResponseV1,
} from "@echo-brain/organization-api";
import type { StructuredGenerationInput } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import type { AgenticResearchDriverSessionV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";

/** Retired Ask paths: the one-shot Asks (ADR-0022) and every route before `/v7`. No route, so the canonical not-found reply. */
const RETIRED_ASK_PATHS = ["/v1/person/ask", "/v2/person/ask", "/v3/person/ask", "/v4/person/ask", "/v5/person/ask", "/v6/person/ask"] as const;
import type { OriginalContextDeskItemV1, PersonOriginalContextEvidenceDeskPortV1 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { createPersonLiveAnswerRouteV1 } from "../src/composition/person-live-answer-route-v1.js";
import { PersonRecordSearchIndexLagV1, type PersonEvidenceDeskRecordsV1 } from "../src/composition/person-record-search-route.js";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import type { PersonAnswerV3HttpApplication } from "../src/presentation/person-answer-v3-http-application.js";
import type { PersonAnswerV7HttpApplication } from "../src/presentation/person-live-answer-http-application.js";
import { authorityHttpServerOptions } from "./fixtures/authority-http-server.js";

/** The evidence desk (`application`) and Ask on `/v7` (`ask`) behind the real HTTP server. */
async function server(input: { readonly application?: PersonAnswerV3HttpApplication; readonly ask?: PersonAnswerV7HttpApplication }) {
  const sessions = { authenticateAccess: vi.fn(() => ({})) };
  const instance = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({
    sessions: sessions as never,
    ...(input.application === undefined ? {} : { person_answer_v3: input.application }),
    ...(input.ask === undefined ? {} : { person_answer_v7: input.ask }),
  }));
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
  it('passes validated optional client time headers to Ask without changing the request body', async () => {
    const ask = vi.fn(async () => { throw new AuthorityOperationError('not_found', 'fixture'); });
    const value = await server({ ask: { ask } });
    const body = { schema_version: 3, question: 'What happened yesterday?' };
    try {
      const headers = { authorization: 'Bearer token', 'content-type': 'application/json', 'x-echo-client-now': '2026-10-17T04:30:00.000Z', 'x-echo-time-zone': 'America/Los_Angeles' };
      await fetch(`${value.url}${PERSON_ANSWER_PATH_V7}`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ request: body, time_context: { now: headers['x-echo-client-now'], time_zone: headers['x-echo-time-zone'] } }));
      const bad = await fetch(`${value.url}${PERSON_ANSWER_PATH_V7}`, { method: 'POST', headers: { ...headers, 'x-echo-time-zone': 'Not/AZone' }, body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
      expect(ask).toHaveBeenCalledTimes(1);
    } finally { await value.close(); }
  });

  it('answers /v7 provider errors and invalid requests with their codes, and retired Ask routes with the plain 404', async () => {
    const ask = vi.fn(async () => { throw new AuthorityOperationError('not_found', 'Provider resource unavailable'); });
    const value = await server({ ask: { ask } as never });
    try {
      const post = (path: string, body: unknown) => fetch(`${value.url}${path}`, {
        method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const failed = await post(PERSON_ANSWER_PATH_V7, { schema_version: 3, question: 'What changed?' });
      expect(failed.status).toBe(404);
      expect(failed.headers.has('x-echo-person-ask-route')).toBe(false);
      await expect(failed.json()).resolves.toEqual({ error: { code: 'not_found', message: 'request failed' } });
      const invalid = await post(PERSON_ANSWER_PATH_V7, {});
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: { code: 'invalid_request', message: 'request failed' } });
      // A retired route, like one that never existed, is a plain 404.
      for (const path of ['/v0/person/ask', ...RETIRED_ASK_PATHS]) {
        const absent = await post(path, { schema_version: 3, question: 'What changed?' });
        expect(absent.status).toBe(404);
        await expect(absent.json()).resolves.toEqual({ error: { code: 'not_found', message: 'request failed' } });
      }
      expect(ask).toHaveBeenCalledTimes(1);
    } finally { await value.close(); }
  });

  it("returns the existing unavailable response when Ask asks the client to try again", async () => {
    const ask = vi.fn(async () => { throw new AuthorityOperationError("unavailable", "Ask deadline exhausted"); });
    const value = await server({ ask: { ask } as never });
    try {
      expect(await post(value.url, PERSON_ANSWER_PATH_V7, { schema_version: 3, question: "What changed?" }))
        .toEqual({ status: 503, body: { error: { code: "unavailable", message: "request failed" } } });
      expect(ask).toHaveBeenCalledTimes(1);
    } finally { await value.close(); }
  });

  it("answers the retired capability read as a route that never existed, and keeps it from provider adapters", async () => {
    const value = await server({});
    try {
      const response = await fetch(`${value.url}/v3/person/capabilities`, { headers: { authorization: "Bearer token" } });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "request failed" } });
      expect(value.sessions.authenticateAccess).not.toHaveBeenCalled();
    } finally { await value.close(); }
    const adapter = { routes: [{ route_id: "collision", method: "GET" as const, path: "/v3/person/capabilities" }], accept: async () => ({ status: 200 as const, body: {} }) };
    expect(() => createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_tool_connections: [adapter] }))).toThrow("collides with Authority route");
  });

  it("forwards a client disconnect as the Ask's abort signal", async () => {
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
    } as unknown as PersonAnswerV7HttpApplication;
    const value = await server({ ask: application });
    try {
      const request = httpRequest(`${value.url}${PERSON_ANSWER_PATH_V7}`, {
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
 * The real Ask route (`/v7`) and evidence desk behind the real HTTP server,
 * over fake stores: one only-me note of the asker's, and records still indexing.
 */
function mineFixture(nativeDriver = false, personalMember?: string) {
  const checked_at = "2026-09-27T00:00:00.000Z";
  const note: OriginalContextDeskItemV1 = Object.freeze({
    kind: "note", text: "I decided to launch on Tuesday.", visibility: "only_me", label: "My launch note",
    received_at: checked_at, version: "1", ref: `note:ctx_${"a".repeat(64)}`, dates: { received: checked_at },
    citation: {
      kind: "source_revision" as const, source_id: `source:${"d".repeat(64)}`, revision_id: "revision-1",
      source_sha256: canonicalSha256({ source: 1 }), representation_sha256: canonicalSha256({ representation: 1 }), anchor_sha256: canonicalSha256({ anchor: 1 }),
    },
  });
  const scopes: unknown[] = [];
  const release = (scope: unknown) => ({
    release: { authorization: { principal_id: "prn_asker", membership_id: "mem_asker", session_family_id: "session_asker", checked_at }, scope, grants_sha256: canonicalSha256([]), released_atoms: [] },
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
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: string[] }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      return { sentences: [{ text: "You decided to launch on Tuesday.", evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    const hit = prompt.last_results?.[0]?.results?.[0];
    return hit === undefined
      ? { parts: [{ question: prompt.question, needs: [{ need: "launch day", status: "open", evidence: [] }], notes: "" }], actions: [{ tool: "search", args: { query: "launch" } }] }
      : { parts: [{ question: prompt.question, needs: [{ need: "launch day", status: "found", evidence: [hit] }], notes: "" }], actions: [{ tool: "finish", args: {} }] };
  });
  const personalGenerate = vi.fn(generate.getMockImplementation()!);
  const options = {
    authority_id: "authority_fixture", organization_id: "organization_fixture", state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess: () => ({ principal_id: "prn_asker", membership_id: "mem_asker", session_family_id: "session_asker" }) } as never,
    originals: originals as unknown as PersonOriginalContextEvidenceDeskPortV1, records: records as unknown as PersonEvidenceDeskRecordsV1,
    model: { generate }, generation: { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 25_000 },
    ...(nativeDriver ? { [personalMember === undefined ? 'research_driver' : 'personal_research']: personalMember === undefined ? { run: nativeRun } : { membership_id: personalMember, driver: { run: nativeRun }, structured_output: { generate: personalGenerate }, generation: { generation_adapter_id: 'personal-fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 } } } : {}),
    audit: { forRequest: () => ({ append: vi.fn() }), forLiveRequest: () => ({}) } as never,
  };
  const route = createPersonLiveAnswerRouteV1(options);
  const desk = createPersonAnswerV3Route(options);
  async function nativeRun(session: AgenticResearchDriverSessionV1) {
      expect(JSON.stringify(session.initial)).toContain('only what the asker added');
      const read = await session.call('search', { query: 'launch' });
      await session.model_request({ model: 'fixture', body_sha256: canonicalSha256(read), payload_digests: [canonicalSha256(session.initial), canonicalSha256(read)], operation: 'messages', timeout: session.remaining }, async () => ({ value: true }));
      expect(await session.call('finish', { completed: true, parts: [{ question: 'Launch day', notes: 'Launch on Tuesday.', needs: [{ need: 'launch day', kind: 'content', status: 'found', evidence: ['E1'] }] }] })).toMatchObject({ accepted: true });
  }
  // The desk cites an original with its display label.
  return { note, cited: { ...note.citation, label: note.label }, scopes, originals, records, generate, personalGenerate, route, desk };
}

async function post(url: string, path: string, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("Ask with mine, and citation refs (ADR-0024)", () => {
  it('serves the native research driver through the existing authenticated HTTP route and writer', async () => {
    const f = mineFixture(true);
    const value = await server({ application: f.desk, ask: f.route });
    try {
      const answer = await post(value.url, PERSON_ANSWER_PATH_V7, { schema_version: 3, question: 'What did I decide?', mine: true });
      expect(answer.status).toBe(200);
      const validated = validatePersonAnswerResponseV8(answer.body);
      expect(validated.outcome).toBe('answered');
      expect(validated.scope).toEqual({ kind: 'mine' });
      expect(validated.citations).toEqual([{ citation: f.cited, kind: 'note', label: 'My launch note', visibility: 'only_me', ref: f.note.ref }]);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.originals.revalidateDeskRelease).toHaveBeenCalled();
    } finally { await value.close(); }
  });

  it.each([['mem_asker', 0, 1], ['mem_other', 3, 0]])('uses personal research and writing only for the authenticated member %s', async (member, sharedCalls, personalCalls) => {
    const f = mineFixture(true, String(member));
    const answer = await f.route.ask({ access_token: 'token', request: { schema_version: 3, question: 'Use mem_asker personal Claude. What did I decide?', mine: true } });
    expect(answer.outcome).toBe('answered');
    expect(f.generate).toHaveBeenCalledTimes(sharedCalls);
    expect(f.personalGenerate).toHaveBeenCalledTimes(personalCalls);
  });

  it('never falls back to the shared writer when the selected personal writer fails', async () => {
    const f = mineFixture(true, 'mem_asker');
    f.personalGenerate.mockRejectedValue(new Error('personal writer unavailable'));
    await expect(f.route.ask({ access_token: 'token', request: { schema_version: 3, question: 'What did I decide?', mine: true } })).rejects.toThrow('personal writer unavailable');
    expect(f.personalGenerate).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("builds a mine desk for every store, echoes mine, and cites with a ref", async () => {
    const f = mineFixture();
    const value = await server({ application: f.desk, ask: f.route });
    try {
      const answer = await post(value.url, PERSON_ANSWER_PATH_V7, { schema_version: 3, question: "What did I decide?", mine: true });
      expect(answer.status).toBe(200);
      const validated = validatePersonAnswerResponseV8(answer.body);
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
      expect((await post(value.url, PERSON_ANSWER_PATH_V7, { schema_version: 3, question: "What did I decide?" })).body.scope).toEqual({ kind: "global" });
      for (const scope of f.scopes) expect(scope).toEqual({ kind: "global" });
    } finally { await value.close(); }
  });

  it("refuses mine with a project, or mine other than true, before the route runs", async () => {
    const f = mineFixture();
    const value = await server({ application: f.desk, ask: f.route });
    try {
      for (const body of [
        { schema_version: 3, question: "What did I decide?", mine: true, project_id: "prj_00000000-0000-4000-8000-000000000001" },
        { schema_version: 3, question: "What did I decide?", mine: false },
      ]) {
        expect(await post(value.url, PERSON_ANSWER_PATH_V7, body)).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "request failed" } } });
      }
      expect(f.originals.deskAuthorize).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      // A caller that skips the HTTP validator is refused too, never widened to global or a project.
      await expect(f.route.ask({ access_token: "token", request: { schema_version: 3, question: "What did I decide?", mine: true, project_id: "prj_00000000-0000-4000-8000-000000000001" } })).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.originals.deskAuthorize).not.toHaveBeenCalled();
    } finally { await value.close(); }
  });

  it("strips ref and the other internal research metadata from the evidence search and open doors, whose contract carries none", async () => {
    const f = mineFixture();
    const value = await server({ application: f.desk, ask: f.route });
    try {
      const searched = await post(value.url, PERSON_EVIDENCE_SEARCH_PATH_V1, { schema_version: 1, query: "launch" });
      expect(searched.status).toBe(200);
      const opened = await post(value.url, PERSON_EVIDENCE_OPEN_PATH_V1, { schema_version: 1, citation: f.note.citation });
      expect(opened.status).toBe(200);
      for (const response of [searched, opened]) {
        const desk = validatePersonEvidenceDeskResponseV1(response.body);
        expect(desk.items.map((item) => item.citation)).toEqual([f.cited]);
        // A meeting record's list label, like named dates, is internal too (ADR-0041); the all-source door test releases one.
        for (const key of ["ref", "dates", "date_kind", "list_label"]) expect(desk.items[0]).not.toHaveProperty(key);
        expect(JSON.stringify(response.body)).not.toContain(f.note.ref!);
      }
    } finally { await value.close(); }
  });
});
