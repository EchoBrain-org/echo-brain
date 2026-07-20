import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  assertPrivateOwnedDirectory,
  readFileNoFollow,
  secureTreeFiles,
} from '../secure-local-files.js';
import {
  analyzeApprovalGroup,
  analyzeApprovalSignal,
} from './approval-group-invariants.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './canonical-json.js';
import type {
  FederatedEventV1,
  FederatedExportManifestV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from './contracts.js';
import {
  assertManifestPredecessor,
  assertManifestSemantics,
  bytewiseCompare,
  EXPORT_MANIFEST_FILENAME,
  failFederatedExportVerification as fail,
  IDENTITY_DIRECTORY,
  identityArtifactPath,
  identityForDigest,
  identityForReference,
  type IdentityMaterial,
  manifestIsAncestorOrEqual,
  POLICY_DIRECTORY,
  policyArtifactPath,
  type PolicyMaterial,
  publicKeyForManifest,
  RECORDS_FILENAME,
  type VerifiedFederatedExportBundle,
} from './export-bundle-material.js';
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from './schema-validation.js';
import { verifySignedDocument } from './signed-document.js';

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
    const rawBytes = assertPrivateFile(join(bundlePath, entry.path), entry.path);
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

function assertSignalManifest(event: FederatedEventV1): void {
  const analysis = analyzeApprovalSignal(event);
  switch (analysis.first_manifest_violation) {
    case 'duplicate-signal-id':
      fail(
        `approval ${event.local_reference.approval_id} has duplicate signal IDs`,
      );
    case 'non-contiguous-position':
      fail(
        `approval ${event.local_reference.approval_id} has non-contiguous signal positions`,
      );
    case 'non-canonical-order':
      fail(
        `approval ${event.local_reference.approval_id} has a non-canonical signal manifest`,
      );
    case null:
      break;
  }
  if (!analysis.own_entry_kind_matches || !analysis.own_entry_digest_matches) {
    fail(`event ${event.event_id} does not match its signal manifest digest`);
  }
}

export function assertApprovalGroups(
  events: readonly FederatedEventV1[],
): void {
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
    const analysis = analyzeApprovalGroup(group.map((item) => item.event));
    for (let offset = 0; offset < group.length; offset += 1) {
      const item = group[offset]!;
      const invariant = analysis.items[offset]!;
      if (
        item.index !== first.index + offset ||
        !invariant.approval_group_matches ||
        !invariant.shared_facts_match
      ) {
        fail(
          `approval ${approvalId} is non-contiguous or has divergent sibling facts`,
        );
      }
      if (invariant.signal_repeated) {
        fail(`approval ${approvalId} repeats an exported signal`);
      }
      if (!invariant.order_is_canonical) {
        fail(
          `approval ${approvalId} records are not in canonical signal order`,
        );
      }
    }
    if (!analysis.present_signals_match_manifest) {
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

export function verifyFederatedExportBundleInternal(
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
