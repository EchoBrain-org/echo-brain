import type { PackagedBuildIdentityV1 } from "../../product/federation/build-identity.js";
import { validatePackagedBuildIdentity } from "../../product/federation/build-identity.js";
import type {
  IdentityClaimV1,
  LocalIdentityManifestV1,
  MembershipIdentityV1,
  OrganizationIdentityV1,
  PrincipalIdentityV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
} from "../../product/federation/contracts.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "../../product/federation/foundation/identifiers.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../../product/federation/foundation/installation-signer.js";
import { verifyInstallationKeyDescriptor } from "../../product/federation/foundation/installation-signer.js";
import {
  createSignedDocument,
  verifySignedDocument,
} from "../../product/federation/foundation/signed-document.js";
import { validateFederationDocument } from "../../product/federation/schema-validation.js";

export interface AuthorityAssignedMemberIdentity {
  organization: OrganizationIdentityV1;
  principal: PrincipalIdentityV1;
  membership: MembershipIdentityV1 & { type: "owner" | "employee" };
}

export interface MemberJoinLocalIdentity {
  device_id: string;
  installation_id: string;
  manifest_id: string;
  policy_id: string;
  device_class: "byod" | "managed";
  created_at: string;
}

export interface BuildAuthorityMemberJoinPlanRequest {
  authority_identity: AuthorityAssignedMemberIdentity;
  local_identity: MemberJoinLocalIdentity;
  identity_claim?: IdentityClaimV1;
  publication: PublicationSnapshotV1;
  build_identity: PackagedBuildIdentityV1;
  signer: InstallationSigner;
}

export interface AuthorityMemberJoinPlan {
  signing_key: InstallationKeyDescriptor;
  identity_manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
}

function nonBlank(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 200) {
    throw new Error(`${label} must contain 1-200 characters`);
  }
}

function assertAuthorityFacts(
  identity: AuthorityAssignedMemberIdentity,
  local: MemberJoinLocalIdentity,
  claim: IdentityClaimV1 | undefined,
): void {
  assertFederationId(
    identity.organization.organization_id,
    "org",
    "member organization",
  );
  assertFederationId(
    identity.principal.principal_id,
    "prn",
    "member principal",
  );
  assertFederationId(
    identity.membership.membership_id,
    "mem",
    "member membership",
  );
  assertFederationId(local.device_id, "dev", "member device");
  assertFederationId(local.installation_id, "ins", "member installation");
  assertFederationId(local.manifest_id, "idm", "member identity manifest");
  assertFederationId(local.policy_id, "pol", "member publication policy");
  if (claim !== undefined) {
    assertFederationId(claim.claim_id, "clm", "member identity claim");
  }
  nonBlank(identity.organization.display_name, "organization display name");
  nonBlank(identity.principal.display_name, "principal display name");
  if (
    identity.principal.organization_id !==
      identity.organization.organization_id ||
    identity.membership.organization_id !==
      identity.organization.organization_id ||
    identity.membership.principal_id !== identity.principal.principal_id ||
    identity.principal.kind !== "human" ||
    identity.membership.status !== "active" ||
    (identity.membership.type !== "owner" &&
      identity.membership.type !== "employee") ||
    (claim !== undefined &&
      claim.principal_id !== identity.principal.principal_id)
  ) {
    throw new Error(
      "authority-assigned member organization, principal, membership, or claim facts disagree",
    );
  }
  const timestamps: Array<readonly [string, string]> = [
    ["organization created_at", identity.organization.created_at],
    ["membership valid_from", identity.membership.valid_from],
    ["member join created_at", local.created_at],
  ];
  if (claim !== undefined) {
    timestamps.push([
      "identity claim verified_at",
      claim.verification.verified_at,
    ]);
  }
  for (const [label, timestamp] of timestamps) {
    assertUtcMillisecondTimestamp(timestamp, label);
    if (timestamp > local.created_at) {
      throw new Error(`${label} is later than the employee join plan`);
    }
  }
}

async function loadOrCreateInstallationKey(
  signer: InstallationSigner,
  installationId: string,
): Promise<InstallationKeyDescriptor> {
  const existing = await signer.inspect(installationId);
  const descriptor = existing ?? (await signer.generate(installationId));
  verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      "installation signer returned a key for another installation",
    );
  }
  return descriptor;
}

/**
 * Builds the member-owned, installation-signed identity material presented
 * to OrganizationAuthorityStore when consuming a preprovisioned enrollment
 * grant. Authority-side enrollment remains the proof that these assigned facts
 * were accepted by the named organization.
 */
export async function buildAuthorityMemberJoinPlan(
  request: BuildAuthorityMemberJoinPlanRequest,
): Promise<AuthorityMemberJoinPlan> {
  const authorityIdentity = structuredClone(request.authority_identity);
  const localIdentity = structuredClone(request.local_identity);
  const identityClaim =
    request.identity_claim === undefined
      ? undefined
      : structuredClone(request.identity_claim);
  const publication = structuredClone(request.publication);
  const buildIdentity = validatePackagedBuildIdentity(
    structuredClone(request.build_identity),
  );
  assertAuthorityFacts(authorityIdentity, localIdentity, identityClaim);

  const signingKey = await loadOrCreateInstallationKey(
    request.signer,
    localIdentity.installation_id,
  );
  const publicKey = verifyInstallationKeyDescriptor(signingKey);
  const manifest = validateFederationDocument<LocalIdentityManifestV1>(
    "local-identity-manifest",
    await createSignedDocument(
      {
        schema_version: 1,
        kind: "echo-local-identity-manifest",
        manifest_id: localIdentity.manifest_id,
        predecessor_manifest_id: null,
        created_at: localIdentity.created_at,
        authority: {
          kind: "organization-authority-enrollment",
          assurance: "authority_preprovisioned",
        },
        organization: authorityIdentity.organization,
        principal: authorityIdentity.principal,
        membership: authorityIdentity.membership,
        installation: {
          installation_id: localIdentity.installation_id,
          organization_id: authorityIdentity.organization.organization_id,
          membership_id: authorityIdentity.membership.membership_id,
          device_id: localIdentity.device_id,
          device_class: localIdentity.device_class,
          enrolled_at: localIdentity.created_at,
          product: {
            name: "echo-brain",
            version: buildIdentity.product_version,
            source_sha: buildIdentity.source_sha,
          },
          signing_key: {
            key_id: signingKey.key_id,
            algorithm: signingKey.algorithm,
            public_key_spki_der_base64: signingKey.public_key_spki_der_base64,
            protection: signingKey.protection,
            assurance: signingKey.assurance,
          },
        },
        identity_claims: identityClaim === undefined ? [] : [identityClaim],
        legacy_cutover: {
          declared_at: localIdentity.created_at,
          pre_cutover_default: "disposable_test",
          native_records_require: [
            "source-attribution-v1",
            "processor-attribution-v1",
            "approval-context-v1",
            "signed-outbox-v1",
          ],
        },
      } as const,
      request.signer,
      localIdentity.installation_id,
      signingKey.key_id,
    ),
  );
  verifySignedDocument(manifest, publicKey, signingKey.key_id);

  const policy = validateFederationDocument<PublicationPolicyV1>(
    "publication-policy",
    await createSignedDocument(
      {
        schema_version: 1,
        kind: "echo-publication-policy",
        policy_id: localIdentity.policy_id,
        organization_id: authorityIdentity.organization.organization_id,
        identity_manifest_id: localIdentity.manifest_id,
        issued_by: {
          installation_id: localIdentity.installation_id,
          key_id: signingKey.key_id,
        },
        version: 1,
        effective_at: localIdentity.created_at,
        publication,
      } as const,
      request.signer,
      localIdentity.installation_id,
      signingKey.key_id,
    ),
  );
  verifySignedDocument(policy, publicKey, signingKey.key_id);

  return {
    signing_key: signingKey,
    identity_manifest: manifest,
    publication_policy: policy,
  };
}
