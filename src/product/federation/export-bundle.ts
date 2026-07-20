import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  assertPrivateOwnedDirectory,
  ensureDirectory,
  fsyncDirectory,
  fsyncDirectoryTree,
  pathEntryExists,
  readFileNoFollow,
  secureTreeFiles,
  writeFileExclusive,
} from '../secure-local-files.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './canonical-json.js';
import type {
  FederatedEventV1,
  FederatedExportManifestV1,
  FederationId,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from './contracts.js';
import { identityManifestFilename } from './identity-manifest-store.js';
import type {
  HistoricalPublicationPolicyReference,
  VerifiedHistoricalIdentityManifest,
  VerifiedHistoricalPublicationPolicy,
} from './identity-lineage-store.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from './identifiers.js';
import type { InstallationSigner } from './installation-signer.js';
import { verifyInstallationKeyDescriptor } from './installation-signer.js';
import type {
  FederatedOutboxStore,
  StoredFederatedOutboxEvent,
  VerifiedFederatedChain,
} from './outbox-store.js';
import { publicationPolicyFilename } from './publication-policy-store.js';
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from './schema-validation.js';
import {
  createSignedDocument,
  signedPayload,
  verifySignedDocument,
} from './signed-document.js';
import { p256KeyId } from './signature-profile.js';

const EXPORT_MANIFEST_FILENAME = 'export-manifest.v1.json';
const RECORDS_FILENAME = 'records.v1.jsonl';
const IDENTITY_DIRECTORY = 'identity-manifests';
const POLICY_DIRECTORY = 'publication-policies';

interface ExportArtifact {
  path: string;
  kind: 'echo-local-identity-manifest' | 'echo-publication-policy';
  sha256: Sha256Digest;
  canonical: string;
}

interface IdentityMaterial {
  artifact: ExportArtifact;
  manifest: LocalIdentityManifestV1;
  publicKey: Buffer;
}

interface PolicyMaterial {
  artifact: ExportArtifact;
  policy: PublicationPolicyV1;
}

export interface FederatedExportIdentitySource {
  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest;
  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest;
  loadVerifiedManifestBySha256(
    sha256: Sha256Digest,
  ): VerifiedHistoricalIdentityManifest;
  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    observedAt: string,
  ): VerifiedHistoricalPublicationPolicy;
}

export interface FederatedExportOutboxSource {
  verifyInstallationChain: FederatedOutboxStore['verifyInstallationChain'];
}

export interface CreateFederatedExportBundleRequest {
  output_root: string;
  installation_id: FederationId;
  signing_identity_manifest_id: FederationId;
  first_sequence: number;
  last_sequence: number;
  export_id: FederationId;
  generated_at: string;
  signer: InstallationSigner;
  outbox: FederatedExportOutboxSource;
  identity_source: FederatedExportIdentitySource;
}

export interface CreatedFederatedExportBundle {
  created: boolean;
  path: string;
  manifest: FederatedExportManifestV1;
  manifest_json: string;
  records_bytes: Buffer;
  events: readonly FederatedEventV1[];
}

export interface VerifiedFederatedExportBundle {
  path: string;
  manifest: FederatedExportManifestV1;
  manifest_json: string;
  records_bytes: Buffer;
  events: readonly FederatedEventV1[];
  event_hashes: readonly Sha256Digest[];
  identity_manifests: ReadonlyMap<string, LocalIdentityManifestV1>;
  publication_policies: ReadonlyMap<string, PublicationPolicyV1>;
}

function fail(message: string): never {
  throw new Error(`federated export verification failed: ${message}`);
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function sortedNames(path: string): string[] {
  return readdirSync(path).sort(bytewiseCompare);
}

function assertExactNames(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalJson(actual) !== canonicalJson([...expected].sort(bytewiseCompare))
  ) {
    fail(`${label} contains missing or unexpected entries`);
  }
}

function assertPrivateFile(path: string, label: string): Buffer {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (state.mode & 0o777) !== 0o600 ||
    currentUid === undefined ||
    state.uid !== currentUid
  ) {
    fail(`${label} must be a current-user regular file with mode 0600`);
  }
  return readFileNoFollow(path, label);
}

function assertPrivateDirectory(path: string, label: string): void {
  try {
    assertPrivateOwnedDirectory(path, label);
  } catch (error) {
    fail((error as Error).message);
  }
}

function identityArtifactPath(manifestId: string): string {
  return `${IDENTITY_DIRECTORY}/${identityManifestFilename(manifestId)}`;
}

function policyArtifactPath(policyId: string, version: number): string {
  return `${POLICY_DIRECTORY}/${publicationPolicyFilename(policyId, version)}`;
}

function parseCanonicalDocument<T>(
  kind:
    | 'local-identity-manifest'
    | 'publication-policy'
    | 'federated-record-envelope'
    | 'federated-export',
  raw: string,
): T {
  const parsed = parseCanonicalJson(raw);
  return validateFederationDocument<T>(kind, parsed);
}

function publicKeyForManifest(manifest: LocalIdentityManifestV1): Buffer {
  const encoded = manifest.installation.signing_key.public_key_spki_der_base64;
  const publicKey = Buffer.from(encoded, 'base64');
  if (
    publicKey.length === 0 ||
    publicKey.toString('base64') !== encoded ||
    p256KeyId(publicKey) !== manifest.installation.signing_key.key_id
  ) {
    fail(`identity manifest ${manifest.manifest_id} has an invalid public key`);
  }
  const parsed = createPublicKey({
    key: publicKey,
    format: 'der',
    type: 'spki',
  });
  const canonical = parsed.export({ format: 'der', type: 'spki' });
  if (
    parsed.asymmetricKeyType !== 'ec' ||
    parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    !Buffer.isBuffer(canonical) ||
    !canonical.equals(publicKey)
  ) {
    fail(
      `identity manifest ${manifest.manifest_id} public key is not canonical P-256 SPKI DER`,
    );
  }
  return publicKey;
}

function assertManifestSemantics(manifest: LocalIdentityManifestV1): void {
  const organizationId = manifest.organization.organization_id;
  if (
    manifest.principal.organization_id !== organizationId ||
    manifest.membership.organization_id !== organizationId ||
    manifest.membership.principal_id !== manifest.principal.principal_id ||
    manifest.installation.organization_id !== organizationId ||
    manifest.installation.membership_id !== manifest.membership.membership_id
  ) {
    fail(
      `identity manifest ${manifest.manifest_id} has an inconsistent identity graph`,
    );
  }
  const claimIds = new Set<string>();
  for (const claim of manifest.identity_claims) {
    if (claimIds.has(claim.claim_id)) {
      fail(`identity manifest ${manifest.manifest_id} has duplicate claims`);
    }
    claimIds.add(claim.claim_id);
    if (claim.principal_id !== manifest.principal.principal_id) {
      fail(
        `identity manifest ${manifest.manifest_id} has a claim for another principal`,
      );
    }
    if (claim.verification.verified_at > manifest.created_at) {
      fail(
        `identity manifest ${manifest.manifest_id} contains a claim verified after the manifest was created`,
      );
    }
    if (
      claim.verification.method === 'slack_dm_challenge' &&
      (claim.issuer.kind !== 'provider' ||
        claim.issuer.provider !== 'slack' ||
        claim.subject.kind !== 'user' ||
        claim.verification.assurance !== 'provider_challenge_observed')
    ) {
      fail(
        `identity manifest ${manifest.manifest_id} contains an invalid Slack identity claim`,
      );
    }
    if (
      claim.verification.method === 'oidc_id_token' &&
      (claim.issuer.kind !== 'oidc' ||
        claim.subject.kind !== 'oidc_sub' ||
        claim.verification.assurance !== 'provider_verified')
    ) {
      fail(
        `identity manifest ${manifest.manifest_id} contains an invalid OIDC identity claim`,
      );
    }
  }
}

function assertManifestPredecessor(
  successor: LocalIdentityManifestV1,
  predecessor: LocalIdentityManifestV1,
): void {
  if (
    successor.predecessor_manifest_id !== predecessor.manifest_id ||
    predecessor.created_at >= successor.created_at ||
    predecessor.organization.organization_id !==
      successor.organization.organization_id ||
    predecessor.principal.principal_id !== successor.principal.principal_id ||
    predecessor.membership.membership_id !== successor.membership.membership_id
  ) {
    fail(
      `identity manifest ${successor.manifest_id} has inconsistent predecessor continuity`,
    );
  }
}

function assertArtifactOrdering(
  artifacts: readonly FederatedExportManifestV1['artifacts'][number][],
): void {
  const paths = new Set<string>();
  let previous: string | undefined;
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) {
      fail(`artifact path ${artifact.path} is duplicated`);
    }
    paths.add(artifact.path);
    if (
      previous !== undefined &&
      bytewiseCompare(previous, artifact.path) >= 0
    ) {
      fail('artifact inventory is not in deterministic bytewise path order');
    }
    previous = artifact.path;
  }
}

function assertBundleTopology(
  bundlePath: string,
  artifacts?: readonly FederatedExportManifestV1['artifacts'][number][],
): void {
  assertPrivateDirectory(bundlePath, 'federated export directory');
  assertExactNames(
    sortedNames(bundlePath),
    [
      EXPORT_MANIFEST_FILENAME,
      IDENTITY_DIRECTORY,
      POLICY_DIRECTORY,
      RECORDS_FILENAME,
    ],
    'federated export directory',
  );
  const identityDirectory = join(bundlePath, IDENTITY_DIRECTORY);
  const policyDirectory = join(bundlePath, POLICY_DIRECTORY);
  assertPrivateDirectory(
    identityDirectory,
    'export identity-manifest directory',
  );
  assertPrivateDirectory(
    policyDirectory,
    'export publication-policy directory',
  );
  if (artifacts === undefined) return;

  const identityNames = artifacts
    .filter((artifact) => artifact.kind === 'echo-local-identity-manifest')
    .map((artifact) => basename(artifact.path));
  const policyNames = artifacts
    .filter((artifact) => artifact.kind === 'echo-publication-policy')
    .map((artifact) => basename(artifact.path));
  assertExactNames(
    sortedNames(identityDirectory),
    identityNames,
    'export identity-manifest directory',
  );
  assertExactNames(
    sortedNames(policyDirectory),
    policyNames,
    'export publication-policy directory',
  );

  const expectedFiles = new Set([
    EXPORT_MANIFEST_FILENAME,
    RECORDS_FILENAME,
    ...artifacts.map((artifact) => artifact.path),
  ]);
  const tree = secureTreeFiles(bundlePath);
  if (
    tree.length !== expectedFiles.size ||
    tree.some(
      (file) => !expectedFiles.has(file.relativePath) || file.mode !== 0o600,
    )
  ) {
    fail('export file inventory or file permissions do not match the manifest');
  }
}

function parseArtifacts(
  bundlePath: string,
  manifest: FederatedExportManifestV1,
): {
  identities: Map<string, IdentityMaterial>;
  policies: Map<string, PolicyMaterial>;
} {
  assertArtifactOrdering(manifest.artifacts);
  assertBundleTopology(bundlePath, manifest.artifacts);
  const identities = new Map<string, IdentityMaterial>();
  const policies = new Map<string, PolicyMaterial>();

  for (const entry of manifest.artifacts) {
    const rawBytes = assertPrivateFile(
      join(bundlePath, entry.path),
      entry.path,
    );
    const raw = rawBytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(rawBytes)) {
      fail(`artifact ${entry.path} is not valid UTF-8`);
    }
    if (sha256Digest(rawBytes) !== entry.sha256) {
      fail(`artifact ${entry.path} digest does not match its exact bytes`);
    }
    if (entry.kind === 'echo-local-identity-manifest') {
      const identity = parseCanonicalDocument<LocalIdentityManifestV1>(
        'local-identity-manifest',
        raw,
      );
      if (entry.path !== identityArtifactPath(identity.manifest_id)) {
        fail(`identity manifest ${identity.manifest_id} has a mismatched path`);
      }
      if (identities.has(identity.manifest_id)) {
        fail(`identity manifest ${identity.manifest_id} is duplicated`);
      }
      assertManifestSemantics(identity);
      const publicKey = publicKeyForManifest(identity);
      verifySignedDocument(
        identity,
        publicKey,
        identity.installation.signing_key.key_id,
      );
      identities.set(identity.manifest_id, {
        artifact: {
          ...entry,
          kind: 'echo-local-identity-manifest',
          canonical: raw,
        },
        manifest: identity,
        publicKey,
      });
      continue;
    }

    const policy = parseCanonicalDocument<PublicationPolicyV1>(
      'publication-policy',
      raw,
    );
    const key = policyArtifactPath(policy.policy_id, policy.version);
    if (entry.path !== key) {
      fail(
        `publication policy ${policy.policy_id} v${policy.version} has a mismatched path`,
      );
    }
    if (policies.has(key)) {
      fail(
        `publication policy ${policy.policy_id} v${policy.version} is duplicated`,
      );
    }
    policies.set(key, {
      artifact: {
        ...entry,
        kind: 'echo-publication-policy',
        canonical: raw,
      },
      policy,
    });
  }
  return { identities, policies };
}

function identityForDigest(
  identities: ReadonlyMap<string, IdentityMaterial>,
  sha256: Sha256Digest,
  label: string,
): IdentityMaterial {
  const matches = [...identities.values()].filter(
    (material) => material.artifact.sha256 === sha256,
  );
  if (matches.length !== 1) {
    fail(
      matches.length === 0
        ? `${label} does not resolve to an exported identity manifest`
        : `${label} resolves to more than one exported identity manifest`,
    );
  }
  return matches[0]!;
}

function identityForReference(
  identities: ReadonlyMap<string, IdentityMaterial>,
  manifestId: FederationId,
  sha256: Sha256Digest,
  label: string,
): IdentityMaterial {
  const byId = identities.get(manifestId);
  const byDigest = identityForDigest(identities, sha256, `${label} digest`);
  if (byId === undefined || byId !== byDigest) {
    fail(`${label} ID and digest do not resolve to the same identity manifest`);
  }
  return byId;
}

function manifestIsAncestorOrEqual(
  identities: ReadonlyMap<string, IdentityMaterial>,
  ancestorId: string,
  descendantId: string,
): boolean {
  const seen = new Set<string>();
  let currentId: string | null = descendantId;
  while (currentId !== null) {
    if (currentId === ancestorId) return true;
    if (seen.has(currentId)) return false;
    seen.add(currentId);
    const current = identities.get(currentId);
    if (current === undefined) return false;
    currentId = current.manifest.predecessor_manifest_id;
  }
  return false;
}

function parseRecords(
  recordsBytes: Buffer,
  manifest: FederatedExportManifestV1,
): { events: FederatedEventV1[]; hashes: Sha256Digest[] } {
  if (sha256Digest(recordsBytes) !== manifest.records.sha256) {
    fail('records JSONL digest does not match its exact bytes');
  }
  if (recordsBytes.length === 0 || recordsBytes.at(-1) !== 0x0a) {
    fail('records JSONL must contain records terminated by one LF each');
  }
  const text = recordsBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(recordsBytes)) {
    fail('records JSONL is not valid UTF-8');
  }
  const lines = text.slice(0, -1).split('\n');
  if (
    lines.length !== manifest.records.count ||
    lines.some((line) => line === '')
  ) {
    fail('records JSONL count or line framing is invalid');
  }
  const events = lines.map((line) =>
    parseCanonicalDocument<FederatedEventV1>('federated-record-envelope', line),
  );
  return { events, hashes: lines.map((line) => sha256Digest(line)) };
}

function publicationSnapshot(
  event: FederatedEventV1,
): PublicationPolicyV1['publication'] {
  return {
    payload_scope: event.publication.payload_scope,
    audience: event.publication.audience,
    sensitivity: event.publication.sensitivity,
    retention: event.publication.retention,
    raw_meeting_content: event.publication.raw_meeting_content,
    participant_observations: event.publication.participant_observations,
  };
}

function assertPolicyAudience(
  policy: PublicationPolicyV1,
  identity: LocalIdentityManifestV1,
): void {
  const organizationId = identity.organization.organization_id;
  const membershipId = identity.membership.membership_id;
  const allowed = new Set([
    `organization:${organizationId}`,
    `membership:${membershipId}`,
  ]);
  if (
    policy.publication.audience.subjects.some(
      (subject) => !allowed.has(`${subject.kind}:${subject.id}`),
    )
  ) {
    fail(
      `publication policy ${policy.policy_id} contains an unknown local audience subject`,
    );
  }
  if (
    policy.publication.audience.scope === 'organization' &&
    (policy.publication.audience.subjects.length !== 1 ||
      policy.publication.audience.subjects[0]?.kind !== 'organization' ||
      policy.publication.audience.subjects[0].id !== organizationId)
  ) {
    fail(
      `publication policy ${policy.policy_id} has a non-canonical organization audience`,
    );
  }
}

function identityOwnsConnection(
  identity: LocalIdentityManifestV1,
  owner: FederatedEventV1['source']['connection']['owner'],
): boolean {
  return owner.kind === 'organization'
    ? owner.id === identity.organization.organization_id
    : owner.id === identity.membership.membership_id;
}

function copiedSlackReasonDigest(reason: string): Sha256Digest {
  return canonicalSha256({
    domain: 'echo.slack-copied-reason.v1',
    text: reason,
  });
}

function assertApprovalIdentity(
  event: FederatedEventV1,
  identity: LocalIdentityManifestV1,
): void {
  const approval = event.approval;
  if (
    approval.approver.principal_id !== identity.principal.principal_id ||
    approval.approver.membership_id !== identity.membership.membership_id
  ) {
    fail(`event ${event.event_id} approval actor belongs to another identity`);
  }

  if (approval.surface === null) {
    if (
      approval.approver.claim_id !== null ||
      approval.raw_actor_assertion.installation_id !==
        event.producer.installation_id
    ) {
      fail(`event ${event.event_id} has an invalid CLI approval actor`);
    }
    return;
  }

  const surface = approval.surface;
  const observation = approval.observation;
  if (
    canonicalJson(surface.binding.adapter) !==
      canonicalJson(observation.binding.adapter) ||
    surface.binding.configuration_sha256 !==
      observation.binding.configuration_sha256 ||
    canonicalJson(surface.binding.configuration_snapshot) !==
      canonicalJson(observation.binding.configuration_snapshot) ||
    surface.binding.configuration_sha256 !==
      canonicalSha256(surface.binding.configuration_snapshot) ||
    observation.binding.configuration_sha256 !==
      canonicalSha256(observation.binding.configuration_snapshot) ||
    surface.connection.connection_id !== observation.connection.connection_id ||
    canonicalJson(surface.connection.owner) !==
      canonicalJson(observation.connection.owner) ||
    canonicalJson(surface.connection.provider_identity) !==
      canonicalJson(observation.connection.provider_identity) ||
    !identityOwnsConnection(identity, surface.connection.owner)
  ) {
    fail(
      `event ${event.event_id} Slack publication and observation snapshots diverge`,
    );
  }

  const configuredChannel =
    surface.binding.configuration_snapshot['channel_id'];
  const configuredApprovalReaction =
    surface.binding.configuration_snapshot['approve_reaction'];
  const reasonReply = approval.raw_actor_assertion.reason_reply;
  const claim = identity.identity_claims.find(
    (candidate) => candidate.claim_id === approval.approver.claim_id,
  );
  if (
    claim === undefined ||
    claim.principal_id !== approval.approver.principal_id ||
    claim.issuer.kind !== 'provider' ||
    claim.issuer.provider !== 'slack' ||
    claim.issuer.tenant_id !== approval.raw_actor_assertion.tenant_id ||
    claim.subject.kind !== 'user' ||
    claim.subject.id !== approval.raw_actor_assertion.subject_id ||
    claim.verification.method !== 'slack_dm_challenge' ||
    claim.verification.assurance !== 'provider_challenge_observed' ||
    approval.assurance !== 'provider_challenge_observed' ||
    claim.verification.assurance !== approval.assurance ||
    claim.verification.verified_at > approval.reviewed_at ||
    surface.connection.provider_identity.team_id !==
      approval.raw_actor_assertion.tenant_id ||
    observation.connection.provider_identity.team_id !==
      approval.raw_actor_assertion.tenant_id ||
    surface.presentation.channel_id !==
      approval.raw_actor_assertion.channel_id ||
    surface.presentation.message_ts !==
      approval.raw_actor_assertion.message_ts ||
    configuredChannel !== surface.presentation.channel_id ||
    configuredApprovalReaction !== approval.raw_actor_assertion.action.name ||
    approval.raw_actor_assertion.action.provider_occurred_at !== null ||
    approval.raw_actor_assertion.action.observed_at !== approval.reviewed_at ||
    (approval.reason === null) !== (reasonReply === null) ||
    (reasonReply !== null &&
      (reasonReply.author_subject_id !==
        approval.raw_actor_assertion.subject_id ||
        approval.reason === null ||
        reasonReply.text_sha256 !== copiedSlackReasonDigest(approval.reason)))
  ) {
    fail(`event ${event.event_id} has an invalid Slack approval actor claim`);
  }
}

function kindOrder(kind: FederatedEventV1['record']['kind']): number {
  if (kind === 'decision') return 0;
  if (kind === 'action') return 1;
  return 2;
}

function assertSignalManifest(event: FederatedEventV1): void {
  const entries = event.record.approval_group.signal_manifest;
  const ids = new Set<string>();
  const nextPosition = new Map<string, number>();
  let previousOrder: readonly [number, number] | undefined;
  for (const entry of entries) {
    if (ids.has(entry.signal_id)) {
      fail(
        `approval ${event.local_reference.approval_id} has duplicate signal IDs`,
      );
    }
    ids.add(entry.signal_id);
    const expectedPosition = nextPosition.get(entry.kind) ?? 0;
    if (entry.position_within_kind !== expectedPosition) {
      fail(
        `approval ${event.local_reference.approval_id} has non-contiguous signal positions`,
      );
    }
    nextPosition.set(entry.kind, expectedPosition + 1);
    const order = [kindOrder(entry.kind), entry.position_within_kind] as const;
    if (
      previousOrder !== undefined &&
      (order[0] < previousOrder[0] ||
        (order[0] === previousOrder[0] && order[1] <= previousOrder[1]))
    ) {
      fail(
        `approval ${event.local_reference.approval_id} has a non-canonical signal manifest`,
      );
    }
    previousOrder = order;
  }
  const own = entries.filter(
    (entry) => entry.signal_id === event.record.signal_id,
  );
  if (
    own.length !== 1 ||
    own[0]!.kind !== event.record.kind ||
    own[0]!.sha256 !== sha256Digest(canonicalJson(event.record.signal))
  ) {
    fail(`event ${event.event_id} does not match its signal manifest digest`);
  }
}

function sharedApprovalFacts(event: FederatedEventV1): unknown {
  return {
    organization_id: event.organization_id,
    occurred_at: event.occurred_at,
    producer: event.producer,
    source: event.source,
    processor: event.processor,
    local_reference: {
      processing_key: event.local_reference.processing_key,
      approval_id: event.local_reference.approval_id,
      node_id: event.local_reference.node_id,
      meeting_id: event.local_reference.meeting_id,
    },
    meeting_context: event.record.meeting_context,
    approval_group: event.record.approval_group,
    approval: event.approval,
    publication: event.publication,
    classification: event.classification,
    identity_manifest_sha256: event.identity_manifest_sha256,
  };
}

function assertApprovalGroups(events: readonly FederatedEventV1[]): void {
  const groups = new Map<
    string,
    { event: FederatedEventV1; index: number }[]
  >();
  const eventIds = new Set<string>();
  const recordIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (eventIds.has(event.event_id) || recordIds.has(event.record.record_id)) {
      fail('event_id and record_id must be unique within an export');
    }
    eventIds.add(event.event_id);
    recordIds.add(event.record.record_id);
    if (
      event.record.signal_id !== event.local_reference.signal_id ||
      event.record.signal.id !== event.record.signal_id ||
      event.record.signal.kind !== event.record.kind ||
      event.record.meeting_context.id !== event.local_reference.meeting_id ||
      event.record.approval_group.approved_brief_sha256 !==
        event.approval.approved_brief_sha256
    ) {
      fail(
        `event ${event.event_id} has inconsistent signal or approval identity`,
      );
    }
    assertSignalManifest(event);
    const approvalId = event.local_reference.approval_id;
    const group = groups.get(approvalId) ?? [];
    group.push({ event, index });
    groups.set(approvalId, group);
  }

  for (const [approvalId, group] of groups) {
    const first = group[0]!;
    const shared = canonicalJson(sharedApprovalFacts(first.event));
    const presentIds = new Set<string>();
    let previousOrder: readonly [number, number] | undefined;
    for (let offset = 0; offset < group.length; offset += 1) {
      const item = group[offset]!;
      if (
        item.index !== first.index + offset ||
        canonicalJson(sharedApprovalFacts(item.event)) !== shared
      ) {
        fail(
          `approval ${approvalId} is non-contiguous or has divergent sibling facts`,
        );
      }
      if (presentIds.has(item.event.record.signal_id)) {
        fail(`approval ${approvalId} repeats an exported signal`);
      }
      presentIds.add(item.event.record.signal_id);
      const manifestEntry =
        item.event.record.approval_group.signal_manifest.find(
          (entry) => entry.signal_id === item.event.record.signal_id,
        )!;
      const order = [
        kindOrder(manifestEntry.kind),
        manifestEntry.position_within_kind,
      ] as const;
      if (
        previousOrder !== undefined &&
        (order[0] < previousOrder[0] ||
          (order[0] === previousOrder[0] && order[1] <= previousOrder[1]))
      ) {
        fail(
          `approval ${approvalId} records are not in canonical signal order`,
        );
      }
      previousOrder = order;
    }
    const manifestIds = new Set(
      first.event.record.approval_group.signal_manifest.map(
        (entry) => entry.signal_id,
      ),
    );
    const complete =
      manifestIds.size === presentIds.size &&
      [...manifestIds].every((signalId) => presentIds.has(signalId));
    if (!complete) {
      fail(`approval ${approvalId} is incomplete in the export range`);
    }
  }
}

function verifyManifestClosure(
  exportManifest: FederatedExportManifestV1,
  events: readonly FederatedEventV1[],
  identities: ReadonlyMap<string, IdentityMaterial>,
  policies: ReadonlyMap<string, PolicyMaterial>,
): void {
  const requiredPolicies = new Set<string>();
  const directManifestIds = new Set<string>([
    exportManifest.signing_identity_manifest_id,
  ]);
  for (const event of events) {
    const policyPath = policyArtifactPath(
      event.publication.policy_id,
      event.publication.version,
    );
    requiredPolicies.add(policyPath);
    directManifestIds.add(
      identityForDigest(
        identities,
        event.identity_manifest_sha256,
        `event ${event.event_id} identity_manifest_sha256`,
      ).manifest.manifest_id,
    );
    directManifestIds.add(
      identityForReference(
        identities,
        event.source.identity_manifest_id,
        event.source.identity_manifest_sha256,
        `event ${event.event_id} source identity manifest`,
      ).manifest.manifest_id,
    );
    directManifestIds.add(
      identityForReference(
        identities,
        event.processor.identity_manifest_id,
        event.processor.identity_manifest_sha256,
        `event ${event.event_id} processor identity manifest`,
      ).manifest.manifest_id,
    );
    const policy = policies.get(policyPath)?.policy;
    if (policy !== undefined)
      directManifestIds.add(policy.identity_manifest_id);
  }
  if (
    requiredPolicies.size !== policies.size ||
    [...requiredPolicies].some((path) => !policies.has(path))
  ) {
    fail('publication-policy artifacts are missing or unreferenced');
  }

  const requiredManifests = new Set<string>();
  const roots = new Set<string>();
  for (const startId of directManifestIds) {
    const traversal = new Set<string>();
    let currentId: string | null = startId;
    let successor: LocalIdentityManifestV1 | undefined;
    while (currentId !== null) {
      if (traversal.has(currentId)) {
        fail('identity-manifest verification closure contains a cycle');
      }
      traversal.add(currentId);
      requiredManifests.add(currentId);
      const material = identities.get(currentId);
      if (material === undefined) {
        fail(`identity-manifest verification closure is missing ${currentId}`);
      }
      if (successor !== undefined) {
        assertManifestPredecessor(successor, material.manifest);
      }
      successor = material.manifest;
      const predecessorId = material.manifest.predecessor_manifest_id;
      if (predecessorId === null) roots.add(material.manifest.manifest_id);
      currentId = predecessorId;
    }
  }
  const successorCounts = new Map<string, number>();
  for (const material of identities.values()) {
    const predecessorId = material.manifest.predecessor_manifest_id;
    if (predecessorId === null) continue;
    successorCounts.set(
      predecessorId,
      (successorCounts.get(predecessorId) ?? 0) + 1,
    );
  }
  if ([...successorCounts.values()].some((count) => count !== 1)) {
    fail('identity-manifest verification closure contains a lineage fork');
  }
  const predecessorIds = new Set(
    [...identities.values()]
      .map((material) => material.manifest.predecessor_manifest_id)
      .filter((manifestId): manifestId is string => manifestId !== null),
  );
  const leaves = [...identities.keys()].filter(
    (manifestId) => !predecessorIds.has(manifestId),
  );
  if (
    leaves.length !== 1 ||
    leaves[0] !== exportManifest.signing_identity_manifest_id
  ) {
    fail(
      'export signing identity manifest is not the unique newest lineage leaf',
    );
  }
  if (
    requiredManifests.size !== identities.size ||
    [...requiredManifests].some((manifestId) => !identities.has(manifestId))
  ) {
    fail('identity-manifest verification closure is not minimal');
  }
  if (roots.size !== 1) {
    fail(
      'identity-manifest verification closure does not have one lineage root',
    );
  }
}

function verifyEvents(
  exportManifest: FederatedExportManifestV1,
  events: readonly FederatedEventV1[],
  hashes: readonly Sha256Digest[],
  identities: ReadonlyMap<string, IdentityMaterial>,
  policies: ReadonlyMap<string, PolicyMaterial>,
): void {
  if (events.some((event) => event.occurred_at > exportManifest.generated_at)) {
    fail('export generated_at precedes an exported event');
  }
  if (
    events.length !== exportManifest.records.count ||
    exportManifest.sequence.last - exportManifest.sequence.first + 1 !==
      events.length
  ) {
    fail('export sequence range and record count disagree');
  }
  if (
    (exportManifest.sequence.first === 1) !==
    (exportManifest.sequence.predecessor_hash === null)
  ) {
    fail('export predecessor hash is inconsistent with the first sequence');
  }
  let previousHash = exportManifest.sequence.predecessor_hash;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const eventHash = hashes[index]!;
    const expectedSequence = exportManifest.sequence.first + index;
    if (
      event.organization_id !== exportManifest.organization_id ||
      event.producer.installation_id !== exportManifest.installation_id ||
      event.integrity.key_id !== event.producer.key_id ||
      event.sequence !== expectedSequence ||
      event.previous_event_hash !== previousHash ||
      event.occurred_at !== event.approval.reviewed_at
    ) {
      fail(`event ${event.event_id} is inconsistent with its export range`);
    }
    const identity = identityForDigest(
      identities,
      event.identity_manifest_sha256,
      `event ${event.event_id} identity_manifest_sha256`,
    );
    if (
      identity.manifest.organization.organization_id !==
        event.organization_id ||
      identity.manifest.principal.principal_id !==
        event.producer.principal_id ||
      identity.manifest.membership.membership_id !==
        event.producer.membership_id ||
      identity.manifest.installation.installation_id !==
        event.producer.installation_id ||
      identity.manifest.installation.signing_key.key_id !==
        event.producer.key_id ||
      identity.manifest.created_at > event.occurred_at ||
      identity.manifest.legacy_cutover.declared_at > event.occurred_at
    ) {
      fail(
        `event ${event.event_id} has an invalid identity-manifest reference`,
      );
    }
    verifySignedDocument(event, identity.publicKey, event.producer.key_id);
    assertApprovalIdentity(event, identity.manifest);

    const sourceIdentity = identityForReference(
      identities,
      event.source.identity_manifest_id,
      event.source.identity_manifest_sha256,
      `event ${event.event_id} source identity manifest`,
    );
    const sourceOwner = event.source.connection.owner;
    if (
      sourceIdentity.manifest.organization.organization_id !==
        event.organization_id ||
      sourceIdentity.manifest.created_at > event.occurred_at ||
      sourceIdentity.manifest.legacy_cutover.declared_at > event.occurred_at ||
      event.source.binding.configuration_sha256 !==
        canonicalSha256(event.source.binding.configuration_snapshot) ||
      (sourceOwner.kind === 'organization'
        ? sourceOwner.id !==
          sourceIdentity.manifest.organization.organization_id
        : sourceOwner.id !== sourceIdentity.manifest.membership.membership_id)
    ) {
      fail(`event ${event.event_id} has an invalid source identity reference`);
    }

    const processorIdentity = identityForReference(
      identities,
      event.processor.identity_manifest_id,
      event.processor.identity_manifest_sha256,
      `event ${event.event_id} processor identity manifest`,
    );
    if (
      processorIdentity.manifest.organization.organization_id !==
        event.organization_id ||
      processorIdentity.manifest.created_at > event.processor.generated_at ||
      processorIdentity.manifest.legacy_cutover.declared_at >
        event.processor.generated_at ||
      event.processor.configuration_sha256 !==
        canonicalSha256(event.processor.configuration_snapshot) ||
      event.processor.generated_at > event.occurred_at
    ) {
      fail(
        `event ${event.event_id} has an invalid processor identity reference`,
      );
    }
    if (
      !manifestIsAncestorOrEqual(
        identities,
        sourceIdentity.manifest.manifest_id,
        processorIdentity.manifest.manifest_id,
      ) ||
      !manifestIsAncestorOrEqual(
        identities,
        processorIdentity.manifest.manifest_id,
        identity.manifest.manifest_id,
      )
    ) {
      fail(
        `event ${event.event_id} source, processor, and event signer manifests are not in capture chronology`,
      );
    }

    const policyPath = policyArtifactPath(
      event.publication.policy_id,
      event.publication.version,
    );
    const policyMaterial = policies.get(policyPath);
    const policyIdentity =
      policyMaterial === undefined
        ? undefined
        : identities.get(policyMaterial.policy.identity_manifest_id);
    if (
      policyMaterial === undefined ||
      policyIdentity === undefined ||
      policyMaterial.artifact.sha256 !== event.publication.policy_sha256 ||
      policyMaterial.policy.organization_id !== event.organization_id ||
      policyMaterial.policy.identity_manifest_id !==
        event.publication.identity_manifest_id ||
      policyIdentity.manifest.organization.organization_id !==
        event.organization_id ||
      policyIdentity.manifest.installation.installation_id !==
        policyMaterial.policy.issued_by.installation_id ||
      policyIdentity.manifest.installation.signing_key.key_id !==
        policyMaterial.policy.issued_by.key_id ||
      policyMaterial.policy.issued_by.installation_id !==
        event.publication.signer_installation_id ||
      policyMaterial.policy.issued_by.key_id !==
        event.publication.signer_key_id ||
      policyMaterial.policy.effective_at > event.occurred_at ||
      policyIdentity.manifest.created_at > policyMaterial.policy.effective_at ||
      policyIdentity.manifest.legacy_cutover.declared_at > event.occurred_at ||
      canonicalJson(policyMaterial.policy.publication) !==
        canonicalJson(publicationSnapshot(event))
    ) {
      fail(
        `event ${event.event_id} has an invalid publication-policy reference`,
      );
    }
    verifySignedDocument(
      policyMaterial.policy,
      policyIdentity.publicKey,
      event.publication.signer_key_id,
    );
    assertPolicyAudience(policyMaterial.policy, policyIdentity.manifest);
    previousHash = eventHash;
  }
  if (hashes.at(-1) !== exportManifest.sequence.head_hash) {
    fail('export head hash does not match the final exact envelope bytes');
  }
  assertApprovalGroups(events);
}

export function verifyFederatedExportBundle(
  bundlePath: string,
): VerifiedFederatedExportBundle {
  assertBundleTopology(bundlePath);
  const manifestBytes = assertPrivateFile(
    join(bundlePath, EXPORT_MANIFEST_FILENAME),
    'federated export manifest',
  );
  assertFederationDocumentSize(manifestBytes, 'federated export manifest');
  const manifestJson = manifestBytes.toString('utf8');
  if (!Buffer.from(manifestJson, 'utf8').equals(manifestBytes)) {
    fail('export manifest is not valid UTF-8');
  }
  const manifest = parseCanonicalDocument<FederatedExportManifestV1>(
    'federated-export',
    manifestJson,
  );
  if (
    manifest.integrity.key_id !== manifest.key_id ||
    manifest.records.path !== RECORDS_FILENAME
  ) {
    fail('export manifest signer or records identity is inconsistent');
  }
  const { identities, policies } = parseArtifacts(bundlePath, manifest);
  const signingIdentity = identities.get(manifest.signing_identity_manifest_id);
  if (
    signingIdentity === undefined ||
    signingIdentity.manifest.organization.organization_id !==
      manifest.organization_id ||
    signingIdentity.manifest.installation.signing_key.key_id !==
      manifest.key_id ||
    signingIdentity.manifest.created_at > manifest.generated_at
  ) {
    fail('signing_identity_manifest_id does not bind the export signer');
  }
  verifySignedDocument(manifest, signingIdentity.publicKey, manifest.key_id);

  const recordsBytes = assertPrivateFile(
    join(bundlePath, RECORDS_FILENAME),
    'federated export records',
  );
  const { events, hashes } = parseRecords(recordsBytes, manifest);
  verifyManifestClosure(manifest, events, identities, policies);
  verifyEvents(manifest, events, hashes, identities, policies);

  return {
    path: bundlePath,
    manifest,
    manifest_json: manifestJson,
    records_bytes: recordsBytes,
    events,
    event_hashes: hashes,
    identity_manifests: new Map(
      [...identities].map(([manifestId, material]) => [
        manifestId,
        material.manifest,
      ]),
    ),
    publication_policies: new Map(
      [...policies].map(([path, material]) => [path, material.policy]),
    ),
  };
}

function policyReference(
  event: FederatedEventV1,
): HistoricalPublicationPolicyReference {
  return {
    policy_id: event.publication.policy_id,
    version: event.publication.version,
    policy_sha256: event.publication.policy_sha256,
    identity_manifest_id: event.publication.identity_manifest_id,
    signer_installation_id: event.publication.signer_installation_id,
    signer_key_id: event.publication.signer_key_id,
  };
}

function exactRange(
  chain: VerifiedFederatedChain,
  first: number,
  last: number,
): readonly StoredFederatedOutboxEvent[] {
  const events = chain.events.filter(
    (event) => event.sequence >= first && event.sequence <= last,
  );
  if (
    events.length !== last - first + 1 ||
    events[0]?.sequence !== first ||
    events.at(-1)?.sequence !== last
  ) {
    throw new Error('federated export range is not present contiguously');
  }
  return events;
}

function assertVerifiedIdentityMaterial(
  material: VerifiedHistoricalIdentityManifest,
  label: string,
): void {
  if (
    material.canonical !== canonicalJson(material.manifest) ||
    material.sha256 !== sha256Digest(material.canonical)
  ) {
    throw new Error(`${label} resolved to inconsistent verified bytes`);
  }
}

function loadExactIdentityReference(
  source: FederatedExportIdentitySource,
  manifestId: FederationId,
  sha256: Sha256Digest,
  label: string,
): VerifiedHistoricalIdentityManifest {
  const byId = source.loadVerifiedManifest(manifestId);
  const byDigest = source.loadVerifiedManifestBySha256(sha256);
  assertVerifiedIdentityMaterial(byId, label);
  assertVerifiedIdentityMaterial(byDigest, label);
  if (
    byId.manifest.manifest_id !== manifestId ||
    byId.sha256 !== sha256 ||
    byDigest.manifest.manifest_id !== manifestId ||
    byDigest.sha256 !== sha256 ||
    byId.canonical !== byDigest.canonical
  ) {
    throw new Error(`${label} ID and digest resolved to conflicting bytes`);
  }
  return byId;
}

function loadExportArtifacts(
  events: readonly StoredFederatedOutboxEvent[],
  signingManifestId: string,
  source: FederatedExportIdentitySource,
): ExportArtifact[] {
  const policies = new Map<string, ExportArtifact>();
  const manifestSeeds = new Set<string>([signingManifestId]);
  for (const stored of events) {
    const event = stored.envelope;
    const eventIdentity = source.loadVerifiedManifestBySha256(
      event.identity_manifest_sha256,
    );
    assertVerifiedIdentityMaterial(
      eventIdentity,
      `event ${event.event_id} identity manifest`,
    );
    if (eventIdentity.sha256 !== event.identity_manifest_sha256) {
      throw new Error(
        `event ${event.event_id} identity digest resolved to conflicting bytes`,
      );
    }
    const sourceIdentity = loadExactIdentityReference(
      source,
      event.source.identity_manifest_id,
      event.source.identity_manifest_sha256,
      `event ${event.event_id} source identity manifest`,
    );
    const processorIdentity = loadExactIdentityReference(
      source,
      event.processor.identity_manifest_id,
      event.processor.identity_manifest_sha256,
      `event ${event.event_id} processor identity manifest`,
    );
    const verified = source.loadVerifiedPolicy(
      policyReference(event),
      event.occurred_at,
    );
    const path = policyArtifactPath(
      verified.policy.policy_id,
      verified.policy.version,
    );
    const artifact: ExportArtifact = {
      path,
      kind: 'echo-publication-policy',
      sha256: verified.sha256,
      canonical: verified.canonical,
    };
    const existing = policies.get(path);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(artifact)
    ) {
      throw new Error(
        `publication policy ${path} resolved to conflicting bytes`,
      );
    }
    policies.set(path, artifact);
    manifestSeeds.add(eventIdentity.manifest.manifest_id);
    manifestSeeds.add(sourceIdentity.manifest.manifest_id);
    manifestSeeds.add(processorIdentity.manifest.manifest_id);
    manifestSeeds.add(verified.policy.identity_manifest_id);
  }

  const identities = new Map<string, ExportArtifact>();
  for (const seed of manifestSeeds) {
    const traversal = new Set<string>();
    let currentId: string | null = seed;
    while (currentId !== null) {
      if (traversal.has(currentId)) {
        throw new Error('identity-manifest export closure contains a cycle');
      }
      traversal.add(currentId);
      const verified = source.loadVerifiedManifest(currentId);
      if (verified.manifest.manifest_id !== currentId) {
        throw new Error('identity source returned the wrong manifest');
      }
      const artifact: ExportArtifact = {
        path: identityArtifactPath(currentId),
        kind: 'echo-local-identity-manifest',
        sha256: verified.sha256,
        canonical: verified.canonical,
      };
      const existing = identities.get(currentId);
      if (
        existing !== undefined &&
        canonicalJson(existing) !== canonicalJson(artifact)
      ) {
        throw new Error(
          `identity manifest ${currentId} resolved to conflicting bytes`,
        );
      }
      identities.set(currentId, artifact);
      currentId = verified.manifest.predecessor_manifest_id;
    }
  }
  return [...identities.values(), ...policies.values()].sort((left, right) =>
    bytewiseCompare(left.path, right.path),
  );
}

function unsignedManifest(
  request: CreateFederatedExportBundleRequest,
  events: readonly StoredFederatedOutboxEvent[],
  artifacts: readonly ExportArtifact[],
  keyId: Sha256Digest,
): Omit<FederatedExportManifestV1, 'integrity'> {
  const first = events[0]!;
  const last = events.at(-1)!;
  const organizationIds = new Set(
    events.map((event) => event.envelope.organization_id),
  );
  if (organizationIds.size !== 1) {
    throw new Error('federated export range crosses organizations');
  }
  const recordsBytes = Buffer.concat(
    events.map((event) =>
      Buffer.concat([event.envelope_bytes, Buffer.from('\n')]),
    ),
  );
  return {
    schema_version: 1,
    kind: 'echo-federated-export',
    export_id: request.export_id,
    organization_id: first.envelope.organization_id,
    installation_id: request.installation_id,
    key_id: keyId,
    signing_identity_manifest_id: request.signing_identity_manifest_id,
    artifacts: artifacts.map(({ path, kind, sha256 }) => ({
      path,
      kind,
      sha256,
    })),
    sequence: {
      first: request.first_sequence,
      last: request.last_sequence,
      predecessor_hash: first.previous_event_hash,
      head_hash: last.event_hash,
    },
    records: {
      path: RECORDS_FILENAME,
      count: events.length,
      sha256: sha256Digest(recordsBytes),
    },
    generated_at: request.generated_at,
  };
}

function assertRequest(request: CreateFederatedExportBundleRequest): void {
  assertFederationId(request.installation_id, 'ins', 'export installation_id');
  assertFederationId(
    request.signing_identity_manifest_id,
    'idm',
    'export signing_identity_manifest_id',
  );
  assertFederationId(request.export_id, 'exp', 'export_id');
  assertUtcMillisecondTimestamp(request.generated_at, 'export generated_at');
  if (
    !Number.isSafeInteger(request.first_sequence) ||
    !Number.isSafeInteger(request.last_sequence) ||
    request.first_sequence < 1 ||
    request.last_sequence < request.first_sequence
  ) {
    throw new Error('federated export sequence range is invalid');
  }
}

function bundleName(request: CreateFederatedExportBundleRequest): string {
  return `echo-org-export-${request.installation_id}-${request.first_sequence}-${request.last_sequence}`;
}

function sameUnsignedManifest(
  existing: FederatedExportManifestV1,
  expected: Omit<FederatedExportManifestV1, 'integrity'>,
): boolean {
  return canonicalJson(signedPayload(existing)) === canonicalJson(expected);
}

export async function createFederatedExportBundle(
  request: CreateFederatedExportBundleRequest,
): Promise<CreatedFederatedExportBundle> {
  assertRequest(request);
  ensureDirectory(request.output_root, 0o700);
  assertPrivateOwnedDirectory(request.output_root, 'federated export root');

  const signingManifest = request.identity_source.loadVerifiedActiveManifest();
  assertVerifiedIdentityMaterial(signingManifest, 'active signing manifest');
  if (
    signingManifest.manifest.manifest_id !==
    request.signing_identity_manifest_id
  ) {
    throw new Error(
      'export signing_identity_manifest_id is not the verified active identity manifest',
    );
  }
  const signingInstallationId =
    signingManifest.manifest.installation.installation_id;
  const descriptor = await request.signer.inspect(signingInstallationId);
  if (descriptor === null) {
    throw new Error('installation signing key is unavailable');
  }
  if (descriptor.installation_id !== signingInstallationId) {
    throw new Error(
      'installation signing key descriptor belongs to a different installation',
    );
  }
  const publicKey = verifyInstallationKeyDescriptor(descriptor);
  const chain = await request.outbox.verifyInstallationChain(
    request.installation_id,
    (event) => {
      const verified = request.identity_source.loadVerifiedManifestBySha256(
        event.envelope.identity_manifest_sha256,
      );
      if (
        verified.sha256 !== event.envelope.identity_manifest_sha256 ||
        verified.manifest.organization.organization_id !==
          event.envelope.organization_id ||
        verified.manifest.principal.principal_id !==
          event.envelope.producer.principal_id ||
        verified.manifest.membership.membership_id !==
          event.envelope.producer.membership_id ||
        verified.manifest.installation.installation_id !==
          event.envelope.producer.installation_id ||
        verified.manifest.installation.signing_key.key_id !==
          event.envelope.producer.key_id
      ) {
        throw new Error(
          `event ${event.event_id} has an invalid identity-manifest reference`,
        );
      }
      return {
        key_id: verified.manifest.installation.signing_key.key_id,
        public_key_spki_der: publicKeyForManifest(verified.manifest),
      };
    },
  );
  const events = exactRange(
    chain,
    request.first_sequence,
    request.last_sequence,
  );
  if (
    events.some((event) => event.envelope.occurred_at > request.generated_at)
  ) {
    throw new Error('export generated_at precedes an exported event');
  }
  if (events.some((event) => event.created_at > request.generated_at)) {
    throw new Error(
      'export generated_at precedes an exported outbox event creation time',
    );
  }
  assertApprovalGroups(events.map((event) => event.envelope));
  const artifacts = loadExportArtifacts(
    events,
    request.signing_identity_manifest_id,
    request.identity_source,
  );
  if (
    signingManifest.manifest.organization.organization_id !==
      events[0]!.envelope.organization_id ||
    signingManifest.manifest.installation.signing_key.key_id !==
      descriptor.key_id ||
    signingManifest.manifest.created_at > request.generated_at
  ) {
    throw new Error(
      'export signing manifest does not bind the requested signer',
    );
  }
  const recordsBytes = Buffer.concat(
    events.map((event) =>
      Buffer.concat([event.envelope_bytes, Buffer.from('\n')]),
    ),
  );
  const payload = unsignedManifest(
    request,
    events,
    artifacts,
    descriptor.key_id,
  );
  validateFederationDocument<Omit<FederatedExportManifestV1, 'integrity'>>(
    'federated-export',
    {
      ...payload,
      integrity: {
        canonicalization: 'RFC8785',
        payload_sha256: sha256Digest('{}'),
        signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
        key_id: descriptor.key_id,
        signature_base64: 'AA==',
      },
    },
  );

  const finalPath = join(request.output_root, bundleName(request));
  if (pathEntryExists(finalPath)) {
    const verified = verifyFederatedExportBundle(finalPath);
    if (
      !sameUnsignedManifest(verified.manifest, payload) ||
      !verified.records_bytes.equals(recordsBytes)
    ) {
      throw new Error(
        'federated export already exists with different immutable bytes',
      );
    }
    return {
      created: false,
      path: finalPath,
      manifest: verified.manifest,
      manifest_json: verified.manifest_json,
      records_bytes: verified.records_bytes,
      events: verified.events,
    };
  }

  const manifest = await createSignedDocument(
    payload,
    request.signer,
    signingInstallationId,
    descriptor.key_id,
  );
  validateFederationDocument<FederatedExportManifestV1>(
    'federated-export',
    manifest,
  );
  verifySignedDocument(manifest, publicKey, descriptor.key_id);
  const manifestJson = canonicalJson(manifest);
  assertFederationDocumentSize(manifestJson, 'federated export manifest');

  let stagingPath: string | undefined;
  try {
    stagingPath = mkdtempSync(
      join(
        request.output_root,
        `.${bundleName(request)}.${request.export_id}.staging-`,
      ),
    );
    chmodSync(stagingPath, 0o700);
    const identityDirectory = join(stagingPath, IDENTITY_DIRECTORY);
    const policyDirectory = join(stagingPath, POLICY_DIRECTORY);
    mkdirSync(identityDirectory, { mode: 0o700 });
    mkdirSync(policyDirectory, { mode: 0o700 });
    chmodSync(identityDirectory, 0o700);
    chmodSync(policyDirectory, 0o700);

    writeFileExclusive(
      join(stagingPath, EXPORT_MANIFEST_FILENAME),
      manifestJson,
      0o600,
    );
    writeFileExclusive(
      join(stagingPath, RECORDS_FILENAME),
      recordsBytes,
      0o600,
    );
    for (const artifact of artifacts) {
      writeFileExclusive(
        join(stagingPath, artifact.path),
        artifact.canonical,
        0o600,
      );
    }
    const staged = verifyFederatedExportBundle(stagingPath);
    if (
      staged.manifest_json !== manifestJson ||
      !staged.records_bytes.equals(recordsBytes)
    ) {
      throw new Error(
        'staged federated export verification changed exact bytes',
      );
    }
    fsyncDirectoryTree(stagingPath);
    renameSync(stagingPath, finalPath);
    stagingPath = undefined;
    fsyncDirectory(request.output_root);
    const committed = verifyFederatedExportBundle(finalPath);
    return {
      created: true,
      path: finalPath,
      manifest: committed.manifest,
      manifest_json: committed.manifest_json,
      records_bytes: committed.records_bytes,
      events: committed.events,
    };
  } catch (error) {
    if (stagingPath !== undefined && pathEntryExists(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
      fsyncDirectory(request.output_root);
    }
    throw error;
  }
}
