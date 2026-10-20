import type { EvidenceDateFilterV1, EvidenceDatesV1 } from "./temporal-query-v1.js";
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { EvidenceDeskAttributesV1, EvidenceDeskDateKindV1, EvidenceDeskRevalidationModeV1 } from './evidence-desk-v1.js';
import type { PersonConnectorAccessV1, PersonPageCitationV1, PersonSlackMessageCitationV1, PersonTicketCitationV1, PersonToolContainerCitationV1 } from '@echo-brain/organization-api';

/**
 * A tool container (research tool contract v1) is a Jira project, Confluence space or Slack channel. Its citation names
 * the container and commits to no text: what it says is read again wherever it is shown.
 */
export type PersonLiveEvidenceCitationV1 = PersonSlackMessageCitationV1 | PersonTicketCitationV1 | PersonPageCitationV1 | PersonToolContainerCitationV1;
/** A live item's row facts: a tool item's owner, due date and status, and a tool container's key and tool. */
export type PersonLiveEvidenceAttributesV1 = Pick<EvidenceDeskAttributesV1, 'owner' | 'due_at' | 'status' | 'key' | 'tool'>;

/** Trusted construction input. Neither an OAuth claim nor a model argument can supply this binding. */
export interface PersonConnectorReadBindingV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly tool_id: string;
  readonly external_scope_id: string | null;
  readonly external_subject_id: string;
  /** ECHO's immutable grant commitment; reconnecting/replacing the grant invalidates an old request. */
  readonly read_grant_sha256: Sha256Digest;
}

export interface PersonConnectorReadAuthorizationV1 {
  /** Checks current ECHO membership, identity link, grant commitment and live_evidence permission synchronously. No provider I/O or asynchronous work is permitted. */
  assertCurrent(binding: PersonConnectorReadBindingV1): void;
}

/** Provider-normalized data, kept only in request memory. Provider wire parsing and tenant URL validation stay with the provider. */
export interface PersonLiveEvidenceValueV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly citation: C;
  /** Provider-owned open handle; never sent to a model or included in an audit. */
  readonly handle: string;
  readonly label: string;
  /** Omitted for an inventory result. */
  readonly text?: string;
  readonly visibility: 'only_me' | 'team';
  readonly attributes?: PersonLiveEvidenceAttributesV1;
  readonly occurred_at?: string;
  readonly date_kind?: EvidenceDeskDateKindV1;
  readonly dates?: EvidenceDatesV1;
}

export interface PersonLiveEvidencePageV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly items: readonly PersonLiveEvidenceValueV1<C>[];
  readonly truncated: boolean;
  /** Provider-owned list continuation, kept inside the request. */
  readonly next_cursor?: string;
  /** Bounded adapter-authored availability or representation notice, never a raw provider error. */
  readonly notice?: string;
  /** List only: the raw vendor page, before the adapter's own filtering, held its full page size (ADR-0041). */
  readonly page_full?: boolean;
  /** Open only: the opened item's own text was cut; `truncated` also covers what came beside it (ADR-0041). Absent: unknown. */
  readonly anchor_truncated?: boolean;
}

export interface PersonLiveEvidenceListInputV1 extends EvidenceDateFilterV1 {
  /** A provider-scoped collection selector, never a connection id or fetch URL. */
  readonly container?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** Created by provider composition for exactly this person's read binding. No method accepts credentials or another actor. */
export interface PersonLiveEvidenceCoordinatesV1 { readonly object_id: string; readonly container_id?: string }

/** Search/list must apply requested temporal bounds or refuse unsupported fields; never silently ignore them. */
export interface PersonLiveEvidenceReaderV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly binding: PersonConnectorReadBindingV1;
  /** Adapter validates its citation and supplies neutral boundary coordinates. */
  validateCitation(value: unknown): { readonly citation: C; readonly tool_id: string; readonly external_scope_id: string | null; readonly coordinates: PersonLiveEvidenceCoordinatesV1 };
  search(input: EvidenceDateFilterV1 & { readonly query: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidencePageV1<C>>;
  open(input: { readonly handle: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidencePageV1<C>>;
  /**
   * Re-reads the current item a citation released earlier names, applying the
   * same tool, tenant, project/space pin and permission checks as an exact read.
   * The adapter validates the citation's shape itself: it was issued by another
   * request, so `validateCitation` cannot vouch for it.
   */
  openCitation?(input: { readonly citation: unknown; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidencePageV1<C>>;
  list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<C>>;
  /**
   * Checks the provider connection AND current visibility of every given item, including inventory metadata. Token validity alone is insufficient.
   * `full` (the default) carries every item released so far. `incremental` carries only the items released since the
   * caller's last successful check, possibly none; the reader then verifies its connection once, after those reads.
   */
  revalidate(input: { readonly citations: readonly C[]; readonly signal?: AbortSignal; readonly mode?: EvidenceDeskRevalidationModeV1 }): Promise<void>;
}

/** Audit coordinates/digests only. Empty and metadata-only reads also commit a receipt. */
export interface PersonLiveEvidenceReleaseV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly schema_version: 1;
  readonly binding: PersonConnectorReadBindingV1;
  readonly operation: 'search' | 'open' | 'list';
  readonly coordinates: readonly PersonLiveEvidenceCoordinatesV1[];
  /** Commits all normalized released fields, including inventory metadata, without retaining their bytes. */
  readonly value_digests: readonly Sha256Digest[];
  readonly citations: readonly C[];
}

export interface PersonLiveEvidenceAuditV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  record(release: PersonLiveEvidenceReleaseV1<C>): Promise<Sha256Digest>;
}

/** The model-visible result has no provider handle, connection reference, or credential. */
export interface PersonLiveEvidenceItemV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly id: string;
  readonly kind: C['kind'];
  readonly citation: C;
  readonly label: string;
  readonly text?: string;
  readonly visibility: 'only_me' | 'team';
  readonly attributes?: PersonLiveEvidenceAttributesV1;
  readonly occurred_at?: string;
  readonly date_kind?: EvidenceDeskDateKindV1;
  readonly dates?: EvidenceDatesV1;
  readonly receipt_sha256: Sha256Digest;
}

export interface PersonLiveEvidenceResultV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly items: readonly PersonLiveEvidenceItemV1<C>[];
  readonly truncated: boolean;
  readonly receipt_digests: readonly Sha256Digest[];
  /** Request-owned continuation; provider cursors never leave the adapter. */
  readonly next_cursor?: string;
  /** A bounded reader notice released with the request result but never written to the audit. */
  readonly notice?: string;
  /** List only: the reader's `page_full`, passed through unchanged. */
  readonly page_full?: boolean;
  /** Open only: the reader's `anchor_truncated`, passed through unchanged. */
  readonly anchor_truncated?: boolean;
}

/** Internal source seam for the V2 evidence desk dispatcher; the V1 desk and Ask V4 schemas still accept only their existing kinds. */
export interface PersonLiveEvidenceSourceV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly tool_id: string;
  search(input: EvidenceDateFilterV1 & { readonly query: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceResultV1<C>>;
  open(input: { readonly item: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceResultV1<C>>;
  /** Opens a citation released by an earlier request (background trigger starting evidence). */
  openCitation?(input: { readonly citation: unknown; readonly limit?: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceResultV1<C>>;
  list(input: Omit<PersonLiveEvidenceListInputV1, 'limit'> & { readonly limit?: number }): Promise<PersonLiveEvidenceResultV1<C>>;
  /**
   * Required before every subsequent model call and final response containing any released evidence.
   * `incremental` re-reads only items released since this source's last successful check; the local
   * grant and the provider connection are checked on every call either way.
   */
  revalidate(input: { readonly signal?: AbortSignal; readonly mode?: EvidenceDeskRevalidationModeV1 }): Promise<void>;
  /** Rechecks the pinned local grant synchronously after all sources have finished provider I/O. */
  assertCurrent(): void;
}

export interface CreatePersonLiveEvidenceSourceV1Options<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly actor: Pick<PersonConnectorReadBindingV1, 'organization_id' | 'principal_id' | 'membership_id'>;
  readonly access: PersonConnectorAccessV1;
  readonly read_grant_sha256: Sha256Digest;
  readonly authorization: PersonConnectorReadAuthorizationV1;
  readonly reader: PersonLiveEvidenceReaderV1<C>;
  readonly audit: PersonLiveEvidenceAuditV1<C>;
}
