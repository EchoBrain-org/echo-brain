import { createHash } from "node:crypto";

/**
 * Judge calibration (spec section 5): the founder blind-grades a sample of
 * runs; the judge's numbers are used only when it agrees on at least 90% of
 * the same checks.
 */
export const CALIBRATION_BAR = 0.9;
export const CALIBRATION_SAMPLE_RUNS = 15;

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Yes/no checks the judge made on one run, keyed so a sheet can be matched back. */
export function judgeChecks(testCase, judge) {
  const checks = [];
  judge.needs.forEach((need, index) => checks.push({ id: `need:${index}`, question: `Does the plan ask for: "${need.expected}"?`, judge: need.covered }));
  judge.parts.forEach(part => {
    const requirement = testCase.parts.find(entry => entry.id === part.id)?.requirement ?? part.id;
    checks.push({ id: `established:${part.id}`, question: `Do the items research read establish: "${requirement}"?`, judge: part.established_by_research });
    if (part.answer_correct !== "not_applicable") checks.push({ id: `answer:${part.id}`, question: `Does the answer state this correctly, supported by its citations: "${requirement}"?`, judge: part.answer_correct === "yes" });
  });
  judge.gaps.forEach((gap, index) => checks.push({ id: `gap:${index}`, question: `Does the answer or plan report this expected gap: "${gap.gap}"?`, judge: gap.reported }));
  judge.must_not.forEach((entry, index) => checks.push({ id: `must_not:${index}`, question: `Does the answer or plan violate: "${entry.rule}"?`, judge: entry.violated }));
  judge.verdicts.forEach((verdict, index) => checks.push({ id: `verdict:${index}`, question: `Is "${verdict.finding}" judged correctly as ${testCase.verdicts?.[index]?.expected ?? "?"}?`, judge: verdict.matches_expected }));
  if (testCase.trigger === "ask") checks.push({ id: "false_abstention", question: "Does the answer decline or say not found where the read items establish the fact?", judge: judge.false_abstention });
  return checks;
}

/** Deterministic spread across cases: every k-th judged run. */
export function sampleRuns(graded, size) {
  const judged = graded.filter(entry => entry.judge !== null && entry.judge !== undefined).sort((left, right) => `${left.checks.case_id}/${left.checks.trial}`.localeCompare(`${right.checks.case_id}/${right.checks.trial}`));
  if (judged.length <= size) return judged;
  const step = judged.length / size;
  return Array.from({ length: size }, (_, index) => judged[Math.floor(index * step)]);
}

function calibrationSample(graded) {
  return sampleRuns(graded.runs, CALIBRATION_SAMPLE_RUNS);
}

const runKey = entry => `${entry.checks.case_id}\u0000${entry.checks.trial}\u0000${entry.checks.budget}`;
const sampleProblem = sample => {
  if (sample.length < CALIBRATION_SAMPLE_RUNS) return `calibration needs ${CALIBRATION_SAMPLE_RUNS} judged runs; found ${sample.length}`;
  if (new Set(sample.map(runKey)).size !== sample.length) return "calibration sample has duplicate run identities";
  return null;
};

/** Binds a blind sheet and its result to one exact grading pass. */
export function calibrationBinding(graded, sample = calibrationSample(graded)) {
  return {
    schema_version: 1,
    judge_model: graded.judge_model ?? null,
    graded_sha256: digest(graded),
    sample_sha256: digest(sample),
    sample_runs: sample.length,
  };
}

/** The blind sheet: questions and run references, never the judge's answers. */
export function blindSheet(sample, casesById) {
  return sample.map(entry => ({
    case_id: entry.checks.case_id, trial: entry.checks.trial, budget: entry.checks.budget,
    checks: judgeChecks(casesById.get(entry.checks.case_id), entry.judge).map(({ id, question }) => ({ id, question, founder: null })),
  }));
}

const blindRows = rows => rows.map(row => ({
  case_id: row.case_id,
  trial: row.trial,
  budget: row.budget,
  checks: row.checks.map(check => ({ id: check.id, question: check.question })),
}));

/** The exact 15-run blind sheet a founder may fill without seeing judge answers. */
export function calibrationSheet(graded, casesById) {
  const sample = calibrationSample(graded);
  const problem = sampleProblem(sample);
  if (problem !== null) throw new Error(problem);
  return {
    schema_version: 2,
    calibration: calibrationBinding(graded, sample),
    instructions: `Open each saved run, answer every check true or false without opening graded.json, then score this exact ${CALIBRATION_SAMPLE_RUNS}-run sheet before reporting.`,
    rows: blindSheet(sample, casesById),
  };
}

export function agreement(sheet, sample, casesById) {
  let total = 0; let agreed = 0; let unanswered = 0;
  const disagreements = [];
  for (const row of sheet) {
    const graded = sample.find(entry => entry.checks.case_id === row.case_id && entry.checks.trial === row.trial && entry.checks.budget === row.budget);
    if (graded === undefined) throw new Error(`calibration row ${row.case_id}/${row.trial} has no graded run`);
    const judged = new Map(judgeChecks(casesById.get(row.case_id), graded.judge).map(check => [check.id, check.judge]));
    for (const check of row.checks) {
      if (typeof check.founder !== "boolean") { unanswered += 1; continue; }
      total += 1;
      if (judged.get(check.id) === check.founder) agreed += 1;
      else disagreements.push({ case_id: row.case_id, trial: row.trial, id: check.id, question: check.question, founder: check.founder, judge: judged.get(check.id) });
    }
  }
  const rate = total === 0 ? null : agreed / total;
  const sufficient_sample = sampleProblem(sample) === null;
  return { sample_runs: sample.length, sufficient_sample, total, agreed, unanswered, rate, trusted: sufficient_sample && rate !== null && unanswered === 0 && rate >= CALIBRATION_BAR, disagreements };
}

/** Score only an unmodified sheet generated from the current graded.json. */
export function scoreCalibration(sheet, graded, casesById) {
  const sample = calibrationSample(graded);
  const problem = sampleProblem(sample);
  if (problem !== null) throw new Error(problem);
  const binding = calibrationBinding(graded, sample);
  if (sheet?.schema_version !== 2 || !same(sheet.calibration, binding)) throw new Error("calibration sheet does not match the current graded.json; generate a new sheet");
  const expected = blindSheet(sample, casesById);
  if (!same(blindRows(sheet.rows ?? []), blindRows(expected))) throw new Error("calibration sheet rows do not match the current judge checks");
  return { schema_version: 2, calibration: binding, ...agreement(sheet.rows, sample, casesById) };
}

/** Report-time gate: an old, short, failed, or unrelated result cannot enable judge metrics. */
export function calibrationStatus(graded, result) {
  if (graded.judge_model === null || graded.judge_model === undefined) return { trusted: false, status: "not_requested", reason: "graded without a judge" };
  const sample = calibrationSample(graded);
  const problem = sampleProblem(sample);
  if (problem !== null) return { trusted: false, status: "untrusted", reason: problem };
  const binding = calibrationBinding(graded, sample);
  if (result?.schema_version !== 2 || !same(result.calibration, binding)) return { trusted: false, status: "untrusted", reason: "missing, stale, or unrelated calibration result" };
  const validCounts = Number.isSafeInteger(result.sample_runs) && result.sample_runs === CALIBRATION_SAMPLE_RUNS &&
    Number.isSafeInteger(result.total) && result.total > 0 && Number.isSafeInteger(result.agreed) && result.agreed >= 0 && result.agreed <= result.total &&
    Number.isSafeInteger(result.unanswered) && result.unanswered === 0;
  const validRate = typeof result.rate === "number" && Number.isFinite(result.rate) && result.rate >= 0 && result.rate <= 1 && result.rate === result.agreed / result.total;
  if (result.trusted !== true || result.sufficient_sample !== true || !validCounts || !validRate || result.rate < CALIBRATION_BAR) return { trusted: false, status: "untrusted", reason: "founder agreement did not meet the 90% calibration bar" };
  return { trusted: true, status: "trusted", sample_runs: result.sample_runs, rate: result.rate };
}
