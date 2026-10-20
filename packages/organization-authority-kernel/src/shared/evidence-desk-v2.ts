import type { PersonAnswerEvidenceCitationV7, PersonAnswerOpenRefV8, PersonWorkspaceCitationV1 } from '@echo-brain/organization-api';
import type { EvidenceDateFieldV1 } from './temporal-query-v1.js';
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
import { FOLLOW_UPS_SOURCE_ID_V1, type FollowUpListStatusV1, type FollowUpsSourceDescriptorV1 } from './follow-up-evidence-v1.js';
import type { WorkspaceSourceDescriptorV1 } from './workspace-evidence-v1.js';

/**
 * The V1 desk plus request-only live work items and knowledge-page sections, ECHO's shared follow-ups (ADR-0040), and
 * the workspace (research tool contract v1): the asker's projects, the people in their organization, their tools, and
 * the containers of their connected tools (Jira projects, Confluence spaces).
 */
export type EvidenceDeskKindV2 = EvidenceDeskKindV1 | 'ticket' | 'page' | 'follow_up' | EvidenceDeskWorkspaceKindV1;
export type EvidenceDeskWorkspaceKindV1 = 'project' | 'person' | 'tool' | 'tool_container';

/** A filter a source may take; which ones, and their allowed values, are in its capabilities. */
export type EvidenceFilterNameV1 = 'kind' | 'status' | 'owner' | 'role';

/**
 * What a source can do, as data (research tool contract v1). Research is shown it in its source catalog, and checks
 * each call against it before the desk, so what research is told and what the desk accepts cannot drift apart.
 */
export interface EvidenceSourceCapabilitiesV1 {
  /** Each filter it applies: its allowed values, `name` for a person's name, or `text` for free text. */
  readonly filters: Readonly<Partial<Record<EvidenceFilterNameV1, readonly string[] | 'name' | 'text'>>>;
  /**
   * Each date field it can filter on, with a one-line meaning. A meaning says when not every item records the date,
   * for example "when the meeting happened; only meetings with a recorded time have it".
   */
  readonly dates: Readonly<Partial<Record<EvidenceDateFieldV1, string>>>;
  /** It matches a window with no date field against any of an item's dates (`date_field: any`). */
  readonly any_date: boolean;
  /** The names of the links its items may carry, such as `decision`, `follows`, `members` or `projects`. */
  readonly links: readonly string[];
  /** How many items the asker can see in it, for an ECHO source that counts them cheaply. */
  readonly count?: number;
}

/** A status a list of projects takes. */
export type ProjectListStatusV1 = 'active' | 'archived';
/** A role a list of projects takes. */
export type ProjectListRoleV1 = 'lead' | 'member';

/**
 * Items a date filter could not test because they do not record the date it reads (research tool contract v1): how
 * many there are, and which dates they do carry. They are not in the result.
 */
export interface EvidenceDeskUncheckedV1 {
  readonly count: number;
  readonly dates: readonly EvidenceDateFieldV1[];
}
/** Meeting records/documents live in Echo; these additions are read live. */
export type EvidenceDeskSourceV2 = string;

/** Server-owned identity is independent of content kind; two providers may both supply pages. */
export interface PersonLiveSourceDescriptorV2 {
  readonly source_id: string;
  /** `tool_container`: the tool's containers (Jira projects, Confluence spaces), research tool contract v1. */
  readonly kind: 'ticket' | 'page' | 'tool_container';
  readonly selector: string;
  readonly description: string;
  readonly metadata_only_list: boolean;
  readonly tool_id?: string;
  /** What the source can do (research tool contract v1). A source without it is described only in prose. */
  readonly capabilities?: EvidenceSourceCapabilitiesV1;
}
/**
 * A request-bound source a desk advertises: a connected tool, ECHO's
 * follow-ups (ADR-0040), or a workspace source (research tool contract v1).
 * The last two have no tool of their own.
 */
export type EvidenceDeskLiveSourceV2 = PersonLiveSourceDescriptorV2 | FollowUpsSourceDescriptorV1 | WorkspaceSourceDescriptorV1;

/** The source of an item, from its kind. */
export function evidenceDeskSourceV2(item: { readonly kind: EvidenceDeskKindV2; readonly source_id?: string; readonly ref?: string }): EvidenceDeskSourceV2 {
  if (item.source_id !== undefined) return item.source_id;
  if (item.kind === 'ticket') return 'ticket';
  if (item.kind === 'page') return 'page';
  if (item.kind === 'follow_up') return FOLLOW_UPS_SOURCE_ID_V1;
  if (item.kind === 'project') return 'projects';
  if (item.kind === 'person') return 'people';
  if (item.kind === 'tool') return 'tools';
  // A tool container's source is its connector's, which the dispatcher always attaches.
  if (item.kind === 'tool_container') return 'tool_container';
  return evidenceDeskSourceV1(item as { kind: EvidenceDeskKindV1; ref?: string });
}

export interface EvidenceDeskItemV2 extends Omit<EvidenceDeskItemV1, 'citation' | 'kind' | 'ref'> {
  /** A workspace item (research tool contract v1) cites with a workspace citation, which only the V8 answer admits. */
  readonly citation: PersonAnswerEvidenceCitationV7 | PersonWorkspaceCitationV1;
  readonly kind: EvidenceDeskKindV2;
  /** Server-owned ref for person open, a follow-up's item page, or a project or tool (V8). Never shown to a model. */
  readonly ref?: PersonAnswerOpenRefV8;
  /** Request-local owner, attached by the dispatcher and never part of a citation. */
  readonly source_id?: string;
  /**
   * Named links to other items (research tool contract v1): for each link name its source declares, the desk ids of the
   * linked items. Every id is an item this request's desk has released, in this result's `items` or `linked` or before,
   * so research can open it. A link to something the asker cannot read is left out, never shown as hidden.
   */
  readonly links?: Readonly<Record<string, readonly string[]>>;
}

export interface EvidenceDeskResultV2 extends Omit<EvidenceDeskResultV1, 'items'> {
  readonly items: readonly EvidenceDeskItemV2[];
  /**
   * Items released beside the result because its items link to them (research tool contract v1): metadata, and text
   * where the source holds it whole. They are never rows of the read itself, so never list members or search hits.
   */
  readonly linked?: readonly EvidenceDeskItemV2[];
  /** A dated read's items the date filter could not test (research tool contract v1); it replaces a missing-date notice. */
  readonly unchecked?: EvidenceDeskUncheckedV1;
}

/** Ticket inventory items carry no text, like meeting and document items. */
export interface EvidenceDeskListInputV2 extends Omit<EvidenceDeskListInputV1, 'source' | 'kinds'> {
  readonly source: EvidenceDeskSourceV2;
  readonly kinds?: readonly EvidenceDeskKindV2[];
  /**
   * Applied before anything is released or read live. The research loop sends
   * owner, status and role only to a source whose capabilities take them
   * (research tool contract v1). Follow-ups match the owner's display name as
   * `followUpOwnerMatchesV1` matches it (ADR-0040).
   */
  readonly owner?: string;
  /** Follow-ups take `open` (the item is open) or `done` (it is done); projects take `active` or `archived`. */
  readonly status?: FollowUpListStatusV1 | ProjectListStatusV1;
  /** Projects: the asker's role in a project. */
  readonly role?: ProjectListRoleV1;
}

export interface EvidenceDeskPortV2 extends Omit<EvidenceDeskPortV1, 'search' | 'open' | 'list'> {
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
