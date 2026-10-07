#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { datasetProblems, loadDataset, substitutePerson } from "./lib/dataset.mjs";
import { CaseNotStartableError, discoverMeetings, exportBindings } from "./lib/bindings.mjs";
import { pollDeadlineMs, rejectedAtIngress, savedResult, startRequest } from "./lib/requests.mjs";
import { codeChecks } from "./lib/checks.mjs";
import { createOpenRouterJudge, judgeInput, parseJudge } from "./lib/judge.mjs";
import { aggregate, markdownReport, withholdJudgeMetrics } from "./lib/report.mjs";
import { calibrationSheet, calibrationStatus, scoreCalibration } from "./lib/calibration.mjs";
import { privateDirectory, readJson, savedRunFiles, writePrivateJson, writePrivateText } from "./lib/private-files.mjs";

const USAGE = `Research loop evaluation (docs/product/2026-10-06-research-loop-eval-v1.md)

  validate                                   Check the committed dataset's structure.
  bindings --export <dir> --project-id <prj_…> --test-person <name> --out <dir>
                                             Bind Jira/Confluence ids from the export and the approved
                                             THERM meetings found on staging (needs a signed-in CLI session).
  run --run --model <loop-model-id> --split development|holdout --state S0|S1 --out <dir> [--trials 3] [--only id,…] [--background-diagnostic]
                                             Run cases against the staging research endpoint, one at a time.
  grade --out <dir> (--judge-model <openrouter-slug> --judge-credential-file <path> | --no-judge)
  report --out <dir>
  calibrate sheet --out <dir>                 Write a blind 15-run sheet for the founder.
  calibrate score --out <dir>                 Compare the filled sheet with the judge.

Results stay under --out, which must be a private directory outside the repository.`;

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { parsed._.push(value); continue; }
    const name = value.slice(2);
    if (["run", "no-judge", "background-diagnostic"].includes(name)) { parsed[name] = true; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} needs a value`);
    parsed[name] = next; index += 1;
  }
  return parsed;
}

const repository = new URL("../../../", import.meta.url);

async function personClient() {
  const path = new URL("src/product/person-client/dist/client.js", repository);
  if (!existsSync(path)) throw new Error("build the person client first: npm run build");
  const { PersonClient } = await import(path.href);
  return new PersonClient({ home_directory: homedir() });
}

function sourceIdentity() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(); } catch { return null; }
}

function selectCases(dataset, split, state, only) {
  const ids = only === undefined ? undefined : new Set(only.split(","));
  const cases = dataset.cases.filter(entry => entry.split === split && entry.state === state && (ids === undefined || ids.has(entry.id)));
  if (ids !== undefined && cases.length !== ids.size) throw new Error("--only names a case that is not in this split and state");
  return cases;
}

async function bindings(args) {
  const out = privateDirectory(args.out);
  if (typeof args.export !== "string") throw new Error("--export is required");
  if (!/^prj_[0-9a-f-]{36}$/u.test(args["project-id"] ?? "")) throw new Error("--project-id must be the THERM ECHO project id");
  const dataset = loadDataset();
  const fromExport = exportBindings(readJson(join(args.export, "source-data.json")));
  const client = await personClient();
  const { meetings, missing } = await discoverMeetings(client, dataset.additions, args["project-id"]);
  const bound = { schema_version: 1, world: dataset.additions.world, test_person: args["test-person"], project_id: args["project-id"], ...fromExport, meetings };
  substitutePerson({}, bound.test_person);
  writePrivateJson(out, "bindings.json", bound);
  process.stdout.write(`bindings.json written; meetings bound: ${Object.keys(meetings).join(", ") || "none"}${missing.length === 0 ? "" : `; not found: ${missing.join(", ")} (fill them in by hand)`}\n`);
}

function runBase(testCase, budget, trial, model, started) {
  return { schema_version: 1, kind: "echo-research-loop-eval-run-v1", case_id: testCase.id, split: testCase.split, state: testCase.state, trigger: testCase.trigger, budget, trial, model, started_at: new Date(started).toISOString() };
}

async function runOne(client, testCase, request, budget, trial, model, pollMs) {
  const started = Date.now();
  const base = runBase(testCase, budget, trial, model, started);
  let receipt;
  try { receipt = await client.startResearchEval(request); }
  catch (error) {
    return { ...base, outcome: rejectedAtIngress(testCase, error) ? "rejected" : "error", error: { code: error?.code ?? error?.name ?? "error", message: String(error?.message ?? error).slice(0, 300) }, elapsed_ms: Date.now() - started };
  }
  const deadline = started + pollDeadlineMs(budget);
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    let result;
    try { result = await client.readResearchEval(receipt.run_id); }
    catch (error) { return { ...base, run_id: receipt.run_id, outcome: "error", error: { code: error?.code ?? "error", message: String(error?.message ?? error).slice(0, 300) }, elapsed_ms: Date.now() - started }; }
    if (result.status !== "running") return { ...base, run_id: receipt.run_id, outcome: result.status, result: savedResult(result), elapsed_ms: Date.now() - started };
    if (Date.now() > deadline) return { ...base, run_id: receipt.run_id, outcome: "error", error: { code: "poll_timeout", message: "The run did not finish before the polling deadline" }, elapsed_ms: Date.now() - started };
  }
}

async function run(args, { client: given, poll_ms: pollMs = 2_000 } = {}) {
  if (args.run !== true) throw new Error("pass --run to start model-backed runs on staging");
  if (typeof args.model !== "string" || args.model.length === 0 || args.model !== args.model.trim()) throw new Error("--model is required to record the evaluated loop model");
  const model = args.model;
  const out = privateDirectory(args.out);
  const bound = readJson(join(out, "bindings.json"));
  const dataset = loadDataset();
  const cases = selectCases(dataset, args.split, args.state, args.only).map(entry => substitutePerson(entry, bound.test_person));
  const trials = Number(args.trials ?? 3);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 5) throw new Error("--trials must be 1 to 5");
  const client = given ?? await personClient();
  for (const testCase of cases) {
    const budgets = [testCase.budget, ...(args["background-diagnostic"] === true && testCase.trigger === "ask" && testCase.budget === "live" ? ["background"] : [])];
    for (const budget of budgets) {
      for (let trial = 1; trial <= (budget === testCase.budget ? trials : 1); trial += 1) {
        let request; let unstartable;
        // A case whose request cannot be built (an unbound or unstartable citation) is recorded and counted, and the run goes on; any other error stops it.
        try { request = startRequest(testCase, bound, budget); } catch (error) { if (!(error instanceof CaseNotStartableError)) throw error; unstartable = error; }
        const saved = unstartable === undefined ? await runOne(client, testCase, request, budget, trial, model, pollMs)
          : { ...runBase(testCase, budget, trial, model, Date.now()), outcome: "error", error: { code: "case_not_startable", message: String(unstartable?.message ?? unstartable).slice(0, 300) }, elapsed_ms: 0 };
        writePrivateJson(out, `runs/${testCase.id}/${budget}-${trial}.json`, { ...saved, source_sha: sourceIdentity() });
        process.stdout.write(`${testCase.id} ${budget} #${trial}: ${saved.outcome}${saved.result?.research?.stop ? ` (${saved.result.research.stop.reason})` : ""}${saved.result?.rendered ? `, card ${saved.result.rendered.status}` : ""}\n`);
      }
    }
  }
}

async function grade(args) {
  const out = privateDirectory(args.out);
  const bound = readJson(join(out, "bindings.json"));
  const dataset = loadDataset();
  const cases = new Map(dataset.cases.map(entry => [entry.id, substitutePerson(entry, bound.test_person)]));
  const judge = args["no-judge"] === true ? null : await createOpenRouterJudge({ credential_file: args["judge-credential-file"], model: args["judge-model"] });
  const graded = [];
  for (const { file, sha256, run: saved } of savedRunFiles(out)) {
    const testCase = cases.get(saved.case_id);
    const checks = codeChecks(testCase, saved, dataset);
    let judged = null; let judgeError = null;
    if (judge !== null && checks.status === "completed") {
      try { judged = parseJudge(testCase, await judge(judgeInput(testCase, saved))); }
      catch (error) { judgeError = String(error?.message ?? error).slice(0, 300); }
    }
    graded.push({ run: { file, sha256 }, checks, judge: judged, judge_error: judgeError });
  }
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: judge === null ? null : args["judge-model"], graded_at: new Date().toISOString(), runs: graded });
  process.stdout.write(`graded ${graded.length} runs${judge === null ? " (code checks only)" : ""}\n`);
}

function report(args) {
  const out = privateDirectory(args.out);
  const graded = readJson(join(out, "graded.json"));
  const files = savedRunFiles(out);
  const runs = files.map(entry => entry.run);
  const models = new Set(runs.map(run => run.model).filter(model => typeof model === "string" && model.length > 0));
  if (models.size !== 1 || runs.some(run => typeof run.model !== "string" || run.model.length === 0)) throw new Error("report needs one evaluated loop model across all saved runs");
  const sources = new Set(runs.map(run => run.source_sha));
  if (sources.size !== 1 || runs.some(run => typeof run.source_sha !== "string" || run.source_sha.length === 0)) throw new Error("report needs one source commit across all saved runs");
  // Metrics come from graded.json and identity from the run files: they must be the same runs.
  if (!Array.isArray(graded.runs) || graded.runs.length !== files.length || graded.runs.some((entry, index) => entry?.run?.file !== files[index].file || entry.run.sha256 !== files[index].sha256)) {
    throw new Error("saved runs changed since grading; run grade again");
  }
  let calibration = null;
  try { if (existsSync(join(out, "calibration-result.json"))) calibration = readJson(join(out, "calibration-result.json")); } catch { calibration = null; }
  const judgeCalibration = calibrationStatus(graded, calibration);
  const reportRuns = judgeCalibration.trusted ? graded.runs : graded.runs.map(entry => ({ ...entry, judge: null }));
  const result = judgeCalibration.trusted ? aggregate(reportRuns) : withholdJudgeMetrics(aggregate(reportRuns));
  const identity = { split: [...new Set(graded.runs.map(entry => entry.checks.split))].join("+"), state: [...new Set(runs.map(entry => entry.state))].join("+"),
    source_sha: [...sources][0], model: [...models][0], world: "therm-v1", judge: graded.judge_model, judge_calibration: judgeCalibration, graded_at: graded.graded_at };
  writePrivateJson(out, "report.json", { identity, ...result });
  writePrivateText(out, "report.md", markdownReport(identity, result));
  process.stdout.write(`report.md written: ${result.summary.cases_complete_in_every_run} of ${result.summary.cases} cases complete and supported in every run${judgeCalibration.trusted ? "" : "; judge metrics withheld"}\n`);
}

function calibrate(args) {
  const out = privateDirectory(args.out);
  const graded = readJson(join(out, "graded.json"));
  const bound = readJson(join(out, "bindings.json"));
  const cases = new Map(loadDataset().cases.map(entry => [entry.id, substitutePerson(entry, bound.test_person)]));
  if (args.sample !== undefined) throw new Error("the calibration sample is fixed at 15 judged runs");
  if (args._[1] === "sheet") {
    const sheet = calibrationSheet(graded, cases);
    writePrivateJson(out, "calibration-sheet.json", sheet);
    process.stdout.write(`calibration-sheet.json written for ${sheet.rows.length} runs\n`);
    return;
  }
  if (args._[1] === "score") {
    const sheet = readJson(join(out, "calibration-sheet.json"));
    const result = scoreCalibration(sheet, graded, cases);
    writePrivateJson(out, "calibration-result.json", result);
    process.stdout.write(`judge agreement ${result.rate === null ? "unknown" : `${Math.round(result.rate * 1000) / 10}%`} over ${result.total} checks; ${result.trusted ? "trusted" : "not trusted"}\n`);
    return;
  }
  throw new Error("calibrate needs sheet or score");
}

/** `dependencies` lets tests stand in for the signed-in person client and the polling interval. */
export async function main(argv, dependencies = {}) {
  const args = options(argv);
  const command = args._[0];
  if (command === "validate") {
    const problems = datasetProblems(loadDataset());
    if (problems.length > 0) throw new Error(`dataset problems:\n${problems.join("\n")}`);
    process.stdout.write("dataset is structurally valid\n");
  } else if (command === "bindings") await bindings(args);
  else if (command === "run") await run(args, dependencies);
  else if (command === "grade") await grade(args);
  else if (command === "report") report(args);
  else if (command === "calibrate") calibrate(args);
  else process.stdout.write(`${USAGE}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
}
