/**
 * Aggregates graded runs (spec section 5). Each case weighs the same; its
 * runs are averaged first. Unknowns stay null rather than counting as passes.
 */

const mean = values => (values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length);
const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** One graded run: code checks plus an optional judge result. */
export function runScores(graded) {
  const { checks, judge } = graded;
  // A run that failed or was rejected delivered nothing: it scores zero on quality, never "unknown".
  if (checks.status !== "completed") {
    return { status: checks.status, complete_and_supported: false, planner_needs_covered: 0, tools_found: 0, tools_read: 0, tools_handed: 0, research_established: 0,
      ...(checks.trigger === "ask" ? { writer_parts_correct: 0 } : {}) };
  }
  const parts = checks.parts.length;
  const ask = checks.trigger === "ask";
  const judged = judge ?? null;
  const established = judged === null ? null : judged.parts.filter(part => part.established_by_research).length;
  const answerCorrect = judged === null || !ask ? null : judged.parts.filter(part => part.answer_correct === "yes").length;
  const verdictsCorrect = judged === null || judged.verdicts.length === 0 ? null : rate(judged.verdicts.filter(verdict => verdict.matches_expected).length, judged.verdicts.length);
  const violations = judged === null ? null : judged.must_not.filter(entry => entry.violated).length;
  const complete = checks.leaks.length > 0 ? false : judged === null ? null
    : established === parts && violations === 0 &&
      (!ask || (answerCorrect === parts && judged.unsupported_claims === 0 && !judged.false_abstention)) &&
      (verdictsCorrect === null || verdictsCorrect === 1);
  return {
    status: "completed",
    planner_needs_covered: judged === null ? null : rate(judged.needs.filter(need => need.covered).length, judged.needs.length),
    planner_invented_needs: judged === null ? null : judged.invented_needs.length,
    tools_found: rate(checks.coverage.found, parts),
    tools_read: rate(checks.coverage.read, parts),
    tools_handed: rate(checks.coverage.handed, parts),
    research_established: established === null ? null : rate(established, parts),
    verdicts_correct: verdictsCorrect,
    writer_parts_correct: answerCorrect === null ? null : rate(answerCorrect, parts),
    writer_unsupported_claims: judged === null || !ask ? null : judged.unsupported_claims,
    writer_false_abstention: judged === null || !ask ? null : judged.false_abstention,
    gaps_reported: judged === null || judged.gaps.length === 0 ? null : rate(judged.gaps.filter(gap => gap.reported).length, judged.gaps.length),
    must_not_violations: violations,
    leaks: checks.leaks.length,
    noise_handed: checks.noise_handed,
    distractors_handed: checks.distractors.handed,
    complete_and_supported: complete,
    stop_reason: checks.stop.reason,
    elapsed_ms: checks.cost.elapsed_ms,
    rounds: checks.cost.rounds,
    model_calls: checks.cost.model_calls,
  };
}

const METRICS = [
  "planner_needs_covered", "planner_invented_needs", "tools_found", "tools_read", "tools_handed", "research_established",
  "verdicts_correct", "writer_parts_correct", "writer_unsupported_claims", "gaps_reported", "must_not_violations",
  "leaks", "noise_handed", "distractors_handed", "elapsed_ms", "rounds", "model_calls",
];

/** Per-case means of each metric (unknown runs excluded), then means across cases. */
export function aggregate(gradedRuns) {
  const byCase = new Map();
  for (const graded of gradedRuns) {
    const key = `${graded.checks.case_id}\u0000${graded.checks.budget}`;
    const list = byCase.get(key) ?? [];
    list.push({ graded, scores: runScores(graded) });
    byCase.set(key, list);
  }
  const cases = [...byCase.values()].map(runs => {
    const { checks } = runs[0].graded;
    const completed = runs.filter(run => run.scores.status === "completed");
    // Quality metrics include failed runs (as zeros); cost metrics describe completed runs only.
    const metrics = Object.fromEntries(METRICS.map(metric => {
      const values = runs.map(run => run.scores[metric]).filter(value => typeof value === "number");
      return [metric, mean(values)];
    }));
    const verdicts = runs.map(run => run.scores.complete_and_supported);
    return {
      case_id: checks.case_id, split: checks.split, trigger: checks.trigger, budget: checks.budget, runs: runs.length,
      failed_runs: runs.length - completed.length,
      rejected_at_ingress: runs.filter(run => run.scores.status === "rejected_at_ingress").length,
      false_abstention_runs: completed.filter(run => run.scores.writer_false_abstention === true).length,
      complete_in_every_run: verdicts.includes(false) ? false : verdicts.includes(null) ? null : true,
      stop_reasons: completed.reduce((counts, run) => ({ ...counts, [run.scores.stop_reason]: (counts[run.scores.stop_reason] ?? 0) + 1 }), {}),
      ...metrics,
    };
  });
  const summary = Object.fromEntries(METRICS.map(metric => [metric, mean(cases.map(entry => entry[metric]).filter(value => typeof value === "number"))]));
  const known = cases.filter(entry => entry.complete_in_every_run !== null);
  return {
    cases,
    summary: {
      ...summary,
      cases: cases.length,
      cases_complete_in_every_run: known.filter(entry => entry.complete_in_every_run).length,
      cases_with_unknown_completion: cases.length - known.length,
      runs_failed: cases.reduce((total, entry) => total + entry.failed_runs, 0),
      runs_rejected_at_ingress: cases.reduce((total, entry) => total + entry.rejected_at_ingress, 0),
      runs_with_leaks: gradedRuns.filter(graded => graded.checks.leaks?.length > 0).length,
      median_elapsed_ms: median(gradedRuns.filter(graded => graded.checks.cost).map(graded => graded.checks.cost.elapsed_ms)),
    },
  };
}

const percent = value => (value === null ? "—" : `${Math.round(value * 100)}%`);
const number = value => (value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(1));

/** A plain report a person can read; identity lines bind it to the run. */
export function markdownReport(identity, report) {
  const s = report.summary;
  const lines = [
    `# Research loop evaluation — ${identity.split} at ${identity.state}`,
    "",
    `Source ${identity.source_sha ?? "unknown"} · model ${identity.model ?? "unknown"} · world ${identity.world} · judge ${identity.judge ?? "none"} · graded ${identity.graded_at}`,
    "",
    "| Stage | Measure | Value |",
    "| --- | --- | --- |",
    `| Planner | expected needs covered | ${percent(s.planner_needs_covered)} |`,
    `| Planner | invented needs per run | ${number(s.planner_invented_needs)} |`,
    `| Tools | required items found | ${percent(s.tools_found)} |`,
    `| Tools | required items read in full | ${percent(s.tools_read)} |`,
    `| Tools | required items handed over | ${percent(s.tools_handed)} |`,
    `| Research | parts established | ${percent(s.research_established)} |`,
    `| Verdicts | Sweep verdicts correct | ${percent(s.verdicts_correct)} |`,
    `| Writer | parts correct in the answer | ${percent(s.writer_parts_correct)} |`,
    `| Writer | unsupported claims per run | ${number(s.writer_unsupported_claims)} |`,
    `| Writer | gaps reported | ${percent(s.gaps_reported)} |`,
    `| Safety | runs with restricted leaks | ${s.runs_with_leaks} |`,
    `| Cost | median time | ${s.median_elapsed_ms === null ? "—" : `${Math.round(s.median_elapsed_ms / 100) / 10} s`} |`,
    `| Cost | rounds / model calls per run | ${number(s.rounds)} / ${number(s.model_calls)} |`,
    "",
    `Complete and supported in every run: **${s.cases_complete_in_every_run} of ${s.cases} cases** (${s.cases_with_unknown_completion} unknown). Failed runs: ${s.runs_failed}; rejected at ingress: ${s.runs_rejected_at_ingress}.`,
    "",
    "| Case | Trigger | Budget | Runs | Found | Read | Handed | Established | Answer | Complete | Stops |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${entry.runs}${entry.failed_runs > 0 ? ` (${entry.failed_runs} failed)` : ""} | ${percent(entry.tools_found)} | ${percent(entry.tools_read)} | ${percent(entry.tools_handed)} | ${percent(entry.research_established)} | ${percent(entry.writer_parts_correct)} | ${entry.complete_in_every_run === null ? "—" : entry.complete_in_every_run ? "yes" : "no"} | ${Object.entries(entry.stop_reasons).map(([reason, count]) => `${reason} ${count}`).join(", ")} |`),
    "",
  ];
  return lines.join("\n");
}
