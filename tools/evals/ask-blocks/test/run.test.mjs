import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ANSWER_LAYOUT_PROMPT } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { parseArgs, researchStep, run } from "../run.mjs";
import { loadCases } from "../grade.mjs";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072 };
const document = loadCases();

test("makes no request without an explicit run and a private credential file, and keeps its budget", () => {
  assert.throws(() => parseArgs(["--out", "/tmp/x"]), /no network request unless --run/u);
  const directory = mkdtempSync(join(tmpdir(), "ask-blocks-args-"));
  const credential = join(directory, "credential");
  writeFileSync(credential, "not read", { mode: 0o600 });
  const base = ["--run", "--credential-file", credential, "--out", join(directory, "out")];
  assert.throws(() => parseArgs([...base, "--catalogs", "today,today"]), /--catalogs must select known catalogs, each once/u);
  assert.throws(() => parseArgs([...base, "--cases", "no-such-case"]), /--cases must select known cases/u);
  assert.throws(() => parseArgs([...base, "--judge", "maybe"]), /--judge must be on or off/u);
  const options = parseArgs([...base, "--cases", "soak-owner", "--trials", "1"]);
  assert.deepEqual([options.trials, options.judge, options.concurrency], [1, true, 4]);
});

test("scripts research as one search, every item opened, then finish", () => {
  const steps = document.cases.find((entry) => entry.id === "ship-steps");
  assert.deepEqual(researchStep(steps, 1).actions, [{ tool: "search", args: { query: steps.research.query } }]);
  assert.equal(researchStep(steps, 2).actions.length, steps.items.length);
  assert.deepEqual(researchStep(steps, 3).actions, [{ tool: "finish", args: {} }]);
});

test("runs every catalog with one repair or retry, judges both orders, and keeps full traces", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-run-"));
  const seen = { balanced: 0, primitives: 0 };
  const replies = (input) => {
    const fields = Object.keys(input.schema.properties ?? {});
    if (fields.includes("ranks")) return { ranks: ["A", "B", "C", "D"].map((answer, at) => ({ answer, rank: at + 1, reason: "fixture" })) };
    if (fields.includes("sentences")) return { lists: [], tables: [], sentences: [{ text: "Priya Raman owns it.", evidence: ["E1"], form: "lead" }], not_found: [] };
    if (fields.includes("template")) return { template: { name: "fact", answer: [{ text: "Priya Raman owns it.", evidence: ["E1"] }] }, not_found: [] };
    if (fields.includes("blocks")) {
      seen.balanced += 1;
      // The first reply opens with prose, which the catalog refuses; the repair answers.
      return seen.balanced === 1 ? { blocks: [{ block: "text", sentences: [{ text: "Priya Raman owns it.", evidence: ["E1"] }] }], not_found: [] }
        : { blocks: [{ block: "answer", sentences: [{ text: "Priya Raman owns it.", evidence: ["E1"] }] }], not_found: [] };
    }
    seen.primitives += 1;
    if (seen.primitives === 1) throw new Error("fixture outage");
    return { root: "main", components: [{ id: "main", component: "Column", children: ["a"] }, { id: "a", component: "Text", variant: "body", text: "Priya Raman owns it.", evidence: ["E1"] }], not_found: [] };
  };
  const inputs = [];
  const structured = { async generate_with_observation(input) { inputs.push(input); return { value: replies(input), finish_reason: "stop", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 }, provider_latency_ms: 2 }; } };
  const options = { run: true, credentialFile: null, out, caseIds: ["soak-owner"], catalogIds: null, trials: 1, judge: true, concurrency: 1, timeoutMs: 20_000 };
  const { reportPath, report } = await run(options, { loaded: { structured_output: structured, generation }, progress: () => undefined });

  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(report.complete, false);
  assert.deepEqual(Object.fromEntries(report.trials.map((trial) => [trial.catalog, trial.attempts.map((attempt) => attempt.kind)])),
    { today: ["first"], templates: ["first"], balanced: ["first", "repair"], primitives: ["first", "retry"] });
  assert.ok(report.trials.every((trial) => trial.grade.valid && trial.grade.grounded && trial.grade.fit));
  const repair = report.trials.find((trial) => trial.catalog === "balanced").attempts[1];
  assert.match(JSON.parse(repair.user_prompt).validation_error, /blocks\[0\] must be the answer block/u);
  assert.equal(report.summary.balanced.repairs, 1);
  // The judge saw both orders; its rank is their mean, so A-to-D then D-to-A gives every catalog 2.5.
  assert.equal(report.judge["soak-owner"].length, 2);
  assert.deepEqual(Object.values(report.judge_ranks["soak-owner"]), [2.5, 2.5, 2.5, 2.5]);
  // Every writer call kept the catalog's own schema and output tokens; the prompts are in the report.
  assert.ok(inputs.filter((input) => !Object.hasOwn(input.schema.properties, "ranks")).every((input) => input.max_output_tokens === 3_000));
  const prompts = report.prompts["soak-owner"];
  assert.ok(JSON.parse(prompts.balanced.user_prompt).block_catalog.length === 7);
  assert.ok(report.system_prompts[prompts.today.system_prompt_sha256].endsWith(`\n\n${ANSWER_LAYOUT_PROMPT}`));
  assert.ok(!report.system_prompts[prompts.balanced.system_prompt_sha256].includes(ANSWER_LAYOUT_PROMPT));
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).kind, "echo-ask-blocks-evaluation-v1");
});
