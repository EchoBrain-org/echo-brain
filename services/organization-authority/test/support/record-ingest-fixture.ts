import { Buffer } from 'node:buffer';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  canonicalSha256,
  federationId,
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND,
  ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE,
  ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
  ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
  organizationPermissionPilotCommandSha256,
  validateOrganizationPermissionPilotAudience,
  type OrganizationPermissionPilotActivationCommandV1,
  type OrganizationPermissionPilotEligibilityProofV1,
} from '@echo-brain/organization-record';
import {
  OrganizationPermissionPilotLog,
  OrganizationRecordLogStore,
} from '@echo-brain/organization-record/append';
import {
  createOrganizationRecordReviewerApprovalEnvelope,
  createOrganizationRecordOrganizationMemberApprovalEnvelope,
  createOrganizationEnrollmentRequest,
  createOrganizationRecordApprovalEnvelope,
  createOrganizationRecordRejectionEnvelope,
  CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
  organizationAuthorityPinSha256,
  organizationEnrollmentGrantSha256,
  organizationRecordReviewerIntent,
  organizationRecordOrganizationMemberIntent,
  organizationRecordEnvelopeId,
  organizationMemberReadableApprovalPresentation,
  organizationMemberReadableApprovalPresentationSha256,
  organizationMemberReadablePolicyContractSha256,
  organizationMemberReadableReleaseDraftSha256,
  projectOrganizationMemberReadableReleaseDraft,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationRecordApprovalEnvelopeV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordEnvelopeV1,
  OrganizationRecordReviewerApprovalEnvelopeV2,
  OrganizationRecordOrganizationMemberApprovalEnvelopeV3,
  OrganizationRecordRejectionEnvelopeV1,
  OrganizationRecordReviewerAuthorizationV1,
  OrganizationRecordReviewerAuthorizationV2,
  OrganizationRecordOrganizationMemberAuthorizationV3,
} from '@echo-brain/organization-protocol';
import {
  OrganizationIntegrationsRepository,
  organizationMemberMessagePresentationPreimage,
  openOrganizationControlDatabase,
  reviewerMessagePresentationPreimage,
  type OrganizationSecretStore,
  type OrganizationPermissionReasonCode,
  type SlackIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import {
  createOrganizationReviewerPermissionCheckRequest,
  createOrganizationMemberReadablePermissionCheckRequest,
  createOrganizationReviewerRecentDecisionsRequest,
  createOrganizationReadableSearchRequest,
  type OrganizationReviewerRecentDecisionsRequestV1,
  type OrganizationReadableSearchRequestV1,
} from '@echo-brain/organization-api';
import { OrganizationAuthorityApplication } from '../../src/application/organization-authority.js';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  OrganizationAuthoritySigner,
} from '../../src/application/ports/runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  openOrganizationRecordRuntime,
  type OrganizationRecordRuntime,
} from '../../src/composition/organization-record.js';
import { ComposedOrganizationIntegrationsApplication } from '../../src/composition/organization-integrations.js';
import { reviewerPolicyContractSha256 } from '../../src/application/reviewer-policy-contract.js';
import type { OrganizationRecordingPolicyV1 } from '../../src/application/organization-recording-policy.js';

export const RECORD_FIXTURE_NOW = '2026-08-08T12:00:00.000Z';
export const RECORD_FIXTURE_LEASE_TTL_MS = 5 * 60 * 1000;
export const RECORD_MEETING_ID = 'granola:meeting-2026-08-08-pricing';
export const RECORD_SOURCE = Object.freeze({
  adapter_id: 'granola',
  instance_id: 'primary',
  external_id: 'granola-2026-08-08-pricing',
});

const SLACK_TOOL_CONFIGURATION_JSON =
  '{"channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';
const SLACK_BINDING_CONFIGURATION_JSON =
  '{"approve_reaction":"white_check_mark","channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';

export function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function approvalId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

class FixtureClock implements AuthorityClock {
  constructor(private current: number) {}

  now(): string {
    return new Date(this.current).toISOString();
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

class FixtureIdentifiers implements AuthorityIdentifierGenerator {
  next(prefix: 'prn' | 'mem' | 'enr'): string {
    return federationId(prefix);
  }
}

interface FixtureKey {
  descriptor: P256SigningKeyDescriptor;
  privateKey: KeyObject;
}

function fixtureKey(): FixtureKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('fixture key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicBytes.toString('base64'),
    },
    privateKey: pair.privateKey,
  };
}

function signWith(key: FixtureKey, bytes: Buffer): Buffer {
  return normalizeP256LowS(
    signMessage('sha256', bytes, { key: key.privateKey, dsaEncoding: 'der' }),
  );
}

class FixtureAuthoritySigner implements OrganizationAuthoritySigner {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  /** Signs the wrong bytes, exactly as a subtly broken signer would. */
  corrupt = false;

  constructor(private readonly key: FixtureKey) {
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: federationId('oau'),
      organization_id: federationId('org'),
      signing_key: key.descriptor,
    };
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    return JSON.parse(
      canonicalJson(this.descriptor),
    ) as OrganizationAuthorityDescriptorV1;
  }

  async sign(message: Buffer, expectedKeyId: Sha256Digest): Promise<Buffer> {
    if (expectedKeyId !== this.key.descriptor.key_id) {
      throw new Error('wrong fixture authority key');
    }
    return signWith(
      this.key,
      this.corrupt ? Buffer.concat([message, Buffer.from([0])]) : message,
    );
  }
}

export function recordBrief(
  overrides: Partial<OrganizationRecordDecisionBriefV1> = {},
): OrganizationRecordDecisionBriefV1 {
  return {
    schema_version: 1,
    id: 'brief-pricing',
    meeting: {
      id: RECORD_MEETING_ID,
      title: 'Pricing review',
      participants: [
        {
          id: 'participant-1',
          display_name: 'Ada Founder',
          identities: [{ kind: 'email', value: 'ada@example.test' }],
          roles: ['organizer'],
          response_status: 'accepted',
          attendance: 'attended',
        },
      ],
    },
    decisions: [
      {
        id: 'signal-decision-1',
        kind: 'decision',
        text: 'Adopt usage-based pricing.',
        subject: 'pricing',
        confidence: 1,
        evidence: [{ meeting_id: RECORD_MEETING_ID, block_id: 'block-12' }],
        status: 'decided',
      },
    ],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: RECORD_FIXTURE_NOW,
    },
    ...overrides,
  } as OrganizationRecordDecisionBriefV1;
}

export interface RecordIngestFixture {
  readonly application: OrganizationAuthorityApplication;
  /** Test-only handle for asserting the durable publication/audit transition. */
  readonly authorityRepository: SqliteOrganizationAuthorityRepository;
  readonly integrations: OrganizationIntegrationsRepository;
  readonly runtime: OrganizationRecordRuntime;
  readonly clock: FixtureClock;
  readonly directory: string;
  readonly installationId: string;
  readonly principalId: string;
  readonly membershipId: string;
  readonly enrollmentId: string;
  readonly otherPrincipalId: string;
  readonly otherMembershipId: string;
  readonly otherEnrollmentId: string;
  readonly authorityId: string;
  readonly organizationId: string;
  readonly recordLogDatabasePath: string;
  readonly recordDerivedDatabasePath: string;
  readonly organizationRecordingPolicy: OrganizationRecordingPolicyV1;
  /** Every post-start derive failure the record runtime signalled to its host. */
  readonly fatalFailures: readonly Error[];
  /** Appends one real allowed audit row and returns the matching evidence. */
  authorize(input: {
    approval_id: string;
    action: 'approve' | 'reject';
    permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProofV1;
  }): OrganizationRecordReviewerAuthorizationV1;
  approvalEnvelope(input: {
    approval_id: string;
    authorization: OrganizationRecordReviewerAuthorizationV1;
    brief?: OrganizationRecordDecisionBriefV1;
    submitted_at?: string;
  }): Promise<OrganizationRecordApprovalEnvelopeV1>;
  rejectionEnvelope(input: {
    approval_id: string;
    authorization: OrganizationRecordReviewerAuthorizationV1;
    reason?: string | null;
  }): Promise<OrganizationRecordRejectionEnvelopeV1>;
  signEnvelopeBytes(bytes: Buffer): Buffer;
  /** Writes the existing development installation key in server-runtime form. */
  writeProcessingInstallationKeyState(): string;
  revokeInstallation(): Promise<void>;
  /** Expires the current access lease without revoking anything. */
  expireAccessLease(): void;
  /** Makes the authority signing key sign the wrong bytes, and back again. */
  corruptAuthoritySignatures(corrupt: boolean): void;
  /** A second authorized org member, enrolled on no installation of its own. */
  authorizeOtherMember(input: {
    approval_id: string;
    action: 'approve' | 'reject';
    permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProofV1;
  }): OrganizationRecordReviewerAuthorizationV1;
  approvalEnvelopeFor(input: {
    approval_id: string;
    authorization: OrganizationRecordReviewerAuthorizationV1;
    reviewer_principal_id?: string;
    reviewer_membership_id?: string;
  }): Promise<OrganizationRecordApprovalEnvelopeV1>;
  /** Records one exact reviewer proof and returns its signed v2 envelope. */
  reviewerApprovalEnvelope(input: {
    approval_id: string;
    brief?: OrganizationRecordDecisionBriefV1;
  }): Promise<OrganizationRecordReviewerApprovalEnvelopeV2>;
  /** Runs the real v3 permission check/audit and returns its signed envelope. */
  organizationMemberApprovalEnvelope(input: {
    approval_id: string;
    brief?: OrganizationRecordDecisionBriefV1;
  }): Promise<OrganizationRecordOrganizationMemberApprovalEnvelopeV3>;
  reviewerRecentDecisionsRequest(): Promise<OrganizationReviewerRecentDecisionsRequestV1>;
  otherReviewerRecentDecisionsRequest(): Promise<OrganizationReviewerRecentDecisionsRequestV1>;
  readableSearchRequest(query: string): Promise<OrganizationReadableSearchRequestV1>;
  otherReadableSearchRequest(query: string): Promise<OrganizationReadableSearchRequestV1>;
  /** Enrolls a replacement current member after test records exist. */
  replacementReadableSearchRequest(query: string): Promise<OrganizationReadableSearchRequestV1>;
  close(): Promise<void>;
}

export interface CreateRecordIngestFixtureOptions {
  /** Creates the immutable two-member marker before the runtime starts. */
  readonly activatePermissionPilot?: boolean;
  /** Test-only central gate state. Production obtains this from activation. */
  readonly organizationMemberRecordingPolicy?:
    | 'active'
    | 'absent'
    | 'mismatched';
}

/**
 * A whole authority process's worth of record ingest: a real authority
 * application, a real control-plane audit, and the real record runtime over two
 * real SQLite files. Nothing here is faked, so an evidence lookup that only
 * appears to work would fail against the audit the Authority actually writes.
 */
export async function createRecordIngestFixture(
  options: CreateRecordIngestFixtureOptions = {},
): Promise<RecordIngestFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'echo-record-ingest-'));
  chmodSync(directory, 0o700);
  const clock = new FixtureClock(Date.parse(RECORD_FIXTURE_NOW));
  const signer = new FixtureAuthoritySigner(fixtureKey());
  const repository = new SqliteOrganizationAuthorityRepository(
    join(directory, 'authority.sqlite'),
  );
  const application = await OrganizationAuthorityApplication.create({
    repository,
    signer,
    clock,
    identifiers: new FixtureIdentifiers(),
    independently_trusted_authority_pin: organizationAuthorityPinSha256(
      signer.descriptor,
    ),
    organization_display_name: 'Example Company',
    active_lease_ttl_ms: RECORD_FIXTURE_LEASE_TTL_MS,
    access_request_maximum_age_ms: 5 * 60 * 1000,
  });
  const authorityId = signer.descriptor.authority_id;
  const organizationId = signer.descriptor.organization_id;

  const membership = application.provisionMembership({
    command_id: `adm_${randomUUID()}`,
    display_name: 'Ada Founder',
    membership_type: 'employee',
  });
  // The pilot marker binds the complete two-person audience before the record
  // runtime opens. Grace also owns an independent installation so the reviewer
  // lifecycle can prove that a different current member receives audited empty
  // bytes without gaining access to Ada's selected record content.
  const otherMember = application.provisionMembership({
    command_id: `adm_${randomUUID()}`,
    display_name: 'Grace Reviewer',
    membership_type: 'employee',
  });
  const grant = Uint8Array.from(randomBytes(32));
  const grantSha256 = organizationEnrollmentGrantSha256(grant);
  application.issueEnrollmentGrant(membership.membership_id, {
    command_id: `adm_${randomUUID()}`,
    enrollment_grant_sha256: grantSha256,
    lifetime_seconds: 3600,
  });
  const installation = fixtureKey();
  const installationId = federationId('ins');
  const pinned = verifyOrganizationAuthorityPin(
    application.descriptor(),
    application.authorityPinSha256(),
  );
  const enrollmentRequest = await createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: grantSha256,
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      installation_id: installationId,
      installation_signing_key: installation.descriptor,
    },
    pinned,
    async (bytes) => signWith(installation, bytes),
  );
  clock.advance(1);
  const enrolled = await application.completeEnrollment({
    enrollment_grant: grant,
    enrollment_request: enrollmentRequest,
  });
  const enrollmentId = enrolled.enrollment_receipt.enrollment_id;

  const writeProcessingInstallationKeyState = (): string => {
    const credentialDirectory = join(
      directory,
      'credentials',
      'processing',
    );
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    const path = join(
      credentialDirectory,
      'installation-key-state.v1.json',
    );
    const privateKey = installation.privateKey.export({
      format: 'der',
      type: 'pkcs8',
    });
    if (!Buffer.isBuffer(privateKey)) {
      throw new Error('fixture installation private key export failed');
    }
    writeFileSync(
      path,
      canonicalJson({
        schema_version: 1,
        descriptor: {
          installation_id: installationId,
          ...installation.descriptor,
          protection: 'development-file',
          assurance: 'software_key_development_only',
          private_key_exportable: true,
        },
        private_key_pkcs8_der_base64: privateKey.toString('base64'),
      }),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    return path;
  };

  // Grace owns a separate current installation for the negative reviewer-read
  // half of the lifecycle. The Slack approval binding below remains Ada's:
  // installation identity and later read identity are intentionally distinct.
  const otherGrant = Uint8Array.from(randomBytes(32));
  const otherGrantSha256 = organizationEnrollmentGrantSha256(otherGrant);
  application.issueEnrollmentGrant(otherMember.membership_id, {
    command_id: `adm_${randomUUID()}`,
    enrollment_grant_sha256: otherGrantSha256,
    lifetime_seconds: 3600,
  });
  const otherInstallation = fixtureKey();
  const otherInstallationId = federationId('ins');
  const otherEnrollmentRequest = await createOrganizationEnrollmentRequest(
    {
      enrollment_grant_sha256: otherGrantSha256,
      principal_id: otherMember.principal_id,
      membership_id: otherMember.membership_id,
      installation_id: otherInstallationId,
      installation_signing_key: otherInstallation.descriptor,
    },
    pinned,
    async (bytes) => signWith(otherInstallation, bytes),
  );
  clock.advance(1);
  const otherEnrolled = await application.completeEnrollment({
    enrollment_grant: otherGrant,
    enrollment_request: otherEnrollmentRequest,
  });
  const otherEnrollmentId = otherEnrolled.enrollment_receipt.enrollment_id;

  const controlDatabase = openOrganizationControlDatabase(':memory:');
  controlDatabase
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      authorityId,
      application.authorityPinSha256(),
      RECORD_FIXTURE_NOW,
    );
  const integrations = new OrganizationIntegrationsRepository(controlDatabase, {
    organization_id: organizationId,
    authority_id: authorityId,
  });
  // The audit row an allowed evaluation writes references a real binding and
  // grant, so the fixture seeds the same rows the Slack onboarding flow leaves
  // behind. Without them the foreign keys — not the lookup — would decide the
  // outcome, and the evidence test would prove nothing.
  const attemptId = 'cat_record-fixture-attempt';
  const connectionId = 'con_record-fixture';
  const adapterBindingId = federationId('bnd');
  const grantIds = {
    approve: `pgr_${randomUUID()}`,
    reject: `pgr_${randomUUID()}`,
  } as const;
  const scopesJson =
    '["channels:history","channels:read","chat:write","reactions:read","users:read"]';
  controlDatabase
    .prepare(
      `INSERT INTO organization_connection_attempts (
         connection_attempt_id, organization_id, requested_by_principal_id,
         requested_by_membership_id, attempt_purpose, target_owner_kind,
         target_principal_id, target_membership_id, provider, provider_issuer,
         provider_tenant_kind, provider_tenant_id, redirect_uri,
         requested_scopes_json, requested_scopes_sha256, state_sha256,
         nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
         provider_subject_kind, provider_subject_id, granted_scopes_json,
         granted_scopes_sha256, verification_evidence_sha256, created_at,
         expires_at, consumed_at, outcome_reason
       ) VALUES (
         ?, ?, ?, ?, 'tool_connection', 'organization', NULL, NULL,
         'slack', 'https://slack.com', 'workspace', 'T12345678',
         'https://authority.invalid/callback', ?, ?, ?, ?, ?, ?, 'pending',
         NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL
       )`,
    )
    .run(
      attemptId,
      organizationId,
      membership.principal_id,
      membership.membership_id,
      scopesJson,
      digest(scopesJson),
      digest('state'),
      digest('nonce'),
      digest('pkce'),
      digest('admin-session'),
      RECORD_FIXTURE_NOW,
      new Date(Date.parse(RECORD_FIXTURE_NOW) + 600_000).toISOString(),
    );
  controlDatabase
    .prepare(
      `UPDATE organization_connection_attempts
       SET status = 'succeeded', provider_subject_kind = 'service_account',
           provider_subject_id = 'U12345679', granted_scopes_json = ?,
           granted_scopes_sha256 = ?, verification_evidence_sha256 = ?,
           consumed_at = ?
       WHERE connection_attempt_id = ?`,
    )
    .run(
      scopesJson,
      digest(scopesJson),
      digest('verification-evidence'),
      RECORD_FIXTURE_NOW,
      attemptId,
    );
  controlDatabase
    .prepare(
      `INSERT INTO organization_tool_connections (
         connection_id, organization_id, connection_kind, owner_kind,
         owner_principal_id, owner_membership_id, human_identity_link_id,
         provider, provider_issuer, provider_tenant_kind, provider_tenant_id,
         provider_subject_kind, provider_subject_id, granted_scopes_json,
         granted_scopes_sha256, verification_attempt_id,
         verification_evidence_sha256, secret_backend_id, secret_handle_id,
         status, created_by_principal_id, created_by_membership_id,
         activated_at, revoked_at, revocation_reason,
         public_configuration_json, public_configuration_sha256
       ) VALUES (
         ?, ?, 'service_account', 'organization', NULL, NULL, NULL,
         'slack', 'https://slack.com', 'workspace', 'T12345678',
         'service_account', 'U12345679', ?, ?, ?, ?, 'authority-file-v1',
         'sch_record-fixture', 'active', ?, ?, ?, NULL, NULL, ?, ?
       )`,
    )
    .run(
      connectionId,
      organizationId,
      scopesJson,
      digest(scopesJson),
      attemptId,
      digest('verification-evidence'),
      membership.principal_id,
      membership.membership_id,
      RECORD_FIXTURE_NOW,
      SLACK_TOOL_CONFIGURATION_JSON,
      digest(SLACK_TOOL_CONFIGURATION_JSON),
    );
  controlDatabase
    .prepare(
      `INSERT INTO organization_adapter_bindings (
         adapter_binding_id, organization_id, product_namespace,
         installation_id, installation_key_id, adapter_kind, adapter_id,
         adapter_instance_id, adapter_version, connection_id,
         public_configuration_json, public_configuration_sha256, status,
         created_by_principal_id, created_by_membership_id, bound_at,
         revoked_at, revocation_reason
       ) VALUES (
         ?, ?, 'echo-brain', ?, ?, 'approval-surface', 'slack-reactions',
         'primary', '1.0.0', ?, ?, ?, 'active', ?, ?, ?, NULL, NULL
       )`,
    )
    .run(
      adapterBindingId,
      organizationId,
      installationId,
      installation.descriptor.key_id,
      connectionId,
      SLACK_BINDING_CONFIGURATION_JSON,
      digest(SLACK_BINDING_CONFIGURATION_JSON),
      membership.principal_id,
      membership.membership_id,
      RECORD_FIXTURE_NOW,
    );
  const identityAttemptId = 'cat_record-fixture-human-attempt';
  const identityLinkId = federationId('clm');
  const identityScopesJson = '["identity.basic"]';
  const identityEvidenceSha256 = digest('human-verification-evidence');
  controlDatabase
    .prepare(
      `INSERT INTO organization_connection_attempts (
         connection_attempt_id, organization_id, requested_by_principal_id,
         requested_by_membership_id, attempt_purpose, target_owner_kind,
         target_principal_id, target_membership_id, provider, provider_issuer,
         provider_tenant_kind, provider_tenant_id, redirect_uri,
         requested_scopes_json, requested_scopes_sha256, state_sha256,
         nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
         provider_subject_kind, provider_subject_id, granted_scopes_json,
         granted_scopes_sha256, verification_evidence_sha256, created_at,
         expires_at, consumed_at, outcome_reason
       ) VALUES (
         ?, ?, ?, ?, 'identity_link', 'membership', ?, ?, 'slack',
         'https://slack.com', 'workspace', 'T12345678',
         'https://authority.invalid/callback', ?, ?, ?, ?, ?, ?, 'pending',
         NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL
       )`,
    )
    .run(
      identityAttemptId,
      organizationId,
      membership.principal_id,
      membership.membership_id,
      membership.principal_id,
      membership.membership_id,
      identityScopesJson,
      digest(identityScopesJson),
      digest('identity-state'),
      digest('identity-nonce'),
      digest('identity-pkce'),
      digest('identity-admin-session'),
      RECORD_FIXTURE_NOW,
      new Date(Date.parse(RECORD_FIXTURE_NOW) + 600_000).toISOString(),
    );
  controlDatabase
    .prepare(
      `UPDATE organization_connection_attempts
       SET status = 'succeeded', provider_subject_kind = 'human_user',
           provider_subject_id = 'U12345678', granted_scopes_json = ?,
           granted_scopes_sha256 = ?, verification_evidence_sha256 = ?,
           consumed_at = ?
       WHERE connection_attempt_id = ?`,
    )
    .run(
      identityScopesJson,
      digest(identityScopesJson),
      identityEvidenceSha256,
      RECORD_FIXTURE_NOW,
      identityAttemptId,
    );
  controlDatabase
    .prepare(
      `INSERT INTO organization_external_identity_links (
         identity_link_id, organization_id, principal_id, membership_id,
         provider, provider_issuer, provider_tenant_kind, provider_tenant_id,
         provider_subject_id, verification_attempt_id,
         verification_evidence_sha256, status, verified_at, revoked_at,
         revocation_reason
       ) VALUES (?, ?, ?, ?, 'slack', 'https://slack.com', 'workspace',
                 'T12345678', 'U12345678', ?, ?, 'active', ?, NULL, NULL)`,
    )
    .run(
      identityLinkId,
      organizationId,
      membership.principal_id,
      membership.membership_id,
      identityAttemptId,
      identityEvidenceSha256,
      RECORD_FIXTURE_NOW,
    );
  for (const action of ['approve', 'reject'] as const) {
    controlDatabase
      .prepare(
        `INSERT INTO organization_permission_grants (
           permission_grant_id, organization_id, adapter_binding_id,
           principal_id, membership_id, action, resource_scope_json, status,
           granted_by_principal_id, granted_by_membership_id, granted_at,
           revoked_at, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        grantIds[action],
        organizationId,
        adapterBindingId,
        membership.principal_id,
        membership.membership_id,
        action,
        membership.principal_id,
        membership.membership_id,
        RECORD_FIXTURE_NOW,
      );
  }

  const reviewerSecrets: OrganizationSecretStore = {
    create: () => {
      throw new Error('reviewer lifecycle does not create credentials');
    },
    read: () => 'xoxb-record-fixture',
    listReferences: () => [],
    remove: () => {
      throw new Error('reviewer lifecycle does not remove credentials');
    },
  };
  const reviewerSlack: SlackIntegrationProvider = {
    verifyConnection: async () => {
      throw new Error('reviewer lifecycle does not verify a new connection');
    },
    verifyChannel: async () => {
      throw new Error('reviewer lifecycle does not verify a new channel');
    },
    verifyHuman: async (_token, userId) => ({
      team_id: 'T12345678',
      user_id: userId,
      verification_evidence_sha256: digest('reviewer-human'),
    }),
    verifyReaction: async (_token, verification) => {
      const organizationMember =
        verification.expected_organization_member_presentation;
      const organizationMemberEvent =
        verification.organization_member_provider_event_sha256;
      if (organizationMember !== null && organizationMember !== undefined) {
        if (organizationMemberEvent === undefined) {
          throw new Error('organization-member lifecycle expected a provider event');
        }
        return {
          observed: true,
          presentation_candidate_observed: true,
          message_presentation_sha256: null,
          organization_member_presentation: {
            release_draft_sha256:
              organizationMember.release_draft_sha256,
            approval_presentation_sha256:
              organizationMember.approval_presentation_sha256,
            message_presentation_sha256: canonicalSha256(
              organizationMemberMessagePresentationPreimage({
                provider_event_sha256: organizationMemberEvent,
                approval_presentation_sha256:
                  organizationMember.approval_presentation_sha256,
                team_id: verification.expected_team_id,
                enterprise_id: verification.expected_enterprise_id,
                bot_user_id: verification.expected_bot_user_id,
                bot_id: verification.expected_bot_id,
                app_id: verification.expected_app_id ?? 'A12345678',
                actor_user_id: verification.user_id,
                channel_id: verification.channel_id,
                message_ts: verification.message_ts,
                reaction_name: verification.reaction_name,
              }),
            ),
          },
        };
      }
      const expected = verification.expected_reviewer_presentation;
      const providerEventSha256 =
        verification.reviewer_provider_event_sha256;
      if (expected === null || expected === undefined || providerEventSha256 === undefined) {
        throw new Error('reviewer lifecycle expected a reviewer presentation');
      }
      return {
        observed: true,
        presentation_candidate_observed: false,
        message_presentation_sha256: null,
        reviewer_presentation: {
          reviewer_release_draft_sha256:
            expected.reviewer_release_draft_sha256,
          approval_presentation_sha256:
            expected.approval_presentation_sha256,
          message_presentation_sha256: canonicalSha256(
            reviewerMessagePresentationPreimage({
              provider_event_sha256: providerEventSha256,
              approval_presentation_sha256:
                expected.approval_presentation_sha256,
              team_id: verification.expected_team_id,
              enterprise_id: verification.expected_enterprise_id,
              bot_user_id: verification.expected_bot_user_id,
              bot_id: verification.expected_bot_id,
              app_id: verification.expected_app_id ?? 'A12345678',
              actor_user_id: verification.user_id,
              channel_id: verification.channel_id,
              message_ts: verification.message_ts,
              reaction_name: verification.reaction_name,
            }),
          ),
        },
      };
    },
    postIdentityLinkChallenge: async () => {
      throw new Error('reviewer lifecycle does not post an identity challenge');
    },
    observeIdentityLinkChallenge: async () => {
      throw new Error(
        'reviewer lifecycle does not observe an identity challenge',
      );
    },
  };
  const organizationRecordingPolicy = {
    schema_version: 1,
    kind: 'organization-recording-policy-v1',
    decision_processor_adapter_instance_id: 'default',
    approval_surface_adapter_instance_id: 'primary',
    presentation_mode: 'organization-member-readable-v1',
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
  } as const;
  const reviewerPermissionApplication =
    new ComposedOrganizationIntegrationsApplication({
      authority: application,
      repository: integrations,
      secrets: reviewerSecrets,
      slack: reviewerSlack,
      permissionPilotHealth: { kind: 'absent' },
      organizationRecordingPolicy,
      now: () => clock.now(),
    });

  const recordLogDatabasePath = join(directory, 'record-log.sqlite');
  const recordDerivedDatabasePath = join(directory, 'record-derived.sqlite');
  if (options.activatePermissionPilot === true) {
    // Runtime startup is read-only with respect to activation. Materialize the
    // record database, then perform the same stopped-state marker write the
    // operator command owns before opening the live runtime.
    OrganizationRecordLogStore.open(recordLogDatabasePath, {
      organization_id: organizationId,
      authority_id: authorityId,
    }).close();
    const audience = validateOrganizationPermissionPilotAudience(
      [
        {
          membership_id: membership.membership_id,
          label: 'Ada Founder',
        },
        {
          membership_id: otherMember.membership_id,
          label: 'Grace Reviewer',
        },
      ].sort((left, right) =>
        left.membership_id.localeCompare(right.membership_id),
      ),
    );
    const requestedAt = clock.now();
    const command: OrganizationPermissionPilotActivationCommandV1 = {
      schema_version: 1,
      kind: ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND,
      command_id: `ppa_${randomUUID()}`,
      authority_id: authorityId,
      organization_id: organizationId,
      policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
      presentation_policy_id:
        ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
      audience,
      requested_at: requestedAt,
      reason: 'Activate the two-person organization-record test pilot.',
    };
    const pilotLog = OrganizationPermissionPilotLog.open(
      recordLogDatabasePath,
      { organization_id: organizationId, authority_id: authorityId },
    );
    try {
      pilotLog.activate({
        command,
        command_sha256: organizationPermissionPilotCommandSha256(command),
        activated_at: requestedAt,
      });
    } finally {
      pilotLog.close();
    }
  }
  const fatalFailures: Error[] = [];
  const runtimeRecordingPolicy: OrganizationRecordingPolicyV1 | undefined =
    options.organizationMemberRecordingPolicy === 'absent'
      ? undefined
      : options.organizationMemberRecordingPolicy === 'mismatched'
        ? {
            ...organizationRecordingPolicy,
            presentation_mode: 'restricted-reviewer-v1',
            policy_contract_sha256: reviewerPolicyContractSha256(),
          }
        : organizationRecordingPolicy;
  const runtime = await openOrganizationRecordRuntime({
    authority: application,
    evidence: integrations,
    organization_id: organizationId,
    authority_id: authorityId,
    record_log_database_path: recordLogDatabasePath,
    record_derived_database_path: recordDerivedDatabasePath,
    ...(runtimeRecordingPolicy === undefined
      ? {}
      : { organization_recording_policy_v1: runtimeRecordingPolicy }),
    alert: () => undefined,
    onFatal: (failure) => fatalFailures.push(failure),
  });

  // A second organization member who approves in the same shared Slack channel
  // but owns no installation. Its grants sit on the very same adapter binding,
  // because that binding is the channel, not the machine.
  const otherGrantIds = {
    approve: `pgr_${randomUUID()}`,
    reject: `pgr_${randomUUID()}`,
  } as const;
  for (const action of ['approve', 'reject'] as const) {
    controlDatabase
      .prepare(
        `INSERT INTO organization_permission_grants (
           permission_grant_id, organization_id, adapter_binding_id,
           principal_id, membership_id, action, resource_scope_json, status,
           granted_by_principal_id, granted_by_membership_id, granted_at,
           revoked_at, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        otherGrantIds[action],
        organizationId,
        adapterBindingId,
        otherMember.principal_id,
        otherMember.membership_id,
        action,
        membership.principal_id,
        membership.membership_id,
        RECORD_FIXTURE_NOW,
      );
  }

  let evaluations = 0;
  const authorizeAs = (
    reviewer: { principal_id: string; membership_id: string },
    grants: Readonly<Record<'approve' | 'reject', string>>,
    input: {
      approval_id: string;
      action: 'approve' | 'reject';
      permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProofV1;
    },
  ): OrganizationRecordReviewerAuthorizationV1 => {
    evaluations += 1;
    const requestId = `pcr_${randomUUID()}`;
    const evaluatedAt = clock.now();
    const reasonCode: OrganizationPermissionReasonCode =
      input.permission_pilot_eligibility === undefined
        ? 'active_membership_and_direct_grant'
        : ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE;
    const evidence: OrganizationRecordReviewerAuthorizationV1 = {
      schema_version: 1,
      kind: 'echo-organization-authorization-evidence',
      authority_id: authorityId,
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      installation_id: installationId,
      request_id: requestId,
      approval_id: input.approval_id,
      action: input.action,
      request_sha256: digest(`request-${evaluations}`),
      provider_event_sha256: digest(`provider-event-${evaluations}`),
      allowed: true,
      reason_code: reasonCode,
      principal_id: reviewer.principal_id,
      membership_id: reviewer.membership_id,
      adapter_binding_id: adapterBindingId,
      permission_grant_id: grants[input.action],
      evaluated_at: evaluatedAt,
    };
    // The real writer, not a hand-rolled INSERT: the lookup must match the
    // exact shape the Authority appends when it allows an approval action.
    integrations.recordPermissionDecision({
      request_id: evidence.request_id,
      request_sha256: evidence.request_sha256,
      provider_event_sha256: evidence.provider_event_sha256,
      action: evidence.action,
      allowed: true,
      reason_code: reasonCode,
      principal_id: evidence.principal_id,
      membership_id: evidence.membership_id,
      adapter_binding_id: evidence.adapter_binding_id,
      permission_grant_id: evidence.permission_grant_id,
      evaluated_at: evidence.evaluated_at,
      authority_evidence_sha256: digest(`authority-status-${evaluations}`),
      authority_checked_at: evidence.evaluated_at,
      organization_id: organizationId,
      caller_principal_id: evidence.principal_id,
      caller_membership_id: evidence.membership_id,
      installation_id: installationId,
      identity_link_id: null,
      connection_id: null,
      approval_id: evidence.approval_id,
      detail: {
        provider: 'slack',
        provider_tenant_id: 'T12345678',
        provider_subject_id: 'U12345678',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        channel_id: 'C12345678',
        message_ts: '1721678400.123456',
        reaction_name: 'white_check_mark',
        ...(input.permission_pilot_eligibility === undefined
          ? {}
          : {
              presentation_policy_id:
                input.permission_pilot_eligibility.presentation_policy_id,
              audience_notice_sha256:
                input.permission_pilot_eligibility.audience_notice_sha256,
              message_presentation_sha256:
                input.permission_pilot_eligibility
                  .message_presentation_sha256,
            }),
      },
    });
    return evidence;
  };
  const authorize = (input: {
    approval_id: string;
    action: 'approve' | 'reject';
    permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProofV1;
  }): OrganizationRecordReviewerAuthorizationV1 =>
    authorizeAs(membership, grantIds, input);
  const authorizeOtherMember = (input: {
    approval_id: string;
    action: 'approve' | 'reject';
    permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProofV1;
  }): OrganizationRecordReviewerAuthorizationV1 =>
    authorizeAs(otherMember, otherGrantIds, input);

  const reviewer = (authorization: OrganizationRecordReviewerAuthorizationV1) => ({
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    reviewed_by: 'Ada Founder',
    authorization,
  });

  const approvalEnvelopeWithReviewer = (input: {
    approval_id: string;
    authorization: OrganizationRecordReviewerAuthorizationV1;
    reviewer_principal_id?: string;
    reviewer_membership_id?: string;
  }): Promise<OrganizationRecordApprovalEnvelopeV1> =>
    createOrganizationRecordApprovalEnvelope(
      {
        envelope_id: organizationRecordEnvelopeId(),
        idempotency_key: input.approval_id,
        payload: {
          brief: recordBrief(),
          source: { ...RECORD_SOURCE },
          alternatives: [],
          links: null,
          reviewed_at: RECORD_FIXTURE_NOW,
          surface: 'slack-reactions',
        },
        reviewer: {
          ...reviewer(input.authorization),
          ...(input.reviewer_principal_id === undefined
            ? {}
            : { principal_id: input.reviewer_principal_id }),
          ...(input.reviewer_membership_id === undefined
            ? {}
            : { membership_id: input.reviewer_membership_id }),
        },
        intent: CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
        submitter: {
          installation_id: installationId,
          submitted_at: RECORD_FIXTURE_NOW,
        },
        installation_signing_key: installation.descriptor,
      },
      pinned,
      async (bytes) => signWith(installation, bytes),
    );

  const reviewerApprovalEnvelope = async (input: {
    approval_id: string;
    brief?: OrganizationRecordDecisionBriefV1;
  }): Promise<OrganizationRecordReviewerApprovalEnvelopeV2> => {
    const brief = input.brief ?? recordBrief();
    const draft = projectReviewerReleaseDraft({
      approval_id: input.approval_id,
      brief,
    });
    const presentation = reviewerApprovalPresentation({
      draft,
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
    });
    const draftSha256 = reviewerReleaseDraftSha256(draft);
    const presentationSha256 =
      reviewerApprovalPresentationSha256(presentation);
    const request = await createOrganizationReviewerPermissionCheckRequest(
      {
        request_id: `pcr_${randomUUID()}`,
        authority_id: authorityId,
        authority_key_id: enrolled.enrollment_receipt.authority_key_id,
        organization_id: organizationId,
        enrollment_id: enrollmentId,
        installation_id: installationId,
        installation_signing_key: installation.descriptor,
        provider: 'slack',
        provider_issuer: 'https://slack.com',
        provider_tenant_kind: 'workspace',
        provider_tenant_id: 'T12345678',
        provider_enterprise_id: null,
        provider_connection_subject_id: 'U12345679',
        provider_connection_bot_id: 'B12345678',
        provider_connection_app_id: 'A12345678',
        provider_subject_kind: 'human_user',
        provider_subject_id: 'U12345678',
        adapter_kind: 'approval-surface',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        adapter_version: '1.0.0',
        approval_id: input.approval_id,
        channel_id: 'C12345678',
        message_ts: '1721678400.123456',
        reaction_name: 'white_check_mark',
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
        reviewer_release_draft_sha256: draftSha256,
        approval_presentation_sha256: presentationSha256,
        requested_at: clock.now(),
      },
      async (bytes) => signWith(installation, bytes),
    );
    const decision = await reviewerPermissionApplication.checkReviewerPermission(
      request,
    );
    if (
      !decision.allowed ||
      decision.principal_id === null ||
      decision.membership_id === null ||
      decision.adapter_binding_id === null ||
      decision.permission_grant_id === null ||
      decision.authorization_audit_event_id === null ||
      decision.authorization_audit_entry_sha256 === null ||
      decision.reviewer_release_draft_sha256 === null ||
      decision.approval_presentation_sha256 === null ||
      decision.semantic_intent_sha256 === null ||
      decision.message_presentation_sha256 === null
    ) {
      throw new Error('reviewer lifecycle permission proof was not allowed');
    }
    const authorization: OrganizationRecordReviewerAuthorizationV2 = {
      schema_version: 2,
      kind: 'echo-organization-authorization-evidence',
      authority_id: authorityId,
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      installation_id: installationId,
      request_id: request.request_id,
      approval_id: input.approval_id,
      action: 'approve',
      request_sha256: decision.request_sha256,
      provider_event_sha256: decision.provider_event_sha256,
      allowed: true,
      reason_code: 'active_reviewer_restricted_notice_v1',
      principal_id: decision.principal_id,
      membership_id: decision.membership_id,
      adapter_binding_id: decision.adapter_binding_id,
      permission_grant_id: decision.permission_grant_id,
      evaluated_at: decision.evaluated_at,
      authorization_audit_event_id: decision.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        decision.authorization_audit_entry_sha256,
      reviewer_release_draft_sha256:
        decision.reviewer_release_draft_sha256,
      approval_presentation_sha256:
        decision.approval_presentation_sha256,
      semantic_intent_sha256: decision.semantic_intent_sha256,
      message_presentation_sha256: decision.message_presentation_sha256,
    };
    return createOrganizationRecordReviewerApprovalEnvelope(
      {
        envelope_id: organizationRecordEnvelopeId(),
        idempotency_key: input.approval_id,
        payload: {
          brief,
          source: { ...RECORD_SOURCE },
          alternatives: [],
          links: null,
          reviewed_at: decision.evaluated_at,
          surface: 'slack-reviewer-v1',
        },
        reviewer: {
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          reviewed_by: 'Ada Founder',
          authorization,
        },
        intent: organizationRecordReviewerIntent(
          decision.semantic_intent_sha256,
        ),
        submitter: {
          installation_id: installationId,
          submitted_at: decision.evaluated_at,
        },
        installation_signing_key: installation.descriptor,
      },
      pinned,
      async (bytes) => signWith(installation, bytes),
    );
  };

  const organizationMemberApprovalEnvelope = async (input: {
    approval_id: string;
    brief?: OrganizationRecordDecisionBriefV1;
  }): Promise<OrganizationRecordOrganizationMemberApprovalEnvelopeV3> => {
    const brief = input.brief ?? recordBrief();
    const draft = projectOrganizationMemberReadableReleaseDraft({
      approval_id: input.approval_id,
      brief,
    });
    const presentation = organizationMemberReadableApprovalPresentation({
      draft,
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
    });
    const request = await createOrganizationMemberReadablePermissionCheckRequest(
      {
        request_id: `pcr_${randomUUID()}`,
        authority_id: authorityId,
        authority_key_id: enrolled.enrollment_receipt.authority_key_id,
        organization_id: organizationId,
        enrollment_id: enrollmentId,
        installation_id: installationId,
        installation_signing_key: installation.descriptor,
        provider: 'slack',
        provider_issuer: 'https://slack.com',
        provider_tenant_kind: 'workspace',
        provider_tenant_id: 'T12345678',
        provider_enterprise_id: null,
        provider_connection_subject_id: 'U12345679',
        provider_connection_bot_id: 'B12345678',
        provider_connection_app_id: 'A12345678',
        provider_subject_kind: 'human_user',
        provider_subject_id: 'U12345678',
        adapter_kind: 'approval-surface',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        adapter_version: '1.0.0',
        approval_id: input.approval_id,
        channel_id: 'C12345678',
        message_ts: '1721678400.123456',
        reaction_name: 'white_check_mark',
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
        release_draft_sha256: organizationMemberReadableReleaseDraftSha256(draft),
        approval_presentation_sha256:
          organizationMemberReadableApprovalPresentationSha256(presentation),
        requested_at: clock.now(),
      },
      async (bytes) => signWith(installation, bytes),
    );
    const decision =
      await reviewerPermissionApplication.checkOrganizationMemberReadablePermission(
        request,
      );
    if (
      !decision.allowed ||
      decision.principal_id === null ||
      decision.membership_id === null ||
      decision.adapter_binding_id === null ||
      decision.permission_grant_id === null ||
      decision.authorization_audit_event_id === null ||
      decision.authorization_audit_entry_sha256 === null ||
      decision.release_draft_sha256 === null ||
      decision.approval_presentation_sha256 === null ||
      decision.semantic_intent_sha256 === null ||
      decision.message_presentation_sha256 === null
    ) {
      throw new Error('organization-member lifecycle permission proof was not allowed');
    }
    const authorization: OrganizationRecordOrganizationMemberAuthorizationV3 = {
      schema_version: 3,
      kind: 'echo-organization-authorization-evidence',
      policy_id: decision.policy_id,
      policy_contract_sha256: decision.policy_contract_sha256,
      authority_id: authorityId,
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      installation_id: installationId,
      request_id: request.request_id,
      approval_id: input.approval_id,
      action: 'approve',
      request_sha256: decision.request_sha256,
      provider_event_sha256: decision.provider_event_sha256,
      allowed: true,
      reason_code: 'active_organization_member_readable_notice_v1',
      principal_id: decision.principal_id,
      membership_id: decision.membership_id,
      adapter_binding_id: decision.adapter_binding_id,
      permission_grant_id: decision.permission_grant_id,
      evaluated_at: decision.evaluated_at,
      authorization_audit_event_id: decision.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        decision.authorization_audit_entry_sha256,
      release_draft_sha256: decision.release_draft_sha256,
      approval_presentation_sha256: decision.approval_presentation_sha256,
      semantic_intent_sha256: decision.semantic_intent_sha256,
      message_presentation_sha256: decision.message_presentation_sha256,
    };
    return createOrganizationRecordOrganizationMemberApprovalEnvelope(
      {
        envelope_id: organizationRecordEnvelopeId(),
        idempotency_key: input.approval_id,
        payload: {
          brief,
          source: { ...RECORD_SOURCE },
          alternatives: [],
          links: null,
          reviewed_at: decision.evaluated_at,
          surface: 'slack-organization-member-readable-v1',
        },
        reviewer: {
          principal_id: decision.principal_id,
          membership_id: decision.membership_id,
          reviewed_by: 'Ada Founder',
          authorization,
        },
        intent: organizationRecordOrganizationMemberIntent(
          decision.semantic_intent_sha256,
        ),
        submitter: {
          installation_id: installationId,
          submitted_at: decision.evaluated_at,
        },
        installation_signing_key: installation.descriptor,
      },
      pinned,
      async (bytes) => signWith(installation, bytes),
    );
  };

  const reviewerRecentDecisionsRequest = (
    receipt: typeof enrolled.enrollment_receipt,
    id: string,
    key: FixtureKey,
  ): Promise<OrganizationReviewerRecentDecisionsRequestV1> =>
    createOrganizationReviewerRecentDecisionsRequest(
      {
        request_id: `rrd_${randomUUID()}`,
        authority_id: receipt.authority_id,
        authority_key_id: receipt.authority_key_id,
        organization_id: receipt.organization_id,
        enrollment_id: receipt.enrollment_id,
        installation_id: id,
        installation_signing_key: key.descriptor,
        requested_at: clock.now(),
      },
      async (bytes) => signWith(key, bytes),
    );

  const readableSearchRequest = (
    receipt: typeof enrolled.enrollment_receipt,
    id: string,
    key: FixtureKey,
    query: string,
  ): Promise<OrganizationReadableSearchRequestV1> =>
    createOrganizationReadableSearchRequest(
      {
        request_id: `osq_${randomUUID()}`,
        authority_id: receipt.authority_id,
        authority_key_id: receipt.authority_key_id,
        organization_id: receipt.organization_id,
        enrollment_id: receipt.enrollment_id,
        installation_id: id,
        installation_signing_key: key.descriptor,
        query,
        requested_at: clock.now(),
      },
      async (bytes) => signWith(key, bytes),
    );

  let replacement:
    | {
        readonly receipt: typeof enrolled.enrollment_receipt;
        readonly installation_id: string;
        readonly key: FixtureKey;
      }
    | undefined;
  const replacementReadableSearchRequest = async (
    query: string,
  ): Promise<OrganizationReadableSearchRequestV1> => {
    if (replacement === undefined) {
      // This is deliberately deferred until a test calls it, so it represents
      // a real later/replacement enrollment rather than another reader that
      // happened to exist when the protected records were written.
      clock.advance(1);
      const member = application.provisionMembership({
        command_id: `adm_${randomUUID()}`,
        display_name: 'Lin Replacement',
        membership_type: 'employee',
      });
      const grant = Uint8Array.from(randomBytes(32));
      const grantSha256 = organizationEnrollmentGrantSha256(grant);
      application.issueEnrollmentGrant(member.membership_id, {
        command_id: `adm_${randomUUID()}`,
        enrollment_grant_sha256: grantSha256,
        lifetime_seconds: 3600,
      });
      const key = fixtureKey();
      const installationId = federationId('ins');
      const request = await createOrganizationEnrollmentRequest(
        {
          enrollment_grant_sha256: grantSha256,
          principal_id: member.principal_id,
          membership_id: member.membership_id,
          installation_id: installationId,
          installation_signing_key: key.descriptor,
        },
        pinned,
        async (bytes) => signWith(key, bytes),
      );
      clock.advance(1);
      const enrolledReplacement = await application.completeEnrollment({
        enrollment_grant: grant,
        enrollment_request: request,
      });
      replacement = {
        receipt: enrolledReplacement.enrollment_receipt,
        installation_id: installationId,
        key,
      };
    }
    return readableSearchRequest(
      replacement.receipt,
      replacement.installation_id,
      replacement.key,
      query,
    );
  };

  return {
    application,
    authorityRepository: repository,
    integrations,
    runtime,
    clock,
    directory,
    installationId,
    principalId: membership.principal_id,
    membershipId: membership.membership_id,
    enrollmentId,
    otherPrincipalId: otherMember.principal_id,
    otherMembershipId: otherMember.membership_id,
    otherEnrollmentId,
    authorityId,
    organizationId,
    recordLogDatabasePath,
    recordDerivedDatabasePath,
    organizationRecordingPolicy,
    fatalFailures,
    authorize,
    approvalEnvelope: (input) =>
      createOrganizationRecordApprovalEnvelope(
        {
          envelope_id: organizationRecordEnvelopeId(),
          idempotency_key: input.approval_id,
          payload: {
            brief: input.brief ?? recordBrief(),
            source: { ...RECORD_SOURCE },
            alternatives: [],
            links: null,
            reviewed_at: RECORD_FIXTURE_NOW,
            surface: 'slack-reactions',
          },
          reviewer: reviewer(input.authorization),
          intent: CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
          submitter: {
            installation_id: installationId,
            submitted_at: input.submitted_at ?? RECORD_FIXTURE_NOW,
          },
          installation_signing_key: installation.descriptor,
        },
        pinned,
        async (bytes) => signWith(installation, bytes),
      ),
    rejectionEnvelope: (input) =>
      createOrganizationRecordRejectionEnvelope(
        {
          envelope_id: organizationRecordEnvelopeId(),
          idempotency_key: input.approval_id,
          payload: {
            source: { ...RECORD_SOURCE },
            meeting_id: RECORD_MEETING_ID,
            rejected_at: RECORD_FIXTURE_NOW,
            reason: input.reason ?? 'Not yet.',
            reconsider_after: null,
          },
          reviewer: reviewer(input.authorization),
          submitter: {
            installation_id: installationId,
            submitted_at: RECORD_FIXTURE_NOW,
          },
          installation_signing_key: installation.descriptor,
        },
        pinned,
        async (bytes) => signWith(installation, bytes),
      ),
    signEnvelopeBytes: (bytes) => signWith(installation, bytes),
    writeProcessingInstallationKeyState,
    revokeInstallation: async () => {
      await application.revokeInstallation(installationId, 'fixture revocation');
    },
    // Nothing is revoked: the access state stays `active` and simply ages past
    // its `valid_until`, which is the exact shape a lapsed member machine has.
    expireAccessLease: () => {
      clock.advance(RECORD_FIXTURE_LEASE_TTL_MS + 1);
    },
    corruptAuthoritySignatures: (corrupt: boolean) => {
      signer.corrupt = corrupt;
    },
    authorizeOtherMember,
    approvalEnvelopeFor: approvalEnvelopeWithReviewer,
    reviewerApprovalEnvelope,
    organizationMemberApprovalEnvelope,
    reviewerRecentDecisionsRequest: () =>
      reviewerRecentDecisionsRequest(
        enrolled.enrollment_receipt,
        installationId,
        installation,
      ),
    otherReviewerRecentDecisionsRequest: () =>
      reviewerRecentDecisionsRequest(
        otherEnrolled.enrollment_receipt,
        otherInstallationId,
        otherInstallation,
      ),
    readableSearchRequest: (query) =>
      readableSearchRequest(
        enrolled.enrollment_receipt,
        installationId,
        installation,
        query,
      ),
    otherReadableSearchRequest: (query) =>
      readableSearchRequest(
        otherEnrolled.enrollment_receipt,
        otherInstallationId,
        otherInstallation,
        query,
      ),
    replacementReadableSearchRequest,
    async close(): Promise<void> {
      try {
        await runtime.close();
      } finally {
        integrations.close();
        application.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export type RecordEnvelopeFixture = OrganizationRecordEnvelopeV1;
