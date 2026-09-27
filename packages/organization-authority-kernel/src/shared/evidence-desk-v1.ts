import type { PersonAnswerCitationV3, PersonAnswerScopeV3 } from '@echo-brain/organization-api';

/** Read-only evidence desk contract bound to one authenticated Person request. */
export type EvidenceDeskKindV1 = 'decision' | 'action' | 'rationale' | 'note' | 'document_passage';
export type EvidenceDeskVisibilityV1 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
export type EvidenceDeskCitationV1 = PersonAnswerCitationV3;
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
  /** SHA-256 receipt for the release that admitted this item into the request. */
  readonly receipt_sha256: `sha256:${string}`;
}

export interface EvidenceDeskResultV1 {
  readonly items: readonly EvidenceDeskItemV1[];
  readonly truncated: boolean;
  /** Every audited release made by this call, including empty and metadata-only releases. */
  readonly receipt_digests: readonly `sha256:${string}`[];
  /** Availability notice, for example when record evidence was unavailable at request start. */
  readonly notice?: string;
}

export interface EvidenceDeskSearchInputV1 {
  readonly query?: string;
  readonly kinds?: readonly EvidenceDeskKindV1[];
  readonly limit?: number;
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
  revalidate(input: { readonly signal?: AbortSignal }): Promise<{ readonly checked_at: string }>;
}
