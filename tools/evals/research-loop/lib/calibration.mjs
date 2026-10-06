/**
 * Judge calibration (spec section 5): the founder blind-grades a sample of
 * runs; the judge's numbers are used only when it agrees on at least 90% of
 * the same checks.
 */
export const CALIBRATION_BAR = 0.9;

/** Yes/no checks the judge made on one run, keyed so a sheet can be matched back. */
export function judgeChecks(testCase, judge) {
  const checks = [];
  judge.needs.forEach((need, index) => checks.push({ id: `need:${index}`, question: `Does the plan ask for: "${need.expected}"?`, judge: need.covered }));
  judge.parts.forEach(part => {
    const requirement = testCase.parts.find(entry => entry.id === part.id)?.requirement ?? part.id;
    checks.push({ id: `established:${part.id}`, question: `Do the items research read establish: "${requirement}"?`, judge: part.established_by_research });
    if (part.answer_correct !== "not_applicable") checks.push({ id: `answer:${part.id}`, question: `Does the answer state this correctly, supported by its citations: "${requirement}"?`, judge: part.answer_correct === "yes" });
  });
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

/** The blind sheet: questions and run references, never the judge's answers. */
export function blindSheet(sample, casesById) {
  return sample.map(entry => ({
    case_id: entry.checks.case_id, trial: entry.checks.trial, budget: entry.checks.budget,
    checks: judgeChecks(casesById.get(entry.checks.case_id), entry.judge).map(({ id, question }) => ({ id, question, founder: null })),
  }));
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
  return { total, agreed, unanswered, rate, trusted: rate !== null && unanswered === 0 && rate >= CALIBRATION_BAR, disagreements };
}
