import { isDeepStrictEqual } from "node:util";
import { itemMatches, leakMarkers, matching, meetingIndex, satisfying, sectionCovered } from "./match.mjs";
import { failedReach, reachChecks, traceCounts } from "./reach.mjs";

/**
 * Code checks for one saved run (spec section 5): what research found, read,
 * cited and handed over for each required part, and for a list part whether
 * the answer names its whole list (ADR-0041); for an Ask run, its plan's
 * needs by declared kind, and whether they are the kinds its case expects;
 * restricted leaks; noise; stop and cost; the impact card or sweep result
 * against its key. Meaning-level checks belong to the judge. A sweep run
 * always carries its verdict counts (`sweep`), so failed runs count toward
 * the findings.
 */
export function codeChecks(testCase, run, dataset) {
  const meetings = meetingIndex(dataset.additions);
  // List parts are counted on every run, so a failed run still scores zero on naming its lists.
  const listParts = testCase.parts.filter(part => part.type === "list").length;
  const base = {
    case_id: testCase.id, split: testCase.split, trigger: testCase.trigger, trial: run.trial, budget: run.budget, ...(listParts === 0 ? {} : { list_parts: listParts }),
    ...(testCase.key_status === undefined ? {} : { key_status: testCase.key_status }),
    // The open-ended family (research tool contract v1): its cases carry reach and cost keys.
    ...(testCase.family === undefined ? {} : { family: testCase.family }),
  };
  // A run that delivered nothing scores zero: a sweep's findings all count as wrong, and a plan it never wrote declares no kind.
  const nothing = { parts: [], leaks: [], stop: null, cost: null, ...(testCase.trigger === "sweep" ? { sweep: gradeSweep(testCase, { findings: [] }) } : {}), ...(testCase.expected_kinds === undefined ? {} : { declared_kinds: false }),
    ...(testCase.reach === undefined ? {} : { reach: failedReach(testCase) }) };
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
  const answer = ask?.response ?? null;
  const lists = listIndex(research);
  // Ask's writer also sees every list research read as rows without text (ADR-0041). A row carries an item's title,
  // dates, status and owner only, so it hands over a part of those types, never other content, and is never noise.
  // The writer answers such a part by selecting the member: code states its row facts, citing the row.
  const textHanded = item => handedIds.has(item.id) && (item.read_in_full || item.text !== undefined);
  const parts = testCase.parts.map(part => {
    if (part.type === "list") return listPart(part, items, meetings, lists, handedIds, answer);
    // Found: research discovered a supporting item (a page counts once discovered).
    const discovered = part.evidence.flatMap(ref => matching(items, ref, meetings));
    // Read, cited and handed need the item that actually carries the evidence (for a page, its section).
    const supporting = [...new Set(part.evidence.flatMap(ref => satisfying(items, ref, meetings)))];
    return {
      id: part.id, type: part.type,
      found: discovered.length > 0,
      read: supporting.some(item => item.read_in_full),
      cited_by_plan: supporting.some(item => item.cited_by_plan),
      handed: supporting.some(item => textHanded(item) || (ROW_FACT_PARTS.has(part.type) && handedIds.has(item.id))),
      item_ids: [...new Set([...discovered, ...supporting].map(item => item.id))],
    };
  });
  const supportingIds = new Set(parts.flatMap(part => part.item_ids));
  const distractorItems = items.filter(item => (testCase.distractors ?? []).some(ref => itemMatches(item, ref, meetings)));
  const noise = items.filter(item => textHanded(item) && !supportingIds.has(item.id)).map(item => item.id);
  // An answer cites what research read in full, or a member's row of a list research read (ADR-0041): a list supports which items exist.
  const answer_citation_violations = (answer?.citations ?? []).flatMap((entry, item_index) =>
    items.some(item => (item.read_in_full || lists.of(item.id).length > 0) && isDeepStrictEqual(item.citation, entry.citation)) ? [] : [{ item_index, label: entry.label }]);
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
      ...(listParts === 0 ? {} : { lists_named: parts.filter(part => part.named === true).length }),
    },
    leaks,
    distractors: { found: distractorItems.length, handed: distractorItems.filter(textHanded).length },
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
    ...(testCase.trigger === "ask" ? { kinds: kindsOf(research.plan) } : {}),
    ...(testCase.expected_kinds === undefined ? {} : { declared_kinds: declaredKinds(research.plan, testCase.expected_kinds) }),
    // What every trace counts, and an open-ended case's reach and cost checks (research tool contract v1).
    trace: traceCounts(research),
    ...(testCase.reach === undefined ? {} : { reach: reachChecks(testCase, run) }),
  };
}

/** The kinds an Ask need declares (ADR-0041). */
const NEED_KINDS = ["which_items", "which_say", "content"];

/** A run's final plan's needs by declared kind; a need saved without one (a run from before ADR-0041) is `missing`. */
function kindsOf(plan) {
  const kinds = { which_items: 0, which_say: 0, content: 0, missing: 0 };
  for (const need of plan.flatMap(part => part.needs)) kinds[NEED_KINDS.includes(need.kind) ? need.kind : "missing"] += 1;
  return kinds;
}

/** Whether the kinds a run's final plan declares, as a set, are the case's: a need without a kind is content, as Ask reads it. */
function declaredKinds(plan, expected) {
  const declared = [...new Set(plan.flatMap(part => part.needs.map(need => NEED_KINDS.includes(need.kind) ? need.kind : "content")))].sort();
  return isDeepStrictEqual(declared, [...expected].sort());
}

/** Part types a list member's row can carry (ADR-0041): dates, owner and status are row facts. */
const ROW_FACT_PARTS = new Set(["date", "owner", "status"]);

/**
 * The lists a run's research read (ADR-0041; a run from before it has none): the lists holding each item as a member,
 * and those a found which_items need of the final plan cites by id, which Ask's renderer states. A need without a kind
 * (a run saved earlier) is content, whose list ids carry no meaning.
 */
function listIndex(research) {
  const all = Array.isArray(research.lists) ? research.lists : [];
  const of = id => all.filter(list => list.members.includes(id));
  const stated = new Set(research.plan.flatMap(part => part.needs.filter(need => need.status === "found" && need.kind === "which_items").flatMap(need => need.evidence)));
  return { of, relied: list => stated.has(list.id) };
}

/**
 * A list part scores on the whole list (ADR-0041, addition 7): each measure holds only when it holds for every member,
 * so naming some members earns nothing. Found: research came across every member. Read: a complete list research
 * read holds every member. Cited: the plan cites every member, or a found which_items need cites a list holding it.
 * Handed: the writer saw every member. Named: every member is named by some statement (`statementOf`), or, for a list
 * longer than the 25 names an answer gives, a statement code wrote ends "and N more" and the members it names plus N
 * are exactly the list. A member the key names by its meeting (a meeting record) has no name here: the research result
 * titles a meeting record by its meeting's label, which every record of the meeting shares, while code names it by a
 * line of its own text (its list label), which the result does not carry. So no statement names it, and the judge's
 * yes cannot count for a list holding one.
 */
function listPart(part, items, meetings, lists, handedIds, answer) {
  const members = part.evidence.map(ref => matching(items, ref, meetings));
  const every = holds => members.every(found => found.some(holds));
  const names = members.map((found, index) => part.evidence[index].meeting === undefined ? found.map(item => nameOf(item.title)) : []);
  const statements = (answer?.parts ?? []).flatMap(value => value.statements).map(statement => statementOf(statement, members, names, items, lists, answer));
  const named = (_, index) => statements.some(statement => statement.named.has(index));
  // Code's statement counts the members it does not name, from ECHO's own list (ADR-0041, addition 5); each
  // statement is read alone, so members another statement names by id never count twice.
  const more = statements.some(statement => {
    const counted = /; and (\d+) more\.$/u.exec(statement.text);
    return statement.code && counted !== null && statement.named.size > 0 && statement.named.size + Number(counted[1]) === members.length;
  });
  return {
    id: part.id, type: part.type,
    found: every(() => true),
    read: every(item => lists.of(item.id).some(list => list.complete === true)),
    cited_by_plan: every(item => item.cited_by_plan || lists.of(item.id).some(lists.relied)),
    handed: every(item => handedIds.has(item.id)),
    named: answer !== null && (members.every(named) || more),
    // For reading a run, never for its score.
    members: members.length,
    members_named: members.filter(named).length,
    item_ids: [...new Set(members.flat().map(item => item.id))],
  };
}

/**
 * What one statement of an answer names (ADR-0041): the members of a list part it cites, by any of their items, whose
 * names its text holds (`namesIn`), however the statement came to cite them. The response does not say which statements
 * code wrote, so a statement never names a member by citing it alone: a writer's sentence citing 8 rows, as one on
 * follow-ups' text may, names the 4 its text names. `code`: the statement reads as one code wrote, which alone may end
 * "and N more" (addition 5): it cites only list members' rows, and its text names every item it cites, as code's
 * statements do (a name never covers a member the statement does not cite).
 */
function statementOf(statement, members, names, items, lists, answer) {
  const resolved = statement.citation_indexes.map(index => items.filter(item => isDeepStrictEqual(item.citation, answer.citations[index]?.citation)));
  const cited = new Set(resolved.flat());
  const own = [...cited].map(item => nameOf(item.title));
  const found = namesIn(statement.text, [...names.flat(), ...own]);
  const rows = resolved.length > 0 && resolved.every(value => value.length > 0 && value.every(item => lists.of(item.id).length > 0));
  return {
    text: statement.text,
    code: rows && own.every(name => found.has(name.key)),
    named: new Set(members.flatMap((value, index) => value.some(item => cited.has(item)) && names[index].some(name => found.has(name.key)) ? [index] : [])),
  };
}

/** Characters of a label in a code-written name (AGENTIC_LIST_NAME_CHARS_V1). */
const NAME_CHARS = 120;
/** One line, as code writes a label in a name. */
function oneLine(value) {
  return String(value ?? "").normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * An item's name as code writes it in a list statement (agenticListStatementV1, groupNames): its title on one line,
 * cut to 120 characters, compared ignoring case. A cut title matches on what stands before its ellipsis, which code's
 * cut name and the whole title both hold (`cut`). Members that share a label share a name, as code merges them.
 */
function nameOf(title) {
  const characters = [...oneLine(title)];
  const cut = characters.length > NAME_CHARS;
  const text = (cut ? characters.slice(0, NAME_CHARS - 1).join("").trimEnd() : characters.join("")).toLowerCase();
  return { key: `${cut ? "cut" : "whole"}:${text}`, text, cut };
}

const STARTS_WORD = /^[\p{L}\p{N}]/u;
const ENDS_WORD = /[\p{L}\p{N}]$/u;
/**
 * The keys of `names` (nameOf) that a statement's text holds, ignoring case: each as a phrase of its own, never inside a
 * longer word (an uncut name ends where a word ends), and longest first, each match taken out of the text, so a name
 * that is part of a longer one the text holds ("PRD" in "PRD v2") is not named by it.
 */
function namesIn(text, names) {
  let rest = oneLine(text).toLowerCase();
  const found = new Set();
  const unique = [...new Map(names.filter(name => name.text.length > 0).map(name => [name.key, name])).values()].sort((left, right) => right.text.length - left.text.length);
  for (const name of unique) {
    const opens = STARTS_WORD.test(name.text);
    const closes = !name.cut && ENDS_WORD.test(name.text);
    for (let at = rest.indexOf(name.text); at !== -1; at = rest.indexOf(name.text, at + 1)) {
      const end = at + name.text.length;
      if ((opens && ENDS_WORD.test(rest.slice(0, at))) || (closes && STARTS_WORD.test(rest.slice(end)))) continue;
      found.add(name.key);
      rest = `${rest.slice(0, at)}${"\u0000".repeat(name.text.length)}${rest.slice(end)}`;
    }
  }
  return found;
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
