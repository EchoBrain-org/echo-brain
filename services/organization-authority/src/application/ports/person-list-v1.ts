import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  PersonDocumentExtractionStateV1,
  PersonDocumentMediaTypeV1,
  PersonOpenMeetingAtomV1,
  PersonOpenMeetingDetailV1,
  ProjectIdV1,
} from "@echo-brain/organization-api";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { PersonAskScopeV2 } from "./person-original-context-retrieval-v1.js";

/** Last emitted row of ONE source. Store order inside a source: added_at DESC, id ASC (binary). */
export interface PersonItemPositionV1 { readonly added_at: string; readonly id: string }
/** Store-raw visibility; only the list route collapses it (ADR-0023). */
export type PersonStoreVisibilityV1 = "only_me" | "team" | "project" | "projects" | "approver_only";
interface PersonStoreRowBaseV1 {
  readonly id: string;
  /** Raw; the route bounds it and falls back. */
  readonly title: string | null;
  /** Canonical YYYY-MM-DDTHH:MM:SS.mmmZ. */
  readonly added_at: string;
  readonly visibility: PersonStoreVisibilityV1;
  /** Association ∩ the caller's active grants, sorted. */
  readonly association_project_ids: readonly ProjectIdV1[];
}
export interface PersonStoreNoteRowV1 extends PersonStoreRowBaseV1 { readonly kind: "note"; readonly id: `ctx_${string}` }
export interface PersonStoreDocumentRowV1 extends PersonStoreRowBaseV1 {
  readonly kind: "document";
  readonly id: `doc_${string}`;
  readonly media_type: PersonDocumentMediaTypeV1;
  readonly extraction_state: PersonDocumentExtractionStateV1;
  readonly size_bytes: number;
}
export interface PersonStoreMeetingRowV1 extends PersonStoreRowBaseV1 {
  readonly kind: "meeting";
  readonly id: `sha256:${string}`;
  readonly meeting_date?: string;
}
/** Route-local capability; only the issuing store instance accepts its identity (WeakMap). Single use. */
export interface PersonStoreHandleV1 { readonly __person_store_handle?: never }
/** Server-only witness. receipt is absent when zero rows were committed (no audit row written). */
export interface PersonStoreReleaseV1 { readonly receipt?: Sha256Digest }

/**
 * Notes and documents from custody, under Ask's exact ACL. List is two-phase:
 * collect is unaudited, commit fences then audits the emitted prefix only.
 */
export interface PersonOriginalItemsPortV1 {
  /** Unaudited. Omit a source to skip it. rows.length < limit ⇒ that source is exhausted. */
  collect(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    /** 1..26 */
    readonly limit: number;
    readonly notes?: { readonly after: PersonItemPositionV1 | null };
    readonly documents?: { readonly after: PersonItemPositionV1 | null };
  }): { readonly notes: readonly PersonStoreNoteRowV1[]; readonly documents: readonly PersonStoreDocumentRowV1[]; readonly handle: PersonStoreHandleV1 };
  /** Fences, then audits exactly the first `notes` and `documents` rows it returned. */
  commit(input: { readonly access_token: string; readonly handle: PersonStoreHandleV1; readonly notes: number; readonly documents: number }): PersonStoreReleaseV1;
  /** Global access. Every item failure: AuthorityOperationError('not_found'). Audited. */
  open(input: {
    readonly access_token: string;
    readonly ref: { readonly kind: "note"; readonly id: `ctx_${string}` } | { readonly kind: "document"; readonly id: `doc_${string}` };
    readonly from_ordinal?: number;
  }):
    | { readonly kind: "note"; readonly row: PersonStoreNoteRowV1; readonly text: string; readonly release: PersonStoreReleaseV1 }
    | {
      readonly kind: "document"; readonly row: PersonStoreDocumentRowV1; readonly filename: string;
      readonly chunks: readonly { readonly anchor_kind: "page" | "paragraph"; readonly anchor_start: number; readonly text: string }[];
      readonly next_ordinal: number | null; readonly release: PersonStoreReleaseV1;
    };
  /** Throws unauthorized (tuple change) or stale_access_state (grants or row change). */
  revalidate(input: { readonly access_token: string; readonly release: PersonStoreReleaseV1 }): void;
}

export type PersonMeetingCollectionV1 =
  /** A verified index lag with a record this reader can read after it: nothing collected, nothing audited. */
  | Readonly<{ status: "held" }>
  | Readonly<{ status: "ok"; rows: readonly PersonStoreMeetingRowV1[]; handle: PersonStoreHandleV1 }>;
/** Inclusive: the first part the next page returns. */
export interface PersonMeetingPartPositionV1 { readonly atom_order: number; readonly part: number }

/**
 * Approved meetings, listed from the exact-head readable-search generation and
 * opened through the Layer 1 exact read. The approver stays server-only.
 */
export interface PersonMeetingItemsPortV1 {
  /** Unaudited. rows.length < limit ⇒ meetings are exhausted. */
  collectMeetings(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly after: PersonItemPositionV1 | null;
    /** 1..26 */
    readonly limit: number;
  }): PersonMeetingCollectionV1;
  /** Fences the session and grants, then audits exactly the first `count` rows it returned. */
  commitMeetings(input: { readonly access_token: string; readonly handle: PersonStoreHandleV1; readonly count: number }): PersonStoreReleaseV1;
  /** Global access. Every item failure: AuthorityOperationError('not_found'). Audited. */
  openMeeting(input: {
    readonly access_token: string;
    readonly record_sha256: `sha256:${string}`;
    readonly from?: PersonMeetingPartPositionV1;
  }): {
    readonly row: PersonStoreMeetingRowV1;
    /** Present iff `from` is undefined. */
    readonly meeting?: PersonOpenMeetingDetailV1;
    /** Present iff `from` is undefined. */
    readonly transcript_shared?: boolean;
    readonly atoms: readonly PersonOpenMeetingAtomV1[];
    readonly next: PersonMeetingPartPositionV1 | null;
    readonly release: PersonStoreReleaseV1;
  };
  /** Layer 1 exact read with current grants; not_found on a miss; no audit (an internal lookup, like openDeskCitation). */
  admitMeeting(input: { readonly access_token: string; readonly record_sha256: `sha256:${string}` }): void;
  /** Throws unauthorized when the session tuple or the caller's grants changed. */
  revalidateMeetingRelease(input: { readonly access_token: string; readonly release: PersonStoreReleaseV1 }): void;
}

/** A shared transcript opened by its approved record, after the caller admitted that record. */
export interface PersonTranscriptByRecordPortV1 {
  readApprovedMeetingTranscriptByRecordV1(input: {
    readonly access_token: string;
    readonly record_sha256: `sha256:${string}`;
    readonly offset?: number;
  }): { readonly text: string; readonly next_offset: number | null };
}

/** The content-free probe the meetings store asks before it offers a transcript ref. */
export type PersonTranscriptProbeV1 = (input: {
  readonly actor: PersonAccessAuthorization;
  readonly approval_id: string;
  readonly record_sha256: `sha256:${string}`;
}) => boolean;
