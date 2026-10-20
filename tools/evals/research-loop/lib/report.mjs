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
  // A sweep has no planner (R77): no plan asks for needs or cites items, and nothing is handed on but what it read. Those
  // measures are not applicable to it, never zero.
  const planned = checks.trigger !== "sweep";
  // A run that failed or was rejected delivered nothing: it scores zero on quality, never "unknown".
  if (checks.status !== "completed") {
    return { status: checks.status, complete_and_supported: false, tools_found: 0, tools_read: 0, research_established: 0, ...(planned ? { planner_needs_covered: 0, tools_handed: 0 } : {}),
      ...(checks.declared_kinds === undefined ? {} : { planner_kinds_declared: 0 }),
      ...(checks.trigger === "ask" ? { writer_parts_correct: 0, ...((checks.list_parts ?? 0) > 0 ? { writer_lists_named: 0 } : {}) } : {}), ...(checks.trigger === "approved_record" ? { card_items_listed: 0 } : {}),
      ...(checks.reach === undefined ? {} : reachScores(checks.reach)) };
  }
  const parts = checks.parts.length;
  const ask = checks.trigger === "ask";
  // A list part counts only on its whole list (ADR-0041): established when a complete list holds every member, and
  // correct in the answer only when it names every member, whatever the judge says. Code decides; the judge may still refuse.
  const codePart = new Map(checks.parts.map(part => [part.id, part]));
  const wholeList = (id, holds) => codePart.get(id)?.type !== "list" || holds(codePart.get(id));
  const listParts = checks.parts.filter(part => part.type === "list");
  const listMissed = ask && listParts.some(part => part.named !== true);
  // The impact card: relations and owners are judged on the key items it lists.
  const card = checks.card ?? null;
  const cardCorrect = card === null || (card.listed === card.expected && card.relations_correct === card.listed && card.owners_correct === card.listed);
  // The sweep result: every finding's verdict against the key.
  const sweep = checks.sweep ?? null;
  const sweepCorrect = sweep === null || sweep.right === sweep.total;
  const judged = judge ?? null;
  const established = judged === null ? null : judged.parts.filter(part => part.established_by_research && wholeList(part.id, value => value.read)).length;
  const answerCorrect = judged === null || !ask ? null : judged.parts.filter(part => part.answer_correct === "yes" && wholeList(part.id, value => value.named === true)).length;
  const verdictsCorrect = judged === null || judged.verdicts.length === 0 ? null : rate(judged.verdicts.filter(verdict => verdict.matches_expected).length, judged.verdicts.length);
  const violations = judged === null ? null : judged.must_not.filter(entry => entry.violated).length;
  const gapsReported = judged === null ? null : judged.gaps.length === (checks.expected_gaps?.length ?? 0) && judged.gaps.every(gap => gap.reported);
  // Gaps are reported by the run's output: Ask's answer or the card. A Sweep case names none (it has no plan to report them in).
  const gapRate = judged === null || judged.gaps.length === 0 ? null : rate(judged.gaps.filter(gap => gap.reported).length, judged.gaps.length);
  const complete = checks.leaks.length > 0 || (checks.answer_citation_violations?.length ?? 0) > 0 || (card?.invented.length ?? 0) > 0 || listMissed ? false : judged === null ? null
    : established === parts && violations === 0 &&
      (!ask || (answerCorrect === parts && judged.unsupported_claims === 0 && !judged.false_abstention)) &&
      cardCorrect && sweepCorrect && gapsReported &&
      (verdictsCorrect === null || verdictsCorrect === 1);
  return {
    status: "completed",
    planner_needs_covered: judged === null || !planned ? null : rate(judged.needs.filter(need => need.covered).length, judged.needs.length),
    planner_invented_needs: judged === null || !planned ? null : judged.invented_needs.length,
    // A code check (ADR-0041): the plan's need kinds, as a set, are the ones its case names.
    planner_kinds_declared: checks.declared_kinds === undefined ? null : checks.declared_kinds ? 1 : 0,
    tools_found: rate(checks.coverage.found, parts),
    tools_read: rate(checks.coverage.read, parts),
    tools_handed: planned ? rate(checks.coverage.handed, parts) : null,
    research_established: established === null ? null : rate(established, parts),
    verdicts_correct: verdictsCorrect,
    writer_parts_correct: answerCorrect === null ? null : rate(answerCorrect, parts),
    writer_lists_named: ask ? rate(listParts.filter(part => part.named === true).length, listParts.length) : null,
    writer_unsupported_claims: judged === null || !ask ? null : judged.unsupported_claims,
    writer_false_abstention: judged === null || !ask ? null : judged.false_abstention,
    gaps_reported: ask ? gapRate : null,
    card_items_listed: card === null ? null : rate(card.listed, card.expected),
    card_relations_correct: card === null ? null : rate(card.relations_correct, card.listed),
    card_owners_correct: card === null ? null : rate(card.owners_correct, card.listed),
    card_invented: card === null ? null : card.invented.length,
    card_gaps_reported: card === null ? null : gapRate,
    must_not_violations: violations,
    leaks: checks.leaks.length,
    noise_handed: planned ? checks.noise_handed : null,
    distractors_handed: planned ? checks.distractors.handed : null,
    complete_and_supported: complete,
    stop_reason: checks.stop.reason,
    elapsed_ms: checks.cost.elapsed_ms,
    rounds: checks.cost.rounds,
    model_calls: checks.cost.model_calls,
    ...(checks.trace === undefined ? {} : traceScores(checks.trace)),
    ...(checks.reach === undefined ? {} : reachScores(checks.reach)),
  };
}

const flag = value => (value === null ? null : value ? 1 : 0);
/** An open-ended case's reach and cost checks as rates; unchecked items count only where some needed stating. */
function reachScores(reach) {
  return { reach_collections: flag(reach.looked_at_every_collection), reach_no_repeated_refusal: flag(reach.no_repeated_refusal),
    reach_unchecked_stated: flag(reach.unchecked_stated), reach_within_rounds: flag(reach.within_rounds), reach_met: flag(reach.met) };
}
/** What one trace counts beside its rounds (research tool contract v1); calls per round count the rounds that read, not finish. */
function traceScores(trace) {
  const reading = trace.calls_per_round.filter(calls => calls > 0).length;
  return { trace_calls_per_round: reading === 0 ? null : trace.calls / reading, trace_refused: trace.refused, trace_repeated_refusals: trace.repeated_refusals, trace_unchecked: trace.unchecked };
}

const METRICS = [
  "planner_needs_covered", "planner_invented_needs", "planner_kinds_declared", "tools_found", "tools_read", "tools_handed", "research_established",
  "verdicts_correct", "writer_parts_correct", "writer_lists_named", "writer_unsupported_claims", "gaps_reported",
  "card_items_listed", "card_relations_correct", "card_owners_correct", "card_invented", "card_gaps_reported", "must_not_violations",
  "leaks", "noise_handed", "distractors_handed", "elapsed_ms", "rounds", "model_calls",
  "trace_calls_per_round", "trace_refused", "trace_repeated_refusals", "trace_unchecked",
  "reach_collections", "reach_no_repeated_refusal", "reach_unchecked_stated", "reach_within_rounds", "reach_met",
];

const JUDGE_METRICS = [
  "planner_needs_covered", "planner_invented_needs", "research_established", "verdicts_correct",
  "writer_parts_correct", "writer_unsupported_claims", "writer_false_abstention", "gaps_reported", "card_gaps_reported", "must_not_violations",
];

/** Sums one count over entries that have it; null when none does (no sweep was graded). */
const tally = (entries, key) => (entries.length === 0 ? null : entries.reduce((sum, entry) => sum + entry[key], 0));
/** An Ask plan's needs by declared kind (ADR-0041); `missing` counts needs saved without one. */
const KIND_COUNTS = ["which_items", "which_say", "content", "missing"];

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
    const kinds = runs.map(run => run.graded.checks.kinds).filter(value => value !== undefined);
    const reached = runs.map(run => run.graded.checks.reach).filter(reach => reach !== undefined);
    return {
      case_id: checks.case_id, split: checks.split, trigger: checks.trigger, budget: checks.budget, runs: runs.length, key_status: checks.key_status ?? null,
      // The open-ended family (research tool contract v1): its reach and cost checks met in every run.
      family: checks.family ?? null, reach_met_in_every_run: reached.length === 0 ? null : reached.every(reach => reach.met),
      reach_missing: [...new Set(reached.flatMap(reach => reach.missing))],
      // Every completed run's needs, by declared kind, summed over the case's runs.
      kinds: kinds.length === 0 ? null : Object.fromEntries(KIND_COUNTS.map(kind => [kind, kinds.reduce((total, value) => total + value[kind], 0)])),
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
      cases_awaiting_key_confirmation: [...new Set(cases.filter(entry => entry.key_status === "awaiting_founder_confirmation").map(entry => entry.case_id))],
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
      open_ended_cases: [...new Set(cases.filter(entry => entry.reach_met_in_every_run !== null).map(entry => entry.case_id))].length,
      open_ended_cases_met_in_every_run: [...new Set(cases.filter(entry => entry.reach_met_in_every_run === true).map(entry => entry.case_id))].length,
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
  const asked = report.cases.filter(entry => entry.kinds !== null);
  const awaiting = s.cases_awaiting_key_confirmation;
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
    ...(awaiting.length === 0 ? [] : [`Keys drafted from the export and awaiting the founder's confirmation: ${awaiting.join(", ")}.`, ""]),
    "| Case | Trigger | Budget | Runs | Complete and supported |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${entry.runs}${entry.failed_runs > 0 ? ` (${entry.failed_runs} failed${entry.not_started > 0 ? `, ${entry.not_started} not started` : ""})` : ""} | ${entry.complete_in_every_run === null ? "—" : entry.complete_in_every_run ? "yes" : "no"} |`),
    "",
    "## Research loop",
    "",
    "Graded on the research result of every trigger. A sweep has no planner, so the planner and handed-over measures leave Sweep cases out (— in their rows). A list part counts only on its whole list: found when research came across every member, read when a complete list holds every member, handed over when the writer saw every member.",
    "",
    "| Stage | Measure | Value |",
    "| --- | --- | --- |",
    `| Planner | expected needs covered | ${percent(s.planner_needs_covered)} |`,
    `| Planner | invented needs per run | ${number(s.planner_invented_needs)} |`,
    `| Planner | need kinds as the case expects (code check) | ${percent(s.planner_kinds_declared)} |`,
    `| Tools | required items found | ${percent(s.tools_found)} |`,
    `| Tools | required items read in full | ${percent(s.tools_read)} |`,
    `| Tools | required items handed over | ${percent(s.tools_handed)} |`,
    `| Research | parts established | ${percent(s.research_established)} |`,
    `| Verdicts | Sweep verdicts correct | ${percent(s.verdicts_correct)} |`,
    `| Safety | runs with restricted leaks | ${s.runs_with_leaks} |`,
    `| Cost | median time | ${s.median_elapsed_ms === null ? "—" : `${Math.round(s.median_elapsed_ms / 100) / 10} s`} |`,
    `| Cost | rounds / model calls per run | ${number(s.rounds)} / ${number(s.model_calls)} |`,
    "",
    "| Case | Trigger | Budget | Found | Read | Handed | Established | Stops |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${percent(entry.tools_found)} | ${percent(entry.tools_read)} | ${percent(entry.tools_handed)} | ${percent(entry.research_established)} | ${Object.entries(entry.stop_reasons).map(([reason, count]) => `${reason} ${count}`).join(", ")} |`),
    "",
    "Each Ask plan's needs by declared kind (ADR-0041), over the case's completed runs. \"As expected\" is the code check for a case that names the kinds its plan should declare.",
    "",
    "| Case | Budget | which_items | which_say | content | no kind | As expected |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...asked.map(entry => `| ${entry.case_id} | ${entry.budget} | ${KIND_COUNTS.map(kind => entry.kinds[kind]).join(" | ")} | ${percent(entry.planner_kinds_declared)} |`),
    "",
    "## Renderers",
    "",
    "Graded on what each renderer made from the research it was given.",
    "",
    "| Renderer | Measure | Value |",
    "| --- | --- | --- |",
    `| Ask writer | parts correct in the answer | ${percent(s.writer_parts_correct)} |`,
    `| Ask writer | lists named in full (code check) | ${percent(s.writer_lists_named)} |`,
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
    "A list part is correct in the answer only when the answer names every member of its list; naming some earns nothing.",
    "",
    "| Case | Trigger | Budget | Answer | Listed | Relations | Owners | Invented | Lists named |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rendered.map(entry => `| ${entry.case_id} | ${entry.trigger} | ${entry.budget} | ${percent(entry.writer_parts_correct)} | ${percent(entry.card_items_listed)} | ${percent(entry.card_relations_correct)} | ${percent(entry.card_owners_correct)} | ${number(entry.card_invented)} | ${percent(entry.writer_lists_named)} |`),
    "",
    "The sweep result's own verdicts, checked by code against the key: landed is landed, still open or changed is not landed, unreadable is no evidence. A verdict not assessed (null) is wrong, and so is every finding of a failed run. \"Sweep verdicts correct\" under Research loop is a different measure: the judge's reading of the items research read.",
    "",
    "| Case | Budget | Runs | Verdicts right / findings | Not assessed |",
    "| --- | --- | --- | --- | --- |",
    ...swept.map(entry => `| ${entry.case_id} | ${entry.budget} | ${entry.runs} | ${outOf(entry.sweep_verdicts_right, entry.sweep_findings)} | ${number(entry.sweep_not_assessed)} |`),
    "",
    ...reachSection(report),
  ];
  return lines.join("\n");
}

/** Reach and cost (research tool contract v1): the open-ended family's four checks, and what every case's traces count. */
function reachSection(report) {
  const s = report.summary;
  const counted = report.cases.filter(entry => typeof entry.trace_refused === "number" || entry.reach_met_in_every_run !== null);
  if (counted.length === 0) return [];
  return [
    "## Reach and cost",
    "",
    "Graded on what research reached and what it spent, never on the answer's wording (research tool contract v1). An open-ended case meets them when every collection holding part of its answer was looked at (within its time window, when it names one), no refused call was sent again, unchecked items were stated wherever its answer used a list that had them, and research finished within its rounds (4 unless the case says otherwise).",
    "",
    `Open-ended cases meeting reach and cost in every run: **${s.open_ended_cases_met_in_every_run} of ${s.open_ended_cases}**.`,
    "",
    "| Check | Value |",
    "| --- | --- |",
    `| every collection holding part of the answer looked at | ${percent(s.reach_collections)} |`,
    `| no refused call sent again | ${percent(s.reach_no_repeated_refusal)} |`,
    `| unchecked items stated, where the answer used them | ${percent(s.reach_unchecked_stated)} |`,
    `| research finished within its rounds | ${percent(s.reach_within_rounds)} |`,
    "",
    "What each case's traces count, over its completed runs, then each check over all its runs (a failed run meets none).",
    "",
    "| Case | Budget | Rounds | Calls per round | Refused | Repeated refusals | Unchecked | Looked at all | No repeat | Unchecked stated | Within rounds | Not looked at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...counted.map(entry => `| ${entry.case_id} | ${entry.budget} | ${number(entry.rounds)} | ${number(entry.trace_calls_per_round)} | ${number(entry.trace_refused)} | ${number(entry.trace_repeated_refusals)} | ${number(entry.trace_unchecked)} | ${percent(entry.reach_collections)} | ${percent(entry.reach_no_repeated_refusal)} | ${percent(entry.reach_unchecked_stated)} | ${percent(entry.reach_within_rounds)} | ${entry.reach_missing.join(", ") || "—"} |`),
    "",
  ];
}
