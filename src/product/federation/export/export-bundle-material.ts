import { createPublicKey } from 'node:crypto';
import {
  canonicalJson,
  sha256Digest,
} from '../foundation/canonical-json.js';
import type {
  FederatedEventV1,
  FederatedExportManifestV1,
  FederationId,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../contracts.js';
import { identityManifestFilename } from '../identity/identity-manifest-store.js';
import type {
  HistoricalPublicationPolicyReference,
  VerifiedHistoricalIdentityManifest,
  VerifiedHistoricalPublicationPolicy,
} from '../identity-lineage-store.js';
import type { InstallationSigner } from '../foundation/installation-signer.js';
import type {
  FederatedOutboxStore,
  StoredFederatedOutboxEvent,
} from '../outbox-store.js';
import { publicationPolicyFilename } from '../identity/publication-policy-store.js';
import { p256KeyId } from '../foundation/signature-profile.js';

export const EXPORT_MANIFEST_FILENAME = 'export-manifest.v1.json';
export const RECORDS_FILENAME = 'records.v1.jsonl';
export const IDENTITY_DIRECTORY = 'identity-manifests';
export const POLICY_DIRECTORY = 'publication-policies';

export interface FederatedExportIdentitySource {
  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest;
  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest;
  loadVerifiedManifestBySha256(
    sha256: Sha256Digest,
  ): VerifiedHistoricalIdentityManifest;
  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy;
}

export interface FederatedExportOutboxSource {
  verifyInstallationChain: FederatedOutboxStore['verifyInstallationChain'];
}

export interface CreateFederatedExportBundleRequest {
  output_root: string;
  installation_id: FederationId;
  signing_identity_manifest_id: FederationId;
  first_sequence: number;
  last_sequence: number;
  export_id: FederationId;
  generated_at: string;
  signer: InstallationSigner;
  outbox: FederatedExportOutboxSource;
  identity_source: FederatedExportIdentitySource;
}

export interface CreatedFederatedExportBundle {
  created: boolean;
  path: string;
  manifest: FederatedExportManifestV1;
  manifest_json: string;
  records_bytes: Buffer;
  events: readonly FederatedEventV1[];
}

export interface VerifiedFederatedExportBundle {
  path: string;
  manifest: FederatedExportManifestV1;
  manifest_json: string;
  records_bytes: Buffer;
  events: readonly FederatedEventV1[];
  event_hashes: readonly Sha256Digest[];
  identity_manifests: ReadonlyMap<string, LocalIdentityManifestV1>;
  publication_policies: ReadonlyMap<string, PublicationPolicyV1>;
}

export interface ExportArtifact {
  path: string;
  kind: 'echo-local-identity-manifest' | 'echo-publication-policy';
  sha256: Sha256Digest;
  canonical: string;
}

export interface IdentityMaterial {
  artifact: ExportArtifact;
  manifest: LocalIdentityManifestV1;
  publicKey: Buffer;
}

export interface PolicyMaterial {
  artifact: ExportArtifact;
  policy: PublicationPolicyV1;
}

export function failFederatedExportVerification(message: string): never {
  throw new Error(`federated export verification failed: ${message}`);
}

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

export function identityArtifactPath(manifestId: string): string {
  return `${IDENTITY_DIRECTORY}/${identityManifestFilename(manifestId)}`;
}

export function policyArtifactPath(policyId: string, version: number): string {
  return `${POLICY_DIRECTORY}/${publicationPolicyFilename(policyId, version)}`;
}

export function publicKeyForManifest(
  manifest: LocalIdentityManifestV1,
): Buffer {
  const encoded = manifest.installation.signing_key.public_key_spki_der_base64;
  const publicKey = Buffer.from(encoded, 'base64');
  if (
    publicKey.length === 0 ||
    publicKey.toString('base64') !== encoded ||
    p256KeyId(publicKey) !== manifest.installation.signing_key.key_id
  ) {
    failFederatedExportVerification(
      `identity manifest ${manifest.manifest_id} has an invalid public key`,
    );
  }
  const parsed = createPublicKey({
    key: publicKey,
    format: 'der',
    type: 'spki',
  });
  const canonical = parsed.export({ format: 'der', type: 'spki' });
  if (
    parsed.asymmetricKeyType !== 'ec' ||
    parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    !Buffer.isBuffer(canonical) ||
    !canonical.equals(publicKey)
  ) {
    failFederatedExportVerification(
      `identity manifest ${manifest.manifest_id} public key is not canonical P-256 SPKI DER`,
    );
  }
  return publicKey;
}

export function assertManifestSemantics(
  manifest: LocalIdentityManifestV1,
): void {
  const organizationId = manifest.organization.organization_id;
  if (
    manifest.principal.organization_id !== organizationId ||
    manifest.principal.organization_id !== organizationId ||
    manifest.membership.organization_id !== organizationId ||
    manifest.membership.principal_id !== manifest.principal.principal_id ||
    manifest.installation.organization_id !== organizationId ||
    manifest.installation.membership_id !== manifest.membership.membership_id
  ) {
    failFederatedExportVerification(
      `identity manifest ${manifest.manifest_id} has an inconsistent identity graph`,
    );
  }
  const claimIds = new Set<string>();
  for (const claim of manifest.identity_claims) {
    if (claimIds.has(claim.claim_id)) {
      failFederatedExportVerification(
        `identity manifest ${manifest.manifest_id} has duplicate claims`,
      );
    }
    claimIds.add(claim.claim_id);
    if (claim.principal_id !== manifest.principal.principal_id) {
      failFederatedExportVerification(
        `identity manifest ${manifest.manifest_id} has a claim for another principal`,
      );
    }
    if (claim.verification.verified_at > manifest.created_at) {
      failFederatedExportVerification(
        `identity manifest ${manifest.manifest_id} contains a claim verified after the manifest was created`,
      );
    }
    if (
      claim.verification.method === 'slack_dm_challenge' &&
      (claim.issuer.kind !== 'provider' ||
        claim.issuer.provider !== 'slack' ||
        claim.subject.kind !== 'user' ||
        claim.verification.assurance !== 'provider_challenge_observed')
    ) {
      failFederatedExportVerification(
        `identity manifest ${manifest.manifest_id} contains an invalid Slack identity claim`,
      );
    }
    if (
      claim.verification.method === 'oidc_id_token' &&
      (claim.issuer.kind !== 'oidc' ||
        claim.subject.kind !== 'oidc_sub' ||
        claim.verification.assurance !== 'provider_verified')
    ) {
      failFederatedExportVerification(
        `identity manifest ${manifest.manifest_id} contains an invalid OIDC identity claim`,
      );
    }
  }
}

export function assertManifestPredecessor(
  successor: LocalIdentityManifestV1,
  predecessor: LocalIdentityManifestV1,
): void {
  if (
    successor.predecessor_manifest_id !== predecessor.manifest_id ||
    predecessor.created_at >= successor.created_at ||
    predecessor.organization.organization_id !==
      successor.organization.organization_id ||
    predecessor.principal.principal_id !== successor.principal.principal_id ||
    predecessor.membership.membership_id !== successor.membership.membership_id
  ) {
    failFederatedExportVerification(
      `identity manifest ${successor.manifest_id} has inconsistent predecessor continuity`,
    );
  }
}

export function identityForDigest(
  identities: ReadonlyMap<string, IdentityMaterial>,
  sha256: Sha256Digest,
  label: string,
): IdentityMaterial {
  const matches = [...identities.values()].filter(
    (material) => material.artifact.sha256 === sha256,
  );
  if (matches.length !== 1) {
    failFederatedExportVerification(
      matches.length === 0
        ? `${label} does not resolve to an exported identity manifest`
        : `${label} resolves to more than one exported identity manifest`,
    );
  }
  return matches[0]!;
}

export function identityForReference(
  identities: ReadonlyMap<string, IdentityMaterial>,
  manifestId: FederationId,
  sha256: Sha256Digest,
  label: string,
): IdentityMaterial {
  const byId = identities.get(manifestId);
  const byDigest = identityForDigest(identities, sha256, `${label} digest`);
  if (byId === undefined || byId !== byDigest) {
    failFederatedExportVerification(
      `${label} ID and digest do not resolve to the same identity manifest`,
    );
  }
  return byId;
}

export function manifestIsAncestorOrEqual(
  identities: ReadonlyMap<string, IdentityMaterial>,
  ancestorId: string,
  descendantId: string,
): boolean {
  const seen = new Set<string>();
  let currentId: string | null = descendantId;
  while (currentId !== null) {
    if (currentId === ancestorId) return true;
    if (seen.has(currentId)) return false;
    seen.add(currentId);
    const current = identities.get(currentId);
    if (current === undefined) return false;
    currentId = current.manifest.predecessor_manifest_id;
  }
  return false;
}

export function policyReference(
  event: FederatedEventV1,
): HistoricalPublicationPolicyReference {
  return {
    policy_id: event.publication.policy_id,
    version: event.publication.version,
    policy_sha256: event.publication.policy_sha256,
    identity_manifest_id: event.publication.identity_manifest_id,
    signer_installation_id: event.publication.signer_installation_id,
    signer_key_id: event.publication.signer_key_id,
  };
}

export function assertVerifiedIdentityMaterial(
  material: VerifiedHistoricalIdentityManifest,
  label: string,
): void {
  if (
    material.canonical !== canonicalJson(material.manifest) ||
    material.sha256 !== sha256Digest(material.canonical)
  ) {
    throw new Error(`${label} resolved to inconsistent verified bytes`);
  }
}

function loadExactIdentityReference(
  source: FederatedExportIdentitySource,
  manifestId: FederationId,
  sha256: Sha256Digest,
  label: string,
): VerifiedHistoricalIdentityManifest {
  const byId = source.loadVerifiedManifest(manifestId);
  const byDigest = source.loadVerifiedManifestBySha256(sha256);
  assertVerifiedIdentityMaterial(byId, label);
  assertVerifiedIdentityMaterial(byDigest, label);
  if (
    byId.manifest.manifest_id !== manifestId ||
    byId.sha256 !== sha256 ||
    byDigest.manifest.manifest_id !== manifestId ||
    byDigest.sha256 !== sha256 ||
    byId.canonical !== byDigest.canonical
  ) {
    throw new Error(`${label} ID and digest resolved to conflicting bytes`);
  }
  return byId;
}

export function loadExportArtifacts(
  events: readonly StoredFederatedOutboxEvent[],
  signingManifestId: string,
  source: FederatedExportIdentitySource,
): ExportArtifact[] {
  const policies = new Map<string, ExportArtifact>();
  const manifestSeeds = new Set<string>([signingManifestId]);
  for (const stored of events) {
    const event = stored.envelope;
    const eventIdentity = source.loadVerifiedManifestBySha256(
      event.identity_manifest_sha256,
    );
    assertVerifiedIdentityMaterial(
      eventIdentity,
      `event ${event.event_id} identity manifest`,
    );
    if (eventIdentity.sha256 !== event.identity_manifest_sha256) {
      throw new Error(
        `event ${event.event_id} identity digest resolved to conflicting bytes`,
      );
    }
    const sourceIdentity = loadExactIdentityReference(
      source,
      event.source.identity_manifest_id,
      event.source.identity_manifest_sha256,
      `event ${event.event_id} source identity manifest`,
    );
    const processorIdentity = loadExactIdentityReference(
      source,
      event.processor.identity_manifest_id,
      event.processor.identity_manifest_sha256,
      `event ${event.event_id} processor identity manifest`,
    );
    const verified = source.loadVerifiedPolicy(
      policyReference(event),
      event.occurred_at,
    );
    const path = policyArtifactPath(
      verified.policy.policy_id,
      verified.policy.version,
    );
    const artifact: ExportArtifact = {
      path,
      kind: 'echo-publication-policy',
      sha256: verified.sha256,
      canonical: verified.canonical,
    };
    const existing = policies.get(path);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(artifact)
    ) {
      throw new Error(
        `publication policy ${path} resolved to conflicting bytes`,
      );
    }
    policies.set(path, artifact);
    manifestSeeds.add(eventIdentity.manifest.manifest_id);
    manifestSeeds.add(sourceIdentity.manifest.manifest_id);
    manifestSeeds.add(processorIdentity.manifest.manifest_id);
    manifestSeeds.add(verified.policy.identity_manifest_id);
  }

  const identities = new Map<string, ExportArtifact>();
  for (const seed of manifestSeeds) {
    const traversal = new Set<string>();
    let currentId: string | null = seed;
    while (currentId !== null) {
      if (traversal.has(currentId)) {
        throw new Error('identity-manifest export closure contains a cycle');
      }
      traversal.add(currentId);
      const verified = source.loadVerifiedManifest(currentId);
      if (verified.manifest.manifest_id !== currentId) {
        throw new Error('identity source returned the wrong manifest');
      }
      const artifact: ExportArtifact = {
        path: identityArtifactPath(currentId),
        kind: 'echo-local-identity-manifest',
        sha256: verified.sha256,
        canonical: verified.canonical,
      };
      const existing = identities.get(currentId);
      if (
        existing !== undefined &&
        canonicalJson(existing) !== canonicalJson(artifact)
      ) {
        throw new Error(
          `identity manifest ${currentId} resolved to conflicting bytes`,
        );
      }
      identities.set(currentId, artifact);
      currentId = verified.manifest.predecessor_manifest_id;
    }
  }
  return [...identities.values(), ...policies.values()].sort((left, right) =>
    bytewiseCompare(left.path, right.path),
  );
}
