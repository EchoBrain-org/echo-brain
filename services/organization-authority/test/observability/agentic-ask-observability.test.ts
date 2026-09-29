import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { observeCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { createOpenRouterStructuredGenerationAdapter } from "../../../../providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../../tests/support/telemetry-fixture-vocabulary-v1.js";
import { SqlitePersonDocumentRepositoryV1 } from "../../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { createPersonDocumentApplicationV1 } from "../../src/application/document-v1.js";
import { createAskJourneyTelemetryFactoryV1 } from "../../src/composition/ask-journey-telemetry-v1.js";
import { createPersonAnswerV3Route } from "../../src/composition/person-answer-v3-route.js";
import { PersonRecordSearchIndexLagV1 } from "../../src/composition/person-record-search-route.js";
import { createStagingJourneyTelemetryTransportV1 } from "../../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js";
import { OWNER, PROJECT_ALPHA, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "../fixtures/project-context-sqlite.js";

const MODEL = "deepseek/deepseek-v3.2";
const identity = { release_sha: "a".repeat(40), build_number: 42 };
const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

type Listing = { id: string };
type Prompt = { question: string; step?: number; last_results?: { tool: string; items?: Listing[] }[]; opened?: Listing[]; evidence?: Listing[] };
type Line = Record<string, any>;

/**
 * One agentic Ask through the real staging transport: the V3 route, the
 * evidence desk, stored documents and the OpenRouter adapter with a scripted
 * provider. Everything the Explorer and dashboards read comes from `lines`.
 */
function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  database.prepare(`INSERT INTO authority_projects_v1 (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
    VALUES (?,?,?,?,?,?,?)`).run(PROJECT_ALPHA, OWNER.organization_id, "Atlas", PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
  database.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at)
    VALUES (?,?,?,?,?,?,'lead','active',?)`).run(`pgm_${randomUUID()}`, PROJECT_ALPHA, OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type, PROJECT_CONTEXT_NOW);
  let tick = Date.parse(PROJECT_CONTEXT_NOW);
  let revokeAtStep: number | undefined;
  let revoked = false;
  const authenticateAccess = () => {
    if (revoked) throw new AuthorityOperationError("unauthorized", "membership revoked");
    return authorization(OWNER, { checked_at: new Date(tick += 1000).toISOString() });
  };
  const originals = new SqlitePersonOriginalContextRetrievalV1(database, { authenticateAccess }, OWNER.organization_id);
  const repository = new SqlitePersonDocumentRepositoryV1(database, () => new Date(tick += 1000).toISOString());
  const documents = createPersonDocumentApplicationV1({ repository, authenticate: () => authorization(OWNER) });
  const bytes = Buffer.from("The launch window is October.");
  documents.upload("owner", { schema_version: 1, kind: "echo-person-document-upload-v1", request_id: randomUUID(), filename: "Atlas plan.md", title: "Atlas plan", content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: "team" }, project_id: PROJECT_ALPHA }, bytes);
  const claim = repository.claimExtraction(); if (claim === undefined) throw new Error("missing extraction claim");
  repository.completeExtraction(claim, { status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1", chunks: [{ anchor_kind: "paragraph", anchor_start: 1, text: "The launch window is October." }], message: null });

  const lines: Line[] = [];
  let heartbeat = () => {};
  const transport = createStagingJourneyTelemetryTransportV1(identity, {
    write: (line) => { lines.push(JSON.parse(line) as Line); },
    scheduler: { set_interval: (fn) => { heartbeat = fn; return 1; }, clear_interval: () => {} },
  }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, content_enabled: true });
  transport.start();
  const journeys = createAskJourneyTelemetryFactoryV1({
    vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, observer: transport.observer, ...identity,
    planner_model: MODEL, answer_model: MODEL,
  });

  // A scripted research agent behind the real adapter: list documents, open the first, finish, answer.
  const model = createOpenRouterStructuredGenerationAdapter({
    credential_ref: "fixture", credential_resolver: () => "fixture-credential-never-record",
    fetch_impl: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as { messages: { content: string }[]; response_format: { json_schema: { schema: { properties?: Record<string, unknown> } } } };
      const prompt = JSON.parse(wire.messages[1]!.content) as Prompt;
      const isAnswer = wire.response_format.json_schema.schema.properties?.sentences !== undefined;
      let reply: unknown;
      if (isAnswer) reply = { sentences: [{ text: "The launch window is October.", evidence: [prompt.evidence![0]!.id] }], not_found: [] };
      else {
        if (revokeAtStep === prompt.step) revoked = true;
        const part = (status: string, evidence: string[] = []) => ({ question: prompt.question, needs: [{ need: "launch window", status, evidence }], notes: "" });
        const listed = prompt.last_results?.find(result => result.tool === "list")?.items ?? [];
        reply = (prompt.opened ?? []).length > 0 ? { parts: [part("found", prompt.opened!.map(item => item.id))], actions: [{ tool: "finish", args: {} }] }
          : listed.length > 0 ? { parts: [part("open")], actions: [{ tool: "open", args: { id: listed[0]!.id } }] }
          : { parts: [part("open")], actions: [{ tool: "list", args: { source: "documents" } }] };
      }
      return new Response(JSON.stringify({ id: `gen-${randomUUID()}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200 });
    },
  });
  const route = createPersonAnswerV3Route({
    authority_id: "oau_project_fixture", organization_id: OWNER.organization_id, state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess } as never, originals,
    records: { initializeDesk() { throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: "openrouter", planner_model: MODEL, answer_model: MODEL, timeout_ms: 10_000 },
    audit: new SqlitePersonAgenticAskAuditV1(database),
    ask_journey_telemetry: journeys,
  });
  // The HTTP server wraps every request in this root span.
  const ask = () => observeCoreRuntimeV1("http_request", () => route.ask({ access_token: "owner", request: { schema_version: 3, question: "When is the launch window?", project_id: PROJECT_ALPHA } }), transport.core_runtime);
  return {
    ask, lines, transport,
    revokeAtStep: (step: number) => { revokeAtStep = step; },
    health: () => { heartbeat(); return lines.filter(line => line.event === "heartbeat").at(-1)!; },
  };
}

const journeyEvents = (lines: readonly Line[]) => lines.filter(line => line.kind === "echo-authority-journey-stage-v1" && line.workflow === "ask");
const coreEvents = (lines: readonly Line[]) => lines.filter(line => line.kind === "echo-authority-journey-stage-v1" && line.workflow === "core_runtime");
const closed = (lines: readonly Line[], phase: string) => coreEvents(lines).filter(line => line.diagnostic?.phase === phase && line.event !== "started");

describe("agentic Ask observability through the staging journey channel", () => {
  it("records the Ask journey, every step, desk call and model call, all linked, with nothing rejected", async () => {
    const f = fixture();
    const answer = await f.ask();
    await flush();
    expect(answer.outcome).toBe("answered");

    // The Ask journey the Explorer lists and the dashboard counts.
    const journey = journeyEvents(f.lines);
    const journeyId = journey[0]!.journey_id as string;
    expect(journey.every(line => line.journey_id === journeyId)).toBe(true);
    expect(journey.map(line => `${line.stage}:${line.event}`)).toEqual([
      "ask_validation:started", "ask_validation:succeeded", "ask_authorization:succeeded",
      "ask_retrieval:succeeded", "ask_planner:succeeded", "ask_context:succeeded", "ask_answer:succeeded",
      "ask_revalidation:succeeded", "ask_audit:succeeded", "ask_response:succeeded",
    ]);
    const stage = (name: string) => journey.find(line => line.stage === name)!;
    expect(stage("ask_retrieval").retrieval).toMatchObject({ planned_query_count: 0, released_atom_count: 1 });
    expect(stage("ask_planner").llm_usage).toMatchObject({ usage_status: "reported", provider: "openrouter", model: MODEL, total_tokens: 360 });
    expect(stage("ask_answer").llm_usage).toMatchObject({ usage_status: "reported", total_tokens: 120 });
    expect(stage("ask_answer").retrieval).toMatchObject({ citation_count: 1 });
    expect(stage("ask_context").retrieval).toMatchObject({ context_atom_count: 1 });
    expect(stage("ask_response")).toMatchObject({ outcome: "answered" });

    // One linked operation holds every desk call and model call of the request.
    const operations = new Set(coreEvents(f.lines).map(line => line.diagnostic.operation_id));
    expect(operations.size).toBe(1);
    expect(closed(f.lines, "http_request")[0]!.diagnostic.linked_journey_ids).toEqual([journeyId]);
    expect(closed(f.lines, "evidence_list").map(line => line.diagnostic.counts)).toEqual([expect.objectContaining({ included_count: 1, document_items: 1, meeting_items: 0, slack_items: 0, transcript_items: 0 })]);
    expect(closed(f.lines, "evidence_open").map(line => line.diagnostic.counts)).toEqual([expect.objectContaining({ included_count: 1, document_items: 1 })]);
    // Every model call is preceded by a desk revalidation, and the final fence adds one more.
    expect(closed(f.lines, "evidence_revalidate")).toHaveLength(5);
    expect(closed(f.lines, "ask_planner")).toHaveLength(3);
    expect(closed(f.lines, "ask_answer")).toHaveLength(1);
    const modelCalls = closed(f.lines, "model_call");
    expect(modelCalls.map(line => line.diagnostic.purpose)).toEqual(["ask_planner", "ask_planner", "ask_planner", "ask_answer"]);
    expect(modelCalls.every(line => line.diagnostic.linked_journey_ids.includes(journeyId))).toBe(true);
    expect(modelCalls[0]!.diagnostic).toMatchObject({ provider: "openrouter", model: MODEL, counts: expect.objectContaining({ total_tokens: 120 }) });

    // Development content is captured per model call; the credential never is.
    expect(f.lines.filter(line => line.content_kind === "model_request")).toHaveLength(4);
    expect(JSON.stringify(f.lines)).not.toContain("fixture-credential-never-record");
    expect(f.health().delivery).toMatchObject({ rejected_events: 0, writes_failed: 0 });
    f.transport.close();
  });

  it("closes a request the desk ended as a retrieval failure and a failed response", async () => {
    const f = fixture();
    f.revokeAtStep(2);
    await expect(f.ask()).rejects.toThrow();
    await flush();
    const journey = journeyEvents(f.lines);
    const stage = (name: string) => journey.find(line => line.stage === name)!;
    expect(stage("ask_retrieval")).toMatchObject({ event: "failed", failure_class: "authorization", retryable: false });
    expect(stage("ask_planner")).toMatchObject({ event: "skipped" });
    expect(stage("ask_response")).toMatchObject({ event: "failed", failure_class: "authorization" });
    // The desk call that met the revoked session is the failed span.
    expect(coreEvents(f.lines).filter(line => line.event === "failed").map(line => line.diagnostic.phase)).toEqual(expect.arrayContaining(["evidence_open", "http_request"]));
    expect(f.health().delivery).toMatchObject({ rejected_events: 0 });
    f.transport.close();
  });
});
