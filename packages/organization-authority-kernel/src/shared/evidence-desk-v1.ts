import { AuthorityOperationError } from "../domain/errors.js";
import type { EvidenceDateFilterV1, EvidenceDatesV1 } from "./temporal-query-v1.js";
import type { PersonAnswerEvidenceCitationV4, PersonAnswerScopeV3, PersonOpenRefV1 } from '@echo-brain/organization-api';

/** A pinned evidence snapshot advanced; rechecking the old snapshot cannot recover it. */
export class EvidenceDeskSnapshotChangedV1 extends AuthorityOperationError {
  constructor() { super("unavailable", "meeting records changed during the search; please try again"); this.name = "EvidenceDeskSnapshotChangedV1"; }
}

/** Read-only evidence desk contract bound to one authenticated Person request. */
export type EvidenceDeskKindV1 = 'imported_meeting' | 'decision' | 'action' | 'rationale' | 'note' | 'document_passage';
export type EvidenceDeskVisibilityV1 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
export type EvidenceDeskCitationV1 = PersonAnswerEvidenceCitationV4;
/** Where an item came from. Meeting records and documents live in Echo. */
export type EvidenceDeskSourceV1 = 'meeting' | 'document';
/** Meaning of a provider-supplied date; never inferred from a storage source. */
export type EvidenceDeskDateKindV1 = 'created' | 'version_created' | 'occurred' | 'updated' | 'due' | 'received';

/** The source of an item, from its kind. */
export function evidenceDeskSourceV1(item: { readonly kind: EvidenceDeskKindV1; readonly ref?: string }): EvidenceDeskSourceV1 {
  if (item.ref?.startsWith('transcript:')) return 'meeting';
  return item.kind === 'note' || item.kind === 'document_passage' ? 'document' : 'meeting';
}
export type EvidenceDeskScopeV1 = PersonAnswerScopeV3;

/**
 * An item's row facts, each one line of text (research tool contract v1 adds the meeting-, project- and tool-level ones).
 * Lists of names are joined with ", ", and end ", and more" when the source holds more than it released.
 */
export interface EvidenceDeskAttributesV1 {
  readonly owner?: string;
  readonly due_at?: string;
  readonly status?: string;
  /** A meeting's participants, as the meeting recorded them (display names). */
  readonly participants?: string;
  /** Who gave a meeting record its final approval (a current directory display name). */
  readonly approved_by?: string;
  /** The asker's role in a project, or a member's role: lead or member. */
  readonly role?: string;
  /** A project's leads (display names). */
  readonly leads?: string;
  /** A tool container's key in its tool, such as a Jira project key or a Confluence space key. */
  readonly key?: string;
  /** The tool a tool item or container belongs to, as the person's tools list names it (Jira, Confluence, Slack). */
  readonly tool?: string;
}

export interface EvidenceDeskItemV1 {
  /** Opaque server-owned desk identity. Models never author or transform this value. */
  readonly id: string;
  readonly citation: EvidenceDeskCitationV1;
  readonly kind: EvidenceDeskKindV1;
  /** Absent for an inventory item. Present only after an authorized release. */
  readonly text?: string;
  readonly label: string;
  /**
   * How Ask's list rows name this item when its label is its container's (a meeting record's is its meeting's): one line
   * of its own text, then the container (ADR-0041). Released and audited with the item; only Ask's list rows read it.
   */
  readonly list_label?: string;
  readonly visibility: EvidenceDeskVisibilityV1;
  readonly attributes?: EvidenceDeskAttributesV1;
  /** YYYY-MM-DD when the item was said, approved or revised, when the source knows it. */
  readonly occurred_at?: string;
  readonly date_kind?: EvidenceDeskDateKindV1;
  /** Source-supplied timestamps/calendar dates with explicit meanings. */
  readonly dates?: EvidenceDatesV1;
  /** SHA-256 receipt for the release that admitted this item into the request. */
  readonly receipt_sha256: `sha256:${string}`;
  /** Server-owned ref for person open. Never shown to a model. */
  readonly ref?: PersonOpenRefV1;
}

export interface EvidenceDeskResultV1 {
  readonly items: readonly EvidenceDeskItemV1[];
  readonly truncated: boolean;
  /** Every audited release made by this call, including empty and metadata-only releases. */
  readonly receipt_digests: readonly `sha256:${string}`[];
  /** Availability notice, for example when record evidence was unavailable at request start. */
  readonly notice?: string;
  /** Opaque continuation for `list`; absent when nothing more exists. */
  readonly next_cursor?: string;
  /**
   * `list` only: the source's raw page held its full page size. With no `next_cursor` the list's end is unverified
   * (ADR-0041). A desk that confirmed its end, for example by reading one row past its limit, says false.
   */
  readonly page_full?: boolean;
  /**
   * `open` only: whether the opened item's own text was cut. `truncated` also reports what an open left out beside the
   * item (a link, a meeting's other records); a desk that does not say leaves `truncated` to cover the item (ADR-0041).
   */
  readonly anchor_truncated?: boolean;
}

export interface EvidenceDeskSearchInputV1 extends EvidenceDateFilterV1 {
  readonly source?: EvidenceDeskSourceV1;
  readonly query?: string;
  readonly kinds?: readonly EvidenceDeskKindV1[];
  readonly limit?: number;
  /** Server-internal complete atom inventory. It is valid only without a query. */
  readonly inventory_mode?: "items";
  readonly signal?: AbortSignal;
}

/** Lists one source without keywords, newest first where the source knows dates. Meeting and document items carry no text. */
export interface EvidenceDeskListInputV1 extends EvidenceDateFilterV1 {
  readonly source: EvidenceDeskSourceV1;
  readonly kinds?: readonly EvidenceDeskKindV1[];
  /** Inclusive YYYY-MM-DD bounds; applied where the source knows dates. */
  readonly since?: string;
  readonly until?: string;
  /** At most 50. */
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface EvidenceDeskOpenInputV1 {
  readonly item: string;
  readonly neighbours?: number;
  readonly signal?: AbortSignal;
}

/**
 * How much one access check re-reads (ADR-0038). `full` re-checks every item
 * released so far. `incremental` re-checks only what was released since this
 * desk's last successful check, and still checks the session, membership
 * tenure, grants, connections and snapshot pins on every call.
 */
export type EvidenceDeskRevalidationModeV1 = 'full' | 'incremental';

export interface EvidenceDeskRevalidateInputV1 {
  readonly signal?: AbortSignal;
  /**
   * Omitted means `full`. Only the check before a model call asks for
   * `incremental`; the final response always runs `full`. A desk or source
   * that cannot check incrementally runs a full check instead.
   */
  readonly mode?: EvidenceDeskRevalidationModeV1;
}

/**
 * Layer-3 port. Its construction binds the actor, scope and pinned snapshot.
 * `revalidate` checks every item released so far, including inventory metadata
 * and the evidence about to be sent to the next model call, plus that snapshot.
 * An `incremental` check narrows "every item" to items released since the
 * last successful check of this desk instance, so an item an earlier check
 * covered is not re-read when it first reaches a later prompt; that state is
 * never shared across requests.
 */
export interface EvidenceDeskPortV1 {
  readonly scope: EvidenceDeskScopeV1;
  search(input: EvidenceDeskSearchInputV1): Promise<EvidenceDeskResultV1>;
  open(input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV1>;
  list(input: EvidenceDeskListInputV1): Promise<EvidenceDeskResultV1>;
  revalidate(input: EvidenceDeskRevalidateInputV1): Promise<{ readonly checked_at: string }>;
}
