import type { JsonObject } from "../../../core/index.js";
import type { ProductStatePaths } from "../../paths.js";
import {
  assertPrivateOwnedDirectory,
  pathEntryExists,
} from "../../secure-local-files.js";
import { ActiveIdentityBundleStore } from "./active-identity-bundle-store.js";
import { parseCanonicalJson, sha256Digest } from "../foundation/canonical-json.js";
import type {
  AdapterBindingV1,
  AdapterCapability,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from "../contracts.js";
import {
  identityManifestFilename,
  IdentityManifestStore,
} from "./identity-manifest-store.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "../foundation/identifiers.js";
import {
  publicationPolicyFilename,
  PublicationPolicyStore,
} from "./publication-policy-store.js";
import {
  validateFederationDocument,
  type FederationSchemaKind,
} from "../schema-validation.js";
import { p256KeyId } from "../foundation/signature-profile.js";
import { verifySignedDocument } from "../foundation/signed-document.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface HistoricalPublicationPolicyReference {
  policy_id: string;
  version: number;
  policy_sha256: Sha256Digest;
  identity_manifest_id: string;
  signer_installation_id: string;
  signer_key_id: Sha256Digest;
}

export interface HistoricalBindingReference {
  identity_manifest_id: string;
  adapter_binding_id: string;
  capability: AdapterCapability;
  adapter_id: string;
  instance_id: string;
  configuration_snapshot: JsonObject;
  configuration_sha256: Sha256Digest;
  connection_id: string | null;
  connection_generation: number | null;
}

export interface HistoricalBindingSnapshotLocator {
  identity_manifest_id: string;
  adapter_binding_id: string;
  configuration_sha256: Sha256Digest;
  connection_id: string | null;
  connection_generation: number | null;
}

export interface VerifiedHistoricalIdentityManifest {
  manifest: LocalIdentityManifestV1;
  canonical: string;
  sha256: Sha256Digest;
}

export interface VerifiedHistoricalPublicationPolicy {
  policy: PublicationPolicyV1;
  manifest: LocalIdentityManifestV1;
  canonical: string;
  sha256: Sha256Digest;
}

export interface VerifiedHistoricalRegistryRevision {
  registry: LocalConnectionRegistryV1;
  canonical: string;
  sha256: Sha256Digest;
}

export interface VerifiedHistoricalRegistryChain {
  registry_id: string;
  identity_manifest_id: string;
  revisions: readonly VerifiedHistoricalRegistryRevision[];
}

export interface ResolvedHistoricalBinding {
  manifest: LocalIdentityManifestV1;
  chain: VerifiedHistoricalRegistryChain;
  revision: VerifiedHistoricalRegistryRevision;
  binding: AdapterBindingV1;
  connection: ToolConnectionV1 | null;
  generation: ToolConnectionGenerationV1 | null;
}

export interface ManifestMaterial extends VerifiedHistoricalIdentityManifest {
  publicKey: Buffer;
}

export function identityLineageFailure(message: string): never {
  throw new Error(`identity lineage verification failed: ${message}`);
}

export function canonicalLineageDocument<T>(
  kind: FederationSchemaKind,
  raw: string,
): T {
  const parsed = parseCanonicalJson(raw);
  return validateFederationDocument<T>(kind, parsed);
}

export function assertIdentityLineageDirectory(
  paths: ProductStatePaths,
  path: string,
  label: string,
): void {
  if (
    !pathEntryExists(paths.root) ||
    !pathEntryExists(paths.identityRoot) ||
    !pathEntryExists(path)
  ) {
    identityLineageFailure(`${label} does not exist`);
  }
  assertPrivateOwnedDirectory(paths.root, "product state directory");
  assertPrivateOwnedDirectory(paths.identityRoot, "identity directory");
  assertPrivateOwnedDirectory(path, label);
}

function canonicalPublicKey(manifest: LocalIdentityManifestV1): Buffer {
  const encoded = manifest.installation.signing_key.public_key_spki_der_base64;
  const publicKey = Buffer.from(encoded, "base64");
  if (publicKey.length === 0 || publicKey.toString("base64") !== encoded) {
    identityLineageFailure(
      "historical manifest public key is not canonical base64",
    );
  }
  if (p256KeyId(publicKey) !== manifest.installation.signing_key.key_id) {
    identityLineageFailure(
      "historical manifest public key does not match key_id",
    );
  }
  return publicKey;
}

function assertManifestSemantics(manifest: LocalIdentityManifestV1): void {
  const organizationId = manifest.organization.organization_id;
  if (
    manifest.principal.organization_id !== organizationId ||
    manifest.membership.organization_id !== organizationId ||
    manifest.membership.principal_id !== manifest.principal.principal_id ||
    manifest.installation.organization_id !== organizationId ||
    manifest.installation.membership_id !== manifest.membership.membership_id
  ) {
    identityLineageFailure(
      "historical manifest identity graph is inconsistent",
    );
  }
  for (const [label, timestamp] of [
    ["manifest.created_at", manifest.created_at],
    ["organization.created_at", manifest.organization.created_at],
    ["membership.valid_from", manifest.membership.valid_from],
    ["installation.enrolled_at", manifest.installation.enrolled_at],
    ["legacy_cutover.declared_at", manifest.legacy_cutover.declared_at],
  ] as const) {
    assertUtcMillisecondTimestamp(timestamp, label);
  }
  const claimIds = new Set<string>();
  for (const claim of manifest.identity_claims) {
    if (claimIds.has(claim.claim_id)) {
      identityLineageFailure(
        "historical manifest contains duplicate claim IDs",
      );
    }
    claimIds.add(claim.claim_id);
    if (claim.principal_id !== manifest.principal.principal_id) {
      identityLineageFailure(
        "historical manifest claim belongs to another principal",
      );
    }
    assertUtcMillisecondTimestamp(
      claim.verification.verified_at,
      "historical identity claim verified_at",
    );
    if (claim.verification.verified_at > manifest.created_at) {
      identityLineageFailure(
        "historical identity claim was verified after its signed manifest",
      );
    }
    if (
      claim.verification.method === "slack_dm_challenge" &&
      (claim.issuer.kind !== "provider" ||
        claim.issuer.provider !== "slack" ||
        claim.subject.kind !== "user" ||
        claim.verification.assurance !== "provider_challenge_observed")
    ) {
      identityLineageFailure(
        "historical Slack identity claim overstates its assurance",
      );
    }
    if (
      claim.verification.method === "oidc_id_token" &&
      (claim.issuer.kind !== "oidc" ||
        claim.subject.kind !== "oidc_sub" ||
        claim.verification.assurance !== "provider_verified")
    ) {
      identityLineageFailure(
        "historical OIDC identity claim overstates its assurance",
      );
    }
  }
}

function assertPolicySemantics(
  manifest: LocalIdentityManifestV1,
  policy: PublicationPolicyV1,
): void {
  assertUtcMillisecondTimestamp(
    policy.effective_at,
    "historical policy effective_at",
  );
  if (
    policy.identity_manifest_id !== manifest.manifest_id ||
    policy.organization_id !== manifest.organization.organization_id ||
    policy.issued_by.installation_id !==
      manifest.installation.installation_id ||
    policy.issued_by.key_id !== manifest.installation.signing_key.key_id
  ) {
    identityLineageFailure(
      "historical policy belongs to another identity lineage",
    );
  }
  if (
    policy.publication.audience.subjects.some(
      (subject) =>
        !(
          (subject.kind === "organization" &&
            subject.id === manifest.organization.organization_id) ||
          (subject.kind === "membership" &&
            subject.id === manifest.membership.membership_id)
        ),
    )
  ) {
    identityLineageFailure(
      "historical policy contains an unknown local audience subject",
    );
  }
  if (
    policy.publication.audience.scope === "organization" &&
    (policy.publication.audience.subjects.length !== 1 ||
      policy.publication.audience.subjects[0]?.kind !== "organization" ||
      policy.publication.audience.subjects[0].id !==
        manifest.organization.organization_id)
  ) {
    identityLineageFailure(
      "historical organization policy has a non-canonical audience",
    );
  }
}

export class IdentityDocumentLineage {
  private readonly activeBundle: ActiveIdentityBundleStore;
  private readonly manifests: IdentityManifestStore;
  private readonly policies: PublicationPolicyStore;

  constructor(private readonly paths: ProductStatePaths) {
    this.activeBundle = new ActiveIdentityBundleStore(paths.root);
    this.manifests = new IdentityManifestStore(paths);
    this.policies = new PublicationPolicyStore(paths);
  }

  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest {
    const material = this.loadAnchoredManifestMaterial(manifestId);
    const { publicKey: _publicKey, ...verified } = material;
    return verified;
  }

  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest {
    const material = this.loadActiveManifestLineage()[0];
    if (material === undefined) {
      identityLineageFailure("there is no verified active identity manifest");
    }
    const { publicKey: _publicKey, ...verified } = material;
    return verified;
  }

  loadVerifiedManifestBySha256(
    sha256: `sha256:${string}`,
  ): VerifiedHistoricalIdentityManifest {
    if (!SHA256_DIGEST.test(sha256)) {
      identityLineageFailure(
        "historical manifest digest is not a canonical SHA-256 digest",
      );
    }
    const matches = this.loadActiveManifestLineage().filter(
      (material) => material.sha256 === sha256,
    );
    if (matches.length !== 1) {
      identityLineageFailure(
        matches.length === 0
          ? `manifest digest ${sha256} is not reachable from the active identity lineage`
          : `manifest digest ${sha256} resolves to more than one active-lineage manifest`,
      );
    }
    const { publicKey: _publicKey, ...verified } = matches[0]!;
    return verified;
  }

  assertManifestAncestorOrEqual(
    ancestorManifestId: string,
    descendantManifestId: string,
  ): void {
    assertFederationId(
      ancestorManifestId,
      "idm",
      "ancestor_identity_manifest_id",
    );
    assertFederationId(
      descendantManifestId,
      "idm",
      "descendant_identity_manifest_id",
    );
    const lineage = this.loadActiveManifestLineage();
    const ancestorIndex = lineage.findIndex(
      (material) => material.manifest.manifest_id === ancestorManifestId,
    );
    const descendantIndex = lineage.findIndex(
      (material) => material.manifest.manifest_id === descendantManifestId,
    );
    if (ancestorIndex === -1 || descendantIndex === -1) {
      identityLineageFailure(
        "manifest order references identity outside the active lineage",
      );
    }
    if (ancestorIndex < descendantIndex) {
      identityLineageFailure(
        `manifest ${ancestorManifestId} is not an ancestor of ${descendantManifestId}`,
      );
    }
  }

  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy {
    assertUtcMillisecondTimestamp(observedAt, "policy observed_at");
    assertFederationId(reference.policy_id, "pol", "policy_id");
    assertFederationId(
      reference.identity_manifest_id,
      "idm",
      "identity_manifest_id",
    );
    assertFederationId(
      reference.signer_installation_id,
      "ins",
      "signer_installation_id",
    );
    const manifest = this.loadAnchoredManifestMaterial(
      reference.identity_manifest_id,
    );
    assertIdentityLineageDirectory(
      this.paths,
      this.paths.identityPolicies,
      "identity policy directory",
    );
    const filename = publicationPolicyFilename(
      reference.policy_id,
      reference.version,
    );
    const raw = this.policies.read(filename);
    const sha256 = sha256Digest(raw);
    if (sha256 !== reference.policy_sha256) {
      identityLineageFailure(
        "historical policy file digest does not match its recorded snapshot",
      );
    }
    const policy = canonicalLineageDocument<PublicationPolicyV1>(
      "publication-policy",
      raw,
    );
    if (
      policy.policy_id !== reference.policy_id ||
      policy.version !== reference.version ||
      policy.identity_manifest_id !== reference.identity_manifest_id ||
      policy.issued_by.installation_id !== reference.signer_installation_id ||
      policy.issued_by.key_id !== reference.signer_key_id
    ) {
      identityLineageFailure(
        "historical policy reference does not match the signed document",
      );
    }
    assertPolicySemantics(manifest.manifest, policy);
    if (
      observedAt < manifest.manifest.legacy_cutover.declared_at ||
      policy.effective_at > observedAt
    ) {
      identityLineageFailure(
        "historical policy was not effective at the observation time",
      );
    }
    verifySignedDocument(
      policy,
      manifest.publicKey,
      manifest.manifest.installation.signing_key.key_id,
    );
    return { policy, manifest: manifest.manifest, canonical: raw, sha256 };
  }

  loadAnchoredManifestMaterial(manifestId: string): ManifestMaterial {
    assertFederationId(manifestId, "idm", "manifest_id");
    const material = this.loadActiveManifestLineage().find(
      (candidate) => candidate.manifest.manifest_id === manifestId,
    );
    if (material !== undefined) return material;
    identityLineageFailure(
      `manifest ${manifestId} is not reachable from the active identity lineage`,
    );
  }

  private loadManifestMaterial(manifestId: string): ManifestMaterial {
    assertFederationId(manifestId, "idm", "manifest_id");
    assertIdentityLineageDirectory(
      this.paths,
      this.paths.identityManifests,
      "identity manifest directory",
    );
    const raw = this.manifests.read(identityManifestFilename(manifestId));
    const manifest = canonicalLineageDocument<LocalIdentityManifestV1>(
      "local-identity-manifest",
      raw,
    );
    if (manifest.manifest_id !== manifestId) {
      identityLineageFailure(
        "historical manifest filename and document ID disagree",
      );
    }
    assertManifestSemantics(manifest);
    const publicKey = canonicalPublicKey(manifest);
    verifySignedDocument(
      manifest,
      publicKey,
      manifest.installation.signing_key.key_id,
    );
    return { manifest, canonical: raw, sha256: sha256Digest(raw), publicKey };
  }

  private loadActiveManifestLineage(): readonly ManifestMaterial[] {
    const active = this.activeBundle.loadVerified();
    if (active === null) {
      identityLineageFailure(
        "there is no verified active identity bundle to anchor history",
      );
    }
    const seen = new Set<string>();
    const lineage: ManifestMaterial[] = [];
    let currentId: string | null = active.manifest.manifest_id;
    let successor: LocalIdentityManifestV1 | undefined;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        identityLineageFailure(
          "active identity manifest predecessor chain contains a cycle",
        );
      }
      seen.add(currentId);
      const current = this.loadManifestMaterial(currentId);
      if (
        successor === undefined &&
        (current.canonical !== active.canonical.manifest ||
          current.sha256 !== active.pointer.manifest.sha256)
      ) {
        identityLineageFailure(
          "active manifest bytes disagree with the verified bundle",
        );
      }
      if (successor !== undefined) {
        if (
          current.manifest.created_at >= successor.created_at ||
          current.manifest.organization.organization_id !==
            successor.organization.organization_id ||
          current.manifest.principal.principal_id !==
            successor.principal.principal_id ||
          current.manifest.membership.membership_id !==
            successor.membership.membership_id
        ) {
          identityLineageFailure(
            "identity manifest predecessor continuity is inconsistent",
          );
        }
      }
      lineage.push(current);
      successor = current.manifest;
      currentId = current.manifest.predecessor_manifest_id;
    }
    return lineage;
  }
}
