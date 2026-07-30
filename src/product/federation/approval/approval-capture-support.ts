import type {
  ApprovalRequest,
  JsonObject,
  JsonValue,
} from '../../../core/index.js';
import {
  DEFAULT_APPROVE_REACTION,
  DEFAULT_REJECT_REACTION,
  SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
  renderSlackApprovalBlocks,
} from '../../../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { ProductRuntimeConfig } from '../../config.js';
import type {
  DecisionNodeEvents,
  DecisionPublishedEvent,
  DecisionRequestedEvent,
} from '../../approval/decision-node.js';
import type { VerifiedActiveIdentityBundle } from '../identity/active-identity-bundle-store.js';
import { canonicalJson, canonicalSha256 } from '../foundation/canonical-json.js';
import type {
  AdapterBindingV1,
  ApprovalFederationMetadataV1,
  ApprovalSurfaceCandidateV1,
  FederatedPublicationSnapshotV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  ProviderIdentityV1,
  SlackProviderIdentitySnapshotV1,
  SourceAttributionV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from '../contracts.js';
import type {
  HistoricalBindingReference,
  HistoricalBindingSnapshotLocator,
  HistoricalPublicationPolicyReference,
  ResolvedHistoricalBinding,
  VerifiedHistoricalIdentityManifest,
  VerifiedHistoricalPublicationPolicy,
} from '../identity-lineage-store.js';
import { validateFederationDocument } from '../schema-validation.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
export const SLACK_TEAM_RE = /^T[A-Z0-9]{2,}$/;
export const SLACK_USER_RE = /^[UW][A-Z0-9]{2,}$/;
export const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,}$/;
export const SLACK_MESSAGE_TS_RE = /^\d+\.\d{6}$/;
export const SLACK_REACTION_RE = /^[a-z0-9_+-]+$/;

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
  authorization?: OrganizationAuthorizationEvidence;
}

export interface OrganizationAuthorizationEvidence {
  schema_version: 1;
  kind: 'echo-organization-authorization-evidence';
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  request_sha256: `sha256:${string}`;
  provider_event_sha256: `sha256:${string}`;
  allowed: true;
  reason_code: string;
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
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

export interface IdentityBundleReader {
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

export interface BoundConnection {
  binding: AdapterBindingV1;
  connection: ToolConnectionV1;
  generation: ToolConnectionGenerationV1;
}

export interface ValidatedStoredApproval {
  metadata: ApprovalFederationMetadataV1;
  manifest: LocalIdentityManifestV1;
  source: SourceAttributionV1;
  processor: ProcessorAttributionV1;
  approvalBinding: ResolvedHistoricalBinding;
}

export interface PublishedFederationReference {
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

export interface ParsedPublishedReference {
  slack: { channel_id: string; message_ts: string };
  federation: PublishedFederationReference;
}

export function fail(message: string): never {
  throw new Error(`federated approval capture failed: ${message}`);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(
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

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

export function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail(`${label} must be a sha256 digest`);
  }
  return value as `sha256:${string}`;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function exactEqual(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right))
    fail(`${label} does not match`);
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function asJsonObject(value: unknown): JsonObject {
  return jsonClone(value) as JsonObject;
}

export function canonicalValue(value: unknown, label: string): JsonValue {
  try {
    canonicalJson(value);
    return jsonClone(value) as JsonValue;
  } catch {
    fail(`${label} must be an RFC 8785 canonicalizable JSON value`);
  }
}

export function providerSnapshot(
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

export function assertSlackSnapshot(
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

export function publicationSnapshot(
  bundle: VerifiedActiveIdentityBundle,
): FederatedPublicationSnapshotV1 {
  return publicationSnapshotFrom(
    bundle.publicationPolicy,
    bundle.pointer.default_publication_policy.sha256,
  );
}

export function publicationSnapshotFrom(
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

export function activeBinding(
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

export function boundConnection(
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

export function approvalConnection(
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

export function configuredSlackReviewerUserId(binding: AdapterBindingV1): string {
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

export function configuredSlackReaction(
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

export function approvalCandidate(
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

export function candidateDigest(
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

export function approvedContextDigest(
  candidateContextSha256: `sha256:${string}`,
  presentation: unknown,
): `sha256:${string}` {
  return canonicalSha256({
    domain: 'echo.approved-context.v1',
    candidate_context_sha256: candidateContextSha256,
    presentation,
  });
}

export function expectedSlackPresentation(
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

export function requestedFederation(
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

export function parseLegacySlackReference(reference: unknown): {
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

export function parsePresentationEvidence(
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

export function parsePublishedReference(reference: unknown): ParsedPublishedReference {
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

export function publishedSlackEvent(events: DecisionNodeEvents): {
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

export function assertArtifactShape(
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

export function copiedReasonDigest(copiedReason: string): `sha256:${string}` {
  // `DecisionResolvedEvent.reason` is the product's intentionally trimmed
  // copy. This digest binds that durable field; it does not claim to preserve
  // provider-exact whitespace from Slack's ephemeral API response.
  return canonicalSha256({
    domain: 'echo.slack-copied-reason.v1',
    text: copiedReason,
  });
}

export function cliReasonDigest(reason: string | null): `sha256:${string}` {
  return canonicalSha256({ domain: 'echo.cli-approval-reason.v1', reason });
}
