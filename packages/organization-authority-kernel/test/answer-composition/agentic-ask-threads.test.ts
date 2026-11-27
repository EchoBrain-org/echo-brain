import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
  type PersonAnswerPreviousV1,
  type PersonAnswerResponseV8,
  type PersonAnswerThreadV1,
} from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { AGENTIC_READ_SILENCE_MS_V1, createAgenticAskV5, type AgenticAskAuditEntryV1, type AgenticResolutionKeptV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { agenticAskAnswerSha256V1 } from "../../src/answer-composition/agentic-ask-v1-response.js";
import { agenticResolutionKeyV1, FOLLOW_UP_RESOLVER_PROMPT, THREAD_RESOLVER_PROMPT, threadPlacementSchema } from "../../src/answer-composition/agentic-follow-up-resolver-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { checked, cited, finishOn, generation, observed, record, result, scripted, searchFor, writerReply } from "./fixtures/agentic-scenarios.js";

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
const { earlier: _earlier, ...SINGLE } = PREVIOUS;
const THREADS: readonly PersonAnswerThreadV1[] = [
  { questions: ["What did Kestrel quote for the heater block tooling?", "when does that quote expire?"], asked_at: "2026-11-22T19:00:00.000Z" },
  { questions: ["When is the FCC pre-scan booked?"], asked_at: "2026-11-19T17:30:00.000Z" },
  { questions: ["How much is the Kestrel heater block tooling quote?"], asked_at: "2026-11-10T17:00:00.000Z" },
];
const QUESTION = "what are the details on that ticket?";
const RESOLVED = "What are the details on THERM-482?";
const ELSEWHERE = { thread: "other", threads: [2, 1] };
const CHOICES = [{ label: "THERM-482", question: RESOLVED }, { label: "MECH-214", question: "What are the details on MECH-214?" }];

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
const reads = (port: ReturnType<typeof desk>) => [port.search, port.list, port.open, port.openCitation];
/** The Ask's input, carrying `previous` and `threads` only when given. */
const sent = (previous: PersonAnswerPreviousV1 | undefined, threads: readonly PersonAnswerThreadV1[] | undefined, question = QUESTION) =>
  ({ question, ...(previous === undefined ? {} : { previous }), ...(threads === undefined ? {} : { threads }) });

describe("where the question belongs decides its one path (ADR-0056)", () => {
  it.each([
    ["several other threads, from its thread", ELSEWHERE, PREVIOUS, { thread: { kind: "other", threads: [1, 0] } }, {}],
    // Merge entries that named the thread itself and no thread were dropped, never failed.
    ["one other thread and the thread on its subject, from its thread", { thread: "other", threads: [1], merge: [3, 1, 9] }, PREVIOUS, { thread: { kind: "other", threads: [0] }, merge: [2] }, { model_entry_dropped: 2 }],
    ["one other thread and the thread on its subject, from a page", { thread: "other", threads: [1], merge: [3, 1, 9] }, undefined, { thread: { kind: "other", threads: [0] }, merge: [2] }, { model_entry_dropped: 2 }],
  ] as const)("does not answer a question that belongs to %s: no research, no citation, the threads by index, released and audited as clarify", async (_name, reply, previous, placed, counted) => {
    expect(validatePersonAnswerRequestV3({ schema_version: 3, ...sent(previous, THREADS) })).toEqual({ schema_version: 3, ...sent(previous, THREADS) });
    const run = scripted({ resolver: [reply] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const { value: response, corrections } = await observed(() => ask.answer(sent(previous, THREADS)));
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: QUESTION, ...placed });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(corrections).toEqual(counted);
    for (const read of reads(port)) expect(read).not.toHaveBeenCalled();
    // One call, the thread resolver's, in the follow-up resolver's place.
    expect(run.inputs.map(input => [input.system_prompt, input.schema])).toEqual([[THREAD_RESOLVER_PROMPT, threadPlacementSchema]]);
    // The check before the resolver's call, then the release's checks before and after the audit.
    expect(port.revalidate).toHaveBeenCalledTimes(3);
    // Nothing new in the audit's vocabulary: outcome clarify, one answer-role call; its hashes cover the placement, and
    // no thread text reaches it.
    expect(audits).toEqual([expect.objectContaining({ outcome: "clarify", rounds: 0, model_calls: 1, repairs: 0, citation_count: 0, receipt_digests: [], generations: [expect.objectContaining({ role: "answer" })] })]);
    expect([audits[0]!.answer_sha256, audits[0]!.response_sha256]).toEqual([agenticAskAnswerSha256V1(response), canonicalSha256(response)]);
    for (const thread of THREADS) for (const question of thread.questions) expect(JSON.stringify(audits)).not.toContain(question);
  });

  it.each([
    ["it says so, from a thread", [{ thread: "new", merge: [1] }], PREVIOUS, THREADS],
    ["it says so, from a page", [{ thread: "new", merge: [1] }], undefined, THREADS],
    // With threads and no previous turn there is no open thread to fall back to: `open` goes back for the repair, then new.
    ["the resolver falls back with no thread open", [{ thread: "open", resolution: "same" }, { thread: "open", resolution: "same" }], undefined, THREADS],
    // The list, even empty, is what asks for a question to be placed: the person starts a second thread from their only one.
    ["it says so, from a person's only thread", [{ thread: "new" }], PREVIOUS, []],
    ["it says so, from a person's only thread of one turn", [{ thread: "new" }], SINGLE, []],
    // With no thread open either, a new thread is the only place there is: no model is asked where it belongs.
    ["there is nowhere else, with no thread open and an empty list", [], undefined, []],
  ] as const)("researches a new subject as asked, from nothing of the open thread, when %s: the answer starts a new thread and merges nothing", async (_name, resolver, previous, threads) => {
    const run = scripted({ resolver, ...researched(QUESTION) });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const { value: response, corrections } = await observed(() => ask.answer(sent(previous, threads)));
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject({ outcome: "answered", question: QUESTION, thread: { kind: "new" }, parts: [{ question: QUESTION }] });
    expect(response).not.toHaveProperty("merge");
    expect(run.of("resolver").map(input => input.system_prompt)).toEqual(resolver.map(() => THREAD_RESOLVER_PROMPT));
    if (resolver.length > 0) expect(JSON.parse(run.of("resolver")[0]!.user_prompt).threads).toHaveLength(threads.length);
    if (resolver.length === 2) {
      expect(JSON.parse(run.of("resolver")[1]!.user_prompt).validation_error).toContain("the person has no thread open");
      expect(corrections).toMatchObject({ model_repair_rejected: 1, resolver_fallback: 1 });
    }
    // No starting item: nothing of the open thread is opened, and research and the writer see the question as asked,
    // and never a thread.
    expect(port.openCitation).not.toHaveBeenCalled();
    expect(JSON.parse(run.of("step")[0]!.user_prompt)).toMatchObject({ question: QUESTION, opened: [] });
    expect(JSON.parse(run.of("writer")[0]!.user_prompt)).toMatchObject({ question: QUESTION });
    for (const input of [...run.of("step"), ...run.of("writer")]) for (const thread of THREADS) expect(`${input.system_prompt}\n${input.user_prompt}`).not.toContain(thread.questions[0]!);
    expect(audits).toEqual([expect.objectContaining({ outcome: "answered", model_calls: resolver.length + 3, generations: [
      ...resolver.map(() => expect.objectContaining({ role: "answer" })), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "answer" }),
    ] })]);
    // The answer's hash covers where it says the question belongs.
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
    const { thread: _thread, ...unplaced } = response;
    expect(agenticAskAnswerSha256V1(unplaced as PersonAnswerResponseV8)).not.toBe(audits[0]!.answer_sha256);
  });

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
    const run = scripted({ resolver: [{ thread: "open", resolution: "clarify", choices: CHOICES, merge: [3] }] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const response = await ask.answer({ question: QUESTION, previous: PREVIOUS, threads: THREADS });
    // The question is asked again once a choice is made, and that answer names the threads to merge.
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: QUESTION, choices: CHOICES });
    for (const read of reads(port)) expect(read).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ outcome: "clarify", rounds: 0, model_calls: 1 })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
  });

  it.each([
    ["it stands alone", [{ thread: "open", resolution: "same" }], THREADS, 0],
    ["no repair makes the reply usable", [{ thread: "other", threads: [9], merge: [1] }, { thread: "elsewhere", merge: [1] }], THREADS, 1],
    // Another thread and a clarify with choices at once: read as the thread, a client could jump there with no click.
    ["the reply and its repair each say two things", [{ thread: "other", threads: [1], resolution: "clarify", choices: CHOICES }, { thread: "other", threads: [1], resolution: "clarify", choices: CHOICES }], THREADS, 1],
    // Only an answer to a request that carried `threads` may say where the question belongs.
    ["the request carried older turns and no list, and the reply says new", [{ thread: "new" }], undefined, 0],
    ["the request carried older turns and no list, and the reply names a merge", [{ thread: "open", resolution: "same", merge: [1] }], undefined, 0],
  ] as const)("answers in the open thread as asked when %s: never another thread, never a merge", async (_name, resolver, threads, fallbacks) => {
    const run = scripted({ resolver, ...researched(QUESTION) });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const { value: response, corrections } = await observed(() => ask.answer(sent(PREVIOUS, threads)));
    expect(response).toMatchObject({ outcome: "answered", question: QUESTION });
    for (const key of ["thread", "merge", "choices"]) expect(response).not.toHaveProperty(key);
    expect(port.openCitation).not.toHaveBeenCalled();
    expect(run.of("resolver").map(input => input.system_prompt)).toEqual(resolver.map(() => THREAD_RESOLVER_PROMPT));
    expect(corrections.resolver_fallback ?? 0).toBe(fallbacks);
    expect(audits).toEqual([expect.objectContaining({ outcome: "answered", repairs: resolver.length - 1 })]);
    if (resolver.length === 2) expect(JSON.parse(run.of("resolver")[1]!.user_prompt).validation_error).toBeTruthy();
    if (resolver[0]!.thread === "other" && "choices" in resolver[0]!) {
      expect(JSON.parse(run.of("resolver")[1]!.user_prompt).validation_error).toContain("only an \"open\" reply has a resolution, a question, sources or choices");
    }
  });
});

describe("the open thread's label on the answer (ADR-0057)", () => {
  // Every word is one the person typed in the open thread or the new question.
  const LABEL = "DVT gate: blocking, approved, details";

  it.each([
    ["resolved", { thread: "open", resolution: "resolved", question: RESOLVED, about: [1], label: LABEL }, RESOLVED],
    ["same", { thread: "open", resolution: "same", label: LABEL }, QUESTION],
  ] as const)("carries the label of a %s answer in the open thread only to an Ask that reads labels, and its hash covers it", async (_name, reply, answers) => {
    const asked = async (labels: boolean) => {
      const run = scripted({ resolver: [reply], ...researched(answers) });
      const { ask, audits } = askV8(desk(), run);
      const response = await ask.answer({ ...sent({ ...PREVIOUS, label: "DVT gate: blocking" }, THREADS), ...(labels ? { labels: true as const } : {}) });
      return { response, audits, run };
    };
    const reading = await asked(true);
    expect(validatePersonAnswerResponseV8(reading.response)).toEqual(reading.response);
    expect(reading.response).toMatchObject({ outcome: "answered", question: answers, label: LABEL });
    // The current label reached the resolver, and no label reaches research or the writer.
    expect(JSON.parse(reading.run.of("resolver")[0]!.user_prompt).open.label).toBe("DVT gate: blocking");
    for (const input of [...reading.run.of("step"), ...reading.run.of("writer")]) expect(`${input.system_prompt}\n${input.user_prompt}`).not.toContain("DVT gate: blocking");
    expect(reading.audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(reading.response));
    const { label: _label, ...unlabelled } = reading.response;
    expect(agenticAskAnswerSha256V1(unlabelled as PersonAnswerResponseV8)).not.toBe(reading.audits[0]!.answer_sha256);
    // An older client never meets the key: the same reply, to an Ask that did not ask for labels, carries none.
    const older = await asked(false);
    expect(older.response).not.toHaveProperty("label");
    expect(older.response).toEqual(unlabelled);
  });

  it.each([
    ["a label in words the person did not type", [{ thread: "open", resolution: "same", label: "THERM-482: details" }], PREVIOUS, THREADS, { outcome: "answered" }, 1],
    ["a label beside a clarify", [{ thread: "open", resolution: "clarify", choices: CHOICES, label: LABEL }], PREVIOUS, THREADS, { outcome: "clarify", choices: CHOICES }, 1],
    ["a label beside other threads", [{ ...ELSEWHERE, label: LABEL }], PREVIOUS, THREADS, { outcome: "clarify", thread: { kind: "other", threads: [1, 0] } }, 1],
    ["a label beside a new subject", [{ thread: "new", label: LABEL }], PREVIOUS, THREADS, { outcome: "answered", thread: { kind: "new" } }, 1],
    // The follow-up resolver's path is today's, byte for byte: it makes no label.
    ["a label on the follow-up resolver's path", [{ resolution: "same", label: LABEL }], SINGLE, undefined, { outcome: "answered" }, 0],
  ] as const)("answers with no label after %s, to an Ask that reads labels", async (_name, resolver, previous, threads, shape, dropped) => {
    const run = scripted({ resolver, ...researched(QUESTION) });
    const { ask } = askV8(desk(), run);
    const { value: response, corrections } = await observed(() => ask.answer({ ...sent(previous, threads), labels: true }));
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject(shape);
    expect(response).not.toHaveProperty("label");
    expect(corrections.resolver_label_dropped ?? 0).toBe(dropped);
  });
});

describe("an Ask without threads or older turns is today's (ADR-0056)", () => {
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

  it("can confirm a single implicit subject before any research starts", async () => {
    const choices = [CHOICES[0]!];
    const run = scripted({ resolver: [{ thread: "open", resolution: "clarify", choices }] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const response = await ask.answer({ question: "Did it ship?", previous: { ...SINGLE, candidate: true } });
    expect(JSON.parse(run.of("resolver")[0]!.user_prompt).open.candidate).toBe(true);
    expect(response).toMatchObject({ outcome: "clarify", choices });
    for (const read of reads(port)) expect(read).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ rounds: 0, model_calls: 1 });
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

  it.each([
    // The resolver's own call cancelled: audited once, nothing read.
    ["a cancel during the resolver's call", () => {
      const stopped = elsewhere(async () => checked, [() => { stopped.controller.abort(cancel()); throw cancel(); }]);
      return stopped;
    }, { name: "AbortError" }, [{ outcome: "cancelled", model_calls: 1, answer_sha256: null, response_sha256: null }]],
    // The second access check is the release's, before its audit record.
    ["a cancel between the resolver's reply and the release's audit", () => elsewhere(async (call, controller) => { if (call === 2) controller.abort(cancel()); return checked; }),
      { name: "AbortError" }, [{ outcome: "cancelled", model_calls: 1, response_sha256: null }]],
    // The third is the release's, after its audit record: the answer is audited and still not handed over.
    ["a cancel after the audit record, with no second record", () => elsewhere(async (call, controller) => { if (call === 3) controller.abort(cancel()); return checked; }),
      { name: "AbortError" }, [{ outcome: "clarify", model_calls: 1 }]],
    // Access lost before the release fails it, releasing and auditing nothing, as every Ask does.
    ["access lost before the release", () => elsewhere(async (call) => { if (call === 2) throw new AuthorityOperationError("stale_access_state", "Membership changed"); return checked; }),
      { code: "stale_access_state" }, []],
  ] as const)("releases nothing after %s", async (_name, start, rejection, stops) => {
    const stopped = start();
    await expect(stopped.pending).rejects.toMatchObject(rejection);
    expect(stopped.audits).toEqual(stops.map(stop => expect.objectContaining(stop)));
    expect(stopped.run.inputs).toHaveLength(1);
    if (stops[0]?.outcome === "clarify") expect(stopped.port.revalidate).toHaveBeenCalledTimes(3);
    for (const read of reads(stopped.port)) expect(read).not.toHaveBeenCalled();
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
  const KEY = agenticResolutionKeyV1({ question: QUESTION, previous: PREVIOUS, threads: THREADS, today: "2026-11-23", time_zone: "America/Los_Angeles" });

  it.each([
    ["a placement elsewhere", [ELSEWHERE], { placement: { thread: "other", threads: [1, 0], merge: [] }, fallback: false }, { outcome: "clarify", thread: { kind: "other", threads: [1, 0] } }],
    // A fallback is kept as any resolution is: the call and its repair are not paid for again, and it stays the open thread as asked.
    ["a fallback", [{ thread: "elsewhere" }, { thread: "other", threads: [9] }], { placement: { thread: "open", resolution: { resolution: "same" }, merge: [] }, fallback: true }, { outcome: "answered", question: QUESTION }],
  ] as const)("reports %s keyed by what it was made from, holding no text, and the next attempt with the same input uses it with no call", async (_name, resolver, value, response) => {
    const first = await attempt(SENT, resolver);
    expect(first.resolverCalls).toBe(resolver.length);
    expect(first.reported).toEqual([{ key: KEY, value }]);
    // What is held between attempts is a digest and thread numbers: none of the question's, the turn's or the threads' text.
    expect(first.reported[0]!.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    for (const text of [QUESTION, PREVIOUS.question, PREVIOUS.statements[0]!.text, ...THREADS.flatMap(thread => thread.questions)]) expect(JSON.stringify(first.reported)).not.toContain(text);
    // No resolver reply is scripted: a second call would fail the Ask. It was not resolved again, so nothing new is kept.
    const second = await attempt({ previous: structuredClone(PREVIOUS), threads: structuredClone(THREADS) }, [], first.reported[0]);
    expect([second.resolverCalls, second.reported]).toEqual([0, []]);
    expect(second.response).toMatchObject(response);
    if (response.outcome === "answered") for (const key of ["thread", "merge"]) expect(second.response).not.toHaveProperty(key);
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
