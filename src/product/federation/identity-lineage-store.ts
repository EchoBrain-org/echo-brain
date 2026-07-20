import { resolveProductStatePaths, type ProductStatePaths } from "../paths.js";
import { canonicalJson, canonicalSha256 } from "./canonical-json.js";
import type { AdapterBindingV1, Sha256Digest } from "./contracts.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "./identifiers.js";
import {
  IdentityDocumentLineage,
  identityLineageFailure,
  type HistoricalBindingReference,
  type HistoricalBindingSnapshotLocator,
  type HistoricalPublicationPolicyReference,
  type ResolvedHistoricalBinding,
  type VerifiedHistoricalIdentityManifest,
  type VerifiedHistoricalPublicationPolicy,
  type VerifiedHistoricalRegistryChain,
} from "./identity-lineage-documents.js";
import { IdentityRegistryLineage } from "./identity-lineage-registries.js";

export type {
  HistoricalBindingReference,
  HistoricalBindingSnapshotLocator,
  HistoricalPublicationPolicyReference,
  ResolvedHistoricalBinding,
  VerifiedHistoricalIdentityManifest,
  VerifiedHistoricalPublicationPolicy,
  VerifiedHistoricalRegistryChain,
  VerifiedHistoricalRegistryRevision,
} from "./identity-lineage-documents.js";

function lifecycleContains(
  observedAt: string,
  startedAt: string,
  endedAt: string | null,
): boolean {
  return observedAt >= startedAt && (endedAt === null || observedAt < endedAt);
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
  private readonly documents: IdentityDocumentLineage;
  private readonly registries: IdentityRegistryLineage;

  constructor(stateDirectory: string) {
    this.paths = resolveProductStatePaths(stateDirectory);
    this.documents = new IdentityDocumentLineage(this.paths);
    this.registries = new IdentityRegistryLineage(this.paths, this.documents);
  }

  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest {
    return this.documents.loadVerifiedManifest(manifestId);
  }

  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest {
    return this.documents.loadVerifiedActiveManifest();
  }

  loadVerifiedManifestBySha256(
    sha256: Sha256Digest,
  ): VerifiedHistoricalIdentityManifest {
    return this.documents.loadVerifiedManifestBySha256(sha256);
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
    this.documents.assertManifestAncestorOrEqual(
      ancestorManifestId,
      descendantManifestId,
    );
  }

  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy {
    return this.documents.loadVerifiedPolicy(reference, observedAt);
  }

  loadVerifiedRegistryChain(
    manifestId: string,
    registryId: string,
  ): VerifiedHistoricalRegistryChain {
    return this.registries.loadVerifiedRegistryChain(manifestId, registryId);
  }

  enumerateVerifiedRegistryChains(
    manifestId: string,
  ): readonly VerifiedHistoricalRegistryChain[] {
    return this.registries.enumerateVerifiedRegistryChains(manifestId);
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
      identityLineageFailure(
        "binding reference configuration digest is invalid",
      );
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
      | "identity_manifest_id"
      | "adapter_binding_id"
      | "connection_id"
      | "connection_generation"
    >,
    observedAt: string,
  ): void {
    assertFederationId(
      reference.identity_manifest_id,
      "idm",
      "identity_manifest_id",
    );
    assertFederationId(
      reference.adapter_binding_id,
      "bnd",
      "adapter_binding_id",
    );
    assertUtcMillisecondTimestamp(observedAt, "binding observed_at");
    if (
      (reference.connection_id === null) !==
      (reference.connection_generation === null)
    ) {
      identityLineageFailure(
        "binding reference connection and generation must both be null or both be set",
      );
    }
    if (reference.connection_id !== null) {
      assertFederationId(reference.connection_id, "con", "connection_id");
      if (
        !Number.isSafeInteger(reference.connection_generation) ||
        (reference.connection_generation as number) < 1
      ) {
        identityLineageFailure(
          "connection_generation must be a positive safe integer",
        );
      }
    }
  }

  private resolveBindingMatchingAt(
    reference: Pick<
      HistoricalBindingReference,
      | "identity_manifest_id"
      | "adapter_binding_id"
      | "connection_id"
      | "connection_generation"
    >,
    observedAt: string,
    matchesBinding: (binding: AdapterBindingV1) => boolean,
  ): ResolvedHistoricalBinding {
    const manifest = this.documents.loadVerifiedManifest(
      reference.identity_manifest_id,
    );
    if (observedAt < manifest.manifest.legacy_cutover.declared_at) {
      identityLineageFailure(
        "binding observation predates the identity cutover",
      );
    }
    const matches: ResolvedHistoricalBinding[] = [];
    for (const chain of this.registries.enumerateVerifiedRegistryChains(
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
        identityLineageFailure(
          "historical binding ID resolves to different immutable facts",
        );
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

      let connection = null;
      let generation = null;
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
      identityLineageFailure(
        "no enrolled historical binding matches the observation",
      );
    }
    if (matches.length !== 1) {
      identityLineageFailure(
        "historical binding resolution is ambiguous across registry chains",
      );
    }
    return matches[0]!;
  }
}
