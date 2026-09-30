import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonMeetingTranscriptCitationV1, PersonOpenRefV1 } from "@echo-brain/organization-api";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";

/**
 * The caller-selected boundary; global is still limited to the actor's ACL.
 * mine = added by the caller (membership_id AND principal_id); always ⊆ global.
 */
export type PersonAskScopeV2 =
  | Readonly<{ readonly kind: "global" }>
  | Readonly<{ readonly kind: "project"; readonly project_id: string }>
  | Readonly<{ readonly kind: "mine" }>;

export interface OriginalContextAuthorizationV1 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly session_family_id: string;
  readonly checked_at: string;
}

/**
 * A request-local release. The adapter must treat object identity as its
 * capability: only the originating adapter may revalidate it.
 */
export interface OriginalContextReleaseV1 {
  readonly authorization: OriginalContextAuthorizationV1;
  readonly scope: PersonAskScopeV2;
  readonly authorization_revision: number;
  readonly released_atoms: readonly ReleasedSourceContextAtomV1[];
}

export interface OriginalContextRetrievalResultV1 {
  readonly release: OriginalContextReleaseV1;
  /** Digest of the content-free Layer-3 release audit committed before bytes return. */
  readonly receipt: Sha256Digest;
  /** One count for every requested query, before cross-query deduplication. */
  readonly query_hit_counts: readonly number[];
}

/**
 * Structural view of the record package's immutable witness. It contains no
 * source bytes; Authority applies its policy inside the current authorization
 * fence before opening existing source custody.
 */
export interface ApprovedMeetingTranscriptGrantV1 {
  readonly approval_id: string;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly policy_id:
    | "restricted-reviewer-person-v2"
    | "organization-member-readable-person-v2"
    | "project-members-readable-person-v1";
  readonly policy_contract_sha256: Sha256Digest;
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
}

export interface ApprovedMeetingTranscriptGrantReaderV1 {
  find(input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly approval_id: string;
  }): ApprovedMeetingTranscriptGrantV1 | null;
  /**
   * Every grant in the lineage, or those for one exact source revision. Ask
   * searches only transcripts it can list; without it, transcripts stay out.
   */
  list?(input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly source_id?: string;
    readonly revision_id?: string;
    readonly source_sha256?: Sha256Digest;
  }): readonly ApprovedMeetingTranscriptGrantV1[];
}

export interface ApprovedMeetingTranscriptReadV1 {
  readonly scope: PersonAskScopeV2;
  readonly citation: PersonMeetingTranscriptCitationV1;
  readonly text: string;
  readonly next_offset: number | null;
}

/**
 * Layer-3 port for immutable Person-upload originals. Implementations release
 * only content that is readable at retrieval time and revalidate every atom
 * before Layer 4 can return an answer.
 */
export interface PersonOriginalContextRetrievalPortV1 {
  retrieve(input: {
    readonly access_token: string;
    readonly queries: readonly string[];
    readonly scope: PersonAskScopeV2;
    /** Called only after the actor and requested scope have been authorized. */
    readonly on_authorized?: () => void;
  }): OriginalContextRetrievalResultV1;
  revalidate(input: {
    readonly access_token: string;
    readonly release: OriginalContextReleaseV1;
  }): { readonly checked_at: string };
  read(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: OriginalContextCitationV1;
  }): { readonly scope: PersonAskScopeV2; readonly atom: ReleasedSourceContextAtomV1 };
  /**
   * Explicit, approved, page-bounded raw-meeting release. This does not add
   * meetings to `retrieve`, so Ask remains unable to discover transcripts.
   */
  readApprovedMeetingTranscript(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: PersonMeetingTranscriptCitationV1;
    readonly offset?: number;
  }): ApprovedMeetingTranscriptReadV1;
}

/** Desk-only, request-bound original evidence release.  Callers of the
 * single-batch PersonOriginalContextRetrievalPortV1 cannot invoke these methods. */
export type OriginalContextDeskKindV1 = "note" | "document_passage";
export type OriginalContextDeskVisibilityV1 = "only_me" | "team" | "project" | "projects";

export interface OriginalContextDeskItemV1 {
  readonly citation: OriginalContextCitationV1;
  readonly kind: OriginalContextDeskKindV1;
  readonly text?: string;
  readonly visibility: OriginalContextDeskVisibilityV1;
  readonly label: string;
  readonly received_at: string;
  readonly version: string;
  /** The note, document or shared transcript this passage opens as (ADR-0023). */
  readonly ref?: PersonOpenRefV1;
}

export interface OriginalContextDeskReleaseV1 {
  readonly release: OriginalContextReleaseV1;
  readonly receipt: Sha256Digest;
  readonly items: readonly OriginalContextDeskItemV1[];
  readonly truncated: boolean;
}

export interface PersonOriginalContextEvidenceDeskPortV1 extends PersonOriginalContextRetrievalPortV1 {
  /** Authenticates the request-bound desk before its first model call. */
  deskAuthorize(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
  }): { readonly checked_at: string };
  deskSearch(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly query?: string;
    readonly kinds?: readonly OriginalContextDeskKindV1[];
    readonly limit?: number;
    /** Server-internal complete passage inventory, valid only without a query. */
    readonly inventory_mode?: "items";
  }): OriginalContextDeskReleaseV1;
  deskOpen(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: OriginalContextCitationV1;
    readonly neighbours?: number;
  }): OriginalContextDeskReleaseV1;
  revalidateDeskRelease(input: {
    readonly access_token: string;
    readonly release: OriginalContextDeskReleaseV1;
  }): { readonly checked_at: string };
}

/** A source citation omits evidence text and presentation-only labels. */
export interface OriginalContextCitationV1 {
  readonly kind: "source_revision";
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly representation_sha256: Sha256Digest;
  readonly anchor_sha256: Sha256Digest;
  readonly document_id?: string;
}
