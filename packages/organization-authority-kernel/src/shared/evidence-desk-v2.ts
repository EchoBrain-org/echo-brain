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
} from './evidence-desk-v1.js';

/** The V1 desk plus request-only live work items and knowledge-page sections. */
export type EvidenceDeskKindV2 = EvidenceDeskKindV1 | 'ticket' | 'page';
/** Meeting records/documents live in Echo; these additions are read live. */
export type EvidenceDeskSourceV2 = string;
export type EvidenceDeskLiveSourceKindV2 = 'slack' | 'ticket' | 'page';
export type EvidenceDeskCatalogSelectorV2 = string;
/** Server-selected descriptor. It contains no provider host, container, or user coordinate. */
export interface LegacyEvidenceDeskLiveSourceV2 {
  readonly source: EvidenceDeskLiveSourceKindV2;
  /** V1 callers can omit descriptors; V2 composition supplies all three. */
  readonly selector?: EvidenceDeskCatalogSelectorV2;
  readonly description?: string;
  readonly metadata_only_list?: boolean;
  readonly tool_id?: string;
}

/** Server-owned identity is independent of content kind; two providers may both supply pages. */
export interface PersonLiveSourceDescriptorV2 {
  readonly source_id: string;
  readonly kind: 'ticket' | 'page' | 'slack_message';
  readonly selector: string;
  readonly description: string;
  readonly metadata_only_list: boolean;
  readonly tool_id?: string;
  readonly requires_channel?: boolean;
  readonly default_since_days?: number;
}
export type EvidenceDeskLiveSourceV2 = PersonLiveSourceDescriptorV2 | LegacyEvidenceDeskLiveSourceV2;

/** Translation for older desks only; registration and execution use the descriptor contract. */
export function liveSourceDescriptorV2(source: EvidenceDeskLiveSourceV2): PersonLiveSourceDescriptorV2 {
  if ('source_id' in source) return source;
  const defaults: Record<EvidenceDeskLiveSourceKindV2, Omit<PersonLiveSourceDescriptorV2, 'source_id'>> = {
    ticket: { kind: 'ticket', selector: 'tickets', description: 'Live work items: discover summaries, then open selected items for their current body and state.', metadata_only_list: true },
    page: { kind: 'page', selector: 'pages', description: 'Live knowledge pages: discover pages, then open selected pages and continuation handles for their current text.', metadata_only_list: true },
    slack: { kind: 'slack_message', selector: 'slack', description: 'Live discussion messages.', metadata_only_list: false, requires_channel: true, default_since_days: 14 },
  };
  return Object.freeze({ source_id: source.source, ...defaults[source.source],
    ...(source.selector === undefined ? {} : { selector: source.selector }),
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.metadata_only_list === undefined ? {} : { metadata_only_list: source.metadata_only_list }),
    ...(source.tool_id === undefined ? {} : { tool_id: source.tool_id }),
  });
}

/** The source of an item, from its kind. */
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2; readonly source_id?: string }): EvidenceDeskSourceV2 {
  if (item.source_id !== undefined) return item.source_id;
  if (item.kind === 'ticket') return 'ticket';
  if (item.kind === 'page') return 'page';
  return evidenceDeskSourceV1({ kind: item.kind });
}

export interface EvidenceDeskItemV2 extends Omit<EvidenceDeskItemV1, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV6;
  readonly kind: EvidenceDeskKindV2;
  /** Request-local owner, attached by the dispatcher and never part of a citation. */
  readonly source_id?: string;
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
  search(input: Omit<EvidenceDeskSearchInputV1, 'kinds'> & { readonly source?: string; readonly kinds?: readonly EvidenceDeskKindV2[] }): Promise<EvidenceDeskResultV2>;
  open(input: EvidenceDeskOpenInputV1): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
  /**
   * Opens one item from a citation released earlier, through the same scope
   * and access checks as any read. Background triggers use it for their
   * starting evidence; a desk without it cannot run them.
   */
  openCitation?(input: EvidenceDeskOpenCitationInputV2): Promise<EvidenceDeskResultV2>;
}

export interface EvidenceDeskOpenCitationInputV2 {
  /** A citation released by an earlier read; validated by the source that owns it. */
  readonly citation: unknown;
  readonly neighbours?: number;
  readonly signal?: AbortSignal;
}
