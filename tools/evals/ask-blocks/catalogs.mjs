/**
 * The four catalogs of the Ask block evaluation (README.md, "Catalogs"): each catalog's entries, the layout part of the
 * writer's instructions, its reply schema, and how a reply is checked and read into common blocks and a view the page
 * draws. `today` is production's own prompt, schema and reading (ADR-0045). Every other catalog's entries follow the
 * research tool contract (ADR-0042): a name, a description that says only what the entry shows, and params with their
 * meanings; its schema and checks are built from the same entries.
 */
import {
  ANSWER_LAYOUT_PROMPT, answerLayoutSchema, cleanModelLine, parseAnswer, stripEvidenceIds,
} from "../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { buildAskLayoutV1, orderAskLayoutV1 } from "../../../packages/organization-authority-kernel/dist/answer-composition/renderers/ask-layout-v1.js";

const TEXT_CHARS = 400;
const LABEL_CHARS = 120;

/** Production's two wording rules, word for word, which every catalog's layout part keeps (README.md, "Catalogs"). */
export const WORDING_RULES = Object.freeze(["- The app shows the answer right under the question", "- Write a long identifier"].map((prefix) => {
  const line = ANSWER_LAYOUT_PROMPT.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) throw new Error(`the production layout prompt has no rule starting "${prefix}"`);
  return line;
}));

// ---- schema pieces ----------------------------------------------------------------------------------------------
const STRING = Object.freeze({ type: "string" });
const IDS = Object.freeze({ type: "array", items: STRING });
const one = (name) => Object.freeze({ type: "string", enum: [name] });
const array = (items, minItems, maxItems) => Object.freeze({ type: "array", items, ...(minItems > 0 ? { minItems } : {}), maxItems });
const object = (required, properties) => Object.freeze({ type: "object", additionalProperties: false, required, properties });
const CLAIM = object(["text", "evidence"], { text: STRING, evidence: IDS });
const ROW = object(["cells", "evidence"], { cells: array(STRING, 2, 6), evidence: IDS });
const EVENT = object(["date", "text", "evidence"], { date: STRING, text: STRING, who: STRING, evidence: IDS });
const FACT = object(["label", "value", "evidence"], { label: STRING, value: STRING, evidence: IDS });
const CARD_KINDS = Object.freeze(["person", "project", "ticket", "decision"]);
const NOT_FOUND = array(STRING, 0, 6);

// ---- reading helpers --------------------------------------------------------------------------------------------
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Model text as production reads it: one line, within its cap, evidence ids dropped. */
const said = (value, chars = TEXT_CHARS) => (typeof value === "string" ? stripEvidenceIds(cleanModelLine(value, chars), true) : "");
const idsOf = (value) => (Array.isArray(value) ? [...new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))] : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** A checker that collects every problem and names where each one is. */
function problems() {
  const found = [];
  return Object.freeze({
    found,
    add: (where, what) => { found.push(`${where} ${what}`); },
    text: (where, value, chars = TEXT_CHARS) => { const text = said(value, chars); if (text.length === 0) found.push(`${where} needs text`); return text; },
    count: (where, value, minimum, maximum) => {
      if (!Array.isArray(value)) { found.push(`${where} must be a list`); return []; }
      if (value.length < minimum || value.length > maximum) found.push(`${where} must have ${minimum} to ${maximum} entries, not ${value.length}`);
      return value;
    },
  });
}

function claimsOf(check, where, value, minimum, maximum) {
  return check.count(where, value, minimum, maximum).map((entry, at) => {
    if (!isObject(entry)) { check.add(`${where}[${at}]`, "must be an object with text and evidence"); return { text: "", evidence: [] }; }
    return { text: check.text(`${where}[${at}].text`, entry.text), evidence: idsOf(entry.evidence) };
  });
}

function tableOf(check, where, columnsValue, rowsValue) {
  const columns = check.count(`${where}.columns`, columnsValue, 2, 6).map((column, at) => check.text(`${where}.columns[${at}]`, column, LABEL_CHARS));
  const rows = check.count(`${where}.rows`, rowsValue, 2, 12).map((row, at) => {
    if (!isObject(row) || !Array.isArray(row.cells)) { check.add(`${where}.rows[${at}]`, "must have cells and evidence"); return { cells: [], evidence: [] }; }
    const cells = row.cells.map((cell) => said(cell));
    if (cells.length !== columns.length) check.add(`${where}.rows[${at}]`, `must have one cell per column (${columns.length}), not ${cells.length}`);
    if (cells.every((cell) => cell.length === 0)) check.add(`${where}.rows[${at}]`, "says nothing");
    return { cells, evidence: idsOf(row.evidence) };
  });
  return { columns, rows };
}

function eventsOf(check, where, value) {
  return check.count(where, value, 2, 12).map((entry, at) => {
    if (!isObject(entry)) { check.add(`${where}[${at}]`, "must be an object with date, text and evidence"); return { date: "", text: "", evidence: [] }; }
    const date = typeof entry.date === "string" ? entry.date.trim() : "";
    if (!DAY.test(date)) check.add(`${where}[${at}].date`, "must be YYYY-MM-DD");
    const who = said(entry.who, LABEL_CHARS);
    return { date, text: check.text(`${where}[${at}].text`, entry.text), ...(who.length === 0 ? {} : { who }), evidence: idsOf(entry.evidence) };
  });
}

function factsOf(check, where, value) {
  return check.count(where, value, 2, 8).map((entry, at) => {
    if (!isObject(entry)) { check.add(`${where}[${at}]`, "must be an object with label, value and evidence"); return { label: "", value: "", evidence: [] }; }
    return { label: check.text(`${where}[${at}].label`, entry.label, LABEL_CHARS), value: check.text(`${where}[${at}].value`, entry.value), evidence: idsOf(entry.evidence) };
  });
}

function notFoundOf(check, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { check.add("not_found", "must be a list"); return []; }
  return value.map((entry) => said(entry)).filter(Boolean);
}

/** The view the page draws for common blocks: one node list, the same for every catalog but `primitives`. */
export function viewOfBlocks(blocks) {
  return blocks.flatMap((block) => {
    const heading = block.title === undefined || block.title.length === 0 || block.kind === "card" ? [] : [{ t: "h", text: block.title }];
    switch (block.kind) {
      case "answer": return [{ t: "lead", claims: block.claims }];
      case "heading": return [{ t: "h", text: block.text }];
      case "label": return [{ t: "label", text: block.text }];
      case "prose": return [...heading, { t: "p", claims: block.claims }];
      case "list": return [...heading, { t: block.ordered ? "ol" : "ul", items: block.claims }];
      case "table": return [...heading, { t: "table", columns: block.columns, rows: block.rows }];
      case "timeline": return [...heading, { t: "timeline", events: block.events }];
      case "card": return [{ t: "card", title: block.title, kind: block.card_kind, facts: block.facts }];
      case "quote": return [{ t: "quote", text: block.text, from: block.from, evidence: block.evidence }];
      default: return [];
    }
  });
}

// ---- today: production ------------------------------------------------------------------------------------------
/** A laid-out production reply read as production reads it (parseAnswer, then code's order and blocks), as common blocks. */
function readToday(value) {
  let parsed;
  try { parsed = parseAnswer(value, { layout: true }); } catch (error) {
    return { valid: false, problems: [error instanceof Error ? error.message : "the reply could not be read"], blocks: [], not_found: [] };
  }
  const tables = parsed.tables ?? [];
  const sentences = parsed.sentences.map((sentence) => {
    const section = sentence.section === undefined ? {} : { section: sentence.section };
    const columns = tables.find((table) => table.section === sentence.section)?.columns;
    const shape = sentence.form === "row" && columns !== undefined && sentence.cells !== undefined
      ? { kind: "row", ...section, columns, cells: sentence.cells }
      : { kind: sentence.form === "row" ? "bullet" : (sentence.form ?? "text"), ...section };
    return { text: sentence.text, evidence: [...sentence.evidence], shape };
  });
  if (sentences.length === 0) return { valid: false, problems: ["the reply has no sentence"], blocks: [], not_found: [...parsed.not_found] };
  const ordered = orderAskLayoutV1([], sentences, sentences.some((sentence) => sentence.shape.kind === "lead"));
  const layout = buildAskLayoutV1(ordered.map((sentence) => ({ citation_indexes: [], shape: sentence.shape })));
  const claim = (at) => ({ text: ordered[at].text, evidence: ordered[at].evidence });
  const blocks = layout.map((block) => {
    if (block.kind === "heading") return { kind: "heading", text: block.text };
    if (block.kind === "lead") return { kind: "answer", claims: block.statements.map(claim) };
    if (block.kind === "paragraph") return { kind: "prose", claims: block.statements.map(claim) };
    if (block.kind === "bullets") return { kind: "list", ordered: false, claims: block.statements.map(claim) };
    return { kind: "table", columns: [...block.columns], rows: block.rows.map((row, at) => ({ cells: [...row.cells], evidence: ordered[block.statements[at]].evidence })) };
  });
  return { valid: true, problems: [], blocks, not_found: [...parsed.not_found] };
}

// ---- templates: one whole-answer template, filled ---------------------------------------------------------------
const ANSWER_PARAM = "1 to 2 sentences, the direct answer, each with its text and evidence";
const TITLE_PARAM = "optional: a heading of a few words";
const ROWS_PARAM = "2 to 12 rows, each with cells (one per column, in the columns' order, empty where the evidence does not say) and evidence";
const EVENTS_PARAM = "2 to 12 events, each with date (YYYY-MM-DD, as the evidence dates the event), text (what happened, in one sentence), who (optional: a person's name as the evidence records it) and evidence";
const FACTS_PARAM = "2 to 8 facts, each with label, value and evidence";

export const TEMPLATE_CATALOG = Object.freeze([
  { template: "fact", description: "A direct answer, with up to three sentences that support or qualify it.", params: { answer: ANSWER_PARAM, support: "0 to 3 sentences, each with its text and evidence" } },
  { template: "list", description: "A direct answer, then parallel items, one sentence each.", params: { answer: ANSWER_PARAM, title: TITLE_PARAM, items: "2 to 10 items, each with its text and evidence" } },
  { template: "report", description: "A direct answer, then a table of items that share the same fields under columns you name, then up to three notes.", params: { answer: ANSWER_PARAM, title: TITLE_PARAM, columns: "2 to 6 column names", rows: ROWS_PARAM, notes: "0 to 3 sentences, each with its text and evidence" } },
  { template: "story", description: "A direct answer, then events in date order, oldest first.", params: { answer: ANSWER_PARAM, title: TITLE_PARAM, events: EVENTS_PARAM } },
  { template: "profile", description: "A direct answer, then one person, project, ticket or decision with its key facts as label and value.", params: { answer: ANSWER_PARAM, title: "its name", kind: "person, project, ticket or decision", facts: FACTS_PARAM } },
].map((entry) => Object.freeze(entry)));

const TEMPLATE_SCHEMAS = Object.freeze([
  object(["name", "answer"], { name: one("fact"), answer: array(CLAIM, 1, 2), support: array(CLAIM, 0, 3) }),
  object(["name", "answer", "items"], { name: one("list"), answer: array(CLAIM, 1, 2), title: STRING, items: array(CLAIM, 2, 10) }),
  object(["name", "answer", "columns", "rows"], { name: one("report"), answer: array(CLAIM, 1, 2), title: STRING, columns: array(STRING, 2, 6), rows: array(ROW, 2, 12), notes: array(CLAIM, 0, 3) }),
  object(["name", "answer", "events"], { name: one("story"), answer: array(CLAIM, 1, 2), title: STRING, events: array(EVENT, 2, 12) }),
  object(["name", "answer", "title", "kind", "facts"], { name: one("profile"), answer: array(CLAIM, 1, 2), title: STRING, kind: { type: "string", enum: [...CARD_KINDS] }, facts: array(FACT, 2, 8) }),
]);
const templateSchema = object(["template", "not_found"], { template: { anyOf: [...TEMPLATE_SCHEMAS] }, not_found: NOT_FOUND });

function readTemplates(value) {
  const check = problems();
  if (!isObject(value) || !isObject(value.template)) return { valid: false, problems: ["the reply must be an object with a template"], blocks: [], not_found: [] };
  const template = value.template;
  const name = template.name;
  const title = said(template.title, LABEL_CHARS);
  const titled = title.length === 0 ? {} : { title };
  const blocks = [{ kind: "answer", claims: claimsOf(check, "template.answer", template.answer, 1, 2) }];
  if (name === "fact") {
    const support = template.support === undefined ? [] : claimsOf(check, "template.support", template.support, 0, 3);
    if (support.length > 0) blocks.push({ kind: "prose", claims: support });
  } else if (name === "list") {
    blocks.push({ kind: "list", ordered: false, ...titled, claims: claimsOf(check, "template.items", template.items, 2, 10) });
  } else if (name === "report") {
    blocks.push({ kind: "table", ...titled, ...tableOf(check, "template", template.columns, template.rows) });
    const notes = template.notes === undefined ? [] : claimsOf(check, "template.notes", template.notes, 0, 3);
    if (notes.length > 0) blocks.push({ kind: "prose", claims: notes });
  } else if (name === "story") {
    blocks.push({ kind: "timeline", ...titled, events: eventsOf(check, "template.events", template.events) });
  } else if (name === "profile") {
    if (!CARD_KINDS.includes(template.kind)) check.add("template.kind", `must be one of ${CARD_KINDS.join(", ")}`);
    if (title.length === 0) check.add("template.title", "needs text");
    blocks.push({ kind: "card", title, card_kind: template.kind, facts: factsOf(check, "template.facts", template.facts) });
  } else {
    check.add("template.name", `must be one of ${TEMPLATE_CATALOG.map((entry) => entry.template).join(", ")}`);
  }
  const notFound = notFoundOf(check, value.not_found);
  return { valid: check.found.length === 0, problems: check.found, blocks, not_found: notFound, choice: typeof name === "string" ? name : null };
}

// ---- balanced: any sequence of meaning-sized blocks -------------------------------------------------------------
export const BLOCK_CATALOG = Object.freeze([
  { block: "answer", description: "The direct answer to the question, in one or two sentences.", params: { sentences: "1 to 2 sentences, each with its text and evidence" } },
  { block: "text", description: "A short paragraph that explains, qualifies or connects facts.", params: { title: TITLE_PARAM, sentences: "1 to 4 sentences, each with its text and evidence" } },
  { block: "points", description: "Parallel items, one sentence each, such as blockers, conditions, decisions or steps.", params: { title: TITLE_PARAM, ordered: "true when the order matters, such as steps taken in turn; false otherwise", items: "2 to 10 items, each with its text and evidence" } },
  { block: "table", description: "Items that share the same fields, one row each, under columns you name, such as each action's owner, due date and status, or two options compared on the same points.", params: { title: TITLE_PARAM, columns: "2 to 6 column names", rows: ROWS_PARAM } },
  { block: "timeline", description: "Events in date order, oldest first: each event's date and what happened, and who was involved when the evidence says.", params: { title: TITLE_PARAM, events: EVENTS_PARAM } },
  { block: "card", description: "One person, project, ticket or decision, with its key facts as label and value.", params: { title: "its name", kind: "person, project, ticket or decision", facts: FACTS_PARAM } },
  { block: "quote", description: "The exact words of one source, such as an approved decision's text or what someone said, with where they come from.", params: { text: "words copied exactly from the cited evidence", from: "who said or recorded it, and when", evidence: "the one id it is copied from" } },
].map((entry) => Object.freeze(entry)));

const BLOCK_SCHEMAS = Object.freeze([
  object(["block", "sentences"], { block: one("answer"), sentences: array(CLAIM, 1, 2) }),
  object(["block", "sentences"], { block: one("text"), title: STRING, sentences: array(CLAIM, 1, 4) }),
  object(["block", "ordered", "items"], { block: one("points"), title: STRING, ordered: { type: "boolean" }, items: array(CLAIM, 2, 10) }),
  object(["block", "columns", "rows"], { block: one("table"), title: STRING, columns: array(STRING, 2, 6), rows: array(ROW, 2, 12) }),
  object(["block", "events"], { block: one("timeline"), title: STRING, events: array(EVENT, 2, 12) }),
  object(["block", "title", "kind", "facts"], { block: one("card"), title: STRING, kind: { type: "string", enum: [...CARD_KINDS] }, facts: array(FACT, 2, 8) }),
  object(["block", "text", "from", "evidence"], { block: one("quote"), text: STRING, from: STRING, evidence: IDS }),
]);
const blockSchema = object(["blocks", "not_found"], { blocks: array({ anyOf: [...BLOCK_SCHEMAS] }, 1, 12), not_found: NOT_FOUND });

function readBalanced(value) {
  const check = problems();
  if (!isObject(value) || !Array.isArray(value.blocks)) return { valid: false, problems: ["the reply must be an object with blocks"], blocks: [], not_found: [] };
  const blocks = check.count("blocks", value.blocks, 1, 12).map((entry, at) => {
    const where = `blocks[${at}]`;
    if (!isObject(entry)) { check.add(where, "must be an object"); return null; }
    const title = said(entry.title, LABEL_CHARS);
    const titled = title.length === 0 ? {} : { title };
    if (at === 0 && entry.block !== "answer") check.add(where, "must be the answer block");
    if (at > 0 && entry.block === "answer") check.add(where, "is a second answer block; only the first block is the answer");
    switch (entry.block) {
      case "answer": return { kind: "answer", claims: claimsOf(check, `${where}.sentences`, entry.sentences, 1, 2) };
      case "text": return { kind: "prose", ...titled, claims: claimsOf(check, `${where}.sentences`, entry.sentences, 1, 4) };
      case "points":
        if (typeof entry.ordered !== "boolean") check.add(`${where}.ordered`, "must be true or false");
        return { kind: "list", ordered: entry.ordered === true, ...titled, claims: claimsOf(check, `${where}.items`, entry.items, 2, 10) };
      case "table": return { kind: "table", ...titled, ...tableOf(check, where, entry.columns, entry.rows) };
      case "timeline": return { kind: "timeline", ...titled, events: eventsOf(check, `${where}.events`, entry.events) };
      case "card":
        if (!CARD_KINDS.includes(entry.kind)) check.add(`${where}.kind`, `must be one of ${CARD_KINDS.join(", ")}`);
        if (title.length === 0) check.add(`${where}.title`, "needs text");
        return { kind: "card", title, card_kind: entry.kind, facts: factsOf(check, `${where}.facts`, entry.facts) };
      case "quote": {
        const evidence = idsOf(entry.evidence);
        if (evidence.length !== 1) check.add(`${where}.evidence`, "must be the one id the quote is copied from");
        return { kind: "quote", text: check.text(`${where}.text`, entry.text), from: said(entry.from, LABEL_CHARS), evidence };
      }
      default:
        check.add(`${where}.block`, `must be one of ${BLOCK_CATALOG.map((block) => block.block).join(", ")}`);
        return null;
    }
  }).filter(Boolean);
  const notFound = notFoundOf(check, value.not_found);
  return { valid: check.found.length === 0, problems: check.found, blocks, not_found: notFound };
}

// ---- primitives: a flat tree of small components ----------------------------------------------------------------
export const COMPONENT_CATALOG = Object.freeze([
  { component: "Column", description: "Shows its children stacked top to bottom.", params: { children: "the ids of the components inside, in order" } },
  { component: "Row", description: "Shows its children side by side, left to right, on one line.", params: { children: "the ids of the components inside, in order" } },
  { component: "List", description: "Shows its children as a list, one item each.", params: { ordered: "true for a numbered list", children: "the ids of the components inside, in order" } },
  { component: "Card", description: "Shows its one child inside a bordered box.", params: { child: "the id of the one component inside" } },
  { component: "Tabs", description: "Shows each child under its own tab title, one tab at a time.", params: { tabs: "2 to 8 tabs, each with its title and the id of its child" } },
  { component: "Divider", description: "A horizontal line between components.", params: {} },
  { component: "Text", description: "A piece of text: a heading, body text or a small caption.", params: { text: "the words", variant: "heading, body or caption", evidence: "the ids of the evidence it states, when it states a fact" } },
].map((entry) => Object.freeze(entry)));

const CHILDREN = array(STRING, 1, 40);
const COMPONENT_SCHEMAS = Object.freeze([
  object(["id", "component", "children"], { id: STRING, component: one("Column"), children: CHILDREN }),
  object(["id", "component", "children"], { id: STRING, component: one("Row"), children: CHILDREN }),
  object(["id", "component", "ordered", "children"], { id: STRING, component: one("List"), ordered: { type: "boolean" }, children: CHILDREN }),
  object(["id", "component", "child"], { id: STRING, component: one("Card"), child: STRING }),
  object(["id", "component", "tabs"], { id: STRING, component: one("Tabs"), tabs: array(object(["title", "child"], { title: STRING, child: STRING }), 2, 8) }),
  object(["id", "component"], { id: STRING, component: one("Divider") }),
  object(["id", "component", "text", "variant"], { id: STRING, component: one("Text"), text: STRING, variant: { type: "string", enum: ["heading", "body", "caption"] }, evidence: IDS }),
]);
const componentSchema = object(["root", "components", "not_found"], { root: STRING, components: array({ anyOf: [...COMPONENT_SCHEMAS] }, 1, 80), not_found: NOT_FOUND });
const COMPONENTS = new Set(COMPONENT_CATALOG.map((entry) => entry.component));
const MAX_DEPTH = 10;
/** A primitives Text is a claim when it is body or caption text of at least this many words (README.md, "Measures"). */
export const CLAIM_WORDS = 4;
const wordCount = (text) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
const QUOTED = /^["“'‘](.+)["”'’]$/u;

/** The ids a component holds, in order. */
function childIdsOf(component) {
  if (component.component === "Card") return typeof component.child === "string" ? [component.child] : [];
  if (component.component === "Tabs") return Array.isArray(component.tabs) ? component.tabs.map((tab) => (isObject(tab) ? tab.child : undefined)).filter((id) => typeof id === "string") : [];
  return Array.isArray(component.children) ? component.children.filter((id) => typeof id === "string") : [];
}

function readPrimitives(value) {
  const check = problems();
  if (!isObject(value) || !Array.isArray(value.components) || typeof value.root !== "string") return { valid: false, problems: ["the reply must be an object with root and components"], blocks: [], not_found: [], tree: null };
  const byId = new Map();
  for (const [at, entry] of check.count("components", value.components, 1, 80).entries()) {
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) { check.add(`components[${at}]`, "needs an id"); continue; }
    if (byId.has(entry.id)) { check.add(`component ${entry.id}`, "is given twice"); continue; }
    if (!COMPONENTS.has(entry.component)) check.add(`component ${entry.id}`, `must be one of ${[...COMPONENTS].join(", ")}`);
    if (entry.component === "Text") {
      if (said(entry.text).length === 0) check.add(`component ${entry.id}`, "needs text");
      if (!["heading", "body", "caption"].includes(entry.variant)) check.add(`component ${entry.id}.variant`, "must be heading, body or caption");
    }
    if (entry.component === "List" && typeof entry.ordered !== "boolean") check.add(`component ${entry.id}.ordered`, "must be true or false");
    if (["Column", "Row", "List"].includes(entry.component) && (!Array.isArray(entry.children) || entry.children.length === 0)) check.add(`component ${entry.id}`, "needs children");
    if (entry.component === "Card" && typeof entry.child !== "string") check.add(`component ${entry.id}`, "needs one child");
    if (entry.component === "Tabs" && (!Array.isArray(entry.tabs) || entry.tabs.length < 2 || entry.tabs.some((tab) => !isObject(tab) || said(tab.title, LABEL_CHARS).length === 0))) check.add(`component ${entry.id}`, "needs two or more tabs, each with a title and a child");
    byId.set(entry.id, entry);
  }
  if (!byId.has(value.root)) check.add("root", "must be the id of a component");
  const parents = new Map();
  for (const component of byId.values()) {
    for (const child of childIdsOf(component)) {
      if (!byId.has(child)) check.add(`component ${component.id}`, `holds ${child}, which is not a component`);
      else if (parents.has(child)) check.add(`component ${child}`, `is inside both ${parents.get(child)} and ${component.id}`);
      else parents.set(child, component.id);
    }
  }
  if (parents.has(value.root)) check.add("root", "must not be inside another component");
  // Walk from the root: every component once, no cycle, within MAX_DEPTH. A component two others hold is drawn once,
  // under the first; the parents check above already named it.
  const reached = new Set();
  const path = new Set();
  const tree = (id, depth) => {
    const component = byId.get(id);
    if (component === undefined) return null;
    if (path.has(id)) { check.add(`component ${id}`, "is inside itself"); return null; }
    if (reached.has(id)) return null;
    reached.add(id);
    if (depth > MAX_DEPTH) { check.add(`component ${id}`, `is deeper than ${MAX_DEPTH} levels`); return null; }
    const node = { id, component: component.component };
    if (component.component === "Text") return { ...node, text: said(component.text), variant: component.variant, evidence: idsOf(component.evidence) };
    if (component.component === "List") node.ordered = component.ordered === true;
    path.add(id);
    if (component.component === "Tabs") node.tabs = (component.tabs ?? []).filter(isObject).map((tab) => ({ title: said(tab.title, LABEL_CHARS), child: tree(tab.child, depth + 1) }));
    else node.children = childIdsOf(component).map((child) => tree(child, depth + 1)).filter(Boolean);
    path.delete(id);
    return node;
  };
  const root = byId.has(value.root) ? tree(value.root, 0) : null;
  for (const id of byId.keys()) if (!reached.has(id)) check.add(`component ${id}`, "is not inside root");
  const blocks = root === null ? [] : normalizePrimitives(root);
  const first = blocks.find((block) => block.kind !== "heading" && block.kind !== "label");
  if (root !== null && first?.kind !== "answer") check.add("root", "must show a body Text first: the direct answer");
  const notFound = notFoundOf(check, value.not_found);
  return { valid: check.found.length === 0, problems: check.found, blocks, not_found: notFound, tree: root };
}

/** Every Text in a subtree, in reading order. */
function textsOf(node) {
  if (node.component === "Text") return [node];
  if (node.component === "Tabs") return node.tabs.flatMap((tab) => (tab.child === null ? [] : textsOf(tab.child)));
  return (node.children ?? []).flatMap(textsOf);
}
const joinTexts = (texts) => ({ text: texts.map((text) => text.text).join(" "), evidence: [...new Set(texts.flatMap((text) => text.evidence))] });
/** A Row of Text only, two or more of them: a table row or a label and value pair. */
const textRow = (node) => node.component === "Row" && node.children.length >= 2 && node.children.every((child) => child.component === "Text");

/** A Column read as a table: two or more Rows of Text with the same number of cells, the first a header when it cites nothing and a later one does. */
function tableFrom(node) {
  if (node.component !== "Column" || node.children.length < 2 || !node.children.every(textRow)) return null;
  const width = node.children[0].children.length;
  if (!node.children.every((row) => row.children.length === width)) return null;
  const cites = (row) => row.children.some((cell) => cell.evidence.length > 0);
  const header = !cites(node.children[0]) && node.children.slice(1).some(cites);
  const rows = (header ? node.children.slice(1) : node.children).map((row) => ({ cells: row.children.map((cell) => cell.text), evidence: joinTexts(row.children).evidence }));
  if (rows.length < 2 && !header) return null;
  return { kind: "table", columns: header ? node.children[0].children.map((cell) => cell.text) : Array.from({ length: width }, () => ""), rows };
}

/**
 * A primitives tree as common blocks (README.md, "Procedure", step 3): headings, quotes, labels and prose from Text;
 * lists from List; tables from a Column of Text Rows; cards from a Card of label and value pairs; each tab its heading
 * and content. The first body Text that states something is the answer.
 */
export function normalizePrimitives(root) {
  const blocks = [];
  const prose = (claim) => {
    const last = blocks.at(-1);
    if (last?.kind === "prose") last.claims.push(claim);
    else blocks.push({ kind: "prose", claims: [claim] });
  };
  const text = (node) => {
    if (node.variant === "heading") { blocks.push({ kind: "heading", text: node.text }); return; }
    const quoted = node.text.match(QUOTED);
    if (quoted !== null && wordCount(quoted[1]) >= 6) { blocks.push({ kind: "quote", text: quoted[1].trim(), from: "", evidence: node.evidence }); return; }
    if (node.evidence.length === 0 && wordCount(node.text) < CLAIM_WORDS) { blocks.push({ kind: "label", text: node.text }); return; }
    prose({ text: node.text, evidence: node.evidence });
  };
  const card = (node) => {
    const inside = node.children[0];
    if (inside === undefined) return;
    const table = tableFrom(inside);
    if (table !== null && table.columns.length === 2) {
      blocks.push({ kind: "card", title: "", card_kind: "", facts: table.rows.map((row) => ({ label: row.cells[0], value: row.cells[1], evidence: row.evidence })) });
      return;
    }
    const parts = inside.component === "Column" ? inside.children : [inside];
    const titled = parts[0]?.component === "Text" && parts[0].variant === "heading";
    const pair = (part) => textRow(part) && part.children.length === 2;
    const pairs = parts.filter(pair).map((row) => ({ label: row.children[0].text, value: row.children[1].text, evidence: joinTexts(row.children).evidence }));
    if (pairs.length < 2) { walk(inside); return; }
    blocks.push({ kind: "card", title: titled ? parts[0].text : "", card_kind: "", facts: pairs });
    parts.filter((part, at) => !pair(part) && !(titled && at === 0)).forEach(walk);
  };
  const walk = (node) => {
    switch (node.component) {
      case "Text": text(node); return;
      case "Divider": return;
      case "List": blocks.push({ kind: "list", ordered: node.ordered === true, claims: node.children.map((child) => joinTexts(textsOf(child))).filter((claim) => claim.text.length > 0) }); return;
      case "Card": card(node); return;
      case "Tabs": node.tabs.forEach((tab) => { blocks.push({ kind: "heading", text: tab.title }); if (tab.child !== null) walk(tab.child); }); return;
      case "Row": if (textRow(node)) { prose(joinTexts(node.children)); return; } node.children.forEach(walk); return;
      default: {
        const table = tableFrom(node);
        if (table !== null) { blocks.push(table); return; }
        node.children.forEach(walk);
      }
    }
  };
  walk(root);
  // The first body Text that states something is the answer, when nothing that states something comes before it.
  const first = blocks.findIndex((block) => block.kind !== "heading" && block.kind !== "label");
  if (first >= 0 && blocks[first].kind === "prose") {
    const [answer, ...rest] = blocks[first].claims;
    blocks.splice(first, 1, { kind: "answer", claims: [answer] }, ...(rest.length === 0 ? [] : [{ kind: "prose", claims: rest }]));
  }
  return blocks;
}

// ---- the layout parts --------------------------------------------------------------------------------------------
const CITES = "Never write ids such as E4 in the text.";
const BLOCK_PROMPT = [
  "Layout: the person's app shows the answer as a short document made of blocks. \"block_catalog\" lists the blocks it can show:",
  "- Each block_catalog entry has \"block\", the name you pass; \"description\", what the block shows; and \"params\", each field it takes with what it means and its limits.",
  "- Choose the blocks that show this answer best, in the order the person should read them, and only the blocks the answer needs: an answer that is one fact is one \"answer\" block.",
  "- The first block is \"answer\": the conclusion, in one or two sentences.",
  ...WORDING_RULES,
  `- Every sentence, item, row, event, fact and quote cites the evidence that supports it in "evidence", and only that evidence. ${CITES}`,
  "- Write a date in a date field or a table cell as YYYY-MM-DD.",
  "- Put in a block only what the evidence says.",
  "",
  "With layout, reply with ONLY a JSON object in exactly this shape instead:",
  "{\"blocks\":[{\"block\":\"answer\",\"sentences\":[{\"text\":\"<the conclusion>\",\"evidence\":[\"E1\"]}]},{\"block\":\"<a block from block_catalog>\",\"<its params>\":\"...\"}],\"not_found\":[]}",
].join("\n");
const TEMPLATE_PROMPT = [
  "Layout: the person's app shows the answer with one template. \"template_catalog\" lists the templates it can show:",
  "- Each template_catalog entry has \"template\", the name you pass; \"description\", what the template shows; and \"params\", each field it takes with what it means and its limits.",
  "- Choose the one template that shows this answer best, and fill its fields.",
  "- Every template opens with \"answer\": the conclusion, in one or two sentences.",
  ...WORDING_RULES,
  `- Every sentence, item, row, event and fact cites the evidence that supports it in "evidence", and only that evidence. ${CITES}`,
  "- Write a date in a date field or a table cell as YYYY-MM-DD.",
  "- Put in a template only what the evidence says.",
  "",
  "With layout, reply with ONLY a JSON object in exactly this shape instead:",
  "{\"template\":{\"name\":\"<a template from template_catalog>\",\"answer\":[{\"text\":\"<the conclusion>\",\"evidence\":[\"E1\"]}],\"<its other params>\":\"...\"},\"not_found\":[]}",
].join("\n");
const COMPONENT_PROMPT = [
  "Layout: the person's app draws the answer from components. \"component_catalog\" lists the components it can draw:",
  "- Each component_catalog entry has \"component\", the name you pass; \"description\", what the component shows; and \"params\", each field it takes with what it means.",
  "- Give the answer as a flat list of components, each with its own \"id\". A component that holds others names their ids in \"children\", \"child\" or \"tabs\"; each component is inside at most one other. \"root\" is the id of the component that holds everything else.",
  "- Build the layout that shows this answer best, with only the components the answer needs.",
  "- The first body Text the root shows is the direct answer: the conclusion, in one or two sentences.",
  ...WORDING_RULES,
  `- Every Text that states a fact cites the evidence that supports it in "evidence", and only that evidence; headings and labels cite nothing. ${CITES}`,
  "- Write a date as YYYY-MM-DD.",
  "- Write only what the evidence says.",
  "",
  "With layout, reply with ONLY a JSON object in exactly this shape instead:",
  "{\"root\":\"main\",\"components\":[{\"id\":\"main\",\"component\":\"Column\",\"children\":[\"answer\"]},{\"id\":\"answer\",\"component\":\"Text\",\"variant\":\"body\",\"text\":\"<the conclusion>\",\"evidence\":[\"E1\"]}],\"not_found\":[]}",
].join("\n");

/**
 * The catalogs, in the page's and the report's order. `catalog_key` names the entries' place in the writer's input
 * (beside `source_catalog`); `today` adds none and keeps production's prompt and schema byte for byte.
 */
export const CATALOGS = Object.freeze([
  Object.freeze({ id: "today", modeled_on: "production (ADR-0045)", catalog_key: null, catalog: null, layout_prompt: ANSWER_LAYOUT_PROMPT, schema: answerLayoutSchema, read: readToday,
    can_show: Object.freeze(["single", "prose", "parallel", "grid", "sequence", "verbatim", "sections"]) }),
  Object.freeze({ id: "templates", modeled_on: "OpenAI ChatKit widget templates, Microsoft Adaptive Card templates", catalog_key: "template_catalog", catalog: TEMPLATE_CATALOG, layout_prompt: TEMPLATE_PROMPT, schema: templateSchema, read: readTemplates,
    can_show: Object.freeze(["single", "prose", "parallel", "grid", "sequence", "profile", "verbatim"]) }),
  Object.freeze({ id: "balanced", modeled_on: "Vercel json-render style meaning-sized components", catalog_key: "block_catalog", catalog: BLOCK_CATALOG, layout_prompt: BLOCK_PROMPT, schema: blockSchema, read: readBalanced,
    can_show: Object.freeze(["single", "prose", "parallel", "ordered", "grid", "sequence", "profile", "verbatim", "sections"]) }),
  Object.freeze({ id: "primitives", modeled_on: "Google A2UI basic catalog, without media and input components", catalog_key: "component_catalog", catalog: COMPONENT_CATALOG, layout_prompt: COMPONENT_PROMPT, schema: componentSchema, read: readPrimitives,
    can_show: Object.freeze(["single", "prose", "parallel", "ordered", "grid", "sequence", "profile", "verbatim", "sections"]) }),
]);
export const CATALOG_IDS = Object.freeze(CATALOGS.map((entry) => entry.id));

/** One catalog's writer prompts, from production's captured ones: the system prompt's layout part swapped, the catalog added as data. */
export function writerPrompts(catalog, captured) {
  const suffix = `\n\n${ANSWER_LAYOUT_PROMPT}`;
  if (!captured.system_prompt.endsWith(suffix)) throw new Error("the captured writer prompt does not end with the production layout part");
  if (catalog.catalog_key === null) return { system_prompt: captured.system_prompt, user_prompt: captured.user_prompt };
  const base = captured.system_prompt.slice(0, -ANSWER_LAYOUT_PROMPT.length);
  const user = JSON.parse(captured.user_prompt);
  if (!Object.hasOwn(user, "source_catalog")) throw new Error("the captured writer input has no source_catalog");
  const entries = Object.entries(user).flatMap(([key, entry]) => (key === "source_catalog" ? [[key, entry], [catalog.catalog_key, catalog.catalog]] : [[key, entry]]));
  return { system_prompt: `${base}${catalog.layout_prompt}`, user_prompt: JSON.stringify(Object.fromEntries(entries)) };
}

/** A reply read by its catalog: whether it is valid, its problems, its common blocks, what it did not find, and the view the page draws. */
export function readReply(catalog, value) {
  const read = catalog.read(value);
  const view = catalog.id === "primitives" ? (read.tree === null || read.tree === undefined ? [] : [read.tree]) : viewOfBlocks(read.blocks);
  return Object.freeze({ ...read, view });
}
