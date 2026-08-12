import type { Sha256Digest } from '@echo-brain/federation-protocol';

export const READABLE_SEARCH_ANALYZER_ID =
  'echo-unicode-alnum-frequency-v1' as const;
export const READABLE_SEARCH_CONTRACT_ID =
  'permission-aware-readable-search-v1' as const;
export const ORGANIZATION_MEMBER_POLICY_ID =
  'organization-member-readable-v1' as const;
export const RESTRICTED_REVIEWER_POLICY_ID =
  'restricted-reviewer-v1' as const;

export type ReadableSearchPolicyId =
  | typeof ORGANIZATION_MEMBER_POLICY_ID
  | typeof RESTRICTED_REVIEWER_POLICY_ID;
export type ReadableSearchSegmentKind = 'organization-member' | 'reviewer';
export type ReadableSearchPlane = 'facts' | 'lexical' | 'content';
export type ReadableSearchItemKind = 'decision' | 'action' | 'rationale';

export interface ReadableSearchSegmentIdentity {
  readonly organization_id: string;
  readonly segment_id: Sha256Digest;
  readonly segment_kind: ReadableSearchSegmentKind;
  readonly policy_id: ReadableSearchPolicyId;
  readonly policy_contract_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
}

export interface RetrievalPermissionFact {
  readonly atom_id: Sha256Digest;
  readonly organization_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: ReadableSearchItemKind;
  readonly policy_id: ReadableSearchPolicyId;
  readonly policy_contract_sha256: Sha256Digest;
  readonly approval_actor_principal_id: string;
  readonly approval_actor_membership_id: string;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly semantic_intent_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly evaluated_at: string;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

export interface RetrievalContentAtom {
  readonly atom_id: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_order: number;
  readonly item_kind: ReadableSearchItemKind;
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

export interface RetrievalLexicalDocument {
  readonly atom_id: Sha256Digest;
  readonly log_position: number;
  readonly atom_order: number;
  readonly content_binding_sha256: Sha256Digest;
}

export interface RetrievalTermPosting {
  readonly term: string;
  readonly atom_id: Sha256Digest;
  readonly term_frequency: number;
}

export interface ReadableSearchSegmentManifest {
  readonly schema_version: 1;
  readonly kind: 'readable-search-segment-manifest-v1';
  readonly organization_id: string;
  readonly segment_id: Sha256Digest;
  readonly segment_kind: ReadableSearchSegmentKind;
  readonly policy_id: ReadableSearchPolicyId;
  readonly policy_contract_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly analyzer_id: typeof READABLE_SEARCH_ANALYZER_ID;
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly facts_root: Sha256Digest;
  readonly content_root: Sha256Digest;
  readonly lexical_root: Sha256Digest;
  readonly fact_count: number;
  readonly content_count: number;
  readonly document_count: number;
  readonly posting_count: number;
}

export interface ReadableSearchGenerationManifest {
  readonly schema_version: 1;
  readonly kind: 'readable-search-generation-manifest-v1';
  readonly organization_id: string;
  readonly generation_id: Sha256Digest;
  readonly retrieval_contract_id: typeof READABLE_SEARCH_CONTRACT_ID;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly source_revision: string;
  readonly builder_artifact_sha256: Sha256Digest;
  readonly input_contract_version: 1;
  readonly policies: readonly {
    readonly policy_id: ReadableSearchPolicyId;
    readonly policy_contract_sha256: Sha256Digest;
  }[];
  readonly record_head: ReadableSearchRecordHead;
  readonly input_cursor: ReadableSearchRecordHead;
  readonly upstream_input_root: Sha256Digest;
  readonly roots: ReadableSearchGenerationRoots;
  readonly segments: readonly ReadableSearchGenerationSegment[];
  readonly analyzer: ReadableSearchAnalyzerDescriptor;
  readonly index: { readonly format_version: 1; readonly sqlite_version: string };
}

export interface ReadableSearchRecordHead {
  readonly position: number;
  readonly record_hash: Sha256Digest | null;
}

export interface ReadableSearchGenerationRoots {
  readonly facts_root: Sha256Digest;
  readonly content_root: Sha256Digest;
  readonly lexical_root: Sha256Digest;
}

export interface ReadableSearchGenerationSegment {
  readonly segment_id: Sha256Digest;
  readonly segment_manifest_sha256: Sha256Digest;
  readonly facts_root: Sha256Digest;
  readonly content_root: Sha256Digest;
  readonly lexical_root: Sha256Digest;
}

export interface ReadableSearchAnalyzerDescriptor {
  readonly analyzer_id: typeof READABLE_SEARCH_ANALYZER_ID;
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly analyzer_source_sha256: Sha256Digest;
  readonly node_version: string;
  readonly unicode_version: string;
  readonly icu_version: string;
}

export interface ReadableSearchPlaneMetadata extends ReadableSearchSegmentIdentity {
  readonly schema_version: 1;
  readonly plane: ReadableSearchPlane;
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly finalized: boolean;
}

/**
 * The retrieval build's only input row. Its producer has already admitted and
 * frozen the Layer 1 facts; this workspace neither opens nor imports Layer 1.
 */
export interface ReadableSearchAdmittedAtom {
  readonly fact: RetrievalPermissionFact;
  readonly text: string;
  readonly text_sha256: Sha256Digest;
}

export interface ReadableSearchStoppedBuildInput {
  readonly state_directory: string;
  readonly organization_id: string;
  readonly record_head: ReadableSearchRecordHead;
  readonly upstream_input_root: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
  readonly analyzer: ReadableSearchAnalyzerDescriptor;
  readonly source_revision: string;
  readonly builder_artifact_sha256: Sha256Digest;
  readonly sqlite_version: string;
  readonly atoms: readonly ReadableSearchAdmittedAtom[];
}

export interface ReadableSearchAdmittedGeneration {
  readonly generation_directory: string;
  readonly manifest: ReadableSearchGenerationManifest;
  readonly manifest_sha256: Sha256Digest;
}

export interface ReadableSearchGenerationAdmissionInput {
  readonly state_directory: string;
  readonly organization_id: string;
  readonly record_head: ReadableSearchRecordHead;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly analyzer: ReadableSearchAnalyzerDescriptor;
}

export interface ReadableSearchScopeInput {
  readonly request_sha256: Sha256Digest;
  readonly caller_binding_sha256: Sha256Digest;
  /** Authority-precomputed exact segment IDs, limited to the two V1 paths. */
  readonly admitted_segment_ids: readonly Sha256Digest[];
}

export interface ReadableSearchResultItem {
  readonly kind: ReadableSearchItemKind;
  readonly text: string;
  readonly policy_id: ReadableSearchPolicyId;
}

export class ReadableSearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadableSearchValidationError';
  }
}
