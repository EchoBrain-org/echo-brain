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
      ...(checks.trigger === "ask" ? { writer_parts_correct: 0 } : {}), ...(checks.trigger === "approved_record" ? { card_items_listed: 0 } : {}) };
  }
  const parts = checks.parts.length;
  const ask = checks.trigger === "ask";
  // The impact card: relations and owners are judged on the key items it lists.
  const card = checks.card ?? null;
  const cardCorrect = card === null || (card.listed === card.expected && card.relations_correct === card.listed && card.owners_correct === card.listed);
  // The sweep result: every finding's verdict against the key.
  const sweep = checks.sweep ?? null;
  const sweepCorrect = sweep === null || sweep.right === sweep.total;
  const judged = judge ?? null;
  const established = judged === null ? null : judged.parts.filter(part => part.established_by_research).length;
  const answerCorrect = judged === null || !ask ? null : judged.parts.filter(part => part.answer_correct === "yes").length;
  const verdictsCorrect = judged === null || judged.verdicts.length === 0 ? null : rate(judged.verdicts.filter(verdict => verdict.matches_expected).length, judged.verdicts.length);
  const violations = judged === null ? null : judged.must_not.filter(entry => entry.violated).length;
  const gapsReported = judged === null ? null : judged.gaps.length === (checks.expected_gaps?.length ?? 0) && judged.gaps.every(gap => gap.reported);
  // Gaps are reported by the run's output: Ask's answer, the card, or (research only) the plan.
  const gapRate = judged === null || judged.gaps.length === 0 ? null : rate(judged.gaps.filter(gap => gap.reported).length, judged.gaps.length);
  const complete = checks.leaks.length > 0 || (checks.answer_citation_violations?.length ?? 0) > 0 || (card?.invented.length ?? 0) > 0 ? false : judged === null ? null
    : established === parts && violations === 0 &&
      (!ask || (answerCorrect === parts && judged.unsupported_claims === 0 && !judged.false_abstention)) &&
      cardCorrect && sweepCorrect && gapsReported &&
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
    gaps_reported: ask ? gapRate : null,
    card_items_listed: card === null ? null : rate(card.listed, card.expected),
    card_relations_correct: card === null ? null : rate(card.relations_correct, card.listed),
    card_owners_correct: card === null ? null : rate(card.owners_correct, card.listed),
    card_invented: card === null ? null : card.invented.length,
    card_gaps_reported: card === null ? null : gapRate,
    research_gaps_reported: ask || card !== null ? null : gapRate,
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
  "planner_needs_covered", "planner_invented_needs", "tools_found", "tools_read", "tools_handed", "research_established", "research_gaps_reported",
  "verdicts_correct", "writer_parts_correct", "writer_unsupported_claims", "gaps_reported",
  "card_items_listed", "card_relations_correct", "card_owners_correct", "card_invented", "card_gaps_reported", "must_not_violations",
  "leaks", "noise_handed", "distractors_handed", "elapsed_ms", "rounds", "model_calls",
];

const JUDGE_METRICS = [
  "planner_needs_covered", "planner_invented_needs", "research_established", "research_gaps_reported", "verdicts_correct",
  "writer_parts_correct", "writer_unsupported_claims", "writer_false_abstention", "gaps_reported", "card_gaps_reported", "must_not_violations",
];

/** Sums one count over entries that have it; null when none does (no sweep was graded). */
const tally = (entries, key) => (entries.length === 0 ? null : entries.reduce((sum, entry) => sum + entry[key], 0));

/**
 * Per-case means of each metric (unknown runs excluded), then means across
 * cases. Sweep verdicts are counted instead: right and findings over every
 * run of a case (a failed run's findings all wrong), then over all sweep cases.
 */
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
    const sweeps = runs.map(run => run.graded.checks.sweep).filter(sweep => sweep !== undefined);
    return {
      case_id: checks.case_id, split: checks.split, trigger: checks.trigger, budget: checks.budget, runs: runs.length,
      failed_runs: runs.length - completed.length,
      not_started: runs.filter(run => run.graded.checks.error?.code === "case_not_startable").length,
      rejected_at_ingress: runs.filter(run => run.scores.status === "rejected_at_ingress").length,
      false_abstention_runs: completed.filter(run => run.scores.writer_false_abstention === true).length,
      complete_in_every_run: verdicts.includes(false) ? false : verdicts.includes(null) ? null : true,
      stop_reasons: completed.reduce((counts, run) => ({ ...counts, [run.scores.stop_reason]: (counts[run.scores.stop_reason] ?? 0) + 1 }), {}),
      sweep_verdicts_right: tally(sweeps, "right"), sweep_findings: tally(sweeps, "total"), sweep_not_assessed: tally(sweeps, "not_assessed"),
      ...metrics,
    };
  });
  const summary = Object.fromEntries(METRICS.map(metric => [metric, mean(cases.map(entry => entry[metric]).filter(value => typeof value === "number"))]));
  const swept = cases.filter(entry => entry.sweep_findings !== null);
  const known = cases.filter(entry => entry.complete_in_every_run !== null);
  return {
    cases,
    summary: {
      ...summary,
      cases: cases.length,
      cases_complete_in_every_run: known.filter(entry => entry.complete_in_every_run).length,
      cases_with_unknown_completion: cases.length - known.length,
      runs_failed: cases.reduce((total, entry) => total + entry.failed_runs, 0),
      runs_not_started: cases.reduce((total, entry) => total + entry.not_started, 0),
      runs_rejected_at_ingress: cases.reduce((total, entry) => total + entry.rejected_at_ingress, 0),
      runs_with_leaks: gradedRuns.filter(graded => graded.checks.leaks?.length > 0).length,
      cards: gradedRuns.filter(graded => graded.checks.card).length,
      cards_not_assessed: gradedRuns.filter(graded => graded.checks.card?.status === "not_assessed").length,
      sweep_verdicts_right: tally(swept, "sweep_verdicts_right"), sweep_findings: tally(swept, "sweep_findings"), sweep_not_assessed: tally(swept, "sweep_not_assessed"),
      median_elapsed_ms: median(gradedRuns.filter(graded => graded.checks.cost).map(graded => graded.checks.cost.elapsed_ms)),
    },
  };
}

/** Preserve code checks while making every model-judge measure explicitly unknown. */
export function withholdJudgeMetrics(report) {
  const withhold = entry => ({ ...entry, ...Object.fromEntries(JUDGE_METRICS.map(metric => [metric, null])) });
  return { ...report, cases: report.cases.map(withhold), summary: withhold(report.summary) };
}

const percent = value => (value === null ? "—" : `${Math.round(value * 100)}%`);
const number = value => (value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(1));
const outOf = (right, findings) => (findings === null ? "—" : `${right} / ${findings}`);

/** A plain report a person can read; identity lines bind it to the run. Research-loop and renderer numbers are kept apart. */
export function markdownReport(identity, report) {
  const s = report.summary;
  const calibration = identity.judge_calibration;
  const rendered = report.cases.filter(entry => entry.trigger === "ask" || entry.trigger === "approved_record");
  const swept = report.cases.filter(entry => entry.trigger === "sweep");
  const lines = [
    `# Research loop evaluation — ${identity.split} at ${identity.state}`,
    "",
    `Source ${identity.source_sha ?? "unknown"} · model ${identity.model ?? "unknown"} · world ${identity.world} · judge ${identity.judge ?? "none"} · graded ${identity.graded_at}`,
    "",
    ...(calibration?.trusted
      ? [`Judge calibration: trusted (${calibration.sample_runs} blind runs, ${Math.round(calibration.rate * 1000) / 10}% founder agreement).`, ""]
      : identity.judge === null || identity.judge === undefined
        ? ["Judge calibration: not requested; code-check metrics only.", ""]
        : [`Judge calibration: ${calibration?.reason ?? "missing"}; judge-derived metrics are withheld. Code-check metrics remain below.`, ""]),
    `Complete and supported in every run: **${s.cases_complete_in_every_run} of ${s.cases} cases** (${s.cases_with_unknown_completion} unknown). Failed runs: ${s.runs_failed}, of which not started (the case's request could not be built): ${s.runs_not_started}; rejected at ingress: ${s.runs_rejected_at_ingress}.`,
    "",
    "Complete and supported needs research, the renderer's result and every safety check to be right.",
    "",
    "| Case | Trigger | Budget | Runs | Complete and supported |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${entry.runs}${entry.failed_runs > 0 ? ` (${entry.failed_runs} failed${entry.not_started > 0 ? `, ${entry.not_started} not started` : ""})` : ""} | ${entry.complete_in_every_run === null ? "—" : entry.complete_in_every_run ? "yes" : "no"} |`),
    "",
    "## Research loop",
    "",
    "Graded on the research result of every trigger.",
    "",
    "| Stage | Measure | Value |",
    "| --- | --- | --- |",
    `| Planner | expected needs covered | ${percent(s.planner_needs_covered)} |`,
    `| Planner | invented needs per run | ${number(s.planner_invented_needs)} |`,
    `| Tools | required items found | ${percent(s.tools_found)} |`,
    `| Tools | required items read in full | ${percent(s.tools_read)} |`,
    `| Tools | required items handed over | ${percent(s.tools_handed)} |`,
    `| Research | parts established | ${percent(s.research_established)} |`,
    `| Research | gaps reported in the plan (Sweep) | ${percent(s.research_gaps_reported)} |`,
    `| Verdicts | Sweep verdicts correct | ${percent(s.verdicts_correct)} |`,
    `| Safety | runs with restricted leaks | ${s.runs_with_leaks} |`,
    `| Cost | median time | ${s.median_elapsed_ms === null ? "—" : `${Math.round(s.median_elapsed_ms / 100) / 10} s`} |`,
    `| Cost | rounds / model calls per run | ${number(s.rounds)} / ${number(s.model_calls)} |`,
    "",
    "| Case | Trigger | Budget | Found | Read | Handed | Established | Stops |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${percent(entry.tools_found)} | ${percent(entry.tools_read)} | ${percent(entry.tools_handed)} | ${percent(entry.research_established)} | ${Object.entries(entry.stop_reasons).map(([reason, count]) => `${reason} ${count}`).join(", ")} |`),
    "",
    "## Renderers",
    "",
    "Graded on what each renderer made from the research it was given.",
    "",
    "| Renderer | Measure | Value |",
    "| --- | --- | --- |",
    `| Ask writer | parts correct in the answer | ${percent(s.writer_parts_correct)} |`,
    `| Ask writer | unsupported claims per run | ${number(s.writer_unsupported_claims)} |`,
    `| Ask writer | gaps reported | ${percent(s.gaps_reported)} |`,
    `| Impact card | affected items listed | ${percent(s.card_items_listed)} |`,
    `| Impact card | relations correct (listed items) | ${percent(s.card_relations_correct)} |`,
    `| Impact card | owners correct (listed items) | ${percent(s.card_owners_correct)} |`,
    `| Impact card | invented items or people per run | ${number(s.card_invented)} |`,
    `| Impact card | gaps reported | ${percent(s.card_gaps_reported)} |`,
    `| Impact card | cards not assessed (no-model fallback) | ${s.cards_not_assessed} of ${s.cards} |`,
    `| Sweep result | verdicts right / findings | ${outOf(s.sweep_verdicts_right, s.sweep_findings)} |`,
    `| Sweep result | findings not assessed | ${number(s.sweep_not_assessed)} |`,
    "",
    "| Case | Trigger | Budget | Answer | Listed | Relations | Owners | Invented |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rendered.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${percent(entry.writer_parts_correct)} | ${percent(entry.card_items_listed)} | ${percent(entry.card_relations_correct)} | ${percent(entry.card_owners_correct)} | ${number(entry.card_invented)} |`),
    "",
    "Sweep verdicts against the key: landed is landed, still open or changed is not landed, unreadable is no evidence. A verdict not assessed (null) is wrong, and so is every finding of a failed run.",
    "",
    "| Case | Budget | Runs | Verdicts right / findings | Not assessed |",
    "| --- | --- | --- | --- | --- |",
    ...swept.map(entry => `| ${entry.case_id} | ${entry.budget} | ${entry.runs} | ${outOf(entry.sweep_verdicts_right, entry.sweep_findings)} | ${number(entry.sweep_not_assessed)} |`),
    "",
  ];
  return lines.join("\n");
}
