import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ASK_PROGRESS_COUNT_MAX_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V3,
  PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1,
  PERSON_ASK_RECEIPT_ROWS_MAX_V1,
  validatePersonAnswerCitationV6,
  validatePersonAnswerCitationV7,
  validatePersonAnswerCitationV8,
  validatePersonAskProgressStepEventV1,
  validatePersonAskProgressStepEventV2,
  validatePersonAskProgressStepEventV3,
  validatePersonAskReceiptV1,
  validatePersonAskReceiptV2,
  validatePersonAskReceiptV3,
  type PersonAskProgressItemV3,
  type PersonAskProgressSourceV3,
  type PersonAskProgressStageV1,
  type PersonAskProgressStepEventV3,
  type PersonAskReceiptRowV3,
  type PersonAskReceiptV3,
} from "@echo-brain/organization-api";
import type { EvidenceDeskItemV2 } from "../shared/evidence-desk-v2.js";
import type { AgenticAskProgressRequestV1, AgenticAskProgressSinkV1, AgenticAskProgressSinkV2, AgenticAskProgressSinkV3 } from "./agentic-ask-progress-v1.js";
import { FOLLOW_UP_EVIDENCE_KIND_V1 } from "../shared/follow-up-evidence-v1.js";
import { WORKSPACE_SOURCE_IDS_V1, type WorkspaceSourceIdV1 } from "../shared/workspace-evidence-v1.js";
import { citationOfAgenticEvidenceItemV1, citationOfAgenticEvidenceItemV8 } from "./agentic-evidence-bundle-v1.js";

/**
 * Ask progress (ADR-0039): one streamed run's record of what it searched and
 * read, the events it sends while it works, and the receipt and audit
 * commitments built from that record. Every event comes from what the run
 * ran; nothing here reads a prompt, a plan, a note or a query.
 *
 * A run streams the progress version its answer has: V1 for the V6 answer
 * on `/v5`, V2 for the V7 answer on `/v6`, which alone may name follow-ups
 * (ADR-0040). Each event is validated as its version before it is sent.
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
  /** `canonicalSha256` of each item this run named, in naming order: its audit record's commitments. */
  named_citation_digests(): readonly Sha256Digest[];
  /** Built only after the release step passed, from this run's record; a V1 run's is a V1 receipt. */
  receipt(elapsed_ms: number): PersonAskReceiptV3;
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

/** The progress version a run streams, by its answer's version. */
export type AgenticAskProgressVersionV1 = 1 | 2 | 3;

/** Each version's validators; V3 (the V8 answer, research tool contract v1) names workspace items and tool containers. */
const VERSIONS = {
  1: { item: validatePersonAnswerCitationV6, step: validatePersonAskProgressStepEventV1, receipt: validatePersonAskReceiptV1 },
  2: { item: validatePersonAnswerCitationV7, step: validatePersonAskProgressStepEventV2, receipt: validatePersonAskReceiptV2 },
  3: { item: validatePersonAnswerCitationV8, step: validatePersonAskProgressStepEventV3, receipt: validatePersonAskReceiptV3 },
} as const satisfies Record<AgenticAskProgressVersionV1, {
  readonly item: (value: unknown) => PersonAskProgressItemV3;
  readonly step: (value: unknown) => PersonAskProgressStepEventV3;
  readonly receipt: (value: unknown) => PersonAskReceiptV3;
}>;

/**
 * A catalog source's progress kind; a source with no displayable kind is never named. Follow-ups are named from V2, and
 * the workspace sources and a tool's containers from V3.
 */
function progressSource(source: AgenticAskProgressCatalogSourceV1, version: AgenticAskProgressVersionV1): PersonAskProgressSourceV3 | undefined {
  if (source.source_id === "meeting") return Object.freeze({ kind: "meetings" });
  if (source.source_id === "document") return Object.freeze({ kind: "documents" });
  if ((WORKSPACE_SOURCE_IDS_V1 as readonly string[]).includes(source.source_id)) return version === 3 ? Object.freeze({ kind: source.source_id as WorkspaceSourceIdV1 }) : undefined;
  const [kind] = source.kinds;
  if (source.kinds.length !== 1) return undefined;
  if (kind === "slack_message") return Object.freeze({ kind: "slack" });
  if (kind === FOLLOW_UP_EVIDENCE_KIND_V1) return version >= 2 ? Object.freeze({ kind: "follow_ups" }) : undefined;
  if (kind === "tool_container") {
    const containerTool = [source.tool_id, source.source_id].find(value => typeof value === "string" && TOOL_ID.test(value));
    return version === 3 && containerTool !== undefined ? Object.freeze({ kind: "containers", tool_id: containerTool }) : undefined;
  }
  if (kind !== "ticket" && kind !== "page") return undefined;
  const toolId = [source.tool_id, source.source_id].find(value => typeof value === "string" && TOOL_ID.test(value));
  return toolId === undefined ? undefined : Object.freeze({ kind: kind === "ticket" ? "tickets" : "pages", tool_id: toolId });
}

function bounded(value: number): number { return Math.min(PERSON_ASK_PROGRESS_COUNT_MAX_V1, Math.max(0, value)); }

/** A streamed request, started now: each attempt of it is given the same one. */
export function createAgenticAskProgressRequestV1(now: () => number = () => performance.now()): AgenticAskProgressRequestV1 {
  const startedAt = now();
  return Object.freeze({ named: new Set<string>(), elapsed: () => now() - startedAt });
}

/** Identity of one released item across reads: its citation's canonical bytes, as the receipt's validator compares them. */
function itemKey(item: EvidenceDeskItemV2): string { return canonicalJson(item.citation); }

/** Merges neighbouring rows of one type: sources united (at most `sourcesMax`), found summed, items concatenated. */
function merged(rows: readonly PersonAskReceiptRowV3[], sourcesMax: number = PERSON_ASK_PROGRESS_SOURCES_MAX_V1): PersonAskReceiptRowV3[] {
  const out: PersonAskReceiptRowV3[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last === undefined || last.type !== row.type) { out.push(row); continue; }
    if (last.type === "searched" && row.type === "searched") {
      const sources = new Map(last.sources.map(source => [canonicalJson(source), source]));
      for (const source of row.sources) if (sources.size < sourcesMax) sources.set(canonicalJson(source), source);
      out[out.length - 1] = { type: "searched", sources: [...sources.values()], found: bounded(last.found + row.found) };
    } else if (last.type === "read" && row.type === "read") out[out.length - 1] = { type: "read", items: [...last.items, ...row.items] };
  }
  return out;
}

interface AgenticAskProgressRecorderOptionsV1 {
  /** The request's catalog, in catalog order. */
  readonly sources: readonly AgenticAskProgressCatalogSourceV1[];
  readonly signal: AbortSignal;
  /**
   * What earlier attempts of this request named (`AgenticAskProgressRequestV1.named`):
   * none of it is named again, and it counts toward the named bound. Shared, so each item
   * this run names is added to it.
   */
  readonly named?: Set<string>;
}

/**
 * The recorder of one streamed run. `signal` is the run's active signal: once
 * the caller cancels or the deadline passes, nothing more is sent, and after
 * `settle` nothing at all. A sink's exception is ignored. `version` is the
 * progress version the run streams, V1 when omitted; its sink receives only
 * events valid in that version.
 */
export function createAgenticAskProgressRecorderV1(options: AgenticAskProgressRecorderOptionsV1 & { readonly sink: AgenticAskProgressSinkV1; readonly version?: 1 }): AgenticAskProgressRecorderV1;
export function createAgenticAskProgressRecorderV1(options: AgenticAskProgressRecorderOptionsV1 & { readonly sink: AgenticAskProgressSinkV2; readonly version: 1 | 2 }): AgenticAskProgressRecorderV1;
export function createAgenticAskProgressRecorderV1(options: AgenticAskProgressRecorderOptionsV1 & { readonly sink: AgenticAskProgressSinkV3; readonly version: AgenticAskProgressVersionV1 }): AgenticAskProgressRecorderV1;
export function createAgenticAskProgressRecorderV1(options: AgenticAskProgressRecorderOptionsV1 & { readonly sink: AgenticAskProgressSinkV1 | AgenticAskProgressSinkV2 | AgenticAskProgressSinkV3; readonly version?: AgenticAskProgressVersionV1 }): AgenticAskProgressRecorderV1 {
  const { signal } = options;
  // A V1 run validates every event as V1 before it is sent, so a V1 sink only ever receives V1 events.
  const sink = options.sink as AgenticAskProgressSinkV3;
  const version = options.version ?? 1;
  const validate = VERSIONS[version];
  const sourcesMax = version === 3 ? PERSON_ASK_PROGRESS_SOURCES_MAX_V3 : PERSON_ASK_PROGRESS_SOURCES_MAX_V1;
  /** An item as this version's answer cites it: the V8 citation names workspace items and tool containers. */
  const citationOf = version === 3 ? citationOfAgenticEvidenceItemV8 : citationOfAgenticEvidenceItemV1;
  const sourcesById = new Map(options.sources.map(source => [source.source_id, progressSource(source, version)]));
  const everySource = options.sources.map(source => sourcesById.get(source.source_id)).filter((value): value is PersonAskProgressSourceV3 => value !== undefined);
  let settled = false;
  let lastStage: string | undefined;
  /** Items a search or list returned to this person: a later one counts only what none returned before. */
  const returnedKeys = new Set<string>();
  /** Items research read in full (looked through), and the ones it named. */
  const readKeys = new Set<string>();
  const named: PersonAskProgressItemV3[] = [];
  /** Every item the request named, an earlier attempt's included: each is named once, and the bound counts them all. */
  const namedKeys = options.named ?? new Set<string>();
  /** The searched and read rows sent, in order: the receipt's source. */
  const rows: PersonAskReceiptRowV3[] = [];
  let batch: { readonly sources: Map<string, PersonAskProgressSourceV3>; found: number } | undefined;

  const live = () => !settled && !signal.aborted;
  /** Validates and sends one event, returning what was sent; an invalid event is dropped, never sent. */
  const send = (event: PersonAskProgressStepEventV3): PersonAskProgressStepEventV3 | undefined => {
    if (!live()) return undefined;
    let valid: PersonAskProgressStepEventV3;
    try { valid = validate.step(event); } catch { return undefined; }
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
      // Found is what searches and lists returned: neighbours an open brought along count once a search or list returns them.
      if (tool === "open") return;
      let fresh = 0;
      for (const item of items) {
        const key = itemKey(item);
        if (returnedKeys.has(key)) continue;
        returnedKeys.add(key); fresh += 1;
      }
      if (batch === undefined) return;
      const covered = sourceId === undefined ? everySource : [sourcesById.get(sourceId)].filter((value): value is PersonAskProgressSourceV3 => value !== undefined);
      for (const source of covered) if (batch.sources.size < sourcesMax) batch.sources.set(canonicalJson(source), source);
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
      // Counts only items whose names can follow: an earlier attempt's names are not sent again.
      const fresh = new Set(items.map(itemKey).filter(key => !readKeys.has(key) && !namedKeys.has(key)));
      stage("reading", fresh.size);
    },
    given(items: readonly EvidenceDeskItemV2[]) {
      // Synchronous from here: a cancel or deadline cannot fall between the check and these names.
      if (!live()) return;
      const fresh: { readonly key: string; readonly item: PersonAskProgressItemV3 }[] = [];
      for (const item of items) {
        const key = itemKey(item);
        if (readKeys.has(key)) continue;
        readKeys.add(key);
        // Read in this run either way; an earlier attempt's name is never sent twice.
        if (namedKeys.has(key) || namedKeys.size + fresh.length >= PERSON_ASK_PROGRESS_NAMED_MAX_V1) continue;
        // The answer citation's projection, in this run's version: kind, label, visibility and the open ref. One that fails it is read, never named.
        try { fresh.push({ key, item: validate.item(citationOf(item)) }); } catch { continue; }
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
    receipt(elapsedMs: number): PersonAskReceiptV3 {
      const elapsed = Math.min(PERSON_ASK_RECEIPT_ELAPSED_MAX_MS_V1, Math.max(0, Math.round(elapsedMs)));
      const lookedThrough = bounded(readKeys.size);
      // Fit the byte bound by dropping named items from the end; looked_through stays.
      for (let keep = named.length; ; keep -= 1) {
        let left = keep;
        const kept = rows.flatMap((row): PersonAskReceiptRowV3[] => {
          if (row.type === "searched") return [row];
          const items = row.items.slice(0, Math.max(0, left));
          left -= items.length;
          return items.length === 0 ? [] : [{ type: "read", items }];
        });
        try {
          return validate.receipt({ looked_through: lookedThrough, elapsed_ms: elapsed, rows: merged(kept, sourcesMax).slice(0, PERSON_ASK_RECEIPT_ROWS_MAX_V1) });
        } catch (error) {
          if (keep === 0) throw error;
        }
      }
    },
    settle() { settled = true; batch = undefined; },
  });
}
