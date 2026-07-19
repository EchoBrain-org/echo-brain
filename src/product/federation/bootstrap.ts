import type { ProductRuntimeConfig } from '../config.js';
import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from './canonical-json.js';
import { ActiveIdentityBundleStore } from './active-identity-bundle-store.js';
import { connectionRegistryFilename } from './connection-registry-store.js';
import type {
  ActiveIdentityBundleV1,
  AdapterBindingV1,
  IdentityClaimV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
  SignedDocument,
  ToolConnectionV1,
} from './contracts.js';
import { federationId } from './identifiers.js';
import { identityManifestFilename } from './identity-manifest-store.js';
import type { InstallationSigner } from './installation-signer.js';
import { verifyInstallationKeyDescriptor } from './installation-signer.js';
import { publicationPolicyFilename } from './publication-policy-store.js';
import {
  loadPackagedBuildIdentity,
  type PackagedBuildIdentityV1,
} from './build-identity.js';
import {
  validateFederationDocument,
  type FederationSchemaKind,
} from './schema-validation.js';
import {
  createSignedDocument,
  signedPayload,
  verifySignedDocument,
} from './signed-document.js';
import {
  validateIdentityDocumentSemantics,
  validateRegistryAgainstRuntime,
} from './bundle-semantics.js';

export interface FounderBootstrapIds {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  device_id: string;
  installation_id: string;
  manifest_id: string;
  registry_id: string;
  policy_id: string;
}

export interface FounderBootstrapInput {
  ids?: FounderBootstrapIds;
  organization_display_name: string;
  principal_display_name: string;
  device_class: 'byod' | 'managed';
  created_at: string;
  identity_claims: readonly IdentityClaimV1[];
  connections: readonly ToolConnectionV1[];
  bindings: readonly AdapterBindingV1[];
  publication: PublicationSnapshotV1;
}

export interface FounderBootstrapDependencies {
  /** Test seam; production always reads the package-owned generated file. */
  loadBuildIdentity?: () => PackagedBuildIdentityV1;
}

type UnsignedIdentityManifest = Omit<LocalIdentityManifestV1, 'integrity' | 'installation'> & {
  installation: Omit<LocalIdentityManifestV1['installation'], 'signing_key'>;
};
type UnsignedConnectionRegistry = Omit<LocalConnectionRegistryV1, 'integrity'>;
type UnsignedPublicationPolicy = Omit<PublicationPolicyV1, 'integrity' | 'issued_by'>;

export interface FounderBootstrapPlan {
  ids: FounderBootstrapIds;
  manifest: UnsignedIdentityManifest;
  registry: UnsignedConnectionRegistry;
  policy: UnsignedPublicationPolicy;
}

export interface FounderBootstrapResult {
  active: ActiveIdentityBundleV1;
  manifest: LocalIdentityManifestV1;
  registry: LocalConnectionRegistryV1;
  policy: PublicationPolicyV1;
  created_paths: readonly string[];
}

interface SignedImmutableResult<T> {
  document: T;
  raw: string;
  created: boolean;
}

async function createOrReuseSignedImmutable<T extends SignedDocument>(options: {
  store: {
    exists(filename: string): boolean;
    read(filename: string): string;
    create(filename: string, raw: string): { created: boolean };
  };
  filename: string;
  schema: FederationSchemaKind;
  payload: Omit<T, 'integrity'>;
  signer: InstallationSigner;
  installationId: string;
  keyId: `sha256:${string}`;
  publicKey: Buffer;
}): Promise<SignedImmutableResult<T>> {
  if (options.store.exists(options.filename)) {
    const raw = options.store.read(options.filename);
    const document = validateFederationDocument<T>(
      options.schema,
      parseCanonicalJson(raw),
    );
    verifySignedDocument(document, options.publicKey, options.keyId);
    if (canonicalJson(signedPayload(document)) !== canonicalJson(options.payload)) {
      throw new Error(
        `${options.schema} already exists with a different bootstrap payload`,
      );
    }
    return { document, raw, created: false };
  }

  const document = validateFederationDocument<T>(
    options.schema,
    await createSignedDocument(
      options.payload,
      options.signer,
      options.installationId,
      options.keyId,
    ),
  );
  const raw = canonicalJson(document);
  const { created } = options.store.create(options.filename, raw);
  return { document, raw, created };
}

export function mintFounderBootstrapIds(): FounderBootstrapIds {
  return {
    organization_id: federationId('org'),
    principal_id: federationId('prn'),
    membership_id: federationId('mem'),
    device_id: federationId('dev'),
    installation_id: federationId('ins'),
    manifest_id: federationId('idm'),
    registry_id: federationId('reg'),
    policy_id: federationId('pol'),
  };
}

function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new Error(`${label} must contain 1-200 characters`);
  }
  return trimmed;
}

function assertBuildIdentity(build: PackagedBuildIdentityV1): void {
  if (build.product_version.trim() === '') throw new Error('product version is required');
  if (!/^[a-f0-9]{40}$/.test(build.source_sha)) {
    throw new Error('bootstrap requires the full lowercase source commit SHA');
  }
  if (build.source_kind !== 'materialized-commit') {
    throw new Error('bootstrap requires a package built from one materialized commit');
  }
}

function founderBuildIdentity(
  dependencies: FounderBootstrapDependencies,
): PackagedBuildIdentityV1 {
  const build = (dependencies.loadBuildIdentity ?? loadPackagedBuildIdentity)();
  assertBuildIdentity(build);
  return build;
}

function assertFounderBootstrapPlanIds(plan: FounderBootstrapPlan): void {
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    ['organization_id', plan.ids.organization_id, plan.manifest.organization.organization_id],
    ['principal_id', plan.ids.principal_id, plan.manifest.principal.principal_id],
    ['membership_id', plan.ids.membership_id, plan.manifest.membership.membership_id],
    ['device_id', plan.ids.device_id, plan.manifest.installation.device_id],
    ['installation_id', plan.ids.installation_id, plan.manifest.installation.installation_id],
    ['manifest_id', plan.ids.manifest_id, plan.manifest.manifest_id],
    ['registry_id', plan.ids.registry_id, plan.registry.registry_id],
    ['policy_id', plan.ids.policy_id, plan.policy.policy_id],
  ];
  const mismatches = expected
    .filter(([, planned, embedded]) => planned !== embedded)
    .map(([label]) => label);
  if (mismatches.length > 0) {
    throw new Error(
      `bootstrap plan IDs do not match their embedded documents: ${mismatches.join(', ')}`,
    );
  }
}

export function planFounderBootstrap(
  input: FounderBootstrapInput,
  dependencies: FounderBootstrapDependencies = {},
): FounderBootstrapPlan {
  const ids = input.ids ?? mintFounderBootstrapIds();
  const build = founderBuildIdentity(dependencies);
  const organizationName = nonBlank(
    input.organization_display_name,
    'organization display name',
  );
  const principalName = nonBlank(input.principal_display_name, 'principal display name');
  const manifest: UnsignedIdentityManifest = {
    schema_version: 1,
    kind: 'echo-local-identity-manifest',
    manifest_id: ids.manifest_id,
    predecessor_manifest_id: null,
    created_at: input.created_at,
    authority: {
      kind: 'local-founder-bootstrap',
      assurance: 'founder_attested',
    },
    organization: {
      organization_id: ids.organization_id,
      display_name: organizationName,
      created_at: input.created_at,
    },
    principal: {
      principal_id: ids.principal_id,
      organization_id: ids.organization_id,
      kind: 'human',
      display_name: principalName,
    },
    membership: {
      membership_id: ids.membership_id,
      organization_id: ids.organization_id,
      principal_id: ids.principal_id,
      type: 'owner',
      status: 'active',
      valid_from: input.created_at,
    },
    installation: {
      installation_id: ids.installation_id,
      organization_id: ids.organization_id,
      membership_id: ids.membership_id,
      device_id: ids.device_id,
      device_class: input.device_class,
      enrolled_at: input.created_at,
      product: {
        name: 'echo-brain',
        version: build.product_version,
        source_sha: build.source_sha,
      },
    },
    identity_claims: input.identity_claims,
    legacy_cutover: {
      declared_at: input.created_at,
      pre_cutover_default: 'disposable_test',
      native_records_require: [
        'source-attribution-v1',
        'processor-attribution-v1',
        'approval-context-v1',
        'signed-outbox-v1',
      ],
    },
  };
  const registry: UnsignedConnectionRegistry = {
    schema_version: 1,
    kind: 'echo-local-connection-registry',
    registry_id: ids.registry_id,
    identity_manifest_id: ids.manifest_id,
    revision: 1,
    previous_registry_sha256: null,
    updated_at: input.created_at,
    connections: input.connections,
    bindings: input.bindings,
  };
  const policy: UnsignedPublicationPolicy = {
    schema_version: 1,
    kind: 'echo-publication-policy',
    policy_id: ids.policy_id,
    organization_id: ids.organization_id,
    identity_manifest_id: ids.manifest_id,
    version: 1,
    effective_at: input.created_at,
    publication: input.publication,
  };
  return { ids, manifest, registry, policy };
}

export async function commitFounderBootstrap(
  config: ProductRuntimeConfig,
  plan: FounderBootstrapPlan,
  signer: InstallationSigner,
  dependencies: FounderBootstrapDependencies = {},
): Promise<FounderBootstrapResult> {
  const store = new ActiveIdentityBundleStore(config.state_dir);
  assertFounderBootstrapPlanIds(plan);
  validateIdentityDocumentSemantics(plan.manifest, plan.registry, plan.policy);
  validateRegistryAgainstRuntime(config, plan.registry);
  const build = founderBuildIdentity(dependencies);
  if (
    plan.manifest.installation.product.name !== 'echo-brain' ||
    plan.manifest.installation.product.version !== build.product_version ||
    plan.manifest.installation.product.source_sha !== build.source_sha
  ) {
    throw new Error(
      'bootstrap plan product identity does not match the packaged build',
    );
  }
  if (store.hasActiveBundle()) {
    const verified = store.loadVerified(config);
    if (verified === null) {
      throw new Error('active identity bundle disappeared during bootstrap recovery');
    }
    const manifestPayload = signedPayload(verified.manifest);
    const registryPayload = signedPayload(verified.connectionRegistry);
    const policyPayload = signedPayload(verified.publicationPolicy);
    const expectedManifest = {
      ...plan.manifest,
      installation: {
        ...plan.manifest.installation,
        signing_key: verified.manifest.installation.signing_key,
      },
    };
    const expectedPolicy = {
      ...plan.policy,
      issued_by: verified.publicationPolicy.issued_by,
    };
    if (
      canonicalJson(manifestPayload) !== canonicalJson(expectedManifest) ||
      canonicalJson(registryPayload) !== canonicalJson(plan.registry) ||
      canonicalJson(policyPayload) !== canonicalJson(expectedPolicy) ||
      verified.pointer.active_installation_id !== plan.ids.installation_id
    ) {
      throw new Error('another identity bootstrap is already active');
    }
    return {
      active: verified.pointer,
      manifest: verified.manifest,
      registry: verified.connectionRegistry,
      policy: verified.publicationPolicy,
      created_paths: [],
    };
  }

  const key = await signer.generate(plan.ids.installation_id);
  const publicKey = verifyInstallationKeyDescriptor(key);
  if (key.installation_id !== plan.ids.installation_id) {
    throw new Error('installation signer generated a key for a different installation');
  }
  if (
    key.protection !== 'secure-enclave' ||
    key.assurance !== 'hardware_bound'
  ) {
    throw new Error(
      'founder seed bootstrap requires a non-exportable Secure Enclave key',
    );
  }
  // Parsing the descriptor validates the key fingerprint and P-256 SPKI before
  // any immutable identity file is written.
  if (publicKey.length === 0) throw new Error('installation public key is empty');

  const manifestFilename = identityManifestFilename(plan.ids.manifest_id);
  const registryFilename = connectionRegistryFilename(plan.ids.registry_id, 1);
  const policyFilename = publicationPolicyFilename(plan.ids.policy_id, 1);
  const manifestResult =
    await createOrReuseSignedImmutable<LocalIdentityManifestV1>({
      store: store.manifests,
      filename: manifestFilename,
      schema: 'local-identity-manifest',
      payload: {
        ...plan.manifest,
        installation: {
          ...plan.manifest.installation,
          signing_key: {
            key_id: key.key_id,
            algorithm: key.algorithm,
            public_key_spki_der_base64: key.public_key_spki_der_base64,
            protection: key.protection,
            assurance: key.assurance,
          },
        },
      },
      signer,
      installationId: plan.ids.installation_id,
      keyId: key.key_id,
      publicKey,
    });
  const registryResult =
    await createOrReuseSignedImmutable<LocalConnectionRegistryV1>({
      store: store.registries,
      filename: registryFilename,
      schema: 'local-connection-registry',
      payload: plan.registry,
      signer,
      installationId: plan.ids.installation_id,
      keyId: key.key_id,
      publicKey,
    });
  const policyResult =
    await createOrReuseSignedImmutable<PublicationPolicyV1>({
      store: store.policies,
      filename: policyFilename,
      schema: 'publication-policy',
      payload: {
        ...plan.policy,
        issued_by: {
          installation_id: plan.ids.installation_id,
          key_id: key.key_id,
        },
      },
      signer,
      installationId: plan.ids.installation_id,
      keyId: key.key_id,
      publicKey,
    });
  const manifest = manifestResult.document;
  const registry = registryResult.document;
  const policy = policyResult.document;
  const manifestRaw = manifestResult.raw;
  const registryRaw = registryResult.raw;
  const policyRaw = policyResult.raw;
  const createdPaths: string[] = [];
  if (manifestResult.created) {
    createdPaths.push(store.manifests.pathFor(manifestFilename));
  }
  if (registryResult.created) {
    createdPaths.push(store.registries.pathFor(registryFilename));
  }
  if (policyResult.created) {
    createdPaths.push(store.policies.pathFor(policyFilename));
  }

  const activePayload: Omit<ActiveIdentityBundleV1, 'integrity'> = {
    schema_version: 1,
    kind: 'echo-active-identity-bundle',
    manifest: {
      manifest_id: plan.ids.manifest_id,
      path: `manifests/${manifestFilename}`,
      sha256: sha256Digest(manifestRaw),
    },
    connection_registry: {
      registry_id: plan.ids.registry_id,
      revision: 1,
      path: `registries/${registryFilename}`,
      sha256: sha256Digest(registryRaw),
    },
    default_publication_policy: {
      policy_id: plan.ids.policy_id,
      version: 1,
      path: `policies/${policyFilename}`,
      sha256: sha256Digest(policyRaw),
    },
    active_installation_id: plan.ids.installation_id,
    activated_at: plan.manifest.created_at,
    activation_reason: 'founder-bootstrap',
  };
  const active = await createSignedDocument(
    activePayload,
    signer,
    plan.ids.installation_id,
    key.key_id,
  );
  validateFederationDocument<ActiveIdentityBundleV1>(
    'active-identity-bundle',
    active,
  );
  store.createInitialPointer(canonicalJson(active));
  createdPaths.push(store.paths.activeIdentityBundle);
  store.loadVerified(config);
  return {
    active,
    manifest,
    registry,
    policy,
    created_paths: createdPaths,
  };
}
