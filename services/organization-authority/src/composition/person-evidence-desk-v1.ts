import { createHash } from "node:crypto";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { annotateCoreRuntimeV1, observeCoreRuntimeV1, type CoreRuntimeCountsV1, type CoreRuntimePhaseV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import {
  evidenceDeskSourceV1,
  type EvidenceDeskCitationV1,
  type EvidenceDeskItemV1,
  type EvidenceDeskKindV1,
  type EvidenceDeskPortV1,
  type EvidenceDeskResultV1,
  type EvidenceDeskSearchInputV1,
  type EvidenceDeskListInputV1,
  type EvidenceDeskOpenInputV1,
  type EvidenceDeskScopeV1,
} from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import { PERSON_EVIDENCE_TEXT_MAX_BYTES_V1 } from "@echo-brain/organization-api";
import type { PersonSlackMessageV1, PersonSlackReaderV1, PersonSlackReleaseAuditV1, PersonSlackReleaseV1 } from "../application/ports/person-slack-reader-v1.js";
import type { PersonAnswerCitationV3 } from "@echo-brain/organization-api";
import type {
  OriginalContextDeskReleaseV1,
  PersonAskScopeV2,
  PersonOriginalContextEvidenceDeskPortV1,
} from "../application/ports/person-original-context-retrieval-v1.js";
import type {
  PersonEvidenceDeskRecordsV1,
  PersonRecordSearchBatchReleaseV1,
  PersonRecordSearchReleasePointerV1,
} from "./person-record-search-route.js";
import { PersonRecordSearchIndexLagV1 } from "./person-record-search-route.js";

/** The V3 route creates one desk per request; actor, bearer and scope never
 * enter the model-facing methods. */
export interface CreatePersonEvidenceDeskV1Options {
  readonly access_token: string;
  readonly scope: PersonAskScopeV2;
  readonly originals: PersonOriginalContextEvidenceDeskPortV1;
  readonly records: PersonEvidenceDeskRecordsV1;
  /** The asker's own live Slack reads and their release audit (RFC-0003). Absent when Slack is not connected. */
  readonly slack?: { readonly reader: PersonSlackReaderV1; readonly audit: PersonSlackReleaseAuditV1 };
  /** Milliseconds clock for the Slack connection-check cache; tests pin it. */
  readonly now_ms?: () => number;
}

/**
 * Observability only: what one desk call returned, by source. A shared
 * transcript counts as a document item; the originals adapter adds
 * transcript_items for that subset. Never text, ids or labels.
 */
function deskCounts(items: readonly EvidenceDeskItemV1[]): CoreRuntimeCountsV1 {
  let meeting = 0; let document = 0; let slack = 0;
  for (const item of items) {
    const source = evidenceDeskSourceV1(item);
    if (source === "meeting") meeting += 1; else if (source === "slack") slack += 1; else document += 1;
  }
  return { included_count: items.length, meeting_items: meeting, document_items: document, slack_items: slack };
}

/** Each desk call is one span under the current request, Ask step or evidence door. */
function observedDeskCall<T extends EvidenceDeskResultV1>(phase: CoreRuntimePhaseV1, operation: () => Promise<T>): Promise<T> {
  return observeCoreRuntimeV1(phase, async () => {
    const result = await operation();
    annotateCoreRuntimeV1({ counts: deskCounts(result.items) });
    return result;
  });
}

/** A Slack connection check stays valid this long (RFC-0003). */
export const PERSON_EVIDENCE_DESK_SLACK_CHECK_MS_V1 = 30_000;
const SLACK_PER_THREAD = 3;
const SLACK_THREAD_REPLIES = 20;

type Stored = Readonly<{
  item: EvidenceDeskItemV1;
  slack?: PersonSlackMessageV1;
  original?: OriginalContextDeskReleaseV1;
  record?: PersonRecordSearchBatchReleaseV1;
  record_anchor?: { readonly atom_id: Sha256Digest; readonly record_sha256: Sha256Digest; readonly record_position: number; readonly envelope_sha256: Sha256Digest; readonly atom_order: number; readonly audience_project_count: number; readonly item_kind: "decision" | "action" | "rationale"; readonly text: string; readonly policy_id: "restricted-reviewer-person-v2" | "organization-member-readable-person-v2" | "project-members-readable-person-v1" };
}>;

/** A compile error when a scope kind is added; a closed failure at run time. */
function unknownScope(scope: never): never {
  throw new AuthorityOperationError("invalid_request", `scope ${String((scope as { readonly kind?: unknown }).kind)} is invalid`);
}

function publicScope(scope: PersonAskScopeV2): EvidenceDeskScopeV1 {
  switch (scope.kind) {
    case "global": return Object.freeze({ kind: "global" });
    case "project": return Object.freeze({ kind: "project", project_id: scope.project_id }) as EvidenceDeskScopeV1;
    case "mine": return Object.freeze({ kind: "mine" });
    default: return unknownScope(scope);
  }
}

/** The records half of a scope. Every records call spreads this, so no scope can fall through to global. */
function recordScope(scope: PersonAskScopeV2): Readonly<{ project_id?: never }> | Readonly<{ project_id: string }> | Readonly<{ mine: true }> {
  switch (scope.kind) {
    case "global": return {};
    case "project": return { project_id: scope.project_id };
    // The records route narrows to meetings the caller finally approved.
    case "mine": return { mine: true as const };
    default: return unknownScope(scope);
  }
}

function sourceCitation(item: OriginalContextDeskReleaseV1["items"][number]): EvidenceDeskCitationV1 {
  return Object.freeze({ ...item.citation, ...(item.label === undefined ? {} : { label: item.label }) }) as EvidenceDeskCitationV1;
}

function recordCitation(item: { readonly atom_id: Sha256Digest; readonly record_sha256: Sha256Digest; readonly policy_id: string }): EvidenceDeskCitationV1 {
  if (item.policy_id !== "restricted-reviewer-person-v2" && item.policy_id !== "organization-member-readable-person-v2" && item.policy_id !== "project-members-readable-person-v1") throw new AuthorityOperationError("unavailable", "record evidence is unavailable");
  return Object.freeze({ kind: "approved_record", atom_id: item.atom_id, record_sha256: item.record_sha256, policy_id: item.policy_id });
}

function itemId(citation: EvidenceDeskCitationV1): string {
  return `desk_${canonicalSha256(citation).slice(7)}`;
}

function textSha256(text: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` as Sha256Digest;
}

/** Desk text is bounded like every released passage; a longer Slack message is cut at a character boundary. */
function boundedText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PERSON_EVIDENCE_TEXT_MAX_BYTES_V1) return text;
  let result = "";
  for (const character of text) {
    if (Buffer.byteLength(result + character, "utf8") > PERSON_EVIDENCE_TEXT_MAX_BYTES_V1 - 3) break;
    result += character;
  }
  return `${result}…`;
}

function slackDay(ts: string): string {
  return new Date(Math.floor(Number(ts) * 1000)).toISOString().slice(0, 10);
}

function slackLabel(message: PersonSlackMessageV1): string {
  const day = slackDay(message.message_ts);
  const reply = message.thread_ts !== undefined && message.thread_ts !== message.message_ts ? " (reply)" : "";
  const where = message.channel_kind === "im" ? `DM with ${message.channel_name}` : message.channel_kind === "mpim" ? `Group DM ${message.channel_name}` : `#${message.channel_name}`;
  return `${where} · ${message.author} · ${day}${reply}`.slice(0, 900);
}

function slackCitation(message: PersonSlackMessageV1, text: string): EvidenceDeskCitationV1 {
  return Object.freeze({
    kind: "slack_message", team_id: message.team_id, channel_id: message.channel_id, message_ts: message.message_ts,
    ...(message.thread_ts === undefined ? {} : { thread_ts: message.thread_ts }),
    permalink: message.permalink, text_sha256: textSha256(text),
  }) as EvidenceDeskCitationV1;
}

function interleave<T>(...lists: readonly (readonly T[])[]): readonly T[] {
  const result: T[] = [];
  for (let index = 0; index < Math.max(0, ...lists.map((list) => list.length)); index += 1) {
    for (const list of lists) if (list[index] !== undefined) result.push(list[index]!);
  }
  return result;
}

/** YYYY-MM-DD to a Slack timestamp bound (start or end of that UTC day). */
function slackBound(day: string | undefined, end: boolean): string | undefined {
  if (day === undefined) return undefined;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new AuthorityOperationError("invalid_request", "list dates must be YYYY-MM-DD");
  return `${Math.floor(ms / 1000) + (end ? 86_399 : 0)}.000000`;
}

function unavailableAtStart(error: unknown): boolean {
  return error instanceof PersonRecordSearchIndexLagV1;
}

function balanced<T>(left: readonly T[], right: readonly T[]): readonly T[] {
  const result: T[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== undefined) result.push(left[index]!);
    if (right[index] !== undefined) result.push(right[index]!);
  }
  return result;
}

/**
 * Creates the concrete Layer-3 desk used by the agentic loop.  `open` accepts
 * only a server-issued item id; HTTP/CLI routes that receive a citation should
 * use `openCitation` below to make a fresh scoped desk release.
 */
export function createPersonEvidenceDeskV1(options: CreatePersonEvidenceDeskV1Options): EvidenceDeskPortV1 & {
  openCitation(input: { readonly citation: PersonAnswerCitationV3; readonly neighbours?: number; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV1>;
} {
  const stored = new Map<string, Stored>();
  const originalReleases: OriginalContextDeskReleaseV1[] = [];
  const recordReleases: PersonRecordSearchBatchReleaseV1[] = [];
  let pointer: PersonRecordSearchReleasePointerV1 | undefined;
  let recordsUnavailableAtStart = false;
  let initialized = false;
  let initializationFailure: unknown;
  let initializationReceipts: Sha256Digest[] = [];
  let latestRecordTruncated = false;
  const now = options.now_ms ?? (() => Date.now());
  let slackReleased = false;
  let slackCheckedAt: number | undefined;

  /** Audits a Slack release before its bytes leave the desk, then stores the items for this request only. */
  const slackItems = (operation: PersonSlackReleaseV1["operation"], messages: readonly PersonSlackMessageV1[]): { items: readonly EvidenceDeskItemV1[]; receipt: Sha256Digest } | null => {
    if (options.slack === undefined || messages.length === 0) return null;
    const prepared = messages.map((message) => {
      const text = boundedText(message.text.normalize("NFC"));
      return { message, text, citation: slackCitation(message, text) };
    }).filter((value) => value.text.trim().length > 0);
    if (prepared.length === 0) return null;
    const receipt = options.slack.audit.record(Object.freeze({
      operation,
      messages: Object.freeze(prepared.map((value) => Object.freeze({ team_id: value.message.team_id, channel_id: value.message.channel_id, message_ts: value.message.message_ts, permalink: value.message.permalink, text_sha256: textSha256(value.text) }))),
    }));
    slackReleased = true;
    const items = prepared.map((value) => save(Object.freeze({
      id: itemId(value.citation), citation: value.citation, kind: "slack_message" as EvidenceDeskKindV1, text: value.text,
      label: slackLabel(value.message), visibility: value.message.channel_kind === "public_channel" ? "team" : "only_me",
      occurred_at: slackDay(value.message.message_ts), receipt_sha256: receipt,
    }) as EvidenceDeskItemV1, { slack: value.message }));
    return { items, receipt };
  };
  const slackSearch = async (query: string, signal?: AbortSignal): Promise<{ items: readonly EvidenceDeskItemV1[]; receipts: readonly Sha256Digest[]; notice?: string }> => {
    if (options.slack === undefined) return { items: [], receipts: [] };
    let messages: readonly PersonSlackMessageV1[];
    try { messages = await options.slack.reader.search({ query, limit: 20, ...(signal === undefined ? {} : { signal }) }); }
    catch (error) {
      if (signal?.aborted) throw error;
      // Slack never fails the request: Echo sources still answer.
      return { items: [], receipts: [], notice: "Slack could not be searched just now." };
    }
    const perThread = new Map<string, number>();
    const kept = messages.filter((message) => {
      const key = `${message.channel_id}:${message.thread_ts ?? message.message_ts}`;
      const count = perThread.get(key) ?? 0;
      perThread.set(key, count + 1);
      return count < SLACK_PER_THREAD;
    });
    const released = slackItems("search", kept);
    return released === null ? { items: [], receipts: [] } : { items: released.items, receipts: [released.receipt] };
  };

  const save = (item: EvidenceDeskItemV1, release: Omit<Stored, "item">): EvidenceDeskItemV1 => {
    const existing = stored.get(item.id);
    // An inventory item has no text.  Opening that same immutable coordinate
    // must upgrade the item while retaining both releases for revalidation.
    if (existing !== undefined && (existing.item.text !== undefined || item.text === undefined)) return existing.item;
    stored.set(item.id, Object.freeze({ item, ...release }));
    return item;
  };
  const originals = (release: OriginalContextDeskReleaseV1): readonly EvidenceDeskItemV1[] => {
    originalReleases.push(release);
    return release.items.map((value) => save(Object.freeze({
      id: itemId(sourceCitation(value)), citation: sourceCitation(value), kind: value.kind,
      ...(value.text === undefined ? {} : { text: value.text }), label: value.label,
      visibility: value.visibility, receipt_sha256: release.receipt,
    }), { original: release }));
  };
  const records = (result: ReturnType<PersonEvidenceDeskRecordsV1["searchBatch"]>, includeText = true): readonly EvidenceDeskItemV1[] => {
    latestRecordTruncated ||= result.truncated === true;
    pointer ??= result.release.active_pointer;
    if (pointer.generation_id !== result.release.active_pointer.generation_id || pointer.manifest_sha256 !== result.release.active_pointer.manifest_sha256 || pointer.record_head.position !== result.release.active_pointer.record_head.position || pointer.record_head.record_sha256 !== result.release.active_pointer.record_head.record_sha256) throw new AuthorityOperationError("unavailable", "record evidence snapshot changed");
    recordReleases.push(result.release);
    if (result.desk_items === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    return result.desk_items.map((value) => {
      const citation = recordCitation(value);
      return save(Object.freeze({ id: itemId(citation), citation, kind: value.item_kind as EvidenceDeskKindV1, ...(includeText ? { text: value.text } : {}), label: value.label, visibility: value.visibility, ...(value.attributes === undefined ? {} : { attributes: value.attributes }), receipt_sha256: result.release.record_read_audit_row_sha256 }), { record: result.release, record_anchor: { atom_id: value.atom_id, record_sha256: value.record_sha256, record_position: value.record_position, envelope_sha256: value.envelope_sha256, atom_order: value.atom_order, audience_project_count: value.audience_project_count, item_kind: value.item_kind, text: value.text, policy_id: value.policy_id } });
    });
  };
  const searchRecords = (query: string, kinds?: readonly EvidenceDeskKindV1[]): readonly EvidenceDeskItemV1[] => {
    if (recordsUnavailableAtStart) return [];
    try {
      const recordKinds = kinds?.filter((kind): kind is "decision" | "action" | "rationale" => kind === "decision" || kind === "action" || kind === "rationale");
      if (recordKinds !== undefined && recordKinds.length === 0) return [];
      return records(options.records.searchBatch({ access_token: options.access_token, queries: [query], limit: 10, desk: true, ...(recordKinds === undefined ? {} : { kinds: recordKinds }), ...recordScope(options.scope), ...(pointer === undefined ? {} : { expected_pointer: pointer }) }));
    } catch (error) {
      if (pointer === undefined && unavailableAtStart(error)) { recordsUnavailableAtStart = true; return []; }
      throw error;
    }
  };
  const initialize = (): string => {
    if (initializationFailure !== undefined) throw initializationFailure;
    const original = options.originals.deskAuthorize({ access_token: options.access_token, scope: options.scope });
    if (initialized) return original.checked_at;
    // The empty model-facing desk still needs a fixed record-mode decision.
    // This server-owned probe never enters the pad or a provider prompt.
    try {
      const probe = options.records.initializeDesk({ access_token: options.access_token, ...recordScope(options.scope) });
      pointer = probe.release.active_pointer;
      recordReleases.push(probe.release);
      initializationReceipts = [probe.release.record_read_audit_row_sha256];
    } catch (error) {
      if (unavailableAtStart(error)) recordsUnavailableAtStart = true;
      else { initializationFailure = error; throw error; }
    }
    initialized = true;
    return original.checked_at;
  };
  const result = (items: readonly EvidenceDeskItemV1[], truncated: boolean, receipts: readonly Sha256Digest[]): EvidenceDeskResultV1 => {
    const all = [...new Set([...initializationReceipts, ...receipts])];
    initializationReceipts = [];
    return Object.freeze({ items: Object.freeze(items), truncated, receipt_digests: Object.freeze(all), ...(recordsUnavailableAtStart ? { notice: "Meeting records were unavailable when this request began." } : {}) });
  };
  const search = async (input: EvidenceDeskSearchInputV1): Promise<EvidenceDeskResultV1> => {
    input.signal?.throwIfAborted();
    if (input.inventory_mode !== undefined &&
      (input.query !== undefined || input.inventory_mode !== "items")) {
      throw new AuthorityOperationError("invalid_request", "evidence inventory mode is invalid");
    }
    initialize();
    const limit = input.limit ?? (input.query === undefined ? 50 : 10);
    if (input.query === undefined) {
      latestRecordTruncated = false;
      const sourceKinds = input.kinds?.filter((kind): kind is "note" | "document_passage" => kind === "note" || kind === "document_passage");
      const released = options.originals.deskSearch({
        access_token: options.access_token,
        scope: options.scope,
        limit,
        ...(sourceKinds === undefined ? {} : { kinds: sourceKinds }),
        ...(input.inventory_mode === "items" ? { inventory_mode: "items" } : {}),
      });
      const beforeRecords = recordReleases.length;
      const recordKinds = input.kinds?.filter((kind): kind is "decision" | "action" | "rationale" => kind === "decision" || kind === "action" || kind === "rationale");
      const recordInventory = recordsUnavailableAtStart ? [] : records(options.records.listDeskBatch({ access_token: options.access_token, limit, ...(recordKinds === undefined ? {} : { kinds: recordKinds }), ...recordScope(options.scope), ...(pointer === undefined ? {} : { expected_pointer: pointer }) }), false);
      const items = balanced(originals(released), recordInventory).filter((item) => input.kinds === undefined || input.kinds.includes(item.kind));
      return result(items.slice(0, limit), released.truncated || latestRecordTruncated || items.length > limit, [released.receipt, ...recordReleases.slice(beforeRecords).map((entry) => entry.record_read_audit_row_sha256)]);
    }
    latestRecordTruncated = false;
    const sourceKinds = input.kinds?.filter((kind): kind is "note" | "document_passage" => kind === "note" || kind === "document_passage");
    const slackWanted = input.kinds === undefined || input.kinds.includes("slack_message");
    // Slack is read live in parallel; the Echo reads below are synchronous and audited first.
    const slack = slackWanted ? slackSearch(input.query, input.signal) : Promise.resolve({ items: [] as readonly EvidenceDeskItemV1[], receipts: [] as readonly Sha256Digest[] });
    const released = options.originals.deskSearch({ access_token: options.access_token, scope: options.scope, query: input.query, limit, ...(sourceKinds === undefined ? {} : { kinds: sourceKinds }) });
    const beforeRecords = recordReleases.length;
    const echoItems = [originals(released), searchRecords(input.query, input.kinds)].map((list) => list.filter((item) => input.kinds === undefined || input.kinds.includes(item.kind)));
    const slackResult = await slack;
    input.signal?.throwIfAborted();
    const items = interleave(echoItems[0]!, echoItems[1]!, slackResult.items);
    const base = result(items.slice(0, limit), released.truncated || latestRecordTruncated || items.length > limit, [released.receipt, ...recordReleases.slice(beforeRecords).map((entry) => entry.record_read_audit_row_sha256), ...slackResult.receipts]);
    const slackNotice: string | undefined = (slackResult as { readonly notice?: string }).notice;
    return slackNotice === undefined ? base : Object.freeze({ ...base, notice: base.notice === undefined ? slackNotice : `${base.notice} ${slackNotice}` });
  };
  const list = async (input: EvidenceDeskListInputV1): Promise<EvidenceDeskResultV1> => {
    input.signal?.throwIfAborted();
    initialize();
    const limit = Math.min(50, Math.max(1, input.limit ?? 50));
    if (input.source === "slack") {
      if (options.slack === undefined) return result([], false, []);
      if (input.channel === undefined) throw new AuthorityOperationError("invalid_request", "slack needs a channel");
      const oldest = slackBound(input.since, false); const latest = slackBound(input.until, true);
      let history: Awaited<ReturnType<PersonSlackReaderV1["history"]>>;
      try { history = await options.slack.reader.history({ channel: input.channel, limit, ...(oldest === undefined ? {} : { oldest }), ...(latest === undefined ? {} : { latest }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.signal === undefined ? {} : { signal: input.signal }) }); }
      catch (error) {
        if (input.signal?.aborted) throw error;
        return Object.freeze({ ...result([], false, []), notice: "Slack could not be read just now." });
      }
      if (!history.found) throw new AuthorityOperationError("invalid_request", `no Slack channel named "${input.channel.slice(0, 80)}" that you can see`);
      const released = slackItems("history", history.messages);
      const base = result(released?.items ?? [], history.next_cursor !== undefined, released === null ? [] : [released.receipt]);
      return history.next_cursor === undefined ? base : Object.freeze({ ...base, next_cursor: history.next_cursor });
    }
    // Meetings and documents: the existing inventory reads, one source each. Items carry no text.
    if (input.source === "meeting") {
      if (recordsUnavailableAtStart) return result([], false, []);
      const recordKinds = input.kinds?.filter((kind): kind is "decision" | "action" | "rationale" => kind === "decision" || kind === "action" || kind === "rationale");
      if (recordKinds !== undefined && recordKinds.length === 0) return result([], false, []);
      latestRecordTruncated = false;
      const beforeRecords = recordReleases.length;
      const items = records(options.records.listDeskBatch({ access_token: options.access_token, limit, ...(recordKinds === undefined ? {} : { kinds: recordKinds }), ...recordScope(options.scope), ...(pointer === undefined ? {} : { expected_pointer: pointer }) }), false);
      return result(items.slice(0, limit), latestRecordTruncated || items.length > limit, recordReleases.slice(beforeRecords).map((entry) => entry.record_read_audit_row_sha256));
    }
    const sourceKinds = input.kinds?.filter((kind): kind is "note" | "document_passage" => kind === "note" || kind === "document_passage");
    if (sourceKinds !== undefined && sourceKinds.length === 0) return result([], false, []);
    const released = options.originals.deskSearch({ access_token: options.access_token, scope: options.scope, limit, ...(sourceKinds === undefined ? {} : { kinds: sourceKinds }) });
    const items = originals(released);
    return result(items.slice(0, limit), released.truncated || items.length > limit, [released.receipt]);
  };
  const open = async (input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV1> => {
    input.signal?.throwIfAborted();
    initialize();
    const value = stored.get(input.item);
    if (value === undefined) throw new AuthorityOperationError("not_found", "evidence item is not available");
    if (value.item.citation.kind === "slack_message") {
      const message = value.slack;
      if (message === undefined || options.slack === undefined) throw new AuthorityOperationError("unavailable", "Slack evidence is unavailable");
      const threadTs = message.thread_ts ?? ((message.reply_count ?? 0) > 0 ? message.message_ts : undefined);
      if (threadTs === undefined) return result([value.item], false, [value.item.receipt_sha256]);
      const thread = await options.slack.reader.thread({ channel_id: message.channel_id, thread_ts: threadTs, limit: SLACK_THREAD_REPLIES + 1, ...(input.signal === undefined ? {} : { signal: input.signal }) });
      const released = slackItems("thread", thread.messages);
      if (released === null) return result([value.item], false, [value.item.receipt_sha256]);
      // The opened message leads, then the thread in order.
      const anchor = released.items.find((item) => item.id === value.item.id) ?? value.item;
      return result([anchor, ...released.items.filter((item) => item.id !== anchor.id)], thread.truncated, [released.receipt]);
    }
    if (value.item.citation.kind === "source_revision") {
      const release = options.originals.deskOpen({ access_token: options.access_token, scope: options.scope, citation: value.item.citation, ...(input.neighbours === undefined ? {} : { neighbours: input.neighbours }) });
      return result(originals(release), release.truncated, [release.receipt]);
    }
    if (value.record === undefined || value.record_anchor === undefined) throw new AuthorityOperationError("unavailable", "record evidence open is unavailable");
    const expanded = options.records.openDeskBatch({ access_token: options.access_token, release: value.record, anchor: value.record_anchor });
    latestRecordTruncated = false;
    return result(records(expanded), expanded.truncated === true, [expanded.release.record_read_audit_row_sha256]);
  };
  const openCitation = async (input: { readonly citation: PersonAnswerCitationV3; readonly neighbours?: number; readonly signal?: AbortSignal }) => {
    input.signal?.throwIfAborted();
    initialize();
    if ((input.citation as { readonly kind: string }).kind === "slack_message") throw new AuthorityOperationError("not_found", "Slack messages open in Slack");
    if (input.citation.kind === "approved_record") {
      const expanded = options.records.openDeskCitation({ access_token: options.access_token, atom_id: input.citation.atom_id, record_sha256: input.citation.record_sha256, policy_id: input.citation.policy_id, ...recordScope(options.scope) });
      latestRecordTruncated = false;
      return result(records(expanded), expanded.truncated === true, [expanded.release.record_read_audit_row_sha256]);
    }
    const release = options.originals.deskOpen({ access_token: options.access_token, scope: options.scope, citation: input.citation, ...(input.neighbours === undefined ? {} : { neighbours: input.neighbours }) });
    return result(originals(release), release.truncated, [release.receipt]);
  };
  const revalidate = async (input: { readonly signal?: AbortSignal }) => {
    input.signal?.throwIfAborted();
    let checkedAt: string | undefined = initialize();
    for (const release of originalReleases) checkedAt = options.originals.revalidateDeskRelease({ access_token: options.access_token, release }).checked_at;
    for (const release of recordReleases) checkedAt = options.records.revalidateBatchRelease({ access_token: options.access_token, release }).checked_at;
    if (slackReleased && options.slack !== undefined && (slackCheckedAt === undefined || now() - slackCheckedAt >= PERSON_EVIDENCE_DESK_SLACK_CHECK_MS_V1)) {
      // A revoked or disconnected Slack connection stops the request before Slack text reaches another model call.
      await options.slack.reader.check({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
      slackCheckedAt = now();
    }
    return Object.freeze({ checked_at: checkedAt });
  };
  return Object.freeze({
    scope: publicScope(options.scope),
    search: (input: EvidenceDeskSearchInputV1) => observedDeskCall("evidence_search", () => search(input)),
    open: (input: EvidenceDeskOpenInputV1) => observedDeskCall("evidence_open", () => open(input)),
    list: (input: EvidenceDeskListInputV1) => observedDeskCall("evidence_list", () => list(input)),
    openCitation: (input: Parameters<typeof openCitation>[0]) => observedDeskCall("evidence_open", () => openCitation(input)),
    revalidate: (input: { readonly signal?: AbortSignal }) => observeCoreRuntimeV1("evidence_revalidate", () => revalidate(input)),
  });
}
