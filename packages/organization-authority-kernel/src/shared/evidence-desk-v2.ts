import type { PersonAnswerEvidenceCitationV5, PersonAnswerScopeV3, PersonOpenRefV1 } from '@echo-brain/organization-api';

/** Read-only evidence desk contract bound to one authenticated Person request. */
export type EvidenceDeskKindV2 = 'decision' | 'action' | 'rationale' | 'note' | 'document_passage' | 'slack_message' | 'ticket';
export type EvidenceDeskVisibilityV2 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
export type EvidenceDeskCitationV2 = PersonAnswerEvidenceCitationV5;
/** Meeting records and documents live in Echo; Slack and tickets are read live. */
export type EvidenceDeskSourceV2 = 'meeting' | 'document' | 'slack' | 'ticket';

/** The source of an item, from its kind. */
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2 }): EvidenceDeskSourceV2 {
  if (item.kind === 'ticket') return 'ticket';
  if (item.kind === 'slack_message') return 'slack';
  return item.kind === 'note' || item.kind === 'document_passage' ? 'document' : 'meeting';
}
export type EvidenceDeskScopeV2 = PersonAnswerScopeV3;

export interface EvidenceDeskAttributesV2 {
  readonly owner?: string;
  readonly due_at?: string;
  readonly status?: string;
}

export interface EvidenceDeskItemV2 {
  /** Opaque server-owned desk identity. Models never author or transform this value. */
  readonly id: string;
  readonly citation: EvidenceDeskCitationV2;
  readonly kind: EvidenceDeskKindV2;
  /** Absent for an inventory item. Present only after an authorized release. */
  readonly text?: string;
  readonly label: string;
  readonly visibility: EvidenceDeskVisibilityV2;
  readonly attributes?: EvidenceDeskAttributesV2;
  /** YYYY-MM-DD when the item was said, approved or revised, when the source knows it. */
  readonly occurred_at?: string;
  /** SHA-256 receipt for the release that admitted this item into the request. */
  readonly receipt_sha256: `sha256:${string}`;
  /** Server-owned ref for person open. Never shown to a model. */
  readonly ref?: PersonOpenRefV1;
}

export interface EvidenceDeskResultV2 {
  readonly items: readonly EvidenceDeskItemV2[];
  readonly truncated: boolean;
  /** Every audited release made by this call, including empty and metadata-only releases. */
  readonly receipt_digests: readonly `sha256:${string}`[];
  /** Availability notice, for example when record evidence was unavailable at request start. */
  readonly notice?: string;
  /** Opaque continuation for `list`; absent when nothing more exists. */
  readonly next_cursor?: string;
}

export interface EvidenceDeskSearchInputV2 {
  readonly query?: string;
  readonly kinds?: readonly EvidenceDeskKindV2[];
  readonly limit?: number;
  /** Server-internal complete atom inventory. It is valid only without a query. */
  readonly inventory_mode?: "items";
  readonly signal?: AbortSignal;
}

/**
 * Lists one source without keywords. Meeting, document and ticket inventory
 * items carry no text; Slack messages carry their text, which is their title.
 * Slack requires `channel` (a name the asker can see).
 */
export interface EvidenceDeskListInputV2 {
  readonly source: EvidenceDeskSourceV2;
  readonly kinds?: readonly EvidenceDeskKindV2[];
  readonly channel?: string;
  /** Inclusive YYYY-MM-DD bounds; applied where the source knows dates. */
  readonly since?: string;
  readonly until?: string;
  /** At most 50. */
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface EvidenceDeskOpenInputV2 {
  readonly item: string;
  readonly neighbours?: number;
  readonly signal?: AbortSignal;
}

/**
 * Layer-3 port. Its construction binds the actor, scope and pinned snapshot.
 * `revalidate` checks every item released so far, including inventory metadata
 * and the evidence about to be sent to the next model call, plus that snapshot.
 */
export interface EvidenceDeskPortV2 {
  readonly scope: EvidenceDeskScopeV2;
  search(input: EvidenceDeskSearchInputV2): Promise<EvidenceDeskResultV2>;
  open(input: EvidenceDeskOpenInputV2): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
  revalidate(input: { readonly signal?: AbortSignal }): Promise<{ readonly checked_at: string }>;
}
