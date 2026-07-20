import { createHash } from 'node:crypto';
import type { DecisionNodeState } from '../../approval/decision-node.js';
import { canonicalJson, canonicalSha256 } from '../foundation/canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  FederatedPublicationSnapshotV1,
  FederatedRecordV1,
  LocalIdentityManifestV1,
  ProductArtifactIdentityV1,
  Sha256Digest,
} from '../contracts.js';
import type {
  FederatedEventDraftV1,
  FederatedChainVerificationKeyResolver,
  FederatedOutboxEventDraft,
} from '../outbox-store.js';
import type {
  FederatedProjectionSnapshots,
  RecordProjectorLineageReader,
} from './record-projection-snapshots.js';

function fail(message: string): never {
  throw new Error(`federated record projection failed: ${message}`);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deterministicId(
  prefix: 'evt' | 'rec',
  installationId: string,
  approvalId: string,
  signalId: string,
): string {
  const bytes = createHash('sha256')
    .update(
      canonicalJson({
        domain: `echo.${prefix}-identity.v1`,
        installation_id: installationId,
        approval_id: approvalId,
        signal_id: signalId,
      }),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function orderedProjectionItems(state: DecisionNodeState) {
  return [
    ...state.brief.decisions.map((signal, position) => ({ signal, position })),
    ...state.brief.actions.map((signal, position) => ({ signal, position })),
    ...state.brief.rationales.map((signal, position) => ({ signal, position })),
  ];
}

export function projectionSubject(
  approvalId: string,
  signalId: string,
): string {
  return `approved-org-record:${approvalId}:${signalId}`;
}

export function buildProjectionSignalManifest(
  items: ReturnType<typeof orderedProjectionItems>,
) {
  return items.map(({ signal, position }) => ({
    signal_id: signal.id,
    kind: signal.kind,
    position_within_kind: position,
    sha256: canonicalSha256(signal),
  }));
}

export function createHistoricalVerificationKeyResolver(
  lineage: RecordProjectorLineageReader,
): FederatedChainVerificationKeyResolver {
  const loadHistoricalManifestByDigest =
    lineage.loadVerifiedManifestBySha256;
  if (loadHistoricalManifestByDigest === undefined) {
    fail('identity lineage cannot resolve historical manifest digests');
  }
  return (event) => {
    const historical = loadHistoricalManifestByDigest.call(
      lineage,
      event.envelope.identity_manifest_sha256,
    );
    if (
      historical.sha256 !== event.envelope.identity_manifest_sha256 ||
      historical.manifest.organization.organization_id !==
        event.envelope.organization_id ||
      historical.manifest.principal.principal_id !==
        event.envelope.producer.principal_id ||
      historical.manifest.membership.membership_id !==
        event.envelope.producer.membership_id ||
      historical.manifest.installation.installation_id !==
        event.envelope.producer.installation_id ||
      historical.manifest.installation.signing_key.key_id !==
        event.envelope.producer.key_id
    ) {
      fail(
        `historical event ${event.event_id} has an invalid identity-manifest reference`,
      );
    }
    return {
      key_id: historical.manifest.installation.signing_key.key_id,
      public_key_spki_der: Buffer.from(
        historical.manifest.installation.signing_key
          .public_key_spki_der_base64,
        'base64',
      ),
    };
  };
}

export function buildRecordProjectionDrafts(options: {
  state: DecisionNodeState;
  items: ReturnType<typeof orderedProjectionItems>;
  manifest: LocalIdentityManifestV1;
  identityManifestSha256: Sha256Digest;
  projectionArtifact: ProductArtifactIdentityV1;
  metadata: ApprovalFederationMetadataV1;
  snapshots: FederatedProjectionSnapshots;
  approvedBriefSha256: `sha256:${string}`;
  signalManifest: ReturnType<typeof buildProjectionSignalManifest>;
}): readonly FederatedOutboxEventDraft[] {
  const installationId = options.manifest.installation.installation_id;
  return options.items.map(({ signal }) => {
    const record = {
      record_id: deterministicId(
        'rec',
        installationId,
        options.state.approval_id,
        signal.id,
      ),
      kind: signal.kind,
      signal_id: signal.id,
      signal: clone(signal),
      meeting_context: clone(options.state.brief.meeting),
      approval_group: {
        brief_schema_version: 1 as const,
        brief_id: options.state.brief.id,
        approved_brief_sha256: options.approvedBriefSha256,
        signal_manifest: clone(options.signalManifest),
      },
    } as FederatedRecordV1;
    const envelope: FederatedEventDraftV1 = {
      schema_version: 1,
      kind: 'echo-federated-event',
      event_type: 'approved-org-record',
      event_id: deterministicId(
        'evt',
        installationId,
        options.state.approval_id,
        signal.id,
      ),
      organization_id: options.manifest.organization.organization_id,
      occurred_at: options.state.reviewed_at!,
      producer: {
        principal_id: options.manifest.principal.principal_id,
        membership_id: options.manifest.membership.membership_id,
        installation_id: installationId,
        key_id: options.manifest.installation.signing_key.key_id,
        membership_assertion: {
          status: 'active',
          authority: 'local-founder-bootstrap',
          assurance: 'founder_attested',
        },
        product_artifact: clone(options.projectionArtifact),
      },
      source: clone(options.snapshots.source),
      processor: clone(options.snapshots.processor),
      local_reference: {
        processing_key: options.state.processing_key,
        approval_id: options.state.approval_id,
        node_id: options.state.node_id,
        meeting_id: options.state.brief.meeting.id,
        signal_id: signal.id,
      },
      record,
      approval: clone(options.snapshots.approval),
      publication: clone(
        options.metadata.publication,
      ) as FederatedPublicationSnapshotV1,
      classification: 'native_attributed',
      identity_manifest_sha256: options.identityManifestSha256,
    };
    return {
      local_subject_key: projectionSubject(
        options.state.approval_id,
        signal.id,
      ),
      envelope,
    };
  });
}
