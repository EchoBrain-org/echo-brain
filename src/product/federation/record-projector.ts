import type { DecisionNodeState } from '../approval/decision-node.js';
import type {
  ApprovalAttributionProvider,
  ProductArtifactEvidenceProvider,
} from './approval-capture-support.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  FederatedPublicationSnapshotV1,
  ProductArtifactIdentityV1,
} from './contracts.js';
import type { InstallationSigner } from './installation-signer.js';
import {
  FederatedOutboxStore,
  type StoredFederatedOutboxEvent,
} from './outbox-store.js';
import { validateFederationDocument } from './schema-validation.js';
import {
  buildFederatedProjectionSnapshots,
  type RecordProjectorLineageReader,
} from './record-projection-snapshots.js';
import {
  buildProjectionSignalManifest,
  buildRecordProjectionDrafts,
  createHistoricalVerificationKeyResolver,
  orderedProjectionItems,
  projectionSubject,
} from './record-projection-drafts.js';

export {
  buildFederatedApprovalSnapshot,
  buildFederatedProjectionSnapshots,
} from './record-projection-snapshots.js';
export type {
  FederatedProjectionSnapshots,
  RecordProjectorLineageReader,
} from './record-projection-snapshots.js';

interface RecordProjectorOutboxWriter {
  appendApprovalGroup(
    request: Parameters<FederatedOutboxStore['appendApprovalGroup']>[0],
  ): Promise<readonly StoredFederatedOutboxEvent[]>;
  readByLocalSubject(
    installationId: Parameters<FederatedOutboxStore['readByLocalSubject']>[0],
    localSubjectKey: string,
  ): Promise<StoredFederatedOutboxEvent | undefined>;
}

export interface FederatedRecordProjectorOptions {
  signer: InstallationSigner;
  artifactProvider: ProductArtifactEvidenceProvider;
  attributionProvider: ApprovalAttributionProvider;
  outbox: RecordProjectorOutboxWriter;
  lineage: RecordProjectorLineageReader;
  now?: () => string;
}

function fail(message: string): never {
  throw new Error(`federated record projection failed: ${message}`);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export class FederatedRecordProjector {
  private readonly now: () => string;

  constructor(private readonly options: FederatedRecordProjectorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async projectApproved(
    state: DecisionNodeState,
  ): Promise<readonly StoredFederatedOutboxEvent[]> {
    if (
      state.status !== 'approved' ||
      state.reviewed_at === null ||
      state.reviewed_by === null
    ) {
      fail('only a durably approved decision node can be projected');
    }
    const items = orderedProjectionItems(state);
    if (items.length === 0) {
      fail('approved brief has no signals and cannot form an envelope group');
    }
    const metadata = validateFederationDocument<ApprovalFederationMetadataV1>(
      'approval-federation-metadata',
      clone(state.requested_metadata['federation']),
    );
    const verifiedManifest = this.options.lineage.loadVerifiedManifest(
      metadata.identity_manifest_id,
    );
    const manifest = verifiedManifest.manifest;
    const verifiedPolicy = this.options.lineage.loadVerifiedPolicy(
      {
        policy_id: metadata.publication.policy_id,
        version: metadata.publication.version,
        policy_sha256: metadata.publication.policy_sha256,
        identity_manifest_id: metadata.publication.identity_manifest_id,
        signer_installation_id: metadata.publication.signer_installation_id,
        signer_key_id: metadata.publication.signer_key_id,
      },
      state.reviewed_at,
    );
    const historicalPublication = {
      policy_id: verifiedPolicy.policy.policy_id,
      version: verifiedPolicy.policy.version,
      policy_sha256: verifiedPolicy.sha256,
      identity_manifest_id: verifiedPolicy.policy.identity_manifest_id,
      signer_installation_id: verifiedPolicy.policy.issued_by.installation_id,
      signer_key_id: verifiedPolicy.policy.issued_by.key_id,
      ...verifiedPolicy.policy.publication,
    } satisfies FederatedPublicationSnapshotV1;
    if (
      canonicalJson(historicalPublication) !==
      canonicalJson(metadata.publication)
    ) {
      fail('historical publication policy differs from the approved snapshot');
    }
    const rawAttributions =
      await this.options.attributionProvider.getAttributionsForMetadata(
        metadata,
      );
    const attributions = {
      source: validateFederationDocument<
        Awaited<
          ReturnType<ApprovalAttributionProvider['getAttributionsForMetadata']>
        >['source']
      >('source-attribution', clone(rawAttributions.source)),
      processor: validateFederationDocument<
        Awaited<
          ReturnType<ApprovalAttributionProvider['getAttributionsForMetadata']>
        >['processor']
      >('processor-attribution', clone(rawAttributions.processor)),
    };
    const snapshots = buildFederatedProjectionSnapshots({
      state,
      metadata,
      manifest,
      sourceAttribution: attributions.source,
      processorAttribution: attributions.processor,
      lineage: this.options.lineage,
      artifactProvider: this.options.artifactProvider,
    });
    if (
      metadata.publication.participant_observations !== 'included-namespaced'
    ) {
      fail(
        'publication policy has unsupported participant-observation semantics',
      );
    }
    const installationId = manifest.installation.installation_id;
    const firstSubject = projectionSubject(
      state.approval_id,
      items[0]!.signal.id,
    );
    const existing = await this.options.outbox.readByLocalSubject(
      installationId,
      firstSubject,
    );
    let projectionArtifact: ProductArtifactIdentityV1;
    if (existing === undefined) {
      projectionArtifact = clone(this.options.artifactProvider.current());
    } else {
      if (
        existing.local_subject_key !== firstSubject ||
        existing.installation_id !== installationId ||
        existing.envelope.local_reference.approval_id !== state.approval_id ||
        existing.envelope.local_reference.signal_id !== items[0]!.signal.id ||
        existing.envelope.producer.installation_id !== installationId ||
        existing.envelope.producer.key_id !==
          manifest.installation.signing_key.key_id
      ) {
        fail('existing projection subject belongs to another approval lineage');
      }
      projectionArtifact = clone(existing.envelope.producer.product_artifact);
    }
    this.options.artifactProvider.verify(projectionArtifact);
    const approvedBriefSha256 = canonicalSha256(state.brief);
    const signalManifest = buildProjectionSignalManifest(items);
    const historicalVerificationKeyResolver =
      createHistoricalVerificationKeyResolver(this.options.lineage);
    const drafts = buildRecordProjectionDrafts({
      state,
      items,
      manifest,
      identityManifestSha256: verifiedManifest.sha256,
      projectionArtifact,
      metadata,
      snapshots,
      approvedBriefSha256,
      signalManifest,
    });
    return await this.options.outbox.appendApprovalGroup({
      installation_id: installationId,
      key_id: manifest.installation.signing_key.key_id,
      created_at: this.now(),
      signer: this.options.signer,
      historical_verification_key_resolver: historicalVerificationKeyResolver,
      events: drafts,
    });
  }
}
