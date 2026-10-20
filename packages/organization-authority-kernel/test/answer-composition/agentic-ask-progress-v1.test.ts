import { canonicalJsonBytes, canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_RECEIPT_MAX_BYTES_V1,
  validatePersonAnswerCitationV6,
  validatePersonAnswerCitationV7,
  validatePersonAnswerResponseV6,
  validatePersonAskProgressStepEventV1,
  validatePersonAskProgressStepEventV2,
  validatePersonAskReceiptV1,
  validatePersonAskReceiptV2,
  validatePersonAskReceiptV3,
  type PersonAskProgressStepEventV3,
} from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { AGENTIC_ASK_DEADLINE_MS_V1, createAgenticAskV3, createAgenticAskV4, createAgenticAskV5, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { createAgenticAskProgressRecorderV1, createAgenticAskProgressRequestV1 } from "../../src/answer-composition/agentic-ask-progress-recorder-v1.js";
import { citationOfAgenticEvidenceItemV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { JIRA, pager, tickets } from "./fixtures/agentic-lists.js";
import { deferred } from "./fixtures/deferred.js";

/**
 * Ask progress (ADR-0039): what a streamed Ask sends while it runs, when it
 * sends a name, and what it never sends. Words the model, the plan or a body
 * holds are canaries that must never appear in any event.
 */

const checked = { checked_at: "2026-10-16T00:00:00.000Z" };
const generation = { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 30_000 };
const CANARY = { query: "zebraquery", note: "NOTE-CANARY planner hunch", need: "NEED-CANARY hypothesis", body: "BODY-CANARY", neighbour: "Neighbour passage" } as const;

const record = canonicalSha256("launch record");
const launch: EvidenceDeskItemV2 = Object.freeze<EvidenceDeskItemV2>({
  id: "desk_launch", kind: "decision", text: `Launch is Tuesday. ${CANARY.body}`, label: "Launch review", visibility: "team",
  citation: { kind: "approved_record", atom_id: canonicalSha256("launch atom"), record_sha256: record, policy_id: "organization-member-readable-person-v2" },
  receipt_sha256: canonicalSha256("launch receipt"), ref: `meeting:${record}`,
});
const documentId = `doc_${"a".repeat(64)}` as const;
const passage = (index: number, text: string, label: string): EvidenceDeskItemV2 => Object.freeze<EvidenceDeskItemV2>({
  id: `desk_prd_${index}`, kind: "document_passage", text, label, visibility: "only_me",
  citation: { kind: "source_revision", source_id: `source:${"d".repeat(64)}`, revision_id: "revision-1", document_id: documentId,
    source_sha256: canonicalSha256("prd"), representation_sha256: canonicalSha256("prd text"), anchor_sha256: canonicalSha256(`anchor ${index}`) },
  receipt_sha256: canonicalSha256(`prd receipt ${index}`), ref: `document:${documentId}`,
});
// Too long to be shown in full from a search: research must open it.
const prd = passage(2, `The PRD sets launch on Tuesday. ${CANARY.body} ${"detail ".repeat(600)}`, "Launch PRD");
const before = passage(1, "Earlier context.", CANARY.neighbour);
const after = passage(3, "Later context.", CANARY.neighbour);
const ticketCitation = (id: string) => ({ kind: "ticket" as const, tool_id: "jira", external_scope_id: "11111111-1111-4111-8111-111111111111", ticket_id: id, permalink: `https://fixture.atlassian.net/browse/ECHO-${id}`, text_sha256: sha256Digest("") });
const ticket = (id: string): EvidenceDeskItemV2 => Object.freeze({ id: `desk_ticket_${id}`, kind: "ticket", citation: ticketCitation(id), label: `ECHO-${id}: metadata only`, visibility: "only_me", receipt_sha256: canonicalSha256(`ticket ${id}`) });
const result = (items: readonly EvidenceDeskItemV2[], extra: Partial<EvidenceDeskResultV2> = {}): EvidenceDeskResultV2 => ({ items, truncated: false, receipt_digests: items.map(item => item.receipt_sha256), ...extra });

type Log = string[];
/** The question's plan: notes and needs carry canaries the stream must never send. */
const part = (status: "open" | "found", evidence: readonly string[] = []) => [{ question: "When is launch?", notes: CANARY.note, needs: [{ need: CANARY.need, status, evidence }] }];
const replies = (prompt: { readonly evidence?: readonly { readonly id: string }[] }, index: number) => [
  { parts: part("open"), actions: [{ tool: "search", args: { query: `launch ${CANARY.query}` } }] },
  { parts: part("open"), actions: [{ tool: "open", args: { id: "E2" } }, { tool: "search", args: { source: "tickets", query: "tuesday" } }] },
  { parts: part("found", ["E1", "E2"]), actions: [{ tool: "finish", args: {} }] },
  { sentences: [{ text: "Launch is Tuesday.", evidence: [prompt.evidence?.[0]?.id ?? "E1"] }], not_found: [] },
][index];

/**
 * One global Ask over meetings, documents and live tickets. Step 1 searches
 * every source; step 2 opens the PRD (which brings neighbours) and searches
 * tickets again; step 3 finishes; then the writer. `inventory` is what the
 * small-scope preload's search returns; `version` 8 runs the V8 Ask, which
 * streams progress V3.
 */
function fixture(options: {
  readonly revalidate?: (mode: string, index: number) => void;
  readonly generate?: (input: StructuredGenerationInput, index: number) => Promise<unknown> | undefined;
  readonly small_scope?: boolean;
  readonly inventory?: EvidenceDeskResultV2;
  readonly version?: 6 | 8;
} = {}) {
  const log: Log = [];
  let checks = 0; let calls = 0;
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: "global" }, ticket_available: true,
    live_sources: [{ source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" }],
    search: vi.fn(async input => {
      log.push(`search:${input.source ?? "all"}`);
      if (input.inventory_mode === "items") return options.inventory ?? result([launch]);
      // The ticket search releases a known item again, says it was cut short, and carries a receipt for more than it shows.
      if (input.source === "jira") return result([launch, ticket("2")], { truncated: true, receipt_digests: [canonicalSha256("unseen release"), ticket("2").receipt_sha256] });
      return result([launch, prd, ticket("1")]);
    }),
    open: vi.fn(async input => {
      log.push(`open:${input.item}`);
      if (input.item === launch.id) return result([launch]);
      return result([before, prd, after]);
    }),
    list: vi.fn(async () => { throw new Error("unexpected list"); }),
    revalidate: vi.fn(async input => {
      const mode = input.mode ?? "full";
      log.push(`revalidate:${mode}`);
      options.revalidate?.(mode, checks++);
      return checked;
    }),
  };
  const prompts: StructuredGenerationInput[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const index = calls++;
    prompts.push(input);
    const writer = (input.schema.properties as Record<string, unknown>).sentences !== undefined;
    log.push(`generate:${writer ? "answer" : "step"}`);
    const custom = options.generate?.(input, index);
    if (custom !== undefined) return custom;
    return replies(JSON.parse(input.user_prompt) as { evidence?: { id: string }[] }, index);
  });
  const audit: AgenticAskAuditEntryV1[] = [];
  const core = { desk, model: { generate }, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); } },
    ...(options.small_scope === true ? { small_scope_shortcut: true } : {}) };
  const ask = options.version === 8 ? createAgenticAskV5(core) : createAgenticAskV3(core);
  const events: PersonAskProgressStepEventV3[] = [];
  const sink = vi.fn((event: PersonAskProgressStepEventV3) => { events.push(event); log.push(`event:${event.type}`); });
  return { desk, generate, prompts, audit, ask, events, sink, log };
}

const digest = (item: EvidenceDeskItemV2) => canonicalSha256(item.citation);
const named = (item: EvidenceDeskItemV2) => validatePersonAnswerCitationV6(citationOfAgenticEvidenceItemV1(item));
const every = [{ kind: "meetings" }, { kind: "documents" }, { kind: "tickets", tool_id: "jira" }];

/** Nothing the model wrote, nothing the plan holds, no body, scratchpad id, desk id or receipt. */
function expectNoDisclosure(events: readonly PersonAskProgressStepEventV3[]) {
  for (const event of events) expect(validatePersonAskProgressStepEventV1(event)).toEqual(event);
  const wire = JSON.stringify(events);
  for (const canary of Object.values(CANARY)) expect(wire).not.toContain(canary);
  expect(wire).not.toMatch(/\bE\d+\b/u);
  expect(wire).not.toContain("desk_");
  expect(wire).not.toContain("tuesday");
  expect(wire).not.toContain("metadata only");
  for (const item of [launch, prd, before, after, ticket("1"), ticket("2")]) expect(wire).not.toContain(item.receipt_sha256);
  expect(wire).not.toContain(canonicalSha256("unseen release"));
  expect(wire).not.toMatch(/round|rounds|step|needs|notes|query/u);
}

describe("agentic Ask progress (ADR-0039)", () => {
  it("streams stages, searched rows with released counts, and names only after the access check before the call that reads them", async () => {
    const f = fixture();
    const { response, receipt } = await f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink });

    // The first step reads nothing yet: no stage until its search.
    expect(f.events).toEqual([
      { type: "stage", stage: "searching" },
      { type: "searched", sources: every, found: 3 },
      { type: "stage", stage: "reading", pending: 1 },
      { type: "read", items: [named(launch)] },
      { type: "stage", stage: "searching" },
      // Only the new ticket: the known item and the receipt for what the read did not return are not counted.
      { type: "searched", sources: [{ kind: "tickets", tool_id: "jira" }], found: 1 },
      { type: "stage", stage: "reading", pending: 1 },
      // The open's anchor; never the neighbours it brought, nor a metadata-only ticket row.
      { type: "read", items: [named(prd)] },
      { type: "stage", stage: "writing" },
      { type: "stage", stage: "checking_access" },
    ]);
    // Each name follows the incremental check before the step call that reads it in full, and precedes that call.
    const nonEvent = (from: number, step: 1 | -1) => { for (let index = from + step; index >= 0 && index < f.log.length; index += step) if (!f.log[index]!.startsWith("event:")) return f.log[index]; return undefined; };
    const reads = f.log.flatMap((entry, index) => entry === "event:read" ? [index] : []);
    expect(reads).toHaveLength(2);
    for (const index of reads) {
      expect(nonEvent(index, -1)).toBe("revalidate:incremental");
      expect(nonEvent(index, 1)).toBe("generate:step");
    }
    // The first name waits for the second step's check; the first check only covered the empty first step.
    expect(f.log.indexOf("event:read")).toBeGreaterThan(f.log.indexOf("search:all"));
    expect(f.log.slice(0, f.log.indexOf("event:read")).filter(entry => entry === "revalidate:incremental")).toHaveLength(2);
    expectNoDisclosure(f.events);

    expect(validatePersonAnswerResponseV6(response)).toMatchObject({ outcome: "answered" });
    expect(validatePersonAskReceiptV1(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      looked_through: 2,
      rows: [
        { type: "searched", sources: every, found: 3 },
        { type: "read", items: [named(launch)] },
        { type: "searched", sources: [{ kind: "tickets", tool_id: "jira" }], found: 1 },
        { type: "read", items: [named(prd)] },
      ],
    });
    expect(receipt.elapsed_ms).toBeGreaterThanOrEqual(0);
    // The request's one audit record lists what was named, as citation commitments only.
    expect(f.audit).toEqual([expect.objectContaining({ outcome: "answered", named_citation_digests: [digest(launch), digest(prd)] })]);
    expect(JSON.stringify(f.audit)).not.toContain("Launch review");
  });

  it("keeps research and the answer unchanged with a sink that throws, and audits no names when nothing streams", async () => {
    const plain = fixture();
    const answer = await plain.ask.answer({ question: "When is launch?" });
    expect(plain.audit).toHaveLength(1);
    expect(plain.audit[0]).not.toHaveProperty("named_citation_digests");

    const streamed = fixture();
    const throwing = vi.fn(() => { throw new Error("sink failure"); });
    const { response } = await streamed.ask.answerWithReceipt({ question: "When is launch?", on_progress: throwing });
    expect(response).toEqual(answer);
    expect(streamed.prompts.map(input => input.user_prompt)).toEqual(plain.prompts.map(input => input.user_prompt));
    expect(throwing).toHaveBeenCalled();
    // What the throwing sink was handed still counts as named.
    expect(streamed.audit[0]).toMatchObject({ named_citation_digests: [digest(launch), digest(prd)] });
  });

  it("names nothing a check has seen revoked, and stops at the refusal", async () => {
    // The check before step 3 is the first to cover the opened PRD, and the person lost it.
    const f = fixture({ revalidate: (mode, index) => { if (mode === "incremental" && index === 2) throw new AuthorityOperationError("unauthorized", "the PRD is no longer readable"); } });
    await expect(f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink })).rejects.toMatchObject({ code: "unauthorized" });
    const read = f.events.filter(event => event.type === "read");
    expect(read).toEqual([{ type: "read", items: [named(launch)] }]);
    // The count went out before the check; no name, and nothing at all, after it.
    expect(f.events.at(-1)).toEqual({ type: "stage", stage: "reading", pending: 1 });
    expect(f.log.slice(f.log.lastIndexOf("revalidate:incremental") + 1).filter(entry => entry.startsWith("event:"))).toEqual([]);
    expectNoDisclosure(f.events);
    // A refused check writes no request record (ADR-0039 records the gap); the desk's release audits cover the name.
    expect(f.audit).toEqual([]);
  });

  it("sends no receipt and nothing further when the final check refuses the answer", async () => {
    const f = fixture({ revalidate: mode => { if (mode === "full") throw new AuthorityOperationError("unauthorized", "membership ended"); } });
    await expect(f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink })).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.events.at(-1)).toEqual({ type: "stage", stage: "checking_access" });
    expect(f.audit).toEqual([]);
  });

  it("emits nothing after a cancel, and audits what was named on the cancelled witness", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const f = fixture({ generate: (_input, index) => {
      if (index !== 3) return undefined;
      entered.resolve();
      return new Promise<never>(() => undefined);
    } });
    const pending = f.ask.answerWithReceipt({ question: "When is launch?", signal: controller.signal, on_progress: f.sink });
    await entered.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const sent = f.events.length;
    expect(f.events.at(-1)).toEqual({ type: "stage", stage: "writing" });
    controller.abort();
    await rejected;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.events).toHaveLength(sent);
    expect(f.audit).toEqual([expect.objectContaining({ outcome: "cancelled", named_citation_digests: [digest(launch), digest(prd)] })]);
  });

  it("emits nothing after the deadline, and audits what was named on the timed-out witness", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      // Step 2's call hangs after its check passed and named the launch review.
      const f = fixture({ generate: (_input, index) => {
        if (index !== 1) return undefined;
        entered.resolve();
        return new Promise<never>(() => undefined);
      } });
      const pending = f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink });
      await entered.promise;
      const rejected = expect(pending).rejects.toMatchObject({ name: "AgenticAskDeadlineErrorV1" });
      const sent = f.events.length;
      await vi.advanceTimersByTimeAsync(AGENTIC_ASK_DEADLINE_MS_V1);
      await rejected;
      expect(f.events).toHaveLength(sent);
      expect(f.events.filter(event => event.type === "read")).toEqual([{ type: "read", items: [named(launch)] }]);
      expect(f.audit).toEqual([expect.objectContaining({ outcome: "timed_out", named_citation_digests: [digest(launch)] })]);
    } finally { vi.useRealTimers(); }
  });

  it("reports the small-scope preload as one search of every source, and names what it read at the first step", async () => {
    const f = fixture({ small_scope: true, generate: (input, index) => {
      if (index === 0) return Promise.resolve({ parts: part("found", ["E1"]), actions: [{ tool: "finish", args: {} }] });
      if (index === 1) return Promise.resolve({ sentences: [{ text: "Launch is Tuesday.", evidence: [(JSON.parse(input.user_prompt) as { evidence: { id: string }[] }).evidence[0]!.id] }], not_found: [] });
      return undefined;
    } });
    const { receipt } = await f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink });
    expect(f.events).toEqual([
      { type: "stage", stage: "searching" },
      { type: "searched", sources: every, found: 1 },
      { type: "stage", stage: "reading", pending: 1 },
      { type: "read", items: [named(launch)] },
      { type: "stage", stage: "writing" },
      { type: "stage", stage: "checking_access" },
    ]);
    expect(receipt).toMatchObject({ looked_through: 1, rows: [{ type: "searched", sources: every, found: 1 }, { type: "read", items: [named(launch)] }] });
  });

  it("adds no searched row and finds nothing for a preload research is never shown, and still says an empty one found nothing", async () => {
    // Everything the person can see did not fit the preload, so research starts blind and its own search finds all three.
    const cut = fixture({ small_scope: true, inventory: result([launch, prd, ticket("1")], { truncated: true }) });
    const { receipt } = await cut.ask.answerWithReceipt({ question: "When is launch?", on_progress: cut.sink });
    const searched = [{ type: "searched", sources: every, found: 3 }, { type: "searched", sources: [{ kind: "tickets", tool_id: "jira" }], found: 1 }];
    expect(cut.events.filter(event => event.type === "searched")).toEqual(searched);
    expect(receipt.rows.filter(row => row.type === "searched")).toEqual(searched);
    // The person can see nothing: the preload is shown in full, and it found nothing.
    const empty = fixture({ small_scope: true, inventory: result([]) });
    await empty.ask.answerWithReceipt({ question: "When is launch?", on_progress: empty.sink });
    expect(empty.events.filter(event => event.type === "searched")).toEqual([{ type: "searched", sources: every, found: 0 }, ...searched]);
  });

  it("counts as found only the preload items research is shown", async () => {
    // The preload fits, but opening the ticket returns none of its text, so research is shown the launch review alone.
    const f = fixture({ small_scope: true, inventory: result([launch, ticket("1")]), generate: (input, index) => {
      if (index === 0) return Promise.resolve({ parts: part("found", ["E1"]), actions: [{ tool: "finish", args: {} }] });
      if (index === 1) return Promise.resolve({ sentences: [{ text: "Launch is Tuesday.", evidence: [(JSON.parse(input.user_prompt) as { evidence: { id: string }[] }).evidence[0]!.id] }], not_found: [] });
      return undefined;
    } });
    const { receipt } = await f.ask.answerWithReceipt({ question: "When is launch?", on_progress: f.sink });
    expect(f.events.filter(event => event.type === "searched")).toEqual([{ type: "searched", sources: every, found: 1 }]);
    expect(receipt).toMatchObject({ looked_through: 1, rows: [{ type: "searched", sources: every, found: 1 }, { type: "read", items: [named(launch)] }] });
  });

  it("names nothing an earlier attempt of the request named, audits each attempt's own names, and times the receipt from the request's start", async () => {
    let clock = 1_000;
    const request = createAgenticAskProgressRequestV1(() => clock);
    const first = fixture();
    await first.ask.answerWithReceipt({ question: "When is launch?", on_progress: first.sink, request });
    clock += 5_000;
    // The restarted attempt reads the same two items on the same stream.
    const second = fixture();
    const { receipt } = await second.ask.answerWithReceipt({ question: "When is launch?", on_progress: second.sink, request });
    expect(second.events.filter(event => event.type === "read")).toEqual([]);
    // Each step still reads, with no count of names that will not come.
    expect(second.events.filter(event => event.type === "stage" && event.stage === "reading")).toEqual([{ type: "stage", stage: "reading" }, { type: "stage", stage: "reading" }]);
    expect(first.audit).toEqual([expect.objectContaining({ outcome: "answered", named_citation_digests: [digest(launch), digest(prd)] })]);
    expect(second.audit).toEqual([expect.objectContaining({ outcome: "answered", named_citation_digests: [] })]);
    // The receipt is this attempt's own: what it read, none of the first attempt's names, and the request's time.
    expect(receipt).toEqual({ looked_through: 2, elapsed_ms: 5_000, rows: [{ type: "searched", sources: every, found: 4 }] });
  });
});

describe("the receipt counts what research looked through (ADR-0043)", () => {
  const question = "Which Jira tickets are open?";
  const need = (status: "open" | "found", first = false) => [{ question, needs: [{ ...(first ? {} : { id: "N1" }), need: "open Jira tickets", kind: "which_items", status, evidence: status === "found" ? ["L1"] : [] }], notes: "" }];
  const LIST = { tool: "list", args: { source: "tickets" } } as const;
  const jira = [{ kind: "tickets", tool_id: "jira" }];
  /**
   * An Ask that only lists rows: one fetch returns Jira's 30 metadata-only rows, research is given 25 and then the other
   * 5, and it finishes on the list, which the writer states. It opens and reads nothing in full.
   */
  function listOnly(core: typeof createAgenticAskV4 | typeof createAgenticAskV5) {
    const replies = [
      { parts: need("open", true), actions: [LIST] }, { parts: need("open"), actions: [LIST] }, { parts: need("found"), actions: [{ tool: "finish", args: {} }] },
      { lists: [{ id: "L1" }], sentences: [], not_found: [] },
    ];
    const list = pager(tickets(1, 30), 50, {}, { page_full: false });
    const desk: EvidenceDeskPortV2 = {
      scope: { kind: "global" }, ticket_available: true, live_sources: [JIRA], list, revalidate: vi.fn(async () => checked),
      search: vi.fn(async () => { throw new Error("unexpected search"); }), open: vi.fn(async () => { throw new Error("unexpected open"); }),
    };
    const generate = vi.fn(async () => replies.shift());
    const ask = core({ desk, model: { generate }, generation, audit: { append: () => undefined } });
    const events: PersonAskProgressStepEventV3[] = [];
    return { ask, list, generate, events, sink: (event: PersonAskProgressStepEventV3) => { events.push(event); } };
  }

  it("counts every row of an Ask that only listed rows, and finds each page research was given, never the rows fetched behind it", async () => {
    const run = listOnly(createAgenticAskV5);
    const { response, receipt } = await run.ask.answerWithReceipt({ question, on_progress: run.sink });
    expect(response.outcome).toBe("answered");
    expect(run.generate).toHaveBeenCalledTimes(4);
    // One fetch returned all 30; the second page came from it.
    expect(run.list).toHaveBeenCalledTimes(1);
    expect(run.events.filter(event => event.type === "searched")).toEqual([{ type: "searched", sources: jira, found: 25 }, { type: "searched", sources: jira, found: 5 }]);
    expect(run.events.filter(event => event.type === "read")).toEqual([]);
    expect(validatePersonAskReceiptV3(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({ looked_through: 30, rows: [{ type: "searched", sources: jira, found: 30 }] });
  });

  it("keeps progress V2's count of items read in full for the same Ask", async () => {
    const run = listOnly(createAgenticAskV4);
    const { receipt } = await run.ask.answerWithReceipt({ question, on_progress: run.sink });
    expect(validatePersonAskReceiptV2(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({ looked_through: 0, rows: [{ type: "searched", sources: jira, found: 30 }] });
  });

  it("counts in progress V3 the rows and previews research was shown, never the neighbours an open brought along", async () => {
    const v3 = fixture({ version: 8 });
    const { receipt } = await v3.ask.answerWithReceipt({ question: "When is launch?", on_progress: v3.sink });
    expect(validatePersonAskReceiptV3(receipt)).toEqual(receipt);
    // Read in full: the launch review and the PRD research opened. Shown as rows only: both metadata-only tickets. Not
    // counted: the passages around the PRD that its open brought along. Named, as in V1: only what was read in full.
    expect(receipt).toMatchObject({ looked_through: 4, rows: [
      { type: "searched", sources: every, found: 3 }, { type: "read", items: [named(launch)] },
      { type: "searched", sources: [{ kind: "tickets", tool_id: "jira" }], found: 1 }, { type: "read", items: [named(prd)] },
    ] });
    expectNoDisclosure(v3.events);
    const v1 = fixture();
    expect((await v1.ask.answerWithReceipt({ question: "When is launch?", on_progress: v1.sink })).receipt.looked_through).toBe(2);
  });
});

describe("agentic Ask progress recorder", () => {
  const sources = [
    { source_id: "meeting", kinds: ["decision"] }, { source_id: "document", kinds: ["document_passage"] },
    { source_id: "jira", kinds: ["ticket"], tool_id: "jira" }, { source_id: "wiki_pages", kinds: ["page"] },
    { source_id: "slack", kinds: ["slack_message"] },
  ];
  const many = (count: number, label = (index: number) => `Decision ${index}`) => Array.from({ length: count }, (_, index): EvidenceDeskItemV2 => ({
    ...launch, id: `desk_${index}`, label: label(index),
    citation: { kind: "approved_record", atom_id: canonicalSha256(`atom ${index}`), record_sha256: record, policy_id: "organization-member-readable-person-v2" },
  }));

  it("names each item once, at most 100 in a run, in read events of at most 25, and keeps counting what it read", () => {
    const events: PersonAskProgressStepEventV3[] = [];
    const recorder = createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: new AbortController().signal });
    const items = many(130);
    // A call given nothing in full is not reading.
    recorder.research.before_check([]);
    expect(events).toEqual([]);
    recorder.research.before_check(items.slice(0, 60));
    recorder.research.given(items.slice(0, 60));
    recorder.research.given(items.slice(0, 60));
    recorder.research.before_check([...items.slice(0, 60), ...items]);
    recorder.research.given(items);
    const reads = events.filter(event => event.type === "read");
    expect(reads.map(event => event.items.length)).toEqual([25, 25, 10, 25, 15]);
    expect(reads.flatMap(event => event.items).map(item => item.label)).toEqual(items.slice(0, PERSON_ASK_PROGRESS_NAMED_MAX_V1).map(item => item.label));
    expect(events.filter(event => event.type === "stage")).toEqual([{ type: "stage", stage: "reading", pending: 60 }, { type: "stage", stage: "reading", pending: 70 }]);
    expect(Math.max(...reads.map(event => event.items.length))).toBeLessThanOrEqual(PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1);
    expect(recorder.named_citation_digests()).toEqual(items.slice(0, 100).map(digest));
    const receipt = recorder.receipt(1234.4);
    expect(receipt).toMatchObject({ looked_through: 130, elapsed_ms: 1234 });
    expect(receipt.rows).toHaveLength(1);
  });

  it("fits the receipt to its byte bound by dropping names from the end, keeping looked_through", () => {
    const recorder = createAgenticAskProgressRecorderV1({ sink: () => undefined, sources, signal: new AbortController().signal });
    const items = many(100, index => `Decision ${index} ${"x".repeat(980)}`);
    recorder.research.given(items);
    const receipt = recorder.receipt(10);
    expect(canonicalJsonBytes(receipt).byteLength).toBeLessThanOrEqual(PERSON_ASK_RECEIPT_MAX_BYTES_V1);
    const listed = receipt.rows.flatMap(row => row.type === "read" ? row.items : []);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(100);
    expect(listed.map(item => item.label)).toEqual(items.slice(0, listed.length).map(item => item.label));
    expect(receipt.looked_through).toBe(100);
  });

  it("maps searched sources from the catalog, never a selector, and drops one with no displayable tool id", () => {
    const events: PersonAskProgressStepEventV3[] = [];
    const recorder = createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: new AbortController().signal });
    recorder.research.reads(true);
    recorder.research.returned("search", undefined, [launch]);
    recorder.research.returned("list", "slack", [launch]);
    recorder.research.returned("search", "document", [prd, before]);
    recorder.research.reads_done();
    // A batch that only opened gave research no rows: no searched row.
    recorder.research.reads(false);
    recorder.research.reads_done();
    expect(events).toEqual([
      { type: "stage", stage: "searching" },
      // The catalog's underscore source id cannot be shown. The listed launch review counts once.
      { type: "searched", sources: [{ kind: "meetings" }, { kind: "documents" }, { kind: "tickets", tool_id: "jira" }, { kind: "slack" }], found: 3 },
      { type: "stage", stage: "reading" },
    ]);
  });

  it("counts as found only what no earlier search or list gave research", () => {
    const events: PersonAskProgressStepEventV3[] = [];
    const recorder = createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: new AbortController().signal });
    const step = (reads: () => void) => { recorder.research.reads(true); reads(); recorder.research.reads_done(); };
    step(() => recorder.research.returned("search", "document", [prd]));
    step(() => recorder.research.returned("search", "meeting", [launch, prd]));
    step(() => recorder.research.returned("list", "document", [before, after, prd, passage(4, "More.", "Launch PRD")]));
    expect(events.filter(event => event.type === "searched").map(event => event.type === "searched" ? event.found : null)).toEqual([1, 1, 3]);
  });

  it("counts in V3 each item a research call was shown, as a row or in full, once, while V1 counts what it read in full", () => {
    const run = (version: 1 | 3) => {
      const recorder = createAgenticAskProgressRecorderV1({ sink: () => undefined, version, sources, signal: new AbortController().signal });
      recorder.research.given([launch], [launch, ticket("1"), ticket("2")]);
      // The next call shows both rows again and reads the PRD in full.
      recorder.research.given([prd], [launch, prd, ticket("1"), ticket("2")]);
      return recorder.receipt(10);
    };
    const v3 = run(3);
    expect(validatePersonAskReceiptV3(v3)).toEqual(v3);
    expect(v3.looked_through).toBe(4);
    expect(v3.rows.flatMap(row => row.type === "read" ? row.items.map(item => item.label) : [])).toEqual(["Launch review", "Launch PRD"]);
    expect(run(1).looked_through).toBe(2);
  });

  it("sends nothing after the run's signal aborts or the run settles, and drops an item its projection refuses", () => {
    const events: PersonAskProgressStepEventV3[] = [];
    const controller = new AbortController();
    const recorder = createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: controller.signal });
    const invalid: EvidenceDeskItemV2 = { ...launch, id: "desk_bad", label: "", citation: { ...launch.citation, atom_id: canonicalSha256("bad") } as EvidenceDeskItemV2["citation"] };
    recorder.research.given([invalid, launch]);
    expect(events).toEqual([{ type: "read", items: [named(launch)] }]);
    controller.abort();
    recorder.research.given(many(3));
    recorder.stage("writing");
    expect(events).toHaveLength(1);
    expect(recorder.named_citation_digests()).toEqual([digest(launch)]);
    const settled = createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: new AbortController().signal });
    settled.settle();
    settled.research.reads(true);
    settled.research.given([launch]);
    expect(events).toHaveLength(1);
    expect(settled.named_citation_digests()).toEqual([]);
  });

  it("names follow-ups only in progress V2 (ADR-0040): a V1 run reads one but never names it or its source", () => {
    const withFollowUps = [...sources, { source_id: "follow_ups", kinds: ["follow_up"] }];
    const followUp: EvidenceDeskItemV2 = Object.freeze<EvidenceDeskItemV2>({
      id: "desk_follow_up", kind: "follow_up", text: `Owner: Mara Lind. ${CANARY.body}`, label: "Ship fan curve v2", visibility: "team",
      citation: { kind: "follow_up", item_id: "itm_fan-curve-2" }, receipt_sha256: canonicalSha256("follow-up receipt"), ref: "follow_up:itm_fan-curve-2",
    });
    const run = (recorder: ReturnType<typeof createAgenticAskProgressRecorderV1>) => {
      recorder.research.reads(true);
      recorder.research.returned("search", undefined, [followUp, launch]);
      recorder.research.reads_done();
      recorder.research.before_check([followUp, launch]);
      recorder.research.given([followUp, launch]);
      return recorder.receipt(42);
    };

    const v2: PersonAskProgressStepEventV3[] = [];
    const v2Receipt = run(createAgenticAskProgressRecorderV1({ sink: event => { v2.push(event); }, version: 2, sources: withFollowUps, signal: new AbortController().signal }));
    const asV7 = (item: EvidenceDeskItemV2) => validatePersonAnswerCitationV7(citationOfAgenticEvidenceItemV1(item));
    expect(v2).toEqual([
      { type: "stage", stage: "searching" },
      { type: "searched", sources: [{ kind: "meetings" }, { kind: "documents" }, { kind: "tickets", tool_id: "jira" }, { kind: "slack" }, { kind: "follow_ups" }], found: 2 },
      { type: "stage", stage: "reading", pending: 2 },
      { type: "read", items: [asV7(followUp), asV7(launch)] },
    ]);
    for (const event of v2) expect(validatePersonAskProgressStepEventV2(event)).toEqual(event);
    expect(validatePersonAskReceiptV2(v2Receipt)).toEqual(v2Receipt);
    expect(v2Receipt.rows.at(-1)).toEqual({ type: "read", items: [asV7(followUp), asV7(launch)] });
    expect(JSON.stringify(v2)).not.toContain(CANARY.body);

    // The V6 answer's stream: the follow-up counts as read, but neither it nor its source kind is ever named.
    const v1: PersonAskProgressStepEventV3[] = [];
    const v1Receipt = run(createAgenticAskProgressRecorderV1({ sink: event => { v1.push(event); }, sources: withFollowUps, signal: new AbortController().signal }));
    for (const event of v1) expect(validatePersonAskProgressStepEventV1(event)).toEqual(event);
    expect(JSON.stringify(v1)).not.toContain("follow_up");
    expect(v1.filter(event => event.type === "read")).toEqual([{ type: "read", items: [named(launch)] }]);
    expect(validatePersonAskReceiptV1(v1Receipt)).toEqual(v1Receipt);
    expect(v1Receipt.looked_through).toBe(2);
  });

  it("shares one request's names across its attempts: none named twice, all within the bound, each attempt's digests its own", () => {
    const request = createAgenticAskProgressRequestV1();
    const events: PersonAskProgressStepEventV3[] = [];
    const attempt = () => createAgenticAskProgressRecorderV1({ sink: event => { events.push(event); }, sources, signal: new AbortController().signal, named: request.named });
    const items = many(120);
    const first = attempt();
    first.research.given(items.slice(0, 90));
    const second = attempt();
    second.research.before_check(items.slice(80, 95));
    second.research.given(items.slice(80, 120));
    const reads = events.filter(event => event.type === "read").flatMap(event => event.items);
    expect(reads.map(item => item.label)).toEqual(items.slice(0, PERSON_ASK_PROGRESS_NAMED_MAX_V1).map(item => item.label));
    expect(events.filter(event => event.type === "stage")).toEqual([{ type: "stage", stage: "reading", pending: 5 }]);
    expect(first.named_citation_digests()).toEqual(items.slice(0, 90).map(digest));
    expect(second.named_citation_digests()).toEqual(items.slice(90, 100).map(digest));
    expect(request.named.size).toBe(PERSON_ASK_PROGRESS_NAMED_MAX_V1);
    // The second attempt read 40, ten of which the first had named; its receipt lists only its own names.
    const receipt = second.receipt(request.elapsed());
    expect(receipt.looked_through).toBe(40);
    expect(receipt.rows.flatMap(row => row.type === "read" ? row.items : []).map(item => item.label)).toEqual(items.slice(90, 100).map(item => item.label));
  });
});
