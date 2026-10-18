import { MISSING_EVENT_DATE_NOTICE_V1 } from "../../shared/temporal-query-v1.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  personAnswerCitationKeyV7,
  type PersonAnswerPartV4,
  type PersonAnswerResponseV4,
  type PersonAnswerResponseV5,
  type PersonAnswerResponseV6,
  type PersonAnswerResponseV7,
} from "@echo-brain/organization-api";
import {
  AGENTIC_ASK_MAX_SENTENCES_V1,
  AgenticAskOutputErrorV1,
  answerSchema,
  cleanId,
  cleanLine,
  parseAnswer,
  partQuestion,
  type Answer,
  type AnswerSentence,
} from "../agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "../agentic-ask-v1-response.js";
import { citationOfAgenticEvidenceItemV1, describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_WRITER_LISTS_MAX_V1,
  AGENTIC_LIST_WRITER_MEMBERS_MAX_V1,
  agenticListCheckedNoteV1,
  agenticListFilterNoticeV1,
  agenticListMembershipV1,
  agenticListMembersNounV1,
  agenticListNameSharesV1,
  agenticListSelectionNotFoundV1,
  agenticListSelectV1,
  agenticListStatementV1,
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

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence and the lists research read, then code lays out one cited
 * paragraph. Code writes the statement that counts and names a list's
 * members, first in the paragraph (ADR-0041): for every list a which_items
 * need of the plan cites, whatever the writer replies, and for each list the
 * writer chooses. The writer's sentences follow, each standing only on text it
 * read. With no usable writer reply code still states those lists, or falls
 * back to the records research read, or says what it could not find.
 */

const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
const RECORDS_GAP = "I found these records, but could not write a verified summary.";
const INCOMPLETE_SEARCH_GAP = "I couldn't complete the search. Please try again.";
const MISSING_DATE_GAP = "I can't verify the requested date because some accessible meeting sources have no recorded event date.";
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

type Entry = AgenticEvidenceBundleItemV1;
type AskResponse = PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7;

export interface AskRendererInputV1 {
  readonly question: string;
}
export interface AskRenderedV1 {
  readonly response: AskResponse;
  /** Short ids the writer was given, in order: items whose text it read, then list rows it saw; empty when no writer call ran. */
  readonly writer_evidence: readonly string[];
}

export interface CreateAskRendererV1Options {
  /** 4 (V1 core), 5 (V2), 6 (V3 and the research core) or 7 (V4: follow-ups, ADR-0040). */
  readonly response_version: 4 | 5 | 6 | 7;
  /** The writer's system prompt, with the live-source guidance when live sources are available. */
  readonly answer_prompt: string;
  /** The sources research could read, as the research model saw them. */
  readonly source_catalog: readonly Readonly<Record<string, unknown>>[];
  /** What the writer is told the desk reads. */
  readonly scope: string;
  /** Who is asking and today's date. */
  readonly context: { readonly asked_by?: string; readonly today: string };
  /** The response's scope: the desk's. */
  readonly desk_scope: AgenticEvidenceBundleV1["gathered_for"]["scope"];
}

function bytes(value: string | undefined): number { return value === undefined ? 0 : Buffer.byteLength(value, "utf8"); }

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

export function createAskRendererV1(options: CreateAskRendererV1Options): AgenticRendererV1<AskRendererInputV1, AskRenderedV1> {
  const responseVersion = options.response_version;
  const tickets = responseVersion >= 5;
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
      const describe = describeAgenticEvidenceItemV1;

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
      // Content needs, whatever their status, and what they cite: the members they ask about (W4). A not_found need still asks.
      const content = needs.filter(need => (need.kind ?? "content") === "content"), contentCited = content.flatMap(need => need.evidence);
      /** Every need that asks about members declares them by what it cites, whatever its status: a list kind its list, a content need an item (W4). */
      const declared = !unlisted && content.every(need => need.evidence.some(id => byShort.has(id)));
      const checked = checkedItems(bundle, agenticOpenReadsV1(bundle.rounds, short => byShort.get(short)?.full === true));
      const rows = new Map(lists.map(list => [list.id, list.members.map(short => agenticWriterListMemberV1(byShort.get(short)!, checked.has(short)))]));
      const viewOf = (list: (typeof lists)[number], cap?: number) => agenticWriterListV1(list, rows.get(list.id)!, stated.includes(list.id), cap);
      /** Every list as code reads it: code states, notes and filters each list the plan's kinds read, past the writer's bound too. */
      const views = new Map(lists.map(list => [list.id, viewOf(list)]));
      // The writer sees at most 5 lists, the plan's first.
      const writerOrder = [...new Set([...stated, ...checking, ...lists.map(list => list.id)])].slice(0, AGENTIC_LIST_WRITER_LISTS_MAX_V1).map(id => listById.get(id)!);
      const writerListsWith = (cap: number) => writerOrder.map(list => viewOf(list, cap));
      /** What a list's members are called: their desk kinds, after the catalog's tool (ADR-0041). */
      const nounOf = (list: AgenticWriterListV1) => {
        const tool = options.source_catalog.find(entry => entry.source === list.source)?.tool_id;
        return agenticListMembersNounV1({ selector: list.source, ...(typeof tool === "string" ? { tool_id: tool } : {}) }, rows.get(list.id)!.map(member => member.kind));
      };

      // ---- final answer ---------------------------------------------------
      const answerContext = {
        question: askedQuestion, ...options.context, scope: options.scope, source_catalog: options.source_catalog,
        // Planner need text is intentionally excluded. Lists carry their filters (ADR-0041); this describes what
        // research read, not whether an arbitrary fact exists.
        research: {
          completed: !researchIncomplete, stop_reason: bundle.stop.reason, reads: bundle.coverage.reads,
          notices: [...bundle.coverage.notices], omitted_evidence_items: bundle.items.filter(entry => entry.item.text !== undefined).length,
        },
      };
      const contextBudget = Math.max(0, input.prompt_budget(options.answer_prompt) - bytes(JSON.stringify({ ...answerContext, lists: [], evidence: [] })));
      // Lists' rows take at most half the room; a smaller window shows fewer members of each, never fewer lists.
      let memberCap = AGENTIC_LIST_WRITER_MEMBERS_MAX_V1;
      let writerLists: readonly AgenticWriterListV1[] = writerListsWith(memberCap);
      while (memberCap > 0 && bytes(JSON.stringify(writerLists)) > contextBudget / 2) { memberCap = Math.floor(memberCap / 2); writerLists = writerListsWith(memberCap); }
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
      const withMembers = (answer: Answer): Answer => answer.lists === undefined ? answer : Object.freeze({ ...answer, lists: Object.freeze(answer.lists.flatMap(use => {
        const kept = use.members?.filter(id => listById.get(use.id)?.members.includes(id) === true);
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
        const parsed = withMembers(parseAnswer(value, { lists: true }));
        last.answer = parsed;
        if (parsed.sentences.some(restsOnRows) && repairable()) throw new AgenticAskOutputErrorV1(ROWS_REASON);
        return parsed;
      };

      const writerRuns = evidence.length > 0 || writerLists.some(list => list.count > 0);
      const written = !writerRuns ? null : await callRendererModelV1(input, WRITER_CALL, options.answer_prompt, {
        ...answerContext,
        lists: writerLists,
        // Working hypotheses are not user requirements or evidence. The
        // writer assesses the original question against released text.
        evidence: evidence.map(entry => ({ ...describe(entry), text: entry.item.text })),
      }, answerSchema, parse);
      // A reply sent back only for a sentence resting on rows is still the writer's answer; code leaves that sentence out.
      const answer = written === null ? null : written.value ?? last.answer;
      const writerEvidence: readonly string[] = written === null ? [] : writerShown;

      // ---- layout (code, not model): one part, read as one paragraph ------
      type Statement = { text: string; citation_indexes: number[]; private: boolean };
      const used: Entry[] = [];
      const usedKeys = new Map<string, number>();
      // One citation per key, the key the Ask response checks for duplicates: a listed ticket's row and its opened body
      // are two items with one key, so they share one citation.
      const keyOf = (short: string) => personAnswerCitationKeyV7(byShort.get(short)!.item.citation);
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
      const question = partQuestion(askedQuestion);

      // ---- statements (W2, W3): each list's use that says which items exist, then its use by id ----
      /** One statement of a list; `which` when it says which items exist (a use in full or by `where`), never for a use by id alone. */
      type Naming = { readonly list: AgenticWriterListV1; readonly noun: AgenticListNounFormsV1; readonly selected: readonly AgenticWriterListMemberV1[]; readonly which: boolean; readonly where?: AgenticListSelectionV1; readonly by_id: boolean };
      const uses = answer?.lists ?? [];
      /** What the lists add to the gap, in order; `partial` when its rule makes the part partial whatever it names (W1, W2, W3). */
      const listGaps: { readonly text: string; readonly partial: boolean }[] = [];
      const selectionNotFound: string[] = [];
      /** The lists the answer uses: those the writer saw, in the order of its first use, then every stated list it did not use. */
      const usedLists = [...new Set([...uses.map(use => use.id).filter(id => writerById.has(id)), ...stated])].map(id => views.get(id)!);
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
        // Each named member cites its own row.
        return { text: statement.text, shorts: statement.cited.map(at => value.selected[at]!.id) };
      });

      // ---- the writer's sentences (W1, W3, W4, W5) ---------------------------
      // A which_say list whose members were not all checked qualifies every sentence citing its members' text (W5).
      const unchecked = checking.map(id => views.get(id)!).filter(list => agenticListCheckedNoteV1(list) !== undefined);
      if (unchecked.length > 0) listGaps.push({ text: UNCHECKED_GAP, partial: false });
      if (unlisted) listGaps.push({ text: WHICH_GAP, partial: true });
      const sentences = answer?.sentences ?? [];
      // A sentence the kept reply still rests on rows or list ids is left out, and the part says so, never what it claimed.
      if (sentences.some(restsOnRows)) listGaps.push({ text: UNSUPPORTED_GAP, partial: true });
      // A sentence that only restates a stated list (W4), once every need declares: each text item it cites is a member, or
      // part of one, of a stated list whose statement covers every member (named, or in "and N more"; a where selection that
      // leaves one out covers none), that no other need asks about: no which_say list holds it, no content need cites it.
      const covering = naming.filter(value => value.which && stated.includes(value.list.id) && rows.get(value.list.id)!.every(member => value.selected.includes(member))).map(value => value.list.id);
      const restates = (shorts: readonly string[]) => declared && shorts.every(short => covering.some(id => {
        const member = membership.in(id, short);
        return member !== undefined && !checking.some(other => membership.in(other, short) !== undefined) && !contentCited.some(cited => membership.in(id, cited) === member);
      }));
      // Its citations are the items whose text the writer read; row ids and list ids are no citations (W1).
      const writerSentences = sentences.flatMap(sentence => {
        const shorts = sentence.evidence.filter(short => textGiven.has(short));
        if (shorts.length === 0 || restates(shorts)) return [];
        const notes = unchecked.filter(list => shorts.some(short => membership.in(list.id, short) !== undefined)).map(list => agenticListCheckedNoteV1(list)!);
        return [{ text: notes.length === 0 ? sentence.text : withNote(sentence.text, notes.join(" ")), shorts }];
      });
      // List statements come first, then the writer's sentences, all dropped from the end to fit the response's bounds (W6).
      const statements: Statement[] = [];
      let dropped = false;
      for (const sentence of [...listStatements, ...writerSentences]) {
        const fresh = new Set(sentence.shorts.map(keyOf).filter(key => !usedKeys.has(key)));
        if (statements.length >= MAX_STATEMENTS || used.length + fresh.size > MAX_CITATIONS) { dropped = true; break; }
        statements.push(statementOf(sentence.text, sentence.shorts));
      }
      const notFound = [...(answer?.not_found ?? []), ...selectionNotFound];
      // A list statement cites rows for which items exist; only what the writer's sentences cite can be limited coverage.
      const coverageLimited = coverageIsLimitedFor(bundle, writerSentences.slice(0, Math.max(0, statements.length - listStatements.length)).flatMap(sentence => sentence.shorts.map(short => byShort.get(short)!)));
      const incomplete = (answer === null && writerRuns) || (researchIncomplete && (statements.length === 0 || notFound.length > 0));
      const dateCoverageMissing = bundle.coverage.notices.some(notice => notice.includes(MISSING_EVENT_DATE_NOTICE_V1));
      const incompleteGap = dateCoverageMissing ? MISSING_DATE_GAP : INCOMPLETE_SEARCH_GAP;
      const gapText = incomplete
        ? cleanLine(`${incompleteGap}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`, 600)
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
        const gap = withGaps(answer === null ? LIST_FALLBACK_GAP : gapText);
        draft = gap === undefined ? { status: "answered", statements } : { status: "partial", statements, gap };
      } else {
        // Honor a completed writer's no-match result instead of substituting research-selected records.
        // Raw fallback remains limited to research-read evidence; merely sending
        // a search passage to a failed writer does not make it a useful answer.
        const fallback = notFound.length > 0 ? [] : (answer === null ? evidence.filter(entry => entry.full) : cited.filter(entry => textGiven.has(entry.short))).slice(0, 3);
        const records = fallback.map(entry => statementOf(entry.item.text!, [entry.short]));
        draft = records.length > 0
          ? { status: "records_only", statements: [], records, gap: withGaps(RECORDS_GAP)! }
          : { status: "not_found", statements: [], gap: withGaps(gapText ?? (dateCoverageMissing ? MISSING_DATE_GAP : incomplete ? INCOMPLETE_SEARCH_GAP : NOT_FOUND_GAP))! };
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
      const result = Object.freeze({
        schema_version: responseVersion, kind: responseVersion === 7 ? "echo-clean-person-answer-v7" : responseVersion === 6 ? "echo-clean-person-answer-v6" : tickets ? "echo-clean-person-answer-v5" : "echo-clean-person-answer-v4", scope: options.desk_scope, outcome,
        parts: Object.freeze([Object.freeze({
          question, status: draft.status,
          statements: Object.freeze(draft.statements.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))),
          ...(draft.gap === undefined ? {} : { gap: draft.gap }),
          ...(draft.records === undefined ? {} : { records: Object.freeze(draft.records.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))) }),
        })]),
        citations: Object.freeze(anyEvidence ? used.map(entry => citationOfAgenticEvidenceItemV1(entry.item)) : []),
        ...(responseNotices.length === 0 ? {} : { notice: responseNotices.join(" ") }),
      });
      const validated: AskResponse = responseVersion === 7 ? compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV7) : responseVersion === 6 ? compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV6) : tickets ? compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV5) : compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV4);
      return Object.freeze({
        result: Object.freeze({ response: validated, writer_evidence: writerEvidence }),
        // `used` is in first-citation order, and fitting the byte bound drops
        // whole statements or records from the end, so the citations released
        // are always the first ones of `used`.
        cited: Object.freeze(used.slice(0, validated.citations.length).map(entry => entry.short)),
        outcome: validated.outcome,
        fallbacks: written?.value === null ? 1 : 0,
        // Ask's answer is its direct statement and parts.
        answer_sha256: canonicalSha256({ direct: validated.direct ?? null, parts: validated.parts }),
      });
    },
  });
}
