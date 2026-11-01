import type { EvidenceDeskUncheckedV1 } from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v2";
import type { EvidenceDateFilterV1, EvidenceDatesV1 } from "@echo-brain/organization-authority-kernel/shared/temporal-query-v1";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonItemRefV1 } from "@echo-brain/organization-api";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";

/** The caller-selected boundary; global is still limited to the actor's ACL. */
export type PersonAskScopeV2 =
  | Readonly<{ readonly kind: "global" }>
  | Readonly<{ readonly kind: "project"; readonly project_id: string }>;

interface OriginalContextAuthorizationV1 {
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
  /** The caller's own project grants at release; the desk's checks pin it (ADR-0038). */
  readonly grants_sha256: Sha256Digest;
  readonly released_atoms: readonly ReleasedSourceContextAtomV1[];
}

/**
 * Layer-3 port for immutable Person-upload originals. Implementations release
 * only content that is readable at retrieval time and revalidate every atom
 * before Layer 4 can return an answer.
 */
export interface PersonOriginalContextRetrievalPortV1 {
  revalidate(input: {
    readonly access_token: string;
    readonly release: OriginalContextReleaseV1;
  }): { readonly checked_at: string };
  read(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: OriginalContextCitationV1;
  }): { readonly scope: PersonAskScopeV2; readonly atom: ReleasedSourceContextAtomV1 };
}

/** Desk-only, request-bound original evidence release.  Callers of the
 * PersonOriginalContextRetrievalPortV1 cannot invoke these methods. */
type OriginalContextDeskKindV1 = "note" | "document_passage" | "imported_meeting";
type OriginalContextDeskVisibilityV1 = "only_me" | "team" | "project" | "projects";

export interface OriginalContextDeskItemV1 {
  readonly dates?: EvidenceDatesV1;
  readonly citation: OriginalContextCitationV1;
  readonly kind: OriginalContextDeskKindV1;
  readonly text?: string;
  readonly visibility: OriginalContextDeskVisibilityV1;
  readonly label: string;
  readonly received_at: string;
  readonly version: string;
  /** The note, document or imported meeting this passage opens as (ADR-0024). */
  readonly ref?: PersonItemRefV1;
}

export interface OriginalContextDeskReleaseV1 {
  readonly release: OriginalContextReleaseV1;
  readonly receipt: Sha256Digest;
  readonly items: readonly OriginalContextDeskItemV1[];
  readonly truncated: boolean;
  /**
   * A dated read's items its date filter could not test, because they do not record that date, and the dates they do
   * record (research tool contract v1). They are not in `items`. Audited with the release.
   */
  readonly unchecked?: EvidenceDeskUncheckedV1;
}

/** What a desk read leaves out before its limit: sources by id, and every item only its reader may see. */
export interface OriginalContextDeskExclusionV1 {
  readonly source_ids: readonly string[];
  readonly only_me: boolean;
}

export interface PersonOriginalContextEvidenceDeskPortV1 extends PersonOriginalContextRetrievalPortV1 {
  /** Authenticates the request-bound desk before its first model call. */
  deskAuthorize(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
  }): { readonly checked_at: string };
  deskSearch(input: EvidenceDateFilterV1 & {
    readonly source?: "meeting" | "document";
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly query?: string;
    readonly kinds?: readonly OriginalContextDeskKindV1[];
    readonly limit?: number;
    readonly exclude?: OriginalContextDeskExclusionV1;
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
    /**
     * The request's desk already checked this release's items (an incremental
     * check, ADR-0038): recheck only the session, identity, scope and the
     * caller's grants pin, not each item. An implementation may ignore it and
     * check everything.
     */
    readonly items_checked?: true;
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
