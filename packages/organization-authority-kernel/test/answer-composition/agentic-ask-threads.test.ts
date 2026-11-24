import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
  type PersonAnswerCitationV8,
  type PersonAnswerPreviousV1,
  type PersonAnswerResponseV8,
  type PersonAnswerThreadV1,
  type PersonAskProgressStepEventV3,
} from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { AGENTIC_READ_SILENCE_MS_V1, createAgenticAskV5, type AgenticAskAuditEntryV1, type AgenticResolutionKeptV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticAskAnswerSha256V1 } from "../../src/answer-composition/agentic-ask-v1-response.js";
import { agenticResolutionKeyV1, FOLLOW_UP_RESOLVER_PROMPT, THREAD_RESOLVER_PROMPT, threadPlacementSchema } from "../../src/answer-composition/agentic-follow-up-resolver-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { checked, generation, record, recorded, result, writerReply } from "./fixtures/agentic-scenarios.js";

/**
 * The asker's threads on a V8 Ask (ADR-0056, Ask threads v1 T3): one resolution places the question (the open thread,
 * a new one, or other threads) before research, and each place has one path through the request, which ends in one
 * released answer or in one audited stop. The thread resolver's own reading is agentic-thread-resolver-v1.test.ts.
 */

const JIRA = { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" } as const;
const TICKET_TEXT = "THERM-482: Thermal fixture fails at 45 °C. Status: In Progress. Assignee: Dev Patel. Root cause: the heater controller overshoots.";
const ticketCitation = { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10482", permalink: "https://example.atlassian.net/browse/THERM-482", text_sha256: sha256Digest(TICKET_TEXT) };
const ticketItem: EvidenceDeskItemV2 = Object.freeze({
  id: "ticket-482", citation: ticketCitation, kind: "ticket", label: "THERM-482: Thermal fixture fails at 45 °C", text: TICKET_TEXT, visibility: "only_me",
  attributes: { status: "In Progress", owner: "Dev Patel" }, occurred_at: "2026-11-20", receipt_sha256: canonicalSha256({ ticket: 482 }),
});
const decisionItem = record("dvt-gate", "Approved: the DVT gate stays on hold until THERM-482 is fixed; Lin Zhao approved the hold.") as EvidenceDeskItemV2;
const cited = (item: EvidenceDeskItemV2, kind: PersonAnswerCitationV8["kind"]): PersonAnswerCitationV8 => ({
  citation: item.citation as PersonAnswerCitationV8["citation"], kind, label: item.label, visibility: item.visibility,
  ...(item.citation.kind === "approved_record" ? { ref: `meeting:${item.citation.record_sha256}` as const } : {}),
});
/** The open thread: an older turn that names the ticket, and a latest turn that cites only the decision. */
const PREVIOUS: PersonAnswerPreviousV1 = {
  purpose: "follow_up", question: "who approved the hold?", asked_at: "2026-11-22T17:05:00.000Z",
  statements: [{ text: "Lin Zhao approved the hold at the DVT gate review.", citation_indexes: [0] }],
  citations: [cited(decisionItem, "decision")],
  earlier: [{
    question: "What's blocking the DVT gate?", asked_at: "2026-11-20T17:05:00.000Z",
    statements: [{ text: "THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.", citation_indexes: [0, 1] }],
    citations: [cited(ticketItem, "ticket"), cited(decisionItem, "decision")],
  }],
};
const THREADS: readonly PersonAnswerThreadV1[] = [
  { questions: ["What did Kestrel quote for the heater block tooling?", "when does that quote expire?"], asked_at: "2026-11-22T19:00:00.000Z" },
  { questions: ["When is the FCC pre-scan booked?"], asked_at: "2026-11-19T17:30:00.000Z" },
  { questions: ["How much is the Kestrel heater block tooling quote?"], asked_at: "2026-11-10T17:00:00.000Z" },
];
const QUESTION = "what are the details on that ticket?";
const RESOLVED = "What are the details on THERM-482?";
const ELSEWHERE = { thread: "other", threads: [2, 1] };

/** Replies by role: the resolver's (either prompt), research steps', and the writer's, each in order; an unscripted call fails the Ask. */
function scripted(script: { readonly resolver?: readonly unknown[]; readonly steps?: readonly unknown[]; readonly writer?: readonly unknown[] }) {
  const inputs: StructuredGenerationInput[] = [];
  const queue = { resolver: [...(script.resolver ?? [])], step: [...(script.steps ?? [])], writer: [...(script.writer ?? [])] };
  const roleOf = (input: StructuredGenerationInput) => input.system_prompt === THREAD_RESOLVER_PROMPT || input.system_prompt === FOLLOW_UP_RESOLVER_PROMPT ? "resolver" as const
    : input.system_prompt.startsWith(ANSWER_PROMPT) ? "writer" as const : "step" as const;
  return {
    inputs, of: (role: "resolver" | "step" | "writer") => inputs.filter(input => roleOf(input) === role),
    model: { generate: async (input: StructuredGenerationInput) => {
      inputs.push(recorded(input));
      const reply = queue[roleOf(input)].shift();
      if (reply === undefined) throw new Error(`unscripted ${roleOf(input)} call`);
      if (typeof reply === "function") return (reply as () => unknown)();
      return reply;
    } },
  };
}
const finishOn = (question: string, evidence: readonly string[]) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "found", evidence }] }], actions: [{ tool: "finish", args: {} }] });
const searchFor = (question: string, query: string) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "open", evidence: [] }] }], actions: [{ tool: "search", args: { query } }] });
/** Research that searches once and finishes on what it found, and a writer that states one sentence from it. */
const researched = (question: string) => ({
  steps: [searchFor(question, "THERM-482"), finishOn(question, ["E1"])],
  writer: [writerReply([{ text: "The DVT gate stays on hold until THERM-482 is fixed.", evidence: ["E1"] }])],
});
function desk(overrides: Partial<EvidenceDeskPortV2> = {}) {
  return {
    scope: { kind: "global" as const }, live_sources: [JIRA],
    search: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["search"]>[0]) => result([decisionItem])),
    list: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["list"]>[0]) => result([])),
    open: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["open"]>[0]) => result([])),
    openCitation: vi.fn(async (_input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => result([ticketItem])),
    revalidate: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["revalidate"]>[0]) => checked),
    ...overrides,
  } satisfies EvidenceDeskPortV2;
}
function askV8(port: EvidenceDeskPortV2, run: ReturnType<typeof scripted>) {
  const audits: AgenticAskAuditEntryV1[] = [];
  const ask = createAgenticAskV5({
    desk: port, model: run.model, generation, audit: { append: entry => { audits.push(entry); } }, today: () => "2026-11-23",
    time_context: { now: "2026-11-23T17:00:00.000Z", time_zone: "America/Los_Angeles" },
  });
  return { ask, audits };
}
/** A run under the request's observer: the corrections every span of it counted, summed. */
async function observed<T>(operation: () => Promise<T>): Promise<{ readonly value: T; readonly corrections: Readonly<Record<string, number>> }> {
  const events: CoreRuntimeObservationV1[] = [];
  const value = await observeCoreRuntimeV1("research_run", operation, { observer: event => { events.push(event); } });
  const corrections: Record<string, number> = {};
  for (const event of events) if (event.event !== "started") for (const [name, count] of Object.entries(event.model_corrections ?? {})) corrections[name] = (corrections[name] ?? 0) + count;
  return { value, corrections };
}
const reads = (port: ReturnType<typeof desk>) => [port.search, port.list, port.open, port.openCitation];

describe("the fixtures are a valid Ask with its threads (ADR-0056)", () => {
  it("is a request the API takes", () => {
    const request = { schema_version: 3, question: QUESTION, previous: PREVIOUS, threads: THREADS };
    expect(validatePersonAnswerRequestV3(request)).toEqual(request);
  });
});

describe("a question that belongs to other threads (ADR-0056)", () => {
  it("is not answered here: no research, no citation, the threads by index, released and audited as clarify", async () => {
    const run = scripted({ resolver: [ELSEWHERE] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const response = await ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS });
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: QUESTION, thread: { kind: "other", threads: [1, 0] } });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    for (const read of reads(port)) expect(read).not.toHaveBeenCalled();
    // One call, the thread resolver's, in the follow-up resolver's place.
    expect(run.inputs).toHaveLength(1);
    expect(run.inputs[0]!.system_prompt).toBe(THREAD_RESOLVER_PROMPT);
    expect(run.inputs[0]!.schema).toBe(threadPlacementSchema);
    // The check before the resolver's call, then the release's checks before and after the audit.
    expect(port.revalidate).toHaveBeenCalledTimes(3);
    // Nothing new in the audit's vocabulary: outcome clarify, one answer-role call.
    expect(audits).toEqual([expect.objectContaining({ outcome: "clarify", rounds: 0, model_calls: 1, repairs: 0, citation_count: 0, receipt_digests: [], generations: [expect.objectContaining({ role: "answer" })] })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
    expect(audits[0]!.response_sha256).toBe(canonicalSha256(response));
    // No thread text reaches the audit record.
    for (const thread of THREADS) for (const question of thread.questions) expect(JSON.stringify(audits)).not.toContain(question);
  });

  it("names the one thread it belongs to and the threads to merge with it, from a page with no thread open too", async () => {
    for (const previous of [PREVIOUS, undefined]) {
      const run = scripted({ resolver: [{ thread: "other", threads: [1], merge: [3, 1, 9] }] });
      const { ask, audits } = askV8(desk(), run);
      const { value: response, corrections } = await observed(() => ask.answer({ question: "when does the Kestrel quote expire?", threads: THREADS, ...(previous === undefined ? {} : { previous }) }));
      expect(response).toMatchObject({ outcome: "clarify", thread: { kind: "other", threads: [0] }, merge: [2] });
      expect(response).not.toHaveProperty("choices");
      // The merge entries that named the thread itself and no thread were dropped, never failed.
      expect(corrections).toEqual({ model_entry_dropped: 2 });
      expect(run.inputs).toHaveLength(1);
      expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
    }
  });

  it("streams as its access check alone, with an empty receipt", async () => {
    const events: PersonAskProgressStepEventV3[] = [];
    const { ask } = askV8(desk(), scripted({ resolver: [ELSEWHERE] }));
    const { response, receipt } = await ask.answerWithReceipt({ question: QUESTION, previous: PREVIOUS, threads: THREADS, on_progress: event => { events.push(event); } });
    expect(response).toMatchObject({ outcome: "clarify", thread: { kind: "other", threads: [1, 0] } });
    expect(events).toEqual([{ type: "stage", stage: "checking_access" }]);
    expect(receipt).toMatchObject({ looked_through: 0, rows: [] });
  });
});

describe("a new subject (ADR-0056)", () => {
  it("researches the question as asked, from nothing of the open thread, and the answer says it starts a new thread", async () => {
    for (const previous of [PREVIOUS, undefined]) {
      const run = scripted({ resolver: [{ thread: "new", merge: [1] }], ...researched(QUESTION) });
      const port = desk();
      const { ask, audits } = askV8(port, run);
      const response = await ask.answer({ question: QUESTION, threads: THREADS, ...(previous === undefined ? {} : { previous }) });
      expect(validatePersonAnswerResponseV8(response)).toEqual(response);
      expect(response).toMatchObject({ outcome: "answered", question: QUESTION, thread: { kind: "new" }, parts: [{ question: QUESTION }] });
      // A new subject merges nothing.
      expect(response).not.toHaveProperty("merge");
      // No starting item: nothing of the open thread is opened, and research and the writer see the question as asked.
      expect(port.openCitation).not.toHaveBeenCalled();
      const [firstStep] = run.of("step");
      expect(JSON.parse(firstStep!.user_prompt)).toMatchObject({ question: QUESTION, opened: [] });
      expect(JSON.parse(run.of("writer")[0]!.user_prompt)).toMatchObject({ question: QUESTION });
      // Neither research nor the writer is shown any thread.
      for (const input of [...run.of("step"), ...run.of("writer")]) for (const thread of THREADS) expect(`${input.system_prompt}\n${input.user_prompt}`).not.toContain(thread.questions[0]!);
      expect(audits).toEqual([expect.objectContaining({ outcome: "answered", model_calls: 4, generations: [
        expect.objectContaining({ role: "answer" }), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "answer" }),
      ] })]);
      // The answer's hash covers where it says the question belongs.
      expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
      const { thread: _thread, ...unplaced } = response;
      expect(agenticAskAnswerSha256V1(unplaced as PersonAnswerResponseV8)).not.toBe(audits[0]!.answer_sha256);
    }
  });

  it("is the fallback of a request with threads and no previous turn: open is refused for the repair, and the answer says new", async () => {
    const run = scripted({ resolver: [{ thread: "open", resolution: "same" }, { thread: "open", resolution: "same" }], ...researched(QUESTION) });
    const { ask } = askV8(desk(), run);
    const { value: response, corrections } = await observed(() => ask.answer({ question: QUESTION, threads: THREADS }));
    expect(response).toMatchObject({ outcome: "answered", question: QUESTION, thread: { kind: "new" } });
    expect(run.of("resolver")).toHaveLength(2);
    expect(JSON.parse(run.of("resolver")[1]!.user_prompt).validation_error).toContain("the person has no thread open");
    expect(corrections).toMatchObject({ model_repair_rejected: 1, resolver_fallback: 1 });
  });
});

describe("a question that continues the open thread (ADR-0056)", () => {
  it("resolves a reference to something only an older turn names, starts research from that turn's citation, and carries the merge", async () => {
    const run = scripted({
      resolver: [{ thread: "open", resolution: "resolved", question: RESOLVED, about: [1], merge: [3] }],
      steps: [finishOn(RESOLVED, ["E1"])],
      writer: [writerReply([{ text: "THERM-482 is in progress, owned by Dev Patel: the heater controller overshoots.", evidence: ["E1"] }])],
    });
    const openCitation = vi.fn(async (_input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => result([ticketItem]));
    const { ask, audits } = askV8(desk({ openCitation }), run);
    const response = await ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject({ outcome: "answered", question: RESOLVED, merge: [2], parts: [{ question: RESOLVED }] });
    expect(response).not.toHaveProperty("thread");
    // Source 1 of the thread's one list is the older turn's ticket: research opened it, and only it, before its first step.
    expect(JSON.parse(run.of("resolver")[0]!.user_prompt).open.sources.map((source: { readonly label: string }) => source.label)).toEqual([ticketItem.label, decisionItem.label]);
    expect(openCitation.mock.calls.map(([input]) => input.citation)).toEqual([ticketCitation]);
    expect(JSON.parse(run.of("step")[0]!.user_prompt)).toMatchObject({ question: RESOLVED, opened: [expect.objectContaining({ id: "E1" })] });
    expect(audits).toEqual([expect.objectContaining({ outcome: "answered", model_calls: 3, generations: [
      expect.objectContaining({ role: "answer" }), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "answer" }),
    ] })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
    const { merge: _merge, ...unmerged } = response;
    expect(agenticAskAnswerSha256V1(unmerged as PersonAnswerResponseV8)).not.toBe(audits[0]!.answer_sha256);
  });

  it("asks which one between things in the open thread, and names no merge beside the choices", async () => {
    const choices = [{ label: "THERM-482: thermal fixture", question: RESOLVED }, { label: "MECH-214: drop test", question: "What are the details on MECH-214?" }];
    const run = scripted({ resolver: [{ thread: "open", resolution: "clarify", choices, merge: [3] }] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const response = await ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS });
    // The question is asked again once a choice is made, and that answer names the threads to merge.
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: QUESTION, choices });
    for (const read of reads(port)) expect(read).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ outcome: "clarify", rounds: 0, model_calls: 1 })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
  });

  it("answers a question that stands alone as asked, and so does a resolver with no usable reply: the open thread, never another, never a merge", async () => {
    for (const resolver of [[{ thread: "open", resolution: "same" }], [{ thread: "other", threads: [9], merge: [1] }, { thread: "elsewhere", merge: [1] }]]) {
      const run = scripted({ resolver, ...researched(QUESTION) });
      const port = desk();
      const { ask } = askV8(port, run);
      const { value: response, corrections } = await observed(() => ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS }));
      expect(response).toMatchObject({ outcome: "answered", question: QUESTION });
      for (const key of ["thread", "merge", "choices"]) expect(response).not.toHaveProperty(key);
      expect(port.openCitation).not.toHaveBeenCalled();
      expect(corrections.resolver_fallback ?? 0).toBe(resolver.length === 2 ? 1 : 0);
      expect(run.of("resolver")).toHaveLength(resolver.length);
    }
  });

  it("answers in the open thread, saying nothing of threads, when the request carried older turns and no other thread", async () => {
    // Only an answer to a request that carried `threads` may say where the question belongs.
    for (const reply of [{ thread: "new" }, { thread: "open", resolution: "same", merge: [1] }]) {
      const run = scripted({ resolver: [reply], ...researched(QUESTION) });
      const { ask } = askV8(desk(), run);
      const response = await ask.answer({ question: QUESTION, previous: PREVIOUS });
      expect(run.of("resolver")[0]!.system_prompt).toBe(THREAD_RESOLVER_PROMPT);
      expect(response).toMatchObject({ outcome: "answered", question: QUESTION });
      for (const key of ["thread", "merge"]) expect(response).not.toHaveProperty(key);
    }
  });
});

describe("an Ask without threads or older turns is today's (ADR-0056)", () => {
  const { earlier: _earlier, ...SINGLE } = PREVIOUS;

  it("resolves a follow-up with the follow-up resolver's own prompt and schema, and answers with no thread or merge", async () => {
    const run = scripted({ resolver: [{ resolution: "same" }], ...researched(QUESTION) });
    const { ask, audits } = askV8(desk(), run);
    const response = await ask.answer({ question: QUESTION, previous: SINGLE });
    expect(run.of("resolver").map(input => input.system_prompt)).toEqual([FOLLOW_UP_RESOLVER_PROMPT]);
    expect(Object.keys(JSON.parse(run.of("resolver")[0]!.user_prompt))).toEqual(["today", "previous", "question"]);
    for (const key of ["thread", "merge"]) expect(response).not.toHaveProperty(key);
    // An answer that says nothing of threads hashes exactly as it did before threads existed.
    expect(audits[0]!.answer_sha256).toBe(canonicalSha256({ direct: response.direct ?? null, parts: response.parts, question: response.question }));
  });

  it("gives the same calls and the same response with threads absent or undefined", async () => {
    const replies = () => scripted({ steps: [searchFor("Who owns the THERM-482 fix?", "THERM-482"), finishOn("Who owns the THERM-482 fix?", ["E1"])],
      writer: [writerReply([{ text: "Dev Patel owns the THERM-482 fix.", evidence: ["E1"] }])] });
    const plain = replies();
    const absent = await askV8(desk(), plain).ask.answer({ question: "Who owns the THERM-482 fix?" });
    const undefinedRun = replies();
    const undefinedThreads = await askV8(desk(), undefinedRun).ask.answer({ question: "Who owns the THERM-482 fix?", previous: undefined, threads: undefined, follow_up: undefined });
    expect(JSON.stringify(undefinedThreads)).toBe(JSON.stringify(absent));
    expect(undefinedRun.inputs.map(({ signal: _signal, ...input }) => input)).toEqual(plain.inputs.map(({ signal: _signal, ...input }) => input));
    expect(plain.of("resolver")).toEqual([]);
    for (const key of ["question", "thread", "merge"]) expect(absent).not.toHaveProperty(key);
  });

  it("never places an Ask again, whatever it is handed: it asks one earlier question again where it was asked", async () => {
    const again: PersonAnswerPreviousV1 = { ...SINGLE, purpose: "ask_again" };
    const run = scripted({ ...researched(again.question) });
    const { ask } = askV8(desk(), run);
    // The API refuses threads beside an Ask again; the core, handed them anyway, makes no resolver call.
    const response = await ask.answer({ question: again.question, previous: again, threads: THREADS });
    expect(run.of("resolver")).toEqual([]);
    expect(response).toMatchObject({ outcome: "answered", question: again.question });
    for (const key of ["thread", "merge"]) expect(response).not.toHaveProperty(key);
  });
});

describe("every place ends in one released answer or one audited stop (ADR-0056)", () => {
  const cancel = () => new DOMException("Ask cancelled", "AbortError");
  /** An Ask whose resolver names other threads, with a desk whose access checks `check` answers by their order (from 1). */
  function elsewhere(check: (call: number, controller: AbortController) => Promise<typeof checked>, resolver: readonly unknown[] = [ELSEWHERE]) {
    const controller = new AbortController();
    let calls = 0;
    const port = desk({ revalidate: vi.fn(async () => check(calls += 1, controller)) });
    const run = scripted({ resolver });
    const { ask, audits } = askV8(port, run);
    const pending = ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS, signal: controller.signal });
    return { pending, audits, run, port, controller };
  }

  it("audits a cancel during the resolver's call once, as cancelled, and releases nothing", async () => {
    const stopped = elsewhere(async () => checked, [() => { stopped.controller.abort(cancel()); throw cancel(); }]);
    await expect(stopped.pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.audits).toEqual([expect.objectContaining({ outcome: "cancelled", model_calls: 1, answer_sha256: null, response_sha256: null })]);
    expect(stopped.run.inputs).toHaveLength(1);
    for (const read of reads(stopped.port)) expect(read).not.toHaveBeenCalled();
  });

  it("audits a cancel between the resolver's reply and the release's audit once, as cancelled", async () => {
    // The second access check is the release's, before its audit record.
    const stopped = elsewhere(async (call, controller) => { if (call === 2) controller.abort(cancel()); return checked; });
    await expect(stopped.pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.audits).toEqual([expect.objectContaining({ outcome: "cancelled", model_calls: 1, response_sha256: null })]);
  });

  it("releases nothing after a cancel that follows the audit record, and writes no second record", async () => {
    // The third access check is the release's, after its audit record: the answer is audited and still not handed over.
    const stopped = elsewhere(async (call, controller) => { if (call === 3) controller.abort(cancel()); return checked; });
    await expect(stopped.pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.audits).toEqual([expect.objectContaining({ outcome: "clarify", model_calls: 1 })]);
    expect(stopped.port.revalidate).toHaveBeenCalledTimes(3);
  });

  it.each([[1, 0], [2, 1]])("audits an access check that stalls (check %i) once, as timed_out, and releases nothing", async (stalled, modelCalls) => {
    vi.useFakeTimers();
    try {
      const stopped = elsewhere((call) => call === stalled ? new Promise(() => undefined) : Promise.resolve(checked));
      const rejected = expect(stopped.pending).rejects.toMatchObject({ name: "AgenticAskStalledErrorV1" });
      await vi.advanceTimersByTimeAsync(AGENTIC_READ_SILENCE_MS_V1);
      await rejected;
      expect(stopped.audits).toEqual([expect.objectContaining({ outcome: "timed_out", model_calls: modelCalls, prompt_sha256: null, answer_sha256: null, response_sha256: null })]);
      expect(stopped.run.inputs).toHaveLength(modelCalls);
    } finally { vi.useRealTimers(); }
  });

  it("fails, releasing and auditing nothing, when access is lost before the release, as every Ask does", async () => {
    const stopped = elsewhere(async (call) => { if (call === 2) throw new AuthorityOperationError("stale_access_state", "Membership changed"); return checked; });
    await expect(stopped.pending).rejects.toMatchObject({ code: "stale_access_state" });
    expect(stopped.audits).toEqual([]);
  });

  it("audits a cancel during research of a new subject once, and never releases the answer", async () => {
    const controller = new AbortController();
    const port = desk({ search: vi.fn(async () => { controller.abort(cancel()); throw cancel(); }) });
    const run = scripted({ resolver: [{ thread: "new" }], steps: [searchFor(QUESTION, "THERM-482")] });
    const { ask, audits } = askV8(port, run);
    await expect(ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(audits).toEqual([expect.objectContaining({ outcome: "cancelled", model_calls: 2 })]);
    expect(run.of("writer")).toEqual([]);
  });
});

describe("a resolution kept between the attempts of one request (ADR-0056)", () => {
  /** One attempt, as a snapshot restart runs them: what it was handed, and what it reported. */
  async function attempt(input: { readonly question?: string; readonly previous?: PersonAnswerPreviousV1; readonly threads?: readonly PersonAnswerThreadV1[] }, resolver: readonly unknown[], handed?: AgenticResolutionKeptV1) {
    const reported: AgenticResolutionKeptV1[] = [];
    // Research is scripted for the attempts whose placement answers; one that asks instead never reaches it.
    const run = scripted({ resolver, ...researched(input.question ?? QUESTION) });
    const { ask } = askV8(desk(), run);
    const response = await ask.answer({
      question: QUESTION, ...input, follow_up: { ...(handed === undefined ? {} : { resolved: handed }), on_resolved: kept => { reported.push(kept); } },
    });
    return { response, reported, resolverCalls: run.of("resolver").length };
  }
  const SENT = { previous: PREVIOUS, threads: THREADS };

  it("reports what it resolved with the key of the question, the checked previous turn and the threads it was made from", async () => {
    const first = await attempt(SENT, [ELSEWHERE]);
    expect(first.resolverCalls).toBe(1);
    expect(first.reported).toEqual([{ key: agenticResolutionKeyV1({ question: QUESTION, previous: PREVIOUS, threads: THREADS, today: "2026-11-23", time_zone: "America/Los_Angeles" }), value: { placement: { thread: "other", threads: [1, 0], merge: [] }, fallback: false } }]);
    // What is held between attempts for a question that belongs elsewhere is a digest and thread numbers: none of the
    // question's, the turn's or the threads' text.
    expect(first.reported[0]!.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    for (const text of [QUESTION, PREVIOUS.question, PREVIOUS.statements[0]!.text, ...THREADS.flatMap(thread => thread.questions)]) expect(JSON.stringify(first.reported)).not.toContain(text);
  });

  it("uses a kept resolution, and makes no second call, when the question, the checked turn and the threads are the same", async () => {
    const [kept] = (await attempt(SENT, [ELSEWHERE])).reported;
    // No resolver reply is scripted: a second call would fail the Ask.
    const second = await attempt({ previous: structuredClone(PREVIOUS), threads: structuredClone(THREADS) }, [], kept);
    expect(second.resolverCalls).toBe(0);
    expect(second.response).toMatchObject({ outcome: "clarify", thread: { kind: "other", threads: [1, 0] } });
    // It was not resolved again, so there is nothing new to keep.
    expect(second.reported).toEqual([]);
  });

  it("keeps a fallback as it keeps any resolution: the call and its repair are not paid for again, and it stays the open thread as asked", async () => {
    const first = await attempt(SENT, [{ thread: "elsewhere" }, { thread: "other", threads: [9] }]);
    expect(first.resolverCalls).toBe(2);
    expect(first.reported).toEqual([{ key: agenticResolutionKeyV1({ question: QUESTION, previous: PREVIOUS, threads: THREADS, today: "2026-11-23", time_zone: "America/Los_Angeles" }), value: { placement: { thread: "open", resolution: { resolution: "same" }, merge: [] }, fallback: true } }]);
    const second = await attempt(SENT, [], first.reported[0]);
    expect(second.resolverCalls).toBe(0);
    expect(second.response).toMatchObject({ outcome: "answered", question: QUESTION });
    for (const key of ["thread", "merge"]) expect(second.response).not.toHaveProperty(key);
  });

  it.each([
    ["a changed thread list", { previous: PREVIOUS, threads: THREADS.slice(1) }],
    ["the same threads in another order", { previous: PREVIOUS, threads: [THREADS[1]!, THREADS[0]!, THREADS[2]!] }],
    ["a thread with one more question", { previous: PREVIOUS, threads: [{ ...THREADS[0]!, questions: [...THREADS[0]!.questions, "and who signed it?"] }, THREADS[1]!, THREADS[2]!] }],
    ["no threads at all", { previous: PREVIOUS }],
    ["a checked turn that lost a sentence", { previous: { ...PREVIOUS, statements: [], citations: [] }, threads: THREADS }],
    ["an older turn that lost a sentence", { previous: { ...PREVIOUS, earlier: [{ ...PREVIOUS.earlier![0]!, statements: [], citations: [] }] }, threads: THREADS }],
    ["no previous turn", { threads: THREADS }],
    ["another question", { ...SENT, question: "and who owns it?" }],
  ])("resolves anew, and never uses the kept resolution, with %s", async (_name, changed) => {
    const [kept] = (await attempt(SENT, [ELSEWHERE])).reported;
    // The kept resolution names threads 2 and 1; the new one says something else, so which was used shows.
    const second = await attempt(changed, [{ thread: "open", resolution: "clarify", choices: [{ label: "A", question: "What is A?" }, { label: "B", question: "What is B?" }] }, { thread: "new" }], kept);
    expect(second.resolverCalls).toBeGreaterThanOrEqual(1);
    expect(second.response).not.toMatchObject({ thread: { kind: "other" } });
    expect(second.reported).toHaveLength(1);
    expect(second.reported[0]!.key).not.toBe(kept!.key);
  });
});
