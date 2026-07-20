import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type { AdapterIdentity } from '../../core/contracts/adapter.js';
import type { DecisionSet } from '../../core/contracts/decision.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../core/contracts/delivery.js';
import type { JsonObject } from '../../core/contracts/json.js';
import type {
  AdapterCursor,
  MeetingDocument,
  MeetingParticipantIdentityKind,
} from '../../core/contracts/meeting.js';
import type { CoreStateStore } from '../../core/storage/core-state-store.js';
import { LLM_DECISION_PROCESSOR_PROMPT_VERSION } from '../../adapters/decision-processors/llm/llm-decision-processor.js';
import {
  ActiveIdentityBundleStore,
  type VerifiedActiveIdentityBundle,
} from './active-identity-bundle-store.js';
import { requiresFounderFederation } from './cutover-fence.js';
import {
  SqliteFederatedAttributionStore,
  type AttributionStorageEvidenceVerifier,
  type ProcessorAttributionKey,
  type SourceAttributionKey,
} from './attribution-store.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  AdapterBindingV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from './contracts.js';
import { federationId, assertUtcMillisecondTimestamp } from './identifiers.js';
import {
  IdentityLineageStore,
  type HistoricalBindingReference,
  type ResolvedHistoricalBinding,
} from './identity-lineage-store.js';

interface AttributionIdentityBundleReader {
  hasActiveBundle(): boolean;
  hasIdentityMaterial(): boolean;
  loadVerified(): VerifiedActiveIdentityBundle | null;
}

export interface AttributionIdentityLineageReader {
  assertManifestAncestorOrEqual(
    ancestorManifestId: string,
    descendantManifestId: string,
  ): void;
  resolveBindingAt(
    reference: HistoricalBindingReference,
    observedAt: string,
  ): ResolvedHistoricalBinding;
}

export interface AttributionArtifactProvider {
  current(): ProductArtifactIdentityV1;
  verify(value: ProductArtifactIdentityV1): void;
}

export interface AttributingCoreStateStoreOptions {
  stateDirectory: string;
  databasePath: string;
  artifactProvider?: AttributionArtifactProvider;
  now?: () => string;
  createObservationId?: () => string;
  /** Unit-test seam. Production reads the signed active bundle from disk. */
  identityBundleReader?: AttributionIdentityBundleReader;
  /** Unit-test seam. Production resolves immutable historical identity files. */
  identityLineageReader?: AttributionIdentityLineageReader;
  /** Unit-test seam. Production uses the shared product SQLite database. */
  attributionStore?: SqliteFederatedAttributionStore;
}

interface BoundConnection {
  binding: AdapterBindingV1;
  connection: ToolConnectionV1;
  generation: ToolConnectionGenerationV1;
}

function fail(message: string): never {
  throw new Error(`federated attribution capture failed: ${message}`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function activeBinding(
  bundle: VerifiedActiveIdentityBundle,
  capability: AdapterBindingV1['capability'],
  identity: AdapterIdentity,
): AdapterBindingV1 {
  const matches = bundle.connectionRegistry.bindings.filter(
    (binding) =>
      binding.status === 'active' &&
      binding.capability === capability &&
      binding.adapter_id === identity.adapter_id &&
      binding.instance_id === identity.instance_id,
  );
  if (matches.length !== 1) {
    fail(
      `expected one active ${capability} binding for ${identity.adapter_id}/${identity.instance_id}`,
    );
  }
  return matches[0]!;
}

function requiredConnection(
  bundle: VerifiedActiveIdentityBundle,
  binding: AdapterBindingV1,
): BoundConnection {
  if (
    binding.connection_id === null ||
    binding.connection_generation === null
  ) {
    fail(
      `source binding ${binding.adapter_binding_id} has no provider connection`,
    );
  }
  const connection = bundle.connectionRegistry.connections.find(
    (item) => item.connection_id === binding.connection_id,
  );
  const generation = connection?.generations.find(
    (item) => item.generation === binding.connection_generation,
  );
  if (connection === undefined || generation === undefined) {
    fail(
      `source binding ${binding.adapter_binding_id} has a dangling connection`,
    );
  }
  return { binding, connection, generation };
}

function assertLifecycle(
  binding: AdapterBindingV1,
  generation: ToolConnectionGenerationV1 | undefined,
  capturedAt: string,
): void {
  if (
    binding.created_at > capturedAt ||
    (binding.ended_at !== null && capturedAt >= binding.ended_at)
  ) {
    fail(
      `binding ${binding.adapter_binding_id} was not active at capture time`,
    );
  }
  if (
    generation !== undefined &&
    (generation.active_from > capturedAt ||
      (generation.ended_at !== null && capturedAt >= generation.ended_at))
  ) {
    fail('provider credential generation was not active at capture time');
  }
}

function participantNamespace(
  kind: MeetingParticipantIdentityKind,
  provider: string,
  connectionId: string,
): string {
  switch (kind) {
    case 'source':
      return `provider:${provider}:${connectionId}`;
    case 'email':
      return 'internet:rfc5322-email';
    case 'phone':
      return 'internet:telephone';
    case 'other':
      return `provider:${provider}:${connectionId}:other`;
  }
}

function sourceKey(meeting: MeetingDocument): SourceAttributionKey {
  return {
    source_adapter_id: meeting.provenance.source.adapter_id,
    source_instance_id: meeting.provenance.source.instance_id,
    external_id: meeting.provenance.external_id,
    meeting_revision: meeting.provenance.canonical_revision,
  };
}

function processorKey(
  meeting: MeetingDocument,
  decisions: DecisionSet,
): ProcessorAttributionKey {
  return {
    ...sourceKey(meeting),
    processor_adapter_id: decisions.processor.adapter_id,
    processor_instance_id: decisions.processor.instance_id,
    processor_version: decisions.processor.version,
  };
}

export function createAttributionStorageEvidenceVerifier(
  lineage: AttributionIdentityLineageReader,
  artifactProvider: AttributionArtifactProvider,
): AttributionStorageEvidenceVerifier {
  function resolveSource(attribution: SourceAttributionV1) {
    return lineage.resolveBindingAt(
      {
        identity_manifest_id: attribution.identity_manifest_id,
        adapter_binding_id: attribution.source.adapter_binding_id,
        capability: 'meeting-source',
        adapter_id: attribution.source.adapter.adapter_id,
        instance_id: attribution.source.adapter.instance_id,
        configuration_snapshot: attribution.source.configuration_snapshot,
        configuration_sha256: attribution.source.configuration_sha256,
        connection_id: attribution.connection.connection_id,
        connection_generation: attribution.connection.generation,
      },
      attribution.captured_at,
    );
  }

  function resolveProcessor(attribution: ProcessorAttributionV1) {
    return lineage.resolveBindingAt(
      {
        identity_manifest_id: attribution.identity_manifest_id,
        adapter_binding_id: attribution.processor.adapter_binding_id,
        capability: 'decision-processor',
        adapter_id: attribution.processor.adapter.adapter_id,
        instance_id: attribution.processor.adapter.instance_id,
        configuration_snapshot: attribution.processor.configuration_snapshot,
        configuration_sha256: attribution.processor.configuration_sha256,
        connection_id: null,
        connection_generation: null,
      },
      attribution.captured_at,
    );
  }

  return {
    verifySourceAttribution(attribution) {
      const resolved = resolveSource(attribution);
      if (
        resolved.manifest.organization.organization_id !==
          attribution.organization_id ||
        resolved.connection === null ||
        resolved.generation === null ||
        canonicalJson({
          connection_id: resolved.connection.connection_id,
          generation: resolved.generation.generation,
          owner: resolved.connection.owner,
          provider: resolved.connection.provider,
          provider_identity: {
            tenant: resolved.generation.provider_identity.tenant,
            subject: resolved.generation.provider_identity.subject,
            verification_method:
              resolved.generation.provider_identity.verification.method,
            assurance:
              resolved.generation.provider_identity.verification.assurance,
          },
        }) !== canonicalJson(attribution.connection)
      ) {
        fail(
          'stored source attribution differs from historical identity lineage',
        );
      }
      artifactProvider.verify(cloneJson(attribution.captured_by));
    },
    verifyProcessorAttribution(attribution) {
      const resolved = resolveProcessor(attribution);
      if (resolved.connection !== null || resolved.generation !== null) {
        fail(
          'stored processor attribution differs from historical identity lineage',
        );
      }
      artifactProvider.verify(cloneJson(attribution.produced_by));
    },
    verifyAttributionPair(source, processor) {
      lineage.assertManifestAncestorOrEqual(
        source.identity_manifest_id,
        processor.identity_manifest_id,
      );
      const sourceManifest = resolveSource(source).manifest;
      const processorManifest = resolveProcessor(processor).manifest;
      if (
        source.organization_id !==
          sourceManifest.organization.organization_id ||
        sourceManifest.organization.organization_id !==
          processorManifest.organization.organization_id ||
        processor.captured_at < source.captured_at
      ) {
        fail(
          'source and processor attributions do not share one ordered organization identity lineage',
        );
      }
    },
  };
}

/**
 * Additive product-layer decorator. With no active identity bundle it delegates
 * byte-for-byte to the existing state store. Once identity is active, immutable
 * sidecars are committed before the unchanged core upserts.
 */
export class AttributingCoreStateStore implements CoreStateStore {
  readonly attributions: SqliteFederatedAttributionStore;
  private readonly identity: AttributionIdentityBundleReader;
  private readonly lineage: AttributionIdentityLineageReader;
  private readonly now: () => string;
  private readonly createObservationId: () => string;
  private readonly ownsAttributionStore: boolean;
  private readonly evidenceVerifier:
    AttributionStorageEvidenceVerifier | undefined;

  constructor(
    private readonly delegate: CoreStateStore & { close?: () => void },
    private readonly options: AttributingCoreStateStoreOptions,
  ) {
    this.identity =
      options.identityBundleReader ??
      new ActiveIdentityBundleStore(options.stateDirectory);
    this.lineage =
      options.identityLineageReader ??
      new IdentityLineageStore(options.stateDirectory);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createObservationId =
      options.createObservationId ?? (() => federationId('obs'));
    this.ownsAttributionStore = options.attributionStore === undefined;
    this.attributions =
      options.attributionStore ??
      new SqliteFederatedAttributionStore(options.databasePath);
    this.evidenceVerifier =
      options.artifactProvider === undefined
        ? undefined
        : createAttributionStorageEvidenceVerifier(
            this.lineage,
            options.artifactProvider,
          );
  }

  async getSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
  ): Promise<AdapterCursor | undefined> {
    return await this.delegate.getSourceCursor(source);
  }

  async setSourceCursor(
    source: AdapterIdentity & { kind: 'meeting-source' },
    cursor: AdapterCursor,
  ): Promise<void> {
    await this.delegate.setSourceCursor(source, cursor);
  }

  async hasProcessed(processingKey: string): Promise<boolean> {
    return await this.delegate.hasProcessed(processingKey);
  }

  async saveMeeting(meeting: MeetingDocument): Promise<void> {
    const bundle = this.activeBundle();
    if (bundle === null) {
      await this.delegate.saveMeeting(meeting);
      return;
    }
    const key = sourceKey(meeting);
    const existing = this.attributions.getSourceAttribution(key);
    if (existing !== undefined) {
      this.recoverSourceAttribution(existing, meeting);
      await this.delegate.saveMeeting(meeting);
      return;
    }
    const attribution = this.sourceAttribution(bundle, meeting, existing);
    this.attributions.preflightOrInsertSourceAttribution(attribution);
    await this.delegate.saveMeeting(meeting);
  }

  async getDecisionSet(
    meeting: MeetingDocument,
    processor: AdapterIdentity & { kind: 'decision-processor' },
  ): Promise<DecisionSet | undefined> {
    const decisions = await this.delegate.getDecisionSet(meeting, processor);
    if (decisions === undefined || this.activeBundle() === null)
      return decisions;
    const attribution = this.attributions.getProcessorAttribution(
      processorKey(meeting, decisions),
    );
    if (
      attribution === undefined ||
      attribution.processor.decision_set_sha256 !== canonicalSha256(decisions)
    ) {
      fail('cached decision set has no matching extraction-time attribution');
    }
    const source = this.attributions.getSourceAttribution(sourceKey(meeting));
    if (source === undefined) {
      fail('cached decision set has no preceding source attribution');
    }
    this.verifyAttributionPair(source, attribution);
    return decisions;
  }

  async saveDecisionSet(
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): Promise<void> {
    const bundle = this.activeBundle();
    if (bundle === null) {
      await this.delegate.saveDecisionSet(meeting, decisions);
      return;
    }
    const key = processorKey(meeting, decisions);
    const existing = this.attributions.getProcessorAttribution(key);
    if (existing !== undefined) {
      this.recoverProcessorAttribution(existing, meeting, decisions);
      await this.delegate.saveDecisionSet(meeting, decisions);
      return;
    }
    const attribution = this.processorAttribution(
      bundle,
      meeting,
      decisions,
      existing,
    );
    const source = this.attributions.getSourceAttribution(sourceKey(meeting));
    if (source === undefined) {
      fail('processor attribution has no preceding source attribution');
    }
    this.verifyAttributionPair(source, attribution);
    this.attributions.preflightOrInsertProcessorAttribution(attribution);
    await this.delegate.saveDecisionSet(meeting, decisions);
  }

  async getApproval(
    processingKey: string,
  ): Promise<ApprovalDecision | undefined> {
    return await this.delegate.getApproval(processingKey);
  }

  async saveApproval(
    processingKey: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.delegate.saveApproval(processingKey, decision);
  }

  async saveDeliveryReceipt(
    envelope: DeliveryEnvelope,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    await this.delegate.saveDeliveryReceipt(envelope, receipt);
  }

  async markProcessed(processingKey: string): Promise<void> {
    await this.delegate.markProcessed(processingKey);
  }

  close(): void {
    try {
      if (this.ownsAttributionStore) this.attributions.close();
    } finally {
      this.delegate.close?.();
    }
  }

  private activeBundle(): VerifiedActiveIdentityBundle | null {
    if (!this.identity.hasActiveBundle()) {
      if (
        requiresFounderFederation(this.options.stateDirectory, this.identity)
      ) {
        fail('identity material exists without a valid active bundle');
      }
      return null;
    }
    const bundle = this.identity.loadVerified();
    if (bundle === null) fail('active identity pointer did not resolve');
    return bundle;
  }

  private artifact(
    existing: ProductArtifactIdentityV1 | undefined,
  ): ProductArtifactIdentityV1 {
    const provider = this.options.artifactProvider;
    if (provider === undefined) {
      fail(
        'identity-enabled attribution requires trusted product artifact evidence',
      );
    }
    const artifact = cloneJson(existing ?? provider.current());
    provider.verify(artifact);
    return artifact;
  }

  private captureTime(existing: string | undefined): string {
    const capturedAt = existing ?? this.now();
    assertUtcMillisecondTimestamp(capturedAt, 'attribution captured_at');
    return capturedAt;
  }

  private recoverSourceAttribution(
    attribution: SourceAttributionV1,
    meeting: MeetingDocument,
  ): void {
    if (attribution.meeting.document_sha256 !== canonicalSha256(meeting)) {
      fail('stored source attribution differs from the retried meeting');
    }
    this.requireEvidenceVerifier().verifySourceAttribution(attribution);
    this.attributions.preflightOrInsertSourceAttribution(attribution);
  }

  private recoverProcessorAttribution(
    attribution: ProcessorAttributionV1,
    meeting: MeetingDocument,
    decisions: DecisionSet,
  ): void {
    if (
      decisions.processor.kind !== 'decision-processor' ||
      decisions.meeting_id !== meeting.id ||
      decisions.meeting_revision !== meeting.provenance.canonical_revision ||
      attribution.processor.decision_set_sha256 !==
        canonicalSha256(decisions) ||
      decisions.generated_at > attribution.captured_at
    ) {
      fail(
        'stored processor attribution differs from the retried decision set',
      );
    }
    this.requireEvidenceVerifier().verifyProcessorAttribution(attribution);
    const source = this.attributions.getSourceAttribution(sourceKey(meeting));
    if (source === undefined) {
      fail('stored processor attribution has no preceding source attribution');
    }
    this.verifyAttributionPair(source, attribution);
    this.attributions.preflightOrInsertProcessorAttribution(attribution);
  }

  private requireEvidenceVerifier(): AttributionStorageEvidenceVerifier {
    return (
      this.evidenceVerifier ??
      fail(
        'identity-enabled attribution requires trusted product artifact evidence',
      )
    );
  }

  private verifyAttributionPair(
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
  ): void {
    if (source.identity_manifest_id === processor.identity_manifest_id) return;
    this.requireEvidenceVerifier().verifyAttributionPair(source, processor);
  }

  private sourceAttribution(
    bundle: VerifiedActiveIdentityBundle,
    meeting: MeetingDocument,
    existing: SourceAttributionV1 | undefined,
  ): SourceAttributionV1 {
    if (meeting.provenance.source.kind !== 'meeting-source') {
      fail('meeting provenance is not a meeting-source adapter');
    }
    const binding = activeBinding(
      bundle,
      'meeting-source',
      meeting.provenance.source,
    );
    const bound = requiredConnection(bundle, binding);
    const capturedAt = this.captureTime(existing?.captured_at);
    assertLifecycle(binding, bound.generation, capturedAt);
    const providerIdentity = bound.generation.provider_identity;
    return {
      schema_version: 1,
      kind: 'echo-source-attribution',
      source_observation_id:
        existing?.source_observation_id ?? this.createObservationId(),
      organization_id: bundle.manifest.organization.organization_id,
      identity_manifest_id:
        existing?.identity_manifest_id ?? bundle.manifest.manifest_id,
      source: {
        adapter_binding_id: binding.adapter_binding_id,
        adapter: cloneJson(meeting.provenance.source),
        configuration_snapshot: cloneJson(binding.configuration_snapshot),
        configuration_sha256: binding.configuration_sha256,
      },
      connection: {
        connection_id: bound.connection.connection_id,
        generation: bound.generation.generation,
        owner: cloneJson(bound.connection.owner),
        provider: bound.connection.provider,
        provider_identity: cloneJson({
          tenant: providerIdentity.tenant,
          subject: providerIdentity.subject,
          verification_method: providerIdentity.verification.method,
          assurance: providerIdentity.verification.assurance,
        }) as JsonObject,
      },
      meeting: {
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
        document_sha256: canonicalSha256(meeting),
      },
      participant_observations: meeting.participants.map(
        (participant) =>
          cloneJson({
            meeting_participant_id: participant.id,
            display_name: participant.display_name ?? null,
            observed_claims: (participant.identities ?? []).map((identity) => ({
              namespace: participantNamespace(
                identity.kind,
                bound.connection.provider,
                bound.connection.connection_id,
              ),
              kind: identity.kind,
              value: identity.value,
            })),
          }) as JsonObject,
      ),
      captured_by: this.artifact(existing?.captured_by),
      captured_at: capturedAt,
    };
  }

  private processorAttribution(
    bundle: VerifiedActiveIdentityBundle,
    meeting: MeetingDocument,
    decisions: DecisionSet,
    existing: ProcessorAttributionV1 | undefined,
  ): ProcessorAttributionV1 {
    if (
      decisions.processor.kind !== 'decision-processor' ||
      decisions.meeting_id !== meeting.id ||
      decisions.meeting_revision !== meeting.provenance.canonical_revision
    ) {
      fail('decision set does not describe the meeting being saved');
    }
    const binding = activeBinding(
      bundle,
      'decision-processor',
      decisions.processor,
    );
    if (
      binding.adapter_id === 'llm' &&
      binding.configuration_snapshot['prompt_version'] !==
        LLM_DECISION_PROCESSOR_PROMPT_VERSION
    ) {
      fail('LLM processor binding lacks the code-owned prompt version');
    }
    if (
      binding.connection_id !== null ||
      binding.connection_generation !== null
    ) {
      fail(
        'Founder Live processor attribution requires a local uncredentialed binding',
      );
    }
    const capturedAt = this.captureTime(existing?.captured_at);
    assertLifecycle(binding, undefined, capturedAt);
    if (decisions.generated_at > capturedAt) {
      fail('decision set generated_at is later than attribution capture');
    }
    return {
      schema_version: 1,
      kind: 'echo-processor-attribution',
      identity_manifest_id:
        existing?.identity_manifest_id ?? bundle.manifest.manifest_id,
      meeting: {
        source_adapter_id: meeting.provenance.source.adapter_id,
        source_instance_id: meeting.provenance.source.instance_id,
        external_id: meeting.provenance.external_id,
        meeting_revision: meeting.provenance.canonical_revision,
      },
      processor: {
        adapter_binding_id: binding.adapter_binding_id,
        adapter: cloneJson(decisions.processor),
        configuration_snapshot: cloneJson(binding.configuration_snapshot),
        configuration_sha256: binding.configuration_sha256,
        decision_set_sha256: canonicalSha256(decisions),
      },
      produced_by: this.artifact(existing?.produced_by),
      captured_at: capturedAt,
    };
  }
}
