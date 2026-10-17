import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ASK_PROGRESS_COUNT_MAX_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V1,
  PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1,
  PERSON_ASK_RECEIPT_ROWS_MAX_V1,
  validatePersonAnswerCitationV6,
  validatePersonAskProgressStepEventV1,
  validatePersonAskReceiptV1,
  type PersonAskProgressItemV1,
  type PersonAskProgressSourceV1,
  type PersonAskProgressStageV1,
  type PersonAskProgressStepEventV1,
  type PersonAskReceiptRowV1,
  type PersonAskReceiptV1,
} from "@echo-brain/organization-api";
import type { EvidenceDeskItemV2 } from "../shared/evidence-desk-v2.js";
import type { AgenticAskProgressSinkV1 } from "./agentic-ask-progress-v1.js";
import { citationOfAgenticEvidenceItemV1 } from "./agentic-evidence-bundle-v1.js";

/**
 * Ask progress (ADR-0039): one streamed run's record of what it searched and
 * read, the events it sends while it works, and the receipt and audit
 * commitments built from that record. Every event comes from what the run
 * ran; nothing here reads a prompt, a plan, a note or a query.
 */

/** What research reports while it runs. The loop calls these; a run without progress passes none. */
export interface AgenticResearchProgressReporterV1 {
  /** A batch of reads starts: the small-scope preload, or one research step's reads. */
  reads(searching: boolean): void;
  /**
   * One read's released items. `source_id` is the catalog source a search or
   * list chose; undefined means it read every catalog source.
   */
  returned(tool: "search" | "open" | "list", source_id: string | undefined, items: readonly EvidenceDeskItemV2[]): void;
  /** The batch's results are applied: a batch that searched or listed becomes one `searched` row. */
  reads_done(): void;
  /** A research call is about to be given these items' complete text, perhaps none. Its access check has not run yet. */
  before_check(items: readonly EvidenceDeskItemV2[]): void;
  /** The gate's `before_call`: the access check before that call passed, and the model is given these items in full. */
  given(items: readonly EvidenceDeskItemV2[]): void;
}

export interface AgenticAskProgressRecorderV1 {
  readonly research: AgenticResearchProgressReporterV1;
  /** The runner's own stages: the answer writer, then the final check and audit. */
  stage(stage: "writing" | "checking_access"): void;
  /** `canonicalSha256` of each named item's citation, in naming order: the request audit's commitments. */
  named_citation_digests(): readonly Sha256Digest[];
  /** Built only after the release step passed, from this record. */
  receipt(elapsed_ms: number): PersonAskReceiptV1;
  /** The run settled: nothing is sent after this. */
  settle(): void;
}

/** One catalog source as research knows it: its server id, the desk kinds behind it and a live source's tool id. */
export interface AgenticAskProgressCatalogSourceV1 {
  readonly source_id: string;
  readonly kinds: readonly string[];
  readonly tool_id?: string;
}

const TOOL_ID = /^[a-z][a-z0-9-]{0,63}$/u;

/** A catalog source's progress kind; a source with no displayable kind is never named. */
function progressSource(source: AgenticAskProgressCatalogSourceV1): PersonAskProgressSourceV1 | undefined {
  if (source.source_id === "meeting") return Object.freeze({ kind: "meetings" });
  if (source.source_id === "document") return Object.freeze({ kind: "documents" });
  const [kind] = source.kinds;
  if (source.kinds.length !== 1) return undefined;
  if (kind === "slack_message") return Object.freeze({ kind: "slack" });
  if (kind !== "ticket" && kind !== "page") return undefined;
  const toolId = [source.tool_id, source.source_id].find(value => typeof value === "string" && TOOL_ID.test(value));
  return toolId === undefined ? undefined : Object.freeze({ kind: kind === "ticket" ? "tickets" : "pages", tool_id: toolId });
}

function bounded(value: number): number { return Math.min(PERSON_ASK_PROGRESS_COUNT_MAX_V1, Math.max(0, value)); }

/** Identity of one released item across reads: its citation's canonical bytes, as the receipt's validator compares them. */
function itemKey(item: EvidenceDeskItemV2): string { return canonicalJson(item.citation); }

/** Merges neighbouring rows of one type: sources united, found summed, items concatenated. */
function merged(rows: readonly PersonAskReceiptRowV1[]): PersonAskReceiptRowV1[] {
  const out: PersonAskReceiptRowV1[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last === undefined || last.type !== row.type) { out.push(row); continue; }
    if (last.type === "searched" && row.type === "searched") {
      const sources = new Map(last.sources.map(source => [canonicalJson(source), source]));
      for (const source of row.sources) if (sources.size < PERSON_ASK_PROGRESS_SOURCES_MAX_V1) sources.set(canonicalJson(source), source);
      out[out.length - 1] = { type: "searched", sources: [...sources.values()], found: bounded(last.found + row.found) };
    } else if (last.type === "read" && row.type === "read") out[out.length - 1] = { type: "read", items: [...last.items, ...row.items] };
  }
  return out;
}

/**
 * The recorder of one streamed run. `signal` is the run's active signal: once
 * the caller cancels or the deadline passes, nothing more is sent, and after
 * `settle` nothing at all. A sink's exception is ignored.
 */
export function createAgenticAskProgressRecorderV1(options: {
  readonly sink: AgenticAskProgressSinkV1;
  /** The request's catalog, in catalog order. */
  readonly sources: readonly AgenticAskProgressCatalogSourceV1[];
  readonly signal: AbortSignal;
}): AgenticAskProgressRecorderV1 {
  const { sink, signal } = options;
  const sourcesById = new Map(options.sources.map(source => [source.source_id, progressSource(source)]));
  const everySource = options.sources.map(source => sourcesById.get(source.source_id)).filter((value): value is PersonAskProgressSourceV1 => value !== undefined);
  let settled = false;
  let lastStage: string | undefined;
  /** Items any read returned to this person: a later read counts only what none returned before. */
  const returnedKeys = new Set<string>();
  /** Items research read in full (looked through), and the ones it named. */
  const readKeys = new Set<string>();
  const named: PersonAskProgressItemV1[] = [];
  const namedKeys = new Set<string>();
  /** The searched and read rows sent, in order: the receipt's source. */
  const rows: PersonAskReceiptRowV1[] = [];
  let batch: { readonly sources: Map<string, PersonAskProgressSourceV1>; found: number } | undefined;

  const live = () => !settled && !signal.aborted;
  /** Validates and sends one event, returning what was sent; an invalid event is dropped, never sent. */
  const send = (event: PersonAskProgressStepEventV1): PersonAskProgressStepEventV1 | undefined => {
    if (!live()) return undefined;
    let valid: PersonAskProgressStepEventV1;
    try { valid = validatePersonAskProgressStepEventV1(event); } catch { return undefined; }
    try { sink(valid); } catch { /* A sink can never change research. */ }
    return valid;
  };
  const stage = (value: PersonAskProgressStageV1, pending?: number) => {
    const counted = pending === undefined || pending < 1 ? undefined : bounded(pending);
    const key = `${value}:${counted ?? ""}`;
    if (!live() || key === lastStage) return;
    lastStage = key;
    send({ type: "stage", stage: value, ...(counted === undefined ? {} : { pending: counted }) });
  };

  const research: AgenticResearchProgressReporterV1 = Object.freeze({
    reads(searching: boolean) {
      batch = { sources: new Map(), found: 0 };
      stage(searching ? "searching" : "reading");
    },
    returned(tool: "search" | "open" | "list", sourceId: string | undefined, items: readonly EvidenceDeskItemV2[]) {
      let fresh = 0;
      for (const item of items) {
        const key = itemKey(item);
        if (returnedKeys.has(key)) continue;
        returnedKeys.add(key); fresh += 1;
      }
      if (tool === "open" || batch === undefined) return;
      const covered = sourceId === undefined ? everySource : [sourcesById.get(sourceId)].filter((value): value is PersonAskProgressSourceV1 => value !== undefined);
      for (const source of covered) if (batch.sources.size < PERSON_ASK_PROGRESS_SOURCES_MAX_V1) batch.sources.set(canonicalJson(source), source);
      batch.found = bounded(batch.found + fresh);
    },
    reads_done() {
      const done = batch;
      batch = undefined;
      if (done === undefined || done.sources.size === 0) return;
      const sent = send({ type: "searched", sources: [...done.sources.values()], found: done.found });
      if (sent !== undefined && sent.type === "searched") rows.push(sent);
    },
    before_check(items: readonly EvidenceDeskItemV2[]) {
      // A call given nothing in full (the first step's plan) reads nothing: no stage, so it is never said.
      if (items.length === 0) return;
      const fresh = new Set(items.map(itemKey).filter(key => !readKeys.has(key)));
      stage("reading", fresh.size);
    },
    given(items: readonly EvidenceDeskItemV2[]) {
      // Synchronous from here: a cancel or deadline cannot fall between the check and these names.
      if (!live()) return;
      const fresh: { readonly key: string; readonly item: PersonAskProgressItemV1 }[] = [];
      for (const item of items) {
        const key = itemKey(item);
        if (readKeys.has(key)) continue;
        readKeys.add(key);
        if (namedKeys.size + fresh.length >= PERSON_ASK_PROGRESS_NAMED_MAX_V1) continue;
        // The answer citation's projection: kind, label, visibility and the open ref. One that fails it is read, never named.
        try { fresh.push({ key, item: validatePersonAnswerCitationV6(citationOfAgenticEvidenceItemV1(item)) }); } catch { continue; }
      }
      for (let start = 0; start < fresh.length; start += PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1) {
        const chunk = fresh.slice(start, start + PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1);
        const sent = send({ type: "read", items: chunk.map(value => value.item) });
        if (sent === undefined || sent.type !== "read") continue;
        for (const value of chunk) { namedKeys.add(value.key); named.push(value.item); }
        rows.push(sent);
      }
    },
  });

  return Object.freeze({
    research,
    stage: (value: "writing" | "checking_access") => stage(value),
    named_citation_digests: () => Object.freeze(named.map(item => canonicalSha256(item.citation))),
    receipt(elapsedMs: number): PersonAskReceiptV1 {
      const elapsed = Math.min(PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1, Math.max(0, Math.round(elapsedMs)));
      const lookedThrough = bounded(readKeys.size);
      // Fit the byte bound by dropping named items from the end; looked_through stays.
      for (let keep = named.length; ; keep -= 1) {
        let left = keep;
        const kept = rows.flatMap((row): PersonAskReceiptRowV1[] => {
          if (row.type === "searched") return [row];
          const items = row.items.slice(0, Math.max(0, left));
          left -= items.length;
          return items.length === 0 ? [] : [{ type: "read", items }];
        });
        try {
          return validatePersonAskReceiptV1({ looked_through: lookedThrough, elapsed_ms: elapsed, rows: merged(kept).slice(0, PERSON_ASK_RECEIPT_ROWS_MAX_V1) });
        } catch (error) {
          if (keep === 0) throw error;
        }
      }
    },
    settle() { settled = true; batch = undefined; },
  });
}
