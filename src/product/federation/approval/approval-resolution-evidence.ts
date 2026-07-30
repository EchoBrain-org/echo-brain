import type { JsonObject, JsonValue } from '../../../core/index.js';
import type { ProductRuntimeConfig } from '../../config.js';
import type {
  DecisionNodeEvents,
  DecisionPublishedEvent,
  DecisionResolvedEvent,
  DecisionRequestedEvent,
} from '../../approval/decision-node.js';
import { decisionApprovalId } from '../../approval/decision-node.js';
import type { VerifiedActiveIdentityBundle } from '../identity/active-identity-bundle-store.js';
import { canonicalJson, canonicalSha256 } from '../foundation/canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  IdentityClaimV1,
  LocalIdentityManifestV1,
  ProductArtifactIdentityV1,
} from '../contracts.js';
import { assertUtcMillisecondTimestamp } from '../foundation/identifiers.js';
import {
  SLACK_CHANNEL_RE,
  SLACK_MESSAGE_TS_RE,
  SLACK_REACTION_RE,
  SLACK_TEAM_RE,
  SLACK_USER_RE,
  approvalConnection,
  approvedContextDigest,
  asJsonObject,
  assertSlackSnapshot,
  cliReasonDigest,
  configuredSlackReaction,
  configuredSlackReviewerUserId,
  copiedReasonDigest,
  digest,
  exactEqual,
  exactKeys,
  fail,
  nonEmpty,
  positiveInteger,
  providerSnapshot,
  publishedSlackEvent,
  type ApprovalIdentityLineageReader,
  type OrganizationAuthorizationEvidence,
  type SlackApprovalResolutionEvidence,
  type ValidatedStoredApproval,
} from './approval-capture-support.js';

export interface ApprovalResolutionEvidenceDependencies {
  runtimeConfig: ProductRuntimeConfig;
  lineage: ApprovalIdentityLineageReader;
  validatedStoredRequested(
    event: DecisionRequestedEvent,
  ): Promise<ValidatedStoredApproval>;
  validateStoredPublished(
    context: ValidatedStoredApproval,
    events: DecisionNodeEvents,
    event: DecisionPublishedEvent,
  ): void;
  assertCurrentManifest(
    bundle: VerifiedActiveIdentityBundle,
    stored: ValidatedStoredApproval,
  ): void;
  productArtifact(): ProductArtifactIdentityV1;
  verifyProductArtifact(
    value: ProductArtifactIdentityV1,
  ): ProductArtifactIdentityV1;
}

export class ApprovalResolutionEvidence {
  constructor(
    private readonly dependencies: ApprovalResolutionEvidenceDependencies,
  ) {}

  async captureResolved(
    bundle: VerifiedActiveIdentityBundle,
    input: {
      events: DecisionNodeEvents;
      status: 'approved' | 'rejected';
      reviewedAt: string;
      reviewedBy: string;
      reason: string | null;
      surface: string;
      legacyMetadata: JsonObject;
      resolutionEvidence?: JsonObject;
    },
  ): Promise<JsonObject> {
    if (Object.keys(input.legacyMetadata).length !== 0) {
      fail('legacy resolution metadata is forbidden after identity activation');
    }
    if (input.reason !== null && input.reason.trim().length === 0) {
      fail('identity-enabled approval reason must be null or non-blank text');
    }
    assertUtcMillisecondTimestamp(input.reviewedAt, 'approval reviewed_at');
    if (input.reviewedAt < input.events.requested.requested_at) {
      fail('approval resolution predates its requested candidate');
    }
    const stored = await this.dependencies.validatedStoredRequested(
      input.events.requested,
    );
    this.dependencies.assertCurrentManifest(bundle, stored);
    for (const event of input.events.published) {
      this.dependencies.validateStoredPublished(stored, input.events, event);
    }
    if (input.surface === 'slack') {
      return this.captureSlackResolution(bundle, stored.metadata, input);
    }
    if (input.surface === 'cli') {
      if (input.resolutionEvidence !== undefined) {
        fail(
          'CLI identity is installation-bound and accepts no provider evidence',
        );
      }
      return this.captureCliResolution(bundle, stored.metadata, input);
    }
    fail(
      `identity-enabled resolution does not support surface ${input.surface}`,
    );
  }

  async validateResolved(input: {
    events: DecisionNodeEvents;
    event: DecisionResolvedEvent;
  }): Promise<void> {
    const stored = await this.dependencies.validatedStoredRequested(
      input.events.requested,
    );
    if (input.event.reviewed_at < input.events.requested.requested_at) {
      fail('stored approval resolution predates its requested candidate');
    }
    const root = exactKeys(
      input.event.metadata,
      ['federation'],
      'resolved metadata',
    );
    const federation = exactKeys(
      root['federation'],
      ['actor', 'approval_context', 'approval_surface_observation'],
      'resolved federation metadata',
    );
    const actor = exactKeys(
      federation['actor'],
      [
        'principal_id',
        'membership_id',
        'claim_id',
        'raw_assertion',
        'assurance',
      ],
      'resolved actor',
    );
    if (
      actor['principal_id'] !== stored.manifest.principal.principal_id ||
      actor['membership_id'] !== stored.manifest.membership.membership_id
    ) {
      fail('resolved actor belongs to another local identity');
    }
    const context = this.assertApprovalContext(
      federation['approval_context'],
      stored.metadata.candidate_context_sha256,
    );
    if (input.event.surface === 'slack') {
      this.validateStoredSlackResolution(
        stored,
        input.events,
        input.event,
        actor,
        context,
        federation['approval_surface_observation'],
      );
      return;
    }
    if (input.event.surface === 'cli') {
      this.validateStoredCliResolution(
        stored,
        input.event,
        actor,
        context,
        federation['approval_surface_observation'],
      );
      return;
    }
    fail('resolved slot has an unsupported identity-enabled surface');
  }

  private captureSlackResolution(
    bundle: VerifiedActiveIdentityBundle,
    requested: ApprovalFederationMetadataV1,
    input: {
      events: DecisionNodeEvents;
      status: 'approved' | 'rejected';
      reviewedAt: string;
      reviewedBy: string;
      reason: string | null;
      resolutionEvidence?: JsonObject;
    },
  ): JsonObject {
    const published = publishedSlackEvent(input.events);
    if (published === null)
      fail('Slack resolution has no immutable publication');
    if (published.event.posted_at > input.reviewedAt) {
      fail('Slack resolution predates its immutable publication');
    }
    const evidence = this.parseResolutionEvidence(input.resolutionEvidence);
    if (evidence.authorization === undefined) {
      fail('Slack resolution requires organization authorization evidence');
    }
    if (
      evidence.authorization.organization_id !==
        bundle.manifest.organization.organization_id ||
      evidence.authorization.principal_id !==
        bundle.manifest.principal.principal_id ||
      evidence.authorization.membership_id !==
        bundle.manifest.membership.membership_id ||
      evidence.authorization.installation_id !==
        bundle.manifest.installation.installation_id ||
      evidence.authorization.approval_id !==
        decisionApprovalId(input.events.requested.processing_key) ||
      evidence.authorization.evaluated_at > input.reviewedAt
    ) {
      fail(
        'organization authorization evidence belongs to another local identity or time',
      );
    }
    const observation = approvalConnection(bundle, this.dependencies.runtimeConfig);
    const enrolledProvider = providerSnapshot(
      observation.generation.provider_identity,
      'observing provider identity',
    );
    exactEqual(
      evidence.provider_identity,
      enrolledProvider,
      'live observing provider identity',
    );
    const publishing = requested.approval_surface.connection;
    if (publishing === null) {
      fail('Slack publication has no frozen provider connection');
    }
    const intendedBinding = requested.approval_surface.binding;
    if (
      publishing.connection_id !== observation.connection.connection_id ||
      observation.binding.capability !== 'approval-surface' ||
      observation.binding.adapter_id !== intendedBinding.adapter.adapter_id ||
      observation.binding.instance_id !== intendedBinding.adapter.instance_id ||
      observation.binding.configuration_sha256 !==
        intendedBinding.configuration_sha256 ||
      canonicalJson(observation.binding.configuration_snapshot) !==
        canonicalJson(intendedBinding.configuration_snapshot) ||
      canonicalJson(publishing.provider_identity) !==
        canonicalJson(enrolledProvider)
    ) {
      fail(
        'publishing and observation do not share one Slack approval configuration and identity',
      );
    }
    if (
      evidence.actor.team_id !== enrolledProvider.team_id ||
      evidence.actor.user_id !==
        configuredSlackReviewerUserId(observation.binding) ||
      evidence.actor.channel_id !== published.reference.slack.channel_id ||
      evidence.actor.message_ts !== published.reference.slack.message_ts ||
      evidence.actor.display_name !== input.reviewedBy
    ) {
      fail('Slack actor assertion does not match the resolution event');
    }
    const expectedReaction = configuredSlackReaction(
      observation.binding,
      input.status,
    );
    if (evidence.actor.reaction_name !== expectedReaction) {
      fail('Slack actor reaction does not match the recorded decision');
    }
    const reply = evidence.actor.reason_reply;
    if (
      (input.reason === null && reply !== null) ||
      (input.reason !== null &&
        (reply === null ||
          reply.text.trim() !== input.reason ||
          reply.author_user_id !== evidence.actor.user_id))
    ) {
      fail('Slack reason reply does not match the stored reason');
    }
    const claim = this.slackActorClaim(
      bundle.manifest,
      evidence.actor.team_id,
      evidence.actor.user_id,
    );
    const presentation = {
      channel_id: published.reference.slack.channel_id,
      message_ts: published.reference.slack.message_ts,
      rendered_blocks_sha256:
        published.reference.federation.rendered_blocks_sha256,
    };
    const actor = {
      principal_id: bundle.manifest.principal.principal_id,
      membership_id: bundle.manifest.membership.membership_id,
      claim_id: claim.claim_id,
      raw_assertion: {
        surface: 'slack',
        issuer: { provider: 'slack', tenant_id: evidence.actor.team_id },
        subject_id: evidence.actor.user_id,
        display_name: evidence.actor.display_name,
        channel_id: evidence.actor.channel_id,
        message_ts: evidence.actor.message_ts,
        action: {
          kind: 'reaction',
          name: evidence.actor.reaction_name,
          provider_occurred_at: null,
          observed_at: input.reviewedAt,
        },
        reason_reply:
          reply === null
            ? null
            : {
                message_ts: reply.message_ts,
                author_subject_id: reply.author_user_id,
                text_sha256: copiedReasonDigest(
                  input.reason ?? fail('Slack reply exists without a reason'),
                ),
              },
      },
      assurance: claim.verification.assurance,
    };
    const approvedDigest = approvedContextDigest(
      requested.candidate_context_sha256,
      presentation,
    );
    return asJsonObject({
      federation: {
        actor,
        approval_context: {
          candidate_context_sha256: requested.candidate_context_sha256,
          presentation,
          approved_context_sha256: approvedDigest,
        },
        approval_surface_observation: {
          adapter_binding_id: observation.binding.adapter_binding_id,
          connection_id: observation.connection.connection_id,
          connection_generation: observation.generation.generation,
          configuration_sha256: observation.binding.configuration_sha256,
          provider_identity_sha256: canonicalSha256(enrolledProvider),
          authorization: evidence.authorization,
          observed_by: this.dependencies.productArtifact(),
        },
      },
    });
  }

  private captureCliResolution(
    bundle: VerifiedActiveIdentityBundle,
    requested: ApprovalFederationMetadataV1,
    input: {
      events: DecisionNodeEvents;
      status: 'approved' | 'rejected';
      reviewedAt: string;
      reviewedBy: string;
      reason: string | null;
    },
  ): JsonObject {
    const presentation = null;
    const rawAssertion = {
      surface: 'cli',
      installation_id: bundle.manifest.installation.installation_id,
      reviewer_label: input.reviewedBy,
      command: input.status === 'approved' ? 'approve' : 'reject',
      observed_at: input.reviewedAt,
      reason_sha256: cliReasonDigest(input.reason),
    };
    const actor = {
      principal_id: bundle.manifest.principal.principal_id,
      membership_id: bundle.manifest.membership.membership_id,
      claim_id: null,
      raw_assertion: rawAssertion,
      assurance: 'installation_holder_self_attested',
    };
    return asJsonObject({
      federation: {
        actor,
        approval_context: {
          candidate_context_sha256: requested.candidate_context_sha256,
          presentation,
          approved_context_sha256: approvedContextDigest(
            requested.candidate_context_sha256,
            presentation,
          ),
        },
        approval_surface_observation: {
          installation_id: bundle.manifest.installation.installation_id,
          key_id: bundle.manifest.installation.signing_key.key_id,
          observed_by: this.dependencies.productArtifact(),
        },
      },
    });
  }

  private parseResolutionEvidence(
    evidence: unknown,
  ): SlackApprovalResolutionEvidence {
    const evidenceRecord =
      typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
        ? evidence
        : {};
    const hasAuthorization = Object.hasOwn(evidenceRecord, 'authorization');
    const root = exactKeys(
      evidence,
      [
        'provider_identity',
        'actor',
        ...(hasAuthorization ? ['authorization'] : []),
      ],
      'Slack resolution evidence',
    );
    const actor = exactKeys(
      root['actor'],
      [
        'team_id',
        'user_id',
        'display_name',
        'reaction_name',
        'channel_id',
        'message_ts',
        'provider_occurred_at',
        'reason_reply',
      ],
      'Slack resolution actor',
    );
    const result: SlackApprovalResolutionEvidence = {
      provider_identity: assertSlackSnapshot(
        root['provider_identity'],
        'Slack resolution provider identity',
      ),
      actor: {
        team_id: nonEmpty(actor['team_id'], 'Slack actor team_id'),
        user_id: nonEmpty(actor['user_id'], 'Slack actor user_id'),
        display_name: nonEmpty(
          actor['display_name'],
          'Slack actor display_name',
        ),
        reaction_name: nonEmpty(actor['reaction_name'], 'Slack actor reaction'),
        channel_id: nonEmpty(actor['channel_id'], 'Slack actor channel_id'),
        message_ts: nonEmpty(actor['message_ts'], 'Slack actor message_ts'),
        provider_occurred_at: null,
        reason_reply: null,
      },
    };
    if (
      actor['provider_occurred_at'] !== null ||
      !SLACK_TEAM_RE.test(result.actor.team_id) ||
      !SLACK_USER_RE.test(result.actor.user_id) ||
      !SLACK_CHANNEL_RE.test(result.actor.channel_id) ||
      !SLACK_MESSAGE_TS_RE.test(result.actor.message_ts)
    ) {
      fail('Slack actor assertion contains invalid provider identifiers');
    }
    if (actor['reason_reply'] !== null) {
      const reply = exactKeys(
        actor['reason_reply'],
        ['message_ts', 'author_user_id', 'text'],
        'Slack reason reply',
      );
      result.actor.reason_reply = {
        message_ts: nonEmpty(reply['message_ts'], 'Slack reply message_ts'),
        author_user_id: nonEmpty(reply['author_user_id'], 'Slack reply author'),
        text: nonEmpty(reply['text'], 'Slack reply text'),
      };
      if (
        !SLACK_MESSAGE_TS_RE.test(result.actor.reason_reply.message_ts) ||
        !SLACK_USER_RE.test(result.actor.reason_reply.author_user_id)
      ) {
        fail('Slack reason reply contains invalid provider identifiers');
      }
    }
    if (hasAuthorization) {
      result.authorization = this.parseAuthorizationEvidence(
        root['authorization'],
      );
    }
    return result;
  }

  private parseAuthorizationEvidence(
    value: unknown,
  ): OrganizationAuthorizationEvidence {
    const evidence = exactKeys(
      value,
      [
        'schema_version',
        'kind',
        'authority_id',
        'organization_id',
        'enrollment_id',
        'installation_id',
        'request_id',
        'approval_id',
        'request_sha256',
        'provider_event_sha256',
        'allowed',
        'reason_code',
        'principal_id',
        'membership_id',
        'adapter_binding_id',
        'permission_grant_id',
        'evaluated_at',
      ],
      'organization authorization evidence',
    );
    if (
      evidence['schema_version'] !== 1 ||
      evidence['kind'] !== 'echo-organization-authorization-evidence' ||
      evidence['allowed'] !== true
    ) {
      fail('organization authorization evidence is not an allow decision');
    }
    const required = (key: string): string =>
      nonEmpty(evidence[key], `organization authorization ${key}`);
    const evaluatedAt = required('evaluated_at');
    assertUtcMillisecondTimestamp(
      evaluatedAt,
      'organization authorization evaluated_at',
    );
    return {
      schema_version: 1,
      kind: 'echo-organization-authorization-evidence',
      authority_id: required('authority_id'),
      organization_id: required('organization_id'),
      enrollment_id: required('enrollment_id'),
      installation_id: required('installation_id'),
      request_id: required('request_id'),
      approval_id: required('approval_id'),
      request_sha256: digest(
        evidence['request_sha256'],
        'organization authorization request',
      ),
      provider_event_sha256: digest(
        evidence['provider_event_sha256'],
        'organization authorization provider event',
      ),
      allowed: true,
      reason_code: required('reason_code'),
      principal_id: required('principal_id'),
      membership_id: required('membership_id'),
      adapter_binding_id: required('adapter_binding_id'),
      permission_grant_id: required('permission_grant_id'),
      evaluated_at: evaluatedAt,
    };
  }

  private slackActorClaim(
    manifest: LocalIdentityManifestV1,
    teamId: string,
    userId: string,
  ): IdentityClaimV1 {
    const matches = manifest.identity_claims.filter(
      (claim) =>
        claim.principal_id === manifest.principal.principal_id &&
        claim.issuer.kind === 'provider' &&
        claim.issuer.provider === 'slack' &&
        claim.issuer.tenant_id === teamId &&
        claim.subject.kind === 'user' &&
        claim.subject.id === userId &&
        claim.verification.method === 'slack_dm_challenge' &&
        claim.verification.assurance === 'provider_challenge_observed',
    );
    if (matches.length !== 1) {
      fail(
        'Slack actor does not resolve to exactly one workspace-scoped identity claim',
      );
    }
    return matches[0]!;
  }

  private assertApprovalContext(
    value: unknown,
    candidate: `sha256:${string}`,
  ): {
    candidate_context_sha256: `sha256:${string}`;
    presentation: JsonValue;
    approved_context_sha256: `sha256:${string}`;
  } {
    const context = exactKeys(
      value,
      ['candidate_context_sha256', 'presentation', 'approved_context_sha256'],
      'approval context',
    );
    if (
      digest(context['candidate_context_sha256'], 'approval candidate') !==
      candidate
    ) {
      fail('resolved candidate digest differs from requested metadata');
    }
    return {
      candidate_context_sha256: candidate,
      presentation: context['presentation'] as JsonValue,
      approved_context_sha256: digest(
        context['approved_context_sha256'],
        'approved context digest',
      ),
    };
  }

  private validateStoredSlackResolution(
    stored: ValidatedStoredApproval,
    events: DecisionNodeEvents,
    event: DecisionResolvedEvent,
    actor: Record<string, unknown>,
    context: {
      candidate_context_sha256: `sha256:${string}`;
      presentation: JsonValue;
      approved_context_sha256: `sha256:${string}`;
    },
    observationValue: unknown,
  ): void {
    if (actor['assurance'] !== 'provider_challenge_observed') {
      fail('Slack actor assurance is invalid');
    }
    const raw = exactKeys(
      actor['raw_assertion'],
      [
        'surface',
        'issuer',
        'subject_id',
        'display_name',
        'channel_id',
        'message_ts',
        'action',
        'reason_reply',
      ],
      'stored Slack actor assertion',
    );
    const issuer = exactKeys(
      raw['issuer'],
      ['provider', 'tenant_id'],
      'Slack actor issuer',
    );
    const action = exactKeys(
      raw['action'],
      ['kind', 'name', 'provider_occurred_at', 'observed_at'],
      'Slack actor action',
    );
    const tenantId = nonEmpty(issuer['tenant_id'], 'Slack actor tenant');
    const subjectId = nonEmpty(raw['subject_id'], 'Slack actor subject');
    const channelId = nonEmpty(raw['channel_id'], 'Slack actor channel');
    const messageTs = nonEmpty(raw['message_ts'], 'Slack actor message_ts');
    const reactionName = nonEmpty(action['name'], 'Slack actor reaction');
    if (
      raw['surface'] !== 'slack' ||
      issuer['provider'] !== 'slack' ||
      !SLACK_TEAM_RE.test(tenantId) ||
      !SLACK_USER_RE.test(subjectId) ||
      !SLACK_CHANNEL_RE.test(channelId) ||
      !SLACK_MESSAGE_TS_RE.test(messageTs) ||
      !SLACK_REACTION_RE.test(reactionName) ||
      action['kind'] !== 'reaction' ||
      action['provider_occurred_at'] !== null ||
      action['observed_at'] !== event.reviewed_at ||
      raw['display_name'] !== event.reviewed_by
    ) {
      fail('stored Slack actor assertion diverges from the resolved event');
    }
    const published = publishedSlackEvent(events);
    if (published === null) fail('stored Slack resolution has no publication');
    if (published.event.posted_at > event.reviewed_at) {
      fail('stored Slack resolution predates its immutable publication');
    }
    if (
      channelId !== published.reference.slack.channel_id ||
      messageTs !== published.reference.slack.message_ts
    ) {
      fail('stored Slack actor refers to another published message');
    }
    const expectedPresentation = {
      channel_id: published.reference.slack.channel_id,
      message_ts: published.reference.slack.message_ts,
      rendered_blocks_sha256:
        published.reference.federation.rendered_blocks_sha256,
    };
    exactEqual(
      context.presentation,
      expectedPresentation,
      'approved Slack presentation',
    );
    if (
      context.approved_context_sha256 !==
      approvedContextDigest(
        context.candidate_context_sha256,
        expectedPresentation,
      )
    ) {
      fail('stored approved Slack context digest is invalid');
    }
    const reasonReply = raw['reason_reply'];
    if (event.reason === null) {
      if (reasonReply !== null)
        fail('stored Slack reply exists without a reason');
    } else {
      const reply = exactKeys(
        reasonReply,
        ['message_ts', 'author_subject_id', 'text_sha256'],
        'stored Slack reason reply',
      );
      const replyMessageTs = nonEmpty(
        reply['message_ts'],
        'stored Slack reply message_ts',
      );
      if (
        !SLACK_MESSAGE_TS_RE.test(replyMessageTs) ||
        reply['author_subject_id'] !== subjectId ||
        reply['text_sha256'] !== copiedReasonDigest(event.reason)
      ) {
        fail('stored Slack reason digest or author is invalid');
      }
    }
    const observationRecord =
      typeof observationValue === 'object' &&
      observationValue !== null &&
      !Array.isArray(observationValue)
        ? observationValue
        : {};
    const hasAuthorization = Object.hasOwn(
      observationRecord,
      'authorization',
    );
    const observation = exactKeys(
      observationValue,
      [
        'adapter_binding_id',
        'connection_id',
        'connection_generation',
        'configuration_sha256',
        'provider_identity_sha256',
        ...(hasAuthorization ? ['authorization'] : []),
        'observed_by',
      ],
      'Slack approval observation',
    );
    const snapshot = {
      adapter_binding_id: nonEmpty(
        observation['adapter_binding_id'],
        'observation binding',
      ),
      connection_id: nonEmpty(
        observation['connection_id'],
        'observation connection',
      ),
      connection_generation: positiveInteger(
        observation['connection_generation'],
        'observation generation',
      ),
      configuration_sha256: digest(
        observation['configuration_sha256'],
        'observation configuration',
      ),
      provider_identity_sha256: digest(
        observation['provider_identity_sha256'],
        'observation provider identity',
      ),
    };
    if (hasAuthorization) {
      const authorization = this.parseAuthorizationEvidence(
        observation['authorization'],
      );
      if (
        authorization.organization_id !==
          stored.manifest.organization.organization_id ||
        authorization.principal_id !== actor['principal_id'] ||
        authorization.membership_id !== actor['membership_id'] ||
        authorization.installation_id !==
          stored.manifest.installation.installation_id ||
        authorization.approval_id !==
          decisionApprovalId(events.requested.processing_key) ||
        authorization.evaluated_at > event.reviewed_at
      ) {
        fail(
          'stored organization authorization evidence belongs to another local identity or time',
        );
      }
    }
    const observed = this.dependencies.lineage.resolveBindingSnapshotAt(
      {
        identity_manifest_id: stored.metadata.identity_manifest_id,
        adapter_binding_id: snapshot.adapter_binding_id,
        connection_id: snapshot.connection_id,
        connection_generation: snapshot.connection_generation,
        configuration_sha256: snapshot.configuration_sha256,
      },
      event.reviewed_at,
    );
    if (
      observed.binding.capability !== 'approval-surface' ||
      observed.binding.adapter_id !== 'slack-reactions' ||
      observed.connection === null ||
      observed.generation === null ||
      observed.connection.provider !== 'slack'
    ) {
      fail('stored Slack observation is not an approval-surface connection');
    }
    const observedProvider = providerSnapshot(
      observed.generation.provider_identity,
      'observed approval provider identity',
    );
    const intendedBinding = stored.metadata.approval_surface.binding;
    if (
      canonicalSha256(observedProvider) !== snapshot.provider_identity_sha256 ||
      observed.binding.adapter_id !== intendedBinding.adapter.adapter_id ||
      observed.binding.instance_id !== intendedBinding.adapter.instance_id ||
      observed.binding.configuration_sha256 !==
        intendedBinding.configuration_sha256 ||
      canonicalJson(observed.binding.configuration_snapshot) !==
        canonicalJson(intendedBinding.configuration_snapshot) ||
      tenantId !== observedProvider.team_id ||
      subjectId !== configuredSlackReviewerUserId(observed.binding) ||
      reactionName !== configuredSlackReaction(observed.binding, event.status)
    ) {
      fail('stored Slack actor is not the frozen reviewer action');
    }
    const claim = this.slackActorClaim(stored.manifest, tenantId, subjectId);
    if (
      actor['claim_id'] !== claim.claim_id ||
      actor['assurance'] !== claim.verification.assurance ||
      claim.verification.verified_at > event.reviewed_at
    ) {
      fail('stored Slack actor claim binding is invalid');
    }
    this.dependencies.verifyProductArtifact(
      exactKeys(
        observation['observed_by'],
        ['product_version', 'source_sha', 'artifact_sha256'],
        'observation artifact',
      ) as unknown as ProductArtifactIdentityV1,
    );
    if (
      snapshot.connection_id !==
        published.reference.federation.published_via.connection_id ||
      canonicalSha256(observedProvider) !==
        published.reference.federation.published_via.provider_identity_sha256
    ) {
      fail(
        'publishing and observation do not share one Slack approval configuration and identity',
      );
    }
  }

  private validateStoredCliResolution(
    stored: ValidatedStoredApproval,
    event: DecisionResolvedEvent,
    actor: Record<string, unknown>,
    context: {
      candidate_context_sha256: `sha256:${string}`;
      presentation: JsonValue;
      approved_context_sha256: `sha256:${string}`;
    },
    observationValue: unknown,
  ): void {
    if (
      actor['claim_id'] !== null ||
      actor['assurance'] !== 'installation_holder_self_attested'
    ) {
      fail('CLI actor assurance or claim is invalid');
    }
    const raw = exactKeys(
      actor['raw_assertion'],
      [
        'surface',
        'installation_id',
        'reviewer_label',
        'command',
        'observed_at',
        'reason_sha256',
      ],
      'stored CLI actor assertion',
    );
    if (
      raw['surface'] !== 'cli' ||
      raw['installation_id'] !== stored.manifest.installation.installation_id ||
      raw['reviewer_label'] !== event.reviewed_by ||
      raw['command'] !== (event.status === 'approved' ? 'approve' : 'reject') ||
      raw['observed_at'] !== event.reviewed_at ||
      raw['reason_sha256'] !== cliReasonDigest(event.reason)
    ) {
      fail('stored CLI actor assertion diverges from the resolved event');
    }
    if (context.presentation !== null) {
      fail('approved CLI presentation must be null');
    }
    if (
      context.approved_context_sha256 !==
      approvedContextDigest(context.candidate_context_sha256, null)
    ) {
      fail('stored approved CLI context digest is invalid');
    }
    const observation = exactKeys(
      observationValue,
      ['installation_id', 'key_id', 'observed_by'],
      'CLI installation observation',
    );
    if (
      observation['installation_id'] !==
        stored.manifest.installation.installation_id ||
      observation['key_id'] !== stored.manifest.installation.signing_key.key_id
    ) {
      fail('CLI observation belongs to another installation');
    }
    this.dependencies.verifyProductArtifact(
      exactKeys(
        observation['observed_by'],
        ['product_version', 'source_sha', 'artifact_sha256'],
        'CLI observation artifact',
      ) as unknown as ProductArtifactIdentityV1,
    );
  }
}
