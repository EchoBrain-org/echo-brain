import type { PersonAnswerEvidenceCitationV6 } from '@echo-brain/organization-api';
import {
  evidenceDeskSourceV1,
  type EvidenceDeskItemV1,
  type EvidenceDeskKindV1,
  type EvidenceDeskListInputV1,
  type EvidenceDeskOpenInputV1,
  type EvidenceDeskPortV1,
  type EvidenceDeskResultV1,
  type EvidenceDeskSearchInputV1,
  type EvidenceDeskSourceV1,
} from './evidence-desk-v1.js';

/** The V1 desk plus request-only live work items and knowledge-page sections. */
export type EvidenceDeskKindV2 = EvidenceDeskKindV1 | 'ticket' | 'page';
/** Meeting records/documents live in Echo; these additions are read live. */
export type EvidenceDeskSourceV2 = EvidenceDeskSourceV1 | 'ticket' | 'page';
export type EvidenceDeskLiveSourceKindV2 = 'slack' | 'ticket' | 'page';
export type EvidenceDeskCatalogSelectorV2 = 'slack' | 'tickets' | 'pages';
/** Server-selected descriptor. It contains no provider host, container, or user coordinate. */
export interface EvidenceDeskLiveSourceV2 {
  readonly source: EvidenceDeskLiveSourceKindV2;
  /** V1 callers can omit descriptors; V2 composition supplies all three. */
  readonly selector?: EvidenceDeskCatalogSelectorV2;
  readonly description?: string;
  readonly metadata_only_list?: boolean;
  readonly tool_id?: string;
}

/** The source of an item, from its kind. */
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2 }): EvidenceDeskSourceV2 {
  if (item.kind === 'ticket') return 'ticket';
  if (item.kind === 'page') return 'page';
  return evidenceDeskSourceV1({ kind: item.kind });
}

export interface EvidenceDeskItemV2 extends Omit<EvidenceDeskItemV1, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV6;
  readonly kind: EvidenceDeskKindV2;
}

export interface EvidenceDeskResultV2 extends Omit<EvidenceDeskResultV1, 'items'> {
  readonly items: readonly EvidenceDeskItemV2[];
}

/** Ticket inventory items carry no text, like meeting and document items. */
export interface EvidenceDeskListInputV2 extends Omit<EvidenceDeskListInputV1, 'source' | 'kinds'> {
  readonly source: EvidenceDeskSourceV2;
  readonly kinds?: readonly EvidenceDeskKindV2[];
}

export interface EvidenceDeskPortV2 extends Omit<EvidenceDeskPortV1, 'search' | 'open' | 'list' | 'live_sources'> {
  /** Request-local availability selected by server composition, without provider coordinates. */
  readonly ticket_available?: boolean;
  /** Connected live sources let research choose without provider implementation details. */
  readonly live_sources?: readonly EvidenceDeskLiveSourceV2[];
  search(input: Omit<EvidenceDeskSearchInputV1, 'kinds'> & { readonly kinds?: readonly EvidenceDeskKindV2[] }): Promise<EvidenceDeskResultV2>;
  open(input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
}
