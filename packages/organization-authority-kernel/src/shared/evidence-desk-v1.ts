import type { PersonAnswerEvidenceCitationV4, PersonAnswerScopeV3, PersonOpenRefV1 } from '@echo-brain/organization-api';

/** Read-only evidence desk contract bound to one authenticated Person request. */
export type EvidenceDeskKindV1 = 'decision' | 'action' | 'rationale' | 'note' | 'document_passage' | 'slack_message';
export type EvidenceDeskVisibilityV1 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
export type EvidenceDeskCitationV1 = PersonAnswerEvidenceCitationV4;
/** Where an item came from. Meeting records and documents live in Echo; Slack is read live and never stored. */
export type EvidenceDeskSourceV1 = 'meeting' | 'document' | 'slack';

/** The source of an item, from its kind. */
export function evidenceDeskSourceV1(item: { readonly kind: EvidenceDeskKindV1 }): EvidenceDeskSourceV1 {
  if (item.kind === 'slack_message') return 'slack';
  return item.kind === 'note' || item.kind === 'document_passage' ? 'document' : 'meeting';
}
export type EvidenceDeskScopeV1 = PersonAnswerScopeV3;

export interface EvidenceDeskAttributesV1 {
  readonly owner?: string;
  readonly due_at?: string;
  readonly status?: string;
}

export interface EvidenceDeskItemV1 {
  /** Opaque server-owned desk identity. Models never author or transform this value. */
  readonly id: string;
  readonly citation: EvidenceDeskCitationV1;
  readonly kind: EvidenceDeskKindV1;
  /** Absent for an inventory item. Present only after an authorized release. */
  readonly text?: string;
  readonly label: string;
  readonly visibility: EvidenceDeskVisibilityV1;
  readonly attributes?: EvidenceDeskAttributesV1;
  /** YYYY-MM-DD when the item was said, approved or revised, when the source knows it. */
  readonly occurred_at?: string;
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
}

export interface EvidenceDeskSearchInputV1 {
  readonly query?: string;
  readonly kinds?: readonly EvidenceDeskKindV1[];
  readonly limit?: number;
  /** Server-internal complete atom inventory. It is valid only without a query. */
  readonly inventory_mode?: "items";
  readonly signal?: AbortSignal;
}

/**
 * Lists one source without keywords, newest first where the source knows dates.
 * Meeting and document items carry no text; Slack messages carry their text,
 * which is their only title. Slack requires `channel` (a name the asker can see).
 */
export interface EvidenceDeskListInputV1 {
  readonly source: EvidenceDeskSourceV1;
  readonly kinds?: readonly EvidenceDeskKindV1[];
  readonly channel?: string;
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
 * Layer-3 port. Its construction binds the actor, scope and pinned snapshot.
 * `revalidate` checks every item released so far, including inventory metadata
 * and the evidence about to be sent to the next model call, plus that snapshot.
 */
export interface EvidenceDeskPortV1 {
  readonly scope: EvidenceDeskScopeV1;
  search(input: EvidenceDeskSearchInputV1): Promise<EvidenceDeskResultV1>;
  open(input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV1>;
  list(input: EvidenceDeskListInputV1): Promise<EvidenceDeskResultV1>;
  revalidate(input: { readonly signal?: AbortSignal }): Promise<{ readonly checked_at: string }>;
}
