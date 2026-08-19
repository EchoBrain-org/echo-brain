import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import { createHash } from 'node:crypto';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  validateOrganizationAuthorityDescriptor,
  validateOrganizationInstallationAccessState,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationInstallationAccessState,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import {
  MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
  organizationInternalLiveManifestSha256,
  validateOrganizationInternalLiveReleaseManifest,
  verifyOrganizationAccessLeaseRequestAnyVersion,
  verifyOrganizationInternalLiveUpdateReceipt,
} from '@echo-brain/organization-api';
import type Database from 'better-sqlite3';
import {
  assertRevocationReason,
  MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
  timestampMillis,
} from '../../../domain/rules.js';
import type {
  AuthorityAdminCounts,
  AuthorityAuditEntry,
  AuthorityReadTransaction,
  AuthorityWriteTransaction,
  InitializeAuthorityRepositoryInput,
  MemberExclusionOwnerSource,
  MemberExclusionReadAuditEntry,
  NewOidcIdentityBinding,
  NewOidcLoginAttempt,
  OidcLoginAttemptCompletion,
  NewAuthorityEnrollment,
  NewInternalLiveRelease,
  PersonReadDecisionAuditEntry,
  PersonReadOperation,
  NewPersonLoginGrant,
  NewPersonSessionCredential,
  NewPersonSessionFamily,
  OrganizationAuthorityRepository,
  StoredAccessLeaseRequest,
  StoredAuthorityAccessState,
  StoredAuthorityAuditEntry,
  StoredAuthorityEnrollment,
  StoredAuthorityMembership,
  StoredAuthorityMetadata,
  StoredEnrollmentGrant,
  StoredInternalLiveRelease,
  StoredInternalLiveUpdateReceipt,
  StoredMemberExclusionSelector,
  StoredOidcIdentityBinding,
  StoredOidcLoginAttempt,
  StoredPersonLoginGrant,
  StoredPersonReadDecisionAudit,
  StoredPersonSessionCredential,
  StoredPersonSessionFamily,
  ReviewerQueryAuditEntry,
  ReadableSearchActiveGenerationPublication,
  ReadableSearchQueryAuditEntry,
  StoredReadableSearchActiveGeneration,
  StoredReadableSearchQueryAuditEntry,
  StoredReviewerQueryAuditEntry,
} from '../../../application/ports/authority-repository.js';
import {
  PERSON_READ_DECISION_AUDIT_RETENTION_DAYS,
  READABLE_SEARCH_QUERY_AUDIT_OPERATION,
  REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
  REVIEWER_QUERY_AUDIT_EXPORT_ACTION,
  REVIEWER_QUERY_AUDIT_OPERATION,
} from '../../../application/ports/authority-repository.js';
import {
  reviewerQueryAuditDecisionDetailJson,
  reviewerQueryAuditRetainUntil,
} from '../../../application/reviewer-query-audit.js';
import {
  readableSearchQueryAuditDetailJson,
  readableSearchQueryAuditRetainUntil,
  validateReadableSearchActiveGenerationPublication,
  validateStoredReadableSearchActiveGeneration,
  validateStoredReadableSearchQueryAuditEntry,
} from '../../../application/readable-search-persistence.js';
import { ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION } from '../../../application/organization-recording-policy-activation.js';
import { reviewerQueryAuditRowBySequence } from './reviewer-query-audit-rows.js';
import type { AuthorityAuditRow } from './reviewer-query-audit-rows.js';
import {
  openAuthorityDatabase,
  type OpenAuthorityDatabaseOptions,
} from './open-database.js';

interface MetadataRow {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: string;
  descriptor_json: string;
  created_at: string;
  last_observed_at: string;
}

interface MembershipRow {
  organization_id: string;
  principal_organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: string;
  status: string;
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  admin_command_id: string | null;
  admin_command_sha256: string | null;
}

interface GrantRow {
  grant_sha256: string;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  request_sha256: string | null;
  admin_command_id: string | null;
  admin_command_sha256: string | null;
}

type AuditRow = AuthorityAuditRow;

interface EnrollmentRow {
  enrollment_id: string;
  grant_sha256: string;
  request_sha256: string;
  request_json: string;
  receipt_sha256: string;
  receipt_json: string;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: string;
  installation_id: string;
  installation_key_id: string;
  installation_public_key_spki_der_base64: string;
  status: string;
  enrolled_at: string;
  revoked_at: string | null;
  revocation_kind: string | null;
  revocation_reason: string | null;
}

interface AccessStateRow {
  enrollment_id: string;
  access_state_sequence: number;
  state_sha256: string;
  state_json: string;
  status: string;
  evaluated_at: string;
  valid_until: string | null;
  revocation_reason: string | null;
}

interface AccessLeaseRequestRow {
  request_id: string;
  request_sha256: string;
  request_json: string;
  enrollment_id: string;
  previous_access_state_sha256: string;
  resulting_state_sha256: string;
  received_at: string;
}

interface InternalLiveReleaseRow {
  directive_sequence: number;
  command_id: string;
  command_sha256: string;
  manifest_url: string;
  manifest_sha256: string;
  manifest_json: string;
  release_version: string;
  release_tag: string;
  source_sha: string;
  artifact_sha256: string;
  approved_at: string;
}

interface InternalLiveUpdateReceiptRow {
  receipt_sequence: number;
  transaction_id: string;
  payload_sha256: string;
  receipt_json: string;
  installation_id: string;
  directive_sequence: number;
  outcome: string;
  finished_at: string;
  received_at: string;
}

interface ReadableSearchActiveGenerationRow {
  organization_id: string;
  generation_id: string;
  manifest_sha256: string;
  retrieval_contract_sha256: string;
  record_head_position: number;
  record_head_hash: string | null;
  published_at: string;
}

interface ReadableSearchQueryAuditRow {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  operation: string;
  decision: string;
  reason_code: string;
  detail_json: string;
}

interface OidcIdentityBindingRow {
  identity_binding_id: string;
  issuer: string;
  subject: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  initial_login_attempt_id: string;
  initial_login_grant_sha256: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: string;
  status: string;
  bound_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface OidcLoginAttemptRow {
  login_attempt_id: string;
  issuer: string;
  attempt_purpose: string;
  client_id: string;
  redirect_uri: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  login_grant_sha256: string | null;
  state_sha256: string;
  nonce_sha256: string;
  pkce_verifier_seal_key_id: string | null;
  pkce_verifier_sealed: Uint8Array | null;
  created_at: string;
  expires_at: string;
  redemption_claim_id: string | null;
  redemption_claimed_at: string | null;
  terminal_outcome: string | null;
  completed_at: string | null;
  resolved_identity_binding_id: string | null;
  upstream_assertion_issued_at: string | null;
}

interface PersonLoginGrantRow {
  login_grant_sha256: string;
  grant_purpose: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: string;
  expected_issuer: string;
  oidc_configuration_sha256: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface PersonSessionFamilyRow {
  session_family_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: string;
  identity_binding_id: string;
  authentication_login_attempt_id: string;
  created_at: string;
  upstream_assertion_issued_at: string;
  tenant_constraint_sha256: string;
  oidc_configuration_sha256: string;
  hard_reauthentication_at: string;
  status: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface PersonSessionCredentialRow {
  session_credential_id: string;
  session_family_id: string;
  credential_kind: string;
  rotation_sequence: number;
  token_sha256: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface PersonReadDecisionAuditRow {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  authority_id: string;
  organization_id: string;
  operation: string;
  request_sha256: string;
  response_sha256: string;
  asserted_subject_principal_id: string;
  decision: string;
  reason_code: string;
  authenticated_principal_id: string | null;
  authenticated_membership_id: string | null;
  authenticated_membership_type: string | null;
  identity_binding_id: string | null;
  session_family_id: string | null;
  access_credential_sha256: string | null;
  caller_binding_sha256: string | null;
  person_state_sha256: string | null;
  session_state_sha256: string | null;
}

interface PersistedAuthorityTrustContext {
  descriptor: OrganizationAuthorityDescriptorV1;
  pinned_authority: PinnedOrganizationAuthority;
  authority_pin_sha256: Sha256Digest;
  organization_display_name: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`authority database invariant: ${message}`);
}

function assertDigest(
  value: string,
  label: string,
): asserts value is Sha256Digest {
  invariant(/^sha256:[0-9a-f]{64}$/.test(value), `${label} is not a digest`);
}

function assertLocalUuid(
  value: string,
  prefix: 'oib' | 'ola' | 'olc' | 'psf' | 'psc',
  label: string,
): void {
  invariant(
    new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    ).test(value),
    `${label} is invalid`,
  );
}

function assertFederationUuid(
  value: string,
  prefix: 'oau' | 'org' | 'prn' | 'mem',
  label: string,
): void {
  invariant(
    new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    ).test(value),
    `${label} is invalid`,
  );
}

function personReadAuditRetainUntil(occurredAt: string): string {
  return new Date(
    timestampMillis(occurredAt, 'Person read decision audit time') +
      PERSON_READ_DECISION_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function personReadDecisionAuditFromRow(
  row: PersonReadDecisionAuditRow,
): StoredPersonReadDecisionAudit {
  invariant(
    Number.isSafeInteger(row.audit_sequence) && row.audit_sequence > 0,
    'Person read decision audit sequence is invalid',
  );
  timestampMillis(row.occurred_at, 'stored Person read decision audit time');
  invariant(
    row.retain_until === personReadAuditRetainUntil(row.occurred_at),
    'Person read decision audit retention is invalid',
  );
  assertFederationUuid(row.authority_id, 'oau', 'Person read audit authority');
  assertFederationUuid(
    row.organization_id,
    'org',
    'Person read audit organization',
  );
  invariant(
    row.operation === 'recent_decisions' ||
      row.operation === 'reviewer_recent_decisions' ||
      row.operation === 'readable_search',
    'Person read audit operation is invalid',
  );
  assertDigest(row.request_sha256, 'Person read audit request');
  assertDigest(row.response_sha256, 'Person read audit response');
  assertFederationUuid(
    row.asserted_subject_principal_id,
    'prn',
    'Person read audit asserted subject',
  );
  invariant(
    (row.decision === 'allow' &&
      row.reason_code === 'active_person_session') ||
      (row.decision === 'deny' &&
        (row.reason_code === 'person_or_session_inactive' ||
          row.reason_code === 'caller_subject_mismatch' ||
          row.reason_code === 'authorization_state_changed' ||
          row.reason_code === 'operation_not_permitted')),
    'Person read audit decision reason is invalid',
  );
  const authenticatedColumns = [
    row.authenticated_principal_id,
    row.authenticated_membership_id,
    row.authenticated_membership_type,
    row.identity_binding_id,
    row.session_family_id,
    row.access_credential_sha256,
    row.caller_binding_sha256,
    row.person_state_sha256,
    row.session_state_sha256,
  ];
  const allNull = authenticatedColumns.every((value) => value === null);
  const allPresent = authenticatedColumns.every((value) => value !== null);
  invariant(
    allNull || allPresent,
    'Person read audit authenticated evidence is partial',
  );
  if (allNull) {
    invariant(
      row.decision === 'deny' &&
        row.reason_code === 'person_or_session_inactive',
      'unauthenticated Person read audit reason is invalid',
    );
    return {
      audit_sequence: row.audit_sequence,
      occurred_at: row.occurred_at,
      retain_until: row.retain_until,
      authority_id: row.authority_id,
      organization_id: row.organization_id,
      operation: row.operation as PersonReadOperation,
      request_sha256: row.request_sha256 as Sha256Digest,
      response_sha256: row.response_sha256 as Sha256Digest,
      asserted_subject_principal_id: row.asserted_subject_principal_id,
      decision: 'deny',
      reason_code: 'person_or_session_inactive',
      authenticated: null,
    };
  }
  invariant(
    row.authenticated_principal_id !== null &&
      row.authenticated_membership_id !== null &&
      row.authenticated_membership_type !== null &&
      row.identity_binding_id !== null &&
      row.session_family_id !== null &&
      row.access_credential_sha256 !== null &&
      row.caller_binding_sha256 !== null &&
      row.person_state_sha256 !== null &&
      row.session_state_sha256 !== null,
    'Person read audit authenticated evidence is missing',
  );
  assertFederationUuid(
    row.authenticated_principal_id,
    'prn',
    'Person read audit authenticated principal',
  );
  assertFederationUuid(
    row.authenticated_membership_id,
    'mem',
    'Person read audit authenticated membership',
  );
  invariant(
    row.authenticated_membership_type === 'owner' ||
      row.authenticated_membership_type === 'employee',
    'Person read audit authenticated membership type is invalid',
  );
  assertLocalUuid(
    row.identity_binding_id,
    'oib',
    'Person read audit identity binding',
  );
  assertLocalUuid(
    row.session_family_id,
    'psf',
    'Person read audit session family',
  );
  assertDigest(
    row.access_credential_sha256,
    'Person read audit access credential',
  );
  assertDigest(row.caller_binding_sha256, 'Person read audit caller binding');
  assertDigest(row.person_state_sha256, 'Person read audit person state');
  assertDigest(row.session_state_sha256, 'Person read audit session state');
  invariant(
    row.reason_code === 'caller_subject_mismatch'
      ? row.asserted_subject_principal_id !== row.authenticated_principal_id
      : row.asserted_subject_principal_id === row.authenticated_principal_id,
    'Person read audit asserted subject relationship is invalid',
  );
  return {
    audit_sequence: row.audit_sequence,
    occurred_at: row.occurred_at,
    retain_until: row.retain_until,
    authority_id: row.authority_id,
    organization_id: row.organization_id,
    operation: row.operation as PersonReadOperation,
    request_sha256: row.request_sha256 as Sha256Digest,
    response_sha256: row.response_sha256 as Sha256Digest,
    asserted_subject_principal_id: row.asserted_subject_principal_id,
    decision: row.decision as 'allow' | 'deny',
    reason_code: row.reason_code as StoredPersonReadDecisionAudit['reason_code'],
    authenticated: {
      organization_id: row.organization_id,
      principal_id: row.authenticated_principal_id,
      membership_id: row.authenticated_membership_id,
      membership_type: row.authenticated_membership_type,
      identity_binding_id: row.identity_binding_id,
      session_family_id: row.session_family_id,
      access_credential_sha256:
        row.access_credential_sha256 as Sha256Digest,
      caller_binding_sha256: row.caller_binding_sha256 as Sha256Digest,
      person_state_sha256: row.person_state_sha256 as Sha256Digest,
      session_state_sha256: row.session_state_sha256 as Sha256Digest,
    },
  };
}

function assertBoundedText(value: string, maximum: number, label: string): void {
  invariant(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximum &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `${label} is invalid`,
  );
}

function assertOidcIssuer(value: string, label: string): void {
  assertBoundedText(value, 2048, label);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`authority database invariant: ${label} is invalid`);
  }
  invariant(
    parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.href === value,
    `${label} is not a canonical HTTPS issuer`,
  );
}

function assertRedirectUri(value: string): void {
  assertBoundedText(value, 4096, 'OIDC redirect URI');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('authority database invariant: OIDC redirect URI is invalid');
  }
  invariant(
    parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '' &&
      parsed.href === value,
    'OIDC redirect URI is not canonical HTTPS',
  );
}

function assertInterval(
  beginsAt: string,
  endsAt: string,
  beginsLabel: string,
  endsLabel: string,
): { begins: number; ends: number } {
  const begins = timestampMillis(beginsAt, beginsLabel);
  const ends = timestampMillis(endsAt, endsLabel);
  invariant(ends > begins, `${endsLabel} must follow ${beginsLabel}`);
  return { begins, ends };
}

function assertAdminCommandPair(
  commandId: string | null,
  commandSha256: string | null,
  label: string,
): asserts commandSha256 is Sha256Digest | null {
  invariant(
    (commandId === null) === (commandSha256 === null),
    `${label} admin command columns are inconsistent`,
  );
  if (commandId === null || commandSha256 === null) return;
  invariant(
    /^adm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      commandId,
    ),
    `${label} admin command ID is invalid`,
  );
  assertDigest(commandSha256, `${label} admin command`);
}

function parseStoredJson(value: string): unknown {
  const parsed = parseCanonicalJson(value);
  invariant(canonicalJson(parsed) === value, 'stored JSON is not canonical');
  return parsed;
}

function verifiedPersistedValue<T>(label: string, verify: () => T): T {
  try {
    return verify();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `authority database invariant: ${label} failed verification: ${detail}`,
    );
  }
}

/** The configured trust root, without the one-off initialization time. */
export type AuthorityTrustConfiguration = Omit<
  InitializeAuthorityRepositoryInput,
  'initialized_at'
>;

/**
 * The narrow, read-only view of Authority state that stopped-state maintenance
 * is allowed to hold.
 *
 * Handing out this instead of the transaction object keeps the whole online
 * write surface -- memberships, grants, enrollments, leases, releases, the
 * generic audit -- out of the maintenance module entirely.
 */
export interface AuthorityStateReader {
  metadata(): StoredAuthorityMetadata;
  membership(membershipId: string): StoredAuthorityMembership | undefined;
}

export function createAuthorityStateReader(
  database: Database.Database,
  trust: AuthorityTrustConfiguration,
): AuthorityStateReader {
  const transaction = new SqliteAuthorityTransaction(database);
  transaction.configureTrust(trust);
  return {
    metadata: () => transaction.metadata(),
    membership: (membershipId) => transaction.membership(membershipId),
  };
}

class SqliteAuthorityTransaction
  implements AuthorityReadTransaction, AuthorityWriteTransaction
{
  private trustContext: PersistedAuthorityTrustContext | undefined;
  private writeTime: string | undefined;

  constructor(private readonly database: Database.Database) {}

  /** The one final time of the write transaction currently in progress. */
  bindWriteTime(observedAt: string): void {
    this.writeTime = observedAt;
  }

  clearWriteTime(): void {
    this.writeTime = undefined;
  }

  private transactionTime(): string {
    invariant(
      this.writeTime !== undefined,
      'operation requires an open authority write transaction',
    );
    return this.writeTime;
  }

  configureTrust(input: AuthorityTrustConfiguration): void {
    const descriptor = validateOrganizationAuthorityDescriptor(
      input.descriptor,
    );
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      descriptor,
      input.authority_pin_sha256,
    );
    this.trustContext = {
      descriptor,
      pinned_authority: pinnedAuthority,
      authority_pin_sha256: input.authority_pin_sha256,
      organization_display_name: input.organization_display_name,
    };
  }

  private trust(): PersistedAuthorityTrustContext {
    invariant(
      this.trustContext !== undefined,
      'repository trust context is not initialized',
    );
    return this.trustContext;
  }

  metadata(): StoredAuthorityMetadata {
    const trust = this.trust();
    const row = this.database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name,
                authority_pin_sha256, descriptor_json, created_at,
                last_observed_at
         FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    invariant(row !== undefined, 'authority metadata is missing');
    assertDigest(row.authority_pin_sha256, 'authority pin');
    const createdAt = timestampMillis(
      row.created_at,
      'stored authority creation time',
    );
    const lastObservedAt = timestampMillis(
      row.last_observed_at,
      'stored authority clock watermark',
    );
    invariant(
      lastObservedAt >= createdAt,
      'authority clock watermark predates creation',
    );
    const descriptor = validateOrganizationAuthorityDescriptor(
      parseStoredJson(row.descriptor_json),
    );
    invariant(
      canonicalSha256(descriptor) === row.authority_pin_sha256,
      'authority pin differs from descriptor',
    );
    invariant(
      canonicalJson(descriptor) === canonicalJson(trust.descriptor) &&
        row.authority_pin_sha256 === trust.authority_pin_sha256 &&
        row.authority_id === descriptor.authority_id &&
        row.organization_id === descriptor.organization_id &&
        row.organization_display_name === trust.organization_display_name,
      'authority metadata differs from configured trust root',
    );
    return {
      authority_id: row.authority_id,
      organization_id: row.organization_id,
      organization_display_name: row.organization_display_name,
      authority_pin_sha256: row.authority_pin_sha256 as Sha256Digest,
      descriptor,
      created_at: row.created_at,
      last_observed_at: row.last_observed_at,
    };
  }

  private membershipFromRow(
    row: MembershipRow | undefined,
  ): StoredAuthorityMembership | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    invariant(
      row.membership_type === 'owner' || row.membership_type === 'employee',
      'membership type is invalid',
    );
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'membership status is invalid',
    );
    invariant(
      row.organization_id === trust.descriptor.organization_id &&
        row.principal_organization_id === row.organization_id,
      'membership organization differs from configured authority',
    );
    const provisionedAt = timestampMillis(
      row.provisioned_at,
      'stored membership provisioning time',
    );
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(row.revoked_at, 'stored membership revocation time') >=
          provisionedAt,
        'membership revocation predates provisioning',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_reason !== null),
      'membership status columns are inconsistent',
    );
    assertAdminCommandPair(
      row.admin_command_id,
      row.admin_command_sha256,
      'membership',
    );
    return {
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      display_name: row.display_name,
      membership_type: row.membership_type as OrganizationMembershipTypeV1,
      status: row.status,
      provisioned_at: row.provisioned_at,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
      admin_command_id: row.admin_command_id,
      admin_command_sha256: row.admin_command_sha256,
    };
  }

  private membershipWhere(
    column: 'm.membership_id' | 'm.admin_command_id',
    value: string,
  ): StoredAuthorityMembership | undefined {
    const row = this.database
      .prepare(
        `SELECT m.organization_id, p.organization_id AS principal_organization_id,
                m.principal_id, m.membership_id,
                p.display_name, m.membership_type, m.status,
                m.provisioned_at, m.revoked_at, m.revocation_reason,
                m.admin_command_id, m.admin_command_sha256
         FROM authority_memberships m
         JOIN authority_principals p ON p.principal_id = m.principal_id
         WHERE ${column} = ?`,
      )
      .get(value) as MembershipRow | undefined;
    return this.membershipFromRow(row);
  }

  membership(membershipId: string): StoredAuthorityMembership | undefined {
    return this.membershipWhere('m.membership_id', membershipId);
  }

  membershipByAdminCommand(
    commandId: string,
  ): StoredAuthorityMembership | undefined {
    return this.membershipWhere('m.admin_command_id', commandId);
  }

  membershipsAfter(
    membershipId: string | undefined,
    limit: number,
  ): StoredAuthorityMembership[] {
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 101,
      'membership page limit is invalid',
    );
    const rows = this.database
      .prepare(
        `SELECT m.organization_id, p.organization_id AS principal_organization_id,
                m.principal_id, m.membership_id,
                p.display_name, m.membership_type, m.status,
                m.provisioned_at, m.revoked_at, m.revocation_reason,
                m.admin_command_id, m.admin_command_sha256
         FROM authority_memberships m
         JOIN authority_principals p ON p.principal_id = m.principal_id
         WHERE (? IS NULL OR m.membership_id > ?)
         ORDER BY m.membership_id
         LIMIT ?`,
      )
      .all(
        membershipId ?? null,
        membershipId ?? null,
        limit,
      ) as MembershipRow[];
    return rows.map((row) => {
      const membership = this.membershipFromRow(row);
      invariant(membership !== undefined, 'membership row disappeared');
      return membership;
    });
  }

  private grantFromRow(
    row: GrantRow | undefined,
  ): StoredEnrollmentGrant | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    assertDigest(row.grant_sha256, 'enrollment grant');
    if (row.request_sha256 !== null) {
      assertDigest(row.request_sha256, 'enrollment request');
    }
    invariant(
      row.authority_id === trust.descriptor.authority_id &&
        row.organization_id === trust.descriptor.organization_id,
      'enrollment grant differs from configured authority',
    );
    const issuedAt = timestampMillis(
      row.issued_at,
      'stored enrollment grant issue time',
    );
    const expiresAt = timestampMillis(
      row.expires_at,
      'stored enrollment grant expiry time',
    );
    invariant(expiresAt > issuedAt, 'enrollment grant has an empty lifetime');
    if (row.consumed_at !== null) {
      const consumedAt = timestampMillis(
        row.consumed_at,
        'stored enrollment grant consumption time',
      );
      invariant(
        consumedAt >= issuedAt && consumedAt < expiresAt,
        'enrollment grant consumption is outside its lifetime',
      );
    }
    invariant(
      (row.consumed_at === null && row.request_sha256 === null) ||
        (row.consumed_at !== null && row.request_sha256 !== null),
      'enrollment grant consumption columns are inconsistent',
    );
    assertAdminCommandPair(
      row.admin_command_id,
      row.admin_command_sha256,
      'enrollment grant',
    );
    const membership = this.membership(row.membership_id);
    invariant(
      membership !== undefined &&
        membership.organization_id === row.organization_id &&
        membership.principal_id === row.principal_id,
      'enrollment grant differs from its membership',
    );
    return {
      ...row,
      grant_sha256: row.grant_sha256 as Sha256Digest,
      request_sha256: row.request_sha256 as Sha256Digest | null,
      admin_command_sha256: row.admin_command_sha256,
    };
  }

  private grantWhere(
    column: 'grant_sha256' | 'admin_command_id',
    value: string,
  ): StoredEnrollmentGrant | undefined {
    const row = this.database
      .prepare(
        `SELECT grant_sha256, authority_id, organization_id, principal_id,
                membership_id, issued_at, expires_at, consumed_at,
                request_sha256, admin_command_id, admin_command_sha256
         FROM authority_enrollment_grants WHERE ${column} = ?`,
      )
      .get(value) as GrantRow | undefined;
    return this.grantFromRow(row);
  }

  grant(grantSha256: Sha256Digest): StoredEnrollmentGrant | undefined {
    return this.grantWhere('grant_sha256', grantSha256);
  }

  grantByAdminCommand(commandId: string): StoredEnrollmentGrant | undefined {
    return this.grantWhere('admin_command_id', commandId);
  }

  grantsAfter(
    grantSha256: Sha256Digest | undefined,
    limit: number,
  ): StoredEnrollmentGrant[] {
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 101,
      'enrollment grant page limit is invalid',
    );
    const rows = this.database
      .prepare(
        `SELECT grant_sha256, authority_id, organization_id, principal_id,
                membership_id, issued_at, expires_at, consumed_at,
                request_sha256, admin_command_id, admin_command_sha256
         FROM authority_enrollment_grants
         WHERE (? IS NULL OR grant_sha256 > ?)
         ORDER BY grant_sha256
         LIMIT ?`,
      )
      .all(grantSha256 ?? null, grantSha256 ?? null, limit) as GrantRow[];
    return rows.map((row) => {
      const grant = this.grantFromRow(row);
      invariant(grant !== undefined, 'enrollment grant row disappeared');
      return grant;
    });
  }

  private enrollmentFromRow(
    row: EnrollmentRow | undefined,
  ): StoredAuthorityEnrollment | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    invariant(
      row.membership_type === 'owner' || row.membership_type === 'employee',
      'enrollment membership type is invalid',
    );
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'enrollment status is invalid',
    );
    invariant(
      row.revocation_kind === null ||
        row.revocation_kind === 'membership_revoked' ||
        row.revocation_kind === 'installation_revoked',
      'enrollment revocation kind is invalid',
    );
    const request = verifiedPersistedValue('enrollment request', () =>
      verifyOrganizationEnrollmentRequest(
        parseStoredJson(row.request_json),
        trust.pinned_authority,
      ),
    );
    const receipt = verifiedPersistedValue('enrollment receipt', () =>
      verifyOrganizationEnrollmentReceipt(
        parseStoredJson(row.receipt_json),
        trust.pinned_authority,
        request,
      ),
    );
    assertDigest(row.grant_sha256, 'stored enrollment grant');
    assertDigest(row.request_sha256, 'stored enrollment request');
    assertDigest(row.receipt_sha256, 'stored enrollment receipt');
    const requestSha256 = canonicalSha256(request);
    const receiptSha256 = canonicalSha256(receipt);
    invariant(
      requestSha256 === row.request_sha256 &&
        receiptSha256 === row.receipt_sha256 &&
        receipt.request_sha256 === requestSha256 &&
        request.enrollment_grant_sha256 === row.grant_sha256,
      'enrollment document digests differ from columns',
    );
    invariant(
      row.authority_id === trust.descriptor.authority_id &&
        row.organization_id === trust.descriptor.organization_id &&
        row.authority_id === request.authority_id &&
        row.authority_id === receipt.authority_id &&
        row.organization_id === request.organization_id &&
        row.organization_id === receipt.organization_id &&
        row.enrollment_id === receipt.enrollment_id &&
        row.principal_id === request.principal_id &&
        row.principal_id === receipt.principal_id &&
        row.membership_id === request.membership_id &&
        row.membership_id === receipt.membership_id &&
        row.membership_type === receipt.membership_type &&
        row.installation_id === request.installation_id &&
        row.installation_id === receipt.installation_id &&
        row.installation_key_id === request.installation_signing_key.key_id &&
        row.installation_key_id === receipt.installation_key_id &&
        row.installation_public_key_spki_der_base64 ===
          request.installation_signing_key.public_key_spki_der_base64 &&
        row.enrolled_at === receipt.enrolled_at,
      'enrollment columns differ from authenticated documents',
    );
    const enrolledAt = timestampMillis(
      row.enrolled_at,
      'stored enrollment time',
    );
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(row.revoked_at, 'stored enrollment revocation time') >=
          enrolledAt,
        'enrollment revocation predates enrollment',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_kind === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_kind !== null &&
          row.revocation_reason !== null),
      'enrollment status columns are inconsistent',
    );
    const membership = this.membership(row.membership_id);
    invariant(
      membership !== undefined &&
        membership.organization_id === row.organization_id &&
        membership.principal_id === row.principal_id &&
        membership.membership_type === row.membership_type,
      'enrollment differs from its membership',
    );
    invariant(
      row.status !== 'active' || membership.status === 'active',
      'active enrollment belongs to a revoked membership',
    );
    invariant(
      row.revocation_kind !== 'membership_revoked' ||
        membership.status === 'revoked',
      'membership-revoked enrollment belongs to an active membership',
    );
    const grant = this.grant(row.grant_sha256 as Sha256Digest);
    invariant(
      grant !== undefined &&
        grant.consumed_at !== null &&
        grant.request_sha256 === row.request_sha256 &&
        grant.authority_id === row.authority_id &&
        grant.organization_id === row.organization_id &&
        grant.principal_id === row.principal_id &&
        grant.membership_id === row.membership_id &&
        timestampMillis(grant.issued_at, 'stored grant issue time') <=
          enrolledAt &&
        enrolledAt <
          timestampMillis(grant.expires_at, 'stored grant expiry time') &&
        timestampMillis(grant.consumed_at, 'stored grant consumption time') >=
          enrolledAt,
      'enrollment differs from its consumed grant',
    );
    return {
      enrollment_id: row.enrollment_id,
      grant_sha256: row.grant_sha256 as Sha256Digest,
      request_sha256: row.request_sha256 as Sha256Digest,
      request,
      receipt_sha256: row.receipt_sha256 as Sha256Digest,
      receipt,
      authority_id: row.authority_id,
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      membership_type: row.membership_type,
      installation_id: row.installation_id,
      installation_signing_key: request.installation_signing_key,
      status: row.status,
      enrolled_at: row.enrolled_at,
      revoked_at: row.revoked_at,
      revocation_kind: row.revocation_kind,
      revocation_reason: row.revocation_reason,
    };
  }

  private enrollmentWhere(
    clause: string,
    value: string,
  ): StoredAuthorityEnrollment | undefined {
    const row = this.database
      .prepare(`SELECT * FROM authority_enrollments WHERE ${clause} = ?`)
      .get(value) as EnrollmentRow | undefined;
    return this.enrollmentFromRow(row);
  }

  enrollmentByGrant(
    grantSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('grant_sha256', grantSha256);
  }

  enrollmentByRequest(
    requestSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('request_sha256', requestSha256);
  }

  enrollmentById(enrollmentId: string): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('enrollment_id', enrollmentId);
  }

  enrollmentByInstallation(
    installationId: string,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('installation_id', installationId);
  }

  enrollmentByKey(keyId: Sha256Digest): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('installation_key_id', keyId);
  }

  enrollmentsForMembership(membershipId: string): StoredAuthorityEnrollment[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM authority_enrollments
         WHERE membership_id = ? ORDER BY enrollment_id`,
      )
      .all(membershipId) as EnrollmentRow[];
    return rows.map((row) => {
      const enrollment = this.enrollmentFromRow(row);
      invariant(enrollment !== undefined, 'enrollment row disappeared');
      return enrollment;
    });
  }

  enrollmentsAfter(
    enrollmentId: string | undefined,
    limit: number,
  ): StoredAuthorityEnrollment[] {
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 101,
      'installation page limit is invalid',
    );
    const rows = this.database
      .prepare(
        `SELECT * FROM authority_enrollments
         WHERE (? IS NULL OR enrollment_id > ?)
         ORDER BY enrollment_id
         LIMIT ?`,
      )
      .all(
        enrollmentId ?? null,
        enrollmentId ?? null,
        limit,
      ) as EnrollmentRow[];
    return rows.map((row) => {
      const enrollment = this.enrollmentFromRow(row);
      invariant(enrollment !== undefined, 'enrollment row disappeared');
      return enrollment;
    });
  }

  activeEnrollments(limit: number): StoredAuthorityEnrollment[] {
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 101,
      'active installation limit is invalid',
    );
    const rows = this.database
      .prepare(
        `SELECT * FROM authority_enrollments
         WHERE status = 'active'
         ORDER BY enrollment_id
         LIMIT ?`,
      )
      .all(limit) as EnrollmentRow[];
    return rows.map((row) => {
      const enrollment = this.enrollmentFromRow(row);
      invariant(enrollment !== undefined, 'active enrollment row disappeared');
      return enrollment;
    });
  }

  private validateAccessStateRow(
    row: AccessStateRow,
    enrollment: StoredAuthorityEnrollment,
  ): OrganizationInstallationAccessStateV1 {
    const state = validateOrganizationInstallationAccessState(
      parseStoredJson(row.state_json),
    );
    assertDigest(row.state_sha256, 'stored access state');
    invariant(
      row.enrollment_id === enrollment.enrollment_id &&
        state.enrollment_id === row.enrollment_id &&
        state.access_state_sequence === row.access_state_sequence &&
        state.status === row.status &&
        state.evaluated_at === row.evaluated_at &&
        state.valid_until === row.valid_until &&
        state.revocation_reason === row.revocation_reason,
      'access state columns differ from document',
    );
    invariant(
      canonicalSha256(state) === row.state_sha256,
      'access state digest differs from document',
    );
    return state;
  }

  private accessStateFromRow(
    row: AccessStateRow | undefined,
  ): StoredAuthorityAccessState | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    const enrollment = this.enrollmentById(row.enrollment_id);
    invariant(
      enrollment !== undefined,
      'access state enrollment is missing or invalid',
    );
    const state = this.validateAccessStateRow(row, enrollment);
    let previous: OrganizationInstallationAccessStateV1 | null = null;
    // Authenticate the replay target and its direct transition in O(1).
    // The schema trigger owns contiguous insertion and terminality, so replay
    // cost does not grow with years of lease history.
    if (row.access_state_sequence > 1) {
      const previousRow = this.database
        .prepare(
          `SELECT * FROM authority_access_states
           WHERE enrollment_id = ? AND access_state_sequence = ?`,
        )
        .get(row.enrollment_id, row.access_state_sequence - 1) as
        AccessStateRow | undefined;
      invariant(
        previousRow !== undefined,
        'access state immediate predecessor is missing',
      );
      previous = this.validateAccessStateRow(previousRow, enrollment);
      invariant(
        previous.access_state_sequence + 1 === state.access_state_sequence,
        'access state does not immediately follow its predecessor',
      );
      if (previous.status === 'active') {
        invariant(
          timestampMillis(
            previous.valid_until,
            'stored predecessor access state expiry',
          ) -
            timestampMillis(
              previous.evaluated_at,
              'stored predecessor access state evaluation time',
            ) <=
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
          'predecessor access lease exceeds the historical maximum TTL',
        );
      }
    }
    const decision = verifiedPersistedValue(
      `access state sequence ${row.access_state_sequence}`,
      () =>
        verifyOrganizationInstallationAccessState({
          state,
          pinned_authority: trust.pinned_authority,
          enrollment_request: enrollment.request,
          enrollment_receipt: enrollment.receipt,
          now: state.evaluated_at,
          maximum_active_ttl_ms:
            MAX_ORGANIZATION_ACCESS_LEASE_REQUEST_TTL_MS,
          previous_state: previous,
        }),
    );
    const target: StoredAuthorityAccessState = {
      enrollment_id: row.enrollment_id,
      state_sha256: row.state_sha256 as Sha256Digest,
      state: decision.state,
    };

    const latest = this.database
      .prepare(
        `SELECT MAX(access_state_sequence) AS access_state_sequence
         FROM authority_access_states WHERE enrollment_id = ?`,
      )
      .get(row.enrollment_id) as { access_state_sequence: number | null };
    invariant(
      latest.access_state_sequence !== null,
      'access state high watermark is missing',
    );
    if (latest.access_state_sequence === target.state.access_state_sequence) {
      invariant(
        target.state.status === enrollment.status,
        'current access state differs from enrollment status',
      );
      if (target.state.status === 'revoked') {
        invariant(
          target.state.revocation_reason === enrollment.revocation_kind &&
            enrollment.revoked_at !== null &&
            timestampMillis(
              target.state.evaluated_at,
              'stored terminal access state evaluation time',
            ) <=
              timestampMillis(
                enrollment.revoked_at,
                'stored enrollment revocation time',
              ),
          'terminal access state differs from enrollment revocation',
        );
      }
    }
    return target;
  }

  currentAccessState(
    enrollmentId: string,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_states
         WHERE enrollment_id = ?
         ORDER BY access_state_sequence DESC LIMIT 1`,
      )
      .get(enrollmentId) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  accessState(
    enrollmentId: string,
    accessStateSequence: number,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_states
         WHERE enrollment_id = ? AND access_state_sequence = ?`,
      )
      .get(enrollmentId, accessStateSequence) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  accessStateByDigest(
    stateSha256: Sha256Digest,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare('SELECT * FROM authority_access_states WHERE state_sha256 = ?')
      .get(stateSha256) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  private internalLiveReleaseFromRow(
    row: InternalLiveReleaseRow | undefined,
  ): StoredInternalLiveRelease | undefined {
    if (row === undefined) return undefined;
    invariant(
      Number.isSafeInteger(row.directive_sequence) &&
        row.directive_sequence > 0,
      'internal-live directive sequence is invalid',
    );
    assertDigest(row.command_sha256, 'internal-live approval command');
    invariant(
      /^[0-9a-f]{64}$/.test(row.manifest_sha256) &&
        /^[0-9a-f]{64}$/.test(row.artifact_sha256) &&
        /^[0-9a-f]{40}$/.test(row.source_sha),
      'internal-live release digests are invalid',
    );
    timestampMillis(row.approved_at, 'internal-live approval time');
    const manifest = verifiedPersistedValue('internal-live release manifest', () =>
      validateOrganizationInternalLiveReleaseManifest(
        parseStoredJson(row.manifest_json),
      ),
    );
    invariant(
      organizationInternalLiveManifestSha256(manifest) ===
          row.manifest_sha256 &&
        manifest.release_version === row.release_version &&
        manifest.release_tag === row.release_tag &&
        manifest.source.sha === row.source_sha &&
        manifest.artifact.sha256 === row.artifact_sha256 &&
        row.manifest_url ===
          `https://github.com/${manifest.build.repository}/releases/download/${encodeURIComponent(manifest.release_tag)}/internal-live-release-manifest.v1.json`,
      'internal-live release columns differ from its manifest',
    );
    return {
      directive_sequence: row.directive_sequence,
      command_id: row.command_id,
      command_sha256: row.command_sha256 as Sha256Digest,
      manifest_url: row.manifest_url,
      manifest_sha256: row.manifest_sha256,
      manifest,
      release_version: row.release_version,
      release_tag: row.release_tag,
      source_sha: row.source_sha,
      artifact_sha256: row.artifact_sha256,
      approved_at: row.approved_at,
    };
  }

  internalLiveReleaseByCommand(
    commandId: string,
  ): StoredInternalLiveRelease | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_internal_live_releases
         WHERE command_id = ?`,
      )
      .get(commandId) as InternalLiveReleaseRow | undefined;
    return this.internalLiveReleaseFromRow(row);
  }

  internalLiveReleaseBySequence(
    directiveSequence: number,
  ): StoredInternalLiveRelease | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_internal_live_releases
         WHERE directive_sequence = ?`,
      )
      .get(directiveSequence) as InternalLiveReleaseRow | undefined;
    return this.internalLiveReleaseFromRow(row);
  }

  currentInternalLiveRelease(): StoredInternalLiveRelease | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_internal_live_releases
         ORDER BY directive_sequence DESC LIMIT 1`,
      )
      .get() as InternalLiveReleaseRow | undefined;
    return this.internalLiveReleaseFromRow(row);
  }

  private internalLiveReceiptFromRow(
    row: InternalLiveUpdateReceiptRow | undefined,
  ): StoredInternalLiveUpdateReceipt | undefined {
    if (row === undefined) return undefined;
    invariant(
      Number.isSafeInteger(row.receipt_sequence) && row.receipt_sequence > 0,
      'internal-live receipt sequence is invalid',
    );
    assertDigest(row.payload_sha256, 'internal-live update receipt payload');
    timestampMillis(row.received_at, 'internal-live receipt received time');
    const enrollment = this.enrollmentByInstallation(row.installation_id);
    invariant(
      enrollment !== undefined,
      'internal-live receipt enrollment is missing or invalid',
    );
    const receipt = verifiedPersistedValue('internal-live update receipt', () =>
      verifyOrganizationInternalLiveUpdateReceipt(
        parseStoredJson(row.receipt_json),
        enrollment.installation_signing_key,
      ),
    );
    invariant(
      receipt.integrity.payload_sha256 === row.payload_sha256 &&
        receipt.transaction_id === row.transaction_id &&
        receipt.enrollment_id === enrollment.enrollment_id &&
        receipt.installation_id === row.installation_id &&
        receipt.directive_sequence === row.directive_sequence &&
        receipt.outcome === row.outcome &&
        receipt.finished_at === row.finished_at,
      'internal-live receipt columns differ from its authenticated document',
    );
    return {
      receipt_sequence: row.receipt_sequence,
      payload_sha256: row.payload_sha256 as Sha256Digest,
      receipt,
      received_at: row.received_at,
    };
  }

  internalLiveUpdateReceiptByTransaction(
    transactionId: string,
  ): StoredInternalLiveUpdateReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_internal_live_update_receipts
         WHERE transaction_id = ?`,
      )
      .get(transactionId) as InternalLiveUpdateReceiptRow | undefined;
    return this.internalLiveReceiptFromRow(row);
  }

  latestInternalLiveUpdateReceipt(
    installationId: string,
    directiveSequence: number,
  ): StoredInternalLiveUpdateReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_internal_live_update_receipts
         WHERE installation_id = ? AND directive_sequence = ?
         ORDER BY receipt_sequence DESC LIMIT 1`,
      )
      .get(
        installationId,
        directiveSequence,
      ) as InternalLiveUpdateReceiptRow | undefined;
    return this.internalLiveReceiptFromRow(row);
  }

  private leaseRequestFromRow(
    row: AccessLeaseRequestRow | undefined,
  ): StoredAccessLeaseRequest | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    assertDigest(row.request_sha256, 'stored access request');
    assertDigest(
      row.previous_access_state_sha256,
      'stored previous access state',
    );
    assertDigest(row.resulting_state_sha256, 'stored resulting access state');
    const enrollment = this.enrollmentById(row.enrollment_id);
    invariant(
      enrollment !== undefined,
      'access request enrollment is missing or invalid',
    );
    const request = verifiedPersistedValue('access lease request', () =>
      verifyOrganizationAccessLeaseRequestAnyVersion(
        parseStoredJson(row.request_json),
        enrollment.installation_signing_key,
      ),
    );
    invariant(
      canonicalSha256(request) === row.request_sha256,
      'access request digest differs from document',
    );
    invariant(
      row.request_id === request.request_id &&
        row.enrollment_id === request.enrollment_id &&
        row.previous_access_state_sha256 ===
          request.previous_access_state_sha256 &&
        request.authority_id === trust.descriptor.authority_id &&
        request.authority_key_id === trust.descriptor.signing_key.key_id &&
        request.organization_id === trust.descriptor.organization_id &&
        request.enrollment_id === enrollment.enrollment_id &&
        request.installation_id === enrollment.installation_id &&
        request.installation_key_id ===
          enrollment.installation_signing_key.key_id,
      'access request columns or coordinates differ from authenticated document',
    );
    const receivedAt = timestampMillis(
      row.received_at,
      'stored access request receipt time',
    );
    const previous = this.accessStateByDigest(
      row.previous_access_state_sha256 as Sha256Digest,
    );
    const resulting = this.accessStateByDigest(
      row.resulting_state_sha256 as Sha256Digest,
    );
    invariant(
      previous !== undefined &&
        resulting !== undefined &&
        previous.enrollment_id === enrollment.enrollment_id &&
        resulting.enrollment_id === enrollment.enrollment_id,
      'access request state pointers differ from its enrollment',
    );
    invariant(
      resulting.state.access_state_sequence >=
        previous.state.access_state_sequence &&
        (resulting.state.status === 'revoked' ||
          resulting.state.access_state_sequence ===
            previous.state.access_state_sequence + 1),
      'access request result is not a valid successor',
    );
    if (resulting.state.status === 'active') {
      const resultingLeaseTtlMs =
        timestampMillis(
          resulting.state.valid_until,
          'stored access request active result expiry',
        ) -
        timestampMillis(
          resulting.state.evaluated_at,
          'stored access request active result evaluation time',
        );
      const requestLeaseTtlBoundMs =
        request.schema_version === 2
          ? request.requested_active_lease_ttl_ms
          : MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS;
      invariant(
        resultingLeaseTtlMs <= requestLeaseTtlBoundMs,
        'access request active result exceeds its versioned TTL bound',
      );
    }
    invariant(
      timestampMillis(
        resulting.state.evaluated_at,
        'stored access request result evaluation time',
      ) <= receivedAt,
      'access request result postdates its committed receipt',
    );
    return {
      request_id: row.request_id,
      request_sha256: row.request_sha256 as Sha256Digest,
      request,
      enrollment_id: row.enrollment_id,
      previous_access_state_sha256:
        row.previous_access_state_sha256 as Sha256Digest,
      resulting_state_sha256: row.resulting_state_sha256 as Sha256Digest,
      received_at: row.received_at,
    };
  }

  accessLeaseRequestByDigest(
    requestSha256: Sha256Digest,
  ): StoredAccessLeaseRequest | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM authority_access_lease_requests WHERE request_sha256 = ?',
      )
      .get(requestSha256) as AccessLeaseRequestRow | undefined;
    return this.leaseRequestFromRow(row);
  }

  accessLeaseRequestById(
    enrollmentId: string,
    requestId: string,
  ): StoredAccessLeaseRequest | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_lease_requests
         WHERE enrollment_id = ? AND request_id = ?`,
      )
      .get(enrollmentId, requestId) as AccessLeaseRequestRow | undefined;
    return this.leaseRequestFromRow(row);
  }

  recentAuditBefore(
    auditSequence: number | undefined,
    limit: number,
  ): StoredAuthorityAuditEntry[] {
    invariant(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 101,
      'audit page limit is invalid',
    );
    if (auditSequence !== undefined) {
      invariant(
        Number.isSafeInteger(auditSequence) && auditSequence > 0,
        'audit cursor is invalid',
      );
    }
    const rows = this.database
      .prepare(
        `SELECT audit_sequence, occurred_at, actor_kind, action, subject_id,
                detail_json
         FROM authority_audit_log
         WHERE (? IS NULL OR audit_sequence < ?)
         ORDER BY audit_sequence DESC
         LIMIT ?`,
      )
      .all(auditSequence ?? null, auditSequence ?? null, limit) as AuditRow[];
    return rows.map((row) => {
      invariant(
        Number.isSafeInteger(row.audit_sequence) && row.audit_sequence > 0,
        'audit sequence is invalid',
      );
      timestampMillis(row.occurred_at, 'stored audit time');
      invariant(
        row.actor_kind === 'admin' ||
          row.actor_kind === 'enrollment_grant' ||
          row.actor_kind === 'installation',
        'audit actor kind is invalid',
      );
      invariant(
        row.action.length > 0 &&
          row.action.length <= 200 &&
          row.subject_id.length > 0 &&
          row.subject_id.length <= 200,
        'audit labels are invalid',
      );
      return {
        audit_sequence: row.audit_sequence,
        occurred_at: row.occurred_at,
        actor_kind: row.actor_kind,
        action: row.action,
        subject_id: row.subject_id,
        detail: parseStoredJson(row.detail_json) as never,
      };
    });
  }

  adminCounts(now: string): AuthorityAdminCounts {
    timestampMillis(now, 'admin overview time');
    const row = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM authority_memberships) AS memberships,
           (SELECT COUNT(*) FROM authority_memberships WHERE status = 'active') AS active_memberships,
           (SELECT COUNT(*) FROM authority_memberships WHERE status = 'revoked') AS revoked_memberships,
           (SELECT COUNT(*) FROM authority_enrollments) AS installations,
           (SELECT COUNT(*) FROM authority_enrollments WHERE status = 'active') AS active_installations,
           (SELECT COUNT(*) FROM authority_enrollments WHERE status = 'revoked') AS revoked_installations,
           (SELECT COUNT(*) FROM authority_enrollment_grants) AS enrollment_grants,
           (SELECT COUNT(*) FROM authority_enrollment_grants
             WHERE consumed_at IS NULL AND expires_at > ?) AS pending_enrollment_grants,
           (SELECT COUNT(*) FROM authority_enrollment_grants
             WHERE consumed_at IS NOT NULL) AS consumed_enrollment_grants,
           (SELECT COUNT(*) FROM authority_enrollment_grants
             WHERE consumed_at IS NULL AND expires_at <= ?) AS expired_enrollment_grants,
           (SELECT COUNT(*) FROM authority_audit_log) AS audit_entries`,
      )
      .get(now, now) as AuthorityAdminCounts;
    for (const value of Object.values(row)) {
      invariant(
        Number.isSafeInteger(value) && value >= 0,
        'admin overview count is invalid',
      );
    }
    invariant(
      row.memberships === row.active_memberships + row.revoked_memberships &&
        row.installations ===
          row.active_installations + row.revoked_installations &&
        row.enrollment_grants ===
          row.pending_enrollment_grants +
            row.consumed_enrollment_grants +
            row.expired_enrollment_grants,
      'admin overview counts are inconsistent',
    );
    return { ...row };
  }

  private assertExactPersonMembership(
    row: {
      organization_id: string;
      principal_id: string;
      membership_id: string;
      membership_type: string;
    },
    label: string,
  ): void {
    invariant(
      row.membership_type === 'owner' || row.membership_type === 'employee',
      `${label} membership type is invalid`,
    );
    const membership = this.membership(row.membership_id);
    invariant(
      membership !== undefined &&
        membership.organization_id === row.organization_id &&
        membership.principal_id === row.principal_id &&
        membership.membership_type === row.membership_type &&
        row.organization_id === this.trust().descriptor.organization_id,
      `${label} differs from its exact Authority membership`,
    );
  }

  private oidcIdentityBindingFromRow(
    row: OidcIdentityBindingRow | undefined,
  ): StoredOidcIdentityBinding | undefined {
    if (row === undefined) return undefined;
    assertLocalUuid(row.identity_binding_id, 'oib', 'OIDC identity binding ID');
    assertOidcIssuer(row.issuer, 'OIDC identity issuer');
    assertBoundedText(row.subject, 1024, 'OIDC identity subject');
    assertDigest(row.tenant_constraint_sha256, 'OIDC tenant constraint');
    assertDigest(row.oidc_configuration_sha256, 'OIDC configuration');
    assertLocalUuid(
      row.initial_login_attempt_id,
      'ola',
      'initial OIDC login attempt ID',
    );
    assertDigest(row.initial_login_grant_sha256, 'initial person login grant');
    this.assertExactPersonMembership(row, 'OIDC identity binding');
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'OIDC identity binding status is invalid',
    );
    const boundAt = timestampMillis(row.bound_at, 'stored OIDC binding time');
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(row.revoked_at, 'stored OIDC binding revocation time') >=
          boundAt,
        'OIDC identity binding revocation predates binding',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_reason !== null),
      'OIDC identity binding status columns are inconsistent',
    );
    const grant = this.personLoginGrant(row.initial_login_grant_sha256 as Sha256Digest);
    invariant(
      grant !== undefined &&
        grant.consumed_at === row.bound_at &&
        grant.expected_issuer === row.issuer &&
        grant.oidc_configuration_sha256 === row.oidc_configuration_sha256 &&
        grant.organization_id === row.organization_id &&
        grant.principal_id === row.principal_id &&
        grant.membership_id === row.membership_id &&
        grant.membership_type === row.membership_type,
      'OIDC identity binding differs from its consumed bootstrap grant',
    );
    const attempt = this.oidcLoginAttemptById(row.initial_login_attempt_id);
    invariant(
      attempt !== undefined &&
        attempt.attempt_purpose === 'identity_bootstrap' &&
        attempt.terminal_outcome === 'succeeded' &&
        attempt.completed_at === row.bound_at &&
        attempt.resolved_identity_binding_id === row.identity_binding_id &&
        attempt.login_grant_sha256 === row.initial_login_grant_sha256 &&
        attempt.issuer === row.issuer &&
        attempt.tenant_constraint_sha256 === row.tenant_constraint_sha256 &&
        attempt.oidc_configuration_sha256 ===
          row.oidc_configuration_sha256,
      'OIDC identity binding differs from its successful bootstrap attempt',
    );
    return {
      ...row,
      membership_type: row.membership_type as OrganizationMembershipTypeV1,
      tenant_constraint_sha256: row.tenant_constraint_sha256 as Sha256Digest,
      oidc_configuration_sha256:
        row.oidc_configuration_sha256 as Sha256Digest,
      initial_login_grant_sha256:
        row.initial_login_grant_sha256 as Sha256Digest,
      status: row.status as 'active' | 'revoked',
    };
  }

  private oidcIdentityBindingWhere(
    where: 'identity_binding_id = ?' | 'issuer = ? AND subject = ?',
    values: readonly string[],
  ): StoredOidcIdentityBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT identity_binding_id, issuer, subject,
                tenant_constraint_sha256, oidc_configuration_sha256,
                initial_login_attempt_id, initial_login_grant_sha256,
                organization_id, principal_id, membership_id, membership_type,
                status, bound_at, revoked_at, revocation_reason
           FROM authority_oidc_identity_bindings WHERE ${where}`,
      )
      .get(...values) as OidcIdentityBindingRow | undefined;
    return this.oidcIdentityBindingFromRow(row);
  }

  oidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined {
    return this.oidcIdentityBindingWhere('issuer = ? AND subject = ?', [
      issuer,
      subject,
    ]);
  }

  oidcIdentityBindingById(
    identityBindingId: string,
  ): StoredOidcIdentityBinding | undefined {
    return this.oidcIdentityBindingWhere('identity_binding_id = ?', [
      identityBindingId,
    ]);
  }

  private oidcLoginAttemptFromRow(
    row: OidcLoginAttemptRow | undefined,
  ): StoredOidcLoginAttempt | undefined {
    if (row === undefined) return undefined;
    assertLocalUuid(row.login_attempt_id, 'ola', 'OIDC login attempt ID');
    assertOidcIssuer(row.issuer, 'OIDC login attempt issuer');
    invariant(
      row.attempt_purpose === 'identity_bootstrap' ||
        row.attempt_purpose === 'existing_identity_login',
      'OIDC login attempt purpose is invalid',
    );
    assertBoundedText(row.client_id, 1024, 'OIDC client ID');
    assertRedirectUri(row.redirect_uri);
    assertDigest(row.tenant_constraint_sha256, 'OIDC tenant constraint');
    assertDigest(row.oidc_configuration_sha256, 'OIDC configuration');
    assertDigest(row.state_sha256, 'OIDC state');
    assertDigest(row.nonce_sha256, 'OIDC nonce');
    if (row.login_grant_sha256 !== null) {
      assertDigest(row.login_grant_sha256, 'person login grant');
    }
    const { begins, ends } = assertInterval(
      row.created_at,
      row.expires_at,
      'stored OIDC login attempt creation time',
      'stored OIDC login attempt expiry time',
    );
    invariant(
      ends === begins + 10 * 60 * 1000,
      'OIDC login attempt lifetime is not exactly ten minutes',
    );
    if (row.terminal_outcome === null) {
      invariant(
        row.completed_at === null &&
          row.resolved_identity_binding_id === null &&
          row.upstream_assertion_issued_at === null &&
          typeof row.pkce_verifier_seal_key_id === 'string' &&
          row.pkce_verifier_seal_key_id.length > 0 &&
          row.pkce_verifier_seal_key_id.length <= 200 &&
          row.pkce_verifier_sealed instanceof Uint8Array &&
          row.pkce_verifier_sealed.byteLength >= 32 &&
          row.pkce_verifier_sealed.byteLength <= 8192,
        'pending OIDC login attempt lacks sealed PKCE material',
      );
      invariant(
        (row.redemption_claim_id === null &&
          row.redemption_claimed_at === null) ||
          (row.redemption_claim_id !== null &&
            row.redemption_claimed_at !== null),
        'OIDC login attempt redemption claim is inconsistent',
      );
      if (
        row.redemption_claim_id !== null &&
        row.redemption_claimed_at !== null
      ) {
        assertLocalUuid(
          row.redemption_claim_id,
          'olc',
          'OIDC redemption claim ID',
        );
        const claimed = timestampMillis(
          row.redemption_claimed_at,
          'stored OIDC redemption claim time',
        );
        invariant(
          claimed >= begins && claimed < ends,
          'OIDC redemption claim is outside the attempt lifetime',
        );
      }
    } else {
      invariant(
        row.terminal_outcome === 'succeeded' ||
          row.terminal_outcome === 'denied' ||
          row.terminal_outcome === 'expired',
        'OIDC login attempt terminal outcome is invalid',
      );
      invariant(
        row.completed_at !== null,
        'terminal OIDC login attempt lacks a completion time',
      );
      const completed = timestampMillis(
        row.completed_at,
        'stored OIDC login attempt completion time',
      );
      invariant(
        completed >= begins &&
          row.redemption_claim_id === null &&
          row.redemption_claimed_at === null &&
          row.pkce_verifier_seal_key_id === null &&
          row.pkce_verifier_sealed === null,
        'terminal OIDC login attempt retained PKCE material or has invalid time',
      );
      if (row.terminal_outcome === 'succeeded') {
        invariant(
          completed < ends &&
            row.resolved_identity_binding_id !== null &&
            row.upstream_assertion_issued_at !== null,
          'successful OIDC login attempt lacks identity evidence',
        );
        assertLocalUuid(
          row.resolved_identity_binding_id,
          'oib',
          'resolved OIDC identity binding ID',
        );
        const upstream = timestampMillis(
          row.upstream_assertion_issued_at,
          'stored upstream assertion issuance time',
        );
        invariant(
          upstream >= begins - 60_000 && upstream <= completed + 60_000,
          'OIDC assertion issuance time is outside the accepted skew',
        );
      } else {
        invariant(
          row.resolved_identity_binding_id === null &&
            row.upstream_assertion_issued_at === null &&
            (row.terminal_outcome === 'expired'
              ? completed >= ends
              : completed < ends),
          'denied or expired OIDC login attempt retained identity evidence',
        );
      }
    }
    invariant(
      (row.attempt_purpose === 'identity_bootstrap' &&
        row.login_grant_sha256 !== null) ||
        (row.attempt_purpose === 'existing_identity_login' &&
          row.login_grant_sha256 === null),
      'OIDC login attempt purpose and grant are inconsistent',
    );
    if (row.login_grant_sha256 !== null) {
      const grant = this.personLoginGrant(
        row.login_grant_sha256 as Sha256Digest,
      );
      invariant(
        grant !== undefined &&
          grant.expected_issuer === row.issuer &&
          grant.oidc_configuration_sha256 === row.oidc_configuration_sha256,
        'OIDC login attempt differs from its bootstrap grant',
      );
    }
    return {
      ...row,
      attempt_purpose: row.attempt_purpose,
      tenant_constraint_sha256: row.tenant_constraint_sha256 as Sha256Digest,
      oidc_configuration_sha256:
        row.oidc_configuration_sha256 as Sha256Digest,
      login_grant_sha256: row.login_grant_sha256 as Sha256Digest | null,
      state_sha256: row.state_sha256 as Sha256Digest,
      nonce_sha256: row.nonce_sha256 as Sha256Digest,
      terminal_outcome: row.terminal_outcome as
        | 'succeeded'
        | 'denied'
        | 'expired'
        | null,
      pkce_verifier_sealed:
        row.pkce_verifier_sealed === null
          ? null
          : Uint8Array.from(row.pkce_verifier_sealed),
    };
  }

  oidcLoginAttempt(
    stateSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined {
    assertDigest(stateSha256, 'OIDC state');
    return this.oidcLoginAttemptWhere('state_sha256 = ?', stateSha256);
  }

  oidcLoginAttemptForLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined {
    assertDigest(loginGrantSha256, 'person login grant');
    return this.oidcLoginAttemptWhere(
      'login_grant_sha256 = ?',
      loginGrantSha256,
    );
  }

  private oidcLoginAttemptById(
    loginAttemptId: string,
  ): StoredOidcLoginAttempt | undefined {
    return this.oidcLoginAttemptWhere(
      'login_attempt_id = ?',
      loginAttemptId,
    );
  }

  private oidcLoginAttemptWhere(
    where:
      | 'state_sha256 = ?'
      | 'login_attempt_id = ?'
      | 'login_grant_sha256 = ?',
    value: string,
  ): StoredOidcLoginAttempt | undefined {
    const row = this.database
      .prepare(
        `SELECT login_attempt_id, issuer, attempt_purpose, client_id,
                redirect_uri, tenant_constraint_sha256,
                oidc_configuration_sha256, login_grant_sha256, state_sha256,
                nonce_sha256, pkce_verifier_seal_key_id,
                pkce_verifier_sealed, created_at, expires_at,
                redemption_claim_id, redemption_claimed_at, terminal_outcome,
                completed_at, resolved_identity_binding_id,
                upstream_assertion_issued_at
           FROM authority_oidc_login_attempts WHERE ${where}`,
      )
      .get(value) as OidcLoginAttemptRow | undefined;
    return this.oidcLoginAttemptFromRow(row);
  }

  private personLoginGrantFromRow(
    row: PersonLoginGrantRow | undefined,
  ): StoredPersonLoginGrant | undefined {
    if (row === undefined) return undefined;
    assertDigest(row.login_grant_sha256, 'person login grant');
    invariant(
      row.grant_purpose === 'oidc_identity_bootstrap',
      'person login grant purpose is invalid',
    );
    assertOidcIssuer(row.expected_issuer, 'person login grant expected issuer');
    assertDigest(row.oidc_configuration_sha256, 'OIDC configuration');
    this.assertExactPersonMembership(row, 'person login grant');
    const { begins, ends } = assertInterval(
      row.issued_at,
      row.expires_at,
      'stored person login grant issue time',
      'stored person login grant expiry time',
    );
    invariant(
      ends === begins + 15 * 60 * 1000,
      'person login grant lifetime is not exactly fifteen minutes',
    );
    if (row.consumed_at !== null) {
      const consumed = timestampMillis(
        row.consumed_at,
        'stored person login grant consumption time',
      );
      invariant(
        consumed >= begins && consumed < ends,
        'person login grant consumption is outside its lifetime',
      );
    }
    return {
      ...row,
      grant_purpose: 'oidc_identity_bootstrap',
      membership_type: row.membership_type as OrganizationMembershipTypeV1,
      login_grant_sha256: row.login_grant_sha256 as Sha256Digest,
      oidc_configuration_sha256:
        row.oidc_configuration_sha256 as Sha256Digest,
    };
  }

  personLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined {
    const row = this.database
      .prepare(
        `SELECT login_grant_sha256, grant_purpose, organization_id,
                principal_id, membership_id, membership_type, expected_issuer,
                oidc_configuration_sha256, issued_at, expires_at, consumed_at
           FROM authority_person_login_grants WHERE login_grant_sha256 = ?`,
      )
      .get(loginGrantSha256) as PersonLoginGrantRow | undefined;
    return this.personLoginGrantFromRow(row);
  }

  private personSessionFamilyFromRow(
    row: PersonSessionFamilyRow | undefined,
  ): StoredPersonSessionFamily | undefined {
    if (row === undefined) return undefined;
    assertLocalUuid(row.session_family_id, 'psf', 'person session family ID');
    assertLocalUuid(row.identity_binding_id, 'oib', 'OIDC identity binding ID');
    assertLocalUuid(
      row.authentication_login_attempt_id,
      'ola',
      'authentication OIDC login attempt ID',
    );
    assertDigest(row.tenant_constraint_sha256, 'session tenant constraint');
    assertDigest(row.oidc_configuration_sha256, 'session OIDC configuration');
    this.assertExactPersonMembership(row, 'person session family');
    const created = timestampMillis(
      row.created_at,
      'stored person session family creation time',
    );
    const upstream = timestampMillis(
      row.upstream_assertion_issued_at,
      'stored upstream assertion issuance time',
    );
    const hard = timestampMillis(
      row.hard_reauthentication_at,
      'stored hard reauthentication time',
    );
    invariant(
      hard === upstream + 7 * 24 * 60 * 60 * 1000 && hard > created,
      'person session family times are inconsistent',
    );
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'person session family status is invalid',
    );
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(
          row.revoked_at,
          'stored person session family revocation time',
        ) >= created,
        'person session family revocation predates creation',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_reason !== null),
      'person session family status columns are inconsistent',
    );
    const binding = this.oidcIdentityBindingById(row.identity_binding_id);
    invariant(
      binding !== undefined &&
        binding.organization_id === row.organization_id &&
        binding.principal_id === row.principal_id &&
        binding.membership_id === row.membership_id &&
        binding.membership_type === row.membership_type,
      'person session family differs from its OIDC identity binding',
    );
    const attempt = this.oidcLoginAttemptById(
      row.authentication_login_attempt_id,
    );
    invariant(
      attempt !== undefined &&
        attempt.terminal_outcome === 'succeeded' &&
        attempt.completed_at === row.created_at &&
        attempt.resolved_identity_binding_id === row.identity_binding_id &&
        attempt.upstream_assertion_issued_at ===
          row.upstream_assertion_issued_at &&
        attempt.issuer === binding.issuer &&
        attempt.tenant_constraint_sha256 === row.tenant_constraint_sha256 &&
        attempt.oidc_configuration_sha256 ===
          row.oidc_configuration_sha256,
      'person session family differs from its successful login attempt',
    );
    return {
      ...row,
      membership_type: row.membership_type as OrganizationMembershipTypeV1,
      tenant_constraint_sha256: row.tenant_constraint_sha256 as Sha256Digest,
      oidc_configuration_sha256:
        row.oidc_configuration_sha256 as Sha256Digest,
      status: row.status as 'active' | 'revoked',
    };
  }

  personSessionFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionFamily | undefined {
    const row = this.database
      .prepare(
        `SELECT session_family_id, organization_id, principal_id,
                membership_id, membership_type, identity_binding_id,
                authentication_login_attempt_id, created_at,
                upstream_assertion_issued_at, tenant_constraint_sha256,
                oidc_configuration_sha256, hard_reauthentication_at,
                status, revoked_at, revocation_reason
           FROM authority_person_session_families WHERE session_family_id = ?`,
      )
      .get(sessionFamilyId) as PersonSessionFamilyRow | undefined;
    return this.personSessionFamilyFromRow(row);
  }

  private personSessionCredentialFromRow(
    row: PersonSessionCredentialRow | undefined,
  ): StoredPersonSessionCredential | undefined {
    if (row === undefined) return undefined;
    assertLocalUuid(
      row.session_credential_id,
      'psc',
      'person session credential ID',
    );
    assertLocalUuid(row.session_family_id, 'psf', 'person session family ID');
    invariant(
      row.credential_kind === 'access' || row.credential_kind === 'refresh',
      'person session credential kind is invalid',
    );
    invariant(
      Number.isSafeInteger(row.rotation_sequence) && row.rotation_sequence > 0,
      'person session credential rotation sequence is invalid',
    );
    assertDigest(row.token_sha256, 'person session credential token');
    const { begins, ends } = assertInterval(
      row.issued_at,
      row.expires_at,
      'stored person session credential issue time',
      'stored person session credential expiry time',
    );
    if (row.consumed_at !== null) {
      const consumed = timestampMillis(
        row.consumed_at,
        'stored refresh credential consumption time',
      );
      invariant(
        row.credential_kind === 'refresh' &&
          consumed >= begins &&
          consumed < ends,
        'person session credential consumption is invalid',
      );
    }
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(
          row.revoked_at,
          'stored person session credential revocation time',
        ) >= begins,
        'person session credential revocation predates issue',
      );
    }
    invariant(
      (row.revoked_at === null && row.revocation_reason === null) ||
        (row.revoked_at !== null && row.revocation_reason !== null),
      'person session credential revocation columns are inconsistent',
    );
    const family = this.personSessionFamily(row.session_family_id);
    invariant(family !== undefined, 'person session credential family is missing');
    const familyDeadline = timestampMillis(
      family.hard_reauthentication_at,
      'stored family hard reauthentication time',
    );
    invariant(
      row.credential_kind === 'access'
        ? ends === Math.min(begins + 12 * 60 * 60 * 1000, familyDeadline)
        : ends === familyDeadline,
      'person session credential lifetime differs from policy',
    );
    return {
      ...row,
      credential_kind: row.credential_kind as 'access' | 'refresh',
      token_sha256: row.token_sha256 as Sha256Digest,
    };
  }

  personSessionCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined {
    const row = this.database
      .prepare(
        `SELECT session_credential_id, session_family_id, credential_kind,
                rotation_sequence, token_sha256, issued_at, expires_at,
                consumed_at, revoked_at, revocation_reason
           FROM authority_person_session_credentials WHERE token_sha256 = ?`,
      )
      .get(tokenSha256) as PersonSessionCredentialRow | undefined;
    return this.personSessionCredentialFromRow(row);
  }

  personSessionCredentialsForFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionCredential[] {
    const rows = this.database
      .prepare(
        `SELECT session_credential_id, session_family_id, credential_kind,
                rotation_sequence, token_sha256, issued_at, expires_at,
                consumed_at, revoked_at, revocation_reason
           FROM authority_person_session_credentials
          WHERE session_family_id = ?
          ORDER BY rotation_sequence, credential_kind, session_credential_id`,
      )
      .all(sessionFamilyId) as PersonSessionCredentialRow[];
    return rows.map((row) => {
      const credential = this.personSessionCredentialFromRow(row);
      invariant(credential !== undefined, 'person session credential disappeared');
      return credential;
    });
  }

  memberExclusionsForOwnerSource(
    source: MemberExclusionOwnerSource,
  ): readonly StoredMemberExclusionSelector[] | undefined {
    const metadata = this.metadata();
    invariant(
      source.organization_id === metadata.organization_id,
      'member exclusion source belongs to another organization',
    );
    assertFederationUuid(
      source.principal_id,
      'prn',
      'member exclusion source principal',
    );
    assertFederationUuid(
      source.membership_id,
      'mem',
      'member exclusion source membership',
    );
    invariant(
      source.membership_type === 'owner' ||
        source.membership_type === 'employee',
      'member exclusion source membership type is invalid',
    );
    assertBoundedText(
      source.source_adapter_id,
      128,
      'member exclusion source adapter ID',
    );
    assertBoundedText(
      source.source_instance_id,
      128,
      'member exclusion source instance ID',
    );
    const owned = this.database
      .prepare(
        `SELECT 1
           FROM authority_processing_source_owner_bindings b
           JOIN authority_memberships m
             ON m.membership_id = b.membership_id
            AND m.organization_id = b.organization_id
            AND m.principal_id = b.principal_id
            AND m.membership_type = b.membership_type
          WHERE b.source_adapter_id = ? AND b.source_instance_id = ?
            AND b.organization_id = ? AND b.principal_id = ?
            AND b.membership_id = ? AND b.membership_type = ?
            AND m.status = 'active'`,
      )
      .get(
        source.source_adapter_id,
        source.source_instance_id,
        source.organization_id,
        source.principal_id,
        source.membership_id,
        source.membership_type,
      );
    if (owned === undefined) return undefined;
    const rows = this.database
      .prepare(
        `SELECT scope_kind, external_id
           FROM authority_processing_member_exclusions
          WHERE organization_id = ? AND principal_id = ?
            AND membership_id = ? AND membership_type = ?
            AND source_adapter_id = ? AND source_instance_id = ?
          ORDER BY CASE scope_kind WHEN 'source' THEN 0 ELSE 1 END,
                   external_id`,
      )
      .all(
        source.organization_id,
        source.principal_id,
        source.membership_id,
        source.membership_type,
        source.source_adapter_id,
        source.source_instance_id,
      ) as Array<{ scope_kind: string; external_id: string }>;
    return rows.map((row): StoredMemberExclusionSelector => {
      if (row.scope_kind === 'source') {
        invariant(
          row.external_id === '',
          'whole-source member exclusion external ID is invalid',
        );
        return {
          scope: 'source',
          source_adapter_id: source.source_adapter_id,
          source_instance_id: source.source_instance_id,
        };
      }
      invariant(
        row.scope_kind === 'meeting' &&
          row.external_id.length > 0 &&
          row.external_id.length <= 4096 &&
          !row.external_id.includes('\0'),
        'meeting member exclusion is invalid',
      );
      return {
        scope: 'meeting',
        source_adapter_id: source.source_adapter_id,
        source_instance_id: source.source_instance_id,
        external_id: row.external_id,
      };
    });
  }

  activeReadableSearchGeneration(): StoredReadableSearchActiveGeneration | null {
    const row = this.database
      .prepare(
        `SELECT organization_id, generation_id, manifest_sha256,
                retrieval_contract_sha256, record_head_position,
                record_head_hash, published_at
           FROM authority_readable_search_active_generation
          WHERE singleton = 1`,
      )
      .get() as ReadableSearchActiveGenerationRow | undefined;
    if (row === undefined) return null;
    const stored = verifiedPersistedValue(
      'readable search active generation',
      () => validateStoredReadableSearchActiveGeneration(row),
    );
    invariant(
      stored.organization_id === this.trust().descriptor.organization_id,
      'readable search active generation belongs to another organization',
    );
    return stored;
  }

  insertMembership(membership: StoredAuthorityMembership): void {
    this.database
      .prepare(
        `INSERT INTO authority_principals (
           principal_id, organization_id, display_name, provisioned_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        membership.principal_id,
        membership.organization_id,
        membership.display_name,
        membership.provisioned_at,
      );
    this.database
      .prepare(
        `INSERT INTO authority_memberships (
           membership_id, organization_id, principal_id, membership_type,
           status, provisioned_at, revoked_at, revocation_reason,
           admin_command_id, admin_command_sha256
         ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        membership.membership_id,
        membership.organization_id,
        membership.principal_id,
        membership.membership_type,
        membership.provisioned_at,
        membership.admin_command_id,
        membership.admin_command_sha256,
      );
  }

  insertGrant(grant: StoredEnrollmentGrant): void {
    this.database
      .prepare(
        `INSERT INTO authority_enrollment_grants (
           grant_sha256, authority_id, organization_id, principal_id,
           membership_id, issued_at, expires_at, consumed_at, request_sha256,
           admin_command_id, admin_command_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        grant.grant_sha256,
        grant.authority_id,
        grant.organization_id,
        grant.principal_id,
        grant.membership_id,
        grant.issued_at,
        grant.expires_at,
        grant.admin_command_id,
        grant.admin_command_sha256,
      );
  }

  insertEnrollment(value: NewAuthorityEnrollment): void {
    const enrollment = value.enrollment;
    this.database
      .prepare(
        `INSERT INTO authority_enrollments (
           enrollment_id, grant_sha256, request_sha256, request_json,
           receipt_sha256, receipt_json, authority_id, organization_id,
           principal_id, membership_id, membership_type, installation_id,
           installation_key_id, installation_public_key_spki_der_base64,
           status, enrolled_at, revoked_at, revocation_kind, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL)`,
      )
      .run(
        enrollment.enrollment_id,
        enrollment.grant_sha256,
        enrollment.request_sha256,
        canonicalJson(enrollment.request),
        enrollment.receipt_sha256,
        canonicalJson(enrollment.receipt),
        enrollment.authority_id,
        enrollment.organization_id,
        enrollment.principal_id,
        enrollment.membership_id,
        enrollment.membership_type,
        enrollment.installation_id,
        enrollment.installation_signing_key.key_id,
        enrollment.installation_signing_key.public_key_spki_der_base64,
        enrollment.enrolled_at,
      );
    this.insertAccessState(value.initial_access_state);
  }

  consumeGrant(
    grantSha256: Sha256Digest,
    requestSha256: Sha256Digest,
    consumedAt: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_enrollment_grants
           SET consumed_at = ?, request_sha256 = ?
           WHERE grant_sha256 = ? AND consumed_at IS NULL`,
        )
        .run(consumedAt, requestSha256, grantSha256).changes === 1
    );
  }

  insertAccessState(value: StoredAuthorityAccessState): void {
    const state = value.state;
    this.database
      .prepare(
        `INSERT INTO authority_access_states (
           enrollment_id, access_state_sequence, state_sha256, state_json,
           status, evaluated_at, valid_until, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.enrollment_id,
        state.access_state_sequence,
        value.state_sha256,
        canonicalJson(state),
        state.status,
        state.evaluated_at,
        state.valid_until,
        state.revocation_reason,
      );
  }

  insertAccessLeaseRequest(request: StoredAccessLeaseRequest): void {
    const requestJson = canonicalJson(request.request);
    this.database
      .prepare(
        `INSERT INTO authority_access_lease_requests (
           request_sha256, request_id, request_json, enrollment_id,
           previous_access_state_sha256, resulting_state_sha256, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.request_sha256,
        request.request_id,
        requestJson,
        request.enrollment_id,
        request.previous_access_state_sha256,
        request.resulting_state_sha256,
        request.received_at,
      );
  }

  insertInternalLiveRelease(release: NewInternalLiveRelease): void {
    const command = release.command;
    const manifest = command.manifest;
    this.database
      .prepare(
        `INSERT INTO authority_internal_live_releases (
           command_id, command_sha256, manifest_url, manifest_sha256,
           manifest_json, release_version, release_tag, source_sha,
           artifact_sha256, approved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.command_id,
        release.command_sha256,
        command.manifest_url,
        command.manifest_sha256,
        canonicalJson(manifest),
        manifest.release_version,
        manifest.release_tag,
        manifest.source.sha,
        manifest.artifact.sha256,
        release.approved_at,
      );
  }

  insertInternalLiveUpdateReceipt(
    stored: Omit<StoredInternalLiveUpdateReceipt, 'receipt_sequence'>,
  ): void {
    const receipt = stored.receipt;
    this.database
      .prepare(
        `INSERT INTO authority_internal_live_update_receipts (
           transaction_id, payload_sha256, receipt_json, installation_id,
           directive_sequence, outcome, finished_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.transaction_id,
        stored.payload_sha256,
        canonicalJson(receipt),
        receipt.installation_id,
        receipt.directive_sequence,
        receipt.outcome,
        receipt.finished_at,
        stored.received_at,
      );
  }

  revokeMembership(
    membershipId: string,
    revokedAt: string,
    reason: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_memberships
           SET status = 'revoked', revoked_at = ?, revocation_reason = ?
           WHERE membership_id = ? AND status = 'active'`,
        )
        .run(revokedAt, reason, membershipId).changes === 1
    );
  }

  revokeEnrollment(
    enrollmentId: string,
    revokedAt: string,
    kind: 'membership_revoked' | 'installation_revoked',
    reason: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_enrollments
           SET status = 'revoked', revoked_at = ?, revocation_kind = ?,
               revocation_reason = ?
           WHERE enrollment_id = ? AND status = 'active'`,
        )
        .run(revokedAt, kind, reason, enrollmentId).changes === 1
    );
  }

  insertPersonLoginGrant(
    grant: NewPersonLoginGrant,
  ): StoredPersonLoginGrant {
    const issuedAt = this.transactionTime();
    const row: PersonLoginGrantRow = {
      ...grant,
      issued_at: issuedAt,
      consumed_at: null,
    };
    this.personLoginGrantFromRow(row);
    const membership = this.membership(grant.membership_id);
    invariant(
      membership?.status === 'active',
      'person login grant requires an active exact membership',
    );
    invariant(
      timestampMillis(grant.expires_at, 'person login grant expiry time') ===
        timestampMillis(issuedAt, 'person login grant issue time') +
          15 * 60 * 1000,
      'person login grant must expire exactly fifteen minutes after issue',
    );
    this.database
      .prepare(
        `INSERT INTO authority_person_login_grants (
           login_grant_sha256, grant_purpose, organization_id, principal_id,
           membership_id, membership_type, expected_issuer,
           oidc_configuration_sha256, issued_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        grant.login_grant_sha256,
        grant.grant_purpose,
        grant.organization_id,
        grant.principal_id,
        grant.membership_id,
        grant.membership_type,
        grant.expected_issuer,
        grant.oidc_configuration_sha256,
        issuedAt,
        grant.expires_at,
      );
    const stored = this.personLoginGrant(grant.login_grant_sha256);
    invariant(stored !== undefined, 'person login grant was not stored');
    return stored;
  }

  consumePersonLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined {
    assertDigest(loginGrantSha256, 'person login grant');
    const consumedAt = this.transactionTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_person_login_grants
            SET consumed_at = ?
          WHERE login_grant_sha256 = ?
            AND consumed_at IS NULL
            AND issued_at <= ? AND expires_at > ?`,
      )
      .run(consumedAt, loginGrantSha256, consumedAt, consumedAt).changes;
    return changed === 1
      ? this.personLoginGrant(loginGrantSha256)
      : undefined;
  }

  insertOidcLoginAttempt(
    attempt: NewOidcLoginAttempt,
  ): StoredOidcLoginAttempt {
    const createdAt = this.transactionTime();
    const { sealed_pkce_verifier: sealedEnvelope, ...attemptFields } = attempt;
    assertBoundedText(sealedEnvelope.key_id, 200, 'PKCE sealing key ID');
    const sealed = Uint8Array.from(sealedEnvelope.sealed_bytes);
    const row: OidcLoginAttemptRow = {
      ...attemptFields,
      pkce_verifier_seal_key_id: sealedEnvelope.key_id,
      pkce_verifier_sealed: sealed,
      created_at: createdAt,
      redemption_claim_id: null,
      redemption_claimed_at: null,
      terminal_outcome: null,
      completed_at: null,
      resolved_identity_binding_id: null,
      upstream_assertion_issued_at: null,
    };
    this.oidcLoginAttemptFromRow(row);
    invariant(
      timestampMillis(attempt.expires_at, 'OIDC login attempt expiry time') ===
        timestampMillis(createdAt, 'OIDC login attempt creation time') +
          10 * 60 * 1000,
      'OIDC login attempt must expire exactly ten minutes after creation',
    );
    if (attempt.login_grant_sha256 !== null) {
      const grant = this.personLoginGrant(attempt.login_grant_sha256);
      invariant(
        grant !== undefined &&
          grant.consumed_at === null &&
          grant.expires_at > createdAt,
        'OIDC bootstrap attempt requires a pending live login grant',
      );
    }
    this.database
      .prepare(
        `INSERT INTO authority_oidc_login_attempts (
           login_attempt_id, issuer, attempt_purpose, client_id, redirect_uri,
           tenant_constraint_sha256, oidc_configuration_sha256,
           login_grant_sha256, state_sha256, nonce_sha256,
           pkce_verifier_seal_key_id, pkce_verifier_sealed, created_at,
           expires_at, redemption_claim_id, redemption_claimed_at,
           terminal_outcome, completed_at,
           resolved_identity_binding_id, upstream_assertion_issued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
                   NULL, NULL, NULL, NULL)`,
      )
      .run(
        attempt.login_attempt_id,
        attempt.issuer,
        attempt.attempt_purpose,
        attempt.client_id,
        attempt.redirect_uri,
        attempt.tenant_constraint_sha256,
        attempt.oidc_configuration_sha256,
        attempt.login_grant_sha256,
        attempt.state_sha256,
        attempt.nonce_sha256,
        sealedEnvelope.key_id,
        sealed,
        createdAt,
        attempt.expires_at,
      );
    const stored = this.oidcLoginAttempt(attempt.state_sha256);
    invariant(stored !== undefined, 'OIDC login attempt was not stored');
    return stored;
  }

  claimOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): StoredOidcLoginAttempt | undefined {
    assertDigest(stateSha256, 'OIDC state');
    assertLocalUuid(
      redemptionClaimId,
      'olc',
      'OIDC redemption claim ID',
    );
    const claimedAt = this.transactionTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_oidc_login_attempts
            SET redemption_claim_id = ?, redemption_claimed_at = ?
          WHERE state_sha256 = ? AND terminal_outcome IS NULL
            AND redemption_claim_id IS NULL
            AND created_at <= ? AND expires_at > ?`,
      )
      .run(
        redemptionClaimId,
        claimedAt,
        stateSha256,
        claimedAt,
        claimedAt,
      ).changes;
    return changed === 1 ? this.oidcLoginAttempt(stateSha256) : undefined;
  }

  releaseOidcLoginAttemptClaim(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): boolean {
    assertDigest(stateSha256, 'OIDC state');
    assertLocalUuid(
      redemptionClaimId,
      'olc',
      'OIDC redemption claim ID',
    );
    const releasedAt = this.transactionTime();
    return (
      this.database
        .prepare(
          `UPDATE authority_oidc_login_attempts
              SET redemption_claim_id = NULL,
                  redemption_claimed_at = NULL
            WHERE state_sha256 = ? AND terminal_outcome IS NULL
              AND redemption_claim_id = ? AND expires_at > ?`,
        )
        .run(stateSha256, redemptionClaimId, releasedAt).changes === 1
    );
  }

  completeOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
    completion: OidcLoginAttemptCompletion,
  ): StoredOidcLoginAttempt | undefined {
    assertDigest(stateSha256, 'OIDC state');
    assertLocalUuid(
      redemptionClaimId,
      'olc',
      'OIDC redemption claim ID',
    );
    const completedAt = this.transactionTime();
    const current = this.oidcLoginAttempt(stateSha256);
    if (
      current === undefined ||
      current.terminal_outcome !== null ||
      current.redemption_claim_id !== redemptionClaimId
    ) {
      return undefined;
    }
    if (completion.outcome === 'succeeded') {
      assertLocalUuid(
        completion.resolved_identity_binding_id,
        'oib',
        'resolved OIDC identity binding ID',
      );
      const upstreamAssertionIssuedAt = timestampMillis(
        completion.upstream_assertion_issued_at,
        'OIDC assertion issuance time',
      );
      const attemptCreatedAt = timestampMillis(
        current.created_at,
        'OIDC login attempt creation time',
      );
      const completionTime = timestampMillis(
        completedAt,
        'OIDC login attempt completion time',
      );
      invariant(
        upstreamAssertionIssuedAt >= attemptCreatedAt - 60_000 &&
          upstreamAssertionIssuedAt <= completionTime + 60_000,
        'OIDC assertion issuance time is outside the accepted skew',
      );
      if (current.attempt_purpose === 'identity_bootstrap') {
        const grant =
          current.login_grant_sha256 === null
            ? undefined
            : this.personLoginGrant(current.login_grant_sha256);
        invariant(
          grant !== undefined &&
            ((grant.consumed_at === null &&
              grant.issued_at <= completedAt &&
              grant.expires_at > completedAt) ||
              grant.consumed_at === completedAt) &&
            this.oidcIdentityBindingById(
              completion.resolved_identity_binding_id,
            ) === undefined,
          'successful bootstrap requires a live or just-consumed grant and fresh identity binding',
        );
      } else {
        const binding = this.oidcIdentityBindingById(
          completion.resolved_identity_binding_id,
        );
        const membership =
          binding === undefined
            ? undefined
            : this.membership(binding.membership_id);
        invariant(
          binding?.status === 'active' &&
            binding.issuer === current.issuer &&
            membership?.status === 'active',
          'successful existing-identity login requires active identity and membership',
        );
      }
    }
    const changed = this.database
      .prepare(
        `UPDATE authority_oidc_login_attempts
            SET terminal_outcome = ?, completed_at = ?,
                resolved_identity_binding_id = ?,
                upstream_assertion_issued_at = ?,
                redemption_claim_id = NULL,
                redemption_claimed_at = NULL,
                pkce_verifier_seal_key_id = NULL,
                pkce_verifier_sealed = NULL
          WHERE state_sha256 = ? AND terminal_outcome IS NULL
            AND redemption_claim_id = ?
            AND created_at <= ? AND expires_at > ?`,
      )
      .run(
        completion.outcome,
        completedAt,
        completion.outcome === 'succeeded'
          ? completion.resolved_identity_binding_id
          : null,
        completion.outcome === 'succeeded'
          ? completion.upstream_assertion_issued_at
          : null,
        stateSha256,
        redemptionClaimId,
        completedAt,
        completedAt,
      ).changes;
    return changed === 1 ? this.oidcLoginAttempt(stateSha256) : undefined;
  }

  expireOidcLoginAttempts(limit: number): number {
    invariant(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
      'OIDC login-attempt expiry limit is invalid',
    );
    const completedAt = this.transactionTime();
    const expired = this.database
      .prepare(
        `UPDATE authority_oidc_login_attempts
            SET terminal_outcome = 'expired', completed_at = ?,
                redemption_claim_id = NULL,
                redemption_claimed_at = NULL,
                pkce_verifier_seal_key_id = NULL,
                pkce_verifier_sealed = NULL
          WHERE login_attempt_id IN (
            SELECT login_attempt_id
              FROM authority_oidc_login_attempts
             WHERE terminal_outcome IS NULL AND expires_at <= ?
             ORDER BY expires_at, login_attempt_id
             LIMIT ?
          )
          RETURNING login_attempt_id`,
      )
      .all(completedAt, completedAt, limit);
    return expired.length;
  }

  insertOidcIdentityBinding(
    binding: NewOidcIdentityBinding,
  ): StoredOidcIdentityBinding {
    const boundAt = this.transactionTime();
    const row: OidcIdentityBindingRow = {
      ...binding,
      status: 'active',
      bound_at: boundAt,
      revoked_at: null,
      revocation_reason: null,
    };
    this.oidcIdentityBindingFromRow(row);
    const membership = this.membership(binding.membership_id);
    invariant(
      membership?.status === 'active',
      'OIDC identity binding requires an active exact membership',
    );
    this.database
      .prepare(
        `INSERT INTO authority_oidc_identity_bindings (
           identity_binding_id, issuer, subject, tenant_constraint_sha256,
           oidc_configuration_sha256, initial_login_attempt_id,
           initial_login_grant_sha256, organization_id, principal_id,
           membership_id, membership_type, status, bound_at, revoked_at,
           revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)`,
      )
      .run(
        binding.identity_binding_id,
        binding.issuer,
        binding.subject,
        binding.tenant_constraint_sha256,
        binding.oidc_configuration_sha256,
        binding.initial_login_attempt_id,
        binding.initial_login_grant_sha256,
        binding.organization_id,
        binding.principal_id,
        binding.membership_id,
        binding.membership_type,
        boundAt,
      );
    const stored = this.oidcIdentityBindingById(binding.identity_binding_id);
    invariant(stored !== undefined, 'OIDC identity binding was not stored');
    return stored;
  }

  revokeOidcIdentityBinding(
    identityBindingId: string,
    reason: string,
  ): boolean {
    assertLocalUuid(identityBindingId, 'oib', 'OIDC identity binding ID');
    assertRevocationReason(reason);
    const revokedAt = this.transactionTime();
    return (
      this.database
        .prepare(
          `UPDATE authority_oidc_identity_bindings
              SET status = 'revoked', revoked_at = ?, revocation_reason = ?
            WHERE identity_binding_id = ? AND status = 'active'`,
        )
        .run(revokedAt, reason, identityBindingId).changes === 1
    );
  }

  insertPersonSessionFamily(
    family: NewPersonSessionFamily,
  ): StoredPersonSessionFamily {
    const createdAt = this.transactionTime();
    const row: PersonSessionFamilyRow = {
      ...family,
      created_at: createdAt,
      status: 'active',
      revoked_at: null,
      revocation_reason: null,
    };
    this.personSessionFamilyFromRow(row);
    const binding = this.oidcIdentityBindingById(family.identity_binding_id);
    const membership = this.membership(family.membership_id);
    invariant(
      binding?.status === 'active' && membership?.status === 'active',
      'person session family requires active identity and membership',
    );
    invariant(
      timestampMillis(
        family.hard_reauthentication_at,
        'person session hard reauthentication time',
      ) ===
        timestampMillis(
          family.upstream_assertion_issued_at,
          'person session upstream assertion issuance time',
        ) +
          7 * 24 * 60 * 60 * 1000 &&
        timestampMillis(
          family.hard_reauthentication_at,
          'person session hard reauthentication time',
        ) > timestampMillis(createdAt, 'person session family creation time'),
      'person session hard reauthentication must be seven days after assertion issuance',
    );
    this.database
      .prepare(
        `INSERT INTO authority_person_session_families (
           session_family_id, organization_id, principal_id, membership_id,
           membership_type, identity_binding_id,
           authentication_login_attempt_id, created_at,
           upstream_assertion_issued_at,
           tenant_constraint_sha256,
           oidc_configuration_sha256, hard_reauthentication_at, status,
           revoked_at, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
      )
      .run(
        family.session_family_id,
        family.organization_id,
        family.principal_id,
        family.membership_id,
        family.membership_type,
        family.identity_binding_id,
        family.authentication_login_attempt_id,
        createdAt,
        family.upstream_assertion_issued_at,
        family.tenant_constraint_sha256,
        family.oidc_configuration_sha256,
        family.hard_reauthentication_at,
      );
    const stored = this.personSessionFamily(family.session_family_id);
    invariant(stored !== undefined, 'person session family was not stored');
    return stored;
  }

  insertPersonSessionCredential(
    credential: NewPersonSessionCredential,
  ): StoredPersonSessionCredential {
    const issuedAt = this.transactionTime();
    const row: PersonSessionCredentialRow = {
      ...credential,
      issued_at: issuedAt,
      consumed_at: null,
      revoked_at: null,
      revocation_reason: null,
    };
    this.personSessionCredentialFromRow(row);
    const family = this.personSessionFamily(credential.session_family_id);
    const issuedAtMillis = timestampMillis(
      issuedAt,
      'person session credential issue time',
    );
    const familyDeadlineMillis =
      family === undefined
        ? Number.NaN
        : timestampMillis(
            family.hard_reauthentication_at,
            'person session hard reauthentication time',
          );
    const expectedExpiryMillis =
      credential.credential_kind === 'access'
        ? Math.min(
            issuedAtMillis + 12 * 60 * 60 * 1000,
            familyDeadlineMillis,
          )
        : familyDeadlineMillis;
    invariant(
      family?.status === 'active' &&
        family.hard_reauthentication_at > issuedAt &&
        timestampMillis(
          credential.expires_at,
          'person session credential expiry time',
        ) === expectedExpiryMillis,
      'person session credential requires a live family and exact policy lifetime',
    );
    const binding = this.oidcIdentityBindingById(family.identity_binding_id);
    const membership = this.membership(family.membership_id);
    invariant(
      binding?.status === 'active' && membership?.status === 'active',
      'person session credential requires active identity and membership',
    );
    const sequenceRow = this.database
      .prepare(
        `SELECT COALESCE(MAX(rotation_sequence), 0) AS current_sequence
           FROM authority_person_session_credentials
          WHERE session_family_id = ? AND credential_kind = ?`,
      )
      .get(
        credential.session_family_id,
        credential.credential_kind,
      ) as { current_sequence: number };
    invariant(
      credential.rotation_sequence === sequenceRow.current_sequence + 1,
      'person session credential rotation is not contiguous',
    );
    this.database
      .prepare(
        `INSERT INTO authority_person_session_credentials (
           session_credential_id, session_family_id, credential_kind,
           rotation_sequence, token_sha256, issued_at, expires_at,
           consumed_at, revoked_at, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        credential.session_credential_id,
        credential.session_family_id,
        credential.credential_kind,
        credential.rotation_sequence,
        credential.token_sha256,
        issuedAt,
        credential.expires_at,
      );
    const stored = this.personSessionCredential(credential.token_sha256);
    invariant(stored !== undefined, 'person session credential was not stored');
    return stored;
  }

  consumePersonSessionRefreshCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined {
    assertDigest(tokenSha256, 'person refresh token');
    const consumedAt = this.transactionTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_person_session_credentials AS credential
            SET consumed_at = ?
          WHERE credential.token_sha256 = ?
            AND credential.credential_kind = 'refresh'
            AND credential.consumed_at IS NULL
            AND credential.revoked_at IS NULL
            AND credential.issued_at <= ? AND credential.expires_at > ?
            AND EXISTS (
              SELECT 1
                FROM authority_person_session_families family
                JOIN authority_oidc_identity_bindings binding
                  ON binding.identity_binding_id = family.identity_binding_id
                JOIN authority_memberships membership
                  ON membership.membership_id = family.membership_id
                 AND membership.organization_id = family.organization_id
                 AND membership.principal_id = family.principal_id
                 AND membership.membership_type = family.membership_type
               WHERE family.session_family_id = credential.session_family_id
                 AND family.status = 'active'
                 AND family.hard_reauthentication_at > ?
                 AND binding.status = 'active'
                 AND membership.status = 'active'
            )`,
      )
      .run(
        consumedAt,
        tokenSha256,
        consumedAt,
        consumedAt,
        consumedAt,
      ).changes;
    return changed === 1
      ? this.personSessionCredential(tokenSha256)
      : undefined;
  }

  revokePersonSessionCredential(
    tokenSha256: Sha256Digest,
    reason: string,
  ): boolean {
    assertDigest(tokenSha256, 'person session credential token');
    assertRevocationReason(reason);
    const revokedAt = this.transactionTime();
    return (
      this.database
        .prepare(
          `UPDATE authority_person_session_credentials
              SET revoked_at = ?, revocation_reason = ?
            WHERE token_sha256 = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, reason, tokenSha256).changes === 1
    );
  }

  revokePersonSessionFamily(
    sessionFamilyId: string,
    reason: string,
  ): boolean {
    assertLocalUuid(sessionFamilyId, 'psf', 'person session family ID');
    assertRevocationReason(reason);
    const revokedAt = this.transactionTime();
    const changed = this.database
      .prepare(
        `UPDATE authority_person_session_families
            SET status = 'revoked', revoked_at = ?, revocation_reason = ?
          WHERE session_family_id = ? AND status = 'active'`,
      )
      .run(revokedAt, reason, sessionFamilyId).changes;
    if (changed !== 1) return false;
    this.database
      .prepare(
        `UPDATE authority_person_session_credentials
            SET revoked_at = ?, revocation_reason = ?
          WHERE session_family_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, reason, sessionFamilyId);
    return true;
  }

  appendPersonReadDecisionAudit(
    entry: PersonReadDecisionAuditEntry,
  ): StoredPersonReadDecisionAudit {
    const metadata = this.metadata();
    const occurredAt = this.transactionTime();
    invariant(
      entry.response_bytes instanceof Uint8Array,
      'Person read audit response bytes are invalid',
    );
    if (entry.authenticated !== null) {
      invariant(
        entry.authenticated.organization_id === metadata.organization_id,
        'Person read audit authentication belongs to another organization',
      );
    }
    const responseSha256 =
      `sha256:${createHash('sha256')
        .update(entry.response_bytes)
        .digest('hex')}` as Sha256Digest;
    const candidate: PersonReadDecisionAuditRow = {
      audit_sequence: 1,
      occurred_at: occurredAt,
      retain_until: personReadAuditRetainUntil(occurredAt),
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      operation: entry.operation,
      request_sha256: entry.request_sha256,
      response_sha256: responseSha256,
      asserted_subject_principal_id: entry.asserted_subject_principal_id,
      decision: entry.decision,
      reason_code: entry.reason_code,
      authenticated_principal_id:
        entry.authenticated?.principal_id ?? null,
      authenticated_membership_id:
        entry.authenticated?.membership_id ?? null,
      authenticated_membership_type:
        entry.authenticated?.membership_type ?? null,
      identity_binding_id:
        entry.authenticated?.identity_binding_id ?? null,
      session_family_id: entry.authenticated?.session_family_id ?? null,
      access_credential_sha256:
        entry.authenticated?.access_credential_sha256 ?? null,
      caller_binding_sha256:
        entry.authenticated?.caller_binding_sha256 ?? null,
      person_state_sha256:
        entry.authenticated?.person_state_sha256 ?? null,
      session_state_sha256:
        entry.authenticated?.session_state_sha256 ?? null,
    };
    personReadDecisionAuditFromRow(candidate);
    const inserted = this.database
      .prepare(
        `INSERT INTO authority_person_read_decision_audit (
           occurred_at, retain_until, authority_id, organization_id,
           operation, request_sha256, response_sha256,
           asserted_subject_principal_id, decision, reason_code,
           authenticated_principal_id, authenticated_membership_id,
           authenticated_membership_type, identity_binding_id,
           session_family_id, access_credential_sha256,
           caller_binding_sha256, person_state_sha256, session_state_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.occurred_at,
        candidate.retain_until,
        candidate.authority_id,
        candidate.organization_id,
        candidate.operation,
        candidate.request_sha256,
        candidate.response_sha256,
        candidate.asserted_subject_principal_id,
        candidate.decision,
        candidate.reason_code,
        candidate.authenticated_principal_id,
        candidate.authenticated_membership_id,
        candidate.authenticated_membership_type,
        candidate.identity_binding_id,
        candidate.session_family_id,
        candidate.access_credential_sha256,
        candidate.caller_binding_sha256,
        candidate.person_state_sha256,
        candidate.session_state_sha256,
      );
    const row = this.database
      .prepare(
        `SELECT audit_sequence, occurred_at, retain_until, authority_id,
                organization_id, operation, request_sha256, response_sha256,
                asserted_subject_principal_id, decision, reason_code,
                authenticated_principal_id, authenticated_membership_id,
                authenticated_membership_type, identity_binding_id,
                session_family_id, access_credential_sha256,
                caller_binding_sha256, person_state_sha256,
                session_state_sha256
           FROM authority_person_read_decision_audit
          WHERE audit_sequence = ?`,
      )
      .get(Number(inserted.lastInsertRowid)) as
      | PersonReadDecisionAuditRow
      | undefined;
    invariant(row !== undefined, 'Person read decision audit was not stored');
    return personReadDecisionAuditFromRow(row);
  }

  appendMemberExclusionReadAudit(
    entry: MemberExclusionReadAuditEntry,
  ): void {
    const metadata = this.metadata();
    const occurredAt = this.transactionTime();
    assertDigest(entry.request_sha256, 'member exclusion read audit request');
    invariant(
      entry.response_bytes instanceof Uint8Array,
      'member exclusion read audit response bytes are invalid',
    );
    invariant(
      Number.isSafeInteger(entry.result_count) && entry.result_count >= 0,
      'member exclusion read audit result count is invalid',
    );
    invariant(
      entry.decision === 'allow' || entry.result_count === 0,
      'denied member exclusion read audit must have zero results',
    );
    const responseSha256 =
      `sha256:${createHash('sha256')
        .update(entry.response_bytes)
        .digest('hex')}` as Sha256Digest;
    const isPerson = entry.actor_kind === 'person';
    const authenticated = isPerson ? entry.authenticated : null;
    if (authenticated !== null) {
      invariant(
        authenticated.organization_id === metadata.organization_id,
        'member exclusion read audit authentication belongs to another organization',
      );
    }
    const actorBindingSha256 = isPerson
      ? authenticated?.caller_binding_sha256 ?? null
      : entry.actor_binding_sha256;
    if (actorBindingSha256 !== null) {
      assertDigest(
        actorBindingSha256,
        'member exclusion read audit actor binding',
      );
    }
    if (isPerson) {
      assertFederationUuid(
        entry.asserted_subject_principal_id,
        'prn',
        'member exclusion read audit asserted subject',
      );
    }
    this.database
      .prepare(
        `INSERT INTO authority_member_exclusion_read_audit (
           occurred_at, retain_until, authority_id, organization_id,
           actor_kind, actor_binding_version, actor_binding_sha256,
           operation, request_sha256, response_sha256, result_count,
           asserted_subject_principal_id, decision, reason_code,
           authenticated_principal_id, authenticated_membership_id,
           authenticated_membership_type, identity_binding_id,
           session_family_id, access_credential_sha256,
           caller_binding_sha256, person_state_sha256, session_state_sha256
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        personReadAuditRetainUntil(occurredAt),
        metadata.authority_id,
        metadata.organization_id,
        entry.actor_kind,
        actorBindingSha256,
        isPerson ? 'member_exclusions' : 'member_exclusions_break_glass',
        entry.request_sha256,
        responseSha256,
        entry.result_count,
        isPerson ? entry.asserted_subject_principal_id : null,
        entry.decision,
        entry.reason_code,
        authenticated?.principal_id ?? null,
        authenticated?.membership_id ?? null,
        authenticated?.membership_type ?? null,
        authenticated?.identity_binding_id ?? null,
        authenticated?.session_family_id ?? null,
        authenticated?.access_credential_sha256 ?? null,
        authenticated?.caller_binding_sha256 ?? null,
        authenticated?.person_state_sha256 ?? null,
        authenticated?.session_state_sha256 ?? null,
      );
  }

  appendAudit(entry: AuthorityAuditEntry): void {
    // Governed stopped-state receipts are reserved. The ordinary audit path,
    // which any online write holds, must not be able to mint a lookalike.
    // Only each maintenance transaction's private atomic insert may.
    if (
      entry.action === REVIEWER_QUERY_AUDIT_EXPORT_ACTION ||
      entry.action === REVIEWER_QUERY_AUDIT_EXPIRED_ACTION ||
      entry.action === ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION
    ) {
      throw new Error(
        'governed stopped-state audit actions are reserved for their maintenance transaction',
      );
    }
    const detailJson = canonicalJson(entry.detail);
    this.database
      .prepare(
        `INSERT INTO authority_audit_log (
           occurred_at, actor_kind, action, subject_id, detail_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.occurred_at,
        entry.actor_kind,
        entry.action,
        entry.subject_id,
        detailJson,
      );
  }

  appendReviewerQueryAudit(
    entry: ReviewerQueryAuditEntry,
  ): StoredReviewerQueryAuditEntry {
    // The row's time is this transaction's own final time. A caller states the
    // decision, never when it happened, so it cannot move the retention.
    const occurredAt = this.transactionTime();
    const detailJson = reviewerQueryAuditDecisionDetailJson(
      {
        decision: entry.decision,
        reason_code: entry.reason_code,
        occurred_at: occurredAt,
        response_bytes: entry.response_bytes,
      },
      entry.detail,
    );
    const inserted = this.database
      .prepare(
        `INSERT INTO authority_query_decision_audit (
           occurred_at, retain_until, operation, decision, reason_code,
           detail_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        reviewerQueryAuditRetainUntil(occurredAt),
        REVIEWER_QUERY_AUDIT_OPERATION,
        entry.decision,
        entry.reason_code,
        detailJson,
      );
    const stored = reviewerQueryAuditRowBySequence(
      this.database,
      Number(inserted.lastInsertRowid),
    );
    if (stored === undefined) {
      throw new Error('reviewer query audit entry was not stored');
    }
    if (stored.occurred_at !== occurredAt) {
      throw new Error('stored reviewer query audit entry lost its write time');
    }
    return stored;
  }

  publishReadableSearchActiveGeneration(
    publication: ReadableSearchActiveGenerationPublication,
  ): StoredReadableSearchActiveGeneration {
    const validated = validateReadableSearchActiveGenerationPublication(publication);
    const metadata = this.metadata();
    invariant(
      validated.organization_id === metadata.organization_id,
      'readable search active generation belongs to another organization',
    );
    const publishedAt = this.transactionTime();
    this.database
      .prepare(
        `INSERT INTO authority_readable_search_active_generation (
           singleton, organization_id, generation_id, manifest_sha256,
           retrieval_contract_sha256, record_head_position, record_head_hash,
           published_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           organization_id = excluded.organization_id,
           generation_id = excluded.generation_id,
           manifest_sha256 = excluded.manifest_sha256,
           retrieval_contract_sha256 = excluded.retrieval_contract_sha256,
           record_head_position = excluded.record_head_position,
           record_head_hash = excluded.record_head_hash,
           published_at = excluded.published_at`,
      )
      .run(
        validated.organization_id,
        validated.generation_id,
        validated.manifest_sha256,
        validated.retrieval_contract_sha256,
        validated.record_head_position,
        validated.record_head_hash,
        publishedAt,
      );
    const stored = this.activeReadableSearchGeneration();
    invariant(stored !== null, 'readable search active generation was not stored');
    invariant(
      stored.published_at === publishedAt,
      'readable search active generation lost its transaction time',
    );
    return stored;
  }

  appendReadableSearchQueryAudit(
    entry: ReadableSearchQueryAuditEntry,
  ): StoredReadableSearchQueryAuditEntry {
    const occurredAt = this.transactionTime();
    const detailJson = readableSearchQueryAuditDetailJson(
      { ...entry, occurred_at: occurredAt },
      entry.detail,
    );
    const inserted = this.database
      .prepare(
        `INSERT INTO authority_readable_search_query_audit (
           occurred_at, retain_until, operation, decision, reason_code,
           detail_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        readableSearchQueryAuditRetainUntil(occurredAt),
        READABLE_SEARCH_QUERY_AUDIT_OPERATION,
        entry.decision,
        entry.reason_code,
        detailJson,
      );
    const row = this.database
      .prepare(
        `SELECT audit_sequence, occurred_at, retain_until, operation, decision,
                reason_code, detail_json
           FROM authority_readable_search_query_audit
          WHERE audit_sequence = ?`,
      )
      .get(Number(inserted.lastInsertRowid)) as ReadableSearchQueryAuditRow | undefined;
    invariant(row !== undefined, 'readable search query audit entry was not stored');
    const stored = verifiedPersistedValue(
      'readable search query audit entry',
      () => validateStoredReadableSearchQueryAuditEntry(row),
    );
    invariant(
      stored.occurred_at === occurredAt,
      'readable search query audit entry lost its transaction time',
    );
    return stored;
  }
}

/**
 * The online repository.
 *
 * It implements the served Authority contract and nothing else. Reviewer
 * query-audit scanning, expiry, control lookup, and control append are not
 * missing by convention here: they are not on this class or its type at all, so
 * the live runtime holds no reference that could reach them. The stopped-state
 * capability lives in `reviewer-query-audit-maintenance.ts`.
 */
export class SqliteOrganizationAuthorityRepository
  implements OrganizationAuthorityRepository
{
  private readonly database: Database.Database;
  private readonly transaction: SqliteAuthorityTransaction;
  private readonly allowInitialization: boolean;
  private closed = false;

  constructor(
    databasePath: string,
    options: OpenAuthorityDatabaseOptions & {
      allowInitialization?: boolean;
    } = {},
  ) {
    this.database = openAuthorityDatabase(databasePath, options);
    this.transaction = new SqliteAuthorityTransaction(this.database);
    this.allowInitialization = options.allowInitialization ?? true;
  }

  initialize(input: InitializeAuthorityRepositoryInput): void {
    timestampMillis(
      input.initialized_at,
      'authority repository initialization time',
    );
    const descriptor = validateOrganizationAuthorityDescriptor(
      input.descriptor,
    );
    verifyOrganizationAuthorityPin(descriptor, input.authority_pin_sha256);
    this.transaction.configureTrust(input);
    const descriptorJson = canonicalJson(descriptor);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database
        .prepare(
          `SELECT authority_id, organization_id, organization_display_name,
                  authority_pin_sha256, descriptor_json, created_at,
                  last_observed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as MetadataRow | undefined;
      if (existing === undefined) {
        if (!this.allowInitialization) {
          throw new Error(
            'authority database must already contain initialized metadata when serving',
          );
        }
        this.database
          .prepare(
            `INSERT INTO authority_metadata (
               singleton, authority_id, organization_id,
               organization_display_name, authority_pin_sha256,
               descriptor_json, created_at, last_observed_at
             ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.descriptor.authority_id,
            input.descriptor.organization_id,
            input.organization_display_name,
            input.authority_pin_sha256,
            descriptorJson,
            input.initialized_at,
            input.initialized_at,
          );
      } else {
        this.transaction.metadata();
        if (
          existing.authority_id !== input.descriptor.authority_id ||
          existing.organization_id !== input.descriptor.organization_id ||
          existing.organization_display_name !==
            input.organization_display_name ||
          existing.authority_pin_sha256 !== input.authority_pin_sha256 ||
          existing.descriptor_json !== descriptorJson
        ) {
          throw new Error(
            'configured organization authority differs from persisted authority metadata',
          );
        }
        if (input.initialized_at < existing.last_observed_at) {
          throw new Error(
            'authority clock regressed since the last committed write',
          );
        }
        this.database
          .prepare(
            `UPDATE authority_metadata SET last_observed_at = ?
             WHERE singleton = 1`,
          )
          .run(input.initialized_at);
      }
      this.transaction.metadata();
      this.database.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  read<T>(operation: (transaction: AuthorityReadTransaction) => T): T {
    this.assertOpen();
    this.database.exec('BEGIN');
    try {
      const result = operation(this.transaction);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  write<T>(
    observedAt: string,
    operation: (transaction: AuthorityWriteTransaction) => T,
  ): T {
    this.assertOpen();
    timestampMillis(observedAt, 'authority write time');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const metadata = this.transaction.metadata();
      if (observedAt < metadata.last_observed_at) {
        throw new Error(
          'authority clock regressed since the last committed write',
        );
      }
      this.database
        .prepare(
          'UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1',
        )
        .run(observedAt);
      this.transaction.bindWriteTime(observedAt);
      const result = operation(this.transaction);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    } finally {
      this.transaction.clearWriteTime();
    }
  }

  writeAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: AuthorityWriteTransaction,
      observedAt: string,
    ) => T,
  ): T {
    this.assertOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const observedAt = observe();
      timestampMillis(observedAt, 'authority write time');
      const metadata = this.transaction.metadata();
      if (observedAt < metadata.last_observed_at) {
        throw new Error(
          'authority clock regressed since the last committed write',
        );
      }
      this.database
        .prepare(
          'UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1',
        )
        .run(observedAt);
      this.transaction.bindWriteTime(observedAt);
      const result = operation(this.transaction, observedAt);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    } finally {
      this.transaction.clearWriteTime();
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error('organization authority repository is closed');
  }

  private rollback(): void {
    try {
      this.database.exec('ROLLBACK');
    } catch {}
  }
}
