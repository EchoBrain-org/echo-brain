import { isDeepStrictEqual } from "node:util";

/**
 * Reach and cost of one research result (research tool contract v1, "Testing open-ended questions"): which
 * collections research looked at, which calls were refused and which refusals it sent again, the items a date filter
 * could not check, and how many rounds it took. Everything is read from the research result a run saves, which a
 * LangSmith trace's research run also holds, never from an answer's wording; only "unchecked items stated" reads the
 * answer, for the count code writes into it.
 */

/** Research finishes within this many rounds, the finish step included (research tool contract v1). */
export const REACH_MAX_ROUNDS = 4;

/**
 * Every collection an open-ended key names, with the source ids and catalog selectors a call or an item names it by. A
 * connected tool's containers are named by the selector their connector declares, and an item by the container it cites.
 */
const COLLECTIONS = Object.freeze({
  meetings: { sources: ["meetings", "meeting"] },
  documents: { sources: ["documents", "document"] },
  follow_ups: { sources: ["follow_ups"], kinds: ["follow_up"] },
  projects: { sources: ["projects"], kinds: ["project"] },
  people: { sources: ["people"], kinds: ["person"] },
  tools: { sources: ["tools"], kinds: ["tool"] },
  tickets: { sources: ["tickets", "jira"], kinds: ["ticket"] },
  pages: { sources: ["pages", "confluence"], kinds: ["page"] },
  slack: { sources: ["slack"], kinds: ["slack_message"] },
  jira_projects: { sources: ["jira_projects"], container: "jira_project" },
  confluence_spaces: { sources: ["confluence_spaces"], container: "confluence_space" },
  slack_channels: { sources: ["slack_channels"], container: "slack_channel" },
});
export const REACH_COLLECTIONS = Object.freeze(Object.keys(COLLECTIONS));
/** The time windows a key may require each collection to be looked at in, relative to the day the question was asked. */
export const REACH_WINDOWS = Object.freeze(["yesterday", "this_week", "last_week"]);

const words = value => String(value ?? "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);

/** The collection a call's `source` names, or null for a source no key names. */
export function collectionOfSource(source) {
  const normalized = words(source).join("_");
  return Object.entries(COLLECTIONS).find(([, entry]) => entry.sources.includes(normalized))?.[0] ?? null;
}

/** The collection an item research came across belongs to: a container by what it cites, else by kind, else by source. */
export function collectionOfItem(item) {
  if (item?.kind === "tool_container") {
    const container = item.citation?.container;
    return Object.entries(COLLECTIONS).find(([, entry]) => entry.container !== undefined && entry.container === container)?.[0] ?? null;
  }
  const byKind = Object.entries(COLLECTIONS).find(([, entry]) => entry.kinds?.includes(item?.kind));
  return byKind !== undefined ? byKind[0] : collectionOfSource(item?.source);
}

/** Every read research planned, in order: each round's actions with their round number. Finish reads nothing. */
function actionsOf(research) {
  return (research?.rounds ?? []).flatMap(round => (round.actions ?? []).map(action => ({ ...action, round: round.round }))).filter(action => action.tool !== "finish");
}

/**
 * Why a call was refused, or null when it was not. A refusal is a result that names refused filters (one outcome per
 * filter, research tool contract v1) or carries an error (the form refusals took before it). A notice that left a list
 * unavailable is not a refusal: the contract replaces it with an unchecked count.
 */
export function refusalOf(action) {
  const result = action?.result ?? {};
  const outcomes = result.filters;
  const refused = outcomes !== null && typeof outcomes === "object" ? Object.entries(outcomes).filter(([, how]) => how === "refused").map(([name]) => name).sort() : [];
  if (refused.length > 0) return `refused ${refused.join(", ")}`;
  return typeof result.error === "string" && result.error.length > 0 ? result.error : null;
}

/** What a call reads: its collection (or its raw source, or every source) for search and list, the item for open. */
function targetOf(action) {
  if (action.tool === "open") return `item:${String(action.args?.id ?? "").trim()}`;
  const source = action.args?.source;
  if (source === undefined) return "every source";
  return collectionOfSource(source) ?? `source:${words(source).join("_")}`;
}

/** Refused calls in order, each marked when an earlier call met the same refusal on the same target. */
function refusals(research) {
  const seen = new Set();
  return actionsOf(research).flatMap(action => {
    const reason = refusalOf(action);
    if (reason === null) return [];
    const key = `${action.tool}\u0000${targetOf(action)}\u0000${reason}`;
    const repeated = seen.has(key);
    seen.add(key);
    return [{ round: action.round, tool: action.tool, target: targetOf(action), reason, repeated }];
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
function shiftDay(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** A required window's first and last day, inclusive, for a question asked on `today`. Weeks start on Monday. */
export function windowOf(kind, today) {
  if (!DAY.test(today ?? "")) throw new Error("a window needs the day the question was asked");
  if (kind === "yesterday") { const day = shiftDay(today, -1); return { since: day, until: day }; }
  const monday = shiftDay(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  if (kind === "this_week") return { since: monday, until: today };
  if (kind === "last_week") return { since: shiftDay(monday, -7), until: shiftDay(monday, -1) };
  throw new Error(`unknown window ${kind}`);
}

/** A call's since or until as a day: a date, or an age the loop accepts (7d, 2w, 1m), counted back from `today`. */
function callDay(value, today) {
  const text = String(value).trim().toLowerCase();
  if (DAY.test(text)) return text;
  const age = /^(\d{1,3})\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)$/u.exec(text);
  if (age === null) return null;
  return shiftDay(today, -Number(age[1]) * (age[2].startsWith("w") ? 7 : age[2].startsWith("m") ? 30 : 1));
}

/** Whether a call's dates hold the whole window: it gives a bound, and neither bound cuts the window. */
function covers(args, window, today) {
  if (args?.since === undefined && args?.until === undefined) return false;
  const since = args.since === undefined ? undefined : callDay(args.since, today);
  const until = args.until === undefined ? undefined : callDay(args.until, today);
  if (since === null || until === null) return false;
  return (since === undefined || since <= window.since) && (until === undefined || until >= window.until);
}

/**
 * The days the question may have been asked on: the run's start in UTC, which an evaluation's Ask reads (it sends no
 * time zone), and in each time zone research's lists were read in, which a person's Ask sends.
 */
export function askedDays(startedAt, research) {
  const at = Date.parse(startedAt ?? "");
  if (!Number.isFinite(at)) return [];
  const zones = new Set((research?.lists ?? []).map(list => list.filter?.time_zone).filter(zone => typeof zone === "string"));
  const days = new Set([new Date(at).toISOString().slice(0, 10)]);
  for (const zone of zones) {
    try { days.add(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)); } catch { /* an unknown zone adds no day */ }
  }
  return [...days];
}

/**
 * The collections research looked at. A search or list counts for the collection it names, unless it was refused (it
 * read nothing); a search of every source counts for the collections of the items it returned. With a window, only
 * calls whose dates hold it count. Without one, every item research came across counts too (a link it followed, a
 * search hit), except items loaded before round 1, which research never asked for.
 */
export function collectionsLookedAt(research, { window, days = [] } = {}) {
  const looked = new Set();
  const byId = new Map((research?.items ?? []).map(item => [item.id, item]));
  for (const action of actionsOf(research)) {
    if ((action.tool !== "search" && action.tool !== "list") || refusalOf(action) !== null) continue;
    if (window !== undefined && !days.some(day => covers(action.args, windowOf(window, day), day))) continue;
    if (action.args?.source !== undefined) {
      const collection = collectionOfSource(action.args.source);
      if (collection !== null) looked.add(collection);
      continue;
    }
    for (const id of action.result?.items ?? []) {
      const collection = collectionOfItem(byId.get(id));
      if (collection !== null) looked.add(collection);
    }
  }
  if (window === undefined) {
    for (const item of research?.items ?? []) {
      const collection = item.preloaded === true ? null : collectionOfItem(item);
      if (collection !== null) looked.add(collection);
    }
  }
  return looked;
}

const uncheckedCount = value => (Number.isSafeInteger(value?.unchecked?.count) && value.unchecked.count > 0 ? value.unchecked.count : 0);

/**
 * The unchecked counts research met: items a date filter could not test because they do not record its date (research
 * tool contract v1). Each list that carries one counts once. A list's count comes from its own result; if no list
 * carries one, each call that does stands for the list of its source.
 */
function uncheckedReports(research) {
  const lists = (research?.lists ?? []).filter(list => uncheckedCount(list) > 0);
  if (lists.length > 0) return lists.map(list => ({ count: uncheckedCount(list), list }));
  const seen = new Map();
  for (const action of actionsOf(research)) {
    const count = uncheckedCount(action.result);
    if (count === 0) continue;
    const key = JSON.stringify([action.tool, targetOf(action), action.args?.since ?? null, action.args?.until ?? null, action.args?.date_field ?? null]);
    seen.set(key, { count, source: collectionOfSource(action.args?.source) });
  }
  return [...seen.values()];
}

/** Lists research's plan relied on: those a found which_items need cites (ADR-0041). */
export function reliedLists(research) {
  return new Set((research?.plan ?? []).flatMap(part => part.needs ?? []).filter(need => need.status === "found" && need.kind === "which_items").flatMap(need => need.evidence ?? []));
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
/** Whether the answer's text (its statements and gaps) states a count, in digits or, up to twenty, in words. */
function statesCount(answer, count) {
  const text = (answer?.parts ?? []).flatMap(part => [...(part.statements ?? []).map(statement => statement.text), part.gap]).filter(value => typeof value === "string").join("\n").toLowerCase();
  if (new RegExp(`(?<![\\d.,])${count}(?![\\d.,]?\\d)`, "u").test(text)) return true;
  return count < NUMBER_WORDS.length && new RegExp(`\\b${NUMBER_WORDS[count]}\\b`, "u").test(text);
}

/**
 * Whether the answer states the unchecked items of every list it uses: a list the plan relied on, or one the answer
 * cites a member of. Null when it uses none that has any, so nothing needed stating. Code writes that count into the
 * answer (research tool contract v1), so the answer states it when its text holds the number.
 */
export function uncheckedStated(research, answer) {
  const relied = reliedLists(research);
  const cited = new Set((research?.items ?? []).filter(item => (answer?.citations ?? []).some(entry => isDeepStrictEqual(entry.citation, item.citation))).map(item => item.id));
  const reliedSources = new Set((research?.lists ?? []).filter(list => relied.has(list.id)).map(list => collectionOfSource(list.source)));
  const used = uncheckedReports(research).filter(report => report.list !== undefined
    ? relied.has(report.list.id) || report.list.members.some(id => cited.has(id))
    : report.source !== null && reliedSources.has(report.source));
  if (used.length === 0) return null;
  return answer !== null && answer !== undefined && used.every(report => statesCount(answer, report.count));
}

/**
 * What one trace counts (research tool contract v1): rounds, calls per round, collections looked at, refused calls and
 * repeated refusals, unchecked items, and the replies research rejected. Counted for every completed run.
 */
export function traceCounts(research) {
  const rounds = research?.rounds ?? [];
  const refused = refusals(research);
  const perRound = rounds.map(round => (round.actions ?? []).filter(action => action.tool !== "finish").length);
  return {
    rounds: rounds.length,
    stop_reason: research?.stop?.reason ?? null,
    calls: perRound.reduce((total, value) => total + value, 0),
    calls_per_round: perRound,
    collections: [...collectionsLookedAt(research)].sort(),
    refused: refused.length,
    repeated_refusals: refused.filter(entry => entry.repeated).length,
    refusal_reasons: [...new Set(refused.map(entry => `${entry.tool} ${entry.target}: ${entry.reason}`))],
    unchecked: uncheckedReports(research).reduce((total, report) => total + report.count, 0),
    notices: research?.coverage?.notices?.length ?? 0,
    rejected_steps: rounds.reduce((total, round) => total + (round.rejected?.length ?? 0), 0),
  };
}

/**
 * A run that delivered no research scores zero on every reach and cost check. It used no list, so whether it stated
 * unchecked items is unknown, never a pass: it meets nothing.
 */
export function failedReach(testCase) {
  return {
    expected: testCase.reach.collections, window: testCase.reach.window ?? null, max_rounds: REACH_MAX_ROUNDS,
    looked_at: [], missing: testCase.reach.collections.map(group => [group].flat().join(" or ")),
    looked_at_every_collection: false, no_repeated_refusal: false, unchecked_stated: null, within_rounds: false, met: false,
  };
}

/**
 * The four reach and cost checks of an open-ended case (research tool contract v1): every collection holding part of
 * the answer was looked at (an entry listing several is met by any of them, and a key's window by calls that hold
 * it); no refused call was sent again; unchecked items were stated; research finished within its rounds.
 */
export function reachChecks(testCase, run) {
  const research = run?.result?.research;
  if (run?.outcome !== "completed" || run.result?.status !== "completed" || research === undefined) return failedReach(testCase);
  const { collections, window } = testCase.reach;
  const looked = collectionsLookedAt(research, { window, days: window === undefined ? [] : askedDays(run.started_at, research) });
  const missing = collections.map(group => [group].flat()).filter(group => !group.some(name => looked.has(name))).map(group => group.join(" or "));
  const counts = traceCounts(research);
  const stated = uncheckedStated(research, run.result.ask?.response ?? null);
  const checks = {
    looked_at_every_collection: missing.length === 0,
    no_repeated_refusal: counts.repeated_refusals === 0,
    unchecked_stated: stated,
    within_rounds: research.stop?.reason === "finished" && counts.rounds <= REACH_MAX_ROUNDS,
  };
  return {
    expected: collections, window: window ?? null, max_rounds: REACH_MAX_ROUNDS, looked_at: [...looked].sort(), missing, ...checks,
    met: checks.looked_at_every_collection && checks.no_repeated_refusal && checks.unchecked_stated !== false && checks.within_rounds,
  };
}
