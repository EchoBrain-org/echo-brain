import {
  PERSON_ANSWER_CAPTION_MAX_BYTES_V1,
  PERSON_ANSWER_STATEMENT_MAX_BYTES_V4,
  PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4,
  PERSON_ANSWER_FALLBACK_RECORD_MAX_BYTES_V4,
  PERSON_ANSWER_PART_GAP_MAX_BYTES_V4,
  personAnswerCitationKeyV8,
  validatePersonAnswerBlocksV2,
  type PersonAnswerBlockV2,
  type PersonAnswerResponseV8,
  type PersonAnswerPartV4,
} from "@echo-brain/organization-api";
import {
  AgenticAskOutputErrorV1,
  ANSWER_BLOCK_CATALOG,
  ANSWER_BLOCKS_PROMPT,
  ANSWER_FOLLOW_UPS_PROMPT,
  ANSWER_SINCE_PROMPT,
  answerBlocksFollowUpsSchema,
  answerBlocksSchema,
  answerBlocksSinceFollowUpsSchema,
  answerBlocksSinceSchema,
  attributed,
  boundedBytes,
  calendarDay,
  cleanId,
  cleanLine,
  cleanModelId,
  FOLLOW_UP_TASK_CHARS,
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
  agenticListFillV1,
  agenticListFilterNoticeV1,
  agenticListUncheckedNoticeV1,
  agenticListMembershipV1,
  agenticListMembersNounV1,
  agenticListSelectionNotFoundV1,
  agenticListShownNoteV1,
  agenticListStatementsV2,
  agenticListTableV1,
  agenticNeedReadsListV1,
  agenticOpenReadsV1,
  agenticPlanListsV1,
  agenticWriterListMemberV1,
  agenticWriterListV1,
  parseAgenticListIdV1,
  type AgenticListFillV1,
  type AgenticListIdV1,
  type AgenticListNounFormsV1,
  type AgenticListSelectionV1,
  type AgenticOpenReadsV1,
  type AgenticWriterListMemberV1,
  type AgenticWriterListV1,
} from "../agentic-list-evidence-v1.js";
import { AGENTIC_ASK_MIN_ANSWER_MS_V1, AGENTIC_MODEL_OUTPUT_TOKENS_V1, type AgenticModelCallV1 } from "../agentic-model-gate-v1.js";
import { agenticNotShownNoticeV1, agenticResearchNotesV1, type AgenticResearchNotesV1 } from "../agentic-research-notes-v1.js";
import { callRendererModelV1, type AgenticRendererV1, type AgenticRenderInputV1 } from "../agentic-renderer-v1.js";
import { observeCoreModelCorrectionV1, type CoreRuntimeModelCorrectionV1 } from "../../shared/core-runtime-observation-v1.js";
import { buildAskBlocksV2, daysWrittenV2, orderAskBlocksV2, quoteIsWordForWordV2, type AskBlockStatementV2 } from "./ask-layout-v2.js";
import { ASK_FOLLOW_UP_ABOUT_KINDS_V1, askFollowUpItemIdV1, type AskFollowUpDraftV1 } from "../ask-follow-ups-v1.js";
import { impactItemKeyV1, outsideLabelScreenV1 } from "./impact-card-storage-v1.js";

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence and the lists research read, and arranges its answer from the block
 * catalog beside the source catalog (answer layout v2, ADR-0051); code reads
 * each item of its blocks as one statement, checked against what it cites, and
 * standing only on text the writer read. The writer never retypes a list: it
 * places a list block, whole or narrowed, and code fills it from the desk and
 * writes its count, where the writer put it (ADR-0054). Research's labels add
 * or remove nothing after a usable reply, one of which something survives the
 * check. With no usable writer reply code states the lists the plan's
 * which_items needs cite (ADR-0041), or falls back to the records research
 * read, or says what it could not find. The answer reads answer first, and its
 * part carries the blocks its kept statements read as.
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
const WHICH_GAP = "I could not confirm the full list of items asked for.";
const UNSUPPORTED_GAP = "Part of the answer was left out because no item's text supports it.";
/** A list block whose narrowing code could not read (ADR-0054): it shows nothing, never the whole list, and the reader is told. */
const LIST_DROPPED_GAP = "A list was left out because its selection could not be read.";
/** A selection that matched no member of a list some of whose members do not record the fact it selects by: no absence is proven. */
const UNRECORDED_GAP = "Some list items do not record the fact used to select them.";
/** The writer's one repair for a sentence resting on list rows or list ids alone. */
const ROWS_REASON = "a sentence cites list rows or list ids but no evidence text: place a \"list\" block to show which items exist and members' title, dates, status and owner (whole, with \"where\" or with \"members\"); what no evidence text says belongs in \"not_found\"";
/** The writer's one repair for a list block whose selection code cannot read (ADR-0054): it is never widened. */
const LIST_REASON = "a \"list\" block's selection could not be read: give the whole list with only \"list\", or narrow it with \"where\" ({\"field\": owner or status with a \"value\", or a date field with \"since\" and \"until\" as YYYY-MM-DD}) or with \"members\" (an array of item ids it shows), and no other keys";
const FIT_GAP = "Some evidence could not fit in this response.";
/** A part's gap as one line, cut only at the Person protocol's own bound for it. */
function gapLine(text: string): string { return boundedBytes(cleanLine(text, PERSON_ANSWER_PART_GAP_MAX_BYTES_V4), PERSON_ANSWER_PART_GAP_MAX_BYTES_V4); }
/** UTF-8 bytes of the response's notice, as the Person protocol bounds it. */
const NOTICE_MAX_BYTES = 2 * 1024;
/** What an answer that drafted follow-ups (ADR-0053) and found nothing about them says, after it says what it drafted. */
const FOLLOW_UP_NOT_FOUND_GAP = "I couldn't find anything more about it in the sources you can access.";
/** What an answer says it drafted: the drafts are the question, so it never asks. */
function draftedGap(count: number): string {
  return count === 1 ? "I drafted a follow-up for you to review and send." : `I drafted ${count} follow-ups for you to review and send.`;
}
/** How many words in a row, shared with an outside item's text or title, make a drafted task a copy of it (ADR-0053). */
const COPIED_RUN_WORDS = 6;
/**
 * One character of a script written without spaces (Han, kana, Thai, Lao, Khmer, Myanmar), or a run of any other letters
 * and digits. Matched by script extensions, so a mark these scripts share (the prolonged sound mark ー, script Common, or
 * an iteration mark) is a character of their writing too, never glued to its neighbours.
 */
const UNSPACED = String.raw`\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Thai}\p{scx=Laoo}\p{scx=Khmr}\p{scx=Mymr}`;
// Script extensions also take in punctuation these scripts share (。、「」): only a letter, digit or mark is a word, so
// punctuation, changed or dropped, still hides no copy.
const UNSPACED_CHARACTER_OR_WORD = new RegExp(String.raw`(?=[\p{L}\p{N}\p{M}])[${UNSPACED}]|(?:(?![${UNSPACED}])[\p{L}\p{N}\p{M}])+`, "gu");
/** Each run of COPIED_RUN_WORDS words of `text`: its words are its letters and digits, NFC and case-folded, so punctuation and spacing hide no copy. */
function wordRuns(text: string): readonly string[] {
  // A script written without spaces between words has no word to count: each of its characters counts as one, so a copied
  // Chinese, Japanese or Thai sentence is a run like any other. Code points only, no locale data: the same on every runtime.
  const words = text.normalize("NFC").toLowerCase().match(UNSPACED_CHARACTER_OR_WORD) ?? [];
  return words.length < COPIED_RUN_WORDS ? [] : words.slice(0, words.length - COPIED_RUN_WORDS + 1).map((_, at) => words.slice(at, at + COPIED_RUN_WORDS).join(" "));
}
/**
 * ECHO's own items, whose titles a stored line may keep: its records and documents, as for an impact card, and the
 * asker's workspace directory (a project, a person, a tool), whose names a task and its owner must be free to use. Every
 * other item's title, a ticket's, a page's, a tool container's or a follow-up's (which carries its ticket's), is screened
 * out (ADR-0032, ADR-0053).
 */
const ECHO_CITATION_KINDS: ReadonlySet<string> = new Set(["approved_record", "source_revision", "project", "person", "tool"]);
/** A list that is not complete: its statement says "at least" (ADR-0041). */
function listEndGap(noun: string): string { return `The list of ${noun} could not be read to its end, so more may exist.`; }
/**
 * The writer runs in Ask's answer span; the audit records it as an `answer` call, with the answer role's allowance
 * (`AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer`). Its answer in blocks has no count limit (ADR-0051), so the allowance is
 * sized for a long answer, an Ask again's `since` included, and the response's byte bound decides what is released.
 */
const WRITER_CALL: AgenticModelCallV1 = Object.freeze({ role: "answer", span: "ask_answer", output_tokens: AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer });

type Entry = AgenticEvidenceBundleItemV1;
/** A statement's shape before its citations are known: prose, or a list statement's table, whose rows name the items they cite. */
type DraftShape = { readonly kind: "text" } | {
  readonly kind: "list"; readonly caption: string; readonly columns: readonly string[];
  readonly group: number;
  readonly rows: readonly { readonly cells: readonly string[]; readonly shorts: readonly string[] }[];
};
const PROSE: DraftShape = Object.freeze({ kind: "text" });

export interface AskRendererInputV1 {
  /** The question the answer answers: a follow-up's is the one its resolver rewrote (ADR-0047). */
  readonly question: string;
  /**
   * What the person typed in this request, when it differs from `question`. Only these words, never the resolver's
   * rewrite or the previous answer it drew on, may vouch for a follow-up's task (ADR-0053). Defaults to `question`.
   */
  readonly typed_question?: string;
}
export interface AskRenderedV1 {
  readonly response: PersonAnswerResponseV8;
  /** Short ids the writer was given, in order: items whose text it read, then list rows it saw; empty when no writer call ran. */
  readonly writer_evidence: readonly string[];
  /** The follow-ups the answer drafted, as code checked them (ADR-0053), in the order the response lists their ids; empty for none. */
  readonly follow_ups: readonly AskFollowUpDraftV1[];
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
  /**
   * For an Ask that carried its previous turn (ADR-0047): the full question the answer answers, which the response names.
   * Without it the response names none.
   */
  readonly answers?: string;
  /** For an Ask again (ADR-0047): the earlier answer; the writer also says what is different since, and the response carries it. */
  readonly earlier?: AskEarlierAnswerV1;
  /**
   * For an answer whose follow-ups the request saves (ADR-0053): the request's id, shared by its every attempt, which
   * fixes each draft's id. Only then is the writer told to draft follow-ups; without it, any it drafts are dropped.
   */
  readonly follow_ups?: { readonly request_id: string };
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

/** Lowercase, each run of spaces one space: how two follow-ups' tasks and owners are compared. */
function folded(value: string): string { return value.toLowerCase().replace(/\s+/gu, " ").trim(); }
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
/** A block read as text: its statements, in its place, and its title where it has one. Blocks add no claim. */
function asText(block: PersonAnswerBlockV2): PersonAnswerBlockV2 {
  return Object.freeze({ kind: "text" as const, ...("title" in block && block.title !== undefined && block.kind !== "card" ? { title: block.title } : {}), statements: block.statements });
}
/** Which contract rule a refused block broke, as the runtime counts it: content-free, from the contract's own message. */
function layoutRule(error: unknown): "writer_block_shape_repaired" | "writer_block_text_repaired" | "writer_block_citations_repaired" | "writer_block_order_repaired" {
  const message = error instanceof Error ? error.message : "";
  if (/citation/u.test(message)) return "writer_block_citations_repaired";
  if (/order|misplaced|leave a statement out/u.test(message)) return "writer_block_order_repaired";
  if (/title|text|who|label|value|from|column|cell|caption/u.test(message)) return "writer_block_text_repaired";
  return "writer_block_shape_repaired";
}
/**
 * Blocks that pass the contract against the part's statements. A block the contract refuses is read as text in its
 * place, alone, and the rule it broke is counted; only when that still fails is the part one text block. Blocks add no
 * claim, so an answer whose blocks code could not build reads as text rather than failing.
 */
export function contracted(blocks: readonly PersonAnswerBlockV2[], statements: Cited, citations: number): readonly PersonAnswerBlockV2[] {
  const valid = (value: readonly PersonAnswerBlockV2[]) => { try { return validatePersonAnswerBlocksV2(value, statements, citations); } catch (error) { return error as Error; } };
  const whole = valid(blocks);
  if (!(whole instanceof Error)) return whole;
  // Each block against the others read as text: the blocks that fail alone are the ones at fault.
  const repaired = blocks.map((block, at) => {
    if (block.kind === "text") return block;
    const alone = valid(blocks.map((other, place) => place === at ? other : asText(other)));
    if (!(alone instanceof Error)) return block;
    observeCoreModelCorrectionV1(layoutRule(alone));
    return asText(block);
  });
  const kept = valid(repaired);
  if (!(kept instanceof Error)) return kept;
  observeCoreModelCorrectionV1("writer_layout_collapsed");
  return Object.freeze([Object.freeze({ kind: "text" as const, statements: Object.freeze(statements.map((_, at) => at)) })]);
}

export function createAskRendererV1(options: CreateAskRendererV1Options): AgenticRendererV1<AskRendererInputV1, AskRenderedV1> {
  const earlier = options.earlier;
  const timeZone = options.context.time_zone ?? 'UTC';
  return Object.freeze({
    async render(input: AgenticRenderInputV1<AskRendererInputV1>) {
      const { bundle } = input;
      const askedQuestion = input.trigger_input.question;
      const researchIncomplete = !bundle.stop.completed;
      const drafting = options.follow_ups !== undefined;
      // Research says the person asked for a follow-up (ADR-0053). A request that saves none cannot draft one: it is an
      // action Ask cannot take, and the answer says so.
      const followUpRequested = bundle.stop.follow_up_requested === true;
      const unsupportedAction = bundle.stop.unsupported_action === true || (followUpRequested && !drafting);
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

      // ---- lists (ADR-0041, ADR-0054): how the writer sees them, and what code states of them with no usable reply ----
      const lists = bundle.lists ?? [];
      const listById = new Map(lists.map(list => [list.id, list]));
      /** Which list member an item is, or is part of: an opened page's section is its page. */
      const membership = agenticListMembershipV1(lists, bundle.items);
      const needs = bundle.plan.flatMap(part => part.needs);
      // With no usable writer reply only (ADR-0054): the lists the plan's which_items needs cite, which code states (W3), and
      // whether one of them cites none (W3). The kinds alone decide; what a need cites beside them never does.
      const { stated, unlisted } = agenticPlanListsV1(needs, id => listById.has(id));
      const checked = checkedItems(bundle, agenticOpenReadsV1(bundle.rounds, short => byShort.get(short)?.full === true));
      const rows = new Map(lists.map(list => [list.id, list.members.map(short => agenticWriterListMemberV1(byShort.get(short)!, checked.has(short), options.context.time_zone))]));
      // With no usable writer reply only (ADR-0054), a which_items need research has not given up on, found or still open
      // when research stopped, has code state its lists (agenticNeedReadsListV1); an interrupted answer stays partial. Its E
      // ids name those members of each list it cites, opened bodies mapped back to their rows. Only a need that cites no
      // member declares its lists whole: a need citing members never brings another list's inventory.
      const listNeeds = needs.flatMap(need => {
        if (need.kind !== "which_items" || !agenticNeedReadsListV1(need)) return [];
        const cited = [...new Set(need.evidence)].flatMap(id => listById.has(id as AgenticListIdV1) ? [id as AgenticListIdV1] : [])
          .map(id => ({ id, members: [...new Set(need.evidence.flatMap(short => membership.in(id, short) ?? []))] }));
        return [{ cited, declares: cited.every(list => list.members.length === 0) }];
      });
      const viewOf = (list: (typeof lists)[number], cap?: number) => agenticWriterListV1(list, rows.get(list.id)!, cap);
      /** Every list as code reads it, past the writer's bound too: what code fills, states and reports the limits of. */
      const views = new Map(lists.map(list => [list.id, viewOf(list)]));
      // The writer sees every list: those the plan's needs cite, in plan order, whatever kind of need cites them, then the
      // others in the order research read them (ADR-0054). List rows take at most half its room, which bounds them.
      const planned = needs.flatMap(need => need.evidence.flatMap(id => { const list = parseAgenticListIdV1(id); return list !== null && listById.has(list) ? [list] : []; }));
      const writerOrder = [...new Set([...planned, ...lists.map(list => list.id)])].map(id => listById.get(id)!);
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
        // The writer picks its blocks from a catalog beside the sources' (ADR-0051).
        block_catalog: ANSWER_BLOCK_CATALOG,
        // Lists carry their filters (ADR-0041); this describes what research read, not whether an arbitrary fact exists.
        // Research's plan reaches the writer apart from it, as research's own notes (ADR-0054).
        research: {
          completed: !researchIncomplete, stop_reason: bundle.stop.reason, reads,
          notices: [...bundle.coverage.notices], omitted_evidence_items: bundle.items.filter(entry => entry.item.text !== undefined).length,
        },
      };
      // The writer is also told how to arrange blocks (ADR-0051), and an Ask again's what to say is different since
      // (ADR-0047).
      // Only a writer whose follow-ups the request saves is told to draft them (ADR-0053); any other's prompt is unchanged.
      const writerPrompt = [options.answer_prompt, ANSWER_BLOCKS_PROMPT, ...(earlier === undefined ? [] : [ANSWER_SINCE_PROMPT]), ...(drafting ? [ANSWER_FOLLOW_UPS_PROMPT] : [])].join("\n\n");
      const writerSchema = earlier === undefined ? (drafting ? answerBlocksFollowUpsSchema : answerBlocksSchema) : (drafting ? answerBlocksSinceFollowUpsSchema : answerBlocksSinceSchema);
      const promptBudget = input.prompt_budget(writerPrompt, WRITER_CALL.output_tokens);
      // Research's notes (ADR-0054) never take room from evidence: lists and evidence are admitted against the whole room,
      // and the notes take only what they leave.
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
      // Research's notes (ADR-0054): its plan, need by need, in what lists and evidence left of the room; how many members
      // of each list it was shown research read in full; and how many lists and rows it was not shown. Needs give way from
      // the end, and notes that cannot fit even with none are left out entirely.
      // A list the writer was not shown leaves every one of its rows unshown.
      const notShown = { lists: lists.length - writerLists.length, list_rows: lists.reduce((sum, list) => { const shown = writerById.get(list.id); return sum + (shown === undefined ? list.members.length : shown.members_omitted ?? 0); }, 0) };
      // The notes' room: what lists and evidence left, less their key in the writer's input.
      const noteRoom = writerBudget - evidenceBytes - bytes(`"research_notes":,`);
      const notes: AgenticResearchNotesV1 = agenticResearchNotesV1({
        plan: bundle.plan, not_shown: notShown,
        shown: id => textGiven.has(id) || shownRows.has(id) || writerById.has(parseAgenticListIdV1(id) ?? "L0"),
        lists: writerLists.map(list => ({ list: list.id, read: list.checked, count: list.count })),
        max_bytes: Math.max(0, noteRoom),
      });
      const researchNotes = bytes(JSON.stringify(notes)) <= noteRoom ? { research_notes: notes } : {};

      // ---- the writer's sentences rest on text (W1) -------------------------
      /**
       * The lists a sentence uses (ADR-0054): each the writer was shown whose id it cites, or a row of which it cites that the
       * writer saw as a row only. A sentence citing a member's text alone uses no list.
       */
      const listsCitedBy = (ids: readonly string[]): readonly AgenticListIdV1[] => [...new Set(ids.flatMap(id => {
        const list = parseAgenticListIdV1(id);
        if (list !== null) return writerById.has(list) ? [list] : [];
        return shownRows.has(id) ? writerLists.filter(view => view.members.some(member => member.id === id)).map(view => view.id) : [];
      }))];
      /** A sentence resting on list rows or list ids: it cites one the writer saw, and no evidence text it read. */
      const restsOnRows = (sentence: AnswerSentence) => !sentence.evidence.some(short => textGiven.has(short)) &&
        sentence.evidence.some(id => shownRows.has(id) || writerById.has(parseAgenticListIdV1(id) ?? "L0"));
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
        const parsed = parseBlocksAnswer(value, since);
        last.answer = parsed;
        // A list block code cannot read, or a sentence resting on rows, takes the writer's one repair; a list block still
        // unreadable after it is dropped, never widened.
        const reasons = [...(parsed.placed.some(placed => placed.unreadable === true) ? [LIST_REASON] : []), ...(parsed.sentences.some(restsOnRows) ? [ROWS_REASON] : [])];
        if (reasons.length > 0 && repairable()) throw new AgenticAskOutputErrorV1(reasons.join("; "));
        return parsed;
      };

      // A request for a follow-up (ADR-0053) runs the writer with no evidence too: it can draft one about nothing ECHO knows.
      const writerRuns = evidence.length > 0 || writerLists.some(list => list.count > 0) || (drafting && followUpRequested);
      const written = !writerRuns ? null : await callRendererModelV1(input, WRITER_CALL, writerPrompt, {
        ...answerContext,
        // Research's working notes are data, marked as research's own: never instructions, never the person's question and never evidence.
        // The writer assesses the original question against released text.
        ...researchNotes,
        lists: writerLists,
        evidence: evidence.map(entry => ({ ...describe(entry), text: entry.item.text })),
      }, writerSchema, parse);
      // A reply sent back only for a sentence resting on rows is still the writer's answer; code leaves that sentence out.
      // Only a writer that ran and left no reply at all has fallen back here.
      const answer = written === null ? null : written.value ?? last.answer;
      const noReply = written !== null && answer === null;
      if (noReply) observeCoreModelCorrectionV1("writer_fallback");
      const writerEvidence: readonly string[] = written === null ? [] : writerShown;

      // ---- follow-ups (ADR-0053): each draft the writer gave, as code checks it -------------------------
      // A task, an owner's name, a day and one item it is about, each optional but the task. No title of an item read from
      // outside ECHO is kept, and a link names only an item the writer was shown. Each kept draft's id is fixed by the
      // request and its place, so every attempt of one request names the same ids.
      const drafts: readonly AskFollowUpDraftV1[] = (() => {
        const given = answer?.follow_ups ?? [];
        if (options.follow_ups === undefined) {
          if (given.length > 0) observeCoreModelCorrectionV1("follow_up_dropped", given.length);
          return [];
        }
        if (given.length === 0) return Object.freeze([]);
        const { request_id: requestId } = options.follow_ups;
        const outside = bundle.items.filter(entry => !ECHO_CITATION_KINDS.has(entry.item.citation.kind));
        const echoOwn = bundle.items.filter(entry => ECHO_CITATION_KINDS.has(entry.item.citation.kind));
        const screen = outsideLabelScreenV1(outside.flatMap(entry => [entry.item.label, agenticEvidenceLabelV1(entry.item, timeZone), ...(entry.item.list_label === undefined ? [] : [entry.item.list_label])]));
        // Text copied from an outside item: any run of COPIED_RUN_WORDS words its text or title holds, unless the person's
        // question or the text or title of one of ECHO's own items holds that run too.
        const runsOf = (values: readonly (string | undefined)[]) => new Set(values.flatMap(value => value === undefined ? [] : wordRuns(value)));
        // Only what the person typed vouches for their words: a follow-up's rewritten question can carry an outside item's text.
        const allowed = runsOf([input.trigger_input.typed_question ?? askedQuestion, ...echoOwn.flatMap(entry => [entry.item.text, entry.item.label])]);
        const copied = new Set([...runsOf(outside.flatMap(entry => [entry.item.text, entry.item.label, entry.item.list_label]))].filter(run => !allowed.has(run)));
        const kept: AskFollowUpDraftV1[] = [];
        const seen = new Set<string>();
        // The parser already put each task and owner on one line within its bound (followUpsOf).
        for (const draft of given) {
          const line = draft.task;
          // A sentence copied from an outside item's text is never stored, in any spelling or punctuation (ADR-0032).
          if (wordRuns(line).some(run => copied.has(run))) {
            observeCoreModelCorrectionV1("follow_up_task_screened"); observeCoreModelCorrectionV1("follow_up_dropped"); continue;
          }
          const screened = screen.names(line);
          if (screened) observeCoreModelCorrectionV1("follow_up_task_screened");
          const task = screened ? screen.scrub(line, FOLLOW_UP_TASK_CHARS) : line;
          // A task that was only an outside title says nothing of ECHO's own.
          if (task.length === 0 || /^a cited item[.!]?$/iu.test(task)) { observeCoreModelCorrectionV1("follow_up_dropped"); continue; }
          let owner = draft.owner ?? "";
          if (owner.length > 0 && screen.names(owner)) { observeCoreModelCorrectionV1("follow_up_owner_dropped"); owner = ""; }
          const due = draft.due_on === undefined ? undefined : calendarDay(draft.due_on);
          if (draft.due_on !== undefined && due === undefined) observeCoreModelCorrectionV1("follow_up_date_dropped");
          const aboutId = draft.about === undefined ? null : cleanModelId(draft.about);
          const aboutEntry = aboutId === null || !(textGiven.has(aboutId) || shownRows.has(aboutId)) ? undefined : byShort.get(aboutId);
          const pointer = aboutEntry === undefined || !ASK_FOLLOW_UP_ABOUT_KINDS_V1.includes(aboutEntry.item.citation.kind) ? undefined
            : citationOfAgenticEvidenceItemV8(aboutEntry.item, timeZone).citation as unknown as Readonly<Record<string, unknown>>;
          const about = pointer !== undefined && impactItemKeyV1(pointer) !== undefined ? pointer : undefined;
          if (draft.about !== undefined && about === undefined) observeCoreModelCorrectionV1("follow_up_link_dropped");
          // A repeat says the same task to the same owner, on the same day, about the same item.
          const key = JSON.stringify([folded(task), folded(owner), due ?? null, about === undefined ? null : impactItemKeyV1(about)]);
          if (seen.has(key)) { observeCoreModelCorrectionV1("writer_repeat_dropped"); continue; }
          seen.add(key);
          kept.push(Object.freeze({
            item_id: askFollowUpItemIdV1(requestId, kept.length), task,
            ...(owner.length === 0 ? {} : { owner_name: owner }), ...(due === undefined ? {} : { due_on: due }), ...(about === undefined ? {} : { about }),
          }));
        }
        return Object.freeze(kept);
      })();
      const followUpIds = drafts.length === 0 ? {} : { follow_ups: Object.freeze(drafts.map(draft => draft.item_id)) };

      // ---- layout (code, not model): one part, in blocks --------------------
      type Statement = { text: string; citation_indexes: number[]; private: boolean };
      // One citation per key, the key the Ask response checks for duplicates: a listed ticket's row and its opened body
      // are two items with one key, so they share one citation.
      const keyOf = (short: string) => personAnswerCitationKeyV8(byShort.get(short)!.item.citation);
      /** Whether a statement citing `shorts` would cite more items than one statement may, in blocks too (ADR-0051). */
      const overCited = (shorts: readonly string[]) => new Set(shorts.map(keyOf)).size > PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4;
      const question = partQuestion(askedQuestion);
      /** The lists whose block a reply that takes the fallback placed and code dropped (ADR-0054): the fallback never states them. */
      let withheld: ReadonlySet<AgenticListIdV1> = new Set();
      /**
       * The response `reply` (the writer's answer, or null) gives in blocks (ADR-0051), with an Ask again's `since`
       * (ADR-0047) or without it, and the items its citations cite, in order. With `keep`, an answer too large for its bytes
       * keeps only its first `keep` statements as it reads, and a placed list it cuts says how many it shows. Each call reads
       * the reply afresh; only the first counts the writer's corrections (`count`). `survived` says whether anything of the
       * reply survived the check, so a reply of which nothing did takes the fallback.
       */
      const respond = (reply: Answer | null, count: boolean, withSince: boolean, keep?: number) => {
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

        // ---- statements (W2, W3): the lists code states, each in full, by `where` or by id ----
        /** One statement of a list; `which` when it says which items exist (in full or by `where`), never for a selection by id alone. */
        type Naming = { readonly list: AgenticWriterListV1; readonly noun: AgenticListNounFormsV1; readonly selected: readonly AgenticWriterListMemberV1[]; readonly which: boolean; readonly where?: AgenticListSelectionV1; readonly by_id: boolean };
        /** What the lists add to the gap, in order; `partial` when its rule makes the part partial whatever it names (W1, W2, W3). */
        const listGaps: { readonly text: string; readonly partial: boolean }[] = [];
        const writerGaps: { readonly text: string; readonly partial: boolean }[] = [];
        const selectionNotFound: { readonly text: string; readonly confirmed: boolean }[] = [];
        // ---- the writer's sentences (W1, W3, W4) ---------------------------
        // Code says nothing about how many members of a list research read (ADR-0054): research's notes tell the writer.
        // Only with no usable writer reply, when code states the plan's which_items lists, does a which_items need that cites
        // no list say the list asked for is unconfirmed (ADR-0041). After a usable reply no research label adds content.
        if (reply === null && unlisted) writerGaps.push({ text: WHICH_GAP, partial: true });
        const sentences = reply?.sentences ?? [];
        // A sentence the kept reply still rests on rows or list ids is left out, and the part says so, never what it claimed.
        if (sentences.some(restsOnRows)) writerGaps.push({ text: UNSUPPORTED_GAP, partial: true });
        // ---- the lists the writer placed (ADR-0054): code fills each from the desk, where the writer put it ----
        // The whole list and a where read every member, past the rows the writer was shown; members by id only the rows it
        // was shown. A narrowing code could not read, or members that name no row it was shown, show nothing and the reader
        // is told: a block never widens to the whole list. A where that matches none says so through the list's not-found
        // phrase, confirmed only for a complete list whose members all record the fact.
        const filled: { readonly list: AgenticWriterListV1; readonly block: number; readonly fill: Extract<AgenticListFillV1, { readonly kind: "rows" }> }[] = [];
        const placedLists = new Set<AgenticListIdV1>();
        /** The lists whose block was dropped, which the fallback never states. */
        const droppedLists = new Set<AgenticListIdV1>();
        for (const placed of reply?.placed ?? []) {
          const shown = writerById.get(placed.list);
          if (shown === undefined) { correct("writer_unknown_id_dropped"); continue; }
          if (placed.unreadable === true) { droppedLists.add(placed.list); listGaps.push({ text: LIST_DROPPED_GAP, partial: true }); continue; }
          const list = views.get(placed.list)!, all = rows.get(placed.list)!;
          const fill = agenticListFillV1({
            placed, all, list: listById.get(placed.list)!, member_of: id => membership.in(placed.list, id),
            // The rows it saw listed, and the items whose text it read: a row's opened body names its row.
            shown: new Set([...shown.members.map(member => member.id), ...textGiven]),
          });
          if ((fill.kind === "rows" || fill.kind === "dropped") && fill.unknown > 0) correct("writer_unknown_id_dropped", fill.unknown);
          if (fill.kind === "dropped") { droppedLists.add(placed.list); listGaps.push({ text: LIST_DROPPED_GAP, partial: true }); continue; }
          placedLists.add(placed.list);
          if (fill.kind === "none_matched") {
            if (!fill.testable) listGaps.push({ text: UNRECORDED_GAP, partial: true });
            selectionNotFound.push({ text: agenticListSelectionNotFoundV1(nounOf(list), list.filter, fill.where), confirmed: fill.confirmed });
          }
          if (fill.kind === "rows") filled.push({ list, block: placed.block, fill });
        }
        // It stands on the items whose text the writer read (W1); after them, never as support, it cites the rows whose facts it
        // may carry: each row it cites that the writer saw, and each private row of a list it cites that the writer saw or a
        // block placing that list shows (W6, ADR-0054), so a sentence leaning on a list is as private as every row of it the
        // reader is shown.
        const placedRows = new Map<string, readonly string[]>();
        for (const { list, fill } of filled) placedRows.set(list.id, [...(placedRows.get(list.id) ?? []), ...fill.selected.map(member => member.id)]);
        const rowsOf = (id: string) => {
          if (shownRows.has(id)) return [id];
          const list = parseAgenticListIdV1(id);
          const shown = list === null ? undefined : writerById.get(list);
          if (shown === undefined) return [];
          return [...new Set([...shown.members.map(member => member.id), ...(placedRows.get(shown.id) ?? [])])].filter(short => privateItem(byShort.get(short)!.item));
        };
        /** The sentence with code's note within a statement's 4 KiB: one too long to take the note whole, a wide row, is cut, never the note. */
        const fittedNote = (text: string, note: string) => {
          const whole = withNote(text, note);
          if (bytes(whole) <= PERSON_ANSWER_STATEMENT_MAX_BYTES_V4) return whole;
          correct("model_text_truncated");
          return `${boundedBytes(text, PERSON_ANSWER_STATEMENT_MAX_BYTES_V4 - bytes(` ${note}`))} ${note}`;
        };
        /** A writer's or `since` sentence as code keeps it: on the text the writer read (W1), then the rows it may carry, and the lists it uses; or none. */
        const drafted = (sentence: Pick<AnswerSentence, "text" | "evidence">) => {
          const read = sentence.evidence.filter(short => textGiven.has(short));
          if (read.length === 0) { correct("writer_uncited_sentence_dropped"); return undefined; }
          // An id that is no text, row or list the writer saw cites nothing.
          const unknown = sentence.evidence.filter(id => !textGiven.has(id) && !shownRows.has(id) && !writerById.has(parseAgenticListIdV1(id) ?? "L0")).length;
          if (unknown > 0) correct("writer_unknown_id_dropped", unknown);
          return { text: sentence.text, shorts: [...read, ...sentence.evidence.flatMap(rowsOf)], read, uses: listsCitedBy(sentence.evidence) };
        };
        /**
         * An item as code checks it against the evidence text it stands on (ADR-0051): a quote that is not word for word in
         * the title or text of one it cites reads as text, its source and words without quotation marks; an event whose day
         * is not one they record or write reads as text without that day. An item that stands on no text is left out (W1).
         */
        const verified = (sentence: AnswerSentence): AnswerSentence => {
          const item = sentence.item;
          const read = sentence.evidence.flatMap(short => textGiven.has(short) ? [byShort.get(short)!] : []);
          if (read.length === 0) return sentence;
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
        /**
         * A statement as code lays it out; a writer's item also keeps the ids of the text it stands on (`read`).
         * `block` is the writer's block a placed list's statement reads at (orderAskBlocksV2); a list code states with no
         * usable writer reply has none.
         */
        type Laid = {
          text: string; shorts: readonly string[]; read?: readonly string[]; shape: DraftShape; item?: AnswerItem; block?: number;
          /** The lists a writer's sentence uses (listsCitedBy), or the list a list statement states. */
          uses?: readonly AgenticListIdV1[];
          /** A placed list's statements share one `group`; `listed` counts the selected members this one names, and all of them. */
          group?: number; listed?: { readonly members: number; readonly selected: number };
        };
        const writerSentences: (Laid & { item: AnswerItem })[] = sentences.flatMap(given => {
          const sentence = verified(given);
          const kept = drafted(sentence);
          return kept === undefined ? [] : [{ text: kept.text, shorts: kept.shorts, read: kept.read, uses: kept.uses, shape: PROSE, item: sentence.item }];
        });

        const statementKeyOf = (sentence: Laid) => JSON.stringify([sentence.text, [...new Set(sentence.shorts.map(keyOf))].sort(), sentence.shorts.some(short => privateItem(byShort.get(short)!.item))]);
        // ---- with no usable writer reply (ADR-0041, kept by ADR-0054): the lists the plan's which_items needs cite ----
        // Each which_items need research has not given up on, found or still open when research stopped, states in plan order
        // its declared lists whole, or the members it cites, opened bodies mapped back to their rows. Within one need a member
        // is stated once, under the first list it cites that holds it; members different needs request keep a statement under
        // each need's list. After a usable reply none of this runs: the writer's choice of lists stands (ADR-0054).
        const fallbackLists: { readonly id: AgenticListIdV1; readonly members?: readonly string[] }[] = [];
        // A list whose block the writer's reply placed and code dropped is never stated in its place: the fallback says
        // something was left out, and never widens the writer's narrowing to the whole list (ADR-0054).
        if (reply === null && withheld.size > 0) listGaps.push({ text: LIST_DROPPED_GAP, partial: true });
        if (reply === null) {
          const added = new Map<string, readonly string[]>();
          const whole = new Set<string>();
          for (const need of listNeeds) {
            const done = new Set<string>();
            for (const { id, members } of need.cited) {
              const wanted = need.declares ? rows.get(id)!.map(member => member.id) : members;
              const fresh = wanted.filter(member => !done.has(member));
              for (const member of fresh) done.add(member);
              if (need.declares && fresh.length === wanted.length) whole.add(id);
              else added.set(id, [...new Set([...(added.get(id) ?? []), ...fresh])]);
            }
          }
          for (const id of stated.filter(id => !withheld.has(id))) {
            const missing = added.get(id) ?? [];
            if (whole.has(id) || (missing.length > 0 && missing.length === views.get(id)!.count)) fallbackLists.push({ id });
            else if (missing.length > 0) fallbackLists.push({ id, members: missing });
          }
        }
        const naming: Naming[] = fallbackLists.flatMap(({ id, members }): Naming[] => {
          const list = views.get(id)!, all = rows.get(id)!, noun = nounOf(list);
          if (members === undefined) return all.length === 0 ? [] : [{ list, noun, selected: all, which: true, by_id: false }];
          const picked = all.filter(member => members.includes(member.id));
          return picked.length === 0 ? [] : [{ list, noun, selected: picked, which: picked.length === all.length, by_id: true }];
        });
        /**
         * A list's statements as code writes them, one table (`group`) across them. A placed list's (ADR-0054) carry the
         * writer's `block`, and how many of its selected members each names (`listed`), so a cut can say what is shown.
         */
        const statementsOf = (value: Naming, group: number, block?: number): Laid[] => {
          // An owner or status reads as the first selected member records it; a date range as the writer gave it.
          const where = value.where === undefined || !("value" in value.where) ? value.where : { field: value.where.field, value: value.selected[0]![value.where.field]! };
          const description = {
            noun: value.noun, filter: value.list.filter, count: value.list.count, complete: value.list.complete, selected: value.selected,
            ...(where === undefined ? {} : { where }), ...(value.by_id ? { by_id: true, which: value.which } : {}),
          };
          // Every member is named, each citing its own row, in as many statements as their bounds need, and a statement naming
          // two or more names is a table, a row per name.
          const statements = agenticListStatementsV2(description);
          const table = agenticListTableV1({ selected: value.selected, names: statements.flatMap(statement => statement.names), by_id: value.by_id, ...(value.list.filter.time_zone === undefined ? {} : { time_zone: value.list.filter.time_zone }) });
          let firstRow = 0;
          return statements.map(statement => {
            const shape: DraftShape = table === undefined ? PROSE : {
              kind: "list", caption: statement.caption, columns: table.columns, group,
              rows: table.rows.slice(firstRow, firstRow + statement.names.length).map(row => ({ cells: row.cells, shorts: row.members.map(at => value.selected[at]!.id) })),
            };
            firstRow += statement.names.length;
            return { text: statement.text, shorts: statement.cited.map(at => value.selected[at]!.id), shape, uses: [value.list.id],
              ...(block === undefined ? {} : { block, group, listed: { members: statement.cited.length, selected: value.selected.length } }) };
          });
        };
        const listStatements: Laid[] = naming.flatMap((value, index) => statementsOf(value, index));
        const placedStatements: Laid[] = filled.flatMap(({ list, block, fill }, index) => statementsOf({
          list, noun: nounOf(list), selected: fill.selected, by_id: fill.by_id, ...(fill.where === undefined ? {} : { where: fill.where }),
          // Members by id that are the whole list say which items exist.
          which: fill.by_id && fill.selected.length === rows.get(list.id)!.length,
        }, naming.length + index, block));

        // List statements come first, then the writer's items (W6, W3). The answer (ADR-0051) reads what is kept answer first,
        // then the lists code states with no usable reply, then the writer's blocks in order, each placed list at its block. It has no count of statements or citations of its own: only its
        // byte bound, which cuts it from its end, and the 40 citations one statement may carry. A statement that would cite
        // more, through the private rows its list id brings, is left out whole, never cut short of them, and the statements
        // after it are kept.
        const statementKeys = new Set<string>();
        const keptReads: Entry[] = [];
        const fitted: Laid[] = [];
        const fittedKeys = new Set<string>();
        let dropped = false;
        for (const sentence of [...listStatements, ...placedStatements, ...writerSentences] as readonly Laid[]) {
          // Temporary model guardrail (ADR-0041): only exact text with the same cited objects and privacy is a repeat.
          // Shared sources or planner kinds never establish that two sentences say the same thing.
          const statementKey = statementKeyOf(sentence);
          if (statementKeys.has(statementKey)) {
            correct("writer_repeat_dropped");
            keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
            continue;
          }
          const fresh = new Set(sentence.shorts.map(keyOf).filter(key => !fittedKeys.has(key)));
          if (overCited(sentence.shorts)) { dropped = true; continue; }
          statementKeys.add(statementKey);
          for (const key of fresh) fittedKeys.add(key);
          fitted.push(sentence);
          keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
        }
        const kept = new Set(fitted);
        // ---- an Ask again's since (ADR-0047): what is different now, read here so the lists it uses are known ----
        // Each sentence stands on text the writer read (W1), as the writer's own sentences do, and repeats are dropped. A
        // sentence citing more than one statement may (its lists' rows included) is left out alone, as a writer's sentence
        // is; the rest stand. A list the writer gave whose every sentence was left out says nothing, never that nothing
        // changed.
        const sinceDrafts = (given: NonNullable<Answer["since"]>) => {
          const keys = new Set<string>();
          const drafts = given.flatMap(sentence => {
            const kept = drafted(sentence);
            if (kept === undefined) return [];
            const key = JSON.stringify([sentence.text, [...new Set(kept.shorts.map(keyOf))].sort()]);
            if (keys.has(key)) { correct("writer_repeat_dropped"); return []; }
            if (overCited(kept.shorts)) { correct("model_entry_dropped"); return []; }
            keys.add(key);
            return [kept];
          });
          if (given.length > 0 && drafts.length === 0) return undefined;
          return drafts;
        };
        // Only beside an answer with evidence: one with none cannot say what changed. With no statement, the fallback shows
        // up to three records research read, unless the reply said what it did not find. A usable reply never brings
        // research-selected records with it (ADR-0054): a reply of only drafts says what it drafted.
        const notFound = [...(reply?.not_found ?? []), ...selectionNotFound.map(gap => gap.text)];
        const fallbackRecords = notFound.length > 0 || reply !== null ? [] : evidence.filter(entry => entry.full).slice(0, 3);
        const evidenced = fitted.length > 0 || fallbackRecords.length > 0;
        const sinceKept = !withSince || reply?.since === undefined || !evidenced ? undefined : sinceDrafts(reply.since);
        // Only a writer that gave no answer block has its first item read as the answer (orderAskBlocksV2).
        const keptLists = [...listStatements, ...placedStatements].filter(entry => kept.has(entry));
        const reading = orderAskBlocksV2(keptLists, writerSentences.filter(entry => kept.has(entry)), sentences.some(sentence => sentence.item.kind === "answer"));
        // An answer too large for its bytes keeps only its first statements, and says the rest did not fit.
        const cut: readonly Laid[] = keep === undefined ? reading : reading.slice(0, keep);
        if (cut.length < reading.length) dropped = true;
        /**
         * The lists the answer uses (ADR-0054), read from what is left after fitting: those a kept statement states, those a
         * kept sentence or kept since sentence cites (listsCitedBy), and those the writer placed or code states with no
         * usable writer reply that state nothing (a selection matching none, an empty list). Their limits follow them: a list
         * not read to its end, a filter that did not apply, and items its date filter could not test. No other list's limits
         * are said, and a list whose every statement fitting left out says none.
         */
        const statedLists = new Set([...listStatements, ...placedStatements].flatMap(sentence => sentence.uses ?? []));
        const usedLists = [...new Set([...[...fallbackLists.map(use => use.id), ...placedLists].filter(id => !statedLists.has(id)),
          ...cut.flatMap(sentence => sentence.uses ?? []), ...(sinceKept ?? []).flatMap(value => value.uses)])].map(id => views.get(id)!);
        // A list that is not complete reads "at least", whatever it states, and the part says so.
        for (const list of usedLists) if (!list.complete) listGaps.push({ text: listEndGap(nounOf(list).plural), partial: true });
        // A list whose date filter could not test some items (research tool contract v1) supports neither "none" nor "all" of
        // them: the part says how many were not checked, and is partial, even when the list is empty.
        let uncheckedEmpty = false;
        for (const list of usedLists) {
          const text = agenticListUncheckedNoticeV1(list, nounOf(list));
          if (text === undefined) continue;
          listGaps.push({ text, partial: true });
          if (list.count === 0) uncheckedEmpty = true;
        }
        listGaps.push(...writerGaps);
        // A placed list the cut left short says, in its caption and in each of its kept statements, how many it shows:
        // "(first 7 shown)". The caption is cut to fit beside the note, never the note.
        const shownOf = new Map<number, number>();
        for (const sentence of cut) if (sentence.listed !== undefined) shownOf.set(sentence.group!, (shownOf.get(sentence.group!) ?? 0) + sentence.listed.members);
        const order: readonly Laid[] = cut.map(sentence => {
          const note = sentence.listed === undefined ? undefined : agenticListShownNoteV1(shownOf.get(sentence.group!)!, sentence.listed.selected);
          if (note === undefined) return sentence;
          const shape: DraftShape = sentence.shape.kind !== "list" ? sentence.shape
            : { ...sentence.shape, caption: `${boundedBytes(sentence.shape.caption, PERSON_ANSWER_CAPTION_MAX_BYTES_V1 - bytes(` ${note}`))} ${note}` };
          return { ...sentence, text: fittedNote(sentence.text, note), shape };
        });
        const statements: Statement[] = order.map(sentence => statementOf(sentence.text, sentence.shorts));
        // A list statement cites rows for which items exist; only the text the kept sentences stand on can be limited coverage.
        const coverageLimited = coverageIsLimitedFor(bundle, keptReads.filter(entry => usedKeys.has(keyOf(entry.short))));
        const incomplete = (reply === null && writerRuns) || (researchIncomplete && (statements.length === 0 || notFound.length > 0));
        const gapText = incomplete
          ? gapLine(`${INCOMPLETE_SEARCH_GAP}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`)
          : notFound.length === 0 ? undefined : gapLine(`Not found: ${notFound.join("; ")}.`);
        // What the lists add to the gap: a list the answer uses not read to its end or not fully tested by its filter, a list
        // kind with no list, a sentence left out for resting on rows, and what did not fit.
        const extraGaps = [...new Set([...listGaps.map(gap => gap.text), ...(dropped ? [FIT_GAP] : [])])];
        const withGaps = (base: string | undefined) => {
          // Keep capability and unfinished-research explanations ahead of variable-length missing-fact text.
          const gaps = [...(unsupportedAction ? [READ_ONLY_GAP] : []),
            ...(unsupportedAction && researchIncomplete && !base?.startsWith(INCOMPLETE_SEARCH_GAP) ? [INCOMPLETE_SEARCH_NOTICE] : []),
            ...(base === undefined ? [] : [base]), ...extraGaps];
          return gaps.length === 0 ? undefined : gapLine(gaps.join(" "));
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
          // A record shows the text research read, cut to the bound the response holds for a record's text, as a gap is cut to its own.
          const records = fallbackRecords.map(entry => statementOf(boundedBytes(entry.item.text!, PERSON_ANSWER_FALLBACK_RECORD_MAX_BYTES_V4), [entry.short]));
          draft = records.length > 0
            ? { status: "records_only", statements: [], records, gap: withGaps(RECORDS_GAP)! }
            : { status: "not_found", statements: [], gap: withGaps(drafts.length > 0
              // An answer that drafted follow-ups says so first, in place of only saying it found nothing (ADR-0053).
              ? `${draftedGap(drafts.length)} ${gapText ?? (uncheckedEmpty ? UNCHECKED_EMPTY_GAP : FOLLOW_UP_NOT_FOUND_GAP)}`
              : gapText ?? (unsupportedAction && needs.length === 0 ? undefined : uncheckedEmpty ? UNCHECKED_EMPTY_GAP : NOT_FOUND_GAP))! };
        }
        const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
        // A writer's missing text has no per-list provenance, so a list the answer uses that was not read to its end, or whose
        // filter could not test every item, leaves it unproven, as it does a where selection over such a list (ADR-0054): the
        // answer's outcome follows the writer and the run, never a need's kind or status. With no usable writer reply the
        // plan's needs still decide, as before: for a which_items need not found (not_found or open), a list it cites, or
        // every list when it cites none, whose coverage is incomplete.
        const coverageIncomplete = (list: Pick<AgenticWriterListV1, "complete" | "unchecked">) => !list.complete || (list.unchecked?.count ?? 0) > 0;
        const absenceUnconfirmed = usedLists.some(coverageIncomplete) || (reply === null && (needs.some(need => {
            if (need.kind !== "which_items" || need.status === "found") return false;
            const cited = need.evidence.flatMap(id => listById.get(parseAgenticListIdV1(id) ?? "L0") ?? []);
            return (cited.length === 0 ? lists : cited).some(coverageIncomplete);
          })));
        // What the person is told about the filters of every list the answer uses, and of no other (W7, ADR-0054).
        const filterNotices = usedLists.flatMap(list => agenticListFilterNoticeV1(list, nounOf(list).plural) ?? []);
        // A completed answer can retain source coverage as a notice. A stop
        // becomes a notice only when the rendered answer has no existing gap.
        // Whenever the writer ran, `notice` records the lists and rows research read that it was not shown (ADR-0054).
        const notShownNotice = written === null ? undefined : agenticNotShownNoticeV1(notShown);
        const responseNotices = [
          ...new Set([...bundle.coverage.notices, ...filterNotices, ...(notShownNotice === undefined ? [] : [notShownNotice])]),
          ...(coverageLimited ? [LIMITED_COVERAGE_GAP] : []),
          ...(researchIncomplete && anyEvidence && draft.gap === undefined ? [INCOMPLETE_SEARCH_NOTICE] : []),
        ];
        const outcome = researchIncomplete ? "partial" as const : !anyEvidence ? (incomplete || unsupportedAction || absenceUnconfirmed || listGaps.some(gap => gap.partial) ? "partial" as const : "not_found" as const) : draft.status === "answered" ? "answered" as const : "partial" as const;
        // Preserve reason provenance before diagnostic gap strings are combined. Desktop actions never classify prose.
        // Only finished research confirms the writer's missing text: an interrupted search keeps its retry reason alone.
        const confirmedMissing = [...(researchIncomplete || absenceUnconfirmed || selectionNotFound.some(gap => !gap.confirmed) ? [] : reply?.not_found ?? []),
          ...selectionNotFound.filter(gap => gap.confirmed).map(gap => gap.text)];
        const missing = confirmedMissing.length > 0 ? gapLine(`Not found: ${confirmedMissing.join("; ")}.`)
          : outcome === "not_found" || (unsupportedAction && !anyEvidence && !incomplete && !absenceUnconfirmed && !listGaps.some(gap => gap.partial)
            && needs.length > 0 && needs.every(need => need.status === "not_found")) ? NOT_FOUND_GAP : undefined;
        const gapDetails = { ...(unsupportedAction ? { unsupported_action: true as const } : {}),
          ...(researchIncomplete ? { interrupted: true as const } : {}), ...(missing === undefined ? {} : { not_found: missing }) };
        // The blocks of the statements kept (ADR-0051), for a part with statements; a list's rows cite their items' citations.
        const indexesOf = (shorts: readonly string[]) => [...new Set(shorts.map(short => usedKeys.get(keyOf(short))!))];
        /** A list statement's table, its rows citing their items' citations. */
        const tableOf = (shape: Extract<DraftShape, { kind: "list" }>) => ({ ...shape, rows: shape.rows.map(row => ({ cells: row.cells, citation_indexes: indexesOf(row.shorts) })) });
        // Each writer item as its block shows it, and each list statement as its table or text. A part with no statements has nothing to lay out.
        const blocks = draft.statements.length === 0 ? undefined
          : contracted(buildAskBlocksV2(order.map(({ shape, item }, at): AskBlockStatementV2 => ({ citation_indexes: statements[at]!.citation_indexes,
            shape: item ?? (shape.kind === "list" ? tableOf(shape) : { kind: "text" }) }))), draft.statements, used.length);
        // ---- an Ask again's since (ADR-0047): what is different now, cited after everything the answer cites ----
        const since = sinceKept?.map(value => statementOf(value.text, value.shorts));
        const result = Object.freeze({
          schema_version: 8, kind: "echo-clean-person-answer-v8", scope: options.desk_scope, outcome,
          parts: Object.freeze([Object.freeze({
            question, status: draft.status === "answered" && Object.keys(gapDetails).length > 0 ? "partial" : draft.status,
            statements: released(draft.statements),
            ...(draft.gap === undefined ? {} : { gap: boundedBytes(draft.gap, 2 * 1024) }),
            ...(Object.keys(gapDetails).length === 0 ? {} : { gap_details: Object.freeze(gapDetails) }),
            ...(draft.records === undefined ? {} : { records: released(draft.records) }),
            ...(blocks === undefined ? {} : { blocks }),
          })]),
          citations: Object.freeze(anyEvidence ? used.map(entry => citationOfAgenticEvidenceItemV8(entry.item, timeZone)) : []),
          // The response holds a notice of 2 KiB: whole notices in order while they fit, the first that does not cut.
          ...(responseNotices.length === 0 ? {} : { notice: boundedBytes(responseNotices.join(" "), NOTICE_MAX_BYTES) }),
          // Only an answer to a request that carried its previous turn names its question and says what is different since (ADR-0047).
          ...(options.answers === undefined ? {} : { question: options.answers }),
          ...(since === undefined ? {} : { since: Object.freeze({ statements: released(since) }) }),
          // Only an answer that drafted follow-ups lists them (ADR-0053), so any other keeps its earlier shape.
          ...followUpIds,
        });
        // What of the reply survived the check, before byte fitting: a statement, a list it placed that code filled (its rows,
        // a selection that matched none, or a hand-pick of none: the writer saying no member answers), something it did not
        // find, or a follow-up it drafted (ADR-0054).
        const survived = reading.length > 0 || placedLists.size > 0 || notFound.length > 0 || drafts.length > 0;
        return { result, used, statements: reading.length, survived, dropped_lists: droppedLists };
      };
      // A reply is usable when something of it survives the check. Only one of which nothing survives takes the fallback
      // kept from before ADR-0054, as no reply does: code states the lists the plan's which_items needs cite, or the records
      // research read, or says nothing was found.
      const first = respond(answer, true, true);
      const usable = answer === null || first.survived;
      if (!usable) withheld = first.dropped_lists;
      // A writer that left no reply has already counted its fallback; one of whose reply nothing survived counts it here.
      if (!usable) observeCoreModelCorrectionV1("writer_fallback");
      const reply = usable ? answer : null;
      // An answer is released within its byte bound. An Ask again's that cannot fit with its `since` goes without it
      // (ADR-0047); one that still cannot fit keeps the most statements, from its start as it reads, that fit, and says the
      // rest did not.
      const inBytes = (responded: ReturnType<typeof respond>) => agenticAskResponseFitsV1(responded.result);
      const whole = usable ? first : respond(null, false, true);
      const unsaid = !inBytes(whole) && "since" in whole.result ? respond(reply, false, false) : whole;
      let fitted = unsaid;
      if (!inBytes(unsaid)) {
        let low = 1, high = respond(reply, false, false, Number.POSITIVE_INFINITY).statements;
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (inBytes(respond(reply, false, false, mid))) low = mid; else high = mid - 1; }
        fitted = respond(reply, false, false, low);
      }
      const { result, used } = fitted;
      const validated = compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV8);
      return Object.freeze({
        result: Object.freeze({ response: validated, writer_evidence: writerEvidence, follow_ups: drafts }),
        // `used` is in first-citation order, and fitting the byte bound drops
        // whole statements or records from the end, so the citations released
        // are always the first ones of `used`.
        cited: Object.freeze(used.slice(0, validated.citations.length).map(entry => entry.short)),
        // The writer never asks which one: only a follow-up's resolver does (ADR-0047).
        outcome: validated.outcome as Exclude<PersonAnswerResponseV8["outcome"], "clarify">,
        // A release built from the writer's own reply, the first one kept after a failed repair included, is no fallback.
        fallbacks: noReply || !usable ? 1 : 0,
        // Ask's answer is its direct statement and parts, and an answer to a request that carried its previous turn names
        // its question and what is different since (ADR-0047).
        answer_sha256: agenticAskAnswerSha256V1(validated, drafts),
      });
    },
  });
}
