import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { validatePersonAnswerResponseV4 } from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_ASK_ANSWER_RESERVE_MS_V1,
  AGENTIC_ASK_DEADLINE_MS_V1,
  AGENTIC_ASK_MAX_MODEL_CALLS_V1,
  createAgenticAskV1,
  type AgenticAskAuditEntryV1,
} from "../../src/answer-composition/agentic-ask-v1.js";
import type { StructuredGenerationInput, StructuredGenerationPort } from "../../src/answer-composition/retrieval-grounded-answer-composition.js";
import type { EvidenceDeskItemV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from "../../src/shared/evidence-desk-v1.js";

const generation = { generation_adapter_id: "fixture", planner_model: "ignored", answer_model: "fixture-model", timeout_ms: 30_000 };
const checked = "2026-09-27T00:00:00.000Z";

function item(id: string, text: string | undefined = `Released body for ${id}.`, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    receipt_sha256: canonicalSha256({ receipt: id }), ...options,
  });
}

/** An inventory (browse) entry: released metadata without text. */
function listedItem(id: string, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  const { text: _text, ...listed } = item(id, "unused", options);
  return Object.freeze(listed);
}

type Desk = EvidenceDeskPortV1 & { search: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; revalidate: ReturnType<typeof vi.fn> };
function desk(input: {
  readonly search?: (query: string) => readonly EvidenceDeskItemV1[];
  readonly inventory?: readonly EvidenceDeskItemV1[];
  readonly open?: (id: string) => readonly EvidenceDeskItemV1[];
  readonly revalidate?: () => Promise<{ readonly checked_at: string }>;
} = {}): Desk {
  const result = (items: readonly EvidenceDeskItemV1[], truncated = false): EvidenceDeskResultV1 => ({ items, truncated, receipt_digests: [canonicalSha256({ desk: items.length })] });
  return {
    scope: { kind: "global" },
    search: vi.fn(async (request: { readonly query?: string }) => request.query === undefined ? result(input.inventory ?? []) : result(input.search?.(request.query) ?? [])),
    open: vi.fn(async (request: { readonly item: string }) => result(input.open?.(request.item) ?? [])),
    revalidate: vi.fn(async () => input.revalidate?.() ?? { checked_at: checked }),
  } as unknown as Desk;
}

type Reply = unknown | ((input: StructuredGenerationInput) => unknown);
function scripted(replies: readonly Reply[]) {
  const inputs: StructuredGenerationInput[] = [];
  let offset = 0;
  const model: StructuredGenerationPort = {
    generate: vi.fn(async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const reply = replies[offset++];
      if (reply === undefined) throw new Error(`unscripted call ${offset}`);
      return typeof reply === "function" ? (reply as (input: StructuredGenerationInput) => unknown)(input) : reply;
    }),
  };
  return { model, inputs, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, any> };
}

const step = (parts: readonly { question?: string; status?: string; notes?: string; evidence?: readonly string[] }[], actions: readonly { tool: string; input?: string }[]) => ({
  parts: parts.map(part => ({ question: part.question ?? "When is launch?", status: part.status ?? "searching", notes: part.notes ?? "", evidence: part.evidence ?? [] })),
  actions: actions.map(action => ({ tool: action.tool, input: action.input ?? "" })),
});
const finish = (parts: readonly { question?: string; status?: string; notes?: string; evidence?: readonly string[] }[]) => step(parts, [{ tool: "finish" }]);
const answer = (parts: readonly { part: number; statements: readonly { text: string; evidence: readonly string[] }[]; gap?: string }[], direct = { text: "Launch is Tuesday.", evidence: ["E1"] }) => ({
  direct, parts: parts.map(part => ({ part: part.part, statements: part.statements, gap: part.gap ?? "" })),
});

function ask(options: { desk: Desk; model: StructuredGenerationPort; audit?: AgenticAskAuditEntryV1[]; now?: () => number; shortcut?: boolean }) {
  const audit = options.audit ?? [];
  return createAgenticAskV1({
    desk: options.desk, model: options.model, generation, audit: { append: entry => { audit.push(entry); } },
    ...(options.now === undefined ? {} : { now_ms: options.now }), ...(options.shortcut === true ? { small_scope_shortcut: true } : {}),
  });
}

describe("agentic Ask: three-tool loop", () => {
  it("searches, finishes, writes one answer, and lays out a cited V4 response", async () => {
    const launch = item("launch", "Launch is approved for Tuesday.");
    const evidence = desk({ search: () => [launch] });
    const audit: AgenticAskAuditEntryV1[] = [];
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch date" }]),
      finish([{ status: "answered", notes: "E1 says Tuesday.", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Launch is Tuesday.", evidence: ["E1"] }] }]),
    ]);
    const result = await ask({ desk: evidence, model: script.model, audit }).answer({ question: "When is launch?" });

    expect(validatePersonAnswerResponseV4(result)).toEqual(result);
    expect(result).toMatchObject({ outcome: "answered", direct: { text: "Launch is Tuesday.", citation_indexes: [0], private: false } });
    expect(result.parts).toEqual([{ question: "When is launch?", status: "answered", statements: [{ text: "Launch is Tuesday.", citation_indexes: [0], private: false }] }]);
    expect(result.citations).toEqual([{ citation: launch.citation, kind: "decision", label: "Meeting launch", visibility: "team" }]);
    // Every model call and the release are fenced by a cumulative revalidation.
    expect(evidence.revalidate).toHaveBeenCalledTimes(4);
    expect(audit).toEqual([expect.objectContaining({ outcome: "answered", rounds: 2, model_calls: 3, repairs: 0, citation_count: 1 })]);
    expect(audit[0]!.generations.map(value => value.role)).toEqual(["step", "step", "answer"]);
  });

  it("shows the model only short ids, never desk identities or citations", async () => {
    const launch = item("launch", "Launch is approved for Tuesday.");
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Launch is Tuesday.", evidence: ["E1"] }] }]),
    ]);
    await ask({ desk: desk({ search: () => [launch] }), model: script.model }).answer({ question: "When is launch?" });
    for (const input of script.inputs) {
      expect(input.user_prompt).not.toContain(launch.id);
      expect(input.user_prompt).not.toContain(launch.citation.kind === "approved_record" ? launch.citation.atom_id : "");
    }
    expect(script.prompt(1).last_results[0].results[0]).toMatchObject({ id: "E1", preview: "Launch is approved for Tuesday.", full: true });
  });

  it("browses a keyword-free scope, opens an item, and cites its full text", async () => {
    const listed = listedItem("plan", { kind: "document_passage", label: "Atlas plan.md" });
    const passage = item("plan", `Atlas plan.md\n${"Background. ".repeat(40)}The launch window is October.`, { kind: "document_passage", label: "Atlas plan.md" });
    const evidence = desk({ inventory: [listed], open: () => [passage] });
    const script = scripted([
      step([{ question: "Summarize this project" }], [{ tool: "browse" }]),
      step([{ question: "Summarize this project" }], [{ tool: "open", input: "E1" }]),
      finish([{ question: "Summarize this project", status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "The launch window is October.", evidence: ["E1"] }] }], { text: "Atlas launches in October.", evidence: ["E1"] }),
    ]);
    const result = await ask({ desk: evidence, model: script.model }).answer({ question: "Summarize this project" });
    expect(script.prompt(1).last_results[0]).toMatchObject({ tool: "browse", items: [{ id: "E1", title: "Atlas plan.md" }], more: false });
    expect(script.prompt(2).opened[0]).toMatchObject({ id: "E1", text: passage.text });
    expect(evidence.open).toHaveBeenCalledWith(expect.objectContaining({ item: listed.id }));
    expect(result.outcome).toBe("answered");
  });

  it("keeps long search hits as previews until opened, and refuses to cite unread text", async () => {
    const long = item("long", `${"Context. ".repeat(60)}Owner is Colin.`);
    const script = scripted([
      step([{ question: "Who owns it?" }], [{ tool: "search", input: "owner" }]),
      finish([{ question: "Who owns it?", status: "answered", evidence: ["E1"] }]),
      step([{ question: "Who owns it?" }], [{ tool: "open", input: "E1" }]),
      finish([{ question: "Who owns it?", status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Colin owns it.", evidence: ["E1"] }] }], { text: "Colin.", evidence: ["E1"] }),
    ]);
    const result = await ask({ desk: desk({ search: () => [long], open: () => [long] }), model: script.model }).answer({ question: "Who owns it?" });
    expect(script.prompt(1).last_results[0].results[0].full).toBe(false);
    expect(script.prompt(2).last_results[0].error).toContain("cites no item whose full text you have read");
    expect(result.outcome).toBe("answered");
  });

  it("rejects a not_found finish after fewer than two searches once, then accepts it", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "not_found" }]),
      finish([{ status: "not_found" }]),
    ]);
    const result = await ask({ desk: desk(), model: script.model }).answer({ question: "When is launch?" });
    expect(script.prompt(2).last_results[0].error).toContain("fewer than two searches");
    expect(result).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", gap: expect.any(String) }] });
    expect(script.inputs).toHaveLength(3); // no answer call without evidence
  });

  it("returns tool errors for unknown ids and invalid queries instead of failing", async () => {
    const script = scripted([
      step([{}], [{ tool: "open", input: "E99" }, { tool: "search", input: "!!!" }]),
      finish([{ status: "not_found" }]),
      finish([{ status: "not_found" }]),
    ]);
    const evidence = desk();
    await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(script.prompt(1).last_results).toEqual([
      expect.objectContaining({ tool: "open", error: expect.stringContaining("unknown id") }),
      expect.objectContaining({ tool: "search", error: expect.stringContaining("keywords") }),
    ]);
    expect(evidence.open).not.toHaveBeenCalled();
  });

  it("does not rerun a search it already ran", async () => {
    const evidence = desk({ search: () => [item("a")] });
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch date" }]),
      step([{}], [{ tool: "search", input: "Launch   date" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(evidence.search).toHaveBeenCalledTimes(1);
    expect(script.prompt(2).last_results[0].note).toContain("already searched");
  });

  it("stops researching after two steps that find nothing new", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "alpha" }]),
      step([{}], [{ tool: "search", input: "beta" }]),
      step([{}], [{ tool: "search", input: "gamma" }]),
    ]);
    const evidence = desk();
    const result = await ask({ desk: evidence, model: script.model }).answer({ question: "When is launch?" });
    expect(script.inputs).toHaveLength(2);
    expect(result.outcome).toBe("not_found");
  });

  it("repairs once with the concrete parser reason and the shape", async () => {
    const script = scripted([
      { answer_parts: [{ question: "When is launch?" }] },
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }] }]),
    ]);
    const audit: AgenticAskAuditEntryV1[] = [];
    await ask({ desk: desk({ search: () => [item("a")] }), model: script.model, audit }).answer({ question: "When is launch?" });
    expect(script.inputs[1]!.system_prompt).toContain("Your previous reply could not be used: \"parts\" must be an array (got keys \"answer_parts\")");
    expect(script.inputs[1]!.system_prompt).toContain("{\"parts\":[{\"question\"");
    expect(audit[0]).toMatchObject({ repairs: 1, model_calls: 4 });
  });

  it("accepts schema-permitted but untidy output (whitespace, casing, id spellings, empty gap)", async () => {
    const script = scripted([
      { parts: [{ question: "  When is launch?  ", status: "Searching", notes: "", evidence: [] }], actions: [{ tool: "Search", input: " launch " }] },
      { parts: [{ question: "When is launch? ", status: "answered", notes: "line one\nline two", evidence: ["e1", "[E1]"] }], actions: [{ tool: "finish", input: "" }] },
      { direct: { text: " Launch is Tuesday. ", evidence: ["1"] }, parts: [{ part: 1, statements: [{ text: "Launch is Tuesday. ", evidence: ["E1"] }], gap: "" }] },
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result).toMatchObject({ outcome: "answered", direct: { text: "Launch is Tuesday." }, parts: [{ question: "When is launch?", status: "answered" }] });
  });

  it("drops statements whose evidence is unknown or unread and keeps the rest", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Invented.", evidence: ["E9"] }, { text: "Tuesday.", evidence: ["E1", "E9"] }] }], { text: "Tuesday.", evidence: ["E9"] }),
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result.parts[0]!.statements).toEqual([{ text: "Tuesday.", citation_indexes: [0], private: false }]);
    expect(result.direct).toBeUndefined();
  });

  it("marks a part partial when the answer names a gap", async () => {
    const script = scripted([
      step([{ question: "When and who?" }], [{ tool: "search", input: "launch" }]),
      finish([{ question: "When and who?", status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }], gap: "No owner is recorded." }]),
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model }).answer({ question: "When and who?" });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "No owner is recorded." }] });
  });

  it("marks statements and the direct answer private when they cite private evidence", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }] }]),
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a", "Tuesday.", { visibility: "only_me" })] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result.parts[0]!.statements[0]!.private).toBe(true);
    expect(result.direct?.private).toBe(true);
  });
});

describe("agentic Ask: failures never lose found evidence", () => {
  const unavailable = () => Object.assign(new Error("OpenRouter request failed"), { diagnostic: { failure_class: "adapter_timeout" } });

  it("shows cited records when the answer call fails twice", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      { wrong: true }, { still: "wrong" },
    ]);
    const result = await ask({ desk: desk({ search: () => [item("a", "Launch is Tuesday.")] }), model: script.model }).answer({ question: "When is launch?" });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Launch is Tuesday.", citation_indexes: [0] }] }] });
    expect(result.direct).toBeUndefined();
  });

  it("shows the most recently opened records when the answer fails and no part cited evidence", async () => {
    const passage = item("plan", "Atlas launches in October.", { kind: "document_passage" });
    const script = scripted([
      step([{ question: "Summarize this project" }], [{ tool: "search", input: "atlas" }]),
      step([{ question: "Summarize this project" }], [{ tool: "open", input: "E1" }]),
      () => { throw Object.assign(new Error("slow"), { diagnostic: { failure_class: "adapter_timeout" } }); },
      () => { throw Object.assign(new Error("slow"), { diagnostic: { failure_class: "adapter_timeout" } }); },
      { wrong: true }, { still: "wrong" },
    ]);
    const result = await ask({ desk: desk({ search: () => [passage], open: () => [passage] }), model: script.model }).answer({ question: "Summarize this project" });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Atlas launches in October." }] }] });
  });

  it("retries a timed-out research step once unchanged, then answers from what was found", async () => {
    const script = scripted([
      step([{}], [{ tool: "search", input: "launch" }]),
      () => { throw unavailable(); },
      () => { throw unavailable(); },
      answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }] }]),
    ]);
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model: script.model, audit }).answer({ question: "When is launch?" });
    expect(result.outcome).toBe("answered");
    expect(script.inputs[2]!.system_prompt).toBe(script.inputs[1]!.system_prompt);
    expect(audit[0]).toMatchObject({ outcome: "answered", fallbacks: 1, repairs: 1, model_calls: 4 });
  });

  it("opens by title when the model passes a seen title instead of an id", async () => {
    const listed = listedItem("mrd", { kind: "document_passage", label: "SCOUT-MRD-v0.1.md" });
    const passage = item("mrd", "SCOUT is an indoor courier robot.", { kind: "document_passage", label: "SCOUT-MRD-v0.1.md" });
    const evidence = desk({ inventory: [listed], open: () => [passage] });
    const script = scripted([
      step([{}], [{ tool: "browse" }]),
      step([{}], [{ tool: "open", input: "SCOUT-MRD-v0.1" }]),
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "An indoor courier robot.", evidence: ["E1"] }] }]),
    ]);
    await ask({ desk: evidence, model: script.model }).answer({ question: "What is SCOUT?" });
    expect(evidence.open).toHaveBeenCalledWith(expect.objectContaining({ item: listed.id, neighbours: 2 }));
    expect(script.prompt(2).last_results[0]).toMatchObject({ tool: "open", opened: ["E1"] });
  });

  it("keeps research inside its budget so the answer always has its reserve", async () => {
    let clock = 0;
    const timeouts: Array<{ role: string; timeout: number; at: number }> = [];
    const model: StructuredGenerationPort = {
      generate: vi.fn(async (input: StructuredGenerationInput) => {
        const role = input.system_prompt.startsWith("You write") ? "answer" : "step";
        timeouts.push({ role, timeout: input.timeout_ms, at: clock });
        if (role === "answer") { clock += 5_000; return answer([{ part: 1, statements: [{ text: "Tuesday.", evidence: ["E1"] }] }]); }
        // A slow provider: every research step runs to its timeout.
        clock += input.timeout_ms;
        if (timeouts.length === 1) return step([{}], [{ tool: "search", input: "launch" }]);
        throw unavailable();
      }),
    };
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await ask({ desk: desk({ search: () => [item("a")] }), model, audit, now: () => clock }).answer({ question: "When is launch?" });
    expect(result.outcome).toBe("answered");
    for (const call of timeouts.filter(value => value.role === "step")) expect(call.at + call.timeout).toBeLessThanOrEqual(AGENTIC_ASK_DEADLINE_MS_V1 - AGENTIC_ASK_ANSWER_RESERVE_MS_V1);
    expect(timeouts.at(-1)!.role).toBe("answer");
    expect(audit[0]!.outcome).toBe("answered");
  });

  it("never exceeds the model-call budget under repeated invalid output", async () => {
    const model: StructuredGenerationPort = { generate: vi.fn(async () => ({ nonsense: true })) };
    const audit: AgenticAskAuditEntryV1[] = [];
    const result = await ask({ desk: desk(), model, audit }).answer({ question: "When is launch?" });
    expect((model.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(AGENTIC_ASK_MAX_MODEL_CALLS_V1);
    expect(result.outcome).toBe("not_found");
  });

  it("treats a revalidation failure as terminal and never falls back around it", async () => {
    let checks = 0;
    const evidence = desk({ search: () => [item("a")], revalidate: async () => { checks += 1; if (checks === 2) throw new Error("membership revoked"); return { checked_at: checked }; } });
    const audit: AgenticAskAuditEntryV1[] = [];
    const script = scripted([step([{}], [{ tool: "search", input: "launch" }]), finish([{ status: "answered", evidence: ["E1"] }])]);
    await expect(ask({ desk: evidence, model: script.model, audit }).answer({ question: "When is launch?" })).rejects.toThrow("membership revoked");
    expect(script.inputs).toHaveLength(1);
    expect(audit).toEqual([]);
  });

  it("audits a hung model at the hard deadline as timed_out", async () => {
    vi.useFakeTimers();
    try {
      const audit: AgenticAskAuditEntryV1[] = [];
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const model: StructuredGenerationPort = { generate: vi.fn(async () => { entered(); return new Promise<never>(() => undefined); }) };
      const pending = ask({ desk: desk(), model, audit }).answer({ question: "When is launch?" });
      await started;
      const rejected = expect(pending).rejects.toMatchObject({ name: "AgenticAskDeadlineErrorV1" });
      await vi.advanceTimersByTimeAsync(AGENTIC_ASK_DEADLINE_MS_V1);
      await rejected;
      expect(audit).toEqual([expect.objectContaining({ outcome: "timed_out", model_calls: 1, prompt_sha256: null, response_sha256: null })]);
    } finally { vi.useRealTimers(); }
  });

  it("does not publish after cancellation and writes a cancelled audit", async () => {
    const controller = new AbortController();
    const audit: AgenticAskAuditEntryV1[] = [];
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const model: StructuredGenerationPort = { generate: vi.fn(async () => { entered(); return new Promise<never>(() => undefined); }) };
    const pending = ask({ desk: desk(), model, audit }).answer({ question: "When is launch?", signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(audit.at(-1)).toMatchObject({ outcome: "cancelled", model_calls: 1, generations: [{ role: "step", finish_reason: null, usage: null }] });
  });
});

describe("agentic Ask: small-scope preload", () => {
  it("opens a small complete scope before step 1 so the model can finish at once", async () => {
    const listed = [listedItem("a"), listedItem("b")];
    const opened = new Map([[listed[0]!.id, item("a", "Full text A.")], [listed[1]!.id, item("b", "Full text B.")]]);
    const evidence = desk({ inventory: listed, open: id => [opened.get(id)!] });
    const script = scripted([
      finish([{ status: "answered", evidence: ["E1"] }]),
      answer([{ part: 1, statements: [{ text: "A.", evidence: ["E1"] }] }]),
    ]);
    const result = await ask({ desk: evidence, model: script.model, shortcut: true }).answer({ question: "When is launch?" });
    expect(evidence.search).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: "items" }));
    expect(script.prompt(0).opened.map((value: { text: string }) => value.text)).toEqual(expect.arrayContaining(["Full text A.", "Full text B."]));
    expect(result.outcome).toBe("answered");
  });
});
