import type {
  ApprovalRequest,
  JsonObject,
} from '../../core/index.js';
import { SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION } from '../../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { DecisionNodeFederationCapture } from '../approval/decision-node-store.js';
import type {
  DecisionNodeEvents,
  DecisionPublishedEvent,
  DecisionRequestedEvent,
  DecisionResolvedEvent,
} from '../approval/decision-node.js';
import {
  ActiveIdentityBundleStore,
  type VerifiedActiveIdentityBundle,
} from './active-identity-bundle-store.js';
import { requiresFounderFederation } from './cutover-fence.js';
import {
  IdentityLineageStore,
  type ResolvedHistoricalBinding,
} from './identity-lineage-store.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  LocalIdentityManifestV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
} from './contracts.js';
import { assertUtcMillisecondTimestamp } from './identifiers.js';
import { validateFederationDocument } from './schema-validation.js';
import { ApprovalResolutionEvidence } from './approval-resolution-evidence.js';
import {
  approvalCandidate,
  approvalConnection,
  asJsonObject,
  assertArtifactShape,
  candidateDigest,
  configuredSlackReviewerUserId,
  exactEqual,
  expectedSlackPresentation,
  fail,
  jsonClone,
  parseLegacySlackReference,
  parsePresentationEvidence,
  parsePublishedReference,
  providerSnapshot,
  publicationSnapshot,
  publicationSnapshotFrom,
  requestedFederation,
  type ApprovalAttributionProvider,
  type ApprovalIdentityLineageReader,
  type FederatedApprovalCaptureOptions,
  type IdentityBundleReader,
  type ProductArtifactEvidenceProvider,
  type ValidatedStoredApproval,
} from './approval-capture-support.js';

export type {
  ApprovalAttributionProvider,
  ApprovalIdentityLineageReader,
  FederatedApprovalCaptureOptions,
  ProductArtifactEvidenceProvider,
  SlackApprovalPresentationEvidence,
  SlackApprovalResolutionEvidence,
} from './approval-capture-support.js';

export class FederatedApprovalCapture implements DecisionNodeFederationCapture {
  private readonly identity: IdentityBundleReader;
  private readonly lineage: ApprovalIdentityLineageReader;
  private readonly resolution: ApprovalResolutionEvidence;

  constructor(private readonly options: FederatedApprovalCaptureOptions) {
    this.identity =
      options.identityBundleReader ??
      new ActiveIdentityBundleStore(options.stateDirectory);
    this.lineage =
      options.identityLineageReader ??
      new IdentityLineageStore(options.stateDirectory);
    this.resolution = new ApprovalResolutionEvidence({
      runtimeConfig: options.runtimeConfig,
      lineage: this.lineage,
      validatedStoredRequested: (event) =>
        this.validatedStoredRequested(event),
      validateStoredPublished: (context, events, event) =>
        this.validateStoredPublished(context, events, event),
      assertCurrentManifest: (bundle, stored) =>
        this.assertCurrentManifest(bundle, stored),
      productArtifact: () => this.productArtifact(),
      verifyProductArtifact: (value) => this.verifyProductArtifact(value),
    });
  }

  async captureRequested(request: ApprovalRequest): Promise<JsonObject> {
    const bundle = this.activeBundle();
    if (bundle === null) return {};
    const provider = this.requireAttributionProvider();
    const attributions = await provider.getAttributions(request);
    const metadata = this.buildRequestedMetadata(bundle, request, attributions);
    return asJsonObject({ federation: metadata });
  }

  async validateRequested(
    event: DecisionRequestedEvent,
    request?: ApprovalRequest,
  ): Promise<void> {
    if (this.activeBundle() === null) {
      if (Object.hasOwn(event.metadata, 'federation')) {
        fail('stored federated approval has no active identity lineage');
      }
      return;
    }
    const stored = await this.validatedStoredRequested(event);
    if (request === undefined) return;
    if (event.processing_key !== request.processing_key) {
      fail('requested processing key changed on retry');
    }
    const attributions =
      await this.requireAttributionProvider().getAttributions(request);
    const source = validateFederationDocument<SourceAttributionV1>(
      'source-attribution',
      jsonClone(attributions.source),
    );
    const processor = validateFederationDocument<ProcessorAttributionV1>(
      'processor-attribution',
      jsonClone(attributions.processor),
    );
    this.assertAttributionFacts(stored.manifest, request, source, processor);
    this.assertHistoricalStoredAttributions(
      stored.metadata,
      stored.manifest,
      source,
      processor,
      event.requested_at,
    );
  }

  async capturePublished(input: {
    events: DecisionNodeEvents;
    surface: string;
    reference: JsonObject;
    presentationEvidence?: JsonObject;
    postedAt: string;
  }): Promise<JsonObject> {
    const bundle = this.activeBundle();
    if (bundle === null) return input.reference;
    if (input.events.resolved !== undefined) {
      fail('identity-enabled approval cannot publish after resolution');
    }
    if (input.surface !== 'slack') {
      fail('identity-enabled publication requires the Slack approval surface');
    }
    assertUtcMillisecondTimestamp(
      input.postedAt,
      'approval publication posted_at',
    );
    if (input.postedAt < input.events.requested.requested_at) {
      fail('approval publication predates its requested candidate');
    }
    const stored = await this.validatedStoredRequested(input.events.requested);
    this.assertCurrentApprovalPublication(bundle, stored);
    const requested = stored.metadata;
    const slack = parseLegacySlackReference(input.reference);
    const evidence = parsePresentationEvidence(input.presentationEvidence);
    exactEqual(
      evidence.rendered_blocks,
      expectedSlackPresentation(input.events, requested),
      'Slack rendered approval presentation',
    );
    const current = approvalConnection(bundle, this.options.runtimeConfig);
    const enrolled = providerSnapshot(
      current.generation.provider_identity,
      'publishing provider identity',
    );
    exactEqual(
      evidence.provider_identity,
      enrolled,
      'live publishing provider identity',
    );
    const configuredChannel =
      current.binding.configuration_snapshot['channel_id'];
    if (slack.channel_id !== configuredChannel) {
      fail(
        'published Slack channel differs from the enrolled approval binding',
      );
    }
    return asJsonObject({
      slack,
      federation: {
        candidate_context_sha256: requested.candidate_context_sha256,
        rendered_blocks_sha256: evidence.rendered_blocks_sha256,
        rendered_blocks: evidence.rendered_blocks,
        published_via: {
          adapter_binding_id: current.binding.adapter_binding_id,
          connection_id: current.connection.connection_id,
          connection_generation: current.generation.generation,
          configuration_sha256: current.binding.configuration_sha256,
          provider_identity_sha256: canonicalSha256(enrolled),
        },
      },
    });
  }

  async validatePublished(input: {
    events: DecisionNodeEvents;
    event: DecisionPublishedEvent;
  }): Promise<void> {
    if (this.activeBundle() === null) {
      if (Object.hasOwn(input.events.requested.metadata, 'federation')) {
        fail('stored federated approval has no active identity lineage');
      }
      return;
    }
    const stored = await this.validatedStoredRequested(input.events.requested);
    this.validateStoredPublished(stored, input.events, input.event);
  }

  async captureResolved(input: {
    events: DecisionNodeEvents;
    status: 'approved' | 'rejected';
    reviewedAt: string;
    reviewedBy: string;
    reason: string | null;
    surface: string;
    legacyMetadata: JsonObject;
    resolutionEvidence?: JsonObject;
  }): Promise<JsonObject> {
    const bundle = this.activeBundle();
    if (bundle === null) return input.legacyMetadata;
    return this.resolution.captureResolved(bundle, input);
  }

  async validateResolved(input: {
    events: DecisionNodeEvents;
    event: DecisionResolvedEvent;
  }): Promise<void> {
    if (this.activeBundle() === null) {
      if (Object.hasOwn(input.events.requested.metadata, 'federation')) {
        fail('stored federated approval has no active identity lineage');
      }
      return;
    }
    return this.resolution.validateResolved(input);
  }

  private activeBundle(): VerifiedActiveIdentityBundle | null {
    const bundle = this.identity.loadVerified(this.options.runtimeConfig);
    if (bundle !== null) return bundle;
    if (requiresFounderFederation(this.options.stateDirectory, this.identity)) {
      fail('identity material exists without a valid active identity bundle');
    }
    return null;
  }

  private requireAttributionProvider(): ApprovalAttributionProvider {
    if (this.options.attributionProvider === undefined) {
      fail(
        'active identity requires a source and processor attribution provider',
      );
    }
    return this.options.attributionProvider;
  }

  private async validatedStoredRequested(
    event: DecisionRequestedEvent,
  ): Promise<ValidatedStoredApproval> {
    const metadata = requestedFederation(event);
    const manifest = this.lineage.loadVerifiedManifest(
      metadata.identity_manifest_id,
    ).manifest;
    this.assertStoredPublication(metadata, event.requested_at);
    const provider = this.requireAttributionProvider();
    const persisted = await provider.getAttributionsForMetadata(metadata);
    const source = validateFederationDocument<SourceAttributionV1>(
      'source-attribution',
      jsonClone(persisted.source),
    );
    const processor = validateFederationDocument<ProcessorAttributionV1>(
      'processor-attribution',
      jsonClone(persisted.processor),
    );
    this.assertHistoricalStoredAttributions(
      metadata,
      manifest,
      source,
      processor,
      event.requested_at,
    );
    const approvalBinding = this.resolveStoredApprovalBinding(
      metadata,
      event.requested_at,
    );
    return { metadata, manifest, source, processor, approvalBinding };
  }

  private productArtifact(): ProductArtifactIdentityV1 {
    const provider = this.requireArtifactProvider();
    const current = assertArtifactShape(provider.current());
    provider.verify(current);
    return jsonClone(current);
  }

  private requireArtifactProvider(): ProductArtifactEvidenceProvider {
    if (this.options.artifactProvider === undefined) {
      fail('active identity requires trusted product artifact evidence');
    }
    return this.options.artifactProvider;
  }

  private verifyProductArtifact(
    value: ProductArtifactIdentityV1,
  ): ProductArtifactIdentityV1 {
    const artifact = assertArtifactShape(value);
    this.requireArtifactProvider().verify(artifact);
    return jsonClone(artifact);
  }

  private validateStoredPublished(
    context: ValidatedStoredApproval,
    events: DecisionNodeEvents,
    event: DecisionPublishedEvent,
  ): void {
    if (event.surface !== 'slack') {
      fail('identity-enabled published slot has an unsupported surface');
    }
    if (event.posted_at < events.requested.requested_at) {
      fail('stored approval publication predates its requested candidate');
    }
    if (
      events.resolved !== undefined &&
      event.posted_at > events.resolved.reviewed_at
    ) {
      fail('stored approval publication follows its resolution');
    }
    const requested = context.metadata;
    const stored = parsePublishedReference(event.reference);
    if (
      stored.federation.candidate_context_sha256 !==
      requested.candidate_context_sha256
    ) {
      fail('published candidate digest differs from requested metadata');
    }
    const candidate = requested.approval_surface;
    if (candidate.connection === null) {
      fail('published Slack approval candidate has no connection');
    }
    if (
      stored.federation.published_via.adapter_binding_id !==
        candidate.binding.adapter_binding_id ||
      stored.federation.published_via.connection_id !==
        candidate.connection.connection_id ||
      stored.federation.published_via.connection_generation !==
        candidate.connection.generation ||
      stored.federation.published_via.configuration_sha256 !==
        candidate.binding.configuration_sha256 ||
      stored.federation.published_via.provider_identity_sha256 !==
        canonicalSha256(candidate.connection.provider_identity)
    ) {
      fail(
        'published approval tool snapshot differs from its requested candidate',
      );
    }
    const bound = this.lineage.resolveBindingAt(
      {
        identity_manifest_id: requested.identity_manifest_id,
        adapter_binding_id: candidate.binding.adapter_binding_id,
        capability: 'approval-surface',
        adapter_id: candidate.binding.adapter.adapter_id,
        instance_id: candidate.binding.adapter.instance_id,
        configuration_snapshot: candidate.binding.configuration_snapshot,
        configuration_sha256: candidate.binding.configuration_sha256,
        connection_id: candidate.connection.connection_id,
        connection_generation: candidate.connection.generation,
      },
      event.posted_at,
    );
    if (
      stored.slack.channel_id !==
      bound.binding.configuration_snapshot['channel_id']
    ) {
      fail('published channel differs from its captured approval binding');
    }
    exactEqual(
      stored.federation.rendered_blocks,
      expectedSlackPresentation(events, requested),
      'published Slack approval presentation',
    );
  }

  private buildRequestedMetadata(
    bundle: VerifiedActiveIdentityBundle,
    request: ApprovalRequest,
    attributions: {
      source: SourceAttributionV1;
      processor: ProcessorAttributionV1;
    },
  ): ApprovalFederationMetadataV1 {
    const source = validateFederationDocument<SourceAttributionV1>(
      'source-attribution',
      jsonClone(attributions.source),
    );
    const processor = validateFederationDocument<ProcessorAttributionV1>(
      'processor-attribution',
      jsonClone(attributions.processor),
    );
    this.assertAttributionSemantics(bundle, request, source, processor);
    const withoutDigest: Omit<
      ApprovalFederationMetadataV1,
      'candidate_context_sha256'
    > = {
      schema_version: 1,
      identity_manifest_id: bundle.manifest.manifest_id,
      source_attribution_ref: {
        source_adapter_id: source.source.adapter.adapter_id,
        source_instance_id: source.source.adapter.instance_id,
        external_id: source.meeting.external_id,
        meeting_revision: source.meeting.canonical_revision,
        attribution_sha256: canonicalSha256(source),
      },
      processor: {
        adapter_binding_id: processor.processor.adapter_binding_id,
        adapter: processor.processor
          .adapter as typeof request.decisions.processor,
        configuration_snapshot: jsonClone(
          processor.processor.configuration_snapshot,
        ),
        configuration_sha256: processor.processor.configuration_sha256,
        attribution_sha256: canonicalSha256(processor),
      },
      approval_surface: approvalCandidate(bundle, this.options.runtimeConfig),
      publication: publicationSnapshot(bundle),
    };
    const metadata: ApprovalFederationMetadataV1 = {
      ...withoutDigest,
      candidate_context_sha256: candidateDigest(request.brief, withoutDigest),
    };
    return validateFederationDocument<ApprovalFederationMetadataV1>(
      'approval-federation-metadata',
      metadata,
    );
  }

  private assertAttributionSemantics(
    bundle: VerifiedActiveIdentityBundle,
    request: ApprovalRequest,
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
  ): void {
    this.assertAttributionFacts(bundle.manifest, request, source, processor);
    this.verifyProductArtifact(source.captured_by);
    this.verifyProductArtifact(processor.produced_by);
    this.assertAttributionLineage(bundle.manifest, source, processor);
  }

  private assertAttributionFacts(
    manifest: LocalIdentityManifestV1,
    request: ApprovalRequest,
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
  ): void {
    const provenance = request.meeting.provenance;
    if (
      source.organization_id !== manifest.organization.organization_id ||
      source.source.adapter.kind !== 'meeting-source' ||
      source.source.adapter.adapter_id !== provenance.source.adapter_id ||
      source.source.adapter.instance_id !== provenance.source.instance_id ||
      source.source.adapter.version !== provenance.source.version ||
      source.meeting.external_id !== provenance.external_id ||
      source.meeting.canonical_revision !== provenance.canonical_revision ||
      source.meeting.document_sha256 !== canonicalSha256(request.meeting) ||
      source.captured_at > request.requested_at
    ) {
      fail(
        'source attribution does not describe the requested meeting revision',
      );
    }
    if (
      processor.meeting.source_adapter_id !== provenance.source.adapter_id ||
      processor.meeting.source_instance_id !== provenance.source.instance_id ||
      processor.meeting.external_id !== provenance.external_id ||
      processor.meeting.meeting_revision !== provenance.canonical_revision ||
      processor.processor.adapter.kind !== 'decision-processor' ||
      processor.processor.adapter.adapter_id !==
        request.decisions.processor.adapter_id ||
      processor.processor.adapter.instance_id !==
        request.decisions.processor.instance_id ||
      processor.processor.adapter.version !==
        request.decisions.processor.version ||
      processor.processor.decision_set_sha256 !==
        canonicalSha256(request.decisions) ||
      processor.captured_at > request.requested_at ||
      processor.captured_at < source.captured_at
    ) {
      fail(
        'processor attribution does not describe the requested decision set',
      );
    }
  }

  private assertHistoricalStoredAttributions(
    stored: ApprovalFederationMetadataV1,
    manifest: LocalIdentityManifestV1,
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
    requestedAt: string,
  ): void {
    const sourceRef = stored.source_attribution_ref;
    if (
      source.organization_id !== manifest.organization.organization_id ||
      source.source.adapter.adapter_id !== sourceRef.source_adapter_id ||
      source.source.adapter.instance_id !== sourceRef.source_instance_id ||
      source.meeting.external_id !== sourceRef.external_id ||
      source.meeting.canonical_revision !== sourceRef.meeting_revision ||
      canonicalSha256(source) !== sourceRef.attribution_sha256
    ) {
      fail('stored source attribution reference does not resolve exactly');
    }
    if (
      processor.meeting.source_adapter_id !== sourceRef.source_adapter_id ||
      processor.meeting.source_instance_id !== sourceRef.source_instance_id ||
      processor.meeting.external_id !== sourceRef.external_id ||
      processor.meeting.meeting_revision !== sourceRef.meeting_revision ||
      processor.processor.adapter_binding_id !==
        stored.processor.adapter_binding_id ||
      canonicalJson(processor.processor.adapter) !==
        canonicalJson(stored.processor.adapter) ||
      canonicalJson(processor.processor.configuration_snapshot) !==
        canonicalJson(stored.processor.configuration_snapshot) ||
      processor.processor.configuration_sha256 !==
        stored.processor.configuration_sha256 ||
      canonicalSha256(processor) !== stored.processor.attribution_sha256
    ) {
      fail('stored processor attribution reference does not resolve exactly');
    }
    if (
      source.captured_at > requestedAt ||
      processor.captured_at > requestedAt
    ) {
      fail('stored attribution was captured after the requested candidate');
    }
    this.verifyProductArtifact(source.captured_by);
    this.verifyProductArtifact(processor.produced_by);
    this.assertAttributionLineage(manifest, source, processor);
  }

  private assertAttributionLineage(
    approvalManifest: LocalIdentityManifestV1,
    source: SourceAttributionV1,
    processor: ProcessorAttributionV1,
  ): void {
    this.lineage.assertManifestAncestorOrEqual(
      source.identity_manifest_id,
      processor.identity_manifest_id,
    );
    this.lineage.assertManifestAncestorOrEqual(
      processor.identity_manifest_id,
      approvalManifest.manifest_id,
    );
    const sourceManifest = this.lineage.loadVerifiedManifest(
      source.identity_manifest_id,
    ).manifest;
    const processorManifest = this.lineage.loadVerifiedManifest(
      processor.identity_manifest_id,
    ).manifest;
    const organizationId = approvalManifest.organization.organization_id;
    if (
      source.organization_id !== organizationId ||
      sourceManifest.organization.organization_id !== organizationId ||
      processorManifest.organization.organization_id !== organizationId ||
      processor.captured_at < source.captured_at
    ) {
      fail(
        'source, processor, and approval do not share one ordered organization identity lineage',
      );
    }
    const resolvedSource = this.lineage.resolveBindingAt(
      {
        identity_manifest_id: source.identity_manifest_id,
        adapter_binding_id: source.source.adapter_binding_id,
        capability: 'meeting-source',
        adapter_id: source.source.adapter.adapter_id,
        instance_id: source.source.adapter.instance_id,
        configuration_snapshot: source.source.configuration_snapshot,
        configuration_sha256: source.source.configuration_sha256,
        connection_id: source.connection.connection_id,
        connection_generation: source.connection.generation,
      },
      source.captured_at,
    );
    const resolvedProcessor = this.lineage.resolveBindingAt(
      {
        identity_manifest_id: processor.identity_manifest_id,
        adapter_binding_id: processor.processor.adapter_binding_id,
        capability: 'decision-processor',
        adapter_id: processor.processor.adapter.adapter_id,
        instance_id: processor.processor.adapter.instance_id,
        configuration_snapshot: processor.processor.configuration_snapshot,
        configuration_sha256: processor.processor.configuration_sha256,
        connection_id: null,
        connection_generation: null,
      },
      processor.captured_at,
    );
    if (
      resolvedSource.connection === null ||
      resolvedSource.generation === null ||
      resolvedSource.connection.provider !== source.connection.provider ||
      canonicalJson(resolvedSource.connection.owner) !==
        canonicalJson(source.connection.owner) ||
      canonicalSha256(source.connection.provider_identity) !==
        canonicalSha256({
          tenant: resolvedSource.generation.provider_identity.tenant,
          subject: resolvedSource.generation.provider_identity.subject,
          verification_method:
            resolvedSource.generation.provider_identity.verification.method,
          assurance:
            resolvedSource.generation.provider_identity.verification.assurance,
        })
    ) {
      fail('source attribution connection snapshot is not enrolled');
    }
    if (
      resolvedProcessor.connection !== null ||
      resolvedProcessor.generation !== null
    ) {
      fail('processor attribution unexpectedly resolves through a connection');
    }
  }

  private assertStoredPublication(
    stored: ApprovalFederationMetadataV1,
    requestedAt: string,
  ): void {
    if (
      stored.publication.identity_manifest_id !== stored.identity_manifest_id
    ) {
      fail('requested publication policy belongs to another identity manifest');
    }
    const policy = this.lineage.loadVerifiedPolicy(
      {
        policy_id: stored.publication.policy_id,
        version: stored.publication.version,
        policy_sha256: stored.publication.policy_sha256,
        identity_manifest_id: stored.publication.identity_manifest_id,
        signer_installation_id: stored.publication.signer_installation_id,
        signer_key_id: stored.publication.signer_key_id,
      },
      requestedAt,
    );
    exactEqual(
      stored.publication,
      publicationSnapshotFrom(policy.policy, policy.sha256),
      'requested publication policy snapshot',
    );
  }

  private resolveStoredApprovalBinding(
    stored: ApprovalFederationMetadataV1,
    requestedAt: string,
  ): ResolvedHistoricalBinding {
    const candidate = stored.approval_surface;
    if (candidate.connection === null) {
      fail('requested Slack approval surface has no provider connection');
    }
    const resolved = this.lineage.resolveBindingAt(
      {
        identity_manifest_id: stored.identity_manifest_id,
        adapter_binding_id: candidate.binding.adapter_binding_id,
        capability: 'approval-surface',
        adapter_id: candidate.binding.adapter.adapter_id,
        instance_id: candidate.binding.adapter.instance_id,
        configuration_snapshot: candidate.binding.configuration_snapshot,
        configuration_sha256: candidate.binding.configuration_sha256,
        connection_id: candidate.connection.connection_id,
        connection_generation: candidate.connection.generation,
      },
      requestedAt,
    );
    if (
      candidate.binding.adapter.version !==
        SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION ||
      candidate.binding.adapter.adapter_id !== 'slack-reactions' ||
      resolved.connection === null ||
      resolved.generation === null ||
      resolved.connection.provider !== 'slack' ||
      canonicalJson(resolved.connection.owner) !==
        canonicalJson(candidate.connection.owner)
    ) {
      fail('requested approval connection snapshot is not enrolled');
    }
    exactEqual(
      candidate.connection.provider_identity,
      providerSnapshot(
        resolved.generation.provider_identity,
        'requested approval provider identity',
      ),
      'requested approval provider identity',
    );
    if (
      configuredSlackReviewerUserId(resolved.binding) ===
      candidate.connection.provider_identity.bot_user_id
    ) {
      fail('requested Slack reviewer must be distinct from the bot identity');
    }
    return resolved;
  }

  private assertCurrentManifest(
    bundle: VerifiedActiveIdentityBundle,
    stored: ValidatedStoredApproval,
  ): void {
    if (stored.metadata.identity_manifest_id !== bundle.manifest.manifest_id) {
      fail('requested metadata belongs to another active identity manifest');
    }
  }

  private assertCurrentApprovalPublication(
    bundle: VerifiedActiveIdentityBundle,
    stored: ValidatedStoredApproval,
  ): void {
    if (stored.metadata.identity_manifest_id !== bundle.manifest.manifest_id) {
      fail('requested metadata belongs to another identity manifest');
    }
    exactEqual(
      stored.metadata.approval_surface,
      approvalCandidate(bundle, this.options.runtimeConfig),
      'current approval binding and requested candidate',
    );
  }


}
