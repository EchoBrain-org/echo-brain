import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { citationOfAgenticEvidenceItemV8 } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-evidence-bundle-v1.js";
import { ANSWER_BLOCK_CATALOG, ANSWER_BLOCKS_PROMPT, answerBlocksSchema } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { sha256 } from "../../shared/runner.mjs";
import { ARM_IDS, BUILT, CATALOG_IDS, readReleased } from "../catalogs.mjs";
import { decideGate, evidenceOf, gradeTrial, loadCases } from "../grade.mjs";
import { captureWriterPrompts, deskItem, evidenceIdsOf, parseArgs, run } from "../run.mjs";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072 };
const document = loadCases();
const caseOf = (id) => document.cases.find((entry) => entry.id === id);
const itemsOf = (caseDefinition) => caseDefinition.items.map((item, index) => deskItem(caseDefinition.id, index, item));

// gate-blockers' items are E1 the review's decision, E2 THERM-482, E3 THERM-488 and E4 the soak follow-up. The answer
// cites them in another order, as the kernel numbers citations by first use: the follow-up, THERM-482, THERM-488, then
// the decision.
const blockers = caseOf("gate-blockers");
const [decision, fan, certificate, soak] = itemsOf(blockers);
const citations = [soak, fan, certificate, decision].map((item) => citationOfAgenticEvidenceItemV8(item, document.time_zone));
/** What the v2 writer is given for gate-blockers, as the kernel asks it: the evidence its answers are graded against, captured once. */
let captured;
const given = () => (captured ??= captureWriterPrompts(blockers, document, generation, BUILT.answer_layout).then((prompts) => evidenceOf(prompts.user_prompt)));
/** A statement citing `citation_indexes`: private exactly when one of them is, as a Jira issue the asker reads alone is. */
const statement = (text, citation_indexes) => ({ text, citation_indexes, private: citation_indexes.some((index) => citations[index].visibility === "only_me") });
/** gate-blockers answered with every block layout v2 has, as the kernel releases it (ADR-0051). */
const released = (part = {}) => ({
  schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "answered", citations,
  parts: [{
    question: blockers.question, status: "answered",
    statements: [
      statement("Three things block the DVT gate.", [3, 1]),
      statement("The gate opens only when all three are done.", [3]),
      statement("Fix the fan stall in firmware 2.3.", [1]),
      statement("Run the 72-hour soak.", [0]),
      statement("2 tickets block the gate: THERM-482; THERM-488.", [1, 2]),
      statement("2026-10-08: THERM-482 was opened.", [1]),
      statement("2026-10-27, Priya Raman: The soak was set.", [0]),
      statement("Ticket: THERM-488; Status: Blocked.", [2]),
      statement("Ticket: THERM-488; Owner: Dev Mehta.", [2]),
      statement("DVT readiness review: “The DVT gate opens only when THERM-482 is fixed”", [3]),
    ],
    blocks: [
      { kind: "answer", statements: [0] },
      { kind: "text", title: "Why", statements: [1] },
      { kind: "points", title: "Steps", ordered: true, statements: [2, 3] },
      { kind: "table", title: "Blocking tickets", statements: [4], columns: ["Ticket", "Status"], caption: "2 tickets block the gate",
        rows: [{ cells: ["THERM-482", "In Progress"], citation_indexes: [1] }, { cells: ["THERM-488", "Blocked"], citation_indexes: [2] }] },
      { kind: "timeline", title: "Dates", statements: [5, 6], events: [{ date: "2026-10-08", text: "THERM-482 was opened." }, { date: "2026-10-27", text: "The soak was set.", who: "Priya Raman" }] },
      { kind: "card", title: "THERM-488", entity: "ticket", statements: [7, 8], facts: [{ label: "Status", value: "Blocked" }, { label: "Owner", value: "Dev Mehta" }] },
      { kind: "quote", statements: [9], text: "The DVT gate opens only when THERM-482 is fixed", from: "DVT readiness review" },
    ],
    ...part,
  }],
});

test("maps each of an answer's citations back to its case item, E1 to En in the order research opened them", () => {
  assert.deepEqual(evidenceIdsOf(citations, itemsOf(blockers)), ["E4", "E2", "E3", "E1"]);
  // A citation of no case item is named as one, so grading finds it among nothing the writer was given.
  const elsewhere = { citation: { kind: "tool", tool_id: "jira" }, kind: "tool", label: "Jira", visibility: "team", ref: "tool:jira" };
  assert.deepEqual(evidenceIdsOf([citations[1], elsewhere], itemsOf(blockers)), ["E2", "citation 2"]);
});

test("reads every block of a released answer into the common blocks, each claim citing its evidence ids", async () => {
  const response = released();
  const read = readReleased(response, evidenceIdsOf(response.citations, itemsOf(blockers)));
  assert.deepEqual([read.valid, read.problems], [true, []]);
  assert.deepEqual(read.blocks, [
    { kind: "answer", claims: [{ text: "Three things block the DVT gate.", evidence: ["E1", "E2"] }] },
    { kind: "prose", title: "Why", claims: [{ text: "The gate opens only when all three are done.", evidence: ["E1"] }] },
    { kind: "list", ordered: true, title: "Steps", claims: [{ text: "Fix the fan stall in firmware 2.3.", evidence: ["E2"] }, { text: "Run the 72-hour soak.", evidence: ["E4"] }] },
    { kind: "table", title: "Blocking tickets", columns: ["Ticket", "Status"], rows: [{ cells: ["THERM-482", "In Progress"], evidence: ["E2"] }, { cells: ["THERM-488", "Blocked"], evidence: ["E3"] }] },
    { kind: "timeline", title: "Dates", events: [{ date: "2026-10-08", text: "THERM-482 was opened.", evidence: ["E2"] }, { date: "2026-10-27", text: "The soak was set.", who: "Priya Raman", evidence: ["E4"] }] },
    { kind: "card", title: "THERM-488", card_kind: "ticket", facts: [{ label: "Status", value: "Blocked", evidence: ["E3"] }, { label: "Owner", value: "Dev Mehta", evidence: ["E3"] }] },
    { kind: "quote", text: "The DVT gate opens only when THERM-482 is fixed", from: "DVT readiness review", evidence: ["E1"] },
  ]);
  assert.deepEqual(read.view.map((node) => node.t), ["lead", "h", "p", "h", "ol", "h", "table", "h", "timeline", "card", "quote"]);
  // Graded as the other arms are, against the evidence the v2 writer is given.
  const grade = gradeTrial(blockers, BUILT, read, await given());
  assert.deepEqual([grade.valid, grade.grounded, grade.fit, grade.grounding_problems], [true, true, true, []]);
  assert.deepEqual(grade.shapes, ["grid", "ordered", "profile", "prose", "sections", "sequence", "verbatim"]);
});

test("is not valid when the answer was released without blocks or fails the V8 contract, and passes nothing", async () => {
  const ids = evidenceIdsOf(citations, itemsOf(blockers));
  const { blocks: _blocks, ...plain } = released().parts[0];
  const without = readReleased({ ...released(), parts: [plain] }, ids);
  assert.deepEqual([without.valid, without.problems, without.blocks], [false, ["the answer was released without blocks"], []]);
  const laidOut = readReleased({ ...released(), parts: [{ ...plain, layout: [{ kind: "lead", statements: [0] }, { kind: "paragraph", statements: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] }] }, ids);
  assert.deepEqual(laidOut.problems, ["the answer was released without blocks"]);
  const broken = readReleased(released({ blocks: released().parts[0].blocks.slice(0, 6) }), ids);
  assert.deepEqual([broken.valid, broken.problems], [false, ["organization API: Ask answer blocks leave a statement out"]]);
  assert.equal(readReleased(null, ids).valid, false);
  const grade = gradeTrial(blockers, BUILT, without, await given());
  assert.deepEqual([grade.valid, grade.grounded, grade.nothing_lost, grade.fit, grade.main_shape], [false, false, false, false, "invalid"]);
});

test("decides the gate only on a complete gate run, by rules 1 to 5", () => {
  const rules = (failing = []) => Object.fromEntries(["valid", "grounded", "nothing_lost", "fit", "stable"].map((rule) => [rule, !failing.includes(rule)]));
  assert.deepEqual(decideGate({ rules: rules() }, true), { complete: true, arm: "built", passes: true, rules: rules() });
  assert.equal(decideGate({ rules: rules(["stable"]) }, true).passes, false);
  assert.equal(decideGate({ rules: rules() }, false).passes, null);
  assert.deepEqual(decideGate(undefined, true), { complete: true, arm: "built", passes: null, rules: null });
});

test("selects the built arm beside the four catalogs, and never asks the judge to rank it", () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-blocks-built-args-"));
  const credential = join(directory, "credential");
  writeFileSync(credential, "not read", { mode: 0o600 });
  const base = ["--run", "--credential-file", credential, "--out", join(directory, "out")];
  assert.deepEqual([CATALOG_IDS, ARM_IDS], [["today", "templates", "balanced", "primitives"], ["today", "templates", "balanced", "primitives", "built"]]);
  const gate = parseArgs([...base, "--catalogs", "built", "--judge", "off"]);
  assert.deepEqual([gate.catalogIds, gate.judge, gate.trials, gate.caseIds], [["built"], false, 3, null]);
  assert.throws(() => parseArgs([...base, "--catalogs", "built"]), /nothing for the judge to rank: add --judge off/u);
  assert.throws(() => parseArgs([...base, "--catalogs", "shipped", "--judge", "off"]), /known catalogs/u);
  // A diagnostic beside a catalog keeps the judge for that catalog.
  assert.deepEqual(parseArgs([...base, "--catalogs", "balanced,built", "--trials", "1"]).catalogIds, ["balanced", "built"]);
});

/** A route that answers every writer call from `reply(input, call)` and refuses any other call. */
function route(reply) {
  const inputs = [];
  return {
    inputs,
    async generate_with_observation(input) {
      if (Object.hasOwn(input.schema.properties ?? {}, "ranks")) throw new Error("the judge never ranks the built writer");
      inputs.push(input);
      return { value: reply(input, inputs.length), finish_reason: "stop", usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020 }, provider_latency_ms: 3 };
    },
  };
}

/** ticket-profile answered with a card, a timeline, a quote, steps and text; the answer cites the follow-up (E2) first. */
const TICKET_REPLY = Object.freeze({ lists: [], not_found: [], blocks: [
  { block: "answer", sentences: [{ text: "It is a High priority Jira issue: the fan stalls at cold start.", evidence: ["E2", "E1"] }] },
  { block: "card", title: "THERM-482", kind: "ticket", facts: [{ label: "Status", value: "In Progress", evidence: ["E1"] }, { label: "Owner", value: "Tomas Okafor", evidence: ["E1"] }] },
  { block: "timeline", title: "Dates", events: [{ date: "2026-11-05", text: "The fix is due to be verified.", who: "Priya Raman", evidence: ["E2"] }, { date: "2026-10-08", text: "THERM-482 was opened.", evidence: ["E1"] }] },
  { block: "quote", text: "A fix is planned in firmware 2.3.", from: "THERM-482", evidence: ["E1"] },
  { block: "points", title: "Next", ordered: true, items: [{ text: "Verify the fix on the DVT units.", evidence: ["E2"] }, { text: "Then the DVT gate can open.", evidence: ["E1"] }] },
  { block: "text", sentences: [{ text: "It stalls below 40% duty cycle under 5°C.", evidence: ["E1"] }] },
] });

const options = (out, fields = {}) => ({ run: true, credentialFile: null, out, caseIds: ["ticket-profile"], catalogIds: ["built"], trials: 1, judge: false, concurrency: 1, timeoutMs: 20_000, ...fields });

test("runs the built writer through the kernel end to end, keeping each call and grading the answer it releases", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-built-run-"));
  const writer = route(() => TICKET_REPLY);
  const { report } = await run(options(out), { loaded: { structured_output: writer, generation }, progress: () => undefined });
  // Only the writer's call reached the route, with the kernel's v2 prompt, block catalog, schema and output room.
  assert.equal(writer.inputs.length, 1);
  const [input] = writer.inputs;
  assert.ok(input.system_prompt.startsWith("You write Echo's final answer") && input.system_prompt.endsWith(`\n\n${ANSWER_BLOCKS_PROMPT}`));
  assert.deepEqual([JSON.parse(input.user_prompt).block_catalog, input.schema, input.max_output_tokens], [ANSWER_BLOCK_CATALOG, answerBlocksSchema, 2_000]);
  // The writer was asked exactly as the capture recorded it, so its call keeps the prompts the report holds.
  const prompts = report.prompts["ticket-profile"].built;
  assert.deepEqual([prompts.user_prompt, prompts.system_prompt_sha256, report.system_prompts[prompts.system_prompt_sha256]], [input.user_prompt, sha256(input.system_prompt), input.system_prompt]);
  const [trial] = report.trials;
  const { elapsed_ms: elapsed, ...attempt } = trial.attempts[0];
  assert.ok(Number.isSafeInteger(elapsed));
  assert.deepEqual(attempt, { attempt: 1, kind: "first", system_prompt_sha256: prompts.system_prompt_sha256, max_output_tokens: 2_000, value: TICKET_REPLY, finish_reason: "stop",
    usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020 }, provider_latency_ms: 3, valid: true });
  // The released answer is kept and graded: its citations in first-use order, the follow-up first, map back to E2 and E1.
  assert.deepEqual(trial.response.citations.map((entry) => entry.kind), ["follow_up", "ticket"]);
  assert.deepEqual(trial.read.blocks.map((block) => block.kind), ["answer", "card", "timeline", "quote", "list", "prose"]);
  assert.deepEqual(trial.read.blocks[0].claims[0].evidence, ["E2", "E1"]);
  // The kernel reads its events oldest first.
  assert.deepEqual(trial.read.blocks[2].events.map((event) => [event.date, event.evidence]), [["2026-10-08", ["E1"]], ["2026-11-05", ["E2"]]]);
  assert.deepEqual([trial.grade.valid, trial.grade.grounded, trial.grade.nothing_lost, trial.grade.fit, trial.grade.main_shape], [true, true, true, true, "profile"]);
  assert.deepEqual(report.catalogs.built, { modeled_on: BUILT.modeled_on, answer_layout: 2, catalog_key: "block_catalog", catalog: ANSWER_BLOCK_CATALOG, can_show: BUILT.can_show, schema: answerBlocksSchema });
  assert.deepEqual([report.complete, report.decision, report.judge, report.errors], [false, { complete: false, arm: "built", passes: null, rules: report.summary.built.rules }, {},
    { writer_calls: 0, trials_without_reply: 0, judge_orders_without_ranks: 0 }]);
});

test("lets the kernel's own reading, repair and downgrades decide what is released; the harness adds no repair", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-built-kernel-"));
  // The first reply has no blocks, which the kernel refuses; its repair quotes words E1 does not have and dates an event
  // on a day E2 does not record, which the kernel reads as text.
  const writer = route((_input, call) => (call === 1 ? { lists: [], not_found: [] } : { lists: [], not_found: [], blocks: [
    { block: "answer", sentences: [{ text: "Priya Raman owns it.", evidence: ["E1"] }] },
    { block: "quote", text: "Priya owns the soak from now on.", from: "DVT readiness review", evidence: ["E1"] },
    { block: "timeline", events: [{ date: "2026-10-27", text: "The soak was assigned.", evidence: ["E1"] }, { date: "2026-09-01", text: "The chamber was ordered.", evidence: ["E2"] }] },
  ] }));
  const { report } = await run(options(out, { caseIds: ["soak-owner"] }), { loaded: { structured_output: writer, generation }, progress: () => undefined });
  const [trial] = report.trials;
  assert.deepEqual(trial.attempts.map((attempt) => [attempt.kind, attempt.valid]), [["first", false], ["repair", true]]);
  assert.match(trial.attempts[0].problems[0], /"blocks" must be an array/u);
  const repair = JSON.parse(trial.attempts[1].user_prompt);
  assert.deepEqual([repair.validation_error, JSON.parse(repair.rejected_response)], [trial.attempts[0].problems[0], { lists: [], not_found: [] }]);
  // Downgraded, the quote and both events read as text after the answer: no quote, and no timeline of one event.
  assert.deepEqual(trial.read.blocks.map((block) => block.kind), ["answer", "prose"]);
  assert.deepEqual(trial.read.blocks[1].claims.map((claim) => claim.text), ["DVT readiness review: Priya owns the soak from now on.", "2026-10-27: The soak was assigned.", "The chamber was ordered."]);
  assert.deepEqual([report.summary.built.repairs, report.summary.built.valid_at_once, report.summary.built.valid], [1, 0, 1]);
});

test("makes a complete gate run of the built writer alone, every case three times with the judge off, and decides it", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-built-gate-"));
  // A reply that says nothing wrong and nothing asked: valid and grounded, but it loses every case's facts.
  const writer = route((input) => ({ lists: [], not_found: [], blocks: [{ block: "answer", sentences: [{ text: "The evidence covers it.", evidence: JSON.parse(input.user_prompt).evidence.map((item) => item.id) }] }] }));
  const { report } = await run(options(out, { caseIds: null, trials: 3, concurrency: 6 }), { loaded: { structured_output: writer, generation }, progress: () => undefined });
  assert.deepEqual([report.complete, report.limits.catalogs, report.summary.built.trials, writer.inputs.length], [true, ["built"], 45, 45]);
  assert.deepEqual(report.decision, { complete: true, arm: "built", passes: false, rules: { valid: true, grounded: true, nothing_lost: false, fit: false, stable: true } });
  // The same run with fewer trials decides nothing.
  const fewer = await run(options(out, { caseIds: null, trials: 1, concurrency: 6 }), { loaded: { structured_output: route(() => TICKET_REPLY), generation }, progress: () => undefined });
  assert.deepEqual([fewer.report.complete, fewer.report.decision.passes], [false, null]);
});

test("resumes a built trial: a reply is handed to the kernel again only when it asks with the same prompts", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-built-resume-"));
  const outage = Object.assign(new Error("402"), { diagnostic: { failure_class: "adapter_http", http_status: 402 } });
  const failing = { inputs: [], async generate_with_observation(input) {
    this.inputs.push(input);
    if (this.inputs.length > 1) throw outage;
    return { value: { lists: [], not_found: [] }, finish_reason: "stop", usage: null, provider_latency_ms: 1 };
  } };
  const first = await run(options(out), { loaded: { structured_output: failing, generation }, progress: () => undefined });
  // The kernel refused the first reply and its repair met the outage, so it released code's fallback, without blocks.
  assert.deepEqual(first.report.trials[0].attempts.map((attempt) => [attempt.kind, attempt.error?.http_status ?? null]), [["first", null], ["repair", 402]]);
  assert.deepEqual([first.report.trials[0].grade.valid, first.report.errors.writer_calls], [false, 1]);

  const writer = route(() => TICKET_REPLY);
  const { report } = await run(options(out, { resume: first.reportPath }), { loaded: { structured_output: writer, generation }, progress: () => undefined });
  // Only the repair was made again: the first reply was carried, refused again, and repaired.
  assert.equal(writer.inputs.length, 1);
  assert.deepEqual(report.trials[0].attempts.map((attempt) => `${attempt.kind}${attempt.carried ? " (carried)" : ""}`), ["first (carried)", "repair"]);
  assert.deepEqual([report.trials[0].grade.valid, report.resumed_from.carried_calls, report.errors.writer_calls], [true, 1, 0]);
});
