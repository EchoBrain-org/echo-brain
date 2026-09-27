import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  EvidenceDeskCitationV1,
  EvidenceDeskItemV1,
  EvidenceDeskKindV1,
  EvidenceDeskPortV1,
  EvidenceDeskResultV1,
  EvidenceDeskSearchInputV1,
  EvidenceDeskOpenInputV1,
  EvidenceDeskScopeV1,
} from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import type { PersonAnswerCitationV3 } from "@echo-brain/organization-api";
import type {
  OriginalContextDeskReleaseV1,
  PersonAskScopeV2,
  PersonOriginalContextEvidenceDeskPortV1,
} from "../application/ports/person-original-context-retrieval-v1.js";
import type {
  PersonRecordSearchBatchApplicationV1,
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
  readonly records: PersonRecordSearchBatchApplicationV1;
}

type Stored = Readonly<{
  item: EvidenceDeskItemV1;
  original?: OriginalContextDeskReleaseV1;
  record?: PersonRecordSearchBatchReleaseV1;
  record_anchor?: { readonly atom_id: Sha256Digest; readonly record_sha256: Sha256Digest; readonly record_position: number; readonly envelope_sha256: Sha256Digest; readonly atom_order: number; readonly audience_project_count: number; readonly item_kind: "decision" | "action" | "rationale"; readonly text: string; readonly policy_id: "restricted-reviewer-person-v2" | "organization-member-readable-person-v2" | "project-members-readable-person-v1" };
}>;

function publicScope(scope: PersonAskScopeV2): EvidenceDeskScopeV1 {
  return (scope.kind === "global" ? Object.freeze({ kind: "global" }) : Object.freeze({ kind: "project", project_id: scope.project_id })) as EvidenceDeskScopeV1;
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
  const records = (result: ReturnType<PersonRecordSearchBatchApplicationV1["searchBatch"]>, includeText = true): readonly EvidenceDeskItemV1[] => {
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
      return records(options.records.searchBatch({ access_token: options.access_token, queries: [query], limit: 10, desk: true, ...(recordKinds === undefined ? {} : { kinds: recordKinds }), ...(options.scope.kind === "project" ? { project_id: options.scope.project_id } : {}), ...(pointer === undefined ? {} : { expected_pointer: pointer }) }));
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
      const probe = options.records.initializeDesk === undefined
        ? options.records.searchBatch({ access_token: options.access_token, queries: ["evidence"], limit: 1, desk: true, ...(options.scope.kind === "project" ? { project_id: options.scope.project_id } : {}) })
        : options.records.initializeDesk({ access_token: options.access_token, ...(options.scope.kind === "project" ? { project_id: options.scope.project_id } : {}) });
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
    initialize();
    const limit = input.limit ?? (input.query === undefined ? 50 : 10);
    if (input.query === undefined) {
      latestRecordTruncated = false;
      const sourceKinds = input.kinds?.filter((kind): kind is "note" | "document_passage" => kind === "note" || kind === "document_passage");
      const released = options.originals.deskSearch({ access_token: options.access_token, scope: options.scope, limit, ...(sourceKinds === undefined ? {} : { kinds: sourceKinds }) });
      const beforeRecords = recordReleases.length;
      const recordKinds = input.kinds?.filter((kind): kind is "decision" | "action" | "rationale" => kind === "decision" || kind === "action" || kind === "rationale");
      const recordInventory = recordsUnavailableAtStart || options.records.listDeskBatch === undefined ? [] : records(options.records.listDeskBatch({ access_token: options.access_token, limit, ...(recordKinds === undefined ? {} : { kinds: recordKinds }), ...(options.scope.kind === "project" ? { project_id: options.scope.project_id } : {}), ...(pointer === undefined ? {} : { expected_pointer: pointer }) }), false);
      const items = balanced(originals(released), recordInventory).filter((item) => input.kinds === undefined || input.kinds.includes(item.kind));
      return result(items.slice(0, limit), released.truncated || latestRecordTruncated || items.length > limit, [released.receipt, ...recordReleases.slice(beforeRecords).map((entry) => entry.record_read_audit_row_sha256)]);
    }
    latestRecordTruncated = false;
    const sourceKinds = input.kinds?.filter((kind): kind is "note" | "document_passage" => kind === "note" || kind === "document_passage");
    const released = options.originals.deskSearch({ access_token: options.access_token, scope: options.scope, query: input.query, limit, ...(sourceKinds === undefined ? {} : { kinds: sourceKinds }) });
    const beforeRecords = recordReleases.length;
    const items = balanced(originals(released), searchRecords(input.query, input.kinds)).filter((item) => input.kinds === undefined || input.kinds.includes(item.kind));
    return result(items.slice(0, limit), released.truncated || latestRecordTruncated || items.length > limit, [released.receipt, ...recordReleases.slice(beforeRecords).map((entry) => entry.record_read_audit_row_sha256)]);
  };
  const open = async (input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV1> => {
    input.signal?.throwIfAborted();
    initialize();
    const value = stored.get(input.item);
    if (value === undefined) throw new AuthorityOperationError("not_found", "evidence item is not available");
    if (value.item.citation.kind === "source_revision") {
      const release = options.originals.deskOpen({ access_token: options.access_token, scope: options.scope, citation: value.item.citation, ...(input.neighbours === undefined ? {} : { neighbours: input.neighbours }) });
      return result(originals(release), release.truncated, [release.receipt]);
    }
    if (value.record === undefined || value.record_anchor === undefined || options.records.openDeskBatch === undefined) throw new AuthorityOperationError("unavailable", "record evidence open is unavailable");
    const expanded = options.records.openDeskBatch({ access_token: options.access_token, release: value.record, anchor: value.record_anchor });
    latestRecordTruncated = false;
    return result(records(expanded), expanded.truncated === true, [expanded.release.record_read_audit_row_sha256]);
  };
  return Object.freeze({
    scope: publicScope(options.scope), search, open,
    openCitation: async (input: { readonly citation: PersonAnswerCitationV3; readonly neighbours?: number; readonly signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      initialize();
      if (input.citation.kind === "approved_record") {
        if (options.records.openDeskCitation === undefined) throw new AuthorityOperationError("unavailable", "record evidence open is unavailable");
        const expanded = options.records.openDeskCitation({ access_token: options.access_token, atom_id: input.citation.atom_id, record_sha256: input.citation.record_sha256, policy_id: input.citation.policy_id, ...(options.scope.kind === "project" ? { project_id: options.scope.project_id } : {}) });
        latestRecordTruncated = false;
        return result(records(expanded), expanded.truncated === true, [expanded.release.record_read_audit_row_sha256]);
      }
      const release = options.originals.deskOpen({ access_token: options.access_token, scope: options.scope, citation: input.citation, ...(input.neighbours === undefined ? {} : { neighbours: input.neighbours }) });
      return result(originals(release), release.truncated, [release.receipt]);
    },
    revalidate: async (input: { readonly signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      let checkedAt: string | undefined = initialize();
      for (const release of originalReleases) checkedAt = options.originals.revalidateDeskRelease({ access_token: options.access_token, release }).checked_at;
      for (const release of recordReleases) checkedAt = options.records.revalidateBatchRelease({ access_token: options.access_token, release }).checked_at;
      return Object.freeze({ checked_at: checkedAt });
    },
  });
}
