import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { PERSON_ANSWER_RESPONSE_MAX_BYTES_V4, validatePersonAnswerResponseV8, type PersonAnswerResponseV8 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { citationOfAgenticEvidenceItemV8 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import {
  ANSWER_FOLLOW_UPS_PROMPT, ANSWER_PROMPT, answerBlocksFollowUpsSchema, answerBlocksSchema, answerBlocksSinceFollowUpsSchema,
} from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticAskAnswerSha256V1, compactAndValidateAgenticAskResponseV1 } from "../../../src/answer-composition/agentic-ask-v1-response.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { askFollowUpItemIdV1 } from "../../../src/answer-composition/ask-follow-ups-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import { followUpItem, ticketBody } from "../fixtures/agentic-lists.js";
import { EMPTY_BUNDLE, record, scriptedGate, writerReply } from "../fixtures/agentic-scenarios.js";

/**
 * The follow-ups Ask's writer drafts (ADR-0053), through the renderer alone: a hand-built bundle, scripted writer replies,
 * and a request that saves follow-ups (`request_id`) or one that saves none.
 */
const REQUEST = "ask_6b0f8a52-55a4-4f6e-9a39-000000000001";

function alone(input: {
  readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly request_id?: string; readonly earlier?: boolean;
  /** The question the writer answers (a follow-up's, as its resolver rewrote it), and what the person typed, when that differs. */
  readonly question?: string; readonly typed?: string;
}) {
  const trace: string[] = [];
  const { gate, inputs } = scriptedGate(input.replies, input.bundle.budget, trace);
  const renderer = createAskRendererV1({
    answer_prompt: ANSWER_PROMPT, source_catalog: [], scope: "everything the asker can read",
    context: { today: "2026-11-18", time_zone: "America/Los_Angeles" }, desk_scope: input.bundle.gathered_for.scope,
    ...(input.request_id === undefined ? {} : { follow_ups: { request_id: input.request_id } }),
    ...(input.earlier === true ? { answers: "What was decided?", earlier: { asked_on: "2026-11-10", statements: [{ text: "Earlier.", sources: ["Meeting r1"] }] } } : {}),
  });
  const render = () => renderer.render({
    bundle: input.bundle, trigger_input: { question: input.question ?? "What was decided? Ask Sam to call the vendor by Friday.", ...(input.typed === undefined ? {} : { typed_question: input.typed }) }, gate, remaining: () => 30_000, signal: new AbortController().signal,
    prompt_budget: (system, output = AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer) => agenticAskContextBudgetBytesV1(undefined, system, output),
  });
  return { render, inputs, trace };
}

type Rendering = Awaited<ReturnType<ReturnType<typeof alone>["render"]>>;
async function observed(render: () => Promise<Rendering>): Promise<{ readonly rendered: Rendering; readonly corrections: Readonly<Record<string, number>> }> {
  const events: CoreRuntimeObservationV1[] = [];
  const rendered = await observeCoreRuntimeV1("research_output", render, { observer: event => { events.push(event); } });
  return { rendered, corrections: events.find(event => event.phase === "research_output" && event.event !== "started")!.model_corrections ?? {} };
}

/** Items E1..En, each read in full and cited by the plan. */
function bundle(items: readonly EvidenceDeskItemV2[], stop: AgenticEvidenceBundleV1["stop"] = { reason: "finished", completed: true }): AgenticEvidenceBundleV1 {
  const shorts = items.map((_, index) => `E${index + 1}`);
  return Object.freeze({
    ...EMPTY_BUNDLE,
    plan: items.length === 0 ? [] : [{ part: 1, question: "What was decided?", notes: "", needs: [{ need: "the decision", status: "found" as const, evidence: shorts }] }],
    items: items.map((item, index) => Object.freeze({ short: `E${index + 1}`, source: "meetings", item, full: true, opened: true, preloaded: false, touched: index + 1, cited_by_plan: true })),
    stop,
  });
}
const decided = record("r1", "Approved: Sam Lee calls the vendor about the fixture delay.");
const ticket = ticketBody(2, "The fixture vendor is late.");
const answered = (followUps?: readonly unknown[]) => ({ ...writerReply([{ text: "The review approved the call.", evidence: ["E1"] }]), ...(followUps === undefined ? {} : { follow_ups: followUps }) });

describe("Ask renderer: follow-ups the writer drafts (ADR-0053)", () => {
  it("leaves an answer that drafts none byte for byte as it was, and tells only a writer whose drafts are saved to draft", async () => {
    const before = alone({ bundle: bundle([decided]), replies: [answered()] });
    const after = alone({ bundle: bundle([decided]), replies: [answered([])], request_id: REQUEST });
    const [plain, drafting] = [await before.render(), await after.render()];
    expect(JSON.stringify(drafting.result.response)).toBe(JSON.stringify(plain.result.response));
    expect(drafting.result.response).not.toHaveProperty("follow_ups");
    expect(drafting.answer_sha256).toBe(plain.answer_sha256);
    expect(drafting.result.follow_ups).toEqual([]);
    // Only the drafting writer sees the instruction, and the reply shape that must give follow_ups.
    expect(before.inputs[0]!.system_prompt).not.toContain(ANSWER_FOLLOW_UPS_PROMPT);
    expect(before.inputs[0]!.schema).toBe(answerBlocksSchema);
    expect(after.inputs[0]!.system_prompt.endsWith(ANSWER_FOLLOW_UPS_PROMPT)).toBe(true);
    expect(after.inputs[0]!.schema).toBe(answerBlocksFollowUpsSchema);
    // An Ask again's writer drafts as well, with since beside them.
    const again = alone({ bundle: bundle([decided]), replies: [{ ...answered([]), since: [] }], request_id: REQUEST, earlier: true });
    await again.render();
    expect(again.inputs[0]!.schema).toBe(answerBlocksSinceFollowUpsSchema);
  });

  it("drops what a writer drafts when the request saves no follow-ups, so the answer lists none", async () => {
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided]), replies: [answered([{ task: "Call the vendor", owner: "Sam Lee" }])] }).render());
    expect(rendered.result.response).not.toHaveProperty("follow_ups");
    expect(rendered.result.follow_ups).toEqual([]);
    expect(corrections).toMatchObject({ follow_up_dropped: 1 });
  });

  it("keeps a clean draft with its owner, day and link, under the request's id, and binds it in the answer's fingerprint", async () => {
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, ticket]), request_id: REQUEST,
      replies: [answered([{ task: "Call   the vendor about the fixture delay", owner: "Sam Lee", due_on: "2026-11-20", about: "E1" }, { task: "Chase the quote", about: "e2" }])] }).render());
    const drafts = rendered.result.follow_ups;
    expect(drafts).toEqual([
      { item_id: askFollowUpItemIdV1(REQUEST, 0), task: "Call the vendor about the fixture delay", owner_name: "Sam Lee", due_on: "2026-11-20", about: decided.citation },
      { item_id: askFollowUpItemIdV1(REQUEST, 1), task: "Chase the quote", about: ticket.citation },
    ]);
    expect(rendered.result.response.follow_ups).toEqual(drafts.map(draft => draft.item_id));
    expect(validatePersonAnswerResponseV8(rendered.result.response)).toEqual(rendered.result.response);
    // The fingerprint binds what is saved, not only the ids.
    expect(rendered.answer_sha256).toBe(agenticAskAnswerSha256V1(rendered.result.response, drafts));
    expect(rendered.answer_sha256).not.toBe(agenticAskAnswerSha256V1({ ...rendered.result.response, follow_ups: undefined }));
    expect(corrections).toMatchObject({ model_id_respelled: 1 });
    expect(corrections).not.toHaveProperty("follow_up_link_dropped");
  });

  it("names the same ids on every attempt of one request, and other ids for another request", async () => {
    const reply = answered([{ task: "Call the vendor" }]);
    const first = await alone({ bundle: bundle([decided]), replies: [reply], request_id: REQUEST }).render();
    const retried = await alone({ bundle: bundle([decided]), replies: [reply], request_id: REQUEST }).render();
    const other = await alone({ bundle: bundle([decided]), replies: [reply], request_id: "ask_6b0f8a52-55a4-4f6e-9a39-000000000002" }).render();
    expect(retried.result.response.follow_ups).toEqual(first.result.response.follow_ups);
    expect(other.result.response.follow_ups).not.toEqual(first.result.response.follow_ups);
  });

  it("repairs or drops each field a draft cannot keep, and the draft stays when its task does", async () => {
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, followUpItem(1)]), request_id: REQUEST, replies: [answered([
      // Not a calendar day: the day goes, the draft stays.
      { task: "Book the lab", due_on: "2026-02-30" },
      { task: "Book the bench", due_on: "next Friday" },
      // An id the writer was not shown, and an item that is not a ticket, page or ECHO record or document: no link.
      { task: "Check the soak", about: "E9" },
      { task: "Confirm the fan curve", about: "E2" },
      // A repeat of a kept draft says nothing new.
      { task: "Book  the lab" },
    ])] }).render());
    expect(rendered.result.follow_ups.map(({ item_id: _id, ...draft }) => draft)).toEqual([
      { task: "Book the lab" }, { task: "Book the bench" }, { task: "Check the soak" }, { task: "Confirm the fan curve" },
    ]);
    expect(rendered.result.follow_ups.map(draft => draft.item_id)).toEqual([0, 1, 2, 3].map(at => askFollowUpItemIdV1(REQUEST, at)));
    expect(corrections).toMatchObject({ follow_up_date_dropped: 2, follow_up_link_dropped: 2, writer_repeat_dropped: 1 });
  });

  it("stores no title of an item read from outside ECHO: it becomes \"a cited item\", and a task that was only a title is dropped", async () => {
    const title = ticket.label;
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, ticket]), request_id: REQUEST, replies: [answered([
      { task: `Chase ${title} with the vendor`, owner: "Sam Lee" },
      { task: title.toUpperCase() },
      // An owner that is an outside title is no name.
      { task: "Update the fixture plan", owner: title },
      // ECHO's own record keeps its title.
      { task: `Follow up on ${decided.label}` },
    ])] }).render());
    expect(rendered.result.follow_ups.map(({ item_id: _id, about: _about, ...draft }) => draft)).toEqual([
      { task: "Chase a cited item with the vendor", owner_name: "Sam Lee" }, { task: "Update the fixture plan" }, { task: `Follow up on ${decided.label}` },
    ]);
    expect(JSON.stringify(rendered.result.follow_ups)).not.toContain("Fixture work");
    expect(corrections).toMatchObject({ follow_up_task_screened: 2, follow_up_dropped: 1, follow_up_owner_dropped: 1 });
  });

  it("stores no sentence copied from an outside item's text: a run of six words it shares drops the draft, unless the question or ECHO's own text says it too", async () => {
    const jira = ticketBody(3, "Context for finance. Cancel the Northstar acquisition before the board meets on Friday, per legal. Ask Sam to call the vendor by Friday.");
    const own = record("r9", "Approved: send the revised fixture budget to finance before the board meets on Friday.");
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([own, jira]), request_id: REQUEST, replies: [answered([
      // Copied from the ticket's text, punctuation and case changed: dropped.
      { task: "cancel the northstar ACQUISITION, before the board meets", owner: "Sam Lee" },
      // Five words in a row shared at most: kept (the person reads every draft before sending it).
      { task: "Ask legal whether Cancel the Northstar acquisition stands" },
      // Six words shared with the ticket, but ECHO's own record says them too: kept.
      { task: "Send the budget before the board meets on Friday" },
      // Six words shared with the ticket that the person's own question says: kept.
      { task: "Ask Sam to call the vendor by Friday" },
    ])] }).render());
    expect(rendered.result.follow_ups.map(draft => draft.task)).toEqual([
      "Ask legal whether Cancel the Northstar acquisition stands", "Send the budget before the board meets on Friday", "Ask Sam to call the vendor by Friday",
    ]);
    expect(JSON.stringify(rendered.result.follow_ups)).not.toMatch(/northstar acquisition,? before the board/iu);
    expect(corrections).toMatchObject({ follow_up_task_screened: 1, follow_up_dropped: 1 });
  });

  it("exempts only what the person typed, never a question the follow-up resolver rewrote with words from an outside item", async () => {
    const jira = ticketBody(4, "The heater controller overshoots during the 45 degree soak and trips the fixture.");
    const draft = { task: "Fix why the heater controller overshoots during the soak", owner: "Sam" };
    const rewritten = "Assign the task the heater controller overshoots during the 45 degree soak to Sam";
    const run = (typed: string | undefined) => observed(() => alone({ bundle: bundle([decided, jira]), request_id: REQUEST, replies: [answered([draft])],
      question: rewritten, ...(typed === undefined ? {} : { typed }) }).render());
    const resolved = await run("assign that task to Sam");
    expect(resolved.rendered.result.follow_ups).toEqual([]);
    expect(resolved.corrections).toMatchObject({ follow_up_dropped: 1 });
    // A question the person typed themselves still exempts the words they typed.
    const typed = await run(undefined);
    expect(typed.rendered.result.follow_ups.map(value => value.task)).toEqual([draft.task]);
  });

  it("counts each character of a script written without spaces as a word, so a copied Chinese or Japanese sentence is dropped", async () => {
    const zh = ticketBody(5, "供应商必须在周五之前重新报价测试夹具，否则项目会延期。");
    const ja = ticketBody(6, "金曜日までに試験治具の見積もりを再提出してください。");
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, zh, ja]), request_id: REQUEST, replies: [answered([
      // Copied, punctuation changed: dropped.
      { task: "供应商必须在周五之前重新报价测试夹具" },
      { task: "試験治具の見積もりを再提出" },
      // The person's own words about the same thing: kept.
      { task: "联系供应商确认新报价" },
      { task: "見積もりの件でベンダーに電話する" },
    ])] }).render());
    expect(rendered.result.follow_ups.map(value => value.task)).toEqual(["联系供应商确认新报价", "見積もりの件でベンダーに電話する"]);
    expect(corrections).toMatchObject({ follow_up_dropped: 2 });
  });

  it("counts a mark these scripts share, such as the prolonged sound mark ー or an iteration mark, as a word of its own", async () => {
    const ja = ticketBody(7, "試合はゴーールです。人々々は喜んだ。");
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, ja]), request_id: REQUEST, replies: [answered([
      // Six characters copied, two of them ー (script Common): dropped.
      { task: "ゴーールです" },
      // Six characters copied, around the iteration mark 々: dropped.
      { task: "人々々は喜ん" },
      // Five of them: kept.
      { task: "ゴーールで確認" },
      // Copied across the ticket's full stop with the stop left out: punctuation is no word, so this is still a run.
      { task: "ールです人々" },
    ])] }).render());
    expect(rendered.result.follow_ups.map(value => value.task)).toEqual(["ゴーールで確認"]);
    expect(corrections).toMatchObject({ follow_up_dropped: 3 });
  });

  it("keeps drafts with the same task and owner apart when their day or their item differs, and drops only a true repeat", async () => {
    const { rendered, corrections } = await observed(() => alone({ bundle: bundle([decided, ticket]), request_id: REQUEST, replies: [answered([
      { task: "Check the status", owner: "Sam Lee", about: "E1" },
      { task: "Check the status", owner: "Sam Lee", about: "E2" },
      { task: "Check the status", owner: "Sam Lee", about: "E2", due_on: "2026-11-20" },
      { task: "Check the  status", owner: "sam lee", about: "E2", due_on: "2026-11-20" },
    ])] }).render());
    expect(rendered.result.follow_ups.map(({ item_id: _id, ...draft }) => draft)).toEqual([
      { task: "Check the status", owner_name: "Sam Lee", about: decided.citation },
      { task: "Check the status", owner_name: "Sam Lee", about: ticket.citation },
      { task: "Check the status", owner_name: "Sam Lee", due_on: "2026-11-20", about: ticket.citation },
    ]);
    expect(corrections).toMatchObject({ writer_repeat_dropped: 1 });
  });

  it("tells the writer to write each task in its own words", () => {
    expect(ANSWER_FOLLOW_UPS_PROMPT).toMatch(/own words/u);
    expect(ANSWER_FOLLOW_UPS_PROMPT).toMatch(/never copy a title or a sentence from a ticket, a page or a message/iu);
  });

  it("drafts a follow-up about nothing ECHO knows: the writer runs with no evidence, and the answer says it drafted one", async () => {
    const empty = bundle([], { reason: "finished", completed: true, follow_up_requested: true });
    const run = alone({ bundle: empty, request_id: REQUEST, replies: [{
      lists: [], blocks: [{ block: "answer", sentences: [{ text: "I drafted the task for Sam.", evidence: [] }] }], not_found: [],
      follow_ups: [{ task: "Call the vendor", owner: "Sam", due_on: "2026-11-20" }],
    }] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(1);
    expect(JSON.parse(run.inputs[0]!.user_prompt).evidence).toEqual([]);
    const response = rendered.result.response;
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject({ outcome: "not_found", citations: [], follow_ups: [askFollowUpItemIdV1(REQUEST, 0)] });
    expect(response.parts[0]).toMatchObject({ status: "not_found", statements: [],
      gap: "I drafted a follow-up for you to review and send. I couldn't find anything more about it in the sources you can access." });
    expect(response.parts[0]!.gap_details).not.toHaveProperty("unsupported_action");
    expect(rendered.result.follow_ups).toEqual([{ item_id: askFollowUpItemIdV1(REQUEST, 0), task: "Call the vendor", owner_name: "Sam", due_on: "2026-11-20" }]);
  });

  it("says plainly what it could not do when research asks for a follow-up the request cannot save, and never calls the writer for nothing", async () => {
    const run = alone({ bundle: bundle([], { reason: "finished", completed: true, follow_up_requested: true }), replies: [] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(0);
    expect(rendered.result.response).not.toHaveProperty("follow_ups");
    expect(rendered.result.response.parts[0]!.gap).toMatch(/^Ask can read your sources, but it can't make changes/u);
    expect(rendered.result.response.parts[0]!.gap_details).toMatchObject({ unsupported_action: true });
    expect(validatePersonAnswerResponseV8(rendered.result.response)).toEqual(rendered.result.response);
  });

  it("drafts nothing beside a writer that gave no usable reply", async () => {
    const rendered = await alone({ bundle: bundle([decided]), request_id: REQUEST, replies: [{ follow_ups: [{ task: "Call the vendor" }] }, { follow_ups: [{ task: "Call the vendor" }] }] }).render();
    expect(rendered.fallbacks).toBe(1);
    expect(rendered.result.response).not.toHaveProperty("follow_ups");
    expect(rendered.result.follow_ups).toEqual([]);
  });
});

describe("Ask response: the follow-ups it lists (ADR-0053)", () => {
  it("keeps the follow-up ids when an answer is cut to its byte bound, and hashes an answer that lists none as before", () => {
    const citation = citationOfAgenticEvidenceItemV8(decided);
    const count = Math.ceil(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4 / 3_800) + 2;
    const statements = Array.from({ length: count }, (_, at) => ({ text: `${"Long statement. ".repeat(240)}${at}`, citation_indexes: [0], private: false }));
    const ids = [askFollowUpItemIdV1(REQUEST, 0)];
    const base = { schema_version: 8 as const, kind: "echo-clean-person-answer-v8" as const, scope: { kind: "global" as const }, outcome: "answered" as const,
      parts: [{ question: "Q", status: "answered" as const, statements }], citations: [citation] };
    const compacted = compactAndValidateAgenticAskResponseV1({ ...base, follow_ups: ids } as PersonAnswerResponseV8);
    expect(compacted.parts[0]!.statements.length).toBeLessThan(count);
    expect(compacted.follow_ups).toEqual(ids);
    const plain = compactAndValidateAgenticAskResponseV1(base as PersonAnswerResponseV8);
    expect(plain).not.toHaveProperty("follow_ups");
    expect(agenticAskAnswerSha256V1(plain)).toBe(canonicalSha256({ direct: null, parts: plain.parts }));
    expect(agenticAskAnswerSha256V1({ ...plain, follow_ups: ids })).toBe(canonicalSha256({ direct: null, parts: plain.parts, follow_ups: ids }));
  });
});
