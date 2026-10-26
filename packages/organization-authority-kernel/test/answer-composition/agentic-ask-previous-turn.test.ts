import { canonicalJsonBytes, canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_RESPONSE_MAX_BYTES_V4,
  validatePersonAnswerResponseV8,
  type PersonAnswerCitationV8,
  type PersonAnswerPreviousV1,
  type PersonAnswerResponseV8,
  type PersonAskProgressStepEventV3,
} from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { createAgenticAskV5, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_SINCE_PROMPT, answerLayoutSinceSchema, answerSchema, answerSinceSchema } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticAskAnswerSha256V1, compactAndValidateAgenticAskResponseV1 } from "../../src/answer-composition/agentic-ask-v1-response.js";
import { FOLLOW_UP_RESOLVER_PROMPT, followUpResolutionSchema } from "../../src/answer-composition/agentic-follow-up-resolver-v1.js";
import { AgenticAskDeadlineErrorV1 } from "../../src/answer-composition/agentic-model-gate-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { checked, generation, record, result } from "./fixtures/agentic-scenarios.js";

/**
 * The previous turn on a V8 Ask (ADR-0047): a follow-up resolved before research and answered from where it points, or
 * asking which one; an Ask again whose writer says what is different since; and every other Ask exactly as before.
 */

const JIRA = { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" } as const;
const TICKET_TEXT = "THERM-482: Thermal fixture fails at 45 °C. Status: In Progress. Assignee: Dev Patel. Root cause: the heater controller overshoots.";
const ticketCitation = { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10482", permalink: "https://example.atlassian.net/browse/THERM-482", text_sha256: sha256Digest(TICKET_TEXT) };
const ticketItem: EvidenceDeskItemV2 = Object.freeze({
  id: "ticket-482", citation: ticketCitation, kind: "ticket", label: "THERM-482: Thermal fixture fails at 45 °C", text: TICKET_TEXT, visibility: "only_me",
  attributes: { status: "In Progress", owner: "Dev Patel" }, occurred_at: "2026-10-20", receipt_sha256: canonicalSha256({ ticket: 482 }),
});
const decisionItem = record("dvt-gate", "Approved: the DVT gate stays on hold until THERM-482 is fixed; Dev Patel owns the fix, due Oct 30.") as EvidenceDeskItemV2;
const cited = (item: EvidenceDeskItemV2, kind: PersonAnswerCitationV8["kind"]): PersonAnswerCitationV8 => ({
  citation: item.citation as PersonAnswerCitationV8["citation"], kind, label: item.label, visibility: item.visibility,
  ...(item.citation.kind === "approved_record" ? { ref: `meeting:${item.citation.record_sha256}` as const } : {}),
});
const FOLLOW_UP: PersonAnswerPreviousV1 = {
  purpose: "follow_up", question: "What's blocking the DVT gate?", asked_at: "2026-10-24T17:05:00.000Z",
  statements: [{ text: "THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.", citation_indexes: [0, 1] }],
  citations: [cited(ticketItem, "ticket"), cited(decisionItem, "decision")],
};
const ASK_AGAIN: PersonAnswerPreviousV1 = {
  ...FOLLOW_UP, purpose: "ask_again", question: "Who owns the THERM-482 fix?", asked_at: "2026-10-14T16:00:00.000Z",
  statements: [{ text: "Priya Nair owns the THERM-482 fix, due Oct 25.", citation_indexes: [1] }],
};
const QUESTION = "what are the details on that ticket?";
const RESOLVED = "What are the details on THERM-482?";

/** Replies by role: the resolver's, research steps', and the writer's, each in order; an unscripted call fails the Ask. */
function scripted(script: { readonly resolver?: readonly unknown[]; readonly steps?: readonly unknown[]; readonly writer?: readonly unknown[] }) {
  const inputs: StructuredGenerationInput[] = [];
  const queue = { resolver: [...(script.resolver ?? [])], step: [...(script.steps ?? [])], writer: [...(script.writer ?? [])] };
  const roleOf = (input: StructuredGenerationInput) => input.system_prompt === FOLLOW_UP_RESOLVER_PROMPT ? "resolver" as const
    : input.system_prompt.startsWith("You write Echo's final answer") ? "writer" as const : "step" as const;
  return {
    inputs, of: (role: "resolver" | "step" | "writer") => inputs.filter(input => roleOf(input) === role),
    model: { generate: async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const reply = queue[roleOf(input)].shift();
      if (reply === undefined) throw new Error(`unscripted ${roleOf(input)} call`);
      return reply;
    } },
  };
}
const finishOn = (question: string, evidence: readonly string[]) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "found", evidence }] }], actions: [{ tool: "finish", args: {} }] });
const searchFor = (question: string, query: string) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "open", evidence: [] }] }], actions: [{ tool: "search", args: { query } }] });
function desk(overrides: Partial<EvidenceDeskPortV2> = {}) {
  return {
    scope: { kind: "global" as const }, live_sources: [JIRA],
    search: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["search"]>[0]) => result([decisionItem])),
    list: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["list"]>[0]) => result([])),
    open: vi.fn(async (_input: Parameters<EvidenceDeskPortV2["open"]>[0]) => result([])),
    openCitation: vi.fn(async (_input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => result([ticketItem])),
    revalidate: vi.fn(async () => checked),
    ...overrides,
  } satisfies EvidenceDeskPortV2;
}
function askV8(port: EvidenceDeskPortV2, run: ReturnType<typeof scripted>, options: { readonly answer_layout?: boolean } = {}) {
  const audits: AgenticAskAuditEntryV1[] = [];
  const ask = createAgenticAskV5({
    desk: port, model: run.model, generation, audit: { append: entry => { audits.push(entry); } }, today: () => "2026-10-25",
    time_context: { now: "2026-10-25T17:00:00.000Z", time_zone: "America/Los_Angeles" }, ...options,
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

describe("a follow-up on the V8 Ask (ADR-0047)", () => {
  it("resolves what it refers to first, researches the full question from the source it points to, and names it", async () => {
    const run = scripted({
      resolver: [{ resolution: "resolved", question: RESOLVED, about: [1] }],
      steps: [finishOn(RESOLVED, ["E1"])],
      writer: [{ lists: [], sentences: [{ text: "THERM-482 is in progress, owned by Dev Patel: the heater controller overshoots.", evidence: ["E1"] }], not_found: [] }],
    });
    const openCitation = vi.fn(async (_input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => result([ticketItem]));
    const { ask, audits } = askV8(desk({ openCitation }), run);
    const response = await ask.answer({ question: QUESTION, previous: FOLLOW_UP });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject({ outcome: "answered", question: RESOLVED, parts: [{ question: RESOLVED, statements: [{ text: expect.stringContaining("Dev Patel") }] }] });
    expect(response).not.toHaveProperty("since");
    // The resolver ran first, before any read; research then started from the ticket alone, and was shown the full question.
    expect(run.inputs[0]!.system_prompt).toBe(FOLLOW_UP_RESOLVER_PROMPT);
    expect(run.inputs[0]!.schema).toBe(followUpResolutionSchema);
    expect(openCitation.mock.calls.map(([input]) => input.citation)).toEqual([ticketCitation]);
    const [firstStep] = run.of("step");
    expect(JSON.parse(firstStep!.user_prompt)).toMatchObject({ question: RESOLVED, opened: [expect.objectContaining({ id: "E1" })] });
    expect(JSON.parse(run.of("writer")[0]!.user_prompt)).toMatchObject({ question: RESOLVED });
    // The writer is today's: no earlier answer, no since.
    expect(run.of("writer")[0]!.schema).toBe(answerSchema);
    expect(JSON.parse(run.of("writer")[0]!.user_prompt)).not.toHaveProperty("earlier");
    // The audit records the resolver as one more answer-role generation of the request.
    expect(audits).toEqual([expect.objectContaining({ outcome: "answered", model_calls: 3, generations: [
      expect.objectContaining({ role: "answer" }), expect.objectContaining({ role: "step" }), expect.objectContaining({ role: "answer" }),
    ] })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
  });

  it("asks which one when more than one thing fits: no research, no citation, released and audited as clarify", async () => {
    const choices = [{ label: "THERM-482: thermal fixture", question: RESOLVED }, { label: "MECH-214: drop test", question: "What are the details on MECH-214?" }];
    const run = scripted({ resolver: [{ resolution: "clarify", choices }] });
    const port = desk();
    const { ask, audits } = askV8(port, run);
    const response = await ask.answer({ question: QUESTION, previous: FOLLOW_UP });
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: QUESTION, choices });
    for (const read of [port.search, port.list, port.open, port.openCitation]) expect(read).not.toHaveBeenCalled();
    expect(run.inputs).toHaveLength(1);
    // The check before the resolver's call, then the release's checks before and after the audit.
    expect(port.revalidate).toHaveBeenCalledTimes(3);
    expect(audits).toEqual([expect.objectContaining({ outcome: "clarify", rounds: 0, model_calls: 1, repairs: 0, citation_count: 0, receipt_digests: [], generations: [expect.objectContaining({ role: "answer" })] })]);
    expect(audits[0]!.answer_sha256).toBe(agenticAskAnswerSha256V1(response));
    expect(audits[0]!.response_sha256).toBe(canonicalSha256(response));
  });

  it("streams a clarify as its access check alone, with an empty receipt", async () => {
    const choices = [{ label: "THERM-482", question: RESOLVED }, { label: "MECH-214", question: "What are the details on MECH-214?" }];
    const events: PersonAskProgressStepEventV3[] = [];
    const { ask } = askV8(desk(), scripted({ resolver: [{ resolution: "clarify", choices }] }));
    const { response, receipt } = await ask.answerWithReceipt({ question: QUESTION, previous: FOLLOW_UP, on_progress: event => { events.push(event); } });
    expect(response).toMatchObject({ outcome: "clarify", choices });
    expect(events).toEqual([{ type: "stage", stage: "checking_access" }]);
    expect(receipt).toMatchObject({ looked_through: 0, rows: [] });
  });

  it("answers a question that stands alone as asked, naming it, and so does a resolver with no usable reply", async () => {
    for (const resolver of [[{ resolution: "same" }], [{ resolution: "guess" }, "still not an object"]]) {
      const run = scripted({
        resolver, steps: [searchFor(QUESTION, "THERM-482"), finishOn(QUESTION, ["E1"])],
        writer: [{ lists: [], sentences: [{ text: "The DVT gate stays on hold until THERM-482 is fixed.", evidence: ["E1"] }], not_found: [] }],
      });
      const port = desk();
      const { ask } = askV8(port, run);
      const { value: response, corrections } = await observed(() => ask.answer({ question: QUESTION, previous: FOLLOW_UP }));
      expect(response).toMatchObject({ outcome: "answered", question: QUESTION });
      expect(port.openCitation).not.toHaveBeenCalled();
      expect(JSON.parse(run.of("step")[0]!.user_prompt)).toMatchObject({ question: QUESTION });
      expect(corrections.resolver_fallback ?? 0).toBe(resolver.length === 2 ? 1 : 0);
    }
  });

  it("goes on when the source it points to can no longer be read, and never seeds what research cannot open", async () => {
    const run = scripted({
      resolver: [{ resolution: "resolved", question: RESOLVED, about: [1, 2] }],
      steps: [searchFor(RESOLVED, "THERM-482"), finishOn(RESOLVED, ["E1"])],
      writer: [{ lists: [], sentences: [{ text: "The DVT gate stays on hold until THERM-482 is fixed.", evidence: ["E1"] }], not_found: [] }],
    });
    const openCitation = vi.fn(async (input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => {
      if ((input.citation as { kind: string }).kind === "ticket") throw Object.assign(new Error("gone"), { name: "AuthorityOperationError", code: "not_found" });
      return result([decisionItem]);
    });
    const followUp: PersonAnswerCitationV8 = { citation: { kind: "follow_up", item_id: "itm_launch-1" }, kind: "follow_up", label: "Fix THERM-482", visibility: "team", ref: "follow_up:itm_launch-1" };
    const { ask } = askV8(desk({ openCitation }), run);
    const response = await ask.answer({ question: QUESTION, previous: { ...FOLLOW_UP, citations: [FOLLOW_UP.citations[0]!, followUp] } });
    expect(response).toMatchObject({ outcome: "answered", question: RESOLVED });
    // The follow-up item is not a kind research opens before its first step; the ticket was tried and reported.
    expect(openCitation.mock.calls.map(([input]) => (input.citation as { kind: string }).kind)).toEqual(["ticket"]);
  });

  it("goes on without a source its tool cannot read for now, and tells neither the planner nor the writer", async () => {
    const replies = () => scripted({
      resolver: [{ resolution: "resolved", question: RESOLVED, about: [1] }],
      steps: [searchFor(RESOLVED, "THERM-482"), finishOn(RESOLVED, ["E1"])],
      writer: [{ lists: [], sentences: [{ text: "The DVT gate stays on hold until THERM-482 is fixed.", evidence: ["E1"] }], not_found: [] }],
    });
    const promptsOf = (run: ReturnType<typeof scripted>) => run.inputs.map(({ signal: _signal, ...input }) => input);
    // The same follow-up with nothing to start from: a desk that cannot open an earlier citation is given no starting item.
    const unseeded = replies();
    const { openCitation: _none, ...cannotOpen } = desk();
    const expected = await askV8(cannotOpen, unseeded).ask.answer({ question: QUESTION, previous: FOLLOW_UP });
    expect(expected).toMatchObject({ outcome: "answered", question: RESOLVED });
    for (const code of ["unavailable", "rate_limited", "quota_exceeded"] as const) {
      const run = replies();
      const openCitation = vi.fn(async (_input: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]): Promise<ReturnType<typeof result>> => {
        throw new AuthorityOperationError(code, "Live evidence operation could not be completed");
      });
      const { ask, audits } = askV8(desk({ openCitation }), run);
      const response = await ask.answer({ question: QUESTION, previous: FOLLOW_UP });
      expect(openCitation.mock.calls.map(([input]) => input.citation), code).toEqual([ticketCitation]);
      // The answer, and every prompt the planner and the writer were given, are those of an Ask with no starting item.
      expect(response, code).toEqual(expected);
      expect(promptsOf(run), code).toEqual(promptsOf(unseeded));
      expect(audits, code).toEqual([expect.objectContaining({ outcome: "answered" })]);
    }
  });

  it("still fails on a starting read that fails any other way: a stale access state, a conflict, an error of no known kind, a cancel or the deadline", async () => {
    const resolved = () => scripted({ resolver: [{ resolution: "resolved", question: RESOLVED, about: [1] }] });
    for (const error of [
      new AuthorityOperationError("stale_access_state", "Access changed"), new AuthorityOperationError("conflict", "Changed while read"),
      new AuthorityOperationError("invalid_request", "Evidence citation is invalid"), new Error("the desk broke"),
    ]) {
      const run = resolved();
      const { ask } = askV8(desk({ openCitation: vi.fn(async () => { throw error; }) }), run);
      await expect(ask.answer({ question: QUESTION, previous: FOLLOW_UP }), error.message).rejects.toBe(error);
      expect(run.of("step"), error.message).toEqual([]);
    }
    // A cancel or the deadline that ends the read stays what it is, whatever the tool said as it stopped.
    for (const reason of [new DOMException("Ask cancelled", "AbortError"), new AgenticAskDeadlineErrorV1()]) {
      const controller = new AbortController();
      const run = resolved();
      const { ask, audits } = askV8(desk({ openCitation: vi.fn(async () => {
        controller.abort(reason);
        throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed");
      }) }), run);
      await expect(ask.answer({ question: QUESTION, previous: FOLLOW_UP, signal: controller.signal }), reason.name).rejects.toMatchObject({ name: reason.name });
      expect(run.of("step"), reason.name).toEqual([]);
      expect(audits, reason.name).toEqual([expect.objectContaining({ outcome: reason instanceof AgenticAskDeadlineErrorV1 ? "timed_out" : "cancelled" })]);
    }
  });
});

describe("Ask again on the V8 Ask (ADR-0047)", () => {
  const again = (writer: unknown, options: { readonly answer_layout?: boolean; readonly steps?: readonly unknown[] } = {}) => {
    const run = scripted({ steps: options.steps ?? [searchFor(ASK_AGAIN.question, "THERM-482 owner"), finishOn(ASK_AGAIN.question, ["E1"])], writer: [writer] });
    return { run, ...askV8(desk(), run, options.answer_layout === undefined ? {} : { answer_layout: options.answer_layout }) };
  };

  it("researches the question as asked, shows the writer the earlier answer, and releases what is different since, each cited", async () => {
    const { run, ask } = again({ lists: [], sentences: [{ text: "Dev Patel owns the THERM-482 fix, due Oct 30.", evidence: ["E1"] }], since: [
      { text: "The fix moved from Priya Nair to Dev Patel.", evidence: ["E1"] },
      { text: "Something no evidence shows.", evidence: [] },
    ], not_found: [] });
    const { value: response, corrections } = await observed(() => ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN }));
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response.question).toBe(ASK_AGAIN.question);
    expect(response.since).toEqual({ statements: [{ text: "The fix moved from Priya Nair to Dev Patel.", citation_indexes: [0], private: false }] });
    expect(corrections).toMatchObject({ writer_uncited_sentence_dropped: 1 });
    // No resolver: research ran on the question as asked.
    expect(run.of("resolver")).toEqual([]);
    expect(JSON.parse(run.of("step")[0]!.user_prompt)).toMatchObject({ question: ASK_AGAIN.question });
    const [writer] = run.of("writer");
    expect(writer!.system_prompt.endsWith(`\n\n${ANSWER_SINCE_PROMPT}`)).toBe(true);
    expect(writer!.schema).toBe(answerSinceSchema);
    expect(writer!.max_output_tokens).toBe(2_000);
    const prompt = JSON.parse(writer!.user_prompt) as Record<string, unknown>;
    // The earlier answer, on its day where the asker is, right after the question.
    expect(prompt.earlier).toEqual({ asked_on: "2026-10-14", statements: [{ text: "Priya Nair owns the THERM-482 fix, due Oct 25.", sources: ["Meeting dvt-gate"] }] });
    expect(Object.keys(prompt).slice(0, 2)).toEqual(["question", "earlier"]);
  });

  it("says nothing changed only when the writer compared and found nothing; never for a since it could not stand behind, or for no answer", async () => {
    const answer = { lists: [], sentences: [{ text: "Dev Patel owns the THERM-482 fix.", evidence: ["E1"] }], not_found: [] };
    const nothing = again({ ...answer, since: [] });
    expect((await nothing.ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN })).since).toEqual({ statements: [] });
    const uncited = again({ ...answer, since: [{ text: "Unsupported.", evidence: ["E9"] }] });
    expect(await uncited.ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN })).not.toHaveProperty("since");
    const unasked = again(answer);
    expect(await unasked.ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN })).not.toHaveProperty("since");
    const notFound = again({ lists: [], sentences: [], since: [{ text: "The owner changed.", evidence: ["E1"] }], not_found: ["the owner of the THERM-482 fix"] });
    const empty = await notFound.ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN });
    expect(empty).toMatchObject({ outcome: "not_found", question: ASK_AGAIN.question });
    expect(empty).not.toHaveProperty("since");
  });

  it("answers an Ask again with no earlier sentence left as asked, naming its question and saying nothing of what changed", async () => {
    const { run, ask } = again({ lists: [], sentences: [{ text: "Dev Patel owns the THERM-482 fix.", evidence: ["E1"] }], not_found: [] });
    const response = await ask.answer({ question: ASK_AGAIN.question, previous: { ...ASK_AGAIN, statements: [], citations: [] } });
    expect(response).toMatchObject({ outcome: "answered", question: ASK_AGAIN.question });
    expect(response).not.toHaveProperty("since");
    expect(run.of("writer")[0]!.schema).toBe(answerSchema);
    expect(JSON.parse(run.of("writer")[0]!.user_prompt)).not.toHaveProperty("earlier");
  });

  it("lays out the answer and keeps since beside it when the client asked for layout", async () => {
    const { run, ask } = again({ lists: [], sentences: [{ text: "Dev Patel owns the THERM-482 fix.", evidence: ["E1"], form: "lead" }], since: [{ text: "The owner changed to Dev Patel.", evidence: ["E1"] }], not_found: [] }, { answer_layout: true });
    const response = await ask.answer({ question: ASK_AGAIN.question, previous: ASK_AGAIN });
    expect(run.of("writer")[0]!.schema).toBe(answerLayoutSinceSchema);
    expect(run.of("writer")[0]!.max_output_tokens).toBe(2_500);
    expect(response.parts[0]!.layout).toEqual([{ kind: "lead", statements: [0] }]);
    expect(response.since).toEqual({ statements: [{ text: "The owner changed to Dev Patel.", citation_indexes: [0], private: false }] });
  });
});

describe("an Ask without the previous turn is today's, byte for byte (ADR-0047)", () => {
  it("makes no resolver call, and gives the same prompts, schemas and response with previous absent or undefined", async () => {
    const replies = () => scripted({ steps: [searchFor("Who owns the THERM-482 fix?", "THERM-482"), finishOn("Who owns the THERM-482 fix?", ["E1"])],
      writer: [{ lists: [], sentences: [{ text: "Dev Patel owns the THERM-482 fix.", evidence: ["E1"] }], since: [{ text: "Ignored.", evidence: ["E1"] }], not_found: [] }] });
    const plain = replies();
    const absent = await askV8(desk(), plain).ask.answer({ question: "Who owns the THERM-482 fix?" });
    const undefinedRun = replies();
    const undefinedPrevious = await askV8(desk(), undefinedRun).ask.answer({ question: "Who owns the THERM-482 fix?", previous: undefined });
    expect(JSON.stringify(undefinedPrevious)).toBe(JSON.stringify(absent));
    expect(undefinedRun.inputs.map(({ signal: _signal, ...input }) => input)).toEqual(plain.inputs.map(({ signal: _signal, ...input }) => input));
    expect(plain.of("resolver")).toEqual([]);
    const [writer] = plain.of("writer");
    expect(writer!.schema).toBe(answerSchema);
    expect(writer!.system_prompt).not.toContain("Asked again");
    expect(JSON.parse(writer!.user_prompt)).not.toHaveProperty("earlier");
    for (const key of ["question", "since", "choices"]) expect(absent).not.toHaveProperty(key);
  });
});

describe("fitting an Ask again's answer to its byte bound (ADR-0047)", () => {
  const citation = { citation: { kind: "approved_record" as const, atom_id: `sha256:${"c".repeat(64)}` as const, record_sha256: `sha256:${"d".repeat(64)}` as const, policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, label: "Decision", visibility: "team" as const };
  const long = (index: number) => `${index} ${"x".repeat(4_080)}.`;
  const statement = (index: number) => ({ text: long(index), citation_indexes: [0], private: false });
  const response = (since: number): PersonAnswerResponseV8 => ({
    schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "answered", citations: [citation],
    parts: [{ question: "Q", status: "answered", statements: Array.from({ length: 10 }, (_, index) => statement(index)) }],
    question: "Who owns the THERM-482 fix?", since: { statements: Array.from({ length: since }, (_, index) => statement(100 + index)) },
  });

  it("drops since first and whole, keeping the answer, its outcome and its question", () => {
    const over = response(6);
    expect(canonicalJsonBytes(over).byteLength).toBeGreaterThan(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
    const fitted = compactAndValidateAgenticAskResponseV1(over);
    expect(fitted).not.toHaveProperty("since");
    expect(fitted).toMatchObject({ outcome: "answered", question: "Who owns the THERM-482 fix?", citations: [citation] });
    expect(fitted.parts[0]!.statements).toHaveLength(10);
    // One that fits keeps its since.
    expect(compactAndValidateAgenticAskResponseV1(response(1)).since!.statements).toHaveLength(1);
  });
});
