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
} from "../agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "../agentic-ask-v1-response.js";
import { citationOfAgenticEvidenceItemV1, describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_WRITER_LISTS_MAX_V1,
  AGENTIC_LIST_WRITER_MEMBERS_MAX_V1,
  agenticListCheckedNoteV1,
  agenticListMembershipV1,
  agenticListMembersNounV1,
  agenticListNameSharesV1,
  agenticListSelectionNotFoundV1,
  agenticListSelectV1,
  agenticListStatementV1,
  agenticNeedSupportV1,
  agenticOpenReadsV1,
  agenticWriterListMemberV1,
  agenticWriterListV1,
  parseAgenticListIdV1,
  type AgenticAnswerListUseV1,
  type AgenticListIdV1,
  type AgenticOpenReadsV1,
  type AgenticWriterListMemberV1,
  type AgenticWriterListV1,
} from "../agentic-list-evidence-v1.js";
import { AGENTIC_ASK_MIN_ANSWER_MS_V1, type AgenticModelCallV1 } from "../agentic-model-gate-v1.js";
import { callRendererModelV1, type AgenticRendererV1, type AgenticRenderInputV1 } from "../agentic-renderer-v1.js";

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence and the lists research read, then code lays out one cited
 * paragraph. For each list the answer uses, code writes the statement that
 * counts and names its members, first in the paragraph (ADR-0041); the
 * writer's sentences follow. Code checks that the answer uses the lists it
 * should, with the writer's one repair, and otherwise writes those lists
 * itself. With no usable writer reply it writes the lists research found the
 * answer in, or falls back to the records research read, or says what it
 * could not find.
 */

const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
const RECORDS_GAP = "I found these records, but could not write a verified summary.";
const INCOMPLETE_SEARCH_GAP = "I couldn't complete the search. Please try again.";
const MISSING_DATE_GAP = "I can't verify the requested date because some accessible meeting sources have no recorded event date.";
const INCOMPLETE_SEARCH_NOTICE = "Research stopped before it finished, so relevant context may be missing.";
const LIMITED_COVERAGE_GAP = "Some source coverage was incomplete, so relevant context may be missing.";
const LIST_FALLBACK_GAP = "I found these items, but could not write the rest of the answer.";
const UNCHECKED_GAP = "Not every listed item was checked, so others may also match.";
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
  const checked = new Set<string>(opens.clean.keys());
  for (const entry of bundle.items) if (entry.full && !opens.limited.has(entry.short)) checked.add(entry.short);
  return checked;
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

      // ---- lists (ADR-0041): which the plan rests on, and how the writer sees them ----
      const lists = bundle.lists ?? [];
      const listById = new Map(lists.map(list => [list.id, list]));
      /** Which list member an item is, or is part of: an opened page's section is its page. */
      const membership = agenticListMembershipV1(lists, bundle.items);
      const full = (short: string) => byShort.get(short)?.full === true;
      /** What research's opens read: the same relation its finish check used. */
      const opens = agenticOpenReadsV1(bundle.rounds, full, cleanId);
      /** Lists a found need of the plan rests on, in the plan's order. */
      const relied: AgenticListIdV1[] = [];
      for (const part of bundle.plan) for (const need of part.needs) {
        if (need.status !== "found") continue;
        const support = agenticNeedSupportV1(need.evidence, { list: id => listById.has(id), full, member_of: membership.first, opened: short => opens.clean.get(short) ?? [] });
        for (const id of support.lists) if (!relied.includes(id)) relied.push(id);
      }
      const checked = checkedItems(bundle, opens);
      // The writer sees at most 5 lists, the plan's first; code names members from every row, past the writer's bound too.
      const writerOrder = [...relied.map(id => listById.get(id)!), ...lists.filter(list => !relied.includes(list.id))].slice(0, AGENTIC_LIST_WRITER_LISTS_MAX_V1);
      const rows = new Map(writerOrder.map(list => [list.id, list.members.map(short => agenticWriterListMemberV1(byShort.get(short)!, checked.has(short)))]));
      const writerListsWith = (cap: number) => writerOrder.map(list => agenticWriterListV1(list, rows.get(list.id)!, relied.includes(list.id), cap));
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
      /** Items whose text the writer reads, and list members it sees as rows: a sentence may cite either. */
      const textGiven = new Set(evidence.map(entry => entry.short));
      const shownRows = writerLists.flatMap(list => list.members.map(member => member.id)).filter(short => !textGiven.has(short));
      const allowed = new Set([...textGiven, ...shownRows]);
      const writerShown: readonly string[] = Object.freeze([...evidence.map(entry => entry.short), ...new Set(shownRows)]);
      input.on_context?.(writerShown);

      // ---- code's check of the lists (ADR-0041) -----------------------------
      const keptSentences = (answer: Answer) => answer.sentences.filter(sentence => sentence.evidence.some(short => allowed.has(short)));
      /** The members of `list` that `shorts` are, or are part of, each once. */
      const membersCited = (list: AgenticListIdV1, shorts: readonly string[]) => new Set(shorts.flatMap(short => membership.in(list, short) ?? []));
      /** The members of `list` a sentence's `shorts` name by their rows alone: cited as rows without text, and none of their text cited beside. */
      const rowsOnly = (list: AgenticListIdV1, shorts: readonly string[]) => {
        const read = membersCited(list, shorts.filter(short => textGiven.has(short)));
        return new Set([...membersCited(list, shorts.filter(short => !textGiven.has(short)))].filter(member => !read.has(member)));
      };
      /**
       * The answer uses a list when it names it in "lists", or when a sentence claims content across it: the list's id
       * beside text the writer read that is not one of the list's own rows (an opened section, or an item outside the
       * list). A list id beside rows, or beside members' own rows that carry text (a follow-up, an opened meeting record),
       * never stands in for the statement code writes, so "the pages are A, B, C and D" citing L1 and four rows, and "you
       * have 10 open follow-ups" citing L1 and ten of them, are still subsets.
       */
      const usesList = (answer: Answer, id: AgenticListIdV1) => (answer.lists ?? []).some(use => use.id === id) ||
        keptSentences(answer).some(sentence => sentence.evidence.includes(id) && sentence.evidence.some(short => textGiven.has(short) && membership.in(id, short) !== short));
      /**
       * Lists the answer should use but does not: one the plan rests on, or one it cites some, not all, members of. A
       * member counts whether the writer has its text or only its row (a follow-up's row carries its text), and an
       * opened section counts as its page. Rows are list facts only, so a sentence naming two or more members by their
       * rows names part of the list whatever else it cites: only "lists" uses the list then.
       */
      const listProblems = (answer: Answer): readonly { readonly id: AgenticListIdV1; readonly reason: string }[] => writerLists.flatMap(list => {
        if (list.count === 0 || (answer.lists ?? []).some(use => use.id === list.id)) return [];
        const cited = keptSentences(answer).map(sentence => sentence.evidence.filter(short => allowed.has(short)));
        const subset = (count: number) => count >= 2 && count < list.count
          ? [{ id: list.id, reason: `the answer cites ${count} of the ${list.count} members of list ${list.id} without the list: put {"id": "${list.id}"} in "lists", with "where" to select by owner or status, so code names every matching member; for what those members say, cite ${list.id} beside their evidence` }]
          : [];
        const byRows = subset(new Set(cited.flatMap(shorts => [...rowsOnly(list.id, shorts)])).size);
        if (usesList(answer, list.id)) return byRows;
        if (list.cited_by_plan) return [{ id: list.id, reason: `research found this answer in list ${list.id}, which the answer does not use: put {"id": "${list.id}"} in "lists" so code names its ${list.count} members` }];
        return byRows.length > 0 ? byRows : subset(membersCited(list.id, cited.flat()).size);
      });
      // A failed check takes the writer's one repair when the first reply fails it and a repair can still run; the
      // repaired reply, or a first reply no repair can follow, is kept and code writes the lists it should have used.
      const callsBefore = input.gate.stats().calls;
      const last: { answer: Answer | null } = { answer: null };
      const repairable = () => {
        const stats = input.gate.stats();
        return stats.calls === callsBefore + 1 && stats.calls < bundle.budget.max_model_calls && input.remaining() >= AGENTIC_ASK_MIN_ANSWER_MS_V1;
      };
      const parse = (value: unknown): Answer => {
        const parsed = parseAnswer(value, { lists: true });
        last.answer = parsed;
        const problems = listProblems(parsed);
        if (problems.length > 0 && repairable()) throw new AgenticAskOutputErrorV1(problems.map(problem => problem.reason).join("; "));
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
      // A reply that failed only the list check is still the writer's answer; code adds the lists.
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

      // Lists the answer uses, then those code writes: after a failed check, or, with no usable reply, those the plan rests on.
      const forced: readonly AgenticListIdV1[] = answer === null
        ? relied.filter(id => (writerById.get(id)?.count ?? 0) > 0)
        : listProblems(answer).map(problem => problem.id);
      const uses: { readonly list: AgenticWriterListV1; readonly where?: AgenticAnswerListUseV1["where"] }[] = [];
      for (const use of answer?.lists ?? []) {
        const list = writerById.get(use.id);
        if (list !== undefined && !uses.some(value => value.list.id === use.id)) uses.push({ list, ...(use.where === undefined ? {} : { where: use.where }) });
      }
      for (const id of forced) if (!uses.some(value => value.list.id === id)) uses.push({ list: writerById.get(id)! });
      const listGaps: string[] = [];
      const selectionNotFound: string[] = [];
      const naming = uses.flatMap(use => {
        if (use.list.count === 0) return [];
        const noun = nounOf(use.list);
        if (!use.list.complete) listGaps.push(listEndGap(noun.plural));
        const selected: readonly AgenticWriterListMemberV1[] = agenticListSelectV1(rows.get(use.list.id)!, use.where);
        if (selected.length === 0) { selectionNotFound.push(agenticListSelectionNotFoundV1(noun, use.list.filter, use.where!)); return []; }
        return [{ ...use, noun, selected }];
      });
      // At most 25 names across the answer, then "and N more", N from the list itself (addition 5).
      const shares = agenticListNameSharesV1(naming.map(value => value.selected.length));
      const listStatements: Statement[] = naming.map((value, index) => {
        const field = value.where?.field;
        const statement = agenticListStatementV1({
          noun: value.noun, filter: value.list.filter, count: value.list.count, complete: value.list.complete, selected: value.selected, share: shares[index]!,
          ...(field === undefined ? {} : { where: { field, value: value.selected[0]![field]! } }),
        });
        // Each named member cites its own row.
        return statementOf(statement.text, statement.cited.map(index => value.selected[index]!.id));
      });

      // The writer's sentences: cited ids it was given, each list it cites adding no citation of its own. A sentence that
      // names two or more members of a list code wrote after the check by their rows, whatever else it cites, restates
      // part of that list, which code now names in full; so does one that cites only that list's members (or their opened
      // sections), two or more of them or rows only. A sentence about one member's text stays.
      const restates = (shorts: readonly string[]) => forced.some(id => rowsOnly(id, shorts).size >= 2) ||
        (shorts.every(short => forced.some(id => membership.in(id, short) !== undefined)) &&
          (new Set(forced.flatMap(id => [...membersCited(id, shorts)])).size >= 2 || !shorts.some(short => textGiven.has(short))));
      const writerSentences = (answer?.sentences ?? []).flatMap(sentence => {
        const shorts = sentence.evidence.filter(short => allowed.has(short));
        if (shorts.length === 0 || restates(shorts)) return [];
        // A sentence that claims content across a list cites the list beside text it read: say how much was checked (addition 4).
        const notes = !shorts.some(short => textGiven.has(short)) ? [] : sentence.evidence.flatMap(id => {
          const list = writerById.get(parseAgenticListIdV1(id) ?? "L0");
          const note = list === undefined ? undefined : agenticListCheckedNoteV1(list);
          return note === undefined ? [] : [note];
        });
        if (notes.length > 0) listGaps.push(UNCHECKED_GAP);
        return [{ text: notes.length === 0 ? sentence.text : withNote(sentence.text, notes.join(" ")), shorts }];
      });
      // List statements come first; the writer's sentences fill the room left, dropped from the end to fit.
      const statements: Statement[] = [...listStatements];
      const contentUsed: Entry[] = [];
      let dropped = false;
      for (const sentence of writerSentences) {
        const fresh = new Set(sentence.shorts.map(keyOf).filter(key => !usedKeys.has(key)));
        if (statements.length >= MAX_STATEMENTS || used.length + fresh.size > MAX_CITATIONS) { dropped = true; break; }
        statements.push(statementOf(sentence.text, sentence.shorts));
        for (const short of sentence.shorts) { const entry = byShort.get(short)!; if (!contentUsed.includes(entry)) contentUsed.push(entry); }
      }
      const notFound = [...(answer?.not_found ?? []), ...selectionNotFound];
      // A list statement cites rows for which items exist; only what the writer's sentences cite can be limited coverage.
      const coverageLimited = coverageIsLimitedFor(bundle, contentUsed);
      const incomplete = (answer === null && writerRuns) || (researchIncomplete && (statements.length === 0 || notFound.length > 0));
      const dateCoverageMissing = bundle.coverage.notices.some(notice => notice.includes(MISSING_EVENT_DATE_NOTICE_V1));
      const incompleteGap = dateCoverageMissing ? MISSING_DATE_GAP : INCOMPLETE_SEARCH_GAP;
      const gapText = incomplete
        ? cleanLine(`${incompleteGap}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`, 600)
        : notFound.length === 0 ? undefined : cleanLine(`Not found: ${notFound.join("; ")}.`, 600);
      // What the lists add to the gap: a list not read to its end, content not checked across a list, and what did not fit.
      const extraGaps = [...new Set(listGaps), ...(dropped ? [FIT_GAP] : [])];
      const withGaps = (base: string | undefined) => {
        const gaps = [...(base === undefined ? [] : [base]), ...extraGaps];
        return gaps.length === 0 ? undefined : cleanLine(gaps.join(" "), 600);
      };
      type Draft = { status: PersonAnswerPartV4["status"]; statements: Statement[]; gap?: string; records?: Statement[] };
      let draft: Draft;
      if (statements.length > 0) {
        // With no usable writer reply, code wrote the lists research found the answer in (ADR-0041).
        const gap = withGaps(answer === null ? LIST_FALLBACK_GAP : gapText);
        draft = gap === undefined ? { status: "answered", statements } : { status: "partial", statements, gap };
      } else {
        // Honor a completed writer's no-match result instead of substituting research-selected records.
        // Raw fallback remains limited to research-read evidence; merely sending
        // a search passage to a failed writer does not make it a useful answer.
        const fallback = notFound.length > 0 ? [] : (answer === null ? evidence.filter(entry => entry.full) : cited.filter(entry => textGiven.has(entry.short))).slice(0, 3);
        const records = fallback.map(entry => statementOf(entry.item.text!, [entry.short]));
        draft = records.length > 0
          ? { status: "records_only", statements: [], records, gap: RECORDS_GAP }
          : { status: "not_found", statements: [], gap: withGaps(gapText ?? (dateCoverageMissing ? MISSING_DATE_GAP : incomplete ? INCOMPLETE_SEARCH_GAP : NOT_FOUND_GAP))! };
      }
      const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
      // A completed answer can retain source coverage as a notice. A stop
      // becomes a notice only when the rendered answer has no existing gap.
      const responseNotices = [
        ...bundle.coverage.notices,
        ...(coverageLimited ? [LIMITED_COVERAGE_GAP] : []),
        ...(researchIncomplete && anyEvidence && draft.gap === undefined ? [INCOMPLETE_SEARCH_NOTICE] : []),
      ];
      const outcome = !anyEvidence ? (incomplete ? "partial" as const : "not_found" as const) : draft.status === "answered" ? "answered" as const : "partial" as const;
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
