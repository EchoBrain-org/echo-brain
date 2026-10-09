import { isDeepStrictEqual } from "node:util";
import { itemMatches, leakMarkers, matching, meetingIndex, satisfying, sectionCovered } from "./match.mjs";

/**
 * Code checks for one saved run (spec section 5): what research found, read,
 * cited and handed over for each required part; restricted leaks; noise;
 * stop and cost; the impact card or sweep result against its key.
 * Meaning-level checks belong to the judge. A sweep run always carries its
 * verdict counts (`sweep`), so failed runs count toward the findings.
 */
export function codeChecks(testCase, run, dataset) {
  const meetings = meetingIndex(dataset.additions);
  const base = { case_id: testCase.id, split: testCase.split, trigger: testCase.trigger, trial: run.trial, budget: run.budget };
  // A run that delivered nothing scores zero: a sweep's findings all count as wrong.
  const nothing = { parts: [], leaks: [], stop: null, cost: null, ...(testCase.trigger === "sweep" ? { sweep: gradeSweep(testCase, { findings: [] }) } : {}) };
  if (run.outcome !== "completed" || run.result?.status !== "completed") {
    return { ...base, status: run.outcome === "rejected" ? "rejected_at_ingress" : "failed", error: run.error ?? run.result?.error ?? null, ...nothing };
  }
  const rendered = run.result.rendered ?? null;
  const research = run.result.research;
  const items = research.items;
  const ask = run.result.ask ?? null;
  // Leaks first: whatever else a completed run lacks, it released what research returned.
  const leaks = [];
  for (const ref of testCase.never_appears ?? []) {
    for (const item of matching(items, ref, meetings)) leaks.push({ kind: "item", ref, item_id: item.id, title: item.title });
  }
  // The goal is the case's own text; everything else in the run came from research or a renderer (the card, or a sweep's lines and citations).
  const scanned = JSON.stringify({ research: { ...research, goal: undefined }, ask, rendered });
  for (const marker of leakMarkers(dataset.additions)) if (scanned.toLowerCase().includes(marker.toLowerCase())) leaks.push({ kind: "marker", marker });
  // An approved record's result is its card, a sweep's its sweep result: a run without one delivered nothing to grade (it predates the rendering endpoint), but its leaks count.
  if (rendered === null && (testCase.trigger === "approved_record" || testCase.trigger === "sweep")) {
    const missing = testCase.trigger === "sweep" ? "sweep runs must return the sweep result" : "approved-record runs must return the impact card";
    return { ...base, status: "failed", error: { code: "no_rendered_result", message: `${missing}; run them again on the current endpoint` }, ...nothing, leaks };
  }
  const card = testCase.trigger === "approved_record" ? rendered : null;
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
  const distractorItems = items.filter(item => (testCase.distractors ?? []).some(ref => itemMatches(item, ref, meetings)));
  const noise = [...handedIds].filter(id => !supportingIds.has(id));
  const answer = ask?.response ?? null;
  const answer_citation_violations = (answer?.citations ?? []).flatMap((entry, item_index) =>
    items.some(item => item.read_in_full && isDeepStrictEqual(item.citation, entry.citation)) ? [] : [{ item_index, label: entry.label }]);
  return {
    ...base,
    status: "completed",
    stop: research.stop,
    cost: research.cost,
    rounds: research.rounds.length,
    plan_needs: research.plan.reduce((total, part) => total + part.needs.length, 0),
    expected_gaps: testCase.gaps,
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
    answer_citations: { total: answer?.citations.length ?? 0, resolved_to_read: (answer?.citations.length ?? 0) - answer_citation_violations.length, unresolved: answer_citation_violations.length },
    answer_citation_violations,
    ask: answer === null ? null : {
      outcome: answer.outcome,
      statements: answer.parts.reduce((total, part) => total + part.statements.length, 0),
      citations: answer.citations.length,
      gap: answer.parts.map(part => part.gap).filter(value => typeof value === "string"),
    },
    card: card === null ? null : cardChecks(testCase, card, items, meetings),
    ...(testCase.trigger === "sweep" ? { sweep: { status: rendered.status, ...gradeSweep(testCase, rendered) } } : {}),
  };
}

/** The sweep result's verdicts in the key's terms; a null verdict (not assessed) has none. */
const SWEEP_VERDICTS = new Map([["landed", "landed"], ["still_open", "not_landed"], ["changed", "not_landed"], ["unreadable", "no_evidence"]]);

/**
 * A sweep result against its key (open items and Home v1, section 6): each
 * key verdict is compared with the result's entry for the same finding_index,
 * so order does not matter. A null verdict is wrong and not assessed, whatever
 * the result's status; a finding with no entry, or more than one, is wrong.
 */
export function gradeSweep(key, result) {
  const graded = key.verdicts.map(({ expected }, index) => {
    const entries = result.findings.filter(entry => entry.finding_index === index);
    const verdict = entries.length === 1 ? entries[0].verdict : undefined;
    return { right: SWEEP_VERDICTS.get(verdict) === expected, not_assessed: verdict === null };
  });
  return { right: graded.filter(entry => entry.right).length, total: graded.length, not_assessed: graded.filter(entry => entry.not_assessed).length };
}

/**
 * The impact card against its key (research trigger contract v1, section 6):
 * which key items it lists, with one of the key's relations and its owner; and
 * invented items (not from research, or unconnected to the record in the key)
 * or people (not the owner in the details of the item they are attached to).
 * Gaps reported are the judge's.
 *
 * A row is credited to a key entry through an item holding that entry's own
 * heading (a ticket is its own heading). An item holding several keyed
 * headings is credited to those whose relation the row gives, or, giving
 * none, to the first of them as wrong. Only when no row is credited does a
 * continuation chunk count: the chunk after the heading, holding no keyed
 * heading of its own. So a chunk is judged against the section it carries.
 */
function cardChecks(testCase, card, items, meetings) {
  const itemOf = index => items.find(item => isDeepStrictEqual(item.citation, card.citations[index]?.citation));
  const labelOf = index => card.citations[index]?.label ?? null;
  const rows = card.affected.map(row => ({ row, item: itemOf(row.citation_index) }));
  // Connected to the record: its own meeting and every item the key cites (affected items are part evidence too).
  const connected = [...testCase.parts.flatMap(part => part.evidence), ...["decision", "action", "rationale", "transcript"].map(item => ({ meeting: testCase.record.meeting, item }))];
  const invented = [
    ...card.decided.filter(entry => itemOf(entry.citation_index) === undefined).map(entry => ({ kind: "item", label: labelOf(entry.citation_index) })),
    ...rows.filter(({ item }) => item === undefined || !connected.some(ref => itemMatches(item, ref, meetings))).map(({ row }) => ({ kind: "item", label: labelOf(row.citation_index) })),
    ...[...new Set([
      ...rows.filter(({ row, item }) => row.owner !== undefined && item?.attributes?.owner !== row.owner).map(({ row }) => row.owner),
      ...card.people.map(person => person.name).filter(name => !rows.some(({ row, item }) => row.owner === name && item?.attributes?.owner === name)),
    ])].map(name => ({ kind: "person", name })),
  ];
  const found = rows.filter(({ item }) => item !== undefined);
  const accepts = (entry, relation) => [entry.relation].flat().includes(relation);
  const held = item => testCase.affected.filter(entry => entry.refs.some(ref => itemMatches(item, ref, meetings) && sectionCovered(item, ref)));
  const credited = new Map(found.map(value => {
    const entries = held(value.item);
    const fitting = entries.filter(entry => accepts(entry, value.row.relation));
    return [value, entries.length <= 1 ? entries : fitting.length > 0 ? fitting : entries.slice(0, 1)];
  }));
  const affected = testCase.affected.map(entry => {
    const heading = found.filter(value => credited.get(value).includes(entry));
    const carriers = new Set(entry.refs.flatMap(ref => satisfying(items, ref, meetings)));
    const listing = (heading.length > 0 ? heading : found.filter(({ item }) => carriers.has(item) && held(item).length === 0)).map(({ row }) => row);
    return {
      id: entry.id, listed: listing.length > 0,
      relation_correct: listing.length > 0 && listing.every(row => accepts(entry, row.relation)),
      owner_correct: listing.length > 0 && listing.every(row => (row.owner ?? null) === entry.owner),
    };
  });
  return {
    status: card.status,
    expected: affected.length,
    listed: affected.filter(entry => entry.listed).length,
    relations_correct: affected.filter(entry => entry.relation_correct).length,
    owners_correct: affected.filter(entry => entry.owner_correct).length,
    affected,
    invented,
    unconfirmed: card.unconfirmed.length,
  };
}
