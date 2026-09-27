import { describe, expect, it, vi } from "vitest";
import {
  createAgenticAskV1,
  type AgenticAskAuditEntryV1,
} from "../../src/answer-composition/agentic-ask-v1.js";
import type { EvidenceDeskItemV1, EvidenceDeskPortV1 } from "../../src/shared/evidence-desk-v1.js";
import type { StructuredGenerationInput, StructuredGenerationPort } from "../../src/answer-composition/retrieval-grounded-answer-composition.js";
import { validatePersonAnswerResponseV4 } from "@echo-brain/organization-api";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const item = (id = "e1", text = "The launch decision is approved for Tuesday.", visibility: EvidenceDeskItemV1["visibility"] = "team"): EvidenceDeskItemV1 => {
  const hex = Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64);
  return Object.freeze({
    id,
    citation: { kind: "approved_record" as const, atom_id: `sha256:${hex}` as const, record_sha256: `sha256:${hex.split("").reverse().join("")}` as const, policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, text, label: "Launch review", visibility, receipt_sha256: digest("c"),
  });
};

function desk(input: { readonly first?: readonly EvidenceDeskItemV1[]; readonly inventory?: readonly EvidenceDeskItemV1[]; readonly opened?: readonly EvidenceDeskItemV1[] } = {}) {
  const search = vi.fn(async (request: { readonly query?: string }) => ({
    items: request.query === undefined ? input.inventory ?? [] : input.first ?? [], truncated: false, receipt_digests: [digest("d")],
  }));
  const open = vi.fn(async () => ({ items: input.opened ?? [], truncated: false, receipt_digests: [digest("e")] }));
  const revalidate = vi.fn(async () => ({ checked_at: "2026-09-27T00:00:00.000Z" }));
  return Object.freeze({ scope: { kind: "global" as const }, search, open, revalidate }) as EvidenceDeskPortV1 & { search: typeof search; open: typeof open; revalidate: typeof revalidate };
}

function scripted(values: readonly unknown[]): StructuredGenerationPort {
  let offset = 0;
  return { generate: vi.fn(async (_input: StructuredGenerationInput) => values[offset++]) };
}

const plan = { parts: [{ question: "When is launch?", queries: ["launch"] }] };
const judge = { scope: { matches_question: true, note: "" }, parts: [{ id: "p1", status: "answered", evidence_ids: ["e1"], new_queries: [] }], done: true };
const writer = { statements: [{ text: "Launch is Tuesday.", evidence_ids: ["e1"] }] };
const summary = { statement: { text: "Launch is Tuesday.", evidence_ids: ["e1"] } };

describe("agentic Ask V1", () => {
  it("uses bounded evidence, admits every model call through revalidation, and makes direct cited", async () => {
    const evidence = desk({ first: [item()] });
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await createAgenticAskV1({
      desk: evidence, model: scripted([plan, judge, writer, summary]),
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { audit.push(entry); } },
    }).answer({ question: "When is launch?" });

    expect(result).toMatchObject({ outcome: "answered", direct: { private: false, citation_indexes: [0] } });
    expect(result.parts[0]).toMatchObject({ status: "answered", statements: [{ citation_indexes: [0] }] });
    expect(evidence.revalidate).toHaveBeenCalledTimes(5); // plan, judge, writer, summary, release
    expect(audit).toEqual([expect.objectContaining({ model_calls: 4, repairs: 0, citation_count: 1, response_sha256: expect.stringMatching(/^sha256:/) })]);
  });

  it("opens a bounded query-less inventory only after the first lexical round is empty", async () => {
    const catalog: EvidenceDeskItemV1 = { ...item("catalog"), text: undefined };
    const evidence = desk({ inventory: [catalog], opened: [item()] });
    const result = await createAgenticAskV1({
      desk: evidence, model: scripted([plan, judge, writer, summary]),
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: vi.fn() },
    }).answer({ question: "When is launch?" });

    expect(evidence.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(evidence.open).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("answered");
  });

  it("repairs malformed planner output once and falls back to the literal question", async () => {
    const evidence = desk({ first: [item()] });
    const audit: AgenticAskAuditEntryV1[] = [];
    const model = scripted([{ not_parts: [] }, { still: "invalid" }, judge, writer, summary]);
    const result = await createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { audit.push(entry); } },
    }).answer({ question: "When is launch?" });

    expect(result.outcome).toBe("answered");
    expect(audit[0]).toMatchObject({ repairs: 1, fallbacks: 1, model_calls: 5 });
  });

  it("does not publish a fallback after cancellation, but writes a terminal cancellation audit", async () => {
    const controller = new AbortController();
    const evidence = desk({ first: [item()] });
    const audits: AgenticAskAuditEntryV1[] = [];
    const model: StructuredGenerationPort = { generate: vi.fn(async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); }) };
    await expect(createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { audits.push(entry); } },
    }).answer({ question: "When is launch?", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(audits).toEqual([expect.objectContaining({ outcome: "cancelled", response_sha256: null })]);
  });

  it("races a model that ignores abort, so client cancellation cannot hang the request", async () => {
    const controller = new AbortController();
    const audits: AgenticAskAuditEntryV1[] = [];
    let entered!: () => void;
    const enteredModel = new Promise<void>(resolve => { entered = resolve; });
    const model: StructuredGenerationPort = { generate: vi.fn(async () => { entered(); return new Promise<never>(() => undefined); }) };
    const pending = createAgenticAskV1({
      desk: desk(), model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { audits.push(entry); } },
    }).answer({ question: "When is launch?", signal: controller.signal });
    await enteredModel;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(audits.at(-1)).toMatchObject({ outcome: "cancelled", model_calls: 1, generations: [expect.objectContaining({ role: "plan" })] });
  });

  it("repairs a truncated observed generation and retains content-free finish telemetry", async () => {
    const evidence = desk({ first: [item()] });
    let calls = 0;
    const model: StructuredGenerationPort = {
      generate: vi.fn(),
      generate_with_observation: vi.fn(async () => {
        calls += 1;
        const value = calls === 1 ? { ignored: true } : calls === 2 ? plan : calls === 3 ? judge : calls === 4 ? writer : summary;
        return {
          value,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null },
          finish_reason: calls === 1 ? "length" as const : "stop" as const,
          provider_latency_ms: 1,
        };
      }),
    };
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { audit.push(entry); } },
    }).answer({ question: "When is launch?" });
    expect(result.outcome).toBe("answered");
    expect(audit[0]).toMatchObject({ repairs: 1, finish_reason_counts: { length: 1, stop: 4 }, generation_usage: { total_tokens: 75 } });
  });

  it("falls back to exact released evidence after a retry-ineligible model transport failure", async () => {
    const evidence = desk({ first: [item()] });
    const model: StructuredGenerationPort = {
      generate: vi.fn(async (input: StructuredGenerationInput) => {
        if (input.system_prompt.includes("Split only")) return plan;
        if (input.system_prompt.includes("Mark each")) return judge;
        if (input.system_prompt.includes("Write only")) throw Object.assign(new Error("transport"), { diagnostic: { failure_class: "adapter_transport" } });
        return summary;
      }),
    };
    const result = await createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: vi.fn() },
    }).answer({ question: "When is launch?" });
    expect(result.parts[0]).toMatchObject({ status: "records_only", records: [{ text: "The launch decision is approved for Tuesday." }] });
  });

  it("removes whole trailing fallback records until the complete V4 response fits its wire bound", async () => {
    const large = Array.from({ length: 5 }, (_, part) => Array.from({ length: 5 }, (_, row) => item(`p${part}r${row}`, "x".repeat(3 * 1024))));
    const evidence: EvidenceDeskPortV1 = {
      scope: { kind: "global" },
      search: async input => ({ items: input.query?.startsWith("q") ? large[Number(input.query.slice(1))]! : [], truncated: false, receipt_digests: [digest("f")] }),
      open: async () => ({ items: [], truncated: false, receipt_digests: [] }),
      revalidate: async () => ({ checked_at: "2026-09-27T00:00:00.000Z" }),
    };
    const model: StructuredGenerationPort = { generate: vi.fn(async (input: StructuredGenerationInput) => {
      if (input.system_prompt.includes("Split only")) return { parts: Array.from({ length: 5 }, (_, index) => ({ question: `Part ${index}`, queries: [`q${index}`] })) };
      if (input.system_prompt.includes("Mark each")) return { scope: { matches_question: true, note: "" }, parts: large.map((rows, index) => ({ id: `p${index + 1}`, status: "answered", evidence_ids: rows.map(value => value.id), new_queries: [] })), done: true };
      return { statements: [{ text: "", evidence_ids: [] }] };
    }) };
    const result = await createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      validate_response: value => validatePersonAnswerResponseV4(value) as never,
      audit: { append: vi.fn() },
    }).answer({ question: "All parts" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(() => validatePersonAnswerResponseV4(result)).not.toThrow();
    expect(result.parts.some(part => part.status === "not_found" || (part.records?.length ?? 0) < 5)).toBe(true);
  });

  it("gives the judge evidence attributes and each part's complete tried-query history", async () => {
    const inputs: Array<{ readonly parts: readonly { readonly tried_queries: readonly string[] }[]; readonly evidence: readonly { readonly attributes?: unknown }[] }> = [];
    let judgments = 0;
    const rich = { ...item("one"), attributes: { owner: "Ava", status: "proposed" } } as EvidenceDeskItemV1;
    const model: StructuredGenerationPort = { generate: vi.fn(async (input: StructuredGenerationInput) => {
      if (input.system_prompt.includes("Split only")) return { parts: [{ question: "Part", queries: ["initial"] }] };
      if (input.system_prompt.includes("Mark each")) {
        inputs.push(JSON.parse(input.user_prompt));
        judgments += 1;
        return judgments === 1
          ? { scope: { matches_question: true, note: "" }, parts: [{ id: "p1", status: "partial", evidence_ids: ["one"], new_queries: ["follow-up"] }], done: false }
          : { scope: { matches_question: true, note: "" }, parts: [{ id: "p1", status: "answered", evidence_ids: ["one"], new_queries: [] }], done: true };
      }
      if (input.system_prompt.includes("Write only")) return { statements: [{ text: "Still proposed.", evidence_ids: ["one"] }] };
      return { statement: null };
    }) };
    const evidenceDesk = desk({ first: [rich] });
    evidenceDesk.search.mockImplementation(async request => ({ items: request.query === "follow-up" ? [item("two")] : [rich], truncated: false, receipt_digests: [digest("d")] }));
    await createAgenticAskV1({
      desk: evidenceDesk, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 }, audit: { append: vi.fn() },
    }).answer({ question: "Question" });
    expect(inputs[1]?.parts[0]?.tried_queries).toEqual(expect.arrayContaining(["Question", "initial", "follow-up"]));
    expect(inputs[0]?.evidence[0]?.attributes).toEqual({ owner: "Ava", status: "proposed" });
  });

  it("waits for every parallel writer cancellation observation before the terminal audit", async () => {
    const controller = new AbortController();
    let writers = 0;
    let allWritersEntered!: () => void;
    const entered = new Promise<void>(resolve => { allWritersEntered = resolve; });
    const model: StructuredGenerationPort = { generate: vi.fn(async (input: StructuredGenerationInput) => {
      if (input.system_prompt.includes("Split only")) return { parts: [{ question: "One", queries: ["one"] }, { question: "Two", queries: ["two"] }, { question: "Three", queries: ["three"] }] };
      if (input.system_prompt.includes("Mark each")) return { scope: { matches_question: true, note: "" }, parts: [{ id: "p1", status: "answered", evidence_ids: ["one"], new_queries: [] }, { id: "p2", status: "answered", evidence_ids: ["two"], new_queries: [] }, { id: "p3", status: "answered", evidence_ids: ["three"], new_queries: [] }], done: true };
      if (input.system_prompt.includes("Write only")) {
        writers += 1;
        if (writers === 3) allWritersEntered();
        return new Promise<never>(() => undefined);
      }
      return summary;
    }) };
    const evidence: EvidenceDeskPortV1 = {
      scope: { kind: "global" },
      search: async input => ({ items: input.query === "one" ? [item("one")] : input.query === "two" ? [item("two")] : input.query === "three" ? [item("three")] : [], truncated: false, receipt_digests: [digest("f")] }),
      open: async () => ({ items: [], truncated: false, receipt_digests: [] }),
      revalidate: async () => ({ checked_at: "2026-09-27T00:00:00.000Z" }),
    };
    const entries: AgenticAskAuditEntryV1[] = [];
    const pending = createAgenticAskV1({
      desk: evidence, model,
      generation: { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 1_000 },
      audit: { append: entry => { expect(entry.generations).toHaveLength(entry.model_calls); entries.push(entry); } },
    }).answer({ question: "All three", signal: controller.signal });
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(entries).toEqual([expect.objectContaining({ outcome: "cancelled", model_calls: 5, generations: expect.arrayContaining([expect.objectContaining({ role: "writer" })]) })]);
  });
});
