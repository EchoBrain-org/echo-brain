import type { JsonObject, JsonValue } from '../../core/index.js';
import type { DecisionNodeState } from '../approval/decision-node.js';
import type {
  ApprovalAttributionProvider,
  ProductArtifactEvidenceProvider,
} from './approval-capture-support.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  ApprovalSurfaceCandidateV1,
  FederatedApprovalSnapshotV1,
  FederatedParticipantObservationV1,
  FederatedProcessorSnapshotV1,
  FederatedSourceSnapshotV1,
  LocalIdentityManifestV1,
  ProductArtifactIdentityV1,
  ProcessorAttributionV1,
  ProviderIdentityV1,
  Sha256Digest,
  SlackApprovalObservationSnapshotV1,
  SlackApprovalSnapshotV1,
  SlackProviderIdentitySnapshotV1,
  SourceAttributionV1,
} from './contracts.js';
import {
  IdentityLineageStore,
  type ResolvedHistoricalBinding,
} from './identity-lineage-store.js';

export interface RecordProjectorLineageReader {
  assertManifestAncestorOrEqual(
    ancestorManifestId: string,
    descendantManifestId: string,
  ): void;
  loadVerifiedManifest(
    manifestId: string,
  ): ReturnType<IdentityLineageStore['loadVerifiedManifest']>;
  loadVerifiedManifestBySha256?(
    sha256: Parameters<IdentityLineageStore['loadVerifiedManifestBySha256']>[0],
  ): ReturnType<IdentityLineageStore['loadVerifiedManifestBySha256']>;
  loadVerifiedPolicy(
    reference: Parameters<IdentityLineageStore['loadVerifiedPolicy']>[0],
    observedAt: string,
  ): ReturnType<IdentityLineageStore['loadVerifiedPolicy']>;
  resolveBindingSnapshotAt(
    locator: Parameters<IdentityLineageStore['resolveBindingSnapshotAt']>[0],
    observedAt: string,
  ): ResolvedHistoricalBinding;
}

interface ResolvedFederationMetadata {
  actor: Record<string, unknown>;
  approvalContext: {
    candidateContextSha256: `sha256:${string}`;
    presentation: JsonValue;
    approvedContextSha256: `sha256:${string}`;
  };
  observation: Record<string, unknown>;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`federated record projection failed: ${message}`);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  const result = string(value, label);
  if (!DIGEST_RE.test(result)) fail(`${label} must be a SHA-256 digest`);
  return result as `sha256:${string}`;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value as number;
}

function approvedContextDigest(
  candidateContextSha256: `sha256:${string}`,
  presentation: JsonValue,
): `sha256:${string}` {
  return canonicalSha256({
    domain: 'echo.approved-context.v1',
    candidate_context_sha256: candidateContextSha256,
    presentation,
  });
}

function copiedReasonDigest(reason: string): `sha256:${string}` {
  return canonicalSha256({
    domain: 'echo.slack-copied-reason.v1',
    text: reason,
  });
}

function parseResolvedMetadata(
  value: JsonObject | null,
): ResolvedFederationMetadata {
  const root = record(value, 'resolved metadata');
  const federation = record(root['federation'], 'resolved federation metadata');
  const actor = record(federation['actor'], 'resolved actor');
  const context = record(
    federation['approval_context'],
    'resolved approval context',
  );
  return {
    actor,
    approvalContext: {
      candidateContextSha256: digest(
        context['candidate_context_sha256'],
        'resolved candidate context',
      ),
      presentation: clone(context['presentation'] as JsonValue),
      approvedContextSha256: digest(
        context['approved_context_sha256'],
        'resolved approved context',
      ),
    },
    observation: record(
      federation['approval_surface_observation'],
      'resolved approval observation',
    ),
  };
}

function slackProviderSnapshot(
  identity: ProviderIdentityV1,
): SlackProviderIdentitySnapshotV1 {
  if (
    identity.tenant?.kind !== 'slack-team' ||
    identity.subject?.kind !== 'bot-installation' ||
    identity.verification.method !== 'slack_auth_test' ||
    identity.verification.assurance !== 'provider_verified'
  ) {
    fail('approval observation is not a verified Slack bot identity');
  }
  return {
    provider: 'slack',
    team_id: identity.tenant.id,
    enterprise_id: identity.tenant.enterprise_id,
    bot_user_id: identity.subject.id,
    bot_id: identity.subject.bot_id,
    app_id: identity.subject.app_id,
  };
}

function artifact(
  value: unknown,
  provider: ProductArtifactEvidenceProvider,
  label: string,
): ProductArtifactIdentityV1 {
  const item = record(value, label) as unknown as ProductArtifactIdentityV1;
  provider.verify(item);
  return clone(item);
}

function participantObservations(
  value: readonly JsonObject[],
): readonly FederatedParticipantObservationV1[] {
  return value.map((item, index) => {
    const observation = record(item, `participant observation ${index}`);
    const claims = observation['observed_claims'];
    if (!Array.isArray(claims)) {
      fail(`participant observation ${index} claims must be an array`);
    }
    return {
      meeting_participant_id: string(
        observation['meeting_participant_id'],
        `participant observation ${index} id`,
      ),
      display_name:
        observation['display_name'] === null
          ? null
          : string(
              observation['display_name'],
              `participant observation ${index} display name`,
            ),
      observed_claims: claims.map((claim, claimIndex) => {
        const entry = record(
          claim,
          `participant observation ${index} claim ${claimIndex}`,
        );
        const kind = entry['kind'];
        if (
          kind !== 'source' &&
          kind !== 'email' &&
          kind !== 'phone' &&
          kind !== 'other'
        ) {
          fail(`participant observation ${index} claim kind is invalid`);
        }
        return {
          namespace: string(entry['namespace'], 'participant claim namespace'),
          kind,
          value: string(entry['value'], 'participant claim value'),
        };
      }),
    };
  });
}

function publicationSurface(
  candidate: ApprovalSurfaceCandidateV1,
  state: DecisionNodeState,
  context: ResolvedFederationMetadata['approvalContext'],
): SlackApprovalSnapshotV1['surface'] {
  if (candidate.connection === null) {
    fail('Slack approval candidate has no provider connection');
  }
  const presentation = record(context.presentation, 'Slack presentation');
  const published = state.published.filter(
    (event) => event.surface === 'slack',
  );
  if (published.length !== 1) {
    fail('approved Slack node must have exactly one publication');
  }
  const reference = record(
    published[0]!.reference,
    'Slack publication reference',
  );
  const slack = record(reference['slack'], 'Slack publication coordinates');
  const result = {
    binding: clone(candidate.binding),
    connection: clone(candidate.connection),
    presentation: {
      channel_id: string(
        presentation['channel_id'],
        'Slack presentation channel',
      ),
      message_ts: string(
        presentation['message_ts'],
        'Slack presentation message',
      ),
      rendered_blocks_sha256: digest(
        presentation['rendered_blocks_sha256'],
        'Slack presentation digest',
      ),
    },
  };
  if (
    result.presentation.channel_id !== slack['channel_id'] ||
    result.presentation.message_ts !== slack['message_ts']
  ) {
    fail('approved Slack presentation differs from its published coordinates');
  }
  return result;
}

function observationSnapshot(
  metadata: ApprovalFederationMetadataV1,
  resolved: ResolvedFederationMetadata,
  reviewedAt: string,
  lineage: RecordProjectorLineageReader,
  artifactProvider: ProductArtifactEvidenceProvider,
): SlackApprovalObservationSnapshotV1 {
  const value = resolved.observation;
  const located = lineage.resolveBindingSnapshotAt(
    {
      identity_manifest_id: metadata.identity_manifest_id,
      adapter_binding_id: string(
        value['adapter_binding_id'],
        'approval observation binding',
      ),
      connection_id: string(
        value['connection_id'],
        'approval observation connection',
      ),
      connection_generation: positiveInteger(
        value['connection_generation'],
        'approval observation generation',
      ),
      configuration_sha256: digest(
        value['configuration_sha256'],
        'approval observation configuration',
      ),
    },
    reviewedAt,
  );
  if (
    located.binding.capability !== 'approval-surface' ||
    located.connection === null ||
    located.generation === null ||
    located.connection.provider !== 'slack'
  ) {
    fail('approval observation does not resolve to a Slack approval binding');
  }
  const candidate = metadata.approval_surface;
  if (candidate.connection === null) {
    fail('published Slack approval candidate has no connection');
  }
  const observedProvider = slackProviderSnapshot(
    located.generation.provider_identity,
  );
  if (
    located.connection.connection_id !== candidate.connection.connection_id ||
    located.binding.adapter_id !== candidate.binding.adapter.adapter_id ||
    located.binding.instance_id !== candidate.binding.adapter.instance_id ||
    located.binding.configuration_sha256 !==
      candidate.binding.configuration_sha256 ||
    canonicalJson(located.binding.configuration_snapshot) !==
      canonicalJson(candidate.binding.configuration_snapshot) ||
    canonicalJson(observedProvider) !==
      canonicalJson(candidate.connection.provider_identity) ||
    digest(
      value['provider_identity_sha256'],
      'approval observation provider identity',
    ) !== canonicalSha256(observedProvider)
  ) {
    fail('publication and reaction observation identities diverge');
  }
  return {
    binding: {
      adapter_binding_id: located.binding.adapter_binding_id,
      adapter: clone(candidate.binding.adapter),
      configuration_snapshot: clone(located.binding.configuration_snapshot),
      configuration_sha256: located.binding.configuration_sha256,
    },
    connection: {
      connection_id: located.connection.connection_id,
      generation: located.generation.generation,
      owner: clone(located.connection.owner),
      provider_identity: observedProvider,
    },
    observed_by: artifact(
      value['observed_by'],
      artifactProvider,
      'approval observation artifact',
    ),
  };
}

function approvalSnapshot(
  state: DecisionNodeState,
  metadata: ApprovalFederationMetadataV1,
  resolved: ResolvedFederationMetadata,
  manifest: LocalIdentityManifestV1,
  lineage: RecordProjectorLineageReader,
  artifactProvider: ProductArtifactEvidenceProvider,
  approvedBriefSha256: `sha256:${string}`,
): FederatedApprovalSnapshotV1 {
  const reviewedAt =
    state.reviewed_at ?? fail('approved node has no review time');
  if (state.reason !== null && state.reason.trim().length === 0) {
    fail('approved reason cannot be empty');
  }
  if (
    resolved.actor['principal_id'] !== manifest.principal.principal_id ||
    resolved.actor['membership_id'] !== manifest.membership.membership_id
  ) {
    fail('approval actor belongs to another local identity');
  }
  if (
    resolved.approvalContext.candidateContextSha256 !==
    metadata.candidate_context_sha256
  ) {
    fail('resolved candidate context differs from the requested candidate');
  }
  if (
    resolved.approvalContext.approvedContextSha256 !==
    approvedContextDigest(
      resolved.approvalContext.candidateContextSha256,
      resolved.approvalContext.presentation,
    )
  ) {
    fail('resolved approved-context digest is invalid');
  }
  const raw = record(
    resolved.actor['raw_assertion'],
    'approval actor assertion',
  );
  const observedBy = artifact(
    resolved.observation['observed_by'],
    artifactProvider,
    'approval observation artifact',
  );
  if (state.resolved_surface === 'slack') {
    const issuer = record(raw['issuer'], 'Slack actor issuer');
    const action = record(raw['action'], 'Slack actor action');
    const replyValue = raw['reason_reply'];
    const claimId = string(resolved.actor['claim_id'], 'Slack approver claim');
    const assurance = resolved.actor['assurance'];
    const claim = manifest.identity_claims.filter(
      (item) => item.claim_id === claimId,
    );
    if (
      claim.length !== 1 ||
      claim[0]!.principal_id !== manifest.principal.principal_id ||
      claim[0]!.issuer.kind !== 'provider' ||
      claim[0]!.issuer.provider !== 'slack' ||
      claim[0]!.issuer.tenant_id !== issuer['tenant_id'] ||
      claim[0]!.subject.kind !== 'user' ||
      claim[0]!.subject.id !== raw['subject_id'] ||
      claim[0]!.verification.assurance !== assurance ||
      claim[0]!.verification.verified_at > reviewedAt ||
      (assurance !== 'provider_challenge_observed' &&
        assurance !== 'provider_verified')
    ) {
      fail('Slack approval actor does not match one verified identity claim');
    }
    if (
      raw['surface'] !== 'slack' ||
      issuer['provider'] !== 'slack' ||
      raw['display_name'] !== state.reviewed_by ||
      action['kind'] !== 'reaction' ||
      action['observed_at'] !== reviewedAt ||
      action['name'] !==
        metadata.approval_surface.binding.configuration_snapshot[
          'approve_reaction'
        ]
    ) {
      fail('Slack approval actor assertion diverges from the approved node');
    }
    if (
      (state.reason === null && replyValue !== null) ||
      (state.reason !== null &&
        (replyValue === null ||
          record(replyValue, 'Slack reason reply')['author_subject_id'] !==
            raw['subject_id'] ||
          record(replyValue, 'Slack reason reply')['text_sha256'] !==
            copiedReasonDigest(state.reason)))
    ) {
      fail('Slack approval reason evidence diverges from the approved node');
    }
    const surface = publicationSurface(
      metadata.approval_surface,
      state,
      resolved.approvalContext,
    );
    if (
      raw['channel_id'] !== surface.presentation.channel_id ||
      raw['message_ts'] !== surface.presentation.message_ts
    ) {
      fail('Slack approval actor refers to another published message');
    }
    const result: SlackApprovalSnapshotV1 = {
      surface,
      observation: observationSnapshot(
        metadata,
        resolved,
        reviewedAt,
        lineage,
        artifactProvider,
      ),
      approver: {
        principal_id: string(
          resolved.actor['principal_id'],
          'Slack approver principal',
        ),
        membership_id: string(
          resolved.actor['membership_id'],
          'Slack approver membership',
        ),
        claim_id: claimId,
      },
      raw_actor_assertion: {
        provider: 'slack',
        tenant_id: string(issuer['tenant_id'], 'Slack actor tenant'),
        subject_id: string(raw['subject_id'], 'Slack actor subject'),
        display_name: string(raw['display_name'], 'Slack actor display name'),
        channel_id: string(raw['channel_id'], 'Slack actor channel'),
        message_ts: string(raw['message_ts'], 'Slack actor message'),
        action: {
          kind: 'reaction',
          name: string(action['name'], 'Slack actor reaction'),
          provider_occurred_at:
            action['provider_occurred_at'] === null
              ? null
              : string(
                  action['provider_occurred_at'],
                  'Slack provider occurrence time',
                ),
          observed_at: string(action['observed_at'], 'Slack observation time'),
        },
        reason_reply:
          replyValue === null
            ? null
            : (() => {
                const reply = record(replyValue, 'Slack reason reply');
                return {
                  message_ts: string(
                    reply['message_ts'],
                    'Slack reply message',
                  ),
                  author_subject_id: string(
                    reply['author_subject_id'],
                    'Slack reply author',
                  ),
                  text_sha256: digest(
                    reply['text_sha256'],
                    'Slack reply digest',
                  ),
                };
              })(),
      },
      assurance,
      reviewed_at: reviewedAt,
      reason: state.reason,
      approved_brief_sha256: approvedBriefSha256,
      approved_context_sha256: resolved.approvalContext.approvedContextSha256,
    };
    if (
      result.observation.observed_by.product_version !==
        observedBy.product_version ||
      canonicalJson(result.observation.observed_by) !==
        canonicalJson(observedBy)
    ) {
      fail('approval observation artifact mapping is inconsistent');
    }
    return result;
  }
  if (state.resolved_surface !== 'cli') {
    fail('approved node uses an unsupported resolution surface');
  }
  if (
    resolved.actor['claim_id'] !== null ||
    resolved.actor['assurance'] !== 'installation_holder_self_attested' ||
    resolved.approvalContext.presentation !== null ||
    resolved.observation['installation_id'] !==
      manifest.installation.installation_id ||
    resolved.observation['key_id'] !== manifest.installation.signing_key.key_id
  ) {
    fail('CLI approval identity snapshot is inconsistent');
  }
  if (
    raw['surface'] !== 'cli' ||
    raw['installation_id'] !== manifest.installation.installation_id ||
    raw['reviewer_label'] !== state.reviewed_by ||
    raw['command'] !== 'approve' ||
    raw['observed_at'] !== reviewedAt
  ) {
    fail('CLI approval actor assertion diverges from the approved node');
  }
  return {
    surface: null,
    approver: {
      principal_id: string(
        resolved.actor['principal_id'],
        'CLI approver principal',
      ),
      membership_id: string(
        resolved.actor['membership_id'],
        'CLI approver membership',
      ),
      claim_id: null,
    },
    raw_actor_assertion: {
      surface: 'cli',
      installation_id: string(raw['installation_id'], 'CLI installation'),
      reviewer_label: string(raw['reviewer_label'], 'CLI reviewer label'),
      command: 'approve',
      observed_at: string(raw['observed_at'], 'CLI observation time'),
    },
    assurance: 'installation_holder_self_attested',
    reviewed_at: reviewedAt,
    reason: state.reason,
    approved_brief_sha256: approvedBriefSha256,
    approved_context_sha256: resolved.approvalContext.approvedContextSha256,
    observed_by: observedBy,
  };
}

/**
 * Rebuild the exact approval evidence embedded in every event in an approval
 * group. Projection and later readiness reconciliation deliberately share
 * this function so actor, surface, observation, context, and artifact mapping
 * cannot evolve independently.
 */
export function buildFederatedApprovalSnapshot(
  state: DecisionNodeState,
  metadata: ApprovalFederationMetadataV1,
  manifest: LocalIdentityManifestV1,
  lineage: RecordProjectorLineageReader,
  artifactProvider: ProductArtifactEvidenceProvider,
): FederatedApprovalSnapshotV1 {
  return approvalSnapshot(
    state,
    metadata,
    parseResolvedMetadata(state.resolved_metadata),
    manifest,
    lineage,
    artifactProvider,
    canonicalSha256(state.brief),
  );
}

function sourceSnapshot(
  source: SourceAttributionV1,
  artifactProvider: ProductArtifactEvidenceProvider,
  identityManifestSha256: Sha256Digest,
): FederatedSourceSnapshotV1 {
  const provider = record(
    source.connection.provider_identity,
    'source provider identity',
  );
  return {
    identity_manifest_id: source.identity_manifest_id,
    identity_manifest_sha256: identityManifestSha256,
    binding: {
      adapter_binding_id: source.source.adapter_binding_id,
      adapter: clone(
        source.source.adapter,
      ) as FederatedSourceSnapshotV1['binding']['adapter'],
      configuration_snapshot: clone(source.source.configuration_snapshot),
      configuration_sha256: source.source.configuration_sha256,
    },
    connection: {
      connection_id: source.connection.connection_id,
      generation: source.connection.generation,
      owner: clone(source.connection.owner),
      provider_identity: {
        provider: source.connection.provider,
        tenant: clone(provider['tenant'] as ProviderIdentityV1['tenant']),
        subject: clone(provider['subject'] as ProviderIdentityV1['subject']),
        verification_method: provider[
          'verification_method'
        ] as FederatedSourceSnapshotV1['connection']['provider_identity']['verification_method'],
        assurance: provider[
          'assurance'
        ] as FederatedSourceSnapshotV1['connection']['provider_identity']['assurance'],
      },
    },
    meeting: {
      external_id: source.meeting.external_id,
      revision: source.meeting.canonical_revision,
      source_observation_id: source.source_observation_id,
      document_sha256: source.meeting.document_sha256,
    },
    participant_observations: participantObservations(
      source.participant_observations,
    ),
    attribution_sha256: canonicalSha256(source),
    observed_by: artifact(
      source.captured_by,
      artifactProvider,
      'source attribution artifact',
    ),
  };
}

function processorSnapshot(
  processor: ProcessorAttributionV1,
  artifactProvider: ProductArtifactEvidenceProvider,
  identityManifestSha256: Sha256Digest,
  generatedAt: string,
): FederatedProcessorSnapshotV1 {
  return {
    identity_manifest_id: processor.identity_manifest_id,
    identity_manifest_sha256: identityManifestSha256,
    adapter_binding_id: processor.processor.adapter_binding_id,
    adapter: clone(
      processor.processor.adapter,
    ) as FederatedProcessorSnapshotV1['adapter'],
    configuration_snapshot: clone(processor.processor.configuration_snapshot),
    configuration_sha256: processor.processor.configuration_sha256,
    attribution_sha256: canonicalSha256(processor),
    decision_set_sha256: processor.processor.decision_set_sha256,
    generated_at: generatedAt,
    produced_by: artifact(
      processor.produced_by,
      artifactProvider,
      'processor attribution artifact',
    ),
  };
}

function assertAttributionLineage(
  metadata: ApprovalFederationMetadataV1,
  approvalManifest: LocalIdentityManifestV1,
  source: Awaited<
    ReturnType<ApprovalAttributionProvider['getAttributionsForMetadata']>
  >['source'],
  processor: Awaited<
    ReturnType<ApprovalAttributionProvider['getAttributionsForMetadata']>
  >['processor'],
  requestedAt: string,
  lineage: RecordProjectorLineageReader,
): {
  sourceManifestSha256: Sha256Digest;
  processorManifestSha256: Sha256Digest;
} {
  lineage.assertManifestAncestorOrEqual(
    source.identity_manifest_id,
    processor.identity_manifest_id,
  );
  lineage.assertManifestAncestorOrEqual(
    processor.identity_manifest_id,
    approvalManifest.manifest_id,
  );
  const verifiedSourceManifest = lineage.loadVerifiedManifest(
    source.identity_manifest_id,
  );
  const sourceManifest = verifiedSourceManifest.manifest;
  const verifiedProcessorManifest = lineage.loadVerifiedManifest(
    processor.identity_manifest_id,
  );
  const processorManifest = verifiedProcessorManifest.manifest;
  const organizationId = approvalManifest.organization.organization_id;
  const sourceRef = metadata.source_attribution_ref;
  if (
    source.organization_id !== organizationId ||
    sourceManifest.organization.organization_id !== organizationId ||
    processorManifest.organization.organization_id !== organizationId ||
    source.source.adapter.adapter_id !== sourceRef.source_adapter_id ||
    source.source.adapter.instance_id !== sourceRef.source_instance_id ||
    source.meeting.external_id !== sourceRef.external_id ||
    source.meeting.canonical_revision !== sourceRef.meeting_revision ||
    canonicalSha256(source) !== sourceRef.attribution_sha256 ||
    processor.meeting.source_adapter_id !== sourceRef.source_adapter_id ||
    processor.meeting.source_instance_id !== sourceRef.source_instance_id ||
    processor.meeting.external_id !== sourceRef.external_id ||
    processor.meeting.meeting_revision !== sourceRef.meeting_revision ||
    processor.processor.adapter_binding_id !==
      metadata.processor.adapter_binding_id ||
    canonicalJson(processor.processor.adapter) !==
      canonicalJson(metadata.processor.adapter) ||
    canonicalJson(processor.processor.configuration_snapshot) !==
      canonicalJson(metadata.processor.configuration_snapshot) ||
    processor.processor.configuration_sha256 !==
      metadata.processor.configuration_sha256 ||
    canonicalSha256(processor) !== metadata.processor.attribution_sha256 ||
    processor.captured_at < source.captured_at ||
    source.captured_at > requestedAt ||
    processor.captured_at > requestedAt
  ) {
    fail(
      'source, processor, and approval do not form one exact ordered organization identity lineage',
    );
  }
  return {
    sourceManifestSha256: verifiedSourceManifest.sha256,
    processorManifestSha256: verifiedProcessorManifest.sha256,
  };
}

export interface FederatedProjectionSnapshots {
  source: FederatedSourceSnapshotV1;
  processor: FederatedProcessorSnapshotV1;
  approval: FederatedApprovalSnapshotV1;
}

/** Rebuild every sidecar/resolution-derived snapshot stored in an event. */
export function buildFederatedProjectionSnapshots(options: {
  state: DecisionNodeState;
  metadata: ApprovalFederationMetadataV1;
  manifest: LocalIdentityManifestV1;
  sourceAttribution: SourceAttributionV1;
  processorAttribution: ProcessorAttributionV1;
  lineage: RecordProjectorLineageReader;
  artifactProvider: ProductArtifactEvidenceProvider;
}): FederatedProjectionSnapshots {
  const attributionLineage = assertAttributionLineage(
    options.metadata,
    options.manifest,
    options.sourceAttribution,
    options.processorAttribution,
    options.state.requested_at,
    options.lineage,
  );
  return {
    source: sourceSnapshot(
      options.sourceAttribution,
      options.artifactProvider,
      attributionLineage.sourceManifestSha256,
    ),
    processor: processorSnapshot(
      options.processorAttribution,
      options.artifactProvider,
      attributionLineage.processorManifestSha256,
      options.state.brief.provenance.generated_at,
    ),
    approval: buildFederatedApprovalSnapshot(
      options.state,
      options.metadata,
      options.manifest,
      options.lineage,
      options.artifactProvider,
    ),
  };
}
