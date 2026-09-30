import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonDocumentExtractionStateV1, PersonDocumentMediaTypeV1, ProjectIdV1 } from "@echo-brain/organization-api";
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
