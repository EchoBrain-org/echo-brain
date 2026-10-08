import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type {
  PersonAnswerPartV4,
  PersonAnswerResponseV4,
  PersonAnswerResponseV5,
  PersonAnswerResponseV6,
} from "@echo-brain/organization-api";
import { answerSchema, cleanId, cleanLine, parseAnswer, partQuestion } from "../agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "../agentic-ask-v1-response.js";
import { citationOfAgenticEvidenceItemV1, describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../agentic-evidence-bundle-v1.js";
import type { AgenticModelCallV1 } from "../agentic-model-gate-v1.js";
import { callRendererModelV1, type AgenticRendererV1, type AgenticRenderInputV1 } from "../agentic-renderer-v1.js";

/**
 * Ask's renderer: one writer call reads the question against released
 * evidence from the bundle, then code lays out one cited paragraph. With no
 * usable writer reply it falls back to the records research read, or says
 * what it could not find.
 */

const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
const RECORDS_GAP = "I found these records, but could not write a verified summary.";
const INCOMPLETE_SEARCH_GAP = "I couldn't complete the search. Please try again.";
const LIMITED_COVERAGE_GAP = "Some source coverage was incomplete, so relevant context may be missing.";
/** The writer runs in Ask's answer span; the audit records it as an `answer` call. */
const WRITER_CALL: AgenticModelCallV1 = Object.freeze({ role: "answer", span: "ask_answer" });

type Entry = AgenticEvidenceBundleItemV1;
type AskResponse = PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6;

export interface AskRendererInputV1 {
  readonly question: string;
}
export interface AskRenderedV1 {
  readonly response: AskResponse;
  /** Short ids the writer was given, in order; empty when no writer call ran. */
  readonly writer_evidence: readonly string[];
}

export interface CreateAskRendererV1Options {
  /** 4 (V1 core), 5 (V2) or 6 (V3 and the research core). */
  readonly response_version: 4 | 5 | 6;
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

      // ---- final answer ---------------------------------------------------
      const answerContext = {
        question: askedQuestion, ...options.context, scope: options.scope, source_catalog: options.source_catalog,
        research: {
          completed: !researchIncomplete, stop_reason: bundle.stop.reason, reads: bundle.coverage.reads,
          // Filters and planner need text are intentionally excluded. This describes
          // inventories actually read, not whether an arbitrary fact exists.
          inventories: bundle.coverage.inventories,
          notices: [...bundle.coverage.notices], omitted_evidence_items: bundle.items.filter(entry => entry.item.text !== undefined).length,
        },
      };
      const writerBudget = Math.max(0, input.prompt_budget(options.answer_prompt) - bytes(JSON.stringify({ ...answerContext, evidence: [] })));
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
      const allowed = new Set(evidence.map(entry => entry.short));
      input.on_context?.(Object.freeze(evidence.map(entry => entry.short)));

      const written = evidence.length === 0 ? null : await callRendererModelV1(input, WRITER_CALL, options.answer_prompt, {
        ...answerContext,
        // Working hypotheses are not user requirements or evidence. The
        // writer assesses the original question against released text.
        evidence: evidence.map(entry => ({ ...describe(entry), text: entry.item.text })),
      }, answerSchema, parseAnswer);
      const answer = written?.value ?? null;
      const writerEvidence: readonly string[] = written === null ? [] : Object.freeze(evidence.map(entry => entry.short));

      // ---- layout (code, not model): one part, read as one paragraph ------
      const used: Entry[] = [];
      const use = (shorts: readonly string[]): number[] => {
        const indexes: number[] = [];
        for (const short of shorts) {
          if (!allowed.has(short)) continue;
          const entry = entryOf(short)!;
          if (!used.includes(entry)) used.push(entry);
          const index = used.indexOf(entry);
          if (!indexes.includes(index)) indexes.push(index);
        }
        return indexes;
      };
      const isPrivate = (shorts: readonly string[]) => shorts.some(short => allowed.has(short) && privateItem(entryOf(short)!.item));
      const question = partQuestion(askedQuestion);
      const statements = (answer?.sentences ?? [])
        .map(sentence => ({ sentence, shorts: sentence.evidence.filter(short => allowed.has(short)) }))
        .filter(value => value.shorts.length > 0)
        .map(value => ({ text: value.sentence.text, citation_indexes: use(value.shorts), private: isPrivate(value.shorts) }));
      const notFound = answer?.not_found ?? [];
      const coverageLimited = coverageIsLimitedFor(bundle, used);
      const responseNotices = [...bundle.coverage.notices, ...(coverageLimited ? [LIMITED_COVERAGE_GAP] : [])];
      const incomplete = researchIncomplete || (answer === null && evidence.length > 0);
      const gapText = incomplete && (statements.length === 0 || notFound.length > 0 || researchIncomplete)
        ? cleanLine(`${INCOMPLETE_SEARCH_GAP}${notFound.length === 0 ? "" : ` Missing context: ${notFound.join("; ")}.`}`, 600)
        : notFound.length === 0 ? undefined : cleanLine(`Not found: ${notFound.join("; ")}.`, 600);
      type Draft = { status: PersonAnswerPartV4["status"]; statements: typeof statements; gap?: string; records?: { text: string; citation_indexes: number[]; private: boolean }[] };
      let draft: Draft;
      if (statements.length > 0) {
        draft = gapText === undefined ? { status: "answered", statements } : { status: "partial", statements, gap: gapText };
      } else {
        // Honor a completed writer's no-match result instead of substituting research-selected records.
        // Raw fallback remains limited to research-read evidence; merely sending
        // a search passage to a failed writer does not make it a useful answer.
        const fallback = notFound.length > 0 ? [] : (answer === null ? evidence.filter(entry => entry.full) : cited.filter(entry => allowed.has(entry.short))).slice(0, 3);
        const records = fallback.map(entry => ({ text: entry.item.text!, citation_indexes: use([entry.short]), private: privateItem(entry.item) }));
        draft = records.length > 0
          ? { status: "records_only", statements: [], records, gap: RECORDS_GAP }
          : { status: "not_found", statements: [], gap: gapText ?? (incomplete ? INCOMPLETE_SEARCH_GAP : NOT_FOUND_GAP) };
      }
      const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
      const outcome = !anyEvidence ? (incomplete ? "partial" as const : "not_found" as const) : draft.status === "answered" ? "answered" as const : "partial" as const;
      const result = Object.freeze({
        schema_version: responseVersion, kind: responseVersion === 6 ? "echo-clean-person-answer-v6" : tickets ? "echo-clean-person-answer-v5" : "echo-clean-person-answer-v4", scope: options.desk_scope, outcome,
        parts: Object.freeze([Object.freeze({
          question, status: draft.status,
          statements: Object.freeze(draft.statements.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))),
          ...(draft.gap === undefined ? {} : { gap: draft.gap }),
          ...(draft.records === undefined ? {} : { records: Object.freeze(draft.records.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))) }),
        })]),
        citations: Object.freeze(anyEvidence ? used.map(entry => citationOfAgenticEvidenceItemV1(entry.item)) : []),
        ...(responseNotices.length === 0 ? {} : { notice: responseNotices.join(" ") }),
      });
      const validated: AskResponse = responseVersion === 6 ? compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV6) : tickets ? compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV5) : compactAndValidateAgenticAskResponseV1(result as PersonAnswerResponseV4);
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
