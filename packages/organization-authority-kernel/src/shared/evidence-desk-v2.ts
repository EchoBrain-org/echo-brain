import type { PersonAnswerEvidenceCitationV7, PersonAnswerOpenRefV7 } from '@echo-brain/organization-api';
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
import type { FollowUpListStatusV1, FollowUpsSourceDescriptorV1 } from './follow-up-evidence-v1.js';

/** The V1 desk plus request-only live work items and knowledge-page sections, and ECHO's shared follow-ups (ADR-0040). */
export type EvidenceDeskKindV2 = EvidenceDeskKindV1 | 'ticket' | 'page' | 'follow_up';
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
/**
 * A request-bound source a desk advertises: a connected tool, or ECHO's
 * follow-ups (ADR-0040), which have no tool of their own.
 */
export type EvidenceDeskLiveSourceV2 = PersonLiveSourceDescriptorV2 | FollowUpsSourceDescriptorV1 | LegacyEvidenceDeskLiveSourceV2;

/** Translation for older desks only; registration and execution use the descriptor contract. */
export function liveSourceDescriptorV2(source: PersonLiveSourceDescriptorV2 | LegacyEvidenceDeskLiveSourceV2): PersonLiveSourceDescriptorV2;
export function liveSourceDescriptorV2(source: EvidenceDeskLiveSourceV2): PersonLiveSourceDescriptorV2 | FollowUpsSourceDescriptorV1;
export function liveSourceDescriptorV2(source: EvidenceDeskLiveSourceV2): PersonLiveSourceDescriptorV2 | FollowUpsSourceDescriptorV1 {
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
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2; readonly source_id?: string; readonly ref?: string }): EvidenceDeskSourceV2 {
  if (item.source_id !== undefined) return item.source_id;
  if (item.kind === 'ticket') return 'ticket';
  if (item.kind === 'page') return 'page';
  return evidenceDeskSourceV1(item as { kind: EvidenceDeskKindV1; ref?: string });
}

export interface EvidenceDeskItemV2 extends Omit<EvidenceDeskItemV1, 'citation' | 'kind' | 'ref'> {
  readonly citation: PersonAnswerEvidenceCitationV7;
  readonly kind: EvidenceDeskKindV2;
  /** Server-owned ref for person open, or a follow-up's item page. Never shown to a model. */
  readonly ref?: PersonAnswerOpenRefV7;
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
  /**
   * Follow-ups only (ADR-0040), applied before anything is released or read
   * live: the owner's display name, matched as `followUpOwnerMatchesV1`
   * matches it, and a status group (`open`: the item is open; `done`: it is
   * done). The research loop sends them to no other source.
   */
  readonly owner?: string;
  readonly status?: FollowUpListStatusV1;
}

export interface EvidenceDeskPortV2 extends Omit<EvidenceDeskPortV1, 'search' | 'open' | 'list' | 'live_sources'> {
  /** Request-local availability selected by server composition, without provider coordinates. */
  readonly ticket_available?: boolean;
  /** Connected live sources let research choose without provider implementation details. */
  readonly live_sources?: readonly EvidenceDeskLiveSourceV2[];
  search(input: Omit<EvidenceDeskSearchInputV1, 'kinds' | 'source'> & { readonly source?: string; readonly kinds?: readonly EvidenceDeskKindV2[] }): Promise<EvidenceDeskResultV2>;
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
