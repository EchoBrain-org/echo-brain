import { itemMatches, leakMarkers, matching, satisfying } from "./match.mjs";

/**
 * Code checks for one saved run (spec section 5): what research found, read,
 * cited and handed over for each required part; restricted leaks; noise;
 * stop and cost. Meaning-level checks belong to the judge.
 */
export function codeChecks(testCase, run, dataset) {
  const meetings = new Map(dataset.additions.meetings.map(meeting => [meeting.id, meeting]));
  const base = { case_id: testCase.id, split: testCase.split, trigger: testCase.trigger, trial: run.trial, budget: run.budget };
  if (run.outcome !== "completed" || run.result?.status !== "completed") {
    return { ...base, status: run.outcome === "rejected" ? "rejected_at_ingress" : "failed", error: run.error ?? run.result?.error ?? null, parts: [], leaks: [], stop: null, cost: null };
  }
  const research = run.result.research;
  const items = research.items;
  const ask = run.result.ask ?? null;
  const handedIds = new Set(testCase.trigger === "ask" ? ask?.writer_evidence ?? [] : items.filter(item => item.cited_by_plan).map(item => item.id));
  const parts = testCase.parts.map(part => {
    // Found: research discovered a supporting item (a page counts once discovered).
    const discovered = part.evidence.flatMap(ref => matching(items, ref, meetings));
    // Read, cited and handed need the item that actually carries the evidence (for a page, its section).
    const supporting = [...new Set(part.evidence.flatMap(ref => satisfying(items, ref, meetings)))];
    return {
      id: part.id, type: part.type,
      found: discovered.length > 0,
      read: supporting.some(item => item.read_in_full),
      cited_by_plan: supporting.some(item => item.cited_by_plan),
      handed: supporting.some(item => handedIds.has(item.id)),
      item_ids: [...new Set([...discovered, ...supporting].map(item => item.id))],
    };
  });
  const supportingIds = new Set(parts.flatMap(part => part.item_ids));
  const leaks = [];
  for (const ref of testCase.never_appears ?? []) {
    for (const item of matching(items, ref, meetings)) leaks.push({ kind: "item", ref, item_id: item.id, title: item.title });
  }
  // The goal is the case's own text; everything else in the run came from research or the writer.
  const scanned = JSON.stringify({ research: { ...research, goal: undefined }, ask });
  for (const marker of leakMarkers(dataset.additions)) if (scanned.toLowerCase().includes(marker.toLowerCase())) leaks.push({ kind: "marker", marker });
  const distractorItems = items.filter(item => (testCase.distractors ?? []).some(ref => itemMatches(item, ref, meetings)));
  const noise = [...handedIds].filter(id => !supportingIds.has(id));
  const answer = ask?.response ?? null;
  return {
    ...base,
    status: "completed",
    stop: research.stop,
    cost: research.cost,
    rounds: research.rounds.length,
    plan_needs: research.plan.reduce((total, part) => total + part.needs.length, 0),
    parts,
    coverage: {
      required: parts.length,
      found: parts.filter(part => part.found).length,
      read: parts.filter(part => part.read).length,
      cited_by_plan: parts.filter(part => part.cited_by_plan).length,
      handed: parts.filter(part => part.handed).length,
    },
    leaks,
    distractors: { found: distractorItems.length, handed: distractorItems.filter(item => handedIds.has(item.id)).length },
    noise_handed: noise.length,
    ask: answer === null ? null : {
      outcome: answer.outcome,
      statements: answer.parts.reduce((total, part) => total + part.statements.length, 0),
      citations: answer.citations.length,
      gap: answer.parts.map(part => part.gap).filter(value => typeof value === "string"),
    },
  };
}
