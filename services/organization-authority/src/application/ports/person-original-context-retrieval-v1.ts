import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";

/** The caller-selected boundary; global is still limited to the actor's ACL. */
export type PersonAskScopeV2 =
  | Readonly<{ readonly kind: "global" }>
  | Readonly<{ readonly kind: "project"; readonly project_id: string }>;

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
  /** One count for every requested query, before cross-query deduplication. */
  readonly query_hit_counts: readonly number[];
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
}

/** Audit-safe identity digest for a combined original/record release. */
export interface OriginalContextReleaseAuditV1 {
  readonly scope: PersonAskScopeV2;
  readonly authorization_revision: number;
  readonly released_atoms_sha256: Sha256Digest;
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
