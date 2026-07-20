import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from '../../../storage/migrate.js';
import type {
  FederatedEventV1,
  FederationId,
  LocalIdentityManifestV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentChallengeV1,
  OrganizationEnrollmentProofV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
  OrgIngestReason,
  OrgIngestReceiptStatus,
  OrgIngestReceiptV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../contracts.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from '../foundation/canonical-json.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  federationId,
  type FederationIdPrefix,
} from '../foundation/identifiers.js';
import {
  createSignedDocumentWithKey,
  verifySignedDocument,
} from '../foundation/signed-document.js';
import {
  assertFederationDocumentSize,
  type FederationSchemaKind,
  validateFederationDocument,
} from '../schema-validation.js';
import { assertCompleteFederatedApprovalGroup } from '../outbox-store.js';
import {
  signWithOrganizationAuthority,
  type OrganizationAuthoritySigner,
  verifyOrganizationAuthorityDescriptor,
} from './authority-signer.js';
import { verifiedManifestPublicKey } from './enrollment-proof.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_CHALLENGE_LIFETIME_MS = 15 * 60 * 1000;
const MAX_ENROLLMENT_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INGEST_EVENTS = 256;
const MAX_INGEST_CANONICAL_BYTES = 16 * 1024 * 1024;

type AuthorityGeneratedIdPrefix = 'ech' | 'enr' | 'igr';

export interface OrganizationAuthorityStoreOptions {
  databasePath: string;
  signer: OrganizationAuthoritySigner;
  now?: () => string;
  createId?: (prefix: AuthorityGeneratedIdPrefix) => FederationId;
  createNonce?: (size: number) => Buffer;
}

export interface ProvisionOrganizationRequest {
  organization_id: FederationId;
  display_name: string;
  principal_id: FederationId;
  principal_display_name: string;
  membership_id: FederationId;
  provisioned_at: string;
}

export interface ProvisionMembershipRequest {
  principal_id: FederationId;
  principal_display_name: string;
  membership_id: FederationId;
  membership_type: 'owner' | 'employee' | 'contractor';
  provisioned_at: string;
}

export interface ProvisionedMembership {
  organization_id: FederationId;
  principal_id: FederationId;
  membership_id: FederationId;
  membership_type: 'owner' | 'employee' | 'contractor';
  status: 'active' | 'revoked';
  version: number;
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export interface IssueEnrollmentChallengeRequest {
  manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
  enrollment_grant: string;
  expires_at: string;
}

export interface IssueEnrollmentGrantRequest {
  expires_at: string;
}

export interface IssuedEnrollmentGrant {
  authority_id: FederationId;
  organization_id: FederationId;
  principal_id: FederationId;
  membership_id: FederationId;
  enrollment_grant: string;
  issued_at: string;
  expires_at: string;
}

export interface CompleteEnrollmentRequest {
  challenge: OrganizationEnrollmentChallengeV1;
  proof: OrganizationEnrollmentProofV1;
  manifest: LocalIdentityManifestV1;
}

export interface RevokeAuthoritySubjectRequest {
  reason: string;
}

export interface StoredAuthorityInstallation {
  installation_id: FederationId;
  organization_id: FederationId;
  principal_id: FederationId;
  membership_id: FederationId;
  key_id: Sha256Digest;
  identity_manifest_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  publication_policy_id: FederationId;
  publication_policy_version: number;
  publication_policy_sha256: Sha256Digest;
  enrollment_receipt_sha256: Sha256Digest;
  status: 'active' | 'revoked';
  version: number;
  enrolled_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  last_sequence: number;
  last_event_hash: Sha256Digest | null;
}

export interface StoredAuthorityEvent {
  event_id: FederationId;
  record_id: FederationId;
  installation_id: FederationId;
  sequence: number;
  event_sha256: Sha256Digest;
  envelope_json: string;
  envelope: FederatedEventV1;
  accepted_at: string;
}

export interface OrganizationAuthorityCounts {
  organizations: number;
  principals: number;
  memberships: number;
  challenges: number;
  installations: number;
  accepted_events: number;
  ingest_receipts: number;
}

interface MetadataRow {
  authority_id: string;
  organization_id: string;
  descriptor_json: string;
}

export interface OrganizationRow {
  organization_id: string;
  display_name: string;
  status: 'active' | 'revoked';
  policy_version: number;
  provisioned_at: string;
  revoked_at: string | null;
}

interface MembershipRow {
  membership_id: string;
  organization_id: string;
  principal_id: string;
  membership_type: 'owner' | 'employee' | 'contractor';
  status: 'active' | 'revoked';
  version: number;
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface PrincipalRow {
  principal_id: string;
  organization_id: string;
  display_name: string;
  provisioned_at: string;
}

interface EnrollmentGrantRow {
  grant_sha256: string;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  challenge_id: string | null;
}

interface ChallengeRow {
  challenge_id: string;
  challenge_sha256: string;
  challenge_json: string;
  publication_policy_sha256: string;
  publication_policy_json: string;
  expires_at: string;
  consumed_at: string | null;
  proof_sha256: string | null;
  enrollment_receipt_sha256: string | null;
  enrollment_receipt_json: string | null;
}

interface InstallationRow {
  installation_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  key_id: string;
  public_key_spki_der_base64: string;
  identity_manifest_id: string;
  identity_manifest_sha256: string;
  identity_manifest_json: string;
  publication_policy_id: string;
  publication_policy_version: number;
  publication_policy_sha256: string;
  enrollment_receipt_sha256: string;
  enrollment_receipt_json: string;
  status: 'active' | 'revoked';
  version: number;
  enrolled_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  last_sequence: number;
  last_event_hash: string | null;
}

interface AcceptedEventRow {
  event_id: string;
  record_id: string;
  installation_id: string;
  sequence: number;
  event_sha256: string;
  envelope_json: string;
  accepted_at: string;
}

interface AuthorityIngestReceiptRow {
  receipt_id: string;
  event_id: string;
  organization_id: string;
  installation_id: string;
  status: OrgIngestReceiptStatus;
  receipt_sha256: string;
  receipt_json: string;
  server_received_at: string;
}

interface ParsedIncomingEvent {
  envelope: FederatedEventV1;
  envelope_json: string;
  event_sha256: Sha256Digest;
}

function canonicalClone<T>(value: T): T {
  return parseCanonicalJson(canonicalJson(value)) as T;
}

function validatedDocumentSnapshot<T>(
  kind: FederationSchemaKind,
  value: unknown,
  label: string,
): T {
  const raw = canonicalJson(value);
  assertFederationDocumentSize(raw, label);
  return validateFederationDocument<T>(kind, parseCanonicalJson(raw));
}

function assertDigest(
  value: string,
  label: string,
): asserts value is Sha256Digest {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertNonempty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function enrollmentGrantBytes(secret: string): Buffer {
  if (typeof secret !== 'string') {
    throw new Error('organization enrollment grant must be text');
  }
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== secret) {
    throw new Error(
      'organization enrollment grant must be canonical base64 for 32 bytes',
    );
  }
  return decoded;
}

function matchingDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function assertManifestSemantics(manifest: LocalIdentityManifestV1): void {
  const organizationId = manifest.organization.organization_id;
  if (
    manifest.predecessor_manifest_id === manifest.manifest_id ||
    manifest.principal.organization_id !== organizationId ||
    manifest.membership.organization_id !== organizationId ||
    manifest.membership.principal_id !== manifest.principal.principal_id ||
    manifest.installation.organization_id !== organizationId ||
    manifest.installation.membership_id !== manifest.membership.membership_id
  ) {
    throw new Error('identity manifest has an inconsistent identity graph');
  }
  for (const [label, timestamp] of [
    ['identity manifest created_at', manifest.created_at],
    ['identity organization created_at', manifest.organization.created_at],
    ['identity membership valid_from', manifest.membership.valid_from],
    ['identity installation enrolled_at', manifest.installation.enrolled_at],
    [
      'identity legacy cutover declared_at',
      manifest.legacy_cutover.declared_at,
    ],
  ] as const) {
    assertUtcMillisecondTimestamp(timestamp, label);
    if (timestamp > manifest.created_at) {
      throw new Error(`${label} is later than the signed manifest`);
    }
  }
  const claimIds = new Set<string>();
  for (const claim of manifest.identity_claims) {
    if (claimIds.has(claim.claim_id)) {
      throw new Error('identity manifest contains duplicate claim IDs');
    }
    claimIds.add(claim.claim_id);
    assertUtcMillisecondTimestamp(
      claim.verification.verified_at,
      'identity claim verified_at',
    );
    if (
      claim.principal_id !== manifest.principal.principal_id ||
      claim.verification.verified_at > manifest.created_at
    ) {
      throw new Error(
        'identity manifest contains a claim outside its principal or chronology',
      );
    }
    if (
      claim.verification.method === 'slack_dm_challenge' &&
      (claim.issuer.kind !== 'provider' ||
        claim.issuer.provider !== 'slack' ||
        claim.subject.kind !== 'user' ||
        claim.verification.assurance !== 'provider_challenge_observed')
    ) {
      throw new Error('identity manifest contains an invalid Slack claim');
    }
    if (
      claim.verification.method === 'oidc_id_token' &&
      (claim.issuer.kind !== 'oidc' ||
        claim.subject.kind !== 'oidc_sub' ||
        claim.verification.assurance !== 'provider_verified')
    ) {
      throw new Error('identity manifest contains an invalid OIDC claim');
    }
  }
}

function verifiedEnrollmentMaterial(input: {
  manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
}): {
  manifest: LocalIdentityManifestV1;
  manifestJson: string;
  manifestSha256: Sha256Digest;
  publicKey: Buffer;
  policy: PublicationPolicyV1;
  policyJson: string;
  policySha256: Sha256Digest;
} {
  const manifest = validatedDocumentSnapshot<LocalIdentityManifestV1>(
    'local-identity-manifest',
    input.manifest,
    'organization enrollment identity manifest',
  );
  assertManifestSemantics(manifest);
  const publicKey = verifiedManifestPublicKey(manifest);
  const policy = validatedDocumentSnapshot<PublicationPolicyV1>(
    'publication-policy',
    input.publication_policy,
    'organization enrollment publication policy',
  );
  if (
    policy.organization_id !== manifest.organization.organization_id ||
    policy.identity_manifest_id !== manifest.manifest_id ||
    policy.issued_by.installation_id !==
      manifest.installation.installation_id ||
    policy.issued_by.key_id !== manifest.installation.signing_key.key_id
  ) {
    throw new Error(
      'organization enrollment policy does not match its identity manifest',
    );
  }
  verifySignedDocument(
    policy,
    publicKey,
    manifest.installation.signing_key.key_id,
  );
  const manifestJson = canonicalJson(manifest);
  const policyJson = canonicalJson(policy);
  return {
    manifest,
    manifestJson,
    manifestSha256: sha256Digest(manifestJson),
    publicKey,
    policy,
    policyJson,
    policySha256: sha256Digest(policyJson),
  };
}

function snapshotIngestBatch(
  input: OrganizationIngestBatchV1,
): OrganizationIngestBatchV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('organization ingest batch must be an object');
  }
  assertExactKeys(
    input,
    [
      'schema_version',
      'kind',
      'authority_id',
      'organization_id',
      'installation_id',
      'enrollment_receipt_sha256',
      'events',
    ],
    'organization ingest batch',
  );
  if (
    input.schema_version !== 1 ||
    input.kind !== 'echo-organization-ingest-batch' ||
    !Array.isArray(input.events) ||
    input.events.length === 0 ||
    input.events.length > MAX_INGEST_EVENTS
  ) {
    throw new Error('organization ingest batch is invalid or empty');
  }
  let canonicalBytes = 0;
  const events = input.events.map((event) => {
    if (typeof event !== 'string') {
      throw new Error('organization ingest batch events must be text');
    }
    canonicalBytes += Buffer.byteLength(event);
    if (canonicalBytes > MAX_INGEST_CANONICAL_BYTES) {
      throw new Error('organization ingest batch exceeds the byte limit');
    }
    return event;
  });
  return canonicalClone({
    schema_version: input.schema_version,
    kind: input.kind,
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    installation_id: input.installation_id,
    enrollment_receipt_sha256: input.enrollment_receipt_sha256,
    events,
  });
}

function asMembership(row: MembershipRow): ProvisionedMembership {
  assertFederationId(row.organization_id, 'org', 'stored organization');
  assertFederationId(row.principal_id, 'prn', 'stored principal');
  assertFederationId(row.membership_id, 'mem', 'stored membership');
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    throw new Error('stored membership version is invalid');
  }
  return { ...row };
}

function begin(database: Database.Database): void {
  database.exec('BEGIN IMMEDIATE');
}

function rollback(database: Database.Database): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the operation failure if SQLite already rolled back.
  }
}

function assertManifestCoordinates(
  descriptor: OrganizationAuthorityDescriptorV1,
  manifest: LocalIdentityManifestV1,
): void {
  const { organization, principal, membership, installation } = manifest;
  if (
    organization.organization_id !== descriptor.organization_id ||
    principal.organization_id !== organization.organization_id ||
    membership.organization_id !== organization.organization_id ||
    membership.principal_id !== principal.principal_id ||
    installation.organization_id !== organization.organization_id ||
    installation.membership_id !== membership.membership_id ||
    manifest.integrity.key_id !== installation.signing_key.key_id
  ) {
    throw new Error('identity manifest graph is inconsistent');
  }
}

function assertChallengeBindings(
  challenge: OrganizationEnrollmentChallengeV1,
  descriptor: OrganizationAuthorityDescriptorV1,
  manifest: LocalIdentityManifestV1,
  policy: PublicationPolicyV1,
): void {
  if (
    challenge.authority_id !== descriptor.authority_id ||
    challenge.organization_id !== descriptor.organization_id ||
    challenge.organization_id !== manifest.organization.organization_id ||
    challenge.principal_id !== manifest.principal.principal_id ||
    challenge.membership_id !== manifest.membership.membership_id ||
    challenge.installation_id !== manifest.installation.installation_id ||
    challenge.installation_key_id !==
      manifest.installation.signing_key.key_id ||
    challenge.identity_manifest_id !== manifest.manifest_id ||
    challenge.identity_manifest_sha256 !== canonicalSha256(manifest) ||
    challenge.publication_policy_id !== policy.policy_id ||
    challenge.publication_policy_version !== policy.version ||
    challenge.publication_policy_sha256 !== canonicalSha256(policy)
  ) {
    throw new Error('enrollment challenge binding does not match the manifest');
  }
}

function assertProofBindings(
  proof: OrganizationEnrollmentProofV1,
  challenge: OrganizationEnrollmentChallengeV1,
): void {
  if (
    proof.challenge_id !== challenge.challenge_id ||
    proof.challenge_sha256 !== canonicalSha256(challenge) ||
    proof.authority_id !== challenge.authority_id ||
    proof.organization_id !== challenge.organization_id ||
    proof.principal_id !== challenge.principal_id ||
    proof.membership_id !== challenge.membership_id ||
    proof.installation_id !== challenge.installation_id ||
    proof.installation_key_id !== challenge.installation_key_id ||
    proof.identity_manifest_id !== challenge.identity_manifest_id ||
    proof.identity_manifest_sha256 !== challenge.identity_manifest_sha256 ||
    proof.publication_policy_id !== challenge.publication_policy_id ||
    proof.publication_policy_version !== challenge.publication_policy_version ||
    proof.publication_policy_sha256 !== challenge.publication_policy_sha256
  ) {
    throw new Error('enrollment proof does not answer the exact challenge');
  }
}

function expectedLocalSubjectKey(event: FederatedEventV1): string {
  return `approved-org-record:${event.local_reference.approval_id}:${event.local_reference.signal_id}`;
}

function assertCompleteContiguousGroups(
  events: readonly ParsedIncomingEvent[],
): void {
  const completed = new Set<string>();
  let currentId: string | undefined;
  let current: ParsedIncomingEvent[] = [];
  const finish = (): void => {
    if (current.length === 0) return;
    assertCompleteFederatedApprovalGroup(
      current.map(({ envelope }) => ({
        local_subject_key: expectedLocalSubjectKey(envelope),
        envelope,
      })),
    );
  };
  for (const event of events) {
    const approvalId = event.envelope.local_reference.approval_id;
    if (approvalId !== currentId) {
      if (currentId !== undefined) {
        finish();
        completed.add(currentId);
      }
      if (completed.has(approvalId)) {
        throw new Error('ingest approval groups must be contiguous');
      }
      currentId = approvalId;
      current = [];
    }
    current.push(event);
  }
  finish();
}

function incomingChainReason(
  events: readonly ParsedIncomingEvent[],
): OrgIngestReason | null {
  const eventIds = new Set<string>();
  const recordIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index]!;
    const event = current.envelope;
    if (eventIds.has(event.event_id)) return 'event_id_conflict';
    if (recordIds.has(event.record.record_id)) return 'record_id_conflict';
    eventIds.add(event.event_id);
    recordIds.add(event.record.record_id);
    if (index > 0) {
      const previous = events[index - 1]!;
      if (event.sequence !== previous.envelope.sequence + 1) {
        return event.sequence > previous.envelope.sequence + 1
          ? 'sequence_gap'
          : 'sequence_fork';
      }
      if (event.previous_event_hash !== previous.event_sha256) {
        return 'previous_event_hash_mismatch';
      }
    }
  }
  return null;
}

function parseStoredReceipt(
  raw: string,
  descriptor: OrganizationAuthorityDescriptorV1,
): OrganizationEnrollmentReceiptV1 {
  const receipt = validateFederationDocument<OrganizationEnrollmentReceiptV1>(
    'organization-enrollment-receipt',
    parseCanonicalJson(raw),
  );
  verifySignedDocument(
    receipt,
    verifyOrganizationAuthorityDescriptor(descriptor),
    descriptor.signing_key.key_id,
  );
  return receipt;
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

function identityOwnsConnection(
  manifest: LocalIdentityManifestV1,
  owner: FederatedEventV1['source']['connection']['owner'],
): boolean {
  return owner.kind === 'organization'
    ? owner.id === manifest.organization.organization_id
    : owner.id === manifest.membership.membership_id;
}

function copiedSlackReasonDigest(reason: string): Sha256Digest {
  return canonicalSha256({
    domain: 'echo.slack-copied-reason.v1',
    text: reason,
  });
}

function assertApprovalSemantics(
  event: FederatedEventV1,
  manifest: LocalIdentityManifestV1,
): void {
  const approval = event.approval;
  if (
    approval.approver.principal_id !== manifest.principal.principal_id ||
    approval.approver.membership_id !== manifest.membership.membership_id
  ) {
    throw new Error('ingest event approval actor belongs to another identity');
  }
  if (approval.surface === null) {
    if (
      approval.approver.claim_id !== null ||
      approval.raw_actor_assertion.installation_id !==
        event.producer.installation_id ||
      approval.raw_actor_assertion.observed_at !== approval.reviewed_at
    ) {
      throw new Error('ingest event has an invalid CLI approval actor');
    }
    return;
  }

  const surface = approval.surface;
  const observation = approval.observation;
  if (
    canonicalJson(surface.binding) !== canonicalJson(observation.binding) ||
    surface.binding.configuration_sha256 !==
      canonicalSha256(surface.binding.configuration_snapshot) ||
    observation.binding.configuration_sha256 !==
      canonicalSha256(observation.binding.configuration_snapshot) ||
    canonicalJson(surface.connection) !==
      canonicalJson(observation.connection) ||
    !identityOwnsConnection(manifest, surface.connection.owner)
  ) {
    throw new Error(
      'ingest event Slack publication and observation snapshots diverge',
    );
  }
  const configuredChannel =
    surface.binding.configuration_snapshot['channel_id'];
  const configuredApprovalReaction =
    surface.binding.configuration_snapshot['approve_reaction'];
  const reasonReply = approval.raw_actor_assertion.reason_reply;
  const claim = manifest.identity_claims.find(
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
    claim.verification.verified_at > approval.reviewed_at ||
    surface.connection.provider_identity.team_id !==
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
    throw new Error('ingest event has invalid Slack approval evidence');
  }
}

function assertEventSemantics(
  event: FederatedEventV1,
  manifest: LocalIdentityManifestV1,
  policy: PublicationPolicyV1,
): void {
  const sourceOwner = event.source.connection.owner;
  if (
    event.occurred_at !== event.approval.reviewed_at ||
    manifest.created_at > event.occurred_at ||
    manifest.legacy_cutover.declared_at > event.occurred_at ||
    event.source.binding.configuration_sha256 !==
      canonicalSha256(event.source.binding.configuration_snapshot) ||
    !identityOwnsConnection(manifest, sourceOwner) ||
    event.processor.configuration_sha256 !==
      canonicalSha256(event.processor.configuration_snapshot) ||
    manifest.created_at > event.processor.generated_at ||
    manifest.legacy_cutover.declared_at > event.processor.generated_at ||
    event.processor.generated_at > event.occurred_at
  ) {
    throw new Error(
      'ingest event source, processor, or approval chronology is inconsistent',
    );
  }
  if (
    event.publication.policy_id !== policy.policy_id ||
    event.publication.version !== policy.version ||
    event.publication.policy_sha256 !== canonicalSha256(policy) ||
    event.publication.identity_manifest_id !== policy.identity_manifest_id ||
    event.publication.signer_installation_id !==
      policy.issued_by.installation_id ||
    event.publication.signer_key_id !== policy.issued_by.key_id ||
    policy.effective_at < manifest.created_at ||
    policy.effective_at > event.occurred_at ||
    canonicalJson(publicationSnapshot(event)) !==
      canonicalJson(policy.publication)
  ) {
    throw new Error(
      'ingest event does not match its registered publication policy',
    );
  }
  assertApprovalSemantics(event, manifest);
}

/**
 * Private, single-organization enrollment and ingest authority. Every mutation
 * is serialized with revocation and commits its signed receipts atomically.
 */
export class OrganizationAuthorityStore {
  private readonly database: Database.Database;
  private readonly signer: OrganizationAuthoritySigner;
  private readonly clock: () => string;
  private readonly idFactory: (
    prefix: AuthorityGeneratedIdPrefix,
  ) => FederationId;
  private readonly nonceFactory: (size: number) => Buffer;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: OrganizationAuthorityStoreOptions);
  constructor(
    databasePath: string,
    signer: OrganizationAuthoritySigner,
    options?: Omit<
      OrganizationAuthorityStoreOptions,
      'databasePath' | 'signer'
    >,
  );
  constructor(
    optionsOrPath: OrganizationAuthorityStoreOptions | string,
    suppliedSigner?: OrganizationAuthoritySigner,
    overrides: Omit<
      OrganizationAuthorityStoreOptions,
      'databasePath' | 'signer'
    > = {},
  ) {
    const options =
      typeof optionsOrPath === 'string'
        ? {
            databasePath: optionsOrPath,
            signer: suppliedSigner,
            ...overrides,
          }
        : optionsOrPath;
    if (options.signer === undefined) {
      throw new Error('organization authority signer is required');
    }
    const databasePath = options.databasePath;
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
      if (existsSync(databasePath)) {
        const state = lstatSync(databasePath);
        if (state.isSymbolicLink() || !state.isFile()) {
          throw new Error(
            'organization authority database must be a regular file',
          );
        }
      }
    }
    this.database = new Database(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    migrate(this.database, MIGRATIONS_DIR);
    this.signer = options.signer;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.idFactory =
      options.createId ??
      ((prefix) => federationId(prefix as FederationIdPrefix));
    this.nonceFactory = options.createNonce ?? randomBytes;
  }

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(async () => {
      if (this.closed)
        throw new Error('organization authority store is closed');
      return operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private currentTime(label: string): string {
    const value = this.clock();
    assertUtcMillisecondTimestamp(value, label);
    return value;
  }

  private nextId(prefix: AuthorityGeneratedIdPrefix): FederationId {
    const value = this.idFactory(prefix);
    assertFederationId(value, prefix, `generated ${prefix} identifier`);
    return value;
  }

  private async authority(): Promise<OrganizationAuthorityDescriptorV1> {
    const inspected = canonicalClone(await this.signer.inspect());
    verifyOrganizationAuthorityDescriptor(inspected);
    const descriptorJson = canonicalJson(inspected);
    const existing = this.database
      .prepare(
        `SELECT authority_id, organization_id, descriptor_json
         FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    if (existing === undefined) {
      this.database
        .prepare(
          `INSERT INTO authority_metadata (
             singleton, authority_id, organization_id, descriptor_json, created_at
           ) VALUES (1, ?, ?, ?, ?)`,
        )
        .run(
          inspected.authority_id,
          inspected.organization_id,
          descriptorJson,
          this.currentTime('authority initialization time'),
        );
    } else if (
      existing.authority_id !== inspected.authority_id ||
      existing.organization_id !== inspected.organization_id ||
      existing.descriptor_json !== descriptorJson
    ) {
      throw new Error(
        'organization authority signer differs from stored authority',
      );
    }
    return inspected;
  }

  private async authorityDocument<T extends object>(
    descriptor: OrganizationAuthorityDescriptorV1,
    payload: T,
  ): Promise<T & { integrity: OrgIngestReceiptV1['integrity'] }> {
    return createSignedDocumentWithKey(
      payload,
      descriptor.signing_key.key_id,
      (bytes) => signWithOrganizationAuthority(this.signer, descriptor, bytes),
    );
  }

  async getDescriptor(): Promise<OrganizationAuthorityDescriptorV1> {
    return this.runExclusive(async () =>
      canonicalClone(await this.authority()),
    );
  }

  async provisionOrganization(
    request: ProvisionOrganizationRequest,
  ): Promise<ProvisionedMembership> {
    const snapshot = canonicalClone(request);
    assertFederationId(snapshot.organization_id, 'org', 'organization');
    assertFederationId(snapshot.principal_id, 'prn', 'first principal');
    assertFederationId(snapshot.membership_id, 'mem', 'first membership');
    assertNonempty(snapshot.display_name, 'organization display name');
    assertNonempty(snapshot.principal_display_name, 'principal display name');
    assertUtcMillisecondTimestamp(snapshot.provisioned_at, 'provisioning time');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      if (snapshot.organization_id !== descriptor.organization_id) {
        throw new Error('provisioned organization does not match authority');
      }
      begin(this.database);
      try {
        const organization = this.database
          .prepare(
            'SELECT * FROM authority_organizations WHERE organization_id = ?',
          )
          .get(snapshot.organization_id) as OrganizationRow | undefined;
        if (organization === undefined) {
          this.database
            .prepare(
              `INSERT INTO authority_organizations (
                 organization_id, display_name, status, policy_version,
                 provisioned_at, revoked_at
               ) VALUES (?, ?, 'active', 1, ?, NULL)`,
            )
            .run(
              snapshot.organization_id,
              snapshot.display_name,
              snapshot.provisioned_at,
            );
        } else if (
          organization.display_name !== snapshot.display_name ||
          organization.provisioned_at !== snapshot.provisioned_at ||
          organization.status !== 'active' ||
          organization.policy_version !== 1
        ) {
          throw new Error('organization is already provisioned differently');
        }
        this.ensurePrincipalAndMembership(
          {
            principal_id: snapshot.principal_id,
            principal_display_name: snapshot.principal_display_name,
            membership_id: snapshot.membership_id,
            membership_type: 'owner',
            provisioned_at: snapshot.provisioned_at,
          },
          snapshot.organization_id,
        );
        const result = this.membershipRow(snapshot.membership_id)!;
        this.database.exec('COMMIT');
        return asMembership(result);
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async provisionMembership(
    request: ProvisionMembershipRequest,
  ): Promise<ProvisionedMembership> {
    const snapshot = canonicalClone(request);
    assertFederationId(snapshot.principal_id, 'prn', 'principal');
    assertFederationId(snapshot.membership_id, 'mem', 'membership');
    assertNonempty(snapshot.principal_display_name, 'principal display name');
    assertUtcMillisecondTimestamp(snapshot.provisioned_at, 'provisioning time');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      begin(this.database);
      try {
        const organization = this.organizationRow(descriptor.organization_id);
        if (organization === undefined || organization.status !== 'active') {
          throw new Error(
            'organization must be active before provisioning membership',
          );
        }
        this.ensurePrincipalAndMembership(snapshot, descriptor.organization_id);
        const result = this.membershipRow(snapshot.membership_id)!;
        this.database.exec('COMMIT');
        return asMembership(result);
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  private ensurePrincipalAndMembership(
    request: ProvisionMembershipRequest,
    organizationId: string,
  ): void {
    const principal = this.database
      .prepare(
        `SELECT principal_id, organization_id, display_name, provisioned_at
         FROM authority_principals WHERE principal_id = ?`,
      )
      .get(request.principal_id) as
      | {
          principal_id: string;
          organization_id: string;
          display_name: string;
          provisioned_at: string;
        }
      | undefined;
    if (principal === undefined) {
      this.database
        .prepare(
          `INSERT INTO authority_principals (
             principal_id, organization_id, display_name, provisioned_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          request.principal_id,
          organizationId,
          request.principal_display_name,
          request.provisioned_at,
        );
    } else if (
      principal.organization_id !== organizationId ||
      principal.display_name !== request.principal_display_name
    ) {
      throw new Error('principal is already provisioned differently');
    }
    const membership = this.membershipRow(request.membership_id);
    if (membership === undefined) {
      this.database
        .prepare(
          `INSERT INTO authority_memberships (
             membership_id, organization_id, principal_id, membership_type,
             status, version, provisioned_at, revoked_at, revocation_reason
           ) VALUES (?, ?, ?, ?, 'active', 1, ?, NULL, NULL)`,
        )
        .run(
          request.membership_id,
          organizationId,
          request.principal_id,
          request.membership_type,
          request.provisioned_at,
        );
    } else if (
      membership.organization_id !== organizationId ||
      membership.principal_id !== request.principal_id ||
      membership.membership_type !== request.membership_type ||
      membership.provisioned_at !== request.provisioned_at ||
      membership.status !== 'active' ||
      membership.version !== 1
    ) {
      throw new Error('membership is already provisioned differently');
    }
  }

  private organizationRow(organizationId: string): OrganizationRow | undefined {
    return this.database
      .prepare(
        'SELECT * FROM authority_organizations WHERE organization_id = ?',
      )
      .get(organizationId) as OrganizationRow | undefined;
  }

  private membershipRow(membershipId: string): MembershipRow | undefined {
    return this.database
      .prepare('SELECT * FROM authority_memberships WHERE membership_id = ?')
      .get(membershipId) as MembershipRow | undefined;
  }

  private principalRow(principalId: string): PrincipalRow | undefined {
    return this.database
      .prepare('SELECT * FROM authority_principals WHERE principal_id = ?')
      .get(principalId) as PrincipalRow | undefined;
  }

  private installationRow(installationId: string): InstallationRow | undefined {
    return this.database
      .prepare(
        'SELECT * FROM authority_installations WHERE installation_id = ?',
      )
      .get(installationId) as InstallationRow | undefined;
  }

  private assertEnrollmentAuthorityFacts(
    descriptor: OrganizationAuthorityDescriptorV1,
    manifest: LocalIdentityManifestV1,
    policy: PublicationPolicyV1,
    evaluatedAt: string,
  ): { organization: OrganizationRow; membership: MembershipRow } {
    assertManifestCoordinates(descriptor, manifest);
    const organization = this.organizationRow(descriptor.organization_id);
    const principal = this.principalRow(manifest.principal.principal_id);
    const membership = this.membershipRow(manifest.membership.membership_id);
    if (
      organization === undefined ||
      organization.status !== 'active' ||
      organization.display_name !== manifest.organization.display_name ||
      principal === undefined ||
      principal.organization_id !== descriptor.organization_id ||
      principal.display_name !== manifest.principal.display_name ||
      membership === undefined ||
      membership.status !== 'active' ||
      membership.organization_id !== descriptor.organization_id ||
      membership.principal_id !== manifest.principal.principal_id ||
      membership.membership_type !== manifest.membership.type
    ) {
      throw new Error(
        'identity manifest does not match active preprovisioned authority facts',
      );
    }
    if (policy.version !== organization.policy_version) {
      throw new Error(
        'publication policy is not the active authority policy version',
      );
    }
    if (
      policy.effective_at < manifest.created_at ||
      policy.effective_at > evaluatedAt
    ) {
      throw new Error(
        'publication policy is outside its manifest and authority chronology',
      );
    }
    if (
      policy.publication.audience.scope === 'organization' &&
      (policy.publication.audience.subjects.length !== 1 ||
        policy.publication.audience.subjects[0]?.kind !== 'organization' ||
        policy.publication.audience.subjects[0].id !==
          descriptor.organization_id)
    ) {
      throw new Error(
        'organization publication audience must name exactly the authority organization',
      );
    }
    for (const subject of policy.publication.audience.subjects) {
      if (subject.kind === 'organization') {
        if (subject.id !== descriptor.organization_id) {
          throw new Error('publication policy audience crosses organizations');
        }
        continue;
      }
      const audienceMembership = this.membershipRow(subject.id);
      if (
        audienceMembership === undefined ||
        audienceMembership.organization_id !== descriptor.organization_id ||
        audienceMembership.status !== 'active'
      ) {
        throw new Error(
          'publication policy audience is not an active organization membership',
        );
      }
    }
    return { organization, membership };
  }

  async issueEnrollmentGrant(
    membershipId: FederationId,
    request: IssueEnrollmentGrantRequest,
  ): Promise<IssuedEnrollmentGrant> {
    assertFederationId(membershipId, 'mem', 'enrollment grant membership');
    const expiresAt = request.expires_at;
    assertUtcMillisecondTimestamp(expiresAt, 'enrollment grant expiry');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      begin(this.database);
      try {
        const now = this.currentTime('enrollment grant issue time');
        const lifetime = Date.parse(expiresAt) - Date.parse(now);
        const organization = this.organizationRow(descriptor.organization_id);
        const membership = this.membershipRow(membershipId);
        if (
          organization === undefined ||
          organization.status !== 'active' ||
          membership === undefined ||
          membership.status !== 'active' ||
          membership.organization_id !== descriptor.organization_id ||
          lifetime <= 0 ||
          lifetime > MAX_ENROLLMENT_GRANT_LIFETIME_MS
        ) {
          throw new Error(
            'an active membership and a positive grant lifetime of at most 7 days are required',
          );
        }
        const secretBytes = this.nonceFactory(32);
        if (!Buffer.isBuffer(secretBytes) || secretBytes.length !== 32) {
          throw new Error('enrollment grant source must return 32 bytes');
        }
        const enrollmentGrant = Buffer.from(secretBytes).toString('base64');
        const grantSha = sha256Digest(Buffer.from(secretBytes));
        this.database
          .prepare(
            `INSERT INTO authority_enrollment_grants (
               grant_sha256, authority_id, organization_id, principal_id,
               membership_id, issued_at, expires_at, consumed_at, challenge_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            grantSha,
            descriptor.authority_id,
            descriptor.organization_id,
            membership.principal_id,
            membership.membership_id,
            now,
            expiresAt,
          );
        this.database.exec('COMMIT');
        return {
          authority_id: descriptor.authority_id,
          organization_id: descriptor.organization_id,
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          enrollment_grant: enrollmentGrant,
          issued_at: now,
          expires_at: expiresAt,
        };
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async issueEnrollmentChallenge(
    request: IssueEnrollmentChallengeRequest,
  ): Promise<OrganizationEnrollmentChallengeV1> {
    const material = verifiedEnrollmentMaterial(request);
    const { manifest, policy } = material;
    const grantSha = sha256Digest(
      enrollmentGrantBytes(request.enrollment_grant),
    );
    const expiresAt = request.expires_at;
    assertUtcMillisecondTimestamp(expiresAt, 'enrollment challenge expiry');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      begin(this.database);
      try {
        const now = this.currentTime('enrollment challenge issue time');
        const lifetime = Date.parse(expiresAt) - Date.parse(now);
        if (lifetime <= 0 || lifetime > MAX_CHALLENGE_LIFETIME_MS) {
          throw new Error(
            'a positive challenge lifetime of at most 15 minutes is required',
          );
        }
        this.assertEnrollmentAuthorityFacts(descriptor, manifest, policy, now);
        const grant = this.database
          .prepare(
            `SELECT grant_sha256, authority_id, organization_id, principal_id,
                    membership_id, issued_at, expires_at, consumed_at,
                    challenge_id
             FROM authority_enrollment_grants WHERE grant_sha256 = ?`,
          )
          .get(grantSha) as EnrollmentGrantRow | undefined;
        if (
          grant === undefined ||
          !matchingDigest(grant.grant_sha256, grantSha) ||
          grant.authority_id !== descriptor.authority_id ||
          grant.organization_id !== descriptor.organization_id ||
          grant.principal_id !== manifest.principal.principal_id ||
          grant.membership_id !== manifest.membership.membership_id
        ) {
          throw new Error(
            'organization enrollment grant does not authorize this membership',
          );
        }
        if (grant.consumed_at !== null) {
          if (grant.challenge_id === null) {
            throw new Error(
              'consumed organization enrollment grant has no challenge',
            );
          }
          const existingRow = this.database
            .prepare(
              `SELECT challenge_json FROM authority_enrollment_challenges
               WHERE challenge_id = ? AND grant_sha256 = ?`,
            )
            .get(grant.challenge_id, grantSha) as
            { challenge_json: string } | undefined;
          if (existingRow === undefined) {
            throw new Error(
              'consumed organization enrollment grant is inconsistent',
            );
          }
          const existing =
            validateFederationDocument<OrganizationEnrollmentChallengeV1>(
              'organization-enrollment-challenge',
              parseCanonicalJson(existingRow.challenge_json),
            );
          assertChallengeBindings(existing, descriptor, manifest, policy);
          if (existing.expires_at !== expiresAt) {
            throw new Error(
              'organization enrollment grant was already consumed differently',
            );
          }
          verifySignedDocument(
            existing,
            verifyOrganizationAuthorityDescriptor(descriptor),
            descriptor.signing_key.key_id,
          );
          this.database.exec('COMMIT');
          return canonicalClone(existing);
        }
        if (
          now < grant.issued_at ||
          now >= grant.expires_at ||
          expiresAt > grant.expires_at
        ) {
          throw new Error(
            'organization enrollment grant is not currently valid',
          );
        }
        if (
          this.installationRow(manifest.installation.installation_id) !==
          undefined
        ) {
          throw new Error('installation is already enrolled');
        }
        const registeredManifest = this.database
          .prepare(
            `SELECT manifest_id FROM authority_identity_manifests
             WHERE manifest_id = ? OR manifest_sha256 = ? OR key_id = ?
             LIMIT 1`,
          )
          .get(
            manifest.manifest_id,
            material.manifestSha256,
            manifest.installation.signing_key.key_id,
          );
        if (registeredManifest !== undefined) {
          throw new Error(
            'identity manifest ID, digest, or key is already registered',
          );
        }
        const nonce = this.nonceFactory(32);
        if (!Buffer.isBuffer(nonce) || nonce.length !== 32) {
          throw new Error(
            'enrollment challenge nonce source must return 32 bytes',
          );
        }
        const challenge = await this.authorityDocument(descriptor, {
          schema_version: 1,
          kind: 'echo-organization-enrollment-challenge',
          challenge_id: this.nextId('ech'),
          authority_id: descriptor.authority_id,
          organization_id: descriptor.organization_id,
          principal_id: manifest.principal.principal_id,
          membership_id: manifest.membership.membership_id,
          installation_id: manifest.installation.installation_id,
          installation_key_id: manifest.installation.signing_key.key_id,
          identity_manifest_id: manifest.manifest_id,
          identity_manifest_sha256: material.manifestSha256,
          publication_policy_id: policy.policy_id,
          publication_policy_version: policy.version,
          publication_policy_sha256: material.policySha256,
          nonce_base64: Buffer.from(nonce).toString('base64'),
          issued_at: now,
          expires_at: expiresAt,
        });
        const validated =
          validateFederationDocument<OrganizationEnrollmentChallengeV1>(
            'organization-enrollment-challenge',
            challenge,
          );
        verifySignedDocument(
          validated,
          verifyOrganizationAuthorityDescriptor(descriptor),
          descriptor.signing_key.key_id,
        );
        const raw = canonicalJson(validated);
        assertFederationDocumentSize(raw, 'organization enrollment challenge');
        this.database
          .prepare(
            `INSERT INTO authority_enrollment_challenges (
               challenge_id, grant_sha256, authority_id, organization_id,
               principal_id, membership_id, installation_id,
               installation_key_id, identity_manifest_id,
               identity_manifest_sha256, publication_policy_id,
               publication_policy_version, publication_policy_sha256,
               publication_policy_json, challenge_sha256, challenge_json,
               issued_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            validated.challenge_id,
            grantSha,
            validated.authority_id,
            validated.organization_id,
            validated.principal_id,
            validated.membership_id,
            validated.installation_id,
            validated.installation_key_id,
            validated.identity_manifest_id,
            validated.identity_manifest_sha256,
            validated.publication_policy_id,
            validated.publication_policy_version,
            validated.publication_policy_sha256,
            material.policyJson,
            canonicalSha256(validated),
            raw,
            validated.issued_at,
            validated.expires_at,
          );
        const consumed = this.database
          .prepare(
            `UPDATE authority_enrollment_grants
             SET consumed_at = ?, challenge_id = ?
             WHERE grant_sha256 = ? AND consumed_at IS NULL`,
          )
          .run(now, validated.challenge_id, grantSha);
        if (consumed.changes !== 1) {
          throw new Error(
            'organization enrollment grant was consumed concurrently',
          );
        }
        this.database.exec('COMMIT');
        return canonicalClone(validated);
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async completeEnrollment(
    request: CompleteEnrollmentRequest,
  ): Promise<OrganizationEnrollmentReceiptV1> {
    const challenge =
      validatedDocumentSnapshot<OrganizationEnrollmentChallengeV1>(
        'organization-enrollment-challenge',
        request.challenge,
        'organization enrollment challenge',
      );
    const proof = validatedDocumentSnapshot<OrganizationEnrollmentProofV1>(
      'organization-enrollment-proof',
      request.proof,
      'organization enrollment proof',
    );
    const manifest = validatedDocumentSnapshot<LocalIdentityManifestV1>(
      'local-identity-manifest',
      request.manifest,
      'organization enrollment identity manifest',
    );
    assertManifestSemantics(manifest);
    const installationPublicKey = verifiedManifestPublicKey(manifest);
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      const authorityPublicKey =
        verifyOrganizationAuthorityDescriptor(descriptor);
      assertProofBindings(proof, challenge);
      verifySignedDocument(
        challenge,
        authorityPublicKey,
        descriptor.signing_key.key_id,
      );
      verifySignedDocument(
        proof,
        installationPublicKey,
        challenge.installation_key_id,
      );
      begin(this.database);
      try {
        const now = this.currentTime('enrollment completion time');
        const row = this.database
          .prepare(
            'SELECT * FROM authority_enrollment_challenges WHERE challenge_id = ?',
          )
          .get(challenge.challenge_id) as ChallengeRow | undefined;
        if (
          row === undefined ||
          row.challenge_sha256 !== canonicalSha256(challenge) ||
          row.challenge_json !== canonicalJson(challenge)
        ) {
          throw new Error(
            'enrollment challenge is unknown or differs from stored bytes',
          );
        }
        assertFederationDocumentSize(
          row.publication_policy_json,
          'stored organization enrollment publication policy',
        );
        const policy = validateFederationDocument<PublicationPolicyV1>(
          'publication-policy',
          parseCanonicalJson(row.publication_policy_json),
        );
        if (
          row.publication_policy_sha256 !==
            sha256Digest(row.publication_policy_json) ||
          row.publication_policy_sha256 !== challenge.publication_policy_sha256
        ) {
          throw new Error(
            'stored enrollment publication policy is inconsistent',
          );
        }
        verifySignedDocument(
          policy,
          installationPublicKey,
          challenge.installation_key_id,
        );
        assertChallengeBindings(challenge, descriptor, manifest, policy);
        const proofSha = canonicalSha256(proof);
        if (row.consumed_at !== null) {
          if (
            row.proof_sha256 === proofSha &&
            row.enrollment_receipt_json !== null &&
            row.enrollment_receipt_sha256 ===
              sha256Digest(row.enrollment_receipt_json)
          ) {
            const existing = parseStoredReceipt(
              row.enrollment_receipt_json,
              descriptor,
            );
            this.database.exec('COMMIT');
            return canonicalClone(existing);
          }
          throw new Error(
            'enrollment challenge was already consumed by different proof bytes',
          );
        }
        if (now >= row.expires_at || now < challenge.issued_at) {
          throw new Error('enrollment challenge is expired or not yet valid');
        }
        const { membership } = this.assertEnrollmentAuthorityFacts(
          descriptor,
          manifest,
          policy,
          now,
        );
        assertDigest(row.challenge_sha256, 'stored enrollment challenge');
        const preexisting = this.installationRow(challenge.installation_id);
        if (preexisting !== undefined) {
          throw new Error('installation identifier is already enrolled');
        }
        const receipt = await this.authorityDocument(descriptor, {
          schema_version: 1,
          kind: 'echo-organization-enrollment-receipt',
          enrollment_id: this.nextId('enr'),
          authority_id: descriptor.authority_id,
          authority_key_id: descriptor.signing_key.key_id,
          organization_id: descriptor.organization_id,
          principal_id: challenge.principal_id,
          membership_id: challenge.membership_id,
          membership_version: membership.version,
          installation_id: challenge.installation_id,
          installation_key_id: challenge.installation_key_id,
          installation_version: 1,
          identity_manifest_id: challenge.identity_manifest_id,
          identity_manifest_sha256: challenge.identity_manifest_sha256,
          publication_policy_id: challenge.publication_policy_id,
          publication_policy_version: challenge.publication_policy_version,
          publication_policy_sha256: challenge.publication_policy_sha256,
          challenge_id: challenge.challenge_id,
          challenge_sha256: row.challenge_sha256 as Sha256Digest,
          proof_sha256: proofSha,
          status: 'enrolled',
          enrolled_at: now,
        });
        const validated =
          validateFederationDocument<OrganizationEnrollmentReceiptV1>(
            'organization-enrollment-receipt',
            receipt,
          );
        verifySignedDocument(
          validated,
          authorityPublicKey,
          descriptor.signing_key.key_id,
        );
        const receiptJson = canonicalJson(validated);
        const receiptSha = sha256Digest(receiptJson);
        const manifestJson = canonicalJson(manifest);
        this.database
          .prepare(
            `INSERT INTO authority_identity_manifests (
               manifest_id, manifest_sha256, organization_id, principal_id,
               membership_id, installation_id, key_id, manifest_json,
               registered_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            challenge.identity_manifest_id,
            challenge.identity_manifest_sha256,
            challenge.organization_id,
            challenge.principal_id,
            challenge.membership_id,
            challenge.installation_id,
            challenge.installation_key_id,
            manifestJson,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO authority_publication_policies (
               policy_id, version, policy_sha256, organization_id, manifest_id,
               installation_id, key_id, policy_json, registered_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            challenge.publication_policy_id,
            challenge.publication_policy_version,
            challenge.publication_policy_sha256,
            challenge.organization_id,
            challenge.identity_manifest_id,
            challenge.installation_id,
            challenge.installation_key_id,
            row.publication_policy_json,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO authority_installations (
               installation_id, organization_id, principal_id, membership_id,
               key_id, public_key_spki_der_base64, identity_manifest_id,
               identity_manifest_sha256, identity_manifest_json,
               publication_policy_id, publication_policy_version,
               publication_policy_sha256,
               enrollment_receipt_sha256, enrollment_receipt_json, status,
               version, enrolled_at, revoked_at, revocation_reason,
               last_sequence, last_event_hash
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL, NULL, 0, NULL)`,
          )
          .run(
            challenge.installation_id,
            challenge.organization_id,
            challenge.principal_id,
            challenge.membership_id,
            challenge.installation_key_id,
            manifest.installation.signing_key.public_key_spki_der_base64,
            challenge.identity_manifest_id,
            challenge.identity_manifest_sha256,
            manifestJson,
            challenge.publication_policy_id,
            challenge.publication_policy_version,
            challenge.publication_policy_sha256,
            receiptSha,
            receiptJson,
            now,
          );
        this.database
          .prepare(
            `UPDATE authority_enrollment_challenges
             SET consumed_at = ?, proof_sha256 = ?, proof_json = ?,
                 enrollment_receipt_sha256 = ?, enrollment_receipt_json = ?
             WHERE challenge_id = ? AND consumed_at IS NULL`,
          )
          .run(
            now,
            proofSha,
            canonicalJson(proof),
            receiptSha,
            receiptJson,
            challenge.challenge_id,
          );
        this.database.exec('COMMIT');
        return canonicalClone(validated);
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async revokeMembership(
    membershipId: FederationId,
    request: RevokeAuthoritySubjectRequest,
  ): Promise<ProvisionedMembership> {
    assertFederationId(membershipId, 'mem', 'membership');
    const snapshot = canonicalClone({ reason: request.reason });
    assertNonempty(snapshot.reason, 'membership revocation reason');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      begin(this.database);
      try {
        const revokedAt = this.currentTime('membership revocation time');
        const row = this.membershipRow(membershipId);
        if (
          row === undefined ||
          row.organization_id !== descriptor.organization_id
        ) {
          throw new Error('membership is not provisioned by this authority');
        }
        if (row.status === 'active') {
          if (revokedAt < row.provisioned_at) {
            throw new Error(
              'membership revocation cannot predate provisioning',
            );
          }
          this.database
            .prepare(
              `UPDATE authority_memberships
               SET status = 'revoked', version = version + 1,
                   revoked_at = ?, revocation_reason = ?
               WHERE membership_id = ? AND status = 'active'`,
            )
            .run(revokedAt, snapshot.reason, membershipId);
        } else if (row.revocation_reason !== snapshot.reason) {
          throw new Error(
            'membership revocation is monotonic and already differs',
          );
        }
        const result = asMembership(this.membershipRow(membershipId)!);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async revokeInstallation(
    installationId: FederationId,
    request: RevokeAuthoritySubjectRequest,
  ): Promise<StoredAuthorityInstallation> {
    assertFederationId(installationId, 'ins', 'installation');
    const snapshot = canonicalClone({ reason: request.reason });
    assertNonempty(snapshot.reason, 'installation revocation reason');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      begin(this.database);
      try {
        const revokedAt = this.currentTime('installation revocation time');
        const row = this.installationRow(installationId);
        if (
          row === undefined ||
          row.organization_id !== descriptor.organization_id
        ) {
          throw new Error('installation is not enrolled with this authority');
        }
        if (row.status === 'active') {
          if (revokedAt < row.enrolled_at) {
            throw new Error(
              'installation revocation cannot predate enrollment',
            );
          }
          this.database
            .prepare(
              `UPDATE authority_installations
               SET status = 'revoked', version = version + 1,
                   revoked_at = ?, revocation_reason = ?
               WHERE installation_id = ? AND status = 'active'`,
            )
            .run(revokedAt, snapshot.reason, installationId);
        } else if (row.revocation_reason !== snapshot.reason) {
          throw new Error(
            'installation revocation is monotonic and already differs',
          );
        }
        const result = this.toStoredInstallation(
          this.installationRow(installationId)!,
        );
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  private toStoredInstallation(
    row: InstallationRow,
  ): StoredAuthorityInstallation {
    assertFederationId(row.installation_id, 'ins', 'stored installation');
    assertFederationId(
      row.organization_id,
      'org',
      'stored installation organization',
    );
    assertFederationId(
      row.principal_id,
      'prn',
      'stored installation principal',
    );
    assertFederationId(
      row.membership_id,
      'mem',
      'stored installation membership',
    );
    assertDigest(row.key_id, 'stored installation key');
    assertDigest(row.identity_manifest_sha256, 'stored identity manifest');
    assertFederationId(
      row.publication_policy_id,
      'pol',
      'stored publication policy',
    );
    assertDigest(row.publication_policy_sha256, 'stored publication policy');
    assertDigest(row.enrollment_receipt_sha256, 'stored enrollment receipt');
    if (row.last_event_hash !== null) {
      assertDigest(row.last_event_hash, 'stored installation head hash');
    }
    if (
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !Number.isSafeInteger(row.publication_policy_version) ||
      row.publication_policy_version < 1 ||
      !Number.isSafeInteger(row.last_sequence) ||
      row.last_sequence < 0 ||
      (row.last_sequence === 0) !== (row.last_event_hash === null)
    ) {
      throw new Error('stored installation state is invalid');
    }
    return {
      installation_id: row.installation_id,
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      key_id: row.key_id,
      identity_manifest_id: row.identity_manifest_id,
      identity_manifest_sha256: row.identity_manifest_sha256,
      publication_policy_id: row.publication_policy_id,
      publication_policy_version: row.publication_policy_version,
      publication_policy_sha256: row.publication_policy_sha256,
      enrollment_receipt_sha256: row.enrollment_receipt_sha256,
      status: row.status,
      version: row.version,
      enrolled_at: row.enrolled_at,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
      last_sequence: row.last_sequence,
      last_event_hash: row.last_event_hash,
    };
  }

  private verifiedInstallationIdentity(
    installation: InstallationRow,
    descriptor: OrganizationAuthorityDescriptorV1,
  ): {
    manifest: LocalIdentityManifestV1;
    publicKey: Buffer;
    enrollmentReceipt: OrganizationEnrollmentReceiptV1;
  } {
    this.toStoredInstallation(installation);
    const manifest = validateFederationDocument<LocalIdentityManifestV1>(
      'local-identity-manifest',
      parseCanonicalJson(installation.identity_manifest_json),
    );
    if (
      canonicalSha256(manifest) !== installation.identity_manifest_sha256 ||
      manifest.manifest_id !== installation.identity_manifest_id ||
      manifest.installation.installation_id !== installation.installation_id ||
      manifest.installation.signing_key.key_id !== installation.key_id ||
      manifest.installation.signing_key.public_key_spki_der_base64 !==
        installation.public_key_spki_der_base64
    ) {
      throw new Error('stored enrolled identity manifest is inconsistent');
    }
    const publicKey = verifiedManifestPublicKey(manifest);
    const enrollmentReceipt = parseStoredReceipt(
      installation.enrollment_receipt_json,
      descriptor,
    );
    if (
      sha256Digest(installation.enrollment_receipt_json) !==
        installation.enrollment_receipt_sha256 ||
      enrollmentReceipt.authority_id !== descriptor.authority_id ||
      enrollmentReceipt.authority_key_id !== descriptor.signing_key.key_id ||
      enrollmentReceipt.organization_id !== installation.organization_id ||
      enrollmentReceipt.principal_id !== installation.principal_id ||
      enrollmentReceipt.membership_id !== installation.membership_id ||
      enrollmentReceipt.installation_id !== installation.installation_id ||
      enrollmentReceipt.installation_key_id !== installation.key_id ||
      enrollmentReceipt.identity_manifest_id !==
        installation.identity_manifest_id ||
      enrollmentReceipt.identity_manifest_sha256 !==
        installation.identity_manifest_sha256 ||
      enrollmentReceipt.publication_policy_id !==
        installation.publication_policy_id ||
      enrollmentReceipt.publication_policy_version !==
        installation.publication_policy_version ||
      enrollmentReceipt.publication_policy_sha256 !==
        installation.publication_policy_sha256
    ) {
      throw new Error('stored enrollment receipt is inconsistent');
    }
    return { manifest, publicKey, enrollmentReceipt };
  }

  private parseAndVerifyIncomingEvents(
    batch: OrganizationIngestBatchV1,
    installation: InstallationRow,
    descriptor: OrganizationAuthorityDescriptorV1,
  ): ParsedIncomingEvent[] {
    const { manifest, publicKey } = this.verifiedInstallationIdentity(
      installation,
      descriptor,
    );
    const organization = this.organizationRow(installation.organization_id);
    if (organization === undefined || organization.status !== 'active') {
      throw new Error('ingest organization is not active');
    }
    const policyRow = this.database
      .prepare(
        `SELECT policy_sha256, organization_id, manifest_id, installation_id,
                key_id, policy_json
         FROM authority_publication_policies
         WHERE policy_id = ? AND version = ?`,
      )
      .get(
        installation.publication_policy_id,
        installation.publication_policy_version,
      ) as
      | {
          policy_sha256: string;
          organization_id: string;
          manifest_id: string;
          installation_id: string;
          key_id: string;
          policy_json: string;
        }
      | undefined;
    if (policyRow === undefined) {
      throw new Error('stored installation publication policy is missing');
    }
    assertFederationDocumentSize(
      policyRow.policy_json,
      'stored installation publication policy',
    );
    const policy = validateFederationDocument<PublicationPolicyV1>(
      'publication-policy',
      parseCanonicalJson(policyRow.policy_json),
    );
    if (
      sha256Digest(policyRow.policy_json) !==
        installation.publication_policy_sha256 ||
      policyRow.policy_sha256 !== installation.publication_policy_sha256 ||
      policyRow.organization_id !== installation.organization_id ||
      policyRow.manifest_id !== installation.identity_manifest_id ||
      policyRow.installation_id !== installation.installation_id ||
      policyRow.key_id !== installation.key_id ||
      policy.policy_id !== installation.publication_policy_id ||
      policy.version !== installation.publication_policy_version ||
      policy.organization_id !== installation.organization_id ||
      policy.identity_manifest_id !== installation.identity_manifest_id ||
      policy.issued_by.installation_id !== installation.installation_id ||
      policy.issued_by.key_id !== installation.key_id
    ) {
      throw new Error('stored installation publication policy is inconsistent');
    }
    verifySignedDocument(
      policy,
      publicKey,
      installation.key_id as Sha256Digest,
    );
    const parsed = batch.events.map((raw): ParsedIncomingEvent => {
      assertFederationDocumentSize(raw, 'organization ingest event');
      const envelope = validateFederationDocument<FederatedEventV1>(
        'federated-record-envelope',
        parseCanonicalJson(raw),
      );
      verifySignedDocument(
        envelope,
        publicKey,
        installation.key_id as Sha256Digest,
      );
      const producer = envelope.producer;
      if (
        envelope.organization_id !== installation.organization_id ||
        envelope.identity_manifest_sha256 !==
          installation.identity_manifest_sha256 ||
        producer.principal_id !== installation.principal_id ||
        producer.membership_id !== installation.membership_id ||
        producer.installation_id !== installation.installation_id ||
        producer.key_id !== installation.key_id ||
        envelope.source.identity_manifest_id !==
          installation.identity_manifest_id ||
        envelope.source.identity_manifest_sha256 !==
          installation.identity_manifest_sha256 ||
        envelope.processor.identity_manifest_id !==
          installation.identity_manifest_id ||
        envelope.processor.identity_manifest_sha256 !==
          installation.identity_manifest_sha256 ||
        envelope.publication.identity_manifest_id !==
          installation.identity_manifest_id ||
        envelope.publication.signer_installation_id !==
          installation.installation_id ||
        envelope.publication.signer_key_id !== installation.key_id ||
        envelope.approval.approver.principal_id !== installation.principal_id ||
        envelope.approval.approver.membership_id !== installation.membership_id
      ) {
        throw new Error('ingest event identity does not match enrollment');
      }
      if (envelope.publication.version !== organization.policy_version) {
        throw new Error(
          'ingest event publication policy version is not active',
        );
      }
      for (const subject of envelope.publication.audience.subjects) {
        if (subject.kind === 'organization') {
          if (subject.id !== installation.organization_id) {
            throw new Error(
              'ingest event publication audience crosses organizations',
            );
          }
          continue;
        }
        const audienceMembership = this.membershipRow(subject.id);
        if (
          audienceMembership === undefined ||
          audienceMembership.organization_id !== installation.organization_id
        ) {
          throw new Error(
            'ingest event publication audience is not organization-scoped',
          );
        }
      }
      if (
        envelope.publication.audience.scope === 'organization' &&
        (envelope.publication.audience.subjects.length !== 1 ||
          envelope.publication.audience.subjects[0]?.kind !== 'organization' ||
          envelope.publication.audience.subjects[0].id !==
            installation.organization_id)
      ) {
        throw new Error('ingest event organization audience is not canonical');
      }
      assertEventSemantics(envelope, manifest, policy);
      return {
        envelope,
        envelope_json: raw,
        event_sha256: sha256Digest(raw),
      };
    });
    assertCompleteContiguousGroups(parsed);
    return parsed;
  }

  private acceptedEventById(eventId: string): AcceptedEventRow | undefined {
    return this.database
      .prepare(
        `SELECT event_id, record_id, installation_id, sequence,
                event_sha256, envelope_json, accepted_at
         FROM authority_accepted_events WHERE event_id = ?`,
      )
      .get(eventId) as AcceptedEventRow | undefined;
  }

  private conflictReason(
    events: readonly ParsedIncomingEvent[],
    installation: InstallationRow,
  ): OrgIngestReason | null {
    const internalConflict = incomingChainReason(events);
    if (internalConflict !== null) return internalConflict;
    for (const incoming of events) {
      const event = incoming.envelope;
      const byEvent = this.acceptedEventById(event.event_id);
      if (byEvent !== undefined) {
        if (
          byEvent.installation_id !== installation.installation_id ||
          byEvent.record_id !== event.record.record_id ||
          byEvent.sequence !== event.sequence ||
          byEvent.event_sha256 !== incoming.event_sha256 ||
          byEvent.envelope_json !== incoming.envelope_json
        ) {
          return 'event_id_conflict';
        }
        continue;
      }
      const byLocalSubject = this.database
        .prepare(
          `SELECT event_id FROM authority_accepted_events
           WHERE installation_id = ? AND local_subject_key = ?`,
        )
        .get(installation.installation_id, expectedLocalSubjectKey(event)) as
        { event_id: string } | undefined;
      if (byLocalSubject !== undefined) return 'local_subject_conflict';
      const byRecord = this.database
        .prepare(
          'SELECT event_id FROM authority_accepted_events WHERE record_id = ?',
        )
        .get(event.record.record_id) as { event_id: string } | undefined;
      if (byRecord !== undefined) return 'record_id_conflict';
      const bySequence = this.database
        .prepare(
          `SELECT event_id FROM authority_accepted_events
           WHERE installation_id = ? AND sequence = ?`,
        )
        .get(installation.installation_id, event.sequence) as
        { event_id: string } | undefined;
      if (
        bySequence !== undefined ||
        event.sequence <= installation.last_sequence
      ) {
        return 'sequence_fork';
      }
    }

    const firstNew = events.find(
      ({ envelope }) => this.acceptedEventById(envelope.event_id) === undefined,
    );
    if (firstNew === undefined) return null;
    const firstNewIndex = events.indexOf(firstNew);
    if (
      events
        .slice(firstNewIndex + 1)
        .some(
          ({ envelope }) =>
            this.acceptedEventById(envelope.event_id) !== undefined,
        )
    ) {
      return 'sequence_fork';
    }
    if (firstNew.envelope.sequence !== installation.last_sequence + 1) {
      return firstNew.envelope.sequence > installation.last_sequence + 1
        ? 'sequence_gap'
        : 'sequence_fork';
    }
    if (
      firstNew.envelope.previous_event_hash !== installation.last_event_hash
    ) {
      return 'previous_event_hash_mismatch';
    }
    return null;
  }

  private async persistReceipt(
    descriptor: OrganizationAuthorityDescriptorV1,
    organization: OrganizationRow,
    membership: MembershipRow,
    installation: InstallationRow,
    event: ParsedIncomingEvent,
    batchSha: Sha256Digest,
    status: OrgIngestReceiptStatus,
    reason: OrgIngestReason | null,
    head: { last_sequence: number; last_event_hash: Sha256Digest | null },
    receivedAt: string,
  ): Promise<OrgIngestReceiptV1> {
    const receipt = await this.authorityDocument(descriptor, {
      schema_version: 1,
      kind: 'echo-org-ingest-receipt',
      receipt_id: this.nextId('igr'),
      authority_id: descriptor.authority_id,
      authority_key_id: descriptor.signing_key.key_id,
      organization_id: descriptor.organization_id,
      membership_id: membership.membership_id,
      membership_version: membership.version,
      installation_id: installation.installation_id,
      installation_version: installation.version,
      enrollment_receipt_sha256: installation.enrollment_receipt_sha256,
      event_id: event.envelope.event_id,
      record_id: event.envelope.record.record_id,
      sequence: event.envelope.sequence,
      event_sha256: event.event_sha256,
      batch_sha256: batchSha,
      status,
      canonical_record_id:
        status === 'accepted' || status === 'duplicate'
          ? event.envelope.record.record_id
          : null,
      server_received_at: receivedAt,
      policy_version: organization.policy_version,
      reason,
      authority_head: head,
    });
    const validated = validateFederationDocument<OrgIngestReceiptV1>(
      'org-ingest-receipt',
      receipt,
    );
    verifySignedDocument(
      validated,
      verifyOrganizationAuthorityDescriptor(descriptor),
      descriptor.signing_key.key_id,
    );
    const raw = canonicalJson(validated);
    assertFederationDocumentSize(raw, 'organization ingest receipt');
    this.database
      .prepare(
        `INSERT INTO authority_ingest_receipts (
           receipt_id, event_id, organization_id, installation_id,
           status, receipt_sha256, receipt_json, server_received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.receipt_id,
        validated.event_id,
        validated.organization_id,
        validated.installation_id,
        validated.status,
        sha256Digest(raw),
        raw,
        validated.server_received_at,
      );
    return canonicalClone(validated);
  }

  async ingestBatch(
    requestedBatch: OrganizationIngestBatchV1,
  ): Promise<readonly OrgIngestReceiptV1[]> {
    const batch = snapshotIngestBatch(requestedBatch);
    assertFederationId(batch.authority_id, 'oau', 'ingest authority');
    assertFederationId(batch.organization_id, 'org', 'ingest organization');
    assertFederationId(batch.installation_id, 'ins', 'ingest installation');
    assertDigest(batch.enrollment_receipt_sha256, 'ingest enrollment receipt');
    const batchSha = canonicalSha256(batch);
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      if (
        batch.authority_id !== descriptor.authority_id ||
        batch.organization_id !== descriptor.organization_id
      ) {
        throw new Error('ingest batch belongs to another authority');
      }
      begin(this.database);
      try {
        const receivedAt = this.currentTime('organization ingest receipt time');
        const organization = this.organizationRow(descriptor.organization_id);
        const installation = this.installationRow(batch.installation_id);
        if (
          organization === undefined ||
          installation === undefined ||
          installation.organization_id !== descriptor.organization_id ||
          installation.enrollment_receipt_sha256 !==
            batch.enrollment_receipt_sha256
        ) {
          throw new Error(
            'ingest batch does not name an enrolled installation',
          );
        }
        const membership = this.membershipRow(installation.membership_id);
        if (
          membership === undefined ||
          membership.organization_id !== descriptor.organization_id ||
          membership.principal_id !== installation.principal_id
        ) {
          throw new Error('enrolled installation membership is inconsistent');
        }
        const events = this.parseAndVerifyIncomingEvents(
          batch,
          installation,
          descriptor,
        );
        const rejectionReason: OrgIngestReason | null =
          membership.status === 'revoked'
            ? 'membership_revoked'
            : installation.status === 'revoked'
              ? 'installation_revoked'
              : null;
        if (rejectionReason !== null) {
          const head = {
            last_sequence: installation.last_sequence,
            last_event_hash:
              installation.last_event_hash as Sha256Digest | null,
          };
          const receipts: OrgIngestReceiptV1[] = [];
          for (const event of events) {
            receipts.push(
              await this.persistReceipt(
                descriptor,
                organization,
                membership,
                installation,
                event,
                batchSha,
                'rejected',
                rejectionReason,
                head,
                receivedAt,
              ),
            );
          }
          this.database.exec('COMMIT');
          return receipts;
        }
        const conflict = this.conflictReason(events, installation);
        if (conflict !== null) {
          const head = {
            last_sequence: installation.last_sequence,
            last_event_hash:
              installation.last_event_hash as Sha256Digest | null,
          };
          const receipts: OrgIngestReceiptV1[] = [];
          for (const event of events) {
            receipts.push(
              await this.persistReceipt(
                descriptor,
                organization,
                membership,
                installation,
                event,
                batchSha,
                'quarantined',
                conflict,
                head,
                receivedAt,
              ),
            );
          }
          this.database.exec('COMMIT');
          return receipts;
        }

        let lastSequence = installation.last_sequence;
        let lastHash = installation.last_event_hash as Sha256Digest | null;
        const receipts: OrgIngestReceiptV1[] = [];
        for (const event of events) {
          const duplicate = this.acceptedEventById(event.envelope.event_id);
          let status: OrgIngestReceiptStatus = 'duplicate';
          if (duplicate === undefined) {
            status = 'accepted';
            this.database
              .prepare(
                `INSERT INTO authority_accepted_events (
                   event_id, record_id, organization_id, principal_id,
                   membership_id, installation_id, local_subject_key, sequence,
                   previous_event_hash, event_sha256, envelope_json, accepted_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                event.envelope.event_id,
                event.envelope.record.record_id,
                descriptor.organization_id,
                installation.principal_id,
                membership.membership_id,
                installation.installation_id,
                expectedLocalSubjectKey(event.envelope),
                event.envelope.sequence,
                event.envelope.previous_event_hash,
                event.event_sha256,
                event.envelope_json,
                receivedAt,
              );
            lastSequence = event.envelope.sequence;
            lastHash = event.event_sha256;
            this.database
              .prepare(
                `UPDATE authority_installations
                 SET last_sequence = ?, last_event_hash = ?
                 WHERE installation_id = ?`,
              )
              .run(lastSequence, lastHash, installation.installation_id);
          }
          receipts.push(
            await this.persistReceipt(
              descriptor,
              organization,
              membership,
              installation,
              event,
              batchSha,
              status,
              null,
              {
                last_sequence: event.envelope.sequence,
                last_event_hash: event.event_sha256,
              },
              receivedAt,
            ),
          );
        }
        this.database.exec('COMMIT');
        return receipts;
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  /** Alias for transport adapters that expose the operation simply as ingest. */
  async ingest(
    batch: OrganizationIngestBatchV1,
  ): Promise<readonly OrgIngestReceiptV1[]> {
    return this.ingestBatch(batch);
  }

  async inspectOrganization(): Promise<OrganizationRow | null> {
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      const row = this.organizationRow(descriptor.organization_id);
      return row === undefined ? null : canonicalClone(row);
    });
  }

  async inspectMembership(
    membershipId: FederationId,
  ): Promise<ProvisionedMembership | null> {
    assertFederationId(membershipId, 'mem', 'membership');
    return this.runExclusive(() => {
      const row = this.membershipRow(membershipId);
      return row === undefined ? null : asMembership(row);
    });
  }

  async inspectInstallation(
    installationId: FederationId,
  ): Promise<StoredAuthorityInstallation | null> {
    assertFederationId(installationId, 'ins', 'installation');
    return this.runExclusive(() => {
      const row = this.installationRow(installationId);
      return row === undefined ? null : this.toStoredInstallation(row);
    });
  }

  async readEnrollmentReceipt(
    installationId: FederationId,
  ): Promise<OrganizationEnrollmentReceiptV1 | null> {
    assertFederationId(installationId, 'ins', 'installation');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      const row = this.installationRow(installationId);
      if (row === undefined) return null;
      return this.verifiedInstallationIdentity(row, descriptor)
        .enrollmentReceipt;
    });
  }

  async readAcceptedEvent(
    eventId: FederationId,
  ): Promise<StoredAuthorityEvent | null> {
    assertFederationId(eventId, 'evt', 'event');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      const row = this.acceptedEventById(eventId);
      if (row === undefined) return null;
      assertDigest(row.event_sha256, 'stored accepted event');
      const envelope = validateFederationDocument<FederatedEventV1>(
        'federated-record-envelope',
        parseCanonicalJson(row.envelope_json),
      );
      if (
        envelope.event_id !== row.event_id ||
        envelope.record.record_id !== row.record_id ||
        envelope.producer.installation_id !== row.installation_id ||
        envelope.sequence !== row.sequence ||
        sha256Digest(row.envelope_json) !== row.event_sha256
      ) {
        throw new Error('stored accepted event row is inconsistent');
      }
      const installation = this.installationRow(row.installation_id);
      if (installation === undefined) {
        throw new Error('stored accepted event installation is missing');
      }
      const { publicKey } = this.verifiedInstallationIdentity(
        installation,
        descriptor,
      );
      verifySignedDocument(
        envelope,
        publicKey,
        installation.key_id as Sha256Digest,
      );
      return { ...row, event_sha256: row.event_sha256, envelope };
    });
  }

  async listIngestReceipts(
    eventId: FederationId,
  ): Promise<readonly OrgIngestReceiptV1[]> {
    assertFederationId(eventId, 'evt', 'event');
    return this.runExclusive(async () => {
      const descriptor = await this.authority();
      const publicKey = verifyOrganizationAuthorityDescriptor(descriptor);
      const rows = this.database
        .prepare(
          `SELECT receipt_id, event_id, organization_id, installation_id,
                  status, receipt_sha256, receipt_json, server_received_at
           FROM authority_ingest_receipts
           WHERE event_id = ? ORDER BY rowid ASC`,
        )
        .all(eventId) as AuthorityIngestReceiptRow[];
      return rows.map((row) => {
        assertDigest(row.receipt_sha256, 'stored organization ingest receipt');
        const receipt = validateFederationDocument<OrgIngestReceiptV1>(
          'org-ingest-receipt',
          parseCanonicalJson(row.receipt_json),
        );
        verifySignedDocument(receipt, publicKey, descriptor.signing_key.key_id);
        if (
          sha256Digest(row.receipt_json) !== row.receipt_sha256 ||
          receipt.receipt_id !== row.receipt_id ||
          receipt.event_id !== eventId ||
          receipt.event_id !== row.event_id ||
          receipt.authority_id !== descriptor.authority_id ||
          receipt.authority_key_id !== descriptor.signing_key.key_id ||
          receipt.organization_id !== descriptor.organization_id ||
          receipt.organization_id !== row.organization_id ||
          receipt.installation_id !== row.installation_id ||
          receipt.status !== row.status ||
          receipt.server_received_at !== row.server_received_at
        ) {
          throw new Error(
            'stored organization ingest receipt row is inconsistent',
          );
        }
        return receipt;
      });
    });
  }

  async counts(): Promise<OrganizationAuthorityCounts> {
    return this.runExclusive(() => {
      const count = (table: string): number => {
        const row = this.database
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as {
          count: number;
        };
        return row.count;
      };
      return {
        organizations: count('authority_organizations'),
        principals: count('authority_principals'),
        memberships: count('authority_memberships'),
        challenges: count('authority_enrollment_challenges'),
        installations: count('authority_installations'),
        accepted_events: count('authority_accepted_events'),
        ingest_receipts: count('authority_ingest_receipts'),
      };
    });
  }

  async close(): Promise<void> {
    const close = this.operationTail.then(() => {
      if (!this.closed) {
        this.closed = true;
        this.database.close();
      }
    });
    this.operationTail = close;
    await close;
  }
}
