import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import type { ProjectUploadEnrichmentSnapshotV1 } from './project-context-v1.js';

/** Immutable V2 source plus its durable optional-enrichment work row. */
export interface PersonUpdateEnrichmentWorkItemV2 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly context_id: string;
  readonly request_id: string;
  readonly payload_sha256: Sha256Digest;
  readonly title: string;
  readonly text: string;
  readonly audience_kind: 'only_me' | 'team' | 'project';
  readonly audience_project_id: string | null;
  readonly project_id: string | null;
  readonly received_at: string;
  readonly state: 'pending' | 'processing' | 'ready' | 'unavailable';
  readonly search_hints: string;
  readonly enrichment_sha256: Sha256Digest | null;
  readonly attempts: number;
}

/**
 * V2 uses the existing serialized Person-upload worker. The adapter owns
 * durable claim/retry and the atomic final eligibility check plus hint write.
 */
export interface PersonUpdateEnrichmentWorkV2 {
  claim(): PersonUpdateEnrichmentWorkItemV2 | undefined;
  validate(item: PersonUpdateEnrichmentWorkItemV2): PersonUpdateSubmitV2;
  captureEligibility(item: PersonUpdateEnrichmentWorkItemV2): ProjectUploadEnrichmentSnapshotV1 | undefined;
  enriched(item: PersonUpdateEnrichmentWorkItemV2, eligibility: ProjectUploadEnrichmentSnapshotV1, searchHints: string, release: Sha256Digest): void;
  defer(item: PersonUpdateEnrichmentWorkItemV2, retry?: boolean): void;
}
