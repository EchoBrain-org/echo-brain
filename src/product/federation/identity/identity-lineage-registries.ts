import { readdirSync } from "node:fs";
import type { ProductStatePaths } from "../../paths.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../foundation/canonical-json.js";
import {
  connectionRegistryFilename,
  ConnectionRegistryStore,
} from "./connection-registry-store.js";
import type {
  AdapterBindingV1,
  IdentityOwnerV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from "../contracts.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "../foundation/identifiers.js";
import {
  assertIdentityLineageDirectory,
  canonicalLineageDocument,
  IdentityDocumentLineage,
  identityLineageFailure,
  type VerifiedHistoricalRegistryChain,
  type VerifiedHistoricalRegistryRevision,
} from "./identity-lineage-documents.js";
import { verifySignedDocument } from "../foundation/signed-document.js";

const REGISTRY_FILENAME =
  /^connection-registry\.(reg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.r([1-9][0-9]*)\.v1\.json$/;

interface RegistryFile {
  filename: string;
  registryId: string;
  revision: number;
}

function expectedProvider(adapterId: string): string | null {
  if (adapterId === "granola") return "granola";
  if (adapterId === "slack" || adapterId === "slack-reactions") {
    return "slack";
  }
  return null;
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
  priorStatus: "active" | "retired",
  priorEndedAt: string | null,
  currentStatus: "active" | "retired",
  currentEndedAt: string | null,
  label: string,
): void {
  if (priorEndedAt !== null) {
    if (currentStatus !== "retired" || currentEndedAt !== priorEndedAt) {
      identityLineageFailure(`${label} changed after retirement`);
    }
    return;
  }
  if (
    (priorStatus === "active" &&
      currentStatus === "active" &&
      currentEndedAt === null) ||
    (priorStatus === "active" &&
      currentStatus === "retired" &&
      currentEndedAt !== null)
  ) {
    return;
  }
  identityLineageFailure(`${label} has an invalid lifecycle transition`);
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
    identityLineageFailure(`${label} changed immutable generation identity`);
  }
  if (
    (prior.ended_at === null && current.ended_at !== null) ||
    prior.ended_at === current.ended_at
  ) {
    return;
  }
  identityLineageFailure(`${label} has an invalid lifecycle transition`);
}

function assertRegistrySemantics(
  manifest: LocalIdentityManifestV1,
  registry: LocalConnectionRegistryV1,
): void {
  if (registry.identity_manifest_id !== manifest.manifest_id) {
    identityLineageFailure("registry belongs to another identity manifest");
  }
  assertUtcMillisecondTimestamp(
    registry.updated_at,
    "historical registry updated_at",
  );
  const connections = new Map<string, ToolConnectionV1>();
  for (const connection of registry.connections) {
    if (connections.has(connection.connection_id)) {
      identityLineageFailure("registry contains duplicate connection IDs");
    }
    connections.set(connection.connection_id, connection);
    if (connection.organization_id !== manifest.organization.organization_id) {
      identityLineageFailure(
        `connection ${connection.connection_id} belongs to another organization`,
      );
    }
    const owner: IdentityOwnerV1 = connection.owner;
    if (
      (owner.kind === "organization" &&
        owner.id !== manifest.organization.organization_id) ||
      (owner.kind === "membership" &&
        owner.id !== manifest.membership.membership_id)
    ) {
      identityLineageFailure(
        `connection ${connection.connection_id} has an unknown owner`,
      );
    }
    const generations = new Set<number>();
    let activeGenerations = 0;
    for (const generation of connection.generations) {
      if (generations.has(generation.generation)) {
        identityLineageFailure(
          `connection ${connection.connection_id} has duplicate generations`,
        );
      }
      generations.add(generation.generation);
      if (generation.ended_at === null) activeGenerations += 1;
      assertUtcMillisecondTimestamp(
        generation.active_from,
        "historical connection generation active_from",
      );
      assertUtcMillisecondTimestamp(
        generation.provider_identity.verification.verified_at,
        "historical provider identity verified_at",
      );
      if (
        generation.provider_identity.verification.verified_at >
          generation.active_from ||
        generation.active_from > registry.updated_at
      ) {
        identityLineageFailure(
          `connection ${connection.connection_id} has impossible verification or activation time`,
        );
      }
      if (
        generation.ended_at !== null &&
        generation.ended_at < generation.active_from
      ) {
        identityLineageFailure(
          `connection ${connection.connection_id} has an inverted lifecycle`,
        );
      }
      if (generation.ended_at !== null) {
        assertUtcMillisecondTimestamp(
          generation.ended_at,
          "historical connection generation ended_at",
        );
      }
      if (
        connection.provider === "slack" &&
        (generation.provider_identity.tenant?.kind !== "slack-team" ||
          generation.provider_identity.subject?.kind !== "bot-installation" ||
          generation.provider_identity.verification.method !==
            "slack_auth_test" ||
          generation.provider_identity.verification.assurance !==
            "provider_verified")
      ) {
        identityLineageFailure(
          "historical Slack connection lacks a verified team and bot",
        );
      }
      if (
        connection.provider === "granola" &&
        generation.provider_identity.verification.method ===
          "provider_first_capture" &&
        (generation.provider_identity.tenant !== null ||
          generation.provider_identity.subject !== null ||
          generation.provider_identity.verification.assurance !==
            "credential_observed")
      ) {
        identityLineageFailure(
          "historical Granola connection overstates provider identity",
        );
      }
    }
    if (activeGenerations > 1) {
      identityLineageFailure(
        `connection ${connection.connection_id} has multiple active generations`,
      );
    }
  }

  const bindings = new Map<string, AdapterBindingV1>();
  const activeSlots = new Set<string>();
  for (const binding of registry.bindings) {
    if (bindings.has(binding.adapter_binding_id)) {
      identityLineageFailure("registry contains duplicate binding IDs");
    }
    bindings.set(binding.adapter_binding_id, binding);
    if (
      canonicalSha256(binding.configuration_snapshot) !==
      binding.configuration_sha256
    ) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} configuration digest is invalid`,
      );
    }
    assertUtcMillisecondTimestamp(
      binding.created_at,
      "historical binding created_at",
    );
    if (binding.created_at > registry.updated_at) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} postdates its registry record`,
      );
    }
    if (
      (binding.status === "active" && binding.ended_at !== null) ||
      (binding.status === "retired" && binding.ended_at === null) ||
      (binding.ended_at !== null && binding.ended_at < binding.created_at)
    ) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} has an invalid lifecycle`,
      );
    }
    if (binding.status === "active") {
      const slot = `${binding.capability}:${binding.adapter_id}:${binding.instance_id}`;
      if (activeSlots.has(slot)) {
        identityLineageFailure(
          `registry contains duplicate active binding slot ${slot}`,
        );
      }
      activeSlots.add(slot);
    }
    if (binding.connection_id === null) {
      if (binding.connection_generation !== null) {
        identityLineageFailure(
          `binding ${binding.adapter_binding_id} has a dangling generation`,
        );
      }
      continue;
    }
    const connection = connections.get(binding.connection_id);
    const generation = connection?.generations.find(
      (item) => item.generation === binding.connection_generation,
    );
    if (connection === undefined || generation === undefined) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} has a missing connection generation`,
      );
    }
    if (binding.status === "active" && generation.ended_at !== null) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} uses a retired generation`,
      );
    }
    const provider = expectedProvider(binding.adapter_id);
    if (provider !== null && connection.provider !== provider) {
      identityLineageFailure(
        `binding ${binding.adapter_binding_id} uses the wrong provider`,
      );
    }
  }

  const activeSlackApprovals = [...bindings.values()].filter(
    (binding) =>
      binding.status === "active" &&
      binding.capability === "approval-surface" &&
      binding.adapter_id === "slack-reactions",
  );
  for (const claim of manifest.identity_claims) {
    if (claim.issuer.kind !== "provider" || claim.issuer.provider !== "slack") {
      continue;
    }
    if (activeSlackApprovals.length !== 1) {
      identityLineageFailure(
        "historical Slack claim lacks one active approval binding",
      );
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
      connection?.provider !== "slack" ||
      generation?.provider_identity.tenant?.kind !== "slack-team" ||
      generation.provider_identity.tenant.id !== claim.issuer.tenant_id
    ) {
      identityLineageFailure(
        "historical Slack claim and approval binding disagree on workspace",
      );
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
      identityLineageFailure(
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
        identityLineageFailure(
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
      identityLineageFailure(
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

export class IdentityRegistryLineage {
  private readonly registries: ConnectionRegistryStore;

  constructor(
    private readonly paths: ProductStatePaths,
    private readonly documents: IdentityDocumentLineage,
  ) {
    this.registries = new ConnectionRegistryStore(paths);
  }

  loadVerifiedRegistryChain(
    manifestId: string,
    registryId: string,
  ): VerifiedHistoricalRegistryChain {
    assertFederationId(manifestId, "idm", "identity_manifest_id");
    assertFederationId(registryId, "reg", "registry_id");
    const files = this.registryFiles().get(registryId);
    if (files === undefined || files.length === 0) {
      identityLineageFailure(`registry chain ${registryId} does not exist`);
    }
    return this.verifyRegistryChain(manifestId, registryId, files);
  }

  enumerateVerifiedRegistryChains(
    manifestId: string,
  ): readonly VerifiedHistoricalRegistryChain[] {
    assertFederationId(manifestId, "idm", "identity_manifest_id");
    const chains: VerifiedHistoricalRegistryChain[] = [];
    for (const [registryId, files] of this.registryFiles()) {
      const manifestIds = new Set(
        files.map((file) => {
          const raw = this.registries.read(file.filename);
          return canonicalLineageDocument<LocalConnectionRegistryV1>(
            "local-connection-registry",
            raw,
          ).identity_manifest_id;
        }),
      );
      if (manifestIds.size !== 1) {
        identityLineageFailure(
          `registry chain ${registryId} crosses identity manifests`,
        );
      }
      if (manifestIds.has(manifestId)) {
        chains.push(this.verifyRegistryChain(manifestId, registryId, files));
      }
    }
    return chains.sort((left, right) =>
      left.registry_id.localeCompare(right.registry_id),
    );
  }

  private registryFiles(): Map<string, RegistryFile[]> {
    assertIdentityLineageDirectory(
      this.paths,
      this.paths.identityRegistries,
      "identity registry directory",
    );
    const groups = new Map<string, RegistryFile[]>();
    for (const entry of readdirSync(this.paths.identityRegistries, {
      withFileTypes: true,
    })) {
      const match = REGISTRY_FILENAME.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        identityLineageFailure(
          `identity registry directory contains unsafe entry ${entry.name}`,
        );
      }
      const registryId = match[1]!;
      const revision = Number(match[2]);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        identityLineageFailure(
          `registry filename ${entry.name} has an unsafe revision`,
        );
      }
      const expected = connectionRegistryFilename(registryId, revision);
      if (entry.name !== expected) {
        identityLineageFailure(
          `registry filename ${entry.name} is not canonical`,
        );
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
    const manifest = this.documents.loadAnchoredManifestMaterial(manifestId);
    const revisions: VerifiedHistoricalRegistryRevision[] = [];
    let previous: VerifiedHistoricalRegistryRevision | undefined;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const expectedRevision = index + 1;
      if (
        file.registryId !== registryId ||
        file.revision !== expectedRevision
      ) {
        identityLineageFailure(
          `registry chain ${registryId} is missing revision ${expectedRevision}`,
        );
      }
      const raw = this.registries.read(file.filename);
      const registry = canonicalLineageDocument<LocalConnectionRegistryV1>(
        "local-connection-registry",
        raw,
      );
      if (
        registry.registry_id !== registryId ||
        registry.revision !== expectedRevision ||
        registry.identity_manifest_id !== manifestId
      ) {
        identityLineageFailure(
          `registry chain ${registryId} has inconsistent document identity`,
        );
      }
      const expectedPrevious = previous?.sha256 ?? null;
      if (registry.previous_registry_sha256 !== expectedPrevious) {
        identityLineageFailure(
          `registry chain ${registryId} revision ${expectedRevision} has a broken hash link`,
        );
      }
      if (
        previous !== undefined &&
        registry.updated_at <= previous.registry.updated_at
      ) {
        identityLineageFailure(
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
}
