import { readdirSync } from 'node:fs';
import type { JsonObject } from '../../core/index.js';
import { resolveProductStatePaths, type ProductStatePaths } from '../paths.js';
import {
  assertPrivateOwnedDirectory,
  pathEntryExists,
} from '../secure-local-files.js';
import { ActiveIdentityBundleStore } from './active-identity-bundle-store.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './canonical-json.js';
import {
  connectionRegistryFilename,
  ConnectionRegistryStore,
} from './connection-registry-store.js';
import type {
  AdapterBindingV1,
  AdapterCapability,
  IdentityOwnerV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from './contracts.js';
import {
  identityManifestFilename,
  IdentityManifestStore,
} from './identity-manifest-store.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from './identifiers.js';
import { p256KeyId } from './signature-profile.js';
import {
  publicationPolicyFilename,
  PublicationPolicyStore,
} from './publication-policy-store.js';
import {
  validateFederationDocument,
  type FederationSchemaKind,
} from './schema-validation.js';
import { verifySignedDocument } from './signed-document.js';

const REGISTRY_FILENAME =
  /^connection-registry\.(reg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.r([1-9][0-9]*)\.v1\.json$/;
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

interface RegistryFile {
  filename: string;
  registryId: string;
  revision: number;
}

interface ManifestMaterial extends VerifiedHistoricalIdentityManifest {
  publicKey: Buffer;
}

function fail(message: string): never {
  throw new Error(`identity lineage verification failed: ${message}`);
}

function canonicalDocument<T>(kind: FederationSchemaKind, raw: string): T {
  const parsed = parseCanonicalJson(raw);
  return validateFederationDocument<T>(kind, parsed);
}

function canonicalPublicKey(manifest: LocalIdentityManifestV1): Buffer {
  const encoded = manifest.installation.signing_key.public_key_spki_der_base64;
  const publicKey = Buffer.from(encoded, 'base64');
  if (publicKey.length === 0 || publicKey.toString('base64') !== encoded) {
    fail('historical manifest public key is not canonical base64');
  }
  if (p256KeyId(publicKey) !== manifest.installation.signing_key.key_id) {
    fail('historical manifest public key does not match key_id');
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
    fail('historical manifest identity graph is inconsistent');
  }
  for (const [label, timestamp] of [
    ['manifest.created_at', manifest.created_at],
    ['organization.created_at', manifest.organization.created_at],
    ['membership.valid_from', manifest.membership.valid_from],
    ['installation.enrolled_at', manifest.installation.enrolled_at],
    ['legacy_cutover.declared_at', manifest.legacy_cutover.declared_at],
  ] as const) {
    assertUtcMillisecondTimestamp(timestamp, label);
  }
  const claimIds = new Set<string>();
  for (const claim of manifest.identity_claims) {
    if (claimIds.has(claim.claim_id)) {
      fail('historical manifest contains duplicate claim IDs');
    }
    claimIds.add(claim.claim_id);
    if (claim.principal_id !== manifest.principal.principal_id) {
      fail('historical manifest claim belongs to another principal');
    }
    assertUtcMillisecondTimestamp(
      claim.verification.verified_at,
      'historical identity claim verified_at',
    );
    if (claim.verification.verified_at > manifest.created_at) {
      fail('historical identity claim was verified after its signed manifest');
    }
    if (
      claim.verification.method === 'slack_dm_challenge' &&
      (claim.issuer.kind !== 'provider' ||
        claim.issuer.provider !== 'slack' ||
        claim.subject.kind !== 'user' ||
        claim.verification.assurance !== 'provider_challenge_observed')
    ) {
      fail('historical Slack identity claim overstates its assurance');
    }
    if (
      claim.verification.method === 'oidc_id_token' &&
      (claim.issuer.kind !== 'oidc' ||
        claim.subject.kind !== 'oidc_sub' ||
        claim.verification.assurance !== 'provider_verified')
    ) {
      fail('historical OIDC identity claim overstates its assurance');
    }
  }
}

function expectedProvider(adapterId: string): string | null {
  if (adapterId === 'granola') return 'granola';
  if (adapterId === 'slack' || adapterId === 'slack-reactions') {
    return 'slack';
  }
  return null;
}

function assertPolicySemantics(
  manifest: LocalIdentityManifestV1,
  policy: PublicationPolicyV1,
): void {
  assertUtcMillisecondTimestamp(
    policy.effective_at,
    'historical policy effective_at',
  );
  if (
    policy.identity_manifest_id !== manifest.manifest_id ||
    policy.organization_id !== manifest.organization.organization_id ||
    policy.issued_by.installation_id !==
      manifest.installation.installation_id ||
    policy.issued_by.key_id !== manifest.installation.signing_key.key_id
  ) {
    fail('historical policy belongs to another identity lineage');
  }
  if (
    policy.publication.audience.subjects.some(
      (subject) =>
        !(
          (subject.kind === 'organization' &&
            subject.id === manifest.organization.organization_id) ||
          (subject.kind === 'membership' &&
            subject.id === manifest.membership.membership_id)
        ),
    )
  ) {
    fail('historical policy contains an unknown local audience subject');
  }
  if (
    policy.publication.audience.scope === 'organization' &&
    (policy.publication.audience.subjects.length !== 1 ||
      policy.publication.audience.subjects[0]?.kind !== 'organization' ||
      policy.publication.audience.subjects[0].id !==
        manifest.organization.organization_id)
  ) {
    fail('historical organization policy has a non-canonical audience');
  }
}

function lifecycleContains(
  observedAt: string,
  startedAt: string,
  endedAt: string | null,
): boolean {
  return observedAt >= startedAt && (endedAt === null || observedAt < endedAt);
}

function connectionIdentity(connection: ToolConnectionV1) {
  return {
    connection_id: connection.connection_id,
    organization_id: connection.organization_id,
    owner: connection.owner,
    provider: connection.provider,
  };
}

function generationIdentity(generation: ToolConnectionGenerationV1) {
  return {
    generation: generation.generation,
    active_from: generation.active_from,
    provider_identity: generation.provider_identity,
    local_credential_guard: generation.local_credential_guard,
  };
}

function bindingIdentity(binding: AdapterBindingV1) {
  return {
    adapter_binding_id: binding.adapter_binding_id,
    capability: binding.capability,
    adapter_id: binding.adapter_id,
    instance_id: binding.instance_id,
    connection_id: binding.connection_id,
    connection_generation: binding.connection_generation,
    configuration_snapshot: binding.configuration_snapshot,
    configuration_sha256: binding.configuration_sha256,
    created_at: binding.created_at,
  };
}

function assertLifecycleClosure(
  priorStatus: 'active' | 'retired',
  priorEndedAt: string | null,
  currentStatus: 'active' | 'retired',
  currentEndedAt: string | null,
  label: string,
): void {
  if (priorEndedAt !== null) {
    if (currentStatus !== 'retired' || currentEndedAt !== priorEndedAt) {
      fail(`${label} changed after retirement`);
    }
    return;
  }
  if (
    (priorStatus === 'active' &&
      currentStatus === 'active' &&
      currentEndedAt === null) ||
    (priorStatus === 'active' &&
      currentStatus === 'retired' &&
      currentEndedAt !== null)
  ) {
    return;
  }
  fail(`${label} has an invalid lifecycle transition`);
}

function assertGenerationClosure(
  prior: ToolConnectionGenerationV1,
  current: ToolConnectionGenerationV1,
  label: string,
): void {
  if (
    canonicalJson(generationIdentity(prior)) !==
    canonicalJson(generationIdentity(current))
  ) {
    fail(`${label} changed immutable generation identity`);
  }
  if (
    (prior.ended_at === null && current.ended_at !== null) ||
    prior.ended_at === current.ended_at
  ) {
    return;
  }
  fail(`${label} has an invalid lifecycle transition`);
}

function assertRegistrySemantics(
  manifest: LocalIdentityManifestV1,
  registry: LocalConnectionRegistryV1,
): void {
  if (registry.identity_manifest_id !== manifest.manifest_id) {
    fail('registry belongs to another identity manifest');
  }
  assertUtcMillisecondTimestamp(
    registry.updated_at,
    'historical registry updated_at',
  );
  const connections = new Map<string, ToolConnectionV1>();
  for (const connection of registry.connections) {
    if (connections.has(connection.connection_id)) {
      fail('registry contains duplicate connection IDs');
    }
    connections.set(connection.connection_id, connection);
    if (connection.organization_id !== manifest.organization.organization_id) {
      fail(
        `connection ${connection.connection_id} belongs to another organization`,
      );
    }
    const owner: IdentityOwnerV1 = connection.owner;
    if (
      (owner.kind === 'organization' &&
        owner.id !== manifest.organization.organization_id) ||
      (owner.kind === 'membership' &&
        owner.id !== manifest.membership.membership_id)
    ) {
      fail(`connection ${connection.connection_id} has an unknown owner`);
    }
    const generations = new Set<number>();
    let activeGenerations = 0;
    for (const generation of connection.generations) {
      if (generations.has(generation.generation)) {
        fail(
          `connection ${connection.connection_id} has duplicate generations`,
        );
      }
      generations.add(generation.generation);
      if (generation.ended_at === null) activeGenerations += 1;
      assertUtcMillisecondTimestamp(
        generation.active_from,
        'historical connection generation active_from',
      );
      assertUtcMillisecondTimestamp(
        generation.provider_identity.verification.verified_at,
        'historical provider identity verified_at',
      );
      if (
        generation.provider_identity.verification.verified_at >
          generation.active_from ||
        generation.active_from > registry.updated_at
      ) {
        fail(
          `connection ${connection.connection_id} has impossible verification or activation time`,
        );
      }
      if (
        generation.ended_at !== null &&
        generation.ended_at < generation.active_from
      ) {
        fail(
          `connection ${connection.connection_id} has an inverted lifecycle`,
        );
      }
      if (generation.ended_at !== null) {
        assertUtcMillisecondTimestamp(
          generation.ended_at,
          'historical connection generation ended_at',
        );
      }
      if (
        connection.provider === 'slack' &&
        (generation.provider_identity.tenant?.kind !== 'slack-team' ||
          generation.provider_identity.subject?.kind !== 'bot-installation' ||
          generation.provider_identity.verification.method !==
            'slack_auth_test' ||
          generation.provider_identity.verification.assurance !==
            'provider_verified')
      ) {
        fail('historical Slack connection lacks a verified team and bot');
      }
      if (
        connection.provider === 'granola' &&
        generation.provider_identity.verification.method ===
          'provider_first_capture' &&
        (generation.provider_identity.tenant !== null ||
          generation.provider_identity.subject !== null ||
          generation.provider_identity.verification.assurance !==
            'credential_observed')
      ) {
        fail('historical Granola connection overstates provider identity');
      }
    }
    if (activeGenerations > 1) {
      fail(
        `connection ${connection.connection_id} has multiple active generations`,
      );
    }
  }

  const bindings = new Map<string, AdapterBindingV1>();
  const activeSlots = new Set<string>();
  for (const binding of registry.bindings) {
    if (bindings.has(binding.adapter_binding_id)) {
      fail('registry contains duplicate binding IDs');
    }
    bindings.set(binding.adapter_binding_id, binding);
    if (
      canonicalSha256(binding.configuration_snapshot) !==
      binding.configuration_sha256
    ) {
      fail(
        `binding ${binding.adapter_binding_id} configuration digest is invalid`,
      );
    }
    assertUtcMillisecondTimestamp(
      binding.created_at,
      'historical binding created_at',
    );
    if (binding.created_at > registry.updated_at) {
      fail(
        `binding ${binding.adapter_binding_id} postdates its registry record`,
      );
    }
    if (
      (binding.status === 'active' && binding.ended_at !== null) ||
      (binding.status === 'retired' && binding.ended_at === null) ||
      (binding.ended_at !== null && binding.ended_at < binding.created_at)
    ) {
      fail(`binding ${binding.adapter_binding_id} has an invalid lifecycle`);
    }
    if (binding.status === 'active') {
      const slot = `${binding.capability}:${binding.adapter_id}:${binding.instance_id}`;
      if (activeSlots.has(slot)) {
        fail(`registry contains duplicate active binding slot ${slot}`);
      }
      activeSlots.add(slot);
    }
    if (binding.connection_id === null) {
      if (binding.connection_generation !== null) {
        fail(`binding ${binding.adapter_binding_id} has a dangling generation`);
      }
      continue;
    }
    const connection = connections.get(binding.connection_id);
    const generation = connection?.generations.find(
      (item) => item.generation === binding.connection_generation,
    );
    if (connection === undefined || generation === undefined) {
      fail(
        `binding ${binding.adapter_binding_id} has a missing connection generation`,
      );
    }
    if (binding.status === 'active' && generation.ended_at !== null) {
      fail(`binding ${binding.adapter_binding_id} uses a retired generation`);
    }
    const provider = expectedProvider(binding.adapter_id);
    if (provider !== null && connection.provider !== provider) {
      fail(`binding ${binding.adapter_binding_id} uses the wrong provider`);
    }
  }

  const activeSlackApprovals = [...bindings.values()].filter(
    (binding) =>
      binding.status === 'active' &&
      binding.capability === 'approval-surface' &&
      binding.adapter_id === 'slack-reactions',
  );
  for (const claim of manifest.identity_claims) {
    if (claim.issuer.kind !== 'provider' || claim.issuer.provider !== 'slack') {
      continue;
    }
    if (activeSlackApprovals.length !== 1) {
      fail('historical Slack claim lacks one active approval binding');
    }
    const binding = activeSlackApprovals[0]!;
    const connection =
      binding.connection_id === null
        ? undefined
        : connections.get(binding.connection_id);
    const generation = connection?.generations.find(
      (item) => item.generation === binding.connection_generation,
    );
    if (
      connection?.provider !== 'slack' ||
      generation?.provider_identity.tenant?.kind !== 'slack-team' ||
      generation.provider_identity.tenant.id !== claim.issuer.tenant_id
    ) {
      fail('historical Slack claim and approval binding disagree on workspace');
    }
  }
}

function assertAppendOnlyRevision(
  previous: LocalConnectionRegistryV1,
  current: LocalConnectionRegistryV1,
): void {
  const currentConnections = new Map(
    current.connections.map((connection) => [
      connection.connection_id,
      connection,
    ]),
  );
  for (const priorConnection of previous.connections) {
    const connection = currentConnections.get(priorConnection.connection_id);
    if (
      connection === undefined ||
      canonicalJson(connectionIdentity(connection)) !==
        canonicalJson(connectionIdentity(priorConnection))
    ) {
      fail(
        `connection ${priorConnection.connection_id} was removed or rewritten`,
      );
    }
    const currentGenerations = new Map(
      connection.generations.map((generation) => [
        generation.generation,
        generation,
      ]),
    );
    for (const priorGeneration of priorConnection.generations) {
      const generation = currentGenerations.get(priorGeneration.generation);
      if (generation === undefined) {
        fail(
          `connection ${priorConnection.connection_id} generation ${priorGeneration.generation} was removed`,
        );
      }
      assertGenerationClosure(
        priorGeneration,
        generation,
        `connection ${priorConnection.connection_id} generation ${priorGeneration.generation}`,
      );
    }
  }

  const currentBindings = new Map(
    current.bindings.map((binding) => [binding.adapter_binding_id, binding]),
  );
  for (const priorBinding of previous.bindings) {
    const binding = currentBindings.get(priorBinding.adapter_binding_id);
    if (
      binding === undefined ||
      canonicalJson(bindingIdentity(binding)) !==
        canonicalJson(bindingIdentity(priorBinding))
    ) {
      fail(
        `binding ${priorBinding.adapter_binding_id} was removed or rewritten`,
      );
    }
    assertLifecycleClosure(
      priorBinding.status,
      priorBinding.ended_at,
      binding.status,
      binding.ended_at,
      `binding ${priorBinding.adapter_binding_id}`,
    );
  }
}

function exactBindingMatch(
  binding: AdapterBindingV1,
  reference: HistoricalBindingReference,
): boolean {
  return (
    binding.adapter_binding_id === reference.adapter_binding_id &&
    binding.capability === reference.capability &&
    binding.adapter_id === reference.adapter_id &&
    binding.instance_id === reference.instance_id &&
    binding.connection_id === reference.connection_id &&
    binding.connection_generation === reference.connection_generation &&
    binding.configuration_sha256 === reference.configuration_sha256 &&
    canonicalJson(binding.configuration_snapshot) ===
      canonicalJson(reference.configuration_snapshot)
  );
}

export class IdentityLineageStore {
  readonly paths: ProductStatePaths;
  private readonly activeBundle: ActiveIdentityBundleStore;
  private readonly manifests: IdentityManifestStore;
  private readonly registries: ConnectionRegistryStore;
  private readonly policies: PublicationPolicyStore;

  constructor(stateDirectory: string) {
    this.paths = resolveProductStatePaths(stateDirectory);
    this.activeBundle = new ActiveIdentityBundleStore(stateDirectory);
    this.manifests = new IdentityManifestStore(this.paths);
    this.registries = new ConnectionRegistryStore(this.paths);
    this.policies = new PublicationPolicyStore(this.paths);
  }

  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest {
    const material = this.loadAnchoredManifestMaterial(manifestId);
    const { publicKey: _publicKey, ...verified } = material;
    return verified;
  }

  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest {
    const material = this.loadActiveManifestLineage()[0];
    if (material === undefined) {
      fail('there is no verified active identity manifest');
    }
    const { publicKey: _publicKey, ...verified } = material;
    return verified;
  }

  loadVerifiedManifestBySha256(
    sha256: Sha256Digest,
  ): VerifiedHistoricalIdentityManifest {
    if (!SHA256_DIGEST.test(sha256)) {
      fail('historical manifest digest is not a canonical SHA-256 digest');
    }
    const matches = this.loadActiveManifestLineage().filter(
      (material) => material.sha256 === sha256,
    );
    if (matches.length !== 1) {
      fail(
        matches.length === 0
          ? `manifest digest ${sha256} is not reachable from the active identity lineage`
          : `manifest digest ${sha256} resolves to more than one active-lineage manifest`,
      );
    }
    const { publicKey: _publicKey, ...verified } = matches[0]!;
    return verified;
  }

  /**
   * Proves ordering inside the one signed predecessor chain anchored by the
   * active identity bundle. Equality is valid; a newer manifest can never be
   * used to justify an earlier processing stage.
   */
  assertManifestAncestorOrEqual(
    ancestorManifestId: string,
    descendantManifestId: string,
  ): void {
    assertFederationId(
      ancestorManifestId,
      'idm',
      'ancestor_identity_manifest_id',
    );
    assertFederationId(
      descendantManifestId,
      'idm',
      'descendant_identity_manifest_id',
    );
    const lineage = this.loadActiveManifestLineage();
    const ancestorIndex = lineage.findIndex(
      (material) => material.manifest.manifest_id === ancestorManifestId,
    );
    const descendantIndex = lineage.findIndex(
      (material) => material.manifest.manifest_id === descendantManifestId,
    );
    if (ancestorIndex === -1 || descendantIndex === -1) {
      fail('manifest order references identity outside the active lineage');
    }
    // `loadActiveManifestLineage` is ordered active/newest to root/oldest.
    if (ancestorIndex < descendantIndex) {
      fail(
        `manifest ${ancestorManifestId} is not an ancestor of ${descendantManifestId}`,
      );
    }
  }

  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy {
    assertUtcMillisecondTimestamp(observedAt, 'policy observed_at');
    assertFederationId(reference.policy_id, 'pol', 'policy_id');
    assertFederationId(
      reference.identity_manifest_id,
      'idm',
      'identity_manifest_id',
    );
    assertFederationId(
      reference.signer_installation_id,
      'ins',
      'signer_installation_id',
    );
    const manifest = this.loadAnchoredManifestMaterial(
      reference.identity_manifest_id,
    );
    this.assertDirectory(
      this.paths.identityPolicies,
      'identity policy directory',
    );
    const filename = publicationPolicyFilename(
      reference.policy_id,
      reference.version,
    );
    const raw = this.policies.read(filename);
    const sha256 = sha256Digest(raw);
    if (sha256 !== reference.policy_sha256) {
      fail(
        'historical policy file digest does not match its recorded snapshot',
      );
    }
    const policy = canonicalDocument<PublicationPolicyV1>(
      'publication-policy',
      raw,
    );
    if (
      policy.policy_id !== reference.policy_id ||
      policy.version !== reference.version ||
      policy.identity_manifest_id !== reference.identity_manifest_id ||
      policy.issued_by.installation_id !== reference.signer_installation_id ||
      policy.issued_by.key_id !== reference.signer_key_id
    ) {
      fail('historical policy reference does not match the signed document');
    }
    assertPolicySemantics(manifest.manifest, policy);
    if (
      observedAt < manifest.manifest.legacy_cutover.declared_at ||
      policy.effective_at > observedAt
    ) {
      fail('historical policy was not effective at the observation time');
    }
    verifySignedDocument(
      policy,
      manifest.publicKey,
      manifest.manifest.installation.signing_key.key_id,
    );
    return { policy, manifest: manifest.manifest, canonical: raw, sha256 };
  }

  loadVerifiedRegistryChain(
    manifestId: string,
    registryId: string,
  ): VerifiedHistoricalRegistryChain {
    assertFederationId(manifestId, 'idm', 'identity_manifest_id');
    assertFederationId(registryId, 'reg', 'registry_id');
    const files = this.registryFiles().get(registryId);
    if (files === undefined || files.length === 0) {
      fail(`registry chain ${registryId} does not exist`);
    }
    return this.verifyRegistryChain(manifestId, registryId, files);
  }

  enumerateVerifiedRegistryChains(
    manifestId: string,
  ): readonly VerifiedHistoricalRegistryChain[] {
    assertFederationId(manifestId, 'idm', 'identity_manifest_id');
    const chains: VerifiedHistoricalRegistryChain[] = [];
    for (const [registryId, files] of this.registryFiles()) {
      const manifestIds = new Set(
        files.map((file) => {
          const raw = this.registries.read(file.filename);
          return canonicalDocument<LocalConnectionRegistryV1>(
            'local-connection-registry',
            raw,
          ).identity_manifest_id;
        }),
      );
      if (manifestIds.size !== 1) {
        fail(`registry chain ${registryId} crosses identity manifests`);
      }
      if (manifestIds.has(manifestId)) {
        chains.push(this.verifyRegistryChain(manifestId, registryId, files));
      }
    }
    return chains.sort((left, right) =>
      left.registry_id.localeCompare(right.registry_id),
    );
  }

  resolveBindingAt(
    reference: HistoricalBindingReference,
    observedAt: string,
  ): ResolvedHistoricalBinding {
    this.assertBindingCoordinates(reference, observedAt);
    if (
      canonicalSha256(reference.configuration_snapshot) !==
      reference.configuration_sha256
    ) {
      fail('binding reference configuration digest is invalid');
    }
    return this.resolveBindingMatchingAt(reference, observedAt, (binding) =>
      exactBindingMatch(binding, reference),
    );
  }

  resolveBindingSnapshotAt(
    locator: HistoricalBindingSnapshotLocator,
    observedAt: string,
  ): ResolvedHistoricalBinding {
    this.assertBindingCoordinates(locator, observedAt);
    return this.resolveBindingMatchingAt(
      locator,
      observedAt,
      (binding) =>
        binding.configuration_sha256 === locator.configuration_sha256 &&
        binding.connection_id === locator.connection_id &&
        binding.connection_generation === locator.connection_generation,
    );
  }

  private assertBindingCoordinates(
    reference: Pick<
      HistoricalBindingReference,
      | 'identity_manifest_id'
      | 'adapter_binding_id'
      | 'connection_id'
      | 'connection_generation'
    >,
    observedAt: string,
  ): void {
    assertFederationId(
      reference.identity_manifest_id,
      'idm',
      'identity_manifest_id',
    );
    assertFederationId(
      reference.adapter_binding_id,
      'bnd',
      'adapter_binding_id',
    );
    assertUtcMillisecondTimestamp(observedAt, 'binding observed_at');
    if (
      (reference.connection_id === null) !==
      (reference.connection_generation === null)
    ) {
      fail(
        'binding reference connection and generation must both be null or both be set',
      );
    }
    if (reference.connection_id !== null) {
      assertFederationId(reference.connection_id, 'con', 'connection_id');
      if (
        !Number.isSafeInteger(reference.connection_generation) ||
        (reference.connection_generation as number) < 1
      ) {
        fail('connection_generation must be a positive safe integer');
      }
    }
  }

  private resolveBindingMatchingAt(
    reference: Pick<
      HistoricalBindingReference,
      | 'identity_manifest_id'
      | 'adapter_binding_id'
      | 'connection_id'
      | 'connection_generation'
    >,
    observedAt: string,
    matchesBinding: (binding: AdapterBindingV1) => boolean,
  ): ResolvedHistoricalBinding {
    const manifest = this.loadVerifiedManifest(reference.identity_manifest_id);
    if (observedAt < manifest.manifest.legacy_cutover.declared_at) {
      fail('binding observation predates the identity cutover');
    }
    const matches: ResolvedHistoricalBinding[] = [];
    for (const chain of this.enumerateVerifiedRegistryChains(
      reference.identity_manifest_id,
    )) {
      const eligible = chain.revisions.filter(
        (revision) => revision.registry.updated_at <= observedAt,
      );
      const revision = eligible.at(-1);
      if (revision === undefined) continue;
      const binding = revision.registry.bindings.find(
        (item) => item.adapter_binding_id === reference.adapter_binding_id,
      );
      if (binding === undefined) continue;
      if (!matchesBinding(binding)) {
        fail('historical binding ID resolves to different immutable facts');
      }
      const terminal = chain.revisions.at(-1)!;
      const terminalBinding = terminal.registry.bindings.find(
        (item) => item.adapter_binding_id === reference.adapter_binding_id,
      );
      if (
        terminalBinding === undefined ||
        !lifecycleContains(
          observedAt,
          binding.created_at,
          terminalBinding.ended_at,
        )
      ) {
        continue;
      }

      let connection: ToolConnectionV1 | null = null;
      let generation: ToolConnectionGenerationV1 | null = null;
      if (reference.connection_id !== null) {
        connection =
          revision.registry.connections.find(
            (item) => item.connection_id === reference.connection_id,
          ) ?? null;
        generation =
          connection?.generations.find(
            (item) => item.generation === reference.connection_generation,
          ) ?? null;
        const terminalConnection = terminal.registry.connections.find(
          (item) => item.connection_id === reference.connection_id,
        );
        const terminalGeneration = terminalConnection?.generations.find(
          (item) => item.generation === reference.connection_generation,
        );
        if (
          connection === null ||
          generation === null ||
          terminalGeneration === undefined ||
          !lifecycleContains(
            observedAt,
            generation.active_from,
            terminalGeneration.ended_at,
          )
        ) {
          continue;
        }
      }
      matches.push({
        manifest: manifest.manifest,
        chain,
        revision,
        binding,
        connection,
        generation,
      });
    }
    if (matches.length === 0) {
      fail('no enrolled historical binding matches the observation');
    }
    if (matches.length !== 1) {
      fail('historical binding resolution is ambiguous across registry chains');
    }
    return matches[0]!;
  }

  private loadManifestMaterial(manifestId: string): ManifestMaterial {
    assertFederationId(manifestId, 'idm', 'manifest_id');
    this.assertDirectory(
      this.paths.identityManifests,
      'identity manifest directory',
    );
    const raw = this.manifests.read(identityManifestFilename(manifestId));
    const manifest = canonicalDocument<LocalIdentityManifestV1>(
      'local-identity-manifest',
      raw,
    );
    if (manifest.manifest_id !== manifestId) {
      fail('historical manifest filename and document ID disagree');
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
      fail('there is no verified active identity bundle to anchor history');
    }
    const seen = new Set<string>();
    const lineage: ManifestMaterial[] = [];
    let currentId: string | null = active.manifest.manifest_id;
    let successor: LocalIdentityManifestV1 | undefined;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        fail('active identity manifest predecessor chain contains a cycle');
      }
      seen.add(currentId);
      const current = this.loadManifestMaterial(currentId);
      if (
        successor === undefined &&
        (current.canonical !== active.canonical.manifest ||
          current.sha256 !== active.pointer.manifest.sha256)
      ) {
        fail('active manifest bytes disagree with the verified bundle');
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
          fail('identity manifest predecessor continuity is inconsistent');
        }
      }
      lineage.push(current);
      successor = current.manifest;
      currentId = current.manifest.predecessor_manifest_id;
    }
    return lineage;
  }

  private loadAnchoredManifestMaterial(manifestId: string): ManifestMaterial {
    assertFederationId(manifestId, 'idm', 'manifest_id');
    const material = this.loadActiveManifestLineage().find(
      (candidate) => candidate.manifest.manifest_id === manifestId,
    );
    if (material !== undefined) return material;
    fail(
      `manifest ${manifestId} is not reachable from the active identity lineage`,
    );
  }

  private registryFiles(): Map<string, RegistryFile[]> {
    this.assertDirectory(
      this.paths.identityRegistries,
      'identity registry directory',
    );
    const groups = new Map<string, RegistryFile[]>();
    for (const entry of readdirSync(this.paths.identityRegistries, {
      withFileTypes: true,
    })) {
      const match = REGISTRY_FILENAME.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        fail(`identity registry directory contains unsafe entry ${entry.name}`);
      }
      const registryId = match[1]!;
      const revision = Number(match[2]);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        fail(`registry filename ${entry.name} has an unsafe revision`);
      }
      const expected = connectionRegistryFilename(registryId, revision);
      if (entry.name !== expected) {
        fail(`registry filename ${entry.name} is not canonical`);
      }
      const files = groups.get(registryId) ?? [];
      files.push({ filename: entry.name, registryId, revision });
      groups.set(registryId, files);
    }
    for (const files of groups.values()) {
      files.sort((left, right) => left.revision - right.revision);
    }
    return groups;
  }

  private verifyRegistryChain(
    manifestId: string,
    registryId: string,
    files: readonly RegistryFile[],
  ): VerifiedHistoricalRegistryChain {
    const manifest = this.loadAnchoredManifestMaterial(manifestId);
    const revisions: VerifiedHistoricalRegistryRevision[] = [];
    let previous: VerifiedHistoricalRegistryRevision | undefined;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const expectedRevision = index + 1;
      if (
        file.registryId !== registryId ||
        file.revision !== expectedRevision
      ) {
        fail(
          `registry chain ${registryId} is missing revision ${expectedRevision}`,
        );
      }
      const raw = this.registries.read(file.filename);
      const registry = canonicalDocument<LocalConnectionRegistryV1>(
        'local-connection-registry',
        raw,
      );
      if (
        registry.registry_id !== registryId ||
        registry.revision !== expectedRevision ||
        registry.identity_manifest_id !== manifestId
      ) {
        fail(`registry chain ${registryId} has inconsistent document identity`);
      }
      const expectedPrevious = previous?.sha256 ?? null;
      if (registry.previous_registry_sha256 !== expectedPrevious) {
        fail(
          `registry chain ${registryId} revision ${expectedRevision} has a broken hash link`,
        );
      }
      if (
        previous !== undefined &&
        registry.updated_at <= previous.registry.updated_at
      ) {
        fail(
          `registry chain ${registryId} timestamps are not strictly increasing`,
        );
      }
      assertRegistrySemantics(manifest.manifest, registry);
      verifySignedDocument(
        registry,
        manifest.publicKey,
        manifest.manifest.installation.signing_key.key_id,
      );
      if (previous !== undefined) {
        assertAppendOnlyRevision(previous.registry, registry);
      }
      const verified = { registry, canonical: raw, sha256: sha256Digest(raw) };
      revisions.push(verified);
      previous = verified;
    }
    return {
      registry_id: registryId,
      identity_manifest_id: manifestId,
      revisions,
    };
  }

  private assertDirectory(path: string, label: string): void {
    if (
      !pathEntryExists(this.paths.root) ||
      !pathEntryExists(this.paths.identityRoot) ||
      !pathEntryExists(path)
    ) {
      fail(`${label} does not exist`);
    }
    assertPrivateOwnedDirectory(this.paths.root, 'product state directory');
    assertPrivateOwnedDirectory(this.paths.identityRoot, 'identity directory');
    assertPrivateOwnedDirectory(path, label);
  }
}
