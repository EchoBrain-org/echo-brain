import {
  PERSON_ANSWER_STATEMENT_MAX_BYTES_V4,
  PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4,
  personAnswerCitationKeyV8,
  validatePersonAnswerBlocksV2,
  type PersonAnswerResponseV8,
  type PersonAnswerPartV4,
  type PersonAskAnswerLayoutV2,
} from "@echo-brain/organization-api";
import {
  AGENTIC_ASK_MAX_SENTENCES_V1,
  AgenticAskOutputErrorV1,
  ANSWER_BLOCK_CATALOG,
  ANSWER_BLOCKS_PROMPT,
  ANSWER_SINCE_PROMPT,
  answerBlocksSchema,
  answerBlocksSinceSchema,
  answerSchema,
  answerSinceSchema,
  attributed,
  boundedBytes,
  cleanId,
  cleanLine,
  parseAnswer,
  parseBlocksAnswer,
  partQuestion,
  textItem,
  type Answer,
  type AnswerItem,
  type AnswerSentence,
} from "../agentic-ask-v1-model-protocol.js";
import { agenticAskAnswerSha256V1, agenticAskResponseFitsV1, compactAndValidateAgenticAskResponseV1 } from "../agentic-ask-v1-response.js";
import {
  agenticEvidenceAttributesV1, agenticEvidenceDatesV1, agenticEvidenceLabelV1, citationOfAgenticEvidenceItemV8, describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1,
  type AgenticEvidenceBundleV1,
} from "../agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_WRITER_LISTS_MAX_V1,
  agenticListCheckedNoteV1,
  agenticListFilterNoticeV1,
  agenticListUncheckedNoticeV1,
  agenticListMembershipV1,
  agenticListMembersNounV1,
  agenticListNameSharesV1,
  agenticListSelectionNotFoundV1,
  agenticListSelectionVerifiedV1,
  agenticListSelectV1,
  agenticListStatementV1,
  agenticListStatementsV2,
  agenticListTableV1,
  agenticNeedReadsListV1,
  agenticOpenReadsV1,
  agenticPlanListsV1,
  agenticWriterListMemberV1,
  agenticWriterListV1,
  parseAgenticListIdV1,
  type AgenticListIdV1,
  type AgenticListNounFormsV1,
  type AgenticListSelectionV1,
  type AgenticOpenReadsV1,
  type AgenticWriterListMemberV1,
  type AgenticWriterListV1,
} from "../agentic-list-evidence-v1.js";
import { AGENTIC_ASK_MIN_ANSWER_MS_V1, type AgenticModelCallV1 } from "../agentic-model-gate-v1.js";
import { callRendererModelV1, type AgenticRendererV1, type AgenticRenderInputV1 } from "../agentic-renderer-v1.js";
import { observeCoreModelCorrectionV1, type CoreRuntimeModelCorrectionV1 } from "../../shared/core-runtime-observation-v1.js";
import { buildAskBlocksV2, daysWrittenV2, orderAskBlocksV2, quoteIsWordForWordV2, type AskBlockStatementV2 } from "./ask-layout-v2.js";

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence and the lists research read, then code lays out one cited
 * paragraph. Code writes the statement that counts and names a list's
 * members, first in the paragraph (ADR-0041): for every list a which_items
 * need of the plan cites, whatever the writer replies, and for each list the
 * writer chooses. The writer's sentences follow, each standing only on text it
 * read. With no usable writer reply code still states those lists, or falls
 * back to the records research read, or says what it could not find. An
 * Ask that asked for answer layout v2 (ADR-0051) gives its writer the block
 * catalog beside the source catalog; code reads each item of its blocks as one
 * statement, checked against what it cites. Its answer reads answer first and
 * its part carries the blocks its kept statements read as, or, when that cannot
 * be released, it is the answer the same reply gives without them.
 */

const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
/** An empty list whose date filter could not test some items (research tool contract v1): none of those it tested matched. */
const UNCHECKED_EMPTY_GAP = "None of the items that record the date asked for matched.";
const RECORDS_GAP = "I found these records, but could not write a verified summary.";
const INCOMPLETE_SEARCH_GAP = "I couldn't complete the search. Please try again.";
const READ_ONLY_GAP = "Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.";
const INCOMPLETE_SEARCH_NOTICE = "Research stopped before it finished, so relevant context may be missing.";
const LIMITED_COVERAGE_GAP = "Some source coverage was incomplete, so relevant context may be missing.";
const LIST_FALLBACK_GAP = "I found these items, but could not write the rest of the answer.";
const UNCHECKED_GAP = "Not every listed item was checked, so others may also match.";
const WHICH_GAP = "I could not confirm the full list of items asked for.";
const UNSUPPORTED_GAP = "Part of the answer was left out because no item's text supports it.";
/** The writer's one repair for a sentence resting on list rows or list ids alone. */
const ROWS_REASON = "a sentence cites list rows or list ids but no evidence text: code states which items exist, and members' title, dates, status and owner, through \"lists\" (with \"where\" or \"members\"); what no evidence text says belongs in \"not_found\"";
const FIT_GAP = "Some evidence could not fit in this response.";
/** A list that is not complete: its statement says "at least" (ADR-0041). */
function listEndGap(noun: string): string { return `The list of ${noun} could not be read to its end, so more may exist.`; }
/** The response's bounds, unchanged by lists: 40 citations and ten statements in a part, but in one arranged in blocks (ADR-0051). */
const MAX_CITATIONS = 40;
const MAX_STATEMENTS = AGENTIC_ASK_MAX_SENTENCES_V1;
/** The writer runs in Ask's answer span; the audit records it as an `answer` call. */
const WRITER_CALL: AgenticModelCallV1 = Object.freeze({ role: "answer", span: "ask_answer" });
/** A v2 Ask's writer arranges its answer in blocks (ADR-0051), a row's cells and an event's day among them: a longer reply. */
const LAYOUT_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_000 });
/** An Ask again's writer (ADR-0047) also says what is different since: room for its sentences beside the answer. */
const SINCE_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_000 });
const LAYOUT_SINCE_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_500 });
/**
 * A writer by the answer layout its Ask asked for: none or v2 (ADR-0051). Each has the part of the prompt after Ask's
 * own, what it adds to the writer's input, and its reply's schema and call, asked once or again (ADR-0047).
 */
const WRITERS = Object.freeze({
  none: { prompt: [], context: {}, schema: answerSchema, since_schema: answerSinceSchema, call: WRITER_CALL, since_call: SINCE_WRITER_CALL },
  2: { prompt: [ANSWER_BLOCKS_PROMPT], context: { block_catalog: ANSWER_BLOCK_CATALOG }, schema: answerBlocksSchema, since_schema: answerBlocksSinceSchema, call: LAYOUT_WRITER_CALL, since_call: LAYOUT_SINCE_WRITER_CALL },
});

type Entry = AgenticEvidenceBundleItemV1;
/** A statement's shape before its citations are known: prose, or a list statement's table, whose rows name the items they cite. */
type DraftShape = { readonly kind: "text" } | {
  readonly kind: "list"; readonly caption: string; readonly columns: readonly string[];
  readonly group?: number;
  readonly rows: readonly { readonly cells: readonly string[]; readonly shorts: readonly string[] }[];
};
const PROSE: DraftShape = Object.freeze({ kind: "text" });

export interface AskRendererInputV1 {
  readonly question: string;
}
export interface AskRenderedV1 {
  readonly response: PersonAnswerResponseV8;
  /** Short ids the writer was given, in order: items whose text it read, then list rows it saw; empty when no writer call ran. */
  readonly writer_evidence: readonly string[];
}

/**
 * The earlier answer an Ask again compares with (ADR-0047): the day it was asked, in the request's time zone, and its
 * sentences, each with the labels of the sources it cited. The asker's own context, never evidence.
 */
export interface AskEarlierAnswerV1 {
  readonly asked_on: string;
  readonly statements: readonly { readonly text: string; readonly sources: readonly string[] }[];
}

/** Ask's writer, for the V8 answer (research tool contract v1), the only Ask answer. */
export interface CreateAskRendererV1Options {
  /** The writer's system prompt, with the live-source guidance when live sources are available. */
  readonly answer_prompt: string;
  /** The sources research could read, as the research model saw them. */
  readonly source_catalog: readonly Readonly<Record<string, unknown>>[];
  /** What the writer is told the desk reads. */
  readonly scope: string;
  /** Who is asking and today's date. */
  readonly context: { readonly asked_by?: string; readonly today: string; readonly time_zone?: string };
  /** The response's scope: the desk's. */
  readonly desk_scope: AgenticEvidenceBundleV1["gathered_for"]["scope"];
  /** The part carries its blocks (answer layout v2, ADR-0051), because the client asked for them. */
  readonly layout?: PersonAskAnswerLayoutV2;
  readonly include_gap_details?: true;
  /**
   * For an Ask that carried its previous turn (ADR-0047): the full question the answer answers, which the response names.
   * Without it the response names none.
   */
  readonly answers?: string;
  /** For an Ask again (ADR-0047): the earlier answer; the writer also says what is different since, and the response carries it. */
  readonly earlier?: AskEarlierAnswerV1;
}

function bytes(value: string | undefined): number { return value === undefined ? 0 : Buffer.byteLength(value, "utf8"); }

/** Statements or records as the response carries them: each its text, citation indexes and privacy, frozen. */
function released(statements: readonly { readonly text: string; readonly citation_indexes: readonly number[]; readonly private: boolean }[]) {
  return Object.freeze(statements.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private })));
}

/**
 * Items research checked (addition 4, ADR-0041): read in full, or opened by an
 * open that was not truncated, carried no notice or error, and returned only
 * bodies research then read in full. A list member's row is checked through
 * the open of that row, whose bodies may have new ids. A limited open leaves
 * it unchecked until a later clean open.
 */
function checkedItems(bundle: AgenticEvidenceBundleV1, opens: AgenticOpenReadsV1): ReadonlySet<string> {
  return new Set([...opens.clean, ...bundle.items.filter(entry => entry.full && !opens.limited.has(entry.short)).map(entry => entry.short)]);
}

/** The sentence with code's note before its closing punctuation. */
function withNote(text: string, note: string): string {
  const end = /[.!?]+$/u.exec(text);
  return end === null ? `${text} ${note}` : `${text.slice(0, end.index).trimEnd()} ${note}${end[0]}`;
}
function privateItem(item: Entry["item"]): boolean {
  return item.visibility === "only_me" || item.visibility === "approver_only";
}

/** Lowercase, each run of spaces one space: how a member's name is matched in a statement. */
function folded(value: string): string { return value.toLowerCase().replace(/\s+/gu, " ").trim(); }
/** A ticket-style key ("THERM-2", "OPS-17"): only such a key names a member short of its whole title. */
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/u;
/** The names a list member goes by as the writer saw it listed: its whole title, and a ticket-style key, its own or the one its title leads with ("THERM-2: Fixture work 2"). */
function memberNames(member: Pick<AgenticWriterListMemberV1, "title" | "key">): readonly string[] {
  const leading = /^([^\s:]+): /u.exec(member.title)?.[1];
  return [member.title, ...[member.key, leading].filter((name): name is string => name !== undefined && TICKET_KEY.test(name))];
}
/** Whether `text` holds `name` whole, in any case: never inside a longer word or number ("THERM-12" holds no "THERM-1"). */
function holdsName(text: string, name: string): boolean {
  const said = folded(text), wanted = folded(name);
  if (wanted.length === 0) return false;
  for (let at = said.indexOf(wanted); at >= 0; at = said.indexOf(wanted, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(said[at - 1] ?? " ") && !/[\p{L}\p{N}]/u.test(said[at + wanted.length] ?? " ")) return true;
  }
  return false;
}
/**
 * Whether a statement's text names list member `member`: it holds one of the member's names whole, and names no other
 * member of the list (`members`) whose name holds that one. A text naming "Launch checklist" or "Q4: Budget" may be about
 * that member, not "Launch" or "Q4: Planning", so it names neither of those: the binding is ignored, and code states the
 * member, never hides it.
 */
function namesMember(text: string, member: AgenticWriterListMemberV1, members: readonly AgenticWriterListMemberV1[]): boolean {
  const said = memberNames(member).filter(name => holdsName(text, name));
  return said.length > 0 && !members.some(other => other.id !== member.id
    && memberNames(other).some(name => holdsName(text, name) && said.some(own => holdsName(name, own))));
}

/**
 * A completed answer can report source coverage separately from a requested
 * fact gap. A limited open matters when it requested or returned a cited body;
 * a later clean open of that same returned body resolves the limitation.
 */
function coverageIsLimitedFor(bundle: AgenticEvidenceBundleV1, used: readonly Entry[]): boolean {
  const usedIds = new Set(used.map(entry => entry.short));
  const limited = new Set<string>();
  const resolved = new Set<string>();
  for (const round of bundle.rounds) for (const action of round.actions) {
    if (action.tool !== "open") continue;
    const requested = typeof action.args.id === "string" ? action.args.id : undefined;
    const citedBodies = action.result.opened.filter(id => usedIds.has(id));
    const relevant = [...(requested !== undefined && usedIds.has(requested) ? [requested] : []), ...citedBodies];
    if (relevant.length === 0) continue;
    const limitedOpen = action.result.truncated === true || action.result.notice === true || action.result.error !== undefined;
    if (limitedOpen) for (const id of relevant) limited.add(id);
    // Only a body returned by a clean open resolves a limited returned body.
    if (!limitedOpen) for (const id of citedBodies) resolved.add(id);
  }
  return [...limited].some(id => !resolved.has(id));
}

type Cited = readonly { readonly citation_indexes: readonly number[] }[];
/**
 * Blocks of a layout that pass the contract (`validate`) against the part's statements, or none: layout adds no claim, so
 * an answer whose layout code could not build reads as it would without one rather than failing.
 */
function contracted<B>(validate: (blocks: readonly B[], statements: Cited, citations: number) => readonly B[], blocks: readonly B[], statements: Cited, citations: number): readonly B[] | undefined {
  try { return validate(blocks, statements, citations); } catch { return undefined; }
}

export function createAskRendererV1(options: CreateAskRendererV1Options): AgenticRendererV1<AskRendererInputV1, AskRenderedV1> {
  /** Layout v2 (ADR-0051): the writer arranges its answer from the block catalog. */
  const arranged = options.layout === 2;
  const writer = WRITERS[options.layout ?? "none"];
  const earlier = options.earlier;
  const timeZone = options.context.time_zone ?? 'UTC';
  return Object.freeze({
    async render(input: AgenticRenderInputV1<AskRendererInputV1>) {
      const { bundle } = input;
      const askedQuestion = input.trigger_input.question;
      const researchIncomplete = !bundle.stop.completed;
      const unsupportedAction = bundle.stop.unsupported_action === true;
      const byShort = new Map(bundle.items.map(entry => [entry.short, entry]));
      const entryOf = (short: string): Entry | undefined => {
        const id = cleanId(short);
        return id === null ? undefined : byShort.get(id);
      };
      const describe = (entry: Entry) => describeAgenticEvidenceItemV1(entry, timeZone);
      /**
       * The days an item records or writes, for a v2 timeline's check (ADR-0051): its dates as `describe` shows them to the
       * writer, in the request's time zone, and every day its title, text or attributes write, a month and day with no year
       * read as the nearest such day to one the item records, or to today when it records none.
       */
      const daysOf = (entry: Entry): ReadonlySet<string> => {
        const { dates, date } = agenticEvidenceDatesV1(entry.item, timeZone);
        const recorded = [...new Set([...Object.values(dates ?? {}), date].flatMap(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) ? [value.slice(0, 10)] : []))];
        const anchors = recorded.length === 0 ? [options.context.today] : recorded;
        const written = [agenticEvidenceLabelV1(entry.item, timeZone), entry.item.text, ...Object.values(agenticEvidenceAttributesV1(entry.item, timeZone) ?? {})]
          .flatMap(value => typeof value === "string" ? [...daysWrittenV2(value, anchors)] : []);
        return new Set([...recorded, ...written]);
      };

      // ---- lists (ADR-0041): what the plan's declared kinds ask of them, and how the writer sees them ----
      const lists = bundle.lists ?? [];
      const listById = new Map(lists.map(list => [list.id, list]));
      /** Which list member an item is, or is part of: an opened page's section is its page. */
      const membership = agenticListMembershipV1(lists, bundle.items);
      const needs = bundle.plan.flatMap(part => part.needs);
      // The lists the plan's declared kinds read: those its which_items needs cite, which code states (W3), and those its
      // which_say needs cite, which research checks (W5), and whether one of them cites none (W3). The kinds alone decide;
      // what a need cites beside them never does.
      const { stated, checking, unlisted } = agenticPlanListsV1(needs, id => listById.has(id));
      const checked = checkedItems(bundle, agenticOpenReadsV1(bundle.rounds, short => byShort.get(short)?.full === true));
      const rows = new Map(lists.map(list => [list.id, list.members.map(short => agenticWriterListMemberV1(byShort.get(short)!, checked.has(short), options.context.time_zone))]));
      // A which_items need research has not given up on, found or still open when research stopped, requests its members,
      // as it states its lists (agenticNeedReadsListV1); an interrupted answer stays partial. Its E ids request those members
      // of each list it cites, opened bodies mapped back to their rows. Only a need that cites no member declares its lists,
      // each the fallback when the writer selects none of it: a need citing members never brings another list's inventory.
      // Each L-only need keeps its declared-list fallback even when another need selects specific members of that list.
      // Within one need, a member is requested once: of the first list it cites, in its own order, that holds the member.
      const listNeeds = needs.flatMap(need => {
        if (need.kind !== "which_items" || !agenticNeedReadsListV1(need)) return [];
        const cited = [...new Set(need.evidence)].flatMap(id => listById.has(id as AgenticListIdV1) ? [id as AgenticListIdV1] : [])
          .map(id => ({ id, members: [...new Set(need.evidence.flatMap(short => membership.in(id, short) ?? []))] }));
        return [{ cited, declares: cited.every(list => list.members.length === 0) }];
      });
      /** The members research requests of each list, as the writer is told them. */
      const requestedByList = new Map(lists.map(list => [list.id, [] as string[]]));
      for (const need of listNeeds) {
        const placed = new Set<string>();
        for (const { id, members } of need.cited) {
          const requested = requestedByList.get(id)!;
          for (const member of members) {
            if (placed.has(member)) continue;
            placed.add(member);
            if (!requested.includes(member)) requested.push(member);
          }
        }
      }
      const viewOf = (list: (typeof lists)[number], cap?: number) => ({ ...agenticWriterListV1(list, rows.get(list.id)!, stated.includes(list.id), cap),
        ...(requestedByList.get(list.id)!.length === 0 ? {} : { requested_members: requestedByList.get(list.id)! }),
      });
      /** Every list as code reads it: code states, notes and filters each list the plan's kinds read, past the writer's bound too. */
      const views = new Map(lists.map(list => [list.id, viewOf(list)]));
      // The writer sees at most 5 lists, the plan's first.
      const writerOrder = [...new Set([...stated, ...checking, ...lists.map(list => list.id)])].slice(0, AGENTIC_LIST_WRITER_LISTS_MAX_V1).map(id => listById.get(id)!);
      const writerListsWith = (cap: number) => writerOrder.map(list => viewOf(list, cap));
      /** What a list's members are called: their desk kinds, after the catalog's tool (ADR-0041); an empty list's, its kind filter's. */
      const nounOf = (list: AgenticWriterListV1) => {
        const tool = options.source_catalog.find(entry => entry.source === list.source)?.tool_id;
        const members = rows.get(list.id)!.map(member => member.kind);
        return agenticListMembersNounV1({ selector: list.source, ...(typeof tool === "string" ? { tool_id: tool } : {}) },
          members.length === 0 && list.filter.kind !== undefined ? [list.filter.kind] : members);
      };

      // ---- final answer ---------------------------------------------------
      // A page with more rows is not a truncated final list. Keep page history
      // in diagnostics; give the writer the final state of each filtered list.
      // Failed reads and notices still matter, including reads with no list.
      const listedSources = new Set(lists.map(list => list.source));
      const reads = [
        ...bundle.coverage.reads.filter(read => read.tool !== "list" || read.unavailable || read.notice || !listedSources.has(read.source)),
        ...lists.map(list => ({
          tool: "list", list: list.id, source: list.source, filter: list.filter,
          returned_items: list.members.length, complete: list.complete, truncated: list.truncated,
          notice: false, unavailable: !list.available,
        })),
      ];
      const answerContext = {
        // An Ask again's writer reads the earlier answer beside the question (ADR-0047); no other writer's input changes.
        question: askedQuestion, ...(earlier === undefined ? {} : { earlier }), ...options.context, scope: options.scope, source_catalog: options.source_catalog,
        // A v2 Ask's writer picks its blocks from a catalog beside the sources' (ADR-0051).
        ...writer.context,
        // Planner need text is intentionally excluded. Lists carry their filters (ADR-0041); this describes what
        // research read, not whether an arbitrary fact exists.
        research: {
          completed: !researchIncomplete, stop_reason: bundle.stop.reason, reads,
          notices: [...bundle.coverage.notices], omitted_evidence_items: bundle.items.filter(entry => entry.item.text !== undefined).length,
        },
      };
      // A v2 Ask's writer is also told how to arrange blocks (ADR-0051), and an Ask again's what to say is different since
      // (ADR-0047); each has a longer reply's room. No other writer's prompt changes.
      const writerPrompt = [options.answer_prompt, ...writer.prompt, ...(earlier === undefined ? [] : [ANSWER_SINCE_PROMPT])].join("\n\n");
      const writerCall = earlier === undefined ? writer.call : writer.since_call;
      const writerSchema = earlier === undefined ? writer.schema : writer.since_schema;
      const promptBudget = writerCall.output_tokens === undefined ? input.prompt_budget(writerPrompt) : input.prompt_budget(writerPrompt, writerCall.output_tokens);
      const contextBudget = Math.max(0, promptBudget - bytes(JSON.stringify({ ...answerContext, lists: [], evidence: [] })));
      // Lists' rows take at most half the room; a smaller window shows fewer members of each, never fewer lists.
      // The largest per-list cap that fits (binary search), so no list loses rows that would have fit.
      const fits = (cap: number) => bytes(JSON.stringify(writerListsWith(cap))) <= contextBudget / 2;
      let low = 0, high = Math.max(0, ...writerOrder.map(list => list.members.length));
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
      const writerLists: readonly AgenticWriterListV1[] = writerListsWith(low);
      const writerBudget = Math.max(0, contextBudget - bytes(JSON.stringify(writerLists)));
      const writerById = new Map(writerLists.map(list => [list.id, list]));
      // What the plan cites and research read in full, in the plan's order.
      const cited = [...new Set(bundle.plan.flatMap(part => part.needs.flatMap(need => need.evidence)))].map(short => entryOf(short)).filter((entry): entry is Entry => entry?.cited_by_plan === true);
      const evidence: Entry[] = []; let evidenceBytes = 0;
      const admit = (entry: Entry) => {
        const cost = bytes(JSON.stringify({ ...describe(entry), text: entry.item.text })) + 1;
        if (evidence.includes(entry) || evidenceBytes + cost > writerBudget) return;
        evidence.push(entry); evidenceBytes += cost;
      };
      for (const entry of cited) admit(entry);
      for (const entry of bundle.items.filter(value => value.full).sort((left, right) => right.touched - left.touched)) admit(entry);
      // Search already released these passage bodies through the desk. The writer
      // can read them even when research stopped at their previews; `full` still
      // records what research read, not what the writer is allowed to read now.
      for (const entry of bundle.items.filter(value => !value.full && value.item.text !== undefined).sort((left, right) => right.touched - left.touched)) admit(entry);
      answerContext.research.omitted_evidence_items = bundle.items.filter(entry => entry.item.text !== undefined && !evidence.includes(entry)).length;
      /** Items whose text the writer reads, and list members it sees as rows only. */
      const textGiven = new Set(evidence.map(entry => entry.short));
      const shownRows = new Set(writerLists.flatMap(list => list.members.map(member => member.id)).filter(short => !textGiven.has(short)));
      const writerShown: readonly string[] = Object.freeze([...evidence.map(entry => entry.short), ...shownRows]);
      input.on_context?.(writerShown);

      // ---- the writer's sentences rest on text (W1) -------------------------
      /** A sentence resting on list rows or list ids: it cites one the writer saw, and no evidence text it read. */
      const restsOnRows = (sentence: AnswerSentence) => !sentence.evidence.some(short => textGiven.has(short)) &&
        sentence.evidence.some(id => shownRows.has(id) || writerById.has(parseAgenticListIdV1(id) ?? "L0"));
      /**
       * Each selection by id as the list members it names: an opened body or section is the member it is part of, as research
       * and the bindings read it, and an id outside the list names none. One that names no member is its where, when it
       * has one, and otherwise no selection, except an explicit empty one in a reply that says what it did not find: that
       * says no member of the list answers.
       */
      const withMembers = (answer: Answer): Answer => Object.freeze({ ...answer, lists: Object.freeze(answer.lists.flatMap(use => {
        if (use.members === undefined) return [use];
        const named = use.members.map(id => membership.in(use.id, id));
        const unknown = named.filter(member => member === undefined).length;
        if (unknown > 0) observeCoreModelCorrectionV1("writer_unknown_id_dropped", unknown);
        const members = [...new Set(named.flatMap(member => member ?? []))];
        if (members.length > 0) return [Object.freeze({ id: use.id, members: Object.freeze(members) })];
        if (use.where !== undefined) return [Object.freeze({ id: use.id, where: use.where })];
        return use.members.length === 0 && answer.not_found.length > 0 ? [Object.freeze({ id: use.id, members: Object.freeze([]) })] : [];
      })) });
      // A sentence resting on rows or list ids takes the writer's one repair when a repair can still run; the repaired
      // reply, or a first reply no repair can follow, is kept, and code leaves such a sentence out.
      const callsBefore = input.gate.stats().calls;
      /** The last reply parsed: kept when the repair's reply is unusable. */
      const last: { answer: Answer | null } = { answer: null };
      const repairable = () => {
        const stats = input.gate.stats();
        return stats.calls === callsBefore + 1 && stats.calls < bundle.budget.max_model_calls && input.remaining() >= AGENTIC_ASK_MIN_ANSWER_MS_V1;
      };
      const parse = (value: unknown): Answer => {
        const since = earlier === undefined ? {} : { since: true };
        const parsed = withMembers(arranged ? parseBlocksAnswer(value, since) : parseAnswer(value, since));
        last.answer = parsed;
        if (parsed.sentences.some(restsOnRows) && repairable()) throw new AgenticAskOutputErrorV1(ROWS_REASON);
        return parsed;
      };

      const writerRuns = evidence.length > 0 || writerLists.some(list => list.count > 0);
      const written = !writerRuns ? null : await callRendererModelV1(input, writerCall, writerPrompt, {
        ...answerContext,
        lists: writerLists,
        // Working hypotheses are not user requirements or evidence. The
        // writer assesses the original question against released text.
        evidence: evidence.map(entry => ({ ...describe(entry), text: entry.item.text })),
      }, writerSchema, parse);
      // A reply sent back only for a sentence resting on rows is still the writer's answer; code leaves that sentence out.
      const answer = written === null ? null : written.value ?? last.answer;
      if (written?.value === null) observeCoreModelCorrectionV1("writer_fallback");
      const writerEvidence: readonly string[] = written === null ? [] : writerShown;

      // ---- layout (code, not model): one part, read as one paragraph ------
      type Statement = { text: string; citation_indexes: number[]; private: boolean };
      // One citation per key, the key the Ask response checks for duplicates: a listed ticket's row and its opened body
      // are two items with one key, so they share one citation.
      const keyOf = (short: string) => personAnswerCitationKeyV8(byShort.get(short)!.item.citation);
      /** Whether a statement citing `shorts` would cite more items than one statement may, in blocks too (ADR-0051). */
      const overCited = (shorts: readonly string[]) => new Set(shorts.map(keyOf)).size > PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4;
      const question = partQuestion(askedQuestion);
      /**
       * The response `reply` (the writer's answer, or null) gives, in blocks (`laid`, ADR-0051) or not, with an Ask again's
       * `since` (ADR-0047) or without it, and the items its citations cite, in order. Each call reads the reply afresh; only
       * the first counts the writer's corrections (`count`).
       */
      const respond = (reply: Answer | null, laid: boolean, count: boolean, withSince: boolean) => {
        const correct = (correction: CoreRuntimeModelCorrectionV1, times?: number) => { if (count) observeCoreModelCorrectionV1(correction, times); };
        const used: Entry[] = [];
        const usedKeys = new Map<string, number>();
        /** Citation indexes of `shorts`, each once; a new cited object becomes the next citation. */
        const cite = (shorts: readonly string[]): number[] => {
          const indexes: number[] = [];
          for (const short of shorts) {
            const key = keyOf(short);
            if (!usedKeys.has(key)) { usedKeys.set(key, used.length); used.push(byShort.get(short)!); }
            const index = usedKeys.get(key)!;
            if (!indexes.includes(index)) indexes.push(index);
          }
          return indexes;
        };
        /** A statement or record from cited ids: private exactly when one of its citations is. */
        const statementOf = (text: string, shorts: readonly string[]): Statement => {
          const indexes = cite(shorts);
          return { text, citation_indexes: indexes, private: indexes.some(index => privateItem(used[index]!.item)) };
        };

        // ---- statements (W2, W3): each list's use that says which items exist, then its use by id ----
        /** One statement of a list; `which` when it says which items exist (a use in full or by `where`), never for a use by id alone. */
        type Naming = { readonly list: AgenticWriterListV1; readonly noun: AgenticListNounFormsV1; readonly selected: readonly AgenticWriterListMemberV1[]; readonly which: boolean; readonly where?: AgenticListSelectionV1; readonly by_id: boolean };
        // Only a list the writer saw can carry its selection; a use of another is counted as unknown below.
        const uses = (reply?.lists ?? []).filter(use => writerById.has(use.id));
        /** What the lists add to the gap, in order; `partial` when its rule makes the part partial whatever it names (W1, W2, W3). */
        const listGaps: { readonly text: string; readonly partial: boolean }[] = [];
        const writerGaps: { readonly text: string; readonly partial: boolean }[] = [];
        const selectionNotFound: { readonly text: string; readonly confirmed: boolean }[] = [];
        /** Each explicit empty selection the answer keeps, and whether its list confirms that no member answers. */
        const explicitNones: boolean[] = [];
        // ---- the writer's sentences (W1, W3, W4, W5) ---------------------------
        // A which_say list whose members were not all checked qualifies every sentence citing its members' text (W5).
        const unchecked = checking.map(id => views.get(id)!).filter(list => agenticListCheckedNoteV1(list) !== undefined);
        if (unchecked.length > 0) writerGaps.push({ text: UNCHECKED_GAP, partial: false });
        if (unlisted) writerGaps.push({ text: WHICH_GAP, partial: true });
        const sentences = reply?.sentences ?? [];
        // A sentence the kept reply still rests on rows or list ids is left out, and the part says so, never what it claimed.
        if (sentences.some(restsOnRows)) writerGaps.push({ text: UNSUPPORTED_GAP, partial: true });
        // It stands on the items whose text the writer read (W1); after them, never as support, it cites the rows whose facts it
        // may carry: each row it cites that the writer saw, and each private row the writer saw of a list it cites (W6).
        const rowsOf = (id: string) => shownRows.has(id) ? [id] : writerById.get(parseAgenticListIdV1(id) ?? "L0")?.members.map(member => member.id).filter(short => privateItem(byShort.get(short)!.item)) ?? [];
        /** The sentence with code's note (W5) within a statement's 4 KiB: one too long to take the note whole, a wide row, is cut, never the note. */
        const fittedNote = (text: string, note: string) => {
          const whole = withNote(text, note);
          if (bytes(whole) <= PERSON_ANSWER_STATEMENT_MAX_BYTES_V4) return whole;
          correct("model_text_truncated");
          return `${boundedBytes(text, PERSON_ANSWER_STATEMENT_MAX_BYTES_V4 - bytes(` ${note}`))} ${note}`;
        };
        /** A writer's or `since` sentence as code keeps it: on the text the writer read (W1), then the rows it may carry, noted (W5); or none. */
        const drafted = (sentence: Pick<AnswerSentence, "text" | "evidence">) => {
          const read = sentence.evidence.filter(short => textGiven.has(short));
          if (read.length === 0) { correct("writer_uncited_sentence_dropped"); return undefined; }
          // An id that is no text, row or list the writer saw cites nothing.
          const unknown = sentence.evidence.filter(id => !textGiven.has(id) && !shownRows.has(id) && !writerById.has(parseAgenticListIdV1(id) ?? "L0")).length;
          if (unknown > 0) correct("writer_unknown_id_dropped", unknown);
          const notes = unchecked.filter(list => read.some(short => membership.in(list.id, short) !== undefined)).map(list => agenticListCheckedNoteV1(list)!);
          return { text: notes.length === 0 ? sentence.text : fittedNote(sentence.text, notes.join(" ")), shorts: [...read, ...sentence.evidence.flatMap(rowsOf)], read, noted: notes.length > 0 };
        };
        /**
         * A v2 item as code checks it against the evidence text it stands on (ADR-0051): a quote that is not word for word in
         * the title or text of one it cites reads as text, its source and words without quotation marks; an event whose day
         * is not one they record or write reads as text without that day. An item that stands on no text is left out (W1).
         */
        const verified = (sentence: AnswerSentence): AnswerSentence => {
          const item = sentence.item;
          const read = sentence.evidence.flatMap(short => textGiven.has(short) ? [byShort.get(short)!] : []);
          if (item === undefined || read.length === 0) return sentence;
          if (item.kind === "quote" && !quoteIsWordForWordV2(item.text, read.flatMap(entry => [agenticEvidenceLabelV1(entry.item, timeZone), entry.item.text ?? ""]))) {
            correct("writer_quote_unquoted");
            return { ...sentence, text: attributed(item.from, item.text), item: textItem(item) };
          }
          if (item.kind === "event" && !read.some(entry => daysOf(entry).has(item.date))) {
            correct("writer_event_undated");
            return { ...sentence, text: attributed(item.who, item.text), item: textItem(item) };
          }
          return sentence;
        };
        /** How a v2 item reads: one whose sentence carries code's note reads as text when its block shows other fields than its sentence, so the note shows. */
        const itemShape = (item: AnswerItem, noted: boolean): AnswerItem => !noted || item.kind === "answer" || item.kind === "text" || item.kind === "point" ? item : textItem(item);
        /** A statement as code lays it out; a writer's item also keeps the ids it cites that the writer saw, text or rows, and the member it declares. */
        type Laid = { text: string; shorts: readonly string[]; read?: readonly string[]; cites?: readonly string[]; shape: DraftShape; item?: AnswerItem; member?: string };
        const writerSentences: Laid[] = sentences.flatMap(given => {
          // Only a v2 reply's sentences are items.
          const sentence = verified(given);
          const kept = drafted(sentence);
          return kept === undefined ? [] : [{ text: kept.text, shorts: kept.shorts, read: kept.read, cites: sentence.evidence.filter(id => textGiven.has(id) || shownRows.has(id)), shape: PROSE,
            ...(sentence.item === undefined ? {} : { item: itemShape(sentence.item, kept.noted) }), ...(sentence.member === undefined ? {} : { member: sentence.member }) }];
        });

        const statementKeyOf = (sentence: Laid) => JSON.stringify([sentence.text, [...new Set(sentence.shorts.map(keyOf))].sort(), sentence.shorts.some(short => privateItem(byShort.get(short)!.item))]);
        // Only retained, grounded structured items can present a member. A citation alone is not a declaration. An item
        // presents member M of a list when the member it declares is M (an opened body or section is the member it is part
        // of), it cites one of M's ids, and its text names M as the writer saw M listed: its whole title or its ticket-style
        // key, and no other member whose name holds M's (namesMember). It may cite other members too, as a comparison or a
        // dependency does; an item about another member names that one, not M.
        // Blocks have no count bound; an oversized whole answer is recomposed without these bindings before its
        // legacy presentation bounds apply, so a dropped item can never suppress the research member floor.
        const presented = new Map<string, Set<string>>();
        const presentationKeys = new Set<string>();
        if (laid) for (const sentence of writerSentences) {
          const key = statementKeyOf(sentence);
          if (presentationKeys.has(key) || overCited(sentence.shorts)) continue;
          presentationKeys.add(key);
          if (sentence.member === undefined || (sentence.item?.kind !== "row" && sentence.item?.kind !== "point")) continue;
          for (const list of lists) {
            const member = membership.in(list.id, sentence.member);
            const row = member === undefined ? undefined : rows.get(list.id)!.find(value => value.id === member);
            if (row === undefined || !(sentence.cites ?? []).some(short => membership.in(list.id, short) === member) || !namesMember(sentence.text, row, rows.get(list.id)!)) continue;
            const members = presented.get(list.id) ?? new Set<string>();
            members.add(row.id); presented.set(list.id, members);
          }
        }
        // Research's which_items needs, found or still open when research stopped, preserve the requested member set. Their
        // L ids are inventories; their E ids identify the requested members, including opened bodies mapped back to listed rows.
        // A stated list shows the writer's valid selection, a use that names a member or carries a where, together with the
        // requested members it leaves out. If such a need declares only L and the writer selects none of that list, that
        // declared list is the fallback. A selection that names no member, given empty or left empty of ids outside the
        // list, is no selection, except an explicit empty one beside not_found: that says no member answers, which holds
        // only for a list research requested no member of, since its requested members are still stated.
        // Bindings never narrow a selection: a member the writer presents through a bound row or point is only not stated
        // again (naming, below). Inventories unrelated to a membership need never become answers merely because research
        // read them.
        // Within one need, each member it requests, by id or by declaring its lists, is stated once: where the writer
        // selected it in a list the need cites, otherwise under the first of those lists, in the need's order, that holds
        // it. Members different needs request keep a statement under each need's list; the writer's selections render
        // where the writer put them.
        const selectedIn = (id: AgenticListIdV1) => uses.filter(use => use.id === id)
          .flatMap(use => use.members ?? agenticListSelectV1(rows.get(id)!, use.where, views.get(id)!.filter.time_zone).map(member => member.id));
        const added = new Map<string, readonly string[]>();
        const whole = new Set<string>();
        for (const need of listNeeds) {
          const done = new Set(need.cited.flatMap(({ id }) => selectedIn(id)));
          for (const { id, members } of need.cited) {
            // The declared list, when the writer selects none of it.
            const declared = need.declares && !uses.some(use => use.id === id);
            const wanted = declared ? rows.get(id)!.map(member => member.id) : members;
            const fresh = wanted.filter(member => !done.has(member));
            for (const member of fresh) done.add(member);
            if (declared && fresh.length === wanted.length) whole.add(id);
            else added.set(id, [...new Set([...(added.get(id) ?? []), ...fresh])]);
          }
        }
        // The lists the writer selected members of, by id, in full or by a where, before code adds research's.
        const writerSelected = new Set<string>(uses.filter(use => use.members === undefined || use.members.length > 0).map(use => use.id));
        const restored = new Set<string>();
        for (const id of stated) {
          if (whole.has(id)) { uses.push({ id }); restored.add(id); continue; }
          const missing = added.get(id) ?? [];
          if (missing.length === 0) continue;
          const at = uses.findIndex(use => use.id === id && use.members !== undefined);
          if (!uses.some(use => use.id === id) && missing.length === views.get(id)!.count) uses.push({ id });
          else if (at < 0) uses.push({ id, members: missing });
          else uses[at] = { id, members: [...new Set([...uses[at]!.members!, ...missing])] };
          restored.add(id);
        }
        // Code states research's selection of a list the writer selected none of: the writer's not_found, which has no
        // per-list provenance, may be about those very members, so it stays untyped.
        const overridden = [...restored].some(id => !writerSelected.has(id));
        const usedLists = [...new Set(uses.map(use => use.id).filter(id => writerById.has(id) || restored.has(id)))].map(id => views.get(id)!);
        // A list whose date filter could not test some items (research tool contract v1) supports neither "none" nor "all" of
        // them: the part says how many were not checked, and is partial, even when the list is empty.
        let uncheckedEmpty = false;
        const presentedLists = stated.filter(id => presented.get(id)?.size).map(id => views.get(id)!);
        for (const list of [...new Set([...usedLists, ...presentedLists, ...checking.map(id => views.get(id)!)])]) {
          const text = agenticListUncheckedNoticeV1(list, nounOf(list));
          if (text === undefined) continue;
          listGaps.push({ text, partial: true });
          if (list.count === 0) uncheckedEmpty = true;
        }
        for (const list of presentedLists) if (!list.complete) listGaps.push({ text: listEndGap(nounOf(list).plural), partial: true });
        const unseen = (reply?.lists ?? []).filter(use => !writerById.has(use.id)).length;
        if (unseen > 0) correct("writer_unknown_id_dropped", unseen);
        const naming: Naming[] = usedLists.flatMap(list => {
          const id = list.id, all = rows.get(id)!, noun = nounOf(list);
          // Code never states again a member the writer presents through a bound row or point; it states the rest of the selection.
          const shown = presented.get(id);
          const unshown = (members: readonly AgenticWriterListMemberV1[]) => shown === undefined ? members : members.filter(member => !shown.has(member.id));
          const byId = uses.find(use => use.id === id && use.members !== undefined);
          const picked = byId === undefined ? undefined : all.filter(member => byId.members!.includes(member.id));
          const given = uses.find(use => use.id === id && use.members === undefined);
          const where = given?.where;
          const chosen = given === undefined ? undefined : agenticListSelectV1(all, where, list.filter.time_zone);
          // An explicit empty selection says no member answers, as a where that matches nothing does: only a complete list,
          // read to its end with every item tested, confirms it.
          const none = byId !== undefined && byId.members!.length === 0;
          if (none) explicitNones.push(list.complete && !list.unchecked?.count);
          // A use that says which items exist of a list that is not complete reads "at least", whatever it selects, and the part says so.
          if ((chosen !== undefined || none || (picked !== undefined && stated.includes(id))) && !list.complete) listGaps.push({ text: listEndGap(noun.plural), partial: true });
          // A use that says which items exist names them all; with some presented, it names the rest by id.
          const rest = (selected: readonly AgenticWriterListMemberV1[], which: Omit<Naming, "list" | "noun" | "selected">): Naming[] => {
            const left = unshown(selected);
            return left.length === 0 ? [] : left.length === selected.length ? [{ list, noun, selected, ...which }] : [{ list, noun, selected: left, which: false, by_id: true }];
          };
          // Two uses that select the same members are one statement, named by id, with the lead of the one that says which items exist.
          if (chosen !== undefined && chosen.length > 0 && picked !== undefined && chosen.length === picked.length && chosen.every(member => picked.includes(member))) return rest(picked, { which: true, ...(where === undefined ? {} : { where }), by_id: true });
          // A selection that names nothing is its not_found phrase (K); an empty list keeps the plain not-found answer.
          if (chosen?.length === 0 && where !== undefined) {
            const verified = agenticListSelectionVerifiedV1(all, where, list.filter.time_zone);
            if (!verified) listGaps.push({ text: "Some list items do not record the fact used to select them.", partial: true });
            selectionNotFound.push({ text: agenticListSelectionNotFoundV1(noun, list.filter, where),
              confirmed: list.complete && !list.unchecked?.count && verified });
          }
          return [
            ...(chosen === undefined || chosen.length === 0 ? [] : rest(chosen, { which: true, ...(where === undefined ? {} : { where }), by_id: false })),
            ...(picked === undefined || picked.length === 0 ? [] : rest(picked, { which: stated.includes(id) && picked.length === all.length, by_id: true })),
          ];
        });
        // Legacy answers share at most 25 names (W6). Blocks keep every member across bounded statements instead.
        const shares = agenticListNameSharesV1(naming);
        const listStatements = naming.flatMap((value, index) => {
          // An owner or status reads as the first selected member records it; a date range as the writer gave it.
          const where = value.where === undefined || !("value" in value.where) ? value.where : { field: value.where.field, value: value.selected[0]![value.where.field]! };
          const description = {
            noun: value.noun, filter: value.list.filter, count: value.list.count, complete: value.list.complete, selected: value.selected,
            ...(where === undefined ? {} : { where }), ...(value.by_id ? { by_id: true, which: value.which } : {}),
          };
          const statements = laid ? agenticListStatementsV2(description)
            : [agenticListStatementV1({ ...description, share: shares[index]!.share, free: shares[index]!.free })];
          if (statements.reduce((total, statement) => total + statement.cited.length, 0) < value.selected.length) listGaps.push({ text: FIT_GAP, partial: true });
          // Each named member cites its own row; in blocks, a statement naming two or more names is a table, a row per name.
          const table = !laid ? undefined : agenticListTableV1({ selected: value.selected, names: statements.flatMap(statement => statement.names), by_id: value.by_id, ...(value.list.filter.time_zone === undefined ? {} : { time_zone: value.list.filter.time_zone }) });
          let firstRow = 0;
          return statements.map(statement => {
            const shape: DraftShape = table === undefined ? PROSE : {
              kind: "list", caption: statement.caption, columns: table.columns, group: index,
              rows: table.rows.slice(firstRow, firstRow + statement.names.length).map(row => ({ cells: row.cells, shorts: row.members.map(at => value.selected[at]!.id) })),
            };
            firstRow += statement.names.length;
            return { text: statement.text, shorts: statement.cited.map(at => value.selected[at]!.id), shape };
          });
        });
        listGaps.push(...writerGaps);

        // List statements come first, then the writer's sentences, each kept whole or dropped with all after it to fit the bounds (W6).
        // What fits is decided in that order whatever the layout, so a long answer never crowds out a stated list (W3). An answer
        // arranged in blocks (ADR-0051) then reads what was kept answer first, then the lists, then the other items block by
        // block. It has no count of statements or citations of its own: only its byte bound,
        // whose fallback, an answer without blocks, keeps ADR-0041's, and the 40 citations one statement may carry. A statement
        // that would cite more, through the private rows its list id brings, is left out whole, never cut short of them, and
        // the statements after it are kept. ADR-0041's 40 for an answer leaves such a statement out first, with every one after it.
        const bounded = !laid;
        const statementKeys = new Set<string>();
        const keptReads: Entry[] = [];
        const fitted: Laid[] = [];
        const fittedKeys = new Set<string>();
        let dropped = false;
        for (const sentence of [...listStatements, ...writerSentences] as readonly Laid[]) {
          // Temporary model guardrail (ADR-0041): only exact text with the same cited objects and privacy is a repeat.
          // Shared sources or planner kinds never establish that two sentences say the same thing.
          const statementKey = statementKeyOf(sentence);
          if (statementKeys.has(statementKey)) {
            correct("writer_repeat_dropped");
            keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
            continue;
          }
          const fresh = new Set(sentence.shorts.map(keyOf).filter(key => !fittedKeys.has(key)));
          if (bounded && (fitted.length >= MAX_STATEMENTS || fittedKeys.size + fresh.size > MAX_CITATIONS)) { dropped = true; break; }
          if (overCited(sentence.shorts)) { dropped = true; continue; }
          statementKeys.add(statementKey);
          for (const key of fresh) fittedKeys.add(key);
          fitted.push(sentence);
          keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
        }
        const kept = new Set(fitted);
        // Only a writer that gave no answer block has its first item read as the answer (orderAskBlocksV2).
        const keptLists = listStatements.filter(entry => kept.has(entry));
        const order: readonly Laid[] = !laid ? fitted
          : orderAskBlocksV2(keptLists, writerSentences.filter((entry): entry is Laid & { item: AnswerItem } => kept.has(entry) && entry.item !== undefined), sentences.some(sentence => sentence.item?.kind === "answer"));
        const statements: Statement[] = order.map(sentence => statementOf(sentence.text, sentence.shorts));
        const notFound = [...(reply?.not_found ?? []), ...selectionNotFound.map(gap => gap.text)];
        // A list statement cites rows for which items exist; only the text the writer's sentences stand on can be limited coverage.
        const coverageLimited = coverageIsLimitedFor(bundle, keptReads);
        const incomplete = (reply === null && writerRuns) || (researchIncomplete && (statements.length === 0 || notFound.length > 0));
        const gapText = incomplete
          ? cleanLine(`${INCOMPLETE_SEARCH_GAP}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`, 600)
          : notFound.length === 0 ? undefined : cleanLine(`Not found: ${notFound.join("; ")}.`, 600);
        // What the lists add to the gap: a list not read to its end, a which_say list not fully checked, a list kind with no
        // list, a sentence left out for resting on rows, and what did not fit.
        const extraGaps = [...new Set([...listGaps.map(gap => gap.text), ...(dropped ? [FIT_GAP] : [])])];
        const withGaps = (base: string | undefined) => {
          // Keep capability and unfinished-research explanations ahead of variable-length missing-fact text.
          const gaps = [...(unsupportedAction ? [READ_ONLY_GAP] : []),
            ...(unsupportedAction && researchIncomplete && !base?.startsWith(INCOMPLETE_SEARCH_GAP) ? [INCOMPLETE_SEARCH_NOTICE] : []),
            ...(base === undefined ? [] : [base]), ...extraGaps];
          return gaps.length === 0 ? undefined : cleanLine(gaps.join(" "), 600);
        };
        type Draft = { status: PersonAnswerPartV4["status"]; statements: Statement[]; gap?: string; records?: Statement[] };
        let draft: Draft;
        if (statements.length > 0) {
          // With no usable writer reply, code stated the lists the plan's which_items needs cite (ADR-0041).
          const gap = withGaps(reply === null ? LIST_FALLBACK_GAP : gapText);
          draft = gap === undefined ? { status: "answered", statements } : { status: "partial", statements, gap };
        } else {
          // Honor a completed writer's no-match result instead of substituting research-selected records.
          // Raw fallback remains limited to research-read evidence; merely sending
          // a search passage to a failed writer does not make it a useful answer.
          const fallback = notFound.length > 0 ? [] : (reply === null ? evidence.filter(entry => entry.full) : cited.filter(entry => textGiven.has(entry.short))).slice(0, 3);
          const records = fallback.map(entry => statementOf(entry.item.text!, [entry.short]));
          draft = records.length > 0
            ? { status: "records_only", statements: [], records, gap: withGaps(RECORDS_GAP)! }
            : { status: "not_found", statements: [], gap: withGaps(gapText ?? (unsupportedAction && needs.length === 0 ? undefined : uncheckedEmpty ? UNCHECKED_EMPTY_GAP : NOT_FOUND_GAP))! };
        }
        const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
        // A writer's missing text has no per-need provenance, so incomplete coverage of a list a need still asks about leaves
        // it unproven, as it does a where selection over such a list: an unchecked declared content list, or, for a which_items
        // need not found (not_found or open), a list it cites, or every list when it cites none, that was not read to its end
        // or whose filter could not test every item. A found need's list reads "at least" and never blocks it.
        const coverageIncomplete = (list: (typeof lists)[number]) => !list.complete || (list.unchecked?.count ?? 0) > 0;
        const unconfirmedAbsence = unchecked.length > 0 || checking.some(id => (views.get(id)!.unchecked?.count ?? 0) > 0)
          || needs.some(need => {
            if (need.kind !== "which_items" || need.status === "found") return false;
            const cited = need.evidence.flatMap(id => listById.get(parseAgenticListIdV1(id) ?? "L0") ?? []);
            return (cited.length === 0 ? lists : cited).some(coverageIncomplete);
          });
        // What the person is told about the filters of every list the answer uses, and of those which_say needs check (W7).
        const filterNotices = [...new Set([...usedLists, ...checking.map(id => views.get(id)!)])].flatMap(list => agenticListFilterNoticeV1(list, nounOf(list).plural) ?? []);
        // A completed answer can retain source coverage as a notice. A stop
        // becomes a notice only when the rendered answer has no existing gap.
        const responseNotices = [
          ...new Set([...bundle.coverage.notices, ...filterNotices]),
          ...(coverageLimited ? [LIMITED_COVERAGE_GAP] : []),
          ...(researchIncomplete && anyEvidence && draft.gap === undefined ? [INCOMPLETE_SEARCH_NOTICE] : []),
        ];
        const outcome = researchIncomplete ? "partial" as const : !anyEvidence ? (incomplete || unsupportedAction || unconfirmedAbsence || listGaps.some(gap => gap.partial) ? "partial" as const : "not_found" as const) : draft.status === "answered" ? "answered" as const : "partial" as const;
        // Preserve reason provenance before diagnostic gap strings are combined. Desktop actions never classify prose.
        // Only finished research confirms the writer's missing text: an interrupted search keeps its retry reason alone.
        const confirmedMissing = [...(researchIncomplete || unconfirmedAbsence || overridden || selectionNotFound.some(gap => !gap.confirmed) || explicitNones.includes(false) ? [] : reply?.not_found ?? []),
          ...selectionNotFound.filter(gap => gap.confirmed).map(gap => gap.text)];
        const missing = confirmedMissing.length > 0 ? boundedBytes(cleanLine(`Not found: ${confirmedMissing.join("; ")}.`, 600), 2 * 1024)
          : outcome === "not_found" || (unsupportedAction && !anyEvidence && !incomplete && !unconfirmedAbsence && !listGaps.some(gap => gap.partial)
            && needs.length > 0 && needs.every(need => need.status === "not_found")) ? NOT_FOUND_GAP : undefined;
        const gapDetails = { ...(unsupportedAction ? { unsupported_action: true as const } : {}),
          ...(researchIncomplete ? { interrupted: true as const } : {}), ...(missing === undefined ? {} : { not_found: missing }) };
        // The blocks of the statements kept (ADR-0051), only for a part with statements; a list's rows cite their items' citations.
        const indexesOf = (shorts: readonly string[]) => [...new Set(shorts.map(short => usedKeys.get(keyOf(short))!))];
        /** A list statement's table, its rows citing their items' citations. */
        const tableOf = (shape: Extract<DraftShape, { kind: "list" }>) => ({ ...shape, rows: shape.rows.map(row => ({ cells: row.cells, citation_indexes: indexesOf(row.shorts) })) });
        // Each writer item as its block shows it, and each list statement as its table or text. A part with no statements has nothing to lay out.
        const blocks = !laid || draft.statements.length === 0 ? undefined
          : contracted(validatePersonAnswerBlocksV2, buildAskBlocksV2(order.map(({ shape, item }, at): AskBlockStatementV2 => ({ citation_indexes: statements[at]!.citation_indexes,
            shape: item ?? (shape.kind === "list" ? tableOf(shape) : { kind: "text" }) }))), draft.statements, used.length);
        // ---- an Ask again's since (ADR-0047): what is different now, after everything the answer cites ----
        // Only beside an answer with evidence: one with none cannot say what changed. Each sentence stands on text the writer
        // read (W1), as the writer's own sentences do, and repeats are dropped. A list the writer gave whose every sentence
        // was left out says nothing, never that nothing changed; one that cannot fit the citation bound whole, or has a sentence
        // citing more than one statement may, is left out whole, since cut short it would say less changed than did.
        const sinceOf = (given: NonNullable<Answer["since"]>): Statement[] | undefined => {
          const keys = new Set<string>();
          const drafts = given.flatMap(sentence => {
            const kept = drafted(sentence);
            if (kept === undefined) return [];
            const key = JSON.stringify([sentence.text, [...new Set(kept.shorts.map(keyOf))].sort()]);
            if (keys.has(key)) { correct("writer_repeat_dropped"); return []; }
            keys.add(key);
            return [kept];
          });
          if (given.length > 0 && drafts.length === 0) return undefined;
          const fresh = new Set(drafts.flatMap(value => value.shorts.map(keyOf)).filter(key => !usedKeys.has(key)));
          if ((bounded && usedKeys.size + fresh.size > MAX_CITATIONS) || drafts.some(value => overCited(value.shorts))) return undefined;
          return drafts.map(value => statementOf(value.text, value.shorts));
        };
        const since = !withSince || reply?.since === undefined || !anyEvidence ? undefined : sinceOf(reply.since);
        const result = Object.freeze({
          schema_version: 8, kind: "echo-clean-person-answer-v8", scope: options.desk_scope, outcome,
          parts: Object.freeze([Object.freeze({
            question, status: draft.status === "answered" && Object.keys(gapDetails).length > 0 ? "partial" : draft.status,
            statements: released(draft.statements),
            ...(draft.gap === undefined ? {} : { gap: boundedBytes(draft.gap, 2 * 1024) }),
            ...(!options.include_gap_details || Object.keys(gapDetails).length === 0 ? {} : { gap_details: Object.freeze(gapDetails) }),
            ...(draft.records === undefined ? {} : { records: released(draft.records) }),
            ...(blocks === undefined ? {} : { blocks }),
          })]),
          citations: Object.freeze(anyEvidence ? used.map(entry => citationOfAgenticEvidenceItemV8(entry.item, timeZone)) : []),
          ...(responseNotices.length === 0 ? {} : { notice: responseNotices.join(" ") }),
          // Only an answer to a request that carried its previous turn names its question and says what is different since (ADR-0047).
          ...(options.answers === undefined ? {} : { question: options.answers }),
          ...(since === undefined ? {} : { since: Object.freeze({ statements: released(since) }) }),
        });
        return { result, used, laid_out: blocks !== undefined };
      };
      /** A response in blocks as it may be released: with its blocks, within its byte bound. Each is measured once, and only then. */
      const releasable = (responded: ReturnType<typeof respond>) => responded.laid_out && agenticAskResponseFitsV1(responded.result) ? responded : undefined;
      const laidOutResponse = arranged ? respond(answer, true, true, true) : undefined;
      // An answer in blocks is released only with its blocks and within its byte bound; an Ask again's that cannot fit with its
      // `since` keeps its blocks without it (ADR-0047). Otherwise the same claims are released without blocks, in the order
      // and numbering an answer without them has: a row is still its cells' claim, and what cannot fit the bound is dropped
      // from the end and said to be missing, an Ask again's `since` first.
      const laidOutReleased = laidOutResponse === undefined ? undefined : releasable(laidOutResponse)
        ?? (laidOutResponse.laid_out && "since" in laidOutResponse.result ? releasable(respond(answer, true, false, false)) : undefined);
      const { result, used } = laidOutReleased ?? respond(answer, false, laidOutResponse === undefined, true);
      const validated = compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV8);
      return Object.freeze({
        result: Object.freeze({ response: validated, writer_evidence: writerEvidence }),
        // `used` is in first-citation order, and fitting the byte bound drops
        // whole statements or records from the end, so the citations released
        // are always the first ones of `used`.
        cited: Object.freeze(used.slice(0, validated.citations.length).map(entry => entry.short)),
        // The writer never asks which one: only a follow-up's resolver does (ADR-0047).
        outcome: validated.outcome as Exclude<PersonAnswerResponseV8["outcome"], "clarify">,
        fallbacks: written?.value === null ? 1 : 0,
        // Ask's answer is its direct statement and parts, and an answer to a request that carried its previous turn names
        // its question and what is different since (ADR-0047).
        answer_sha256: agenticAskAnswerSha256V1(validated),
      });
    },
  });
}
