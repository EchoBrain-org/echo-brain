import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonConnectorAccessV1, PersonEvidenceAttributesV1, PersonSlackMessageCitationV1, PersonTicketCitationV1 } from '@echo-brain/organization-api';

export type PersonLiveEvidenceCitationV1 = PersonSlackMessageCitationV1 | PersonTicketCitationV1;

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
  readonly attributes?: PersonEvidenceAttributesV1;
  readonly occurred_at?: string;
}

export interface PersonLiveEvidencePageV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly items: readonly PersonLiveEvidenceValueV1<C>[];
  readonly truncated: boolean;
  /** Provider-owned list continuation, kept inside the request. */
  readonly next_cursor?: string;
}

export interface PersonLiveEvidenceListInputV1 {
  /** A channel name or ticket project understood by the provider, never a connection id or fetch URL. */
  readonly container?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** Created by provider composition for exactly this person's read binding. No method accepts credentials or another actor. */
export interface PersonLiveEvidenceCoordinatesV1 { readonly object_id: string; readonly container_id?: string }

export interface PersonLiveEvidenceReaderV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly binding: PersonConnectorReadBindingV1;
  /** Adapter validates its citation and supplies neutral boundary coordinates. */
  validateCitation(value: unknown): { readonly citation: C; readonly tool_id: string; readonly external_scope_id: string | null; readonly coordinates: PersonLiveEvidenceCoordinatesV1 };
  search(input: { readonly query: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidencePageV1<C>>;
  open(input: { readonly handle: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidencePageV1<C>>;
  list(input: PersonLiveEvidenceListInputV1): Promise<PersonLiveEvidencePageV1<C>>;
  /** Checks the provider connection AND current visibility of every released item, including inventory metadata. Token validity alone is insufficient. */
  revalidate(input: { readonly citations: readonly C[]; readonly signal?: AbortSignal }): Promise<void>;
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
  readonly attributes?: PersonEvidenceAttributesV1;
  readonly occurred_at?: string;
  readonly receipt_sha256: Sha256Digest;
}

export interface PersonLiveEvidenceResultV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly items: readonly PersonLiveEvidenceItemV1<C>[];
  readonly truncated: boolean;
  readonly receipt_digests: readonly Sha256Digest[];
  /** Request-owned continuation; provider cursors never leave the adapter. */
  readonly next_cursor?: string;
}

/** Internal source seam for the V2 evidence desk dispatcher; the V1 desk and Ask V4 schemas still accept only their existing kinds. */
export interface PersonLiveEvidenceSourceV1<C extends PersonLiveEvidenceCitationV1 = PersonLiveEvidenceCitationV1> {
  readonly tool_id: string;
  search(input: { readonly query: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceResultV1<C>>;
  open(input: { readonly item: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceResultV1<C>>;
  list(input: Omit<PersonLiveEvidenceListInputV1, 'limit'> & { readonly limit?: number }): Promise<PersonLiveEvidenceResultV1<C>>;
  /** Required before every subsequent model call and final response containing any released evidence. */
  revalidate(input: { readonly signal?: AbortSignal }): Promise<void>;
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
