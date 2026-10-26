import {
  personAnswerCitationKeyV8,
  validatePersonAnswerLayoutV1,
  type PersonAnswerBlockV1,
  type PersonAnswerResponseV8,
  type PersonAnswerPartV4,
} from "@echo-brain/organization-api";
import {
  AGENTIC_ASK_MAX_SENTENCES_V1,
  AgenticAskOutputErrorV1,
  ANSWER_LAYOUT_PROMPT,
  ANSWER_SINCE_PROMPT,
  answerLayoutSchema,
  answerLayoutSinceSchema,
  answerSchema,
  answerSinceSchema,
  cleanId,
  cleanLine,
  parseAnswer,
  partQuestion,
  type Answer,
  type AnswerSentence,
} from "../agentic-ask-v1-model-protocol.js";
import { agenticAskAnswerSha256V1, agenticAskResponseFitsV1, compactAndValidateAgenticAskResponseV1 } from "../agentic-ask-v1-response.js";
import { citationOfAgenticEvidenceItemV8, describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_WRITER_LISTS_MAX_V1,
  agenticListCheckedNoteV1,
  agenticListFilterNoticeV1,
  agenticListUncheckedNoticeV1,
  agenticListMembershipV1,
  agenticListMembersNounV1,
  agenticListNameSharesV1,
  agenticListSelectionNotFoundV1,
  agenticListSelectV1,
  agenticListStatementV1,
  agenticListTableV1,
  agenticOpenReadsV1,
  agenticPlanListsV1,
  agenticWriterListMemberV1,
  agenticWriterListV1,
  parseAgenticListIdV1,
  type AgenticListNounFormsV1,
  type AgenticListSelectionV1,
  type AgenticOpenReadsV1,
  type AgenticWriterListMemberV1,
  type AgenticWriterListV1,
} from "../agentic-list-evidence-v1.js";
import { AGENTIC_ASK_MIN_ANSWER_MS_V1, type AgenticModelCallV1 } from "../agentic-model-gate-v1.js";
import { callRendererModelV1, type AgenticRendererV1, type AgenticRenderInputV1 } from "../agentic-renderer-v1.js";
import { observeCoreModelCorrectionV1, type CoreRuntimeModelCorrectionV1 } from "../../shared/core-runtime-observation-v1.js";
import { buildAskLayoutV1, orderAskLayoutV1, type AskLayoutShapeV1 } from "./ask-layout-v1.js";

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence and the lists research read, then code lays out one cited
 * paragraph. Code writes the statement that counts and names a list's
 * members, first in the paragraph (ADR-0041): for every list a which_items
 * need of the plan cites, whatever the writer replies, and for each list the
 * writer chooses. The writer's sentences follow, each standing only on text it
 * read. With no usable writer reply code still states those lists, or falls
 * back to the records research read, or says what it could not find. An
 * Ask that asked for its layout (ADR-0045) gives its writer the layout prompt
 * and schema; its answer reads lead first and its part carries the blocks its
 * kept statements read as, or, when that cannot be released, it is exactly the
 * answer the same reply gives without layout.
 */

const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
/** An empty list whose date filter could not test some items (research tool contract v1): none of those it tested matched. */
const UNCHECKED_EMPTY_GAP = "None of the items that record the date asked for matched.";
const RECORDS_GAP = "I found these records, but could not write a verified summary.";
const INCOMPLETE_SEARCH_GAP = "I couldn't complete the search. Please try again.";
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
/** The response's bounds, unchanged by lists: 40 citations and ten statements in a part. */
const MAX_CITATIONS = 40;
const MAX_STATEMENTS = AGENTIC_ASK_MAX_SENTENCES_V1;
/** The writer runs in Ask's answer span; the audit records it as an `answer` call. */
const WRITER_CALL: AgenticModelCallV1 = Object.freeze({ role: "answer", span: "ask_answer" });
/** A laid-out Ask's writer (ADR-0045) marks each sentence's form and section, and a row's cells: a longer reply. */
const LAYOUT_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_000 });
/** An Ask again's writer (ADR-0047) also says what is different since: room for its sentences beside the answer. */
const SINCE_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_000 });
const LAYOUT_SINCE_WRITER_CALL: AgenticModelCallV1 = Object.freeze({ ...WRITER_CALL, output_tokens: 2_500 });

type Entry = AgenticEvidenceBundleItemV1;
/** A statement's shape before its citations are known: a list's rows name the items they cite. */
type DraftShape = Exclude<AskLayoutShapeV1, { kind: "list" }> | {
  readonly kind: "list"; readonly caption: string; readonly columns: readonly string[];
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
  /** The part carries its layout (answer layout v1, ADR-0045), because the client asked for it. */
  readonly layout?: boolean;
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

/**
 * A layout that passes the contract against the part's statements, or none: layout adds no claim, so an answer whose
 * layout code could not build reads as it would without one rather than failing.
 */
function laidOutBlocks(blocks: readonly PersonAnswerBlockV1[], statements: readonly { readonly citation_indexes: readonly number[] }[], citations: number): readonly PersonAnswerBlockV1[] | undefined {
  try { return validatePersonAnswerLayoutV1(blocks, statements, citations); } catch { return undefined; }
}

export function createAskRendererV1(options: CreateAskRendererV1Options): AgenticRendererV1<AskRendererInputV1, AskRenderedV1> {
  const laidOut = options.layout === true;
  const earlier = options.earlier;
  return Object.freeze({
    async render(input: AgenticRenderInputV1<AskRendererInputV1>) {
      const { bundle } = input;
      const askedQuestion = input.trigger_input.question;
      const researchIncomplete = !bundle.stop.completed;
      const byShort = new Map(bundle.items.map(entry => [entry.short, entry]));
      const entryOf = (short: string): Entry | undefined => {
        const id = cleanId(short);
        return id === null ? undefined : byShort.get(id);
      };
      const describe = (entry: Entry) => describeAgenticEvidenceItemV1(entry, options.context.time_zone ?? 'UTC');

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
      const viewOf = (list: (typeof lists)[number], cap?: number) => agenticWriterListV1(list, rows.get(list.id)!, stated.includes(list.id), cap);
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
        // Planner need text is intentionally excluded. Lists carry their filters (ADR-0041); this describes what
        // research read, not whether an arbitrary fact exists.
        research: {
          completed: !researchIncomplete, stop_reason: bundle.stop.reason, reads,
          notices: [...bundle.coverage.notices], omitted_evidence_items: bundle.items.filter(entry => entry.item.text !== undefined).length,
        },
      };
      // A laid-out Ask's writer is also told how to mark forms (ADR-0045), and an Ask again's what to say is different since
      // (ADR-0047); each has a longer reply's room. No other writer's prompt changes.
      const writerPrompt = [options.answer_prompt, ...(laidOut ? [ANSWER_LAYOUT_PROMPT] : []), ...(earlier === undefined ? [] : [ANSWER_SINCE_PROMPT])].join("\n\n");
      const writerCall = earlier === undefined ? (laidOut ? LAYOUT_WRITER_CALL : WRITER_CALL) : laidOut ? LAYOUT_SINCE_WRITER_CALL : SINCE_WRITER_CALL;
      const writerSchema = earlier === undefined ? (laidOut ? answerLayoutSchema : answerSchema) : laidOut ? answerLayoutSinceSchema : answerSinceSchema;
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
      /** The reply with each by-id selection kept to its list's members; one that names none of them is no use of the list. */
      const withMembers = (answer: Answer): Answer => Object.freeze({ ...answer, lists: Object.freeze(answer.lists.flatMap(use => {
        const kept = use.members?.filter(id => listById.get(use.id)?.members.includes(id) === true);
        if (kept !== undefined && kept.length < use.members!.length) observeCoreModelCorrectionV1("writer_unknown_id_dropped", use.members!.length - kept.length);
        return kept === undefined ? [use] : kept.length === 0 ? [] : [Object.freeze({ id: use.id, members: Object.freeze(kept) })];
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
        const parsed = withMembers(parseAnswer(value, { layout: laidOut, ...(earlier === undefined ? {} : { since: true }) }));
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
      const question = partQuestion(askedQuestion);
      /**
       * The response `reply` (the writer's answer, or null) gives, laid out (ADR-0045) or not, with an Ask again's `since`
       * (ADR-0047) or without it, and the items its citations cite, in order. Each call reads the reply afresh; only the
       * first counts the writer's corrections (`count`).
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
        const uses = reply?.lists ?? [];
        /** What the lists add to the gap, in order; `partial` when its rule makes the part partial whatever it names (W1, W2, W3). */
        const listGaps: { readonly text: string; readonly partial: boolean }[] = [];
        const selectionNotFound: string[] = [];
        /** The lists the answer uses: those the writer saw, in the order of its first use, then every stated list it did not use. */
        const usedLists = [...new Set([...uses.map(use => use.id).filter(id => writerById.has(id)), ...stated])].map(id => views.get(id)!);
        const unseen = uses.filter(use => !writerById.has(use.id)).length;
        if (unseen > 0) correct("writer_unknown_id_dropped", unseen);
        const naming: Naming[] = usedLists.flatMap(list => {
          const id = list.id, all = rows.get(id)!, noun = nounOf(list);
          const byId = uses.find(use => use.id === id && use.members !== undefined);
          const picked = byId === undefined ? undefined : all.filter(member => byId.members!.includes(member.id));
          // Code adds the full use of a stated list the writer gave no use saying which items exist (W3), whatever its members.
          const given = uses.find(use => use.id === id && use.members === undefined) ?? (stated.includes(id) ? { id } : undefined);
          const where = given?.where;
          const chosen = given === undefined ? undefined : agenticListSelectV1(all, where, list.filter.time_zone);
          // A use that says which items exist of a list that is not complete reads "at least", whatever it selects, and the part says so.
          if (chosen !== undefined && !list.complete) listGaps.push({ text: listEndGap(noun.plural), partial: true });
          // Two uses that select the same members are one statement, named by id, with the lead of the one that says which items exist.
          if (chosen !== undefined && picked !== undefined && chosen.length === picked.length && chosen.every(member => picked.includes(member))) return [{ list, noun, selected: picked, which: true, ...(where === undefined ? {} : { where }), by_id: true }];
          // A selection that names nothing is its not_found phrase (K); an empty list keeps the plain not-found answer.
          if (chosen?.length === 0 && where !== undefined) selectionNotFound.push(agenticListSelectionNotFoundV1(noun, list.filter, where));
          return [
            ...(chosen === undefined || chosen.length === 0 ? [] : [{ list, noun, selected: chosen, which: true, ...(where === undefined ? {} : { where }), by_id: false }]),
            ...(picked === undefined ? [] : [{ list, noun, selected: picked, which: false, by_id: true }]),
          ];
        });
        // At most 25 distinct members named across the answer (W6): those selected by id first, then the rest shared
        // round-robin, a member another statement names costing nothing; "and N more" counts from the list itself (addition 5).
        const shares = agenticListNameSharesV1(naming);
        const listStatements = naming.map((value, index) => {
          // An owner or status reads as the first selected member records it; a date range as the writer gave it.
          const where = value.where === undefined || !("value" in value.where) ? value.where : { field: value.where.field, value: value.selected[0]![value.where.field]! };
          const statement = agenticListStatementV1({
            noun: value.noun, filter: value.list.filter, count: value.list.count, complete: value.list.complete, selected: value.selected,
            share: shares[index]!.share, free: shares[index]!.free, ...(where === undefined ? {} : { where }), ...(value.by_id ? { by_id: true, which: value.which } : {}),
          });
          // Each named member cites its own row; with layout, a statement naming two or more names is a table, a row per name.
          const table = !laid ? undefined : agenticListTableV1({ selected: value.selected, names: statement.names, by_id: value.by_id, ...(value.list.filter.time_zone === undefined ? {} : { time_zone: value.list.filter.time_zone }) });
          const shape: DraftShape = table === undefined ? PROSE : {
            kind: "list", caption: statement.caption, columns: table.columns,
            rows: table.rows.map(row => ({ cells: row.cells, shorts: row.members.map(at => value.selected[at]!.id) })),
          };
          return { text: statement.text, shorts: statement.cited.map(at => value.selected[at]!.id), shape };
        });

        // ---- the writer's sentences (W1, W3, W4, W5) ---------------------------
        // A which_say list whose members were not all checked qualifies every sentence citing its members' text (W5).
        const unchecked = checking.map(id => views.get(id)!).filter(list => agenticListCheckedNoteV1(list) !== undefined);
        if (unchecked.length > 0) listGaps.push({ text: UNCHECKED_GAP, partial: false });
        if (unlisted) listGaps.push({ text: WHICH_GAP, partial: true });
        // A list whose date filter could not test some items (research tool contract v1) supports neither "none" nor "all" of
        // them: the part says how many were not checked, and is partial, even when the list is empty.
        let uncheckedEmpty = false;
        for (const list of [...new Set([...usedLists, ...checking.map(id => views.get(id)!)])]) {
          const text = agenticListUncheckedNoticeV1(list, nounOf(list));
          if (text === undefined) continue;
          listGaps.push({ text, partial: true });
          if (list.count === 0) uncheckedEmpty = true;
        }
        const sentences = reply?.sentences ?? [];
        // A sentence the kept reply still rests on rows or list ids is left out, and the part says so, never what it claimed.
        if (sentences.some(restsOnRows)) listGaps.push({ text: UNSUPPORTED_GAP, partial: true });
        // It stands on the items whose text the writer read (W1); after them, never as support, it cites the rows whose facts it
        // may carry: each row it cites that the writer saw, and each private row the writer saw of a list it cites (W6).
        const rowsOf = (id: string) => shownRows.has(id) ? [id] : writerById.get(parseAgenticListIdV1(id) ?? "L0")?.members.map(member => member.id).filter(short => privateItem(byShort.get(short)!.item)) ?? [];
        /** How a sentence reads (ADR-0045): a row whose sentence carries code's note reads as a bullet, so the note shows. Only a laid-out reply has forms. */
        const shapeOf = (sentence: AnswerSentence, noted: boolean): DraftShape => {
          const section = sentence.section === undefined ? {} : { section: sentence.section };
          if (sentence.form === "row" && !noted) return { kind: "row", ...section, columns: reply!.tables!.find(table => table.section === sentence.section)!.columns, cells: sentence.cells! };
          return { kind: sentence.form === undefined ? "text" : sentence.form === "row" ? "bullet" : sentence.form, ...section };
        };
        /** A writer's or `since` sentence as code keeps it: on the text the writer read (W1), then the rows it may carry, noted (W5); or none. */
        const drafted = (sentence: Pick<AnswerSentence, "text" | "evidence">) => {
          const read = sentence.evidence.filter(short => textGiven.has(short));
          if (read.length === 0) { correct("writer_uncited_sentence_dropped"); return undefined; }
          // An id that is no text, row or list the writer saw cites nothing.
          const unknown = sentence.evidence.filter(id => !textGiven.has(id) && !shownRows.has(id) && !writerById.has(parseAgenticListIdV1(id) ?? "L0")).length;
          if (unknown > 0) correct("writer_unknown_id_dropped", unknown);
          const notes = unchecked.filter(list => read.some(short => membership.in(list.id, short) !== undefined)).map(list => agenticListCheckedNoteV1(list)!);
          return { text: notes.length === 0 ? sentence.text : withNote(sentence.text, notes.join(" ")), shorts: [...read, ...sentence.evidence.flatMap(rowsOf)], read, noted: notes.length > 0 };
        };
        const writerSentences = sentences.flatMap(sentence => {
          const kept = drafted(sentence);
          return kept === undefined ? [] : [{ text: kept.text, shorts: kept.shorts, read: kept.read, shape: shapeOf(sentence, kept.noted) }];
        });
        // List statements come first, then the writer's sentences, each kept whole or dropped with all after it to fit the bounds (W6).
        // What fits is decided in that order whatever the layout, so a long lead never crowds out a stated list (W3). A laid-out
        // answer (ADR-0045) then reads what was kept lead first, then the lists, then the other sentences by section.
        type Laid = { text: string; shorts: readonly string[]; read?: readonly string[]; shape: DraftShape };
        const statementKeys = new Set<string>();
        const keptReads: Entry[] = [];
        const fitted: Laid[] = [];
        const fittedKeys = new Set<string>();
        let dropped = false;
        for (const sentence of [...listStatements, ...writerSentences] as readonly Laid[]) {
          // Temporary model guardrail (ADR-0041): only exact text with the same cited objects and privacy is a repeat.
          // Shared sources or planner kinds never establish that two sentences say the same thing.
          const statementKey = JSON.stringify([sentence.text, [...new Set(sentence.shorts.map(keyOf))].sort(), sentence.shorts.some(short => privateItem(byShort.get(short)!.item))]);
          if (statementKeys.has(statementKey)) {
            correct("writer_repeat_dropped");
            keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
            continue;
          }
          const fresh = new Set(sentence.shorts.map(keyOf).filter(key => !fittedKeys.has(key)));
          if (fitted.length >= MAX_STATEMENTS || fittedKeys.size + fresh.size > MAX_CITATIONS) { dropped = true; break; }
          statementKeys.add(statementKey);
          for (const key of fresh) fittedKeys.add(key);
          fitted.push(sentence);
          keptReads.push(...(sentence.read ?? []).map(short => byShort.get(short)!));
        }
        const kept = new Set(fitted);
        // Only a writer that marked no lead at all has its first sentence read as one (orderAskLayoutV1).
        const order: readonly Laid[] = laid ? orderAskLayoutV1(listStatements.filter(entry => kept.has(entry)), writerSentences.filter(entry => kept.has(entry)), sentences.some(sentence => sentence.form === "lead")) : fitted;
        const statements: Statement[] = order.map(sentence => statementOf(sentence.text, sentence.shorts));
        /** The shape of each statement kept, in order. */
        const shapes: readonly DraftShape[] = order.map(sentence => sentence.shape);
        const notFound = [...(reply?.not_found ?? []), ...selectionNotFound];
        // A list statement cites rows for which items exist; only the text the writer's sentences stand on can be limited coverage.
        const coverageLimited = coverageIsLimitedFor(bundle, keptReads);
        const incomplete = (reply === null && writerRuns) || (researchIncomplete && (statements.length === 0 || notFound.length > 0));
        const gapText = incomplete
          ? cleanLine(`${INCOMPLETE_SEARCH_GAP}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`, 600)
          : notFound.length === 0 ? undefined : cleanLine(`Not found: ${notFound.join("; ")}.`, 600);
        // What the lists add to the gap: a list not read to its end, a which_say list not fully checked, a list kind with no
        // list, a sentence left out for resting on rows, and what did not fit.
        const extraGaps = [...new Set(listGaps.map(gap => gap.text)), ...(dropped ? [FIT_GAP] : [])];
        const withGaps = (base: string | undefined) => {
          const gaps = [...(base === undefined ? [] : [base]), ...extraGaps];
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
            : { status: "not_found", statements: [], gap: withGaps(gapText ?? (uncheckedEmpty ? UNCHECKED_EMPTY_GAP : NOT_FOUND_GAP))! };
        }
        const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
        // What the person is told about the filters of every list the answer uses, and of those which_say needs check (W7).
        const filterNotices = [...new Set([...usedLists, ...checking.map(id => views.get(id)!)])].flatMap(list => agenticListFilterNoticeV1(list, nounOf(list).plural) ?? []);
        // A completed answer can retain source coverage as a notice. A stop
        // becomes a notice only when the rendered answer has no existing gap.
        const responseNotices = [
          ...new Set([...bundle.coverage.notices, ...filterNotices]),
          ...(coverageLimited ? [LIMITED_COVERAGE_GAP] : []),
          ...(researchIncomplete && anyEvidence && draft.gap === undefined ? [INCOMPLETE_SEARCH_NOTICE] : []),
        ];
        const outcome = !anyEvidence ? (incomplete || listGaps.some(gap => gap.partial) ? "partial" as const : "not_found" as const) : draft.status === "answered" ? "answered" as const : "partial" as const;
        // The blocks of the statements kept (ADR-0045), only for a part with statements; a list's rows cite their items' citations.
        const indexesOf = (shorts: readonly string[]) => [...new Set(shorts.map(short => usedKeys.get(keyOf(short))!))];
        const layout = !laid || draft.statements.length === 0 ? undefined : laidOutBlocks(buildAskLayoutV1(draft.statements.map((value, index) => {
          const shape = shapes[index]!;
          return { citation_indexes: value.citation_indexes, shape: shape.kind !== "list" ? shape : { ...shape, rows: shape.rows.map(row => ({ cells: row.cells, citation_indexes: indexesOf(row.shorts) })) } };
        })), draft.statements, used.length);
        // ---- an Ask again's since (ADR-0047): what is different now, after everything the answer cites ----
        // Only beside an answer with evidence: one with none cannot say what changed. Each sentence stands on text the writer
        // read (W1), as the writer's own sentences do, and repeats are dropped. A list the writer gave whose every sentence
        // was left out says nothing, never that nothing changed; one that cannot fit the citation bound whole is left out
        // whole, since cut short it would say less changed than did.
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
          if (usedKeys.size + fresh.size > MAX_CITATIONS) return undefined;
          return drafts.map(value => statementOf(value.text, value.shorts));
        };
        const since = !withSince || reply?.since === undefined || !anyEvidence ? undefined : sinceOf(reply.since);
        const result = Object.freeze({
          schema_version: 8, kind: "echo-clean-person-answer-v8", scope: options.desk_scope, outcome,
          parts: Object.freeze([Object.freeze({
            question, status: draft.status,
            statements: released(draft.statements),
            ...(draft.gap === undefined ? {} : { gap: draft.gap }),
            ...(draft.records === undefined ? {} : { records: released(draft.records) }),
            ...(layout === undefined ? {} : { layout }),
          })]),
          citations: Object.freeze(anyEvidence ? used.map(entry => citationOfAgenticEvidenceItemV8(entry.item, options.context.time_zone ?? 'UTC')) : []),
          ...(responseNotices.length === 0 ? {} : { notice: responseNotices.join(" ") }),
          // Only an answer to a request that carried its previous turn names its question and says what is different since (ADR-0047).
          ...(options.answers === undefined ? {} : { question: options.answers }),
          ...(since === undefined ? {} : { since: Object.freeze({ statements: released(since) }) }),
        });
        return { result, used, laid_out: layout !== undefined };
      };
      /** A laid-out response as it may be released: with its layout, within its byte bound. Each is measured once, and only then. */
      const releasable = (responded: ReturnType<typeof respond>) => responded.laid_out && agenticAskResponseFitsV1(responded.result) ? responded : undefined;
      const laidOutResponse = laidOut ? respond(answer, true, true, true) : undefined;
      // A laid-out answer is released only with its layout and within its byte bound; an Ask again's that cannot fit with its
      // `since` keeps its layout without it (ADR-0047). Otherwise the same claims are released without layout, in the order
      // and numbering an answer without layout has (ADR-0045): a row is still its cells' claim, and what cannot fit the bound
      // is dropped from the end and said to be missing, an Ask again's `since` first.
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
