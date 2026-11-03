/**
 * Deterministic grading for the Ask block evaluation (README.md, "Measures" and "Pre-registered rules"). Each trial is
 * graded from its reply as its catalog reads it into common blocks, against the evidence the writer was given. The
 * founder's and the judge's ranks are summarized here too; neither is a model call.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validatePersonQueryText } from "@echo-brain/organization-api";
import { ITEM_KINDS, nonEmptyStrings, says, wordIndex, words } from "../shared/ask-cases.mjs";
import { CATALOG_IDS } from "./catalogs.mjs";

export const CASES_FILE = new URL("./cases.json", import.meta.url);
export const CASE_COUNT = 15;
export const TRIALS = 3;
export const SHAPES = Object.freeze(["single", "prose", "parallel", "ordered", "grid", "sequence", "profile", "verbatim", "sections"]);
/** The pre-registered thresholds, over 45 trials (rules 1 to 4) and 15 cases (rules 5 and 6). */
export const RULES = Object.freeze({ valid: 43, grounded: 43, nothing_lost: 41, fit: 36, stable: 12, ranked: 9 });
/** Mean founder ranks within this much of each other are a tie for block size. */
const RANK_TIE = 0.1;
const QUOTE_WORDS = 6;

// ---- words and dates ---------------------------------------------------------------------------------------------
// A text's words are read as the wording evaluation reads them (shared/ask-cases.mjs): an identifier or a date is one word.
export { says, wordIndex, words };

const MONTHS = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const NAMED_DAY = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gu;
const pad = (value) => String(value).padStart(2, "0");

/** Every date a text writes, as YYYY-MM-DD: ISO days, and a month name with a day, in 2026 unless it names a year. */
export function datesIn(text, year = 2026) {
  const found = new Set();
  for (const match of String(text).matchAll(ISO_DAY)) found.add(`${match[1]}-${match[2]}-${match[3]}`);
  for (const match of String(text).matchAll(NAMED_DAY)) {
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    const day = Number(match[2]);
    if (month !== undefined && day >= 1 && day <= 31) found.add(`${match[3] ?? year}-${pad(month)}-${pad(day)}`);
  }
  return found;
}
/** The date a text opens with, if it opens with one. */
function openingDate(text) {
  const trimmed = String(text).trim();
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (iso !== null) return iso[1];
  const named = trimmed.match(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b(?:,?\s+\d{4})?/u);
  return named === null ? null : ([...datesIn(named[0])][0] ?? null);
}

// ---- cases -------------------------------------------------------------------------------------------------------
const itemText = (item) => [item.title, item.label, item.text, item.owner, item.status, item.due_at, item.key, item.priority, item.decision?.title, item.decision?.first_line]
  .filter((value) => typeof value === "string").join("\n");

/** Every problem with the cases document; an empty list when it is the pre-registered set. */
export function caseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-blocks-eval-cases-v1" || document.schema_version !== 1) return ["the cases document kind is invalid"];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.today ?? "") || typeof document.time_zone !== "string" || typeof document.asker !== "string" || Number.isNaN(Date.parse(document.asked_at))) problems.push("today, asked_at, time_zone and asker are required");
  const cases = Array.isArray(document.cases) ? document.cases : [];
  if (cases.length !== CASE_COUNT) problems.push(`there are ${cases.length} cases, not ${CASE_COUNT}`);
  const ids = new Set();
  for (const entry of cases) {
    const where = `case ${entry?.id}`;
    if (typeof entry?.id !== "string" || !/^[a-z0-9-]{3,80}$/u.test(entry.id) || ids.has(entry.id)) problems.push(`${where}: id is missing or repeated`);
    ids.add(entry?.id);
    try { validatePersonQueryText(entry.question); } catch { problems.push(`${where}: the question is not a valid Ask question`); continue; }
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0 || !items.every((item) => ITEM_KINDS.has(item?.kind))) problems.push(`${where}: items must be follow-ups, decisions or tickets`);
    if (typeof entry.research?.query !== "string" || typeof entry.research?.need !== "string") problems.push(`${where}: research needs a query and a need`);
    const expect = entry.expect ?? {};
    const shapes = Array.isArray(expect.shapes) ? expect.shapes : [];
    if (shapes.length === 0 || !shapes.every((shape) => shape === "any" || SHAPES.includes(shape))) problems.push(`${where}: shapes must be known shapes`);
    if (!Array.isArray(expect.fallback) || !expect.fallback.every((shape) => SHAPES.includes(shape))) problems.push(`${where}: fallback must be known shapes`);
    const evidence = items.map(itemText).join("\n");
    if (!Array.isArray(expect.facts) || expect.facts.length === 0 || !expect.facts.every((alternatives) => nonEmptyStrings(alternatives))) problems.push(`${where}: facts are required`);
    else for (const alternatives of expect.facts) {
      if (!alternatives.some((fact) => fact === "you" || says(evidence, fact) || [...datesIn(fact)].some((day) => evidence.includes(day)))) problems.push(`${where}: no item says ${alternatives[0]}`);
    }
    if (!Array.isArray(expect.people) || !expect.people.every((person) => typeof person === "string" && says(evidence, person))) problems.push(`${where}: people must each appear in an item`);
    if (expect.order !== undefined && typeof expect.order !== "boolean") problems.push(`${where}: order must be true or false`);
    if (expect.forbidden_event_dates !== undefined && !(Array.isArray(expect.forbidden_event_dates) && expect.forbidden_event_dates.every((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day)))) problems.push(`${where}: forbidden event dates must be YYYY-MM-DD`);
  }
  return problems;
}

/** The pre-registered cases, refused when they are not the set the README registered. */
export function loadCases(path = CASES_FILE) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const problems = caseProblems(document);
  if (problems.length > 0) throw new Error(`block eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

/** The page's fixed order of the four catalogs for a case (labels A to D), from the case id alone. */
export function caseOrder(caseId) {
  const key = (catalog) => createHash("sha256").update(`${caseId}:${catalog}`).digest("hex");
  return Object.freeze([...CATALOG_IDS].sort((left, right) => key(left).localeCompare(key(right))));
}

// ---- the writer's evidence ---------------------------------------------------------------------------------------
/** The evidence the writer was given, by id, from its user prompt: each item's text to quote from, and its dates. */
export function evidenceOf(userPrompt) {
  const input = JSON.parse(userPrompt);
  const byId = new Map();
  for (const entry of Array.isArray(input.evidence) ? input.evidence : []) {
    const attributes = entry.attributes !== null && typeof entry.attributes === "object" ? entry.attributes : {};
    const text = [entry.title, entry.label, entry.text, ...Object.values(attributes)].filter((value) => typeof value === "string").join("\n");
    const dates = new Set(datesIn(text));
    for (const value of Object.values(entry.dates ?? {})) if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)) dates.add(value.slice(0, 10));
    if (typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}/u.test(entry.date)) dates.add(entry.date.slice(0, 10));
    byId.set(entry.id, Object.freeze({ id: entry.id, text, quotable: [entry.title, entry.text].filter((value) => typeof value === "string").join("\n"), dates }));
  }
  return Object.freeze({ byId, today: input.today });
}

// ---- reading an answer's blocks ----------------------------------------------------------------------------------
/** Every claim in an answer's blocks, in reading order, with the text the checks read and where it sits. */
export function claimsOf(blocks) {
  return blocks.flatMap((block, at) => {
    const base = { block: at, kind: block.kind };
    switch (block.kind) {
      case "answer": case "prose": case "list": return block.claims.map((claim) => ({ ...base, text: claim.text, evidence: claim.evidence }));
      case "table": return block.rows.map((row) => ({ ...base, text: row.cells.filter(Boolean).join("; "), evidence: row.evidence, cells: row.cells, columns: block.columns }));
      case "timeline": return block.events.map((event) => ({ ...base, text: [event.date, event.text, event.who].filter(Boolean).join(" "), evidence: event.evidence, date: event.date }));
      case "card": return block.facts.map((fact) => ({ ...base, text: `${fact.label}: ${fact.value}`, evidence: fact.evidence }));
      case "quote": return [{ ...base, text: block.text, evidence: block.evidence, quote: true }];
      default: return [];
    }
  });
}

/** Everything an answer writes, in reading order: headings, titles, labels, columns and claims. */
export function readingText(blocks) {
  return blocks.flatMap((block) => {
    const title = block.title === undefined || block.title.length === 0 ? [] : [block.title];
    switch (block.kind) {
      case "heading": case "label": return [block.text];
      case "answer": case "prose": case "list": return [...title, ...block.claims.map((claim) => claim.text)];
      case "table": return [...title, block.columns.filter(Boolean).join("; "), ...block.rows.map((row) => row.cells.filter(Boolean).join("; "))];
      case "timeline": return [...title, ...block.events.map((event) => [event.date, event.text, event.who].filter(Boolean).join(" "))];
      case "card": return [...title, ...block.facts.map((fact) => `${fact.label}: ${fact.value}`)];
      case "quote": return [block.text, block.from].filter(Boolean);
      default: return [];
    }
  }).join("\n");
}

/** Whether `quote` is word for word in one of the cited items' title or text. */
function verbatim(quote, cited, evidence) {
  const wanted = words(quote);
  if (wanted.length === 0) return false;
  return cited.some((id) => {
    const entry = evidence.byId.get(id);
    if (entry === undefined) return false;
    const source = words(entry.quotable);
    return source.some((_, at) => wanted.every((word, offset) => source[at + offset] === word));
  });
}
const QUOTED_SPAN = /["“]([^"”]+)["”]/gu;
const quotedSpans = (text) => [...String(text).matchAll(QUOTED_SPAN)].map((match) => match[1]).filter((span) => words(span).length >= QUOTE_WORDS);
const DATE_COLUMN = /date|day|when|due/iu;
const nonDecreasing = (days) => days.every((day, at) => at === 0 || day >= days[at - 1]);

/** The shapes an answer shows (README.md, "Measures"). */
export function shapesOf(blocks, evidence) {
  const shapes = new Set();
  const content = blocks.filter((block) => block.kind !== "heading" && block.kind !== "label");
  const claims = claimsOf(blocks);
  const rich = content.some((block) => ["list", "table", "timeline", "card", "quote"].includes(block.kind));
  const prose = content.filter((block) => block.kind === "prose");
  if (content[0]?.kind === "answer" && !rich && prose.length <= 1 && (prose[0]?.claims.length ?? 0) <= 2 && content.length <= 2 && claims.length <= 3) shapes.add("single");
  for (const block of content) {
    if (block.kind === "prose") shapes.add("prose");
    if (block.kind === "list" && block.claims.length >= 2) {
      shapes.add(block.ordered ? "ordered" : "parallel");
      const days = block.claims.map((claim) => [...datesIn(claim.text)][0]);
      if (days.every(Boolean) && nonDecreasing(days)) shapes.add("sequence");
    }
    if (block.kind === "table" && block.rows.length >= 2 && Math.max(block.columns.length, ...block.rows.map((row) => row.cells.length)) >= 2) {
      shapes.add("grid");
      const column = block.columns.findIndex((name) => DATE_COLUMN.test(name));
      if (column >= 0) {
        const days = block.rows.map((row) => [...datesIn(row.cells[column] ?? "")][0]);
        if (days.every(Boolean) && nonDecreasing(days)) shapes.add("sequence");
      }
    }
    if (block.kind === "timeline" && block.events.length >= 2 && nonDecreasing(block.events.map((event) => event.date))) shapes.add("sequence");
    if (block.kind === "card" && block.facts.length >= 2) shapes.add("profile");
    if (block.kind === "quote" && words(block.text).length >= QUOTE_WORDS && verbatim(block.text, block.evidence, evidence)) shapes.add("verbatim");
  }
  if (claims.some((claim) => !claim.quote && quotedSpans(claim.text).some((span) => verbatim(span, claim.evidence, evidence)))) shapes.add("verbatim");
  // Sections: two or more headings or titles, each with a claim under it before the next one.
  let sections = 0;
  let pending = false;
  for (const block of blocks) {
    if (block.kind === "heading" || (block.title !== undefined && block.title.length > 0 && block.kind !== "card")) pending = true;
    if (pending && claimsOf([block]).length > 0) { sections += 1; pending = false; }
  }
  if (sections >= 2) shapes.add("sections");
  return shapes;
}

/** The shape of the first block after the answer that states something, for stability; "single" when there is none. */
export function mainShape(blocks) {
  const answer = blocks.findIndex((block) => block.kind === "answer");
  const next = blocks.slice(answer + 1).find((block) => claimsOf([block]).length > 0);
  if (next === undefined) return "single";
  if (next.kind === "list") return next.ordered ? "ordered" : "parallel";
  return { table: "grid", timeline: "sequence", card: "profile", quote: "verbatim", prose: "prose", answer: "prose" }[next.kind] ?? next.kind;
}

/** Whether every claim is tied to evidence (README.md, "Grounded"), with each problem found. */
export function groundingOf(caseDefinition, blocks, evidence) {
  const problems = [];
  const claims = claimsOf(blocks);
  if (claims.length === 0) problems.push("the answer states nothing");
  const people = caseDefinition.expect.people;
  const forbidden = new Set(caseDefinition.expect.forbidden_event_dates ?? []);
  for (const [at, claim] of claims.entries()) {
    const where = `claim ${at + 1} (${claim.kind})`;
    if (claim.evidence.length === 0) { problems.push(`${where} cites nothing`); continue; }
    const unknown = claim.evidence.filter((id) => !evidence.byId.has(id));
    if (unknown.length > 0) problems.push(`${where} cites ${unknown.join(", ")}, which the writer was not given`);
    const cited = claim.evidence.map((id) => evidence.byId.get(id)).filter(Boolean);
    const known = new Set([evidence.today, ...cited.flatMap((entry) => [...entry.dates])]);
    const written = new Set([...datesIn(claim.text), ...(claim.date === undefined ? [] : [claim.date])]);
    for (const day of written) if (!known.has(day)) problems.push(`${where} writes ${day}, which no item it cites has`);
    for (const person of people) {
      const first = person.split(" ")[0];
      const named = says(claim.text, person) || says(claim.text, first);
      if (named && !cited.some((entry) => says(entry.text, first))) problems.push(`${where} names ${person}, whom no item it cites names`);
    }
    if (claim.quote && !verbatim(claim.text, claim.evidence, evidence)) problems.push(`${where} is a quote that is not word for word in what it cites`);
    for (const span of quotedSpans(claim.text)) if (!claim.quote && !verbatim(span, claim.evidence, evidence)) problems.push(`${where} quotes "${span}", which is not word for word in what it cites`);
    if (forbidden.size > 0) {
      const dateCells = (claim.columns ?? []).map((name, column) => (DATE_COLUMN.test(name) ? claim.cells[column] : null)).filter((cell) => cell !== null);
      const eventDays = new Set([claim.date, openingDate(claim.text), ...dateCells.flatMap((cell) => [...datesIn(cell)])].filter(Boolean));
      for (const day of eventDays) if (forbidden.has(day)) problems.push(`${where} dates an event ${day}, a date the case forbids`);
    }
  }
  return Object.freeze({ grounded: problems.length === 0, problems: Object.freeze(problems) });
}

/** Whether the answer writes every required fact, and in a case marked in order, in the listed order (README.md, "Nothing lost"). */
export function factsOf(caseDefinition, blocks) {
  const text = readingText(blocks);
  const found = (alternatives, within) => alternatives.some((fact) => (fact === "you" ? says(within, "you") : says(within, fact) || [...datesIn(fact)].some((day) => datesIn(within).has(day))));
  const missing = caseDefinition.expect.facts.filter((alternatives) => !found(alternatives, text)).map((alternatives) => alternatives[0]);
  let inOrder = true;
  if (caseDefinition.expect.order === true && missing.length === 0) {
    const answer = blocks.findIndex((block) => block.kind === "answer");
    const after = blocks.slice(answer + 1);
    const ordered = readingText(after.length > 0 ? after : blocks.slice(answer, answer + 1));
    const firstAt = (alternatives) => {
      const places = alternatives.flatMap((fact) => {
        const direct = wordIndex(ordered, fact);
        const dated = [...datesIn(fact)].flatMap((day) => [wordIndex(ordered, day), ...[...ordered.matchAll(NAMED_DAY)].filter((match) => datesIn(match[0]).has(day)).map((match) => words(ordered.slice(0, match.index)).length)]);
        return [direct, ...dated].filter((place) => place >= 0);
      });
      return places.length === 0 ? -1 : Math.min(...places);
    };
    const places = caseDefinition.expect.facts.map(firstAt);
    inOrder = places.every((place, at) => place >= 0 && (at === 0 || place > places[at - 1]));
  }
  return Object.freeze({ nothing_lost: missing.length === 0 && inOrder, missing: Object.freeze(missing), in_order: inOrder });
}

/** Whether the answer fits within its catalog's own blocks (README.md, "Fit"). */
export function fits(caseDefinition, catalog, shapes) {
  const wanted = caseDefinition.expect.shapes;
  if (wanted.includes("any")) return true;
  if (wanted.includes("single")) return shapes.has("single");
  const accepted = wanted.some((shape) => catalog.can_show.includes(shape)) ? wanted : caseDefinition.expect.fallback;
  return accepted.some((shape) => shapes.has(shape));
}

/** One trial's grade, from its catalog's reading of its final reply. An invalid reply passes nothing. */
export function gradeTrial(caseDefinition, catalog, read, evidence) {
  if (!read.valid) {
    return Object.freeze({ valid: false, grounded: false, nothing_lost: false, fit: false, shapes: Object.freeze([]), main_shape: "invalid",
      grounding_problems: Object.freeze([]), missing_facts: Object.freeze([]), in_order: false, claims: 0, blocks: 0, block_kinds: Object.freeze([]) });
  }
  const shapes = shapesOf(read.blocks, evidence);
  const grounding = groundingOf(caseDefinition, read.blocks, evidence);
  const facts = factsOf(caseDefinition, read.blocks);
  return Object.freeze({
    valid: true, grounded: grounding.grounded, nothing_lost: facts.nothing_lost, fit: fits(caseDefinition, catalog, shapes),
    shapes: Object.freeze([...shapes].sort()), main_shape: mainShape(read.blocks),
    grounding_problems: grounding.problems, missing_facts: facts.missing, in_order: facts.in_order,
    claims: claimsOf(read.blocks).length, blocks: read.blocks.length, block_kinds: Object.freeze(read.blocks.map((block) => block.kind)),
  });
}

/** Whether a case's trials are stable: at least two of its three trials share their main shape (README.md, "Stable"). */
export function stableOf(trials) {
  const counts = new Map();
  for (const trial of trials) counts.set(trial.grade.main_shape, (counts.get(trial.grade.main_shape) ?? 0) + 1);
  return [...counts.entries()].some(([shape, count]) => shape !== "invalid" && count >= 2);
}

/** `value` to two decimal places, as the summaries report a mean. */
const hundredths = (value) => Math.round(value * 100) / 100;

/** Each catalog's rule counts over its trials, beside the measures reported with them. */
export function summarizeCatalogs(trials, catalogIds = CATALOG_IDS) {
  return Object.freeze(Object.fromEntries(catalogIds.map((catalog) => {
    const own = trials.filter((trial) => trial.catalog === catalog);
    const count = (name) => own.filter((trial) => trial.grade[name]).length;
    const cases = [...new Set(own.map((trial) => trial.case_id))];
    const stable = cases.filter((caseId) => stableOf(own.filter((trial) => trial.case_id === caseId))).length;
    const total = (pick) => own.reduce((sum, trial) => sum + (pick(trial) ?? 0), 0);
    const kinds = {};
    for (const trial of own) for (const kind of trial.grade.block_kinds) kinds[kind] = (kinds[kind] ?? 0) + 1;
    return [catalog, Object.freeze({
      trials: own.length, cases: cases.length,
      valid: count("valid"), grounded: count("grounded"), nothing_lost: count("nothing_lost"), fit: count("fit"), stable,
      valid_at_once: own.filter((trial) => trial.attempts?.[0]?.valid === true).length,
      repairs: own.filter((trial) => (trial.attempts?.length ?? 0) > 1).length,
      mean_blocks: own.length === 0 ? null : hundredths(total((trial) => trial.grade.blocks) / own.length),
      mean_claims: own.length === 0 ? null : hundredths(total((trial) => trial.grade.claims) / own.length),
      output_tokens: total((trial) => trial.attempts?.reduce((sum, attempt) => sum + (attempt.usage?.output_tokens ?? 0), 0)),
      block_kinds: Object.freeze(kinds),
      rules: Object.freeze({
        valid: count("valid") >= RULES.valid, grounded: count("grounded") >= RULES.grounded, nothing_lost: count("nothing_lost") >= RULES.nothing_lost,
        fit: count("fit") >= RULES.fit, stable: stable >= RULES.stable,
      }),
    })];
  })));
}

/**
 * The founder's and the judge's ranks over the cases (README.md, "Ranks" and "Pre-registered rules"): each catalog's
 * mean rank, rule 6, and how often the judge's top pick and its order of each pair of catalogs match the founder's.
 * `founder` and `judge` map case id to catalog id to rank (1 best); a case missing from either is left out of it.
 */
export function summarizeRanks(founder, judge, catalogIds = CATALOG_IDS) {
  const mean = (ranks, catalog) => {
    const values = Object.values(ranks).map((byCatalog) => byCatalog[catalog]).filter((value) => typeof value === "number");
    return values.length === 0 ? null : hundredths(values.reduce((sum, value) => sum + value, 0) / values.length);
  };
  const cases = Object.keys(founder);
  const ranked = cases.filter((caseId) => founder[caseId].balanced <= founder[caseId].today).length;
  let tops = 0;
  let topCases = 0;
  let pairs = 0;
  let agreeing = 0;
  for (const caseId of cases.filter((id) => judge[id] !== undefined)) {
    const best = (ranks) => new Set(catalogIds.filter((catalog) => ranks[catalog] === Math.min(...catalogIds.map((entry) => ranks[entry]))));
    const founderBest = best(founder[caseId]);
    topCases += 1;
    if ([...best(judge[caseId])].some((catalog) => founderBest.has(catalog))) tops += 1;
    for (const [at, left] of catalogIds.entries()) {
      for (const right of catalogIds.slice(at + 1)) {
        pairs += 1;
        if (Math.sign(founder[caseId][left] - founder[caseId][right]) === Math.sign(judge[caseId][left] - judge[caseId][right])) agreeing += 1;
      }
    }
  }
  return Object.freeze({
    cases: cases.length,
    founder_mean_rank: Object.freeze(Object.fromEntries(catalogIds.map((catalog) => [catalog, mean(founder, catalog)]))),
    judge_mean_rank: Object.freeze(Object.fromEntries(catalogIds.map((catalog) => [catalog, mean(judge, catalog)]))),
    balanced_at_least_today: ranked,
    rule_ranked: cases.length === CASE_COUNT && ranked >= RULES.ranked,
    judge_top_pick_agrees: topCases === 0 ? null : Object.freeze({ cases: topCases, agreeing: tops }),
    judge_pairs_agree: pairs === 0 ? null : Object.freeze({ pairs, agreeing }),
  });
}

/**
 * The pre-registered decision: the direction is sound when `balanced` passes rules 1 to 6; the right block size is the
 * catalog with the lowest mean founder rank among those passing rules 1 to 3, a tie within 0.1 going to fewer repairs,
 * then to fewer output tokens. Undecided until every case is ranked.
 */
export function decide(catalogs, ranks) {
  const balanced = catalogs.balanced;
  const complete = ranks !== null && ranks.cases === CASE_COUNT;
  const sound = complete && balanced !== undefined && Object.values(balanced.rules).every(Boolean) && ranks.rule_ranked;
  const eligible = Object.entries(catalogs).filter(([, summary]) => summary.rules.valid && summary.rules.grounded && summary.rules.nothing_lost)
    .map(([catalog, summary]) => ({ catalog, rank: ranks?.founder_mean_rank?.[catalog] ?? null, repairs: summary.repairs, tokens: summary.output_tokens }))
    .filter((entry) => entry.rank !== null)
    .sort((left, right) => (Math.abs(left.rank - right.rank) > RANK_TIE ? left.rank - right.rank : left.repairs - right.repairs || left.tokens - right.tokens));
  return Object.freeze({ complete, direction_sound: complete ? sound : null, right_size: complete ? (eligible[0]?.catalog ?? null) : null, eligible: Object.freeze(eligible) });
}

/**
 * The gate on the built writer (README.md, "Gate on the built writer"): it passes when `built` meets rules 1 to 5 at the
 * pre-registered thresholds in a complete gate run (`summary` is its summarizeCatalogs entry). Undecided otherwise; the
 * founder's check on the desktop stands in for rule 6.
 */
export function decideGate(summary, complete) {
  const rules = summary?.rules ?? null;
  return Object.freeze({ complete, arm: "built", passes: complete && rules !== null ? Object.values(rules).every(Boolean) : null, rules });
}
