import type {
  ActionSignal,
  AdapterIdentity,
  DecisionSignal,
  JsonObject,
  JsonValue,
  MeetingParticipant,
  MeetingTime,
  RationaleSignal,
} from '../../core/index.js';

export type Sha256Digest = `sha256:${string}`;
export type FederationId = string;

export type IdentityAssurance =
  | 'founder_attested'
  | 'authority_preprovisioned'
  | 'provider_challenge_observed'
  | 'provider_verified'
  | 'credential_observed'
  | 'operator_attested'
  | 'installation_holder_self_attested';

export type KeyProtection =
  'secure-enclave' | 'keychain-this-device-only' | 'development-file';
export type KeyProtectionAssurance =
  | 'hardware_bound'
  | 'platform_key_device_only'
  | 'software_key_development_only';

export interface SignedIntegrity {
  canonicalization: 'RFC8785';
  payload_sha256: Sha256Digest;
  signature_algorithm: 'ecdsa-p256-sha256-der-low-s';
  key_id: Sha256Digest;
  signature_base64: string;
}

export interface SignedDocument {
  integrity: SignedIntegrity;
}

export interface BundleDocumentReference {
  path: string;
  sha256: Sha256Digest;
}

export interface ActiveIdentityBundleV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-active-identity-bundle';
  manifest: BundleDocumentReference & { manifest_id: FederationId };
  connection_registry: BundleDocumentReference & {
    registry_id: FederationId;
    revision: number;
  };
  default_publication_policy: BundleDocumentReference & {
    policy_id: FederationId;
    version: number;
  };
  active_installation_id: FederationId;
  activated_at: string;
  activation_reason:
    'founder-bootstrap' | 'installation-reenrollment' | 'bundle-update';
}

export interface OrganizationIdentityV1 {
  organization_id: FederationId;
  display_name: string;
  created_at: string;
}

export interface PrincipalIdentityV1 {
  principal_id: FederationId;
  organization_id: FederationId;
  kind: 'human';
  display_name: string;
}

export interface MembershipIdentityV1 {
  membership_id: FederationId;
  organization_id: FederationId;
  principal_id: FederationId;
  type: 'owner' | 'employee' | 'contractor';
  status: 'active';
  valid_from: string;
}

export interface InstallationSigningKeyV1 {
  key_id: Sha256Digest;
  algorithm: 'ecdsa-p256-sha256-der-low-s';
  public_key_spki_der_base64: string;
  protection: KeyProtection;
  assurance: KeyProtectionAssurance;
}

export interface InstallationIdentityV1 {
  installation_id: FederationId;
  organization_id: FederationId;
  membership_id: FederationId;
  device_id: FederationId;
  device_class: 'byod' | 'managed';
  enrolled_at: string;
  product: {
    name: 'echo-brain';
    version: string;
    source_sha: string;
  };
  signing_key: InstallationSigningKeyV1;
}

export type IdentityClaimIssuerV1 =
  | {
      kind: 'provider';
      provider: string;
      tenant_id: string;
    }
  | {
      kind: 'oidc';
      issuer_uri: string;
    };

export interface IdentityClaimV1 {
  claim_id: FederationId;
  principal_id: FederationId;
  issuer: IdentityClaimIssuerV1;
  subject: { kind: 'user' | 'oidc_sub'; id: string };
  verification: {
    method: 'slack_dm_challenge' | 'email_magic_link' | 'oidc_id_token';
    assurance: 'provider_challenge_observed' | 'provider_verified';
    verified_at: string;
    evidence_sha256: Sha256Digest;
    audience?: string;
    authentication_time?: string;
    nonce_sha256?: Sha256Digest;
  };
}

export interface LocalIdentityManifestV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-local-identity-manifest';
  manifest_id: FederationId;
  predecessor_manifest_id: FederationId | null;
  created_at: string;
  authority:
    | {
        kind: 'local-founder-bootstrap';
        assurance: 'founder_attested';
      }
    | {
        kind: 'organization-authority-enrollment';
        assurance: 'authority_preprovisioned';
      };
  organization: OrganizationIdentityV1;
  principal: PrincipalIdentityV1;
  membership: MembershipIdentityV1;
  installation: InstallationIdentityV1;
  identity_claims: readonly IdentityClaimV1[];
  legacy_cutover: {
    declared_at: string;
    pre_cutover_default: 'disposable_test';
    native_records_require: readonly [
      'source-attribution-v1',
      'processor-attribution-v1',
      'approval-context-v1',
      'signed-outbox-v1',
    ];
  };
}

export interface IdentityOwnerV1 {
  kind: 'organization' | 'membership';
  id: FederationId;
}

export interface ProviderIdentityVerificationV1 {
  method: 'slack_auth_test' | 'provider_first_capture' | 'operator_attestation';
  assurance: 'provider_verified' | 'credential_observed' | 'operator_attested';
  verified_at: string;
  evidence_sha256: Sha256Digest;
}

export interface ProviderIdentityV1 {
  tenant: {
    kind: string;
    id: string;
    enterprise_id: string | null;
  } | null;
  subject: {
    kind: string;
    id: string;
    bot_id: string | null;
    app_id: string | null;
  } | null;
  verification: ProviderIdentityVerificationV1;
}

export interface ToolConnectionGenerationV1 {
  generation: number;
  active_from: string;
  ended_at: string | null;
  provider_identity: ProviderIdentityV1;
  local_credential_guard: {
    reference: string;
    algorithm: 'sha256-salted';
    salt_base64: string;
    digest: Sha256Digest;
    exportable: false;
  };
}

export interface ToolConnectionV1 {
  connection_id: FederationId;
  organization_id: FederationId;
  owner: IdentityOwnerV1;
  provider: string;
  generations: readonly ToolConnectionGenerationV1[];
}

export type AdapterCapability =
  | 'meeting-source'
  | 'decision-processor'
  | 'approval-surface'
  | 'delivery-surface';

export interface AdapterBindingV1 {
  adapter_binding_id: FederationId;
  capability: AdapterCapability;
  adapter_id: string;
  instance_id: string;
  connection_id: FederationId | null;
  connection_generation: number | null;
  configuration_snapshot: JsonObject;
  configuration_sha256: Sha256Digest;
  created_at: string;
  ended_at: string | null;
  status: 'active' | 'retired';
}

export interface LocalConnectionRegistryV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-local-connection-registry';
  registry_id: FederationId;
  identity_manifest_id: FederationId;
  revision: number;
  previous_registry_sha256: Sha256Digest | null;
  updated_at: string;
  connections: readonly ToolConnectionV1[];
  bindings: readonly AdapterBindingV1[];
}

export interface PublicationSnapshotV1 {
  payload_scope: 'approved-signal-with-meeting-context-brief-digest-and-bounded-evidence';
  audience: {
    scope: 'organization' | 'named-subjects';
    subjects: readonly IdentityOwnerV1[];
  };
  sensitivity: 'internal' | 'confidential' | 'restricted';
  retention: { kind: 'indefinite' } | { kind: 'duration'; days: number };
  raw_meeting_content: 'local-only';
  participant_observations: 'included-namespaced' | 'excluded';
}

export interface PublicationPolicyV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-publication-policy';
  policy_id: FederationId;
  organization_id: FederationId;
  identity_manifest_id: FederationId;
  issued_by: {
    installation_id: FederationId;
    key_id: Sha256Digest;
  };
  version: number;
  effective_at: string;
  publication: PublicationSnapshotV1;
}

export interface SourceAttributionV1 {
  schema_version: 1;
  kind: 'echo-source-attribution';
  source_observation_id: FederationId;
  organization_id: FederationId;
  identity_manifest_id: FederationId;
  source: {
    adapter_binding_id: FederationId;
    adapter: AdapterIdentity;
    configuration_snapshot: JsonObject;
    configuration_sha256: Sha256Digest;
  };
  connection: {
    connection_id: FederationId;
    generation: number;
    owner: IdentityOwnerV1;
    provider: string;
    provider_identity: JsonObject;
  };
  meeting: {
    external_id: string;
    canonical_revision: string;
    document_sha256: Sha256Digest;
  };
  participant_observations: readonly JsonObject[];
  captured_by: ProductArtifactIdentityV1;
  captured_at: string;
}

export interface ProductArtifactIdentityV1 {
  product_version: string;
  source_sha: string;
  artifact_sha256: Sha256Digest;
}

export interface ProcessorAttributionV1 {
  schema_version: 1;
  kind: 'echo-processor-attribution';
  identity_manifest_id: FederationId;
  meeting: {
    source_adapter_id: string;
    source_instance_id: string;
    external_id: string;
    meeting_revision: string;
  };
  processor: {
    adapter_binding_id: FederationId;
    adapter: AdapterIdentity;
    configuration_snapshot: JsonObject;
    configuration_sha256: Sha256Digest;
    decision_set_sha256: Sha256Digest;
  };
  produced_by: ProductArtifactIdentityV1;
  captured_at: string;
}

export interface ApprovalFederationMetadataV1 {
  schema_version: 1;
  identity_manifest_id: FederationId;
  source_attribution_ref: {
    source_adapter_id: string;
    source_instance_id: string;
    external_id: string;
    meeting_revision: string;
    attribution_sha256: Sha256Digest;
  };
  processor: ApprovalProcessorSnapshotV1;
  approval_surface: ApprovalSurfaceCandidateV1;
  publication: FederatedPublicationSnapshotV1;
  candidate_context_sha256: Sha256Digest;
}

export interface ApprovalProcessorSnapshotV1 {
  adapter_binding_id: FederationId;
  adapter: AdapterIdentity & { kind: 'decision-processor' };
  configuration_snapshot: JsonObject;
  configuration_sha256: Sha256Digest;
  attribution_sha256: Sha256Digest;
}

export interface SlackProviderIdentitySnapshotV1 {
  provider: 'slack';
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string | null;
  app_id: string | null;
}

export interface ApprovalBindingSnapshotV1 {
  adapter_binding_id: FederationId;
  adapter: AdapterIdentity & { kind: 'approval-surface' };
  configuration_snapshot: JsonObject;
  configuration_sha256: Sha256Digest;
}

export interface ApprovalSurfaceCandidateV1 {
  binding: ApprovalBindingSnapshotV1;
  connection: {
    connection_id: FederationId;
    generation: number;
    owner: IdentityOwnerV1;
    provider_identity: SlackProviderIdentitySnapshotV1;
  } | null;
}

export interface NativeProducerV1 {
  principal_id: FederationId;
  membership_id: FederationId;
  installation_id: FederationId;
  key_id: Sha256Digest;
  membership_assertion:
    | {
        status: 'active';
        authority: 'local-founder-bootstrap';
        assurance: 'founder_attested';
      }
    | {
        status: 'active';
        authority: 'organization-authority-enrollment';
        assurance: 'authority_preprovisioned';
      };
  product_artifact: ProductArtifactIdentityV1;
}

export interface FederatedParticipantObservationV1 {
  meeting_participant_id: string;
  display_name: string | null;
  observed_claims: readonly {
    namespace: string;
    kind: 'source' | 'email' | 'phone' | 'other';
    value: string;
  }[];
}

export interface FederatedSourceSnapshotV1 {
  identity_manifest_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  binding: {
    adapter_binding_id: FederationId;
    adapter: AdapterIdentity & { kind: 'meeting-source' };
    configuration_snapshot: JsonObject;
    configuration_sha256: Sha256Digest;
  };
  connection: {
    connection_id: FederationId;
    generation: number;
    owner: IdentityOwnerV1;
    provider_identity: {
      provider: string;
      tenant: ProviderIdentityV1['tenant'];
      subject: ProviderIdentityV1['subject'];
      verification_method: ProviderIdentityVerificationV1['method'];
      assurance: ProviderIdentityVerificationV1['assurance'];
    };
  };
  meeting: {
    external_id: string;
    revision: string;
    source_observation_id: FederationId;
    document_sha256: Sha256Digest;
  };
  participant_observations: readonly FederatedParticipantObservationV1[];
  attribution_sha256: Sha256Digest;
  observed_by: ProductArtifactIdentityV1;
}

export interface FederatedProcessorSnapshotV1 {
  identity_manifest_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  adapter_binding_id: FederationId;
  adapter: AdapterIdentity & { kind: 'decision-processor' };
  configuration_snapshot: JsonObject;
  configuration_sha256: Sha256Digest;
  attribution_sha256: Sha256Digest;
  decision_set_sha256: Sha256Digest;
  generated_at: string;
  produced_by: ProductArtifactIdentityV1;
}

export interface NativeLocalReferenceV1 {
  processing_key: string;
  approval_id: string;
  node_id: string;
  meeting_id: string;
  signal_id: string;
}

export interface FederatedMeetingContextV1 {
  id: string;
  title?: string;
  time?: MeetingTime;
  participants: readonly MeetingParticipant[];
}

export interface FederatedApprovalGroupV1 {
  brief_schema_version: 1;
  brief_id: string;
  approved_brief_sha256: Sha256Digest;
  signal_manifest: readonly {
    signal_id: string;
    kind: 'decision' | 'action' | 'rationale';
    position_within_kind: number;
    sha256: Sha256Digest;
  }[];
}

interface FederatedRecordBaseV1 {
  record_id: FederationId;
  signal_id: string;
  meeting_context: FederatedMeetingContextV1;
  approval_group: FederatedApprovalGroupV1;
}

export type FederatedRecordV1 =
  | (FederatedRecordBaseV1 & {
      kind: 'decision';
      signal: DecisionSignal;
    })
  | (FederatedRecordBaseV1 & {
      kind: 'action';
      signal: ActionSignal;
    })
  | (FederatedRecordBaseV1 & {
      kind: 'rationale';
      signal: RationaleSignal;
    });

export interface SlackApprovalSurfaceSnapshotV1 extends ApprovalSurfaceCandidateV1 {
  connection: NonNullable<ApprovalSurfaceCandidateV1['connection']>;
  presentation: {
    channel_id: string;
    message_ts: string;
    rendered_blocks_sha256: Sha256Digest;
  };
}

export interface SlackApprovalObservationSnapshotV1 {
  binding: ApprovalBindingSnapshotV1;
  connection: NonNullable<ApprovalSurfaceCandidateV1['connection']>;
  observed_by: ProductArtifactIdentityV1;
}

export interface SlackApprovalSnapshotV1 {
  surface: SlackApprovalSurfaceSnapshotV1;
  observation: SlackApprovalObservationSnapshotV1;
  approver: {
    principal_id: FederationId;
    membership_id: FederationId;
    claim_id: FederationId;
  };
  raw_actor_assertion: {
    provider: 'slack';
    tenant_id: string;
    subject_id: string;
    display_name: string;
    channel_id: string;
    message_ts: string;
    action: {
      kind: 'reaction';
      name: string;
      provider_occurred_at: string | null;
      observed_at: string;
    };
    reason_reply: {
      message_ts: string;
      author_subject_id: string;
      text_sha256: Sha256Digest;
    } | null;
  };
  assurance: 'provider_challenge_observed' | 'provider_verified';
  reviewed_at: string;
  reason: string | null;
  approved_brief_sha256: Sha256Digest;
  approved_context_sha256: Sha256Digest;
}

export interface CliApprovalSnapshotV1 {
  surface: null;
  approver: {
    principal_id: FederationId;
    membership_id: FederationId;
    claim_id: null;
  };
  raw_actor_assertion: {
    surface: 'cli';
    installation_id: FederationId;
    reviewer_label: string;
    command: 'approve';
    observed_at: string;
  };
  assurance: 'installation_holder_self_attested';
  reviewed_at: string;
  reason: string | null;
  approved_brief_sha256: Sha256Digest;
  approved_context_sha256: Sha256Digest;
  observed_by: ProductArtifactIdentityV1;
}

export type FederatedApprovalSnapshotV1 =
  SlackApprovalSnapshotV1 | CliApprovalSnapshotV1;

export interface FederatedPublicationSnapshotV1 extends PublicationSnapshotV1 {
  policy_id: FederationId;
  version: number;
  policy_sha256: Sha256Digest;
  identity_manifest_id: FederationId;
  signer_installation_id: FederationId;
  signer_key_id: Sha256Digest;
}

export interface FederatedEventV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-federated-event';
  event_type: 'approved-org-record';
  event_id: FederationId;
  organization_id: FederationId;
  sequence: number;
  previous_event_hash: Sha256Digest | null;
  occurred_at: string;
  producer: NativeProducerV1;
  source: FederatedSourceSnapshotV1;
  processor: FederatedProcessorSnapshotV1;
  local_reference: NativeLocalReferenceV1;
  record: FederatedRecordV1;
  approval: FederatedApprovalSnapshotV1;
  publication: FederatedPublicationSnapshotV1;
  classification: 'native_attributed';
  identity_manifest_sha256: Sha256Digest;
}

export interface FederatedExportManifestV1 extends SignedDocument {
  schema_version: 1;
  kind: 'echo-federated-export';
  export_id: FederationId;
  organization_id: FederationId;
  installation_id: FederationId;
  key_id: Sha256Digest;
  signing_identity_manifest_id: FederationId;
  artifacts: readonly {
    path: string;
    kind: string;
    sha256: Sha256Digest;
  }[];
  sequence: {
    first: number;
    last: number;
    predecessor_hash: Sha256Digest | null;
    head_hash: Sha256Digest;
  };
  records: {
    path: 'records.v1.jsonl';
    count: number;
    sha256: Sha256Digest;
  };
  generated_at: string;
}

export interface FederatedRecoveryReportV1 {
  schema_version: 1;
  kind: 'echo-federated-recovery-report';
  unsigned: true;
  reason: 'installation-key-unavailable';
  organization_id: FederationId;
  installation_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  records: {
    path: 'records.v1.jsonl';
    count: number;
    individually_verified: number;
    verification_failures: readonly JsonValue[];
    sha256: Sha256Digest;
  };
  generated_at: string;
}
