import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { JsonValue } from '../../../core/index.js';
import { resolveProductStatePaths, type ProductStatePaths } from '../../paths.js';
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  pathEntryExists,
  readFileNoFollow,
} from '../../secure-local-files.js';
import { parseCanonicalJson, sha256Digest } from '../foundation/canonical-json.js';
import {
  connectionRegistryFilename,
  ConnectionRegistryStore,
} from './connection-registry-store.js';
import type {
  ActiveIdentityBundleV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
} from '../contracts.js';
import {
  identityManifestFilename,
  IdentityManifestStore,
} from './identity-manifest-store.js';
import { p256KeyId } from '../foundation/signature-profile.js';
import {
  publicationPolicyFilename,
  PublicationPolicyStore,
} from './publication-policy-store.js';
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from '../schema-validation.js';
import { verifySignedDocument } from '../foundation/signed-document.js';
import type { ProductRuntimeConfig } from '../../config.js';
import {
  validateIdentityDocumentSemantics,
  validateRegistryAgainstRuntime,
} from './bundle-semantics.js';

export interface VerifiedActiveIdentityBundle {
  pointer: ActiveIdentityBundleV1;
  manifest: LocalIdentityManifestV1;
  connectionRegistry: LocalConnectionRegistryV1;
  publicationPolicy: PublicationPolicyV1;
  canonical: {
    pointer: string;
    manifest: string;
    connectionRegistry: string;
    publicationPolicy: string;
  };
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function readActivePointer(paths: ProductStatePaths): string {
  assertPrivateOwnedRegularFile(paths.activeIdentityBundle, 0o600, () => {
    throw new Error('active identity bundle must be a current-user regular file with mode 0600');
  });
  const raw = readFileNoFollow(paths.activeIdentityBundle, 'active identity bundle');
  assertFederationDocumentSize(raw, 'active identity bundle');
  return raw.toString('utf8');
}

function canonicalDocument<T>(kind: Parameters<typeof validateFederationDocument>[0], raw: string): T {
  const parsed = parseCanonicalJson<JsonValue>(raw);
  return validateFederationDocument<T>(kind, parsed);
}

function canonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return bytes;
}

export class ActiveIdentityBundleStore {
  readonly paths: ProductStatePaths;
  readonly manifests: IdentityManifestStore;
  readonly registries: ConnectionRegistryStore;
  readonly policies: PublicationPolicyStore;

  constructor(stateDirectory: string) {
    this.paths = resolveProductStatePaths(stateDirectory);
    this.manifests = new IdentityManifestStore(this.paths);
    this.registries = new ConnectionRegistryStore(this.paths);
    this.policies = new PublicationPolicyStore(this.paths);
  }

  hasActiveBundle(): boolean {
    return pathEntryExists(this.paths.activeIdentityBundle);
  }

  /**
   * Detect signed/staged identity state even when the active pointer is gone.
   * Empty directories are harmless preparation; any file or unexpected entry
   * means this profile may have crossed (or interrupted) bootstrap and cannot
   * silently fall back to disposable rehearsal behavior.
   */
  hasIdentityMaterial(): boolean {
    if (!pathEntryExists(this.paths.identityRoot)) return false;
    const root = lstatSync(this.paths.identityRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) return true;
    const expectedDirectories = new Set(['manifests', 'registries', 'policies']);
    for (const entry of readdirSync(this.paths.identityRoot, {
      withFileTypes: true,
    })) {
      if (!expectedDirectories.has(entry.name)) return true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
      if (
        readdirSync(
          join(this.paths.identityRoot, entry.name),
          { withFileTypes: true },
        ).length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  loadVerified(
    runtimeConfig?: ProductRuntimeConfig,
  ): VerifiedActiveIdentityBundle | null {
    if (!this.hasActiveBundle()) return null;
    assertPrivateOwnedDirectory(this.paths.root, 'product state directory');
    assertPrivateOwnedDirectory(this.paths.identityRoot, 'identity directory');

    const pointerRaw = readActivePointer(this.paths);
    const pointer = canonicalDocument<ActiveIdentityBundleV1>(
      'active-identity-bundle',
      pointerRaw,
    );
    const manifestFilename = identityManifestFilename(pointer.manifest.manifest_id);
    const registryFilename = connectionRegistryFilename(
      pointer.connection_registry.registry_id,
      pointer.connection_registry.revision,
    );
    const policyFilename = publicationPolicyFilename(
      pointer.default_publication_policy.policy_id,
      pointer.default_publication_policy.version,
    );
    const expectedManifestPath = `manifests/${manifestFilename}`;
    const expectedRegistryPath = `registries/${registryFilename}`;
    const expectedPolicyPath = `policies/${policyFilename}`;
    if (
      pointer.manifest.path !== expectedManifestPath ||
      pointer.connection_registry.path !== expectedRegistryPath ||
      pointer.default_publication_policy.path !== expectedPolicyPath
    ) {
      throw new Error('active identity bundle contains a non-canonical dependency path');
    }

    const manifestRaw = this.manifests.read(manifestFilename);
    const registryRaw = this.registries.read(registryFilename);
    const policyRaw = this.policies.read(policyFilename);
    if (
      sha256Digest(manifestRaw) !== pointer.manifest.sha256 ||
      sha256Digest(registryRaw) !== pointer.connection_registry.sha256 ||
      sha256Digest(policyRaw) !== pointer.default_publication_policy.sha256
    ) {
      throw new Error('active identity bundle dependency digest does not match');
    }
    const manifest = canonicalDocument<LocalIdentityManifestV1>(
      'local-identity-manifest',
      manifestRaw,
    );
    const registry = canonicalDocument<LocalConnectionRegistryV1>(
      'local-connection-registry',
      registryRaw,
    );
    const policy = canonicalDocument<PublicationPolicyV1>(
      'publication-policy',
      policyRaw,
    );
    validateIdentityDocumentSemantics(manifest, registry, policy);
    if (runtimeConfig !== undefined) {
      validateRegistryAgainstRuntime(runtimeConfig, registry);
    }

    if (
      manifest.manifest_id !== pointer.manifest.manifest_id ||
      manifest.installation.installation_id !== pointer.active_installation_id ||
      registry.registry_id !== pointer.connection_registry.registry_id ||
      registry.revision !== pointer.connection_registry.revision ||
      registry.identity_manifest_id !== manifest.manifest_id ||
      policy.policy_id !== pointer.default_publication_policy.policy_id ||
      policy.version !== pointer.default_publication_policy.version ||
      policy.identity_manifest_id !== manifest.manifest_id ||
      policy.organization_id !== manifest.organization.organization_id ||
      policy.issued_by.installation_id !== manifest.installation.installation_id
    ) {
      throw new Error('active identity bundle cross-document identity is inconsistent');
    }

    const publicKey = canonicalBase64(
      manifest.installation.signing_key.public_key_spki_der_base64,
      'installation public key',
    );
    const keyId = manifest.installation.signing_key.key_id;
    if (p256KeyId(publicKey) !== keyId || policy.issued_by.key_id !== keyId) {
      throw new Error('active identity bundle signing key identity is inconsistent');
    }
    verifySignedDocument(manifest, publicKey, keyId);
    verifySignedDocument(registry, publicKey, keyId);
    verifySignedDocument(policy, publicKey, keyId);
    verifySignedDocument(pointer, publicKey, keyId);

    // These are computed rather than trusted, documenting the exact root used
    // by future bundle-update code without accepting caller-supplied paths.
    if (
      portableRelative(this.paths.identityRoot, this.manifests.pathFor(manifestFilename)) !==
        expectedManifestPath ||
      portableRelative(this.paths.identityRoot, this.registries.pathFor(registryFilename)) !==
        expectedRegistryPath ||
      portableRelative(this.paths.identityRoot, this.policies.pathFor(policyFilename)) !==
        expectedPolicyPath
    ) {
      throw new Error('active identity bundle resolved outside its identity root');
    }

    return {
      pointer,
      manifest,
      connectionRegistry: registry,
      publicationPolicy: policy,
      canonical: {
        pointer: pointerRaw,
        manifest: manifestRaw,
        connectionRegistry: registryRaw,
        publicationPolicy: policyRaw,
      },
    };
  }
}
