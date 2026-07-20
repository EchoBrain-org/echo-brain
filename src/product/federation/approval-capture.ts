import type {
  ApprovalRequest,
  JsonObject,
  JsonValue,
} from '../../core/index.js';
import {
  DEFAULT_APPROVE_REACTION,
  DEFAULT_REJECT_REACTION,
  SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
  renderSlackApprovalBlocks,
} from '../../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { ProductRuntimeConfig } from '../config.js';
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
import {
  IdentityLineageStore,
  type HistoricalBindingReference,
  type HistoricalBindingSnapshotLocator,
  type HistoricalPublicationPolicyReference,
  type ResolvedHistoricalBinding,
  type VerifiedHistoricalIdentityManifest,
  type VerifiedHistoricalPublicationPolicy,
} from './identity-lineage-store.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import type {
  AdapterBindingV1,
  ApprovalFederationMetadataV1,
  ApprovalSurfaceCandidateV1,
  FederatedPublicationSnapshotV1,
  IdentityClaimV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  ProviderIdentityV1,
  SlackProviderIdentitySnapshotV1,
  SourceAttributionV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from './contracts.js';
import { assertUtcMillisecondTimestamp } from './identifiers.js';
import { validateFederationDocument } from './schema-validation.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
const SLACK_TEAM_RE = /^T[A-Z0-9]{2,}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,}$/;
const SLACK_MESSAGE_TS_RE = /^\d+\.\d{6}$/;
const SLACK_REACTION_RE = /^[a-z0-9_+-]+$/;

export interface ApprovalAttributionProvider {
  getAttributions(request: ApprovalRequest): Promise<{
    source: SourceAttributionV1;
    processor: ProcessorAttributionV1;
  }>;
  getAttributionsForMetadata(metadata: ApprovalFederationMetadataV1): Promise<{
    source: SourceAttributionV1;
    processor: ProcessorAttributionV1;
  }>;
}

export interface SlackApprovalPresentationEvidence {
  rendered_blocks_sha256: `sha256:${string}`;
  rendered_blocks: JsonValue;
  provider_identity: SlackProviderIdentitySnapshotV1;
}

export interface SlackApprovalResolutionEvidence {
  provider_identity: SlackProviderIdentitySnapshotV1;
  actor: {
    team_id: string;
    user_id: string;
    display_name: string;
    reaction_name: string;
    channel_id: string;
    message_ts: string;
    provider_occurred_at: null;
    reason_reply: {
      message_ts: string;
      author_user_id: string;
      text: string;
    } | null;
  };
}

export interface ProductArtifactEvidenceProvider {
  current(): ProductArtifactIdentityV1;
  verify(value: ProductArtifactIdentityV1): void;
}

export interface ApprovalIdentityLineageReader {
  assertManifestAncestorOrEqual(
    ancestorManifestId: string,
    descendantManifestId: string,
  ): void;
  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest;
  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy;
  resolveBindingAt(
    reference: HistoricalBindingReference,
    observedAt: string,
  ): ResolvedHistoricalBinding;
  resolveBindingSnapshotAt(
    locator: HistoricalBindingSnapshotLocator,
    observedAt: string,
  ): ResolvedHistoricalBinding;
}

interface IdentityBundleReader {
  hasActiveBundle(): boolean;
  hasIdentityMaterial(): boolean;
  loadVerified(
    runtimeConfig?: ProductRuntimeConfig,
  ): VerifiedActiveIdentityBundle | null;
}

export interface FederatedApprovalCaptureOptions {
  stateDirectory: string;
  runtimeConfig: ProductRuntimeConfig;
  attributionProvider?: ApprovalAttributionProvider;
  artifactProvider?: ProductArtifactEvidenceProvider;
  /** Unit-test seam. Production reads immutable signed local history. */
  identityLineageReader?: ApprovalIdentityLineageReader;
  /** Unit-test seam. Production composition must use the verified disk store. */
  identityBundleReader?: IdentityBundleReader;
}

interface BoundConnection {
  binding: AdapterBindingV1;
  connection: ToolConnectionV1;
  generation: ToolConnectionGenerationV1;
}

interface ValidatedStoredApproval {
  metadata: ApprovalFederationMetadataV1;
  manifest: LocalIdentityManifestV1;
  source: SourceAttributionV1;
  processor: ProcessorAttributionV1;
  approvalBinding: ResolvedHistoricalBinding;
}

interface PublishedFederationReference {
  candidate_context_sha256: `sha256:${string}`;
  rendered_blocks_sha256: `sha256:${string}`;
  rendered_blocks: JsonValue;
  published_via: {
    adapter_binding_id: string;
    connection_id: string;
    connection_generation: number;
    configuration_sha256: `sha256:${string}`;
    provider_identity_sha256: `sha256:${string}`;
  };
}

interface ParsedPublishedReference {
  slack: { channel_id: string; message_ts: string };
  federation: PublishedFederationReference;
}

function fail(message: string): never {
  throw new Error(`federated approval capture failed: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has unknown or missing keys`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail(`${label} must be a sha256 digest`);
  }
  return value as `sha256:${string}`;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function exactEqual(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right))
    fail(`${label} does not match`);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function asJsonObject(value: unknown): JsonObject {
  return jsonClone(value) as JsonObject;
}

function canonicalValue(value: unknown, label: string): JsonValue {
  try {
    canonicalJson(value);
    return jsonClone(value) as JsonValue;
  } catch {
    fail(`${label} must be an RFC 8785 canonicalizable JSON value`);
  }
}

function providerSnapshot(
  identity: ProviderIdentityV1,
  label: string,
): SlackProviderIdentitySnapshotV1 {
  if (
    identity.tenant?.kind !== 'slack-team' ||
    identity.subject?.kind !== 'bot-installation' ||
    identity.verification.method !== 'slack_auth_test' ||
    identity.verification.assurance !== 'provider_verified'
  ) {
    fail(`${label} is not a verified Slack bot identity`);
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

function assertSlackSnapshot(
  value: unknown,
  label: string,
): SlackProviderIdentitySnapshotV1 {
  const record = exactKeys(
    value,
    ['provider', 'team_id', 'enterprise_id', 'bot_user_id', 'bot_id', 'app_id'],
    label,
  );
  if (
    record['provider'] !== 'slack' ||
    !SLACK_TEAM_RE.test(nonEmpty(record['team_id'], `${label}.team_id`)) ||
    !SLACK_USER_RE.test(
      nonEmpty(record['bot_user_id'], `${label}.bot_user_id`),
    ) ||
    (record['enterprise_id'] !== null &&
      typeof record['enterprise_id'] !== 'string') ||
    (record['bot_id'] !== null && typeof record['bot_id'] !== 'string') ||
    (record['app_id'] !== null && typeof record['app_id'] !== 'string')
  ) {
    fail(`${label} contains invalid Slack identity fields`);
  }
  return record as unknown as SlackProviderIdentitySnapshotV1;
}

function publicationSnapshot(
  bundle: VerifiedActiveIdentityBundle,
): FederatedPublicationSnapshotV1 {
  return publicationSnapshotFrom(
    bundle.publicationPolicy,
    bundle.pointer.default_publication_policy.sha256,
  );
}

function publicationSnapshotFrom(
  policy: VerifiedActiveIdentityBundle['publicationPolicy'],
  policySha256: `sha256:${string}`,
): FederatedPublicationSnapshotV1 {
  return {
    policy_id: policy.policy_id,
    version: policy.version,
    policy_sha256: policySha256,
    identity_manifest_id: policy.identity_manifest_id,
    signer_installation_id: policy.issued_by.installation_id,
    signer_key_id: policy.issued_by.key_id,
    ...jsonClone(policy.publication),
  };
}

function activeBinding(
  registry: LocalConnectionRegistryV1,
  capability: AdapterBindingV1['capability'],
  adapterId: string,
  instanceId: string,
): AdapterBindingV1 {
  const matches = registry.bindings.filter(
    (binding) =>
      binding.status === 'active' &&
      binding.capability === capability &&
      binding.adapter_id === adapterId &&
      binding.instance_id === instanceId,
  );
  if (matches.length !== 1) {
    fail(
      `expected one active ${capability} binding for ${adapterId}/${instanceId}`,
    );
  }
  return matches[0]!;
}

function boundConnection(
  registry: LocalConnectionRegistryV1,
  binding: AdapterBindingV1,
): BoundConnection {
  if (
    binding.connection_id === null ||
    binding.connection_generation === null
  ) {
    fail(`binding ${binding.adapter_binding_id} has no provider connection`);
  }
  const connection = registry.connections.find(
    (item) => item.connection_id === binding.connection_id,
  );
  const generation = connection?.generations.find(
    (item) => item.generation === binding.connection_generation,
  );
  if (connection === undefined || generation === undefined) {
    fail(
      `binding ${binding.adapter_binding_id} has a dangling provider generation`,
    );
  }
  return { binding, connection, generation };
}

function approvalConnection(
  bundle: VerifiedActiveIdentityBundle,
  runtime: ProductRuntimeConfig,
): BoundConnection {
  if (
    runtime.approval_mode !== 'adapter' ||
    runtime.approval_surface.adapter_id !== 'slack-reactions'
  ) {
    fail(
      'seed-grade approval capture requires slack-reactions as its intended surface',
    );
  }
  const binding = activeBinding(
    bundle.connectionRegistry,
    'approval-surface',
    runtime.approval_surface.adapter_id,
    runtime.approval_surface.instance_id,
  );
  const result = boundConnection(bundle.connectionRegistry, binding);
  if (result.connection.provider !== 'slack') {
    fail('approval binding does not use a Slack connection');
  }
  return result;
}

function configuredSlackReviewerUserId(binding: AdapterBindingV1): string {
  const reviewer = binding.configuration_snapshot['reviewer'];
  if (!isPlainObject(reviewer)) {
    fail('approval binding has no frozen Slack reviewer');
  }
  const userId = nonEmpty(
    reviewer['slack_user_id'],
    'approval binding Slack reviewer',
  );
  if (!SLACK_USER_RE.test(userId)) {
    fail('approval binding Slack reviewer is malformed');
  }
  return userId;
}

function configuredSlackReaction(
  binding: { configuration_snapshot: JsonObject },
  status: 'approved' | 'rejected',
): string {
  const key = status === 'approved' ? 'approve_reaction' : 'reject_reaction';
  const fallback =
    status === 'approved' ? DEFAULT_APPROVE_REACTION : DEFAULT_REJECT_REACTION;
  const configured = binding.configuration_snapshot[key];
  const reaction = configured === undefined ? fallback : configured;
  if (typeof reaction !== 'string' || !SLACK_REACTION_RE.test(reaction)) {
    fail(`approval binding ${key} is malformed`);
  }
  return reaction;
}

function approvalCandidate(
  bundle: VerifiedActiveIdentityBundle,
  runtime: ProductRuntimeConfig,
): ApprovalSurfaceCandidateV1 {
  const { binding, connection, generation } = approvalConnection(
    bundle,
    runtime,
  );
  return {
    binding: {
      adapter_binding_id: binding.adapter_binding_id,
      adapter: {
        kind: 'approval-surface',
        adapter_id: binding.adapter_id,
        instance_id: binding.instance_id,
        version: SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
      },
      configuration_snapshot: jsonClone(binding.configuration_snapshot),
      configuration_sha256: binding.configuration_sha256,
    },
    connection: {
      connection_id: connection.connection_id,
      generation: generation.generation,
      owner: jsonClone(connection.owner),
      provider_identity: providerSnapshot(
        generation.provider_identity,
        'approval connection provider identity',
      ),
    },
  };
}

function candidateDigest(
  brief: ApprovalRequest['brief'] | DecisionRequestedEvent['brief'],
  metadata: Omit<ApprovalFederationMetadataV1, 'candidate_context_sha256'>,
): `sha256:${string}` {
  return canonicalSha256({
    domain: 'echo.approval-candidate-context.v1',
    brief,
    source_attribution_sha256:
      metadata.source_attribution_ref.attribution_sha256,
    processor: metadata.processor,
    publication: metadata.publication,
    intended_approval_surface: metadata.approval_surface,
  });
}

function approvedContextDigest(
  candidateContextSha256: `sha256:${string}`,
  presentation: unknown,
): `sha256:${string}` {
  return canonicalSha256({
    domain: 'echo.approved-context.v1',
    candidate_context_sha256: candidateContextSha256,
    presentation,
  });
}

function expectedSlackPresentation(
  events: DecisionNodeEvents,
  requested: ApprovalFederationMetadataV1,
): JsonValue[] {
  return renderSlackApprovalBlocks({
    brief: events.requested.brief,
    approvalId: events.approval_id,
    requestedMetadata: asJsonObject({ federation: requested }),
    approveReaction: configuredSlackReaction(
      requested.approval_surface.binding,
      'approved',
    ),
    rejectReaction: configuredSlackReaction(
      requested.approval_surface.binding,
      'rejected',
    ),
  });
}

function requestedFederation(
  event: DecisionRequestedEvent,
): ApprovalFederationMetadataV1 {
  const outer = exactKeys(event.metadata, ['federation'], 'requested metadata');
  const metadata = validateFederationDocument<ApprovalFederationMetadataV1>(
    'approval-federation-metadata',
    outer['federation'],
  );
  const { candidate_context_sha256: _stored, ...withoutDigest } = metadata;
  const expected = candidateDigest(event.brief, withoutDigest);
  if (metadata.candidate_context_sha256 !== expected) {
    fail('requested candidate context digest is invalid');
  }
  return metadata;
}

function parseLegacySlackReference(reference: unknown): {
  channel_id: string;
  message_ts: string;
} {
  const value = exactKeys(
    reference,
    ['channel_id', 'message_ts'],
    'Slack reference',
  );
  const channelId = nonEmpty(value['channel_id'], 'Slack reference channel_id');
  const messageTs = nonEmpty(value['message_ts'], 'Slack reference message_ts');
  if (
    !SLACK_CHANNEL_RE.test(channelId) ||
    !SLACK_MESSAGE_TS_RE.test(messageTs)
  ) {
    fail('Slack reference identifiers are malformed');
  }
  return { channel_id: channelId, message_ts: messageTs };
}

function parsePresentationEvidence(
  evidence: unknown,
): SlackApprovalPresentationEvidence {
  const value = exactKeys(
    evidence,
    ['rendered_blocks_sha256', 'rendered_blocks', 'provider_identity'],
    'Slack presentation evidence',
  );
  const renderedBlocks = canonicalValue(
    value['rendered_blocks'],
    'Slack rendered blocks',
  );
  if (!Array.isArray(renderedBlocks)) {
    fail('Slack rendered blocks must be an array');
  }
  const renderedBlocksSha256 = digest(
    value['rendered_blocks_sha256'],
    'Slack rendered blocks',
  );
  if (canonicalSha256(renderedBlocks) !== renderedBlocksSha256) {
    fail('Slack rendered-block digest does not match its exact presentation');
  }
  return {
    rendered_blocks_sha256: renderedBlocksSha256,
    rendered_blocks: renderedBlocks,
    provider_identity: assertSlackSnapshot(
      value['provider_identity'],
      'Slack presentation provider identity',
    ),
  };
}

function parsePublishedReference(reference: unknown): ParsedPublishedReference {
  const root = exactKeys(
    reference,
    ['slack', 'federation'],
    'published reference',
  );
  const slack = parseLegacySlackReference(root['slack']);
  const federation = exactKeys(
    root['federation'],
    [
      'candidate_context_sha256',
      'rendered_blocks_sha256',
      'rendered_blocks',
      'published_via',
    ],
    'published federation reference',
  );
  const publishedVia = exactKeys(
    federation['published_via'],
    [
      'adapter_binding_id',
      'connection_id',
      'connection_generation',
      'configuration_sha256',
      'provider_identity_sha256',
    ],
    'published_via',
  );
  const renderedBlocks = canonicalValue(
    federation['rendered_blocks'],
    'published rendered blocks',
  );
  if (!Array.isArray(renderedBlocks)) {
    fail('published rendered blocks must be an array');
  }
  const renderedBlocksSha256 = digest(
    federation['rendered_blocks_sha256'],
    'published rendered blocks',
  );
  if (canonicalSha256(renderedBlocks) !== renderedBlocksSha256) {
    fail('published rendered-block digest is invalid');
  }
  return {
    slack,
    federation: {
      candidate_context_sha256: digest(
        federation['candidate_context_sha256'],
        'published candidate context',
      ),
      rendered_blocks_sha256: renderedBlocksSha256,
      rendered_blocks: renderedBlocks,
      published_via: {
        adapter_binding_id: nonEmpty(
          publishedVia['adapter_binding_id'],
          'published binding id',
        ),
        connection_id: nonEmpty(
          publishedVia['connection_id'],
          'published connection id',
        ),
        connection_generation: positiveInteger(
          publishedVia['connection_generation'],
          'published connection generation',
        ),
        configuration_sha256: digest(
          publishedVia['configuration_sha256'],
          'published configuration digest',
        ),
        provider_identity_sha256: digest(
          publishedVia['provider_identity_sha256'],
          'published provider identity digest',
        ),
      },
    },
  };
}

function publishedSlackEvent(events: DecisionNodeEvents): {
  event: DecisionPublishedEvent;
  reference: ParsedPublishedReference;
} | null {
  const matches = events.published.filter((event) => event.surface === 'slack');
  if (matches.length === 0) return null;
  if (matches.length !== 1)
    fail('decision node has multiple Slack publications');
  return {
    event: matches[0]!,
    reference: parsePublishedReference(matches[0]!.reference),
  };
}

function assertArtifactShape(
  value: ProductArtifactIdentityV1,
): ProductArtifactIdentityV1 {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(',') !==
      ['artifact_sha256', 'product_version', 'source_sha'].sort().join(',') ||
    typeof value.product_version !== 'string' ||
    value.product_version.trim() === '' ||
    !SOURCE_SHA_RE.test(value.source_sha) ||
    !DIGEST_RE.test(value.artifact_sha256)
  ) {
    fail('product artifact observer has an invalid shape');
  }
  return jsonClone(value);
}

function copiedReasonDigest(copiedReason: string): `sha256:${string}` {
  // `DecisionResolvedEvent.reason` is the product's intentionally trimmed
  // copy. This digest binds that durable field; it does not claim to preserve
  // provider-exact whitespace from Slack's ephemeral API response.
  return canonicalSha256({
    domain: 'echo.slack-copied-reason.v1',
    text: copiedReason,
  });
}

function cliReasonDigest(reason: string | null): `sha256:${string}` {
  return canonicalSha256({ domain: 'echo.cli-approval-reason.v1', reason });
}

export class FederatedApprovalCapture implements DecisionNodeFederationCapture {
  private readonly identity: IdentityBundleReader;
  private readonly lineage: ApprovalIdentityLineageReader;

  constructor(private readonly options: FederatedApprovalCaptureOptions) {
    this.identity =
      options.identityBundleReader ??
      new ActiveIdentityBundleStore(options.stateDirectory);
    this.lineage =
      options.identityLineageReader ??
      new IdentityLineageStore(options.stateDirectory);
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
    const stored = await this.validatedStoredRequested(input.events.requested);
    this.assertCurrentManifest(bundle, stored);
    for (const event of input.events.published) {
      this.validateStoredPublished(stored, input.events, event);
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
    if (this.activeBundle() === null) {
      if (Object.hasOwn(input.events.requested.metadata, 'federation')) {
        fail('stored federated approval has no active identity lineage');
      }
      return;
    }
    const stored = await this.validatedStoredRequested(input.events.requested);
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

  private activeBundle(): VerifiedActiveIdentityBundle | null {
    const bundle = this.identity.loadVerified(this.options.runtimeConfig);
    if (bundle !== null) return bundle;
    if (
      this.identity.hasActiveBundle() ||
      this.identity.hasIdentityMaterial()
    ) {
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
    const observation = approvalConnection(bundle, this.options.runtimeConfig);
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
          observed_by: this.productArtifact(),
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
          observed_by: this.productArtifact(),
        },
      },
    });
  }

  private parseResolutionEvidence(
    evidence: unknown,
  ): SlackApprovalResolutionEvidence {
    const root = exactKeys(
      evidence,
      ['provider_identity', 'actor'],
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
    return result;
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
    const observation = exactKeys(
      observationValue,
      [
        'adapter_binding_id',
        'connection_id',
        'connection_generation',
        'configuration_sha256',
        'provider_identity_sha256',
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
    const observed = this.lineage.resolveBindingSnapshotAt(
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
    this.verifyProductArtifact(
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
    this.verifyProductArtifact(
      exactKeys(
        observation['observed_by'],
        ['product_version', 'source_sha', 'artifact_sha256'],
        'CLI observation artifact',
      ) as unknown as ProductArtifactIdentityV1,
    );
  }
}
