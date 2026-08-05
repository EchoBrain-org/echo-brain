import type { JsonObject } from '../../core/index.js';
import type {
  KeyProtection,
  KeyProtectionAssurance,
  Sha256Digest,
  SignedDocument,
} from '@echo-brain/federation-protocol';

export type {
  KeyProtection,
  KeyProtectionAssurance,
  Sha256Digest,
  SignedDocument,
  SignedIntegrity,
} from '@echo-brain/federation-protocol';

export type FederationId = string;

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
