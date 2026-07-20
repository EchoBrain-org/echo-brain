import type { CoreStateStore } from '../../core/storage/core-state-store.js';
import type { ProductRuntimeConfig } from '../config.js';
import {
  DecisionNodeStore,
  type DecisionNodeFederationCapture,
} from '../approval/decision-node-store.js';
import type { DecisionNodeState } from '../approval/decision-node.js';
import {
  ActiveIdentityBundleStore,
  type VerifiedActiveIdentityBundle,
} from './active-identity-bundle-store.js';
import {
  inspectFounderCutoverFence,
  requiresFounderFederation,
} from './cutover-fence.js';
import { ApprovalProjectingCoreStateStore } from './approval-projecting-core-state-store.js';
import {
  FederatedApprovalCapture,
  type ApprovalIdentityLineageReader,
  type ProductArtifactEvidenceProvider,
} from './approval-capture.js';
import { PackagedProductArtifactEvidenceProvider } from './artifact-evidence.js';
import {
  AttributingCoreStateStore,
  createAttributionStorageEvidenceVerifier,
} from './attributing-core-state-store.js';
import { SqliteFederatedAttributionStore } from './attribution-store.js';
import type { IdentityCheckDependencies } from './identity-check.js';
import { IdentityLineageStore } from './identity-lineage-store.js';
import type { VerifiedHistoricalIdentityManifest } from './identity-lineage-store.js';
import type { FederatedExportIdentitySource } from './export-bundle.js';
import {
  FounderIndependentCopyStore,
  type IndependentCopyPlatformInspector,
  type IndependentCopyReadiness,
} from './independent-copy-store.js';
import type { InstallationSigner } from './installation-signer.js';
import { verifyInstallationKeyDescriptor } from './installation-signer.js';
import { FederatedOutboxStore } from './outbox-store.js';
import {
  buildFederatedProjectionSnapshots,
  FederatedRecordProjector,
} from './record-projector.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  FederationId,
  ProductArtifactIdentityV1,
} from './contracts.js';
import { validateFederationDocument } from './schema-validation.js';
import {
  assertLegacyProcessingBoundaryReady,
  verifyLegacyClassificationReport,
  type LegacyDecisionNodeReader,
} from './legacy-classification.js';

export interface FounderFederationRuntimeOptions {
  runtimeConfig: ProductRuntimeConfig;
  databasePath: string;
  signer?: InstallationSigner;
  artifactProvider?: ProductArtifactEvidenceProvider;
  now?: () => string;
  createId?: () => string;
  /** Focused-test seams. Production uses the state_dir-backed implementations. */
  identityStore?: FounderFederationIdentityReader;
  lineage?: FounderFederationLineageReader;
  attributionStore?: SqliteFederatedAttributionStore;
  outbox?: FederatedOutboxStore;
  projectionDecisionNodes?: Pick<DecisionNodeStore, 'listFederated'>;
  legacyDecisionNodes?: LegacyDecisionNodeReader;
  independentCopyStore?: Pick<
    FounderIndependentCopyStore,
    'ensure' | 'check'
  >;
  independentCopyInspector?: IndependentCopyPlatformInspector;
  createExportId?: () => FederationId;
}

type FounderFederationLineageReader = ApprovalIdentityLineageReader &
  FederatedExportIdentitySource;

export interface FounderFederationIdentityReader {
  hasActiveBundle(): boolean;
  hasIdentityMaterial(): boolean;
  loadVerified(
    runtimeConfig?: ProductRuntimeConfig,
  ): VerifiedActiveIdentityBundle | null;
}

export interface FounderFederationRuntime {
  readonly identityEnabled: boolean;
  readonly approvalCapture: DecisionNodeFederationCapture;
  readonly signer: InstallationSigner | undefined;
  createDecisionNodeStore(): DecisionNodeStore;
  wrapCoreState(
    base: CoreStateStore & { close?: () => void },
    decisions: DecisionNodeStore,
  ): CoreStateStore & { close?: () => void };
  projectApproved(
    state: DecisionNodeState,
  ): ReturnType<FederatedRecordProjector['projectApproved']>;
  ensureIndependentCopy(): Promise<IndependentCopyReadiness>;
  identityChecks(
    configured?: IdentityCheckDependencies,
  ): IdentityCheckDependencies;
  close(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(`founder federation runtime failed: ${message}`);
}

class ProjectionPendingError extends Error {
  constructor(readonly approvalId: string) {
    super(`approval ${approvalId} has no signed outbox group`);
    this.name = 'ProjectionPendingError';
  }
}

function requestedFederationMetadata(
  state: DecisionNodeState,
): Record<string, unknown> {
  const metadata = state.requested_metadata['federation'];
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    fail(`approval ${state.approval_id} has invalid federation metadata`);
  }
  return metadata;
}

function approvedSignals(state: DecisionNodeState) {
  return [
    ...state.brief.decisions,
    ...state.brief.actions,
    ...state.brief.rationales,
  ];
}

function expectedSignalManifest(state: DecisionNodeState) {
  return [
    ...state.brief.decisions.map((signal, position) => ({
      signal_id: signal.id,
      kind: signal.kind,
      position_within_kind: position,
      sha256: canonicalSha256(signal),
    })),
    ...state.brief.actions.map((signal, position) => ({
      signal_id: signal.id,
      kind: signal.kind,
      position_within_kind: position,
      sha256: canonicalSha256(signal),
    })),
    ...state.brief.rationales.map((signal, position) => ({
      signal_id: signal.id,
      kind: signal.kind,
      position_within_kind: position,
      sha256: canonicalSha256(signal),
    })),
  ];
}

function assertManifestSnapshot(
  manifestId: string,
  manifestSha256: `sha256:${string}`,
  organizationId: string,
  label: string,
  lineage: FounderFederationLineageReader,
): void {
  const byId = lineage.loadVerifiedManifest(manifestId);
  const byDigest = lineage.loadVerifiedManifestBySha256(manifestSha256);
  if (
    byId.sha256 !== manifestSha256 ||
    byDigest.sha256 !== manifestSha256 ||
    byDigest.manifest.manifest_id !== manifestId ||
    byId.manifest.organization.organization_id !== organizationId ||
    byDigest.manifest.organization.organization_id !== organizationId
  ) {
    fail(`${label} identity-manifest snapshot does not resolve exactly`);
  }
}

function assertHistoricalEventReferenceClosure(
  event: Awaited<
    ReturnType<FederatedOutboxStore['readInstallationEvents']>
  >[number],
  lineage: FounderFederationLineageReader,
): void {
  const envelope = event.envelope;
  assertManifestSnapshot(
    envelope.source.identity_manifest_id,
    envelope.source.identity_manifest_sha256,
    envelope.organization_id,
    'source',
    lineage,
  );
  assertManifestSnapshot(
    envelope.processor.identity_manifest_id,
    envelope.processor.identity_manifest_sha256,
    envelope.organization_id,
    'processor',
    lineage,
  );
  const publication = envelope.publication;
  const policy = lineage.loadVerifiedPolicy(
    {
      policy_id: publication.policy_id,
      version: publication.version,
      policy_sha256: publication.policy_sha256,
      identity_manifest_id: publication.identity_manifest_id,
      signer_installation_id: publication.signer_installation_id,
      signer_key_id: publication.signer_key_id,
    },
    envelope.occurred_at,
  );
  const historicalPublication = {
    policy_id: policy.policy.policy_id,
    version: policy.policy.version,
    policy_sha256: policy.sha256,
    identity_manifest_id: policy.policy.identity_manifest_id,
    signer_installation_id: policy.policy.issued_by.installation_id,
    signer_key_id: policy.policy.issued_by.key_id,
    ...policy.policy.publication,
  };
  if (
    policy.manifest.organization.organization_id !== envelope.organization_id ||
    canonicalJson(historicalPublication) !== canonicalJson(publication)
  ) {
    fail('event publication policy snapshot does not resolve exactly');
  }
}

function historicalEventVerificationKey(
  event: Awaited<
    ReturnType<FederatedOutboxStore['readInstallationEvents']>
  >[number],
  lineage: FounderFederationLineageReader,
) {
  const verified: VerifiedHistoricalIdentityManifest =
    lineage.loadVerifiedManifestBySha256(
      event.envelope.identity_manifest_sha256,
    );
  const manifest = verified.manifest;
  if (
    verified.sha256 !== event.envelope.identity_manifest_sha256 ||
    event.installation_id !== event.envelope.producer.installation_id ||
    manifest.organization.organization_id !== event.envelope.organization_id ||
    manifest.principal.principal_id !== event.envelope.producer.principal_id ||
    manifest.membership.membership_id !==
      event.envelope.producer.membership_id ||
    manifest.installation.installation_id !==
      event.envelope.producer.installation_id ||
    manifest.installation.signing_key.key_id !== event.envelope.producer.key_id
  ) {
    fail(
      `historical event ${event.event_id} has an invalid identity-manifest reference`,
    );
  }
  assertHistoricalEventReferenceClosure(event, lineage);
  return {
    key_id: manifest.installation.signing_key.key_id,
    public_key_spki_der: Buffer.from(
      manifest.installation.signing_key.public_key_spki_der_base64,
      'base64',
    ),
  };
}

async function assertApprovedProjectionCompleteness(
  states: readonly DecisionNodeState[],
  lineage: FounderFederationLineageReader,
  outbox: FederatedOutboxStore,
  attributions: SqliteFederatedAttributionStore,
  artifactProvider: ProductArtifactEvidenceProvider,
): Promise<number> {
  const approved = states.filter((state) => state.status === 'approved');
  const eventsByInstallation = new Map<
    string,
    Awaited<ReturnType<FederatedOutboxStore['readInstallationEvents']>>
  >();

  for (const state of approved) {
    const signals = approvedSignals(state);
    if (signals.length === 0) {
      fail(`approval ${state.approval_id} projection is pending (no signals)`);
    }
    const requested = requestedFederationMetadata(state);
    const metadata = validateFederationDocument<ApprovalFederationMetadataV1>(
      'approval-federation-metadata',
      requested,
    );
    const manifest = lineage.loadVerifiedManifest(
      metadata.identity_manifest_id,
    );
    const installation = manifest.manifest.installation;
    let installationEvents = eventsByInstallation.get(
      installation.installation_id,
    );
    if (installationEvents === undefined) {
      installationEvents = await outbox.readInstallationEvents(
        installation.installation_id,
      );
      eventsByInstallation.set(
        installation.installation_id,
        installationEvents,
      );
    }
    const group = installationEvents.filter(
      (event) =>
        event.envelope.local_reference.approval_id === state.approval_id,
    );
    const expectedSubjects = signals
      .map((signal) => `approved-org-record:${state.approval_id}:${signal.id}`)
      .sort();
    const actualSubjects = group.map((event) => event.local_subject_key).sort();
    if (group.length === 0) {
      throw new ProjectionPendingError(state.approval_id);
    }
    if (canonicalJson(actualSubjects) !== canonicalJson(expectedSubjects)) {
      fail(
        `approval ${state.approval_id} projection is incomplete or divergent`,
      );
    }

    const approvedBriefSha256 = canonicalSha256(state.brief);
    const sidecars = await attributions.getAttributionsForMetadata(metadata);
    const snapshots = buildFederatedProjectionSnapshots({
      state,
      metadata,
      manifest: manifest.manifest,
      sourceAttribution: sidecars.source,
      processorAttribution: sidecars.processor,
      lineage,
      artifactProvider,
    });
    const signalManifest = expectedSignalManifest(state);
    const projectionArtifact = canonicalJson(
      group[0]!.envelope.producer.product_artifact,
    );
    const signalsById = new Map(signals.map((signal) => [signal.id, signal]));
    for (const event of group) {
      const reference = event.envelope.local_reference;
      const signal = signalsById.get(reference.signal_id);
      if (
        signal === undefined ||
        event.installation_id !== installation.installation_id ||
        event.envelope.producer.installation_id !==
          installation.installation_id ||
        event.envelope.producer.key_id !== installation.signing_key.key_id ||
        canonicalJson(event.envelope.producer.product_artifact) !==
          projectionArtifact ||
        event.envelope.occurred_at !== state.reviewed_at ||
        state.reviewed_at === null ||
        state.requested_at > state.reviewed_at ||
        canonicalJson(event.envelope.publication) !==
          canonicalJson(metadata.publication) ||
        event.envelope.identity_manifest_sha256 !== manifest.sha256 ||
        reference.processing_key !== state.processing_key ||
        reference.approval_id !== state.approval_id ||
        reference.node_id !== state.node_id ||
        reference.meeting_id !== state.brief.meeting.id ||
        event.envelope.record.signal_id !== signal.id ||
        canonicalJson(event.envelope.record.signal) !== canonicalJson(signal) ||
        canonicalJson(event.envelope.record.meeting_context) !==
          canonicalJson(state.brief.meeting) ||
        event.envelope.record.approval_group.brief_schema_version !==
          state.brief.schema_version ||
        event.envelope.record.approval_group.brief_id !== state.brief.id ||
        canonicalJson(event.envelope.record.approval_group.signal_manifest) !==
          canonicalJson(signalManifest) ||
        event.envelope.record.approval_group.approved_brief_sha256 !==
          approvedBriefSha256 ||
        event.envelope.approval.approved_brief_sha256 !== approvedBriefSha256 ||
        canonicalJson(event.envelope.source) !==
          canonicalJson(snapshots.source) ||
        canonicalJson(event.envelope.processor) !==
          canonicalJson(snapshots.processor) ||
        canonicalJson(event.envelope.approval) !==
          canonicalJson(snapshots.approval)
      ) {
        fail(`approval ${state.approval_id} projection differs from its node`);
      }
    }
  }
  return approved.length;
}

/**
 * Owns one command's identity-enabled resources. Nothing durable is opened in
 * the inactive rehearsal lane. Active commands share the same readers/stores
 * across capture, projection, export readiness, and the core-state wrappers.
 */
export async function openFounderFederationRuntime(
  options: FounderFederationRuntimeOptions,
): Promise<FounderFederationRuntime> {
  const stateDirectory = options.runtimeConfig.state_dir;
  const identity =
    options.identityStore ?? new ActiveIdentityBundleStore(stateDirectory);
  const active = identity.loadVerified(options.runtimeConfig);
  if (active === null && requiresFounderFederation(stateDirectory, identity)) {
    fail('identity material exists without a valid active bundle');
  }

  if (active === null) {
    const capture = new FederatedApprovalCapture({
      stateDirectory,
      runtimeConfig: options.runtimeConfig,
      identityBundleReader: identity,
    });
    return {
      identityEnabled: false,
      approvalCapture: capture,
      signer: options.signer,
      createDecisionNodeStore: () =>
        new DecisionNodeStore(stateDirectory, {
          now: options.now,
          createId: options.createId,
          federationCapture: capture,
        }),
      wrapCoreState: (base) => base,
      projectApproved: async () =>
        fail('inactive rehearsal records cannot enter the federated outbox'),
      ensureIndependentCopy: async () =>
        fail('inactive rehearsal mode has no federated records to copy'),
      identityChecks: (configured = {}) => ({
        ...configured,
        ...(configured.signer === undefined && options.signer !== undefined
          ? { signer: options.signer }
          : {}),
      }),
      close: async () => undefined,
    };
  }

  let attribution: SqliteFederatedAttributionStore | undefined;
  let outbox: FederatedOutboxStore | undefined;
  try {
    const artifact =
      options.artifactProvider ?? new PackagedProductArtifactEvidenceProvider();
    const lineage = options.lineage ?? new IdentityLineageStore(stateDirectory);
    attribution =
      options.attributionStore ??
      new SqliteFederatedAttributionStore(options.databasePath);
    outbox = options.outbox ?? new FederatedOutboxStore(options.databasePath);
    const signer = options.signer;
    const capture = new FederatedApprovalCapture({
      stateDirectory,
      runtimeConfig: options.runtimeConfig,
      identityBundleReader: identity,
      identityLineageReader: lineage,
      attributionProvider: attribution,
      artifactProvider: artifact,
    });
    const defaultDecisionNodes = new DecisionNodeStore(stateDirectory, {
      now: options.now,
      createId: options.createId,
      federationCapture: capture,
    });
    const projectionDecisionNodes =
      options.projectionDecisionNodes ?? defaultDecisionNodes;
    const legacyDecisionNodes =
      options.legacyDecisionNodes ?? defaultDecisionNodes;
    const projector =
      signer === undefined
        ? undefined
        : new FederatedRecordProjector({
            signer,
            artifactProvider: artifact,
            attributionProvider: attribution,
            outbox,
            lineage,
            now: options.now,
          });
    const independentCopy =
      options.independentCopyStore ??
      (signer === undefined
        ? undefined
        : new FounderIndependentCopyStore({
            stateDirectory,
            outbox,
            identitySource: lineage,
            signer,
            ...(options.independentCopyInspector === undefined
              ? {}
              : { inspector: options.independentCopyInspector }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.createExportId === undefined
              ? {}
              : { createExportId: options.createExportId }),
          }));
    const attributionEvidence = createAttributionStorageEvidenceVerifier(
      lineage,
      artifact,
    );
    let closed = false;

    const approvalCaptureReady = async () => {
      try {
        const current = artifact.current();
        artifact.verify(current);
        return {
          ok: true,
          detail:
            'approval capture shares verified attribution, lineage, and retained product-artifact evidence',
        };
      } catch (error) {
        return {
          ok: false,
          detail: `approval capture evidence is unavailable: ${(error as Error).message}`,
        };
      }
    };
    const attributionStorageReady = async () => {
      try {
        const result =
          attribution!.verifyStoredAttributions(attributionEvidence);
        return {
          ok: true,
          detail: `verified ${result.source_attributions} source and ${result.processor_attributions} processor attribution sidecars`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `attribution storage is invalid: ${(error as Error).message}`,
        };
      }
    };
    const signedOutboxReady = async () => {
      try {
        if (signer === undefined) {
          throw new Error('installation signer is unavailable');
        }
        const installation = active.manifest.installation;
        const descriptor = await signer.inspect(installation.installation_id);
        if (descriptor === null) {
          throw new Error('installation signing key is unavailable');
        }
        verifyInstallationKeyDescriptor(descriptor);
        if (
          descriptor.key_id !== installation.signing_key.key_id ||
          descriptor.public_key_spki_der_base64 !==
            installation.signing_key.public_key_spki_der_base64
        ) {
          throw new Error('live signer does not match the active manifest');
        }
        // The live descriptor proves that this command still controls the
        // active installation key. Historical events are verified with the
        // exact manifest digest each event committed, so key rotation cannot
        // make an otherwise valid local chain unverifiable.
        const installationIds = new Set(await outbox!.listInstallationIds());
        installationIds.add(installation.installation_id);
        let eventCount = 0;
        const verifiedArtifacts = new Set<string>();
        const verifyArtifactOnce = (value: ProductArtifactIdentityV1) => {
          const identity = canonicalJson(value);
          if (verifiedArtifacts.has(identity)) return;
          artifact.verify(value);
          verifiedArtifacts.add(identity);
        };
        for (const installationId of [...installationIds].sort()) {
          const chain = await outbox!.verifyInstallationChain(
            installationId,
            (event) => historicalEventVerificationKey(event, lineage),
          );
          for (const event of chain.events) {
            verifyArtifactOnce(event.envelope.producer.product_artifact);
            verifyArtifactOnce(event.envelope.source.observed_by);
            verifyArtifactOnce(event.envelope.processor.produced_by);
            verifyArtifactOnce(
              event.envelope.approval.surface === null
                ? event.envelope.approval.observed_by
                : event.envelope.approval.observation.observed_by,
            );
          }
          eventCount += chain.events.length;
        }
        const projectedApprovals = await assertApprovedProjectionCompleteness(
          await projectionDecisionNodes.listFederated(),
          lineage,
          outbox!,
          attribution!,
          artifact,
        );
        return {
          ok: true,
          detail: `verified signed outbox chains with ${eventCount} event${eventCount === 1 ? '' : 's'} and ${projectedApprovals} projected approval${projectedApprovals === 1 ? '' : 's'}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail:
            error instanceof ProjectionPendingError
              ? `projection pending: ${error.message}`
              : `signed outbox is unavailable or invalid: ${(error as Error).message}`,
        };
      }
    };
    const independentCopyReady = async () => {
      if (independentCopy === undefined) {
        return {
          ok: false,
          detail:
            'protected independent-copy runtime is unavailable without the installation signer',
        };
      }
      const result = await independentCopy.check();
      return { ok: result.ok, detail: result.detail };
    };
    const legacyBoundaryReady = async () => {
      try {
        const fence = inspectFounderCutoverFence(stateDirectory);
        if (fence.state !== 'committing' && fence.state !== 'complete') {
          throw new Error('no irreversible founder cutover session exists');
        }
        await assertLegacyProcessingBoundaryReady({
          decision_nodes: legacyDecisionNodes,
          core_database_path: options.databasePath,
        });
        const verified = await verifyLegacyClassificationReport({
          state_directory: stateDirectory,
          bootstrap_session_id: fence.session.session_id,
          decision_nodes: legacyDecisionNodes,
          core_database_path: options.databasePath,
          cutover_at: active.manifest.legacy_cutover.declared_at,
        });
        const counts = verified.document.classification.counts;
        return {
          ok: true,
          detail: `verified immutable legacy boundary: ${counts.disposable_test} disposable rehearsal${counts.disposable_test === 1 ? '' : 's'} and ${counts.legacy_imported_unverified} delivered unverified record${counts.legacy_imported_unverified === 1 ? '' : 's'}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `legacy cutover boundary is unavailable or invalid: ${(error as Error).message}`,
        };
      }
    };
    const ensureIndependentCopy = async (): Promise<IndependentCopyReadiness> => {
      if (independentCopy === undefined) {
        fail(
          'protected independent-copy runtime is unavailable without the installation signer',
        );
      }
      const result = await independentCopy.ensure();
      if (!result.ok) fail(result.detail);
      return result;
    };
    const projectAndCopy = async (state: DecisionNodeState) => {
      if (projector === undefined) {
        fail('identity-enabled projection requires the installation signer');
      }
      const projected = await projector.projectApproved(state);
      await ensureIndependentCopy();
      return projected;
    };
    return {
      identityEnabled: true,
      approvalCapture: capture,
      signer,
      createDecisionNodeStore: () =>
        new DecisionNodeStore(stateDirectory, {
          now: options.now,
          createId: options.createId,
          federationCapture: capture,
        }),
      wrapCoreState(base, decisions) {
        if (projector === undefined) {
          fail('identity-enabled core state requires the installation signer');
        }
        const attributing = new AttributingCoreStateStore(base, {
          stateDirectory,
          databasePath: options.databasePath,
          artifactProvider: artifact,
          now: options.now,
          identityBundleReader: identity,
          attributionStore: attribution,
        });
        return new ApprovalProjectingCoreStateStore(
          attributing,
          decisions,
          projector,
          async () => {
            await ensureIndependentCopy();
          },
        );
      },
      projectApproved: projectAndCopy,
      ensureIndependentCopy,
      identityChecks(configured = {}) {
        return {
          ...configured,
          // Runtime-owned readiness must describe these exact command-scoped
          // resources. Callers may still supply the independent-copy probe
          // until WS5 installs its concrete protected-copy verifier.
          signer: signer ?? configured.signer,
          legacyBoundaryReady,
          approvalCaptureReady,
          attributionStorageReady,
          signedOutboxReady,
          independentCopyReady,
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await outbox!.close();
        } finally {
          attribution!.close();
        }
      },
    };
  } catch (error) {
    try {
      await outbox?.close();
    } finally {
      attribution?.close();
    }
    throw error;
  }
}
