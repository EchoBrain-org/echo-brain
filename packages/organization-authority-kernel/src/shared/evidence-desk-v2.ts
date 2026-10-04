import type { PersonAnswerEvidenceCitationV5 } from '@echo-brain/organization-api';
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

/** The V1 desk plus live tickets. */
export type EvidenceDeskKindV2 = EvidenceDeskKindV1 | 'ticket';
/** Meeting records and documents live in Echo; Slack and tickets are read live. */
export type EvidenceDeskSourceV2 = EvidenceDeskSourceV1 | 'ticket';

/** The source of an item, from its kind. */
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2 }): EvidenceDeskSourceV2 {
  return item.kind === 'ticket' ? 'ticket' : evidenceDeskSourceV1({ kind: item.kind });
}

export interface EvidenceDeskItemV2 extends Omit<EvidenceDeskItemV1, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV5;
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

export interface EvidenceDeskPortV2 extends Omit<EvidenceDeskPortV1, 'search' | 'open' | 'list'> {
  /** Request-local availability selected by server composition, without provider coordinates. */
  readonly ticket_available?: boolean;
  /** Connected tool names let research choose a source without knowing provider implementation details. */
  readonly live_sources?: readonly { readonly source: 'ticket' | 'slack'; readonly tool_id: string }[];
  search(input: Omit<EvidenceDeskSearchInputV1, 'kinds'> & { readonly kinds?: readonly EvidenceDeskKindV2[] }): Promise<EvidenceDeskResultV2>;
  open(input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
}
