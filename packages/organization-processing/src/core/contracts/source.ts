import type { AdapterIdentity } from "./adapter.js";

export const SOURCE_SCHEMA_VERSION_V1 = 1 as const;

/** meeting-source remains accepted while existing providers use the bridge. */
export type SourceAdapterIdentityV1 = AdapterIdentity & {
  readonly kind: "source" | "meeting-source";
};

/**
 * Identity supplied by a source adapter. Organization, custody and audience are
 * bound separately by Authority; an adapter cannot grant access through data.
 * The stable key excludes adapter.version, which describes this observation.
 */
export interface SourceItemV1 {
  readonly schema_version: typeof SOURCE_SCHEMA_VERSION_V1;
  readonly source_id: string;
  readonly adapter: SourceAdapterIdentityV1;
  readonly external_id: string;
}

export interface SourceArtifactReferenceV1 {
  readonly artifact_id: string;
  readonly media_type: string;
  /** SHA-256 of the original bytes, lower-case hex without a prefix. */
  readonly sha256: string;
  readonly byte_length: number;
}

export interface SourceRepresentationReferenceV1 {
  readonly representation_id: string;
  readonly media_type: string;
  readonly schema_version: number;
  readonly processor_version: string;
  readonly sha256: string;
}

/** A captured revision is immutable; richer derived content gets its own ref. */
export interface SourceRevisionV1 {
  readonly schema_version: typeof SOURCE_SCHEMA_VERSION_V1;
  readonly source_id: string;
  readonly revision_id: string;
  readonly captured_at: string;
  /** Digest of canonical typed content, distinct from original artifact bytes. */
  readonly content_sha256: string;
  readonly artifact_refs: readonly SourceArtifactReferenceV1[];
  readonly representation_refs: readonly SourceRepresentationReferenceV1[];
  readonly previous_revision_id?: string;
  /** Accepted contributor provenance; never a continuing processing credential. */
  readonly contributor?: {
    readonly principal_id: string;
    readonly membership_id: string;
  };
}

/** Content is a versioned domain value or descriptor, never provider credentials. */
export interface SourceEnvelopeV1<TContent = unknown> {
  readonly item: SourceItemV1;
  readonly revision: SourceRevisionV1;
  readonly content: TContent;
}

export interface SourcePullRequestV1 {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SourceBatchV1<TContent = unknown> {
  readonly sources: readonly SourceEnvelopeV1<TContent>[];
  readonly next_cursor?: string;
}

/**
 * Trusted Authority bindings, resolved from accepted commands/admissions. These
 * are references to current policy, not frozen reader lists or adapter claims.
 */
export interface SourceAdmissionScopeV1 {
  readonly organization_id: string;
  readonly custody_ref: string;
  readonly access_policy_ref: string;
  readonly analysis_policy: "on_request" | "automatic";
}
