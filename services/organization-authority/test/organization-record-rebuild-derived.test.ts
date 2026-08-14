import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  canonicalJson,
  federationId,
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationRecordReviewerApprovalEnvelope,
  createOrganizationRecordOrganizationMemberApprovalEnvelope,
  organizationAuthorityPinSha256,
  organizationMemberReadablePolicyContractSha256,
  organizationMemberReadableApprovalPresentation,
  organizationMemberReadableApprovalPresentationSha256,
  organizationMemberReadableReleaseDraftSha256,
  organizationRecordEnvelopeId,
  organizationRecordOrganizationMemberIntent,
  organizationRecordReviewerIntent,
  projectOrganizationMemberReadableReleaseDraft,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
  verifyOrganizationAuthorityPin,
  type OrganizationAuthorityDescriptorV1,
} from '@echo-brain/organization-protocol';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  OrganizationRecordLogStore,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record/maintenance';
import { OrganizationRecordIngest } from '@echo-brain/organization-record/append';
import type { JsonObject } from '@echo-brain/organization-record';
import {
  createOrganizationMemberEligibilityCapabilityChannel,
  deriveOrganizationMemberReadableEligibilityProof,
} from '@echo-brain/organization-record/append';
import {
  buildStoppedReadableSearchGeneration,
  createReadableSearchAnalyzerDescriptor,
  readableSearchRetrievalContractSha256,
  readableSearchSourceBytesSha256,
} from '@echo-brain/organization-retrieval/build';
import {
  OrganizationIntegrationsRepository,
  openOrganizationControlDatabase,
  organizationMemberMessagePresentationPreimage,
  organizationMemberReadableAuditDetail,
  organizationMemberReadableSemanticPreimage,
  reviewerMessagePresentationPreimage,
  reviewerRestrictedAuditDetail,
  reviewerRestrictedSemanticPreimage,
} from '@echo-brain/organization-control-plane';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
} from '../src/composition/operator-config.js';
import {
  activateOrganizationMemberRecording,
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
  readableSearchReleaseDescriptor,
  rebuildAuthorityReadableSearch,
  rebuildAuthorityDerivedRecordStore,
  verifyAuthorityReadableSearchBackup,
} from '../src/composition/operator-state.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import { validateReadableSearchGenerationPublishedAuditDetail } from '../src/application/readable-search-persistence.js';
import { organizationMemberReadableEnvelopeValidator } from '../src/composition/organization-member-envelope-validator.js';
import { reviewerRestrictedEnvelopeValidator } from '../src/composition/reviewer-envelope-validator.js';
import { reviewerPolicyContractSha256 } from '../src/application/reviewer-policy-contract.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import type { OrganizationMemberRecordingActivationCommandV1 } from '../src/application/organization-recording-policy-activation.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { seedActiveSlackApprovalSurface } from './support/active-slack-approval-surface.js';
import { recordBrief } from './support/record-ingest-fixture.js';

const roots: string[] = [];
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fileIdentity(path: string): Record<string, number | string> {
  const state = statSync(path);
  return {
    dev: state.dev,
    ino: state.ino,
    size: state.size,
    mtime_ms: state.mtimeMs,
    ctime_ms: state.ctimeMs,
    mode: state.mode & 0o777,
    uid: state.uid,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function directoryIdentity(
  root: string,
): Record<string, Record<string, number | string>> {
  const result: Record<string, Record<string, number | string>> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = prefix === '' ? name : `${prefix}/${name}`;
      const state = lstatSync(path);
      if (state.isDirectory()) {
        result[`${relativePath}/`] = {
          mode: state.mode & 0o777,
          mtime_ms: state.mtimeMs,
          ctime_ms: state.ctimeMs,
        };
        visit(path, relativePath);
      } else {
        result[relativePath] = fileIdentity(path);
      }
    }
  };
  visit(root, '');
  return result;
}

function readableSearchBackupIdentity(
  paths: ReturnType<typeof authorityStatePaths>,
): Record<string, unknown> {
  return {
    authority: fileIdentity(paths.database_path),
    record: fileIdentity(paths.record_log_database_path),
    integrations: fileIdentity(paths.integrations_database_path),
    retrieval: directoryIdentity(join(paths.state_directory, 'record-retrieval')),
  };
}

function rejectionEnvelope(index: number): Record<string, unknown> {
  return {
    schema_version: 1,
    event_type: 'rejection',
    envelope_id: `rec_00000000-0000-4000-8000-00000000000${index}`,
    idempotency_key: String(index).repeat(64),
    payload: {
      schema_version: 1,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: `granola-meeting-${index}`,
      },
      meeting_id: `mtg_${index}`,
      rejected_at: '2026-08-08T12:00:00.000Z',
      reason: 'Not a shared decision yet',
      reconsider_after: null,
    },
    reviewer: { principal_id: 'prn_ada', reviewed_by: 'Ada Founder' },
    intent: { restricted: true },
    submitter: { installation_id: INSTALLATION_ID },
  };
}

function underivableEnvelope(index: number): Record<string, unknown> {
  const envelope = rejectionEnvelope(index);
  return { ...envelope, payload: null };
}

function appendRecord(
  config: AuthorityRuntimeConfigV1,
  envelope: Record<string, unknown>,
): void {
  const paths = authorityStatePaths(config.state_dir);
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
  });
  try {
    const canonicalEnvelope = canonicalJson(envelope as never);
    log.append({
      envelope: {
        envelope: envelope as never,
        envelope_id: envelope['envelope_id'] as string,
        event_type: envelope['event_type'] as 'approval' | 'rejection',
        idempotency_key: envelope['idempotency_key'] as string,
        installation_id: INSTALLATION_ID,
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: sha256Digest(canonicalEnvelope),
    });
  } finally {
    log.close();
  }
}

async function appendOrganizationMemberRecord(
  config: AuthorityRuntimeConfigV1,
): Promise<void> {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  const signingKey = {
    key_id: p256KeyId(publicBytes),
    algorithm: 'ecdsa-p256-sha256-der-low-s',
    public_key_spki_der_base64: publicBytes.toString('base64'),
  } as const;
  const authorityDescriptor = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    signing_key: signingKey,
  } as const;
  const pinned = verifyOrganizationAuthorityPin(
    authorityDescriptor,
    organizationAuthorityPinSha256(authorityDescriptor),
  );
  const approvalId = createHash('sha256')
    .update('stopped-rebuild-member-v3')
    .digest('hex');
  const brief = recordBrief();
  const evaluatedAt = '2026-08-08T12:00:00.000Z';
  const semanticIntentSha256 = sha256Digest('member semantic intent');
  const installationId = federationId('ins');
  const principalId = federationId('prn');
  const membershipId = federationId('mem');
  const releaseDraftSha256 = organizationMemberReadableReleaseDraftSha256(
    projectOrganizationMemberReadableReleaseDraft({
      approval_id: approvalId,
      brief,
    }),
  );
  const envelope = await createOrganizationRecordOrganizationMemberApprovalEnvelope(
    {
      envelope_id: organizationRecordEnvelopeId(),
      idempotency_key: approvalId,
      payload: {
        brief,
        source: {
          adapter_id: 'granola',
          instance_id: 'primary',
          external_id: 'stopped-rebuild-member-v3',
        },
        alternatives: [],
        links: null,
        reviewed_at: evaluatedAt,
        surface: 'slack-organization-member-readable-v1',
      },
      reviewer: {
        principal_id: principalId,
        membership_id: membershipId,
        reviewed_by: 'Ada Founder',
        authorization: {
          schema_version: 3,
          kind: 'echo-organization-authorization-evidence',
          policy_id: 'organization-member-readable-v1',
          policy_contract_sha256:
            organizationMemberReadablePolicyContractSha256(),
          authority_id: config.authority.authority_id,
          organization_id: config.organization.organization_id,
          enrollment_id: federationId('enr'),
          installation_id: installationId,
          request_id: `pcr_${randomUUID()}`,
          approval_id: approvalId,
          action: 'approve',
          request_sha256: sha256Digest('member request'),
          provider_event_sha256: sha256Digest('member provider event'),
          allowed: true,
          reason_code: 'active_organization_member_readable_notice_v1',
          principal_id: principalId,
          membership_id: membershipId,
          adapter_binding_id: federationId('bnd'),
          permission_grant_id: `pgr_${randomUUID()}`,
          evaluated_at: evaluatedAt,
          authorization_audit_event_id: `aud_${randomUUID()}`,
          authorization_audit_entry_sha256: sha256Digest('member audit entry'),
          release_draft_sha256: releaseDraftSha256,
          approval_presentation_sha256: sha256Digest('member presentation'),
          semantic_intent_sha256: semanticIntentSha256,
          message_presentation_sha256: sha256Digest('member provider presentation'),
        },
      },
      intent: organizationRecordOrganizationMemberIntent(
        semanticIntentSha256,
      ),
      submitter: {
        installation_id: installationId,
        submitted_at: evaluatedAt,
      },
      installation_signing_key: signingKey,
    },
    pinned,
    async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: keyPair.privateKey,
          dsaEncoding: 'der',
        }),
      ),
  );
  const document = envelope as unknown as JsonObject;
  const paths = authorityStatePaths(config.state_dir);
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
    organization_member_validator: organizationMemberReadableEnvelopeValidator({
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    }),
  });
  try {
    const canonicalEnvelope = canonicalJson(envelope);
    const envelopeSha256 = sha256Digest(canonicalEnvelope);
    const view = organizationMemberReadableEnvelopeValidator({
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    })(document);
    const proof = deriveOrganizationMemberReadableEligibilityProof({
      organization_id: config.organization.organization_id,
      canonical_envelope_sha256: envelopeSha256,
      envelope: view,
    });
    const channel = createOrganizationMemberEligibilityCapabilityChannel();
    log.append({
      envelope: {
        envelope: document,
        envelope_id: envelope.envelope_id,
        event_type: 'approval',
        idempotency_key: envelope.idempotency_key,
        installation_id: envelope.submitter.installation_id,
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: envelopeSha256,
      organization_member_eligibility: {
        capability: channel.issue(proof.preimage),
        channel,
      },
    });
  } finally {
    log.close();
  }
}

function derivedCursorPosition(databasePath: string): number {
  const database = openOrganizationRecordDatabase(
    databasePath,
    ORGANIZATION_RECORD_DERIVED_DATABASE,
    { readonly: true },
  );
  try {
    return (
      database
        .prepare(
          `SELECT last_position FROM organization_derived_cursor WHERE singleton = 1`,
        )
        .get() as { last_position: number }
    ).last_position;
  } finally {
    database.close();
  }
}

function rebuildingLeftovers(stateDirectory: string): string[] {
  return readdirSync(stateDirectory).filter((name) =>
    name.includes('.rebuilding-'),
  );
}

function expectNoRecordSidecars(
  paths: ReturnType<typeof authorityStatePaths>,
): void {
  for (const databasePath of [
    paths.record_log_database_path,
    paths.record_derived_database_path,
  ]) {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      expect(existsSync(`${databasePath}${suffix}`)).toBe(false);
    }
  }
}

function generationPublicationAudits(databasePath: string): readonly {
  readonly occurred_at: string;
  readonly subject_id: string;
  readonly detail: unknown;
}[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database
      .prepare(
        `SELECT occurred_at, subject_id, detail_json
         FROM authority_audit_log
         WHERE action = 'permission.readable_search_generation_published'
         ORDER BY audit_sequence ASC`,
      )
      .all() as readonly {
        readonly occurred_at: string;
        readonly subject_id: string;
        readonly detail_json: string;
      }[]).map((row) => ({
      occurred_at: row.occurred_at,
      subject_id: row.subject_id,
      detail: parseCanonicalJson(row.detail_json),
    }));
  } finally {
    database.close();
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no loopback port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function initializedFixture(): Promise<{
  configPath: string;
  config: AuthorityRuntimeConfigV1;
  stateDirectory: string;
  authorityDescriptor: OrganizationAuthorityDescriptorV1;
  authorityPinSha256: `sha256:${string}`;
}> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-record-rebuild-')),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  const initialized = await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
    port: await reserveLoopbackPort(),
  });
  return {
    configPath,
    config: readAuthorityRuntimeConfig(configPath),
    stateDirectory,
    authorityDescriptor: initialized.authority_descriptor,
    authorityPinSha256: initialized.authority_pin_sha256,
  };
}

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function bypassImmutableTrigger(
  database: Database.Database,
  triggerName: string,
  mutate: () => void,
): void {
  const row = database
    .prepare(
      `SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = ?`,
    )
    .get(triggerName) as { readonly sql: string | null } | undefined;
  if (row?.sql === null || row?.sql === undefined) {
    throw new Error(`test immutable trigger ${triggerName} is missing`);
  }
  database.exec(`DROP TRIGGER ${triggerName}`);
  try {
    mutate();
  } finally {
    database.exec(row.sql);
  }
}

function recordSigningKey(): {
  readonly descriptor: {
    readonly key_id: `sha256:${string}`;
    readonly algorithm: 'ecdsa-p256-sha256-der-low-s';
    readonly public_key_spki_der_base64: string;
  };
  sign(bytes: Buffer): Buffer;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  return Object.freeze({
    descriptor: Object.freeze({
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
      public_key_spki_der_base64: publicBytes.toString('base64'),
    }),
    sign(bytes: Buffer): Buffer {
      return normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      );
    },
  });
}

interface PolicyQualifiedBackupFixture
  extends Awaited<ReturnType<typeof initializedFixture>> {
  readonly reviewerAuditEventId: string;
  readonly memberAuditEventId: string;
}

/**
 * Produces one stopped, operator-shaped state containing a fully qualified v2
 * record and v3 record. The backup verifier must be able to re-prove these
 * facts from the real chained integration-audit repository before any test
 * mutates one side of the boundary.
 */
async function policyQualifiedBackupFixture(): Promise<PolicyQualifiedBackupFixture> {
  const fixture = await initializedFixture();
  const paths = authorityStatePaths(fixture.stateDirectory);
  const metadata = new Database(paths.database_path, { readonly: true });
  const lastObservedAt = (
    metadata
      .prepare(
        'SELECT last_observed_at FROM authority_metadata WHERE singleton = 1',
      )
      .get() as { last_observed_at: string }
  ).last_observed_at;
  metadata.close();
  const provisionedAt = plus(lastObservedAt, 1);
  const owner: StoredAuthorityMembership = {
    organization_id: fixture.config.organization.organization_id,
    principal_id: federationId('prn'),
    membership_id: federationId('mem'),
    display_name: 'Backup Owner',
    membership_type: 'owner',
    status: 'active',
    provisioned_at: provisionedAt,
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${randomUUID()}`,
    admin_command_sha256: canonicalSha256({
      schema_version: 1,
      kind: 'test-readable-search-backup-owner',
    }),
  };
  const authority = new SqliteOrganizationAuthorityRepository(
    paths.database_path,
    { fileMustExist: true, allowInitialization: false },
  );
  authority.initialize({
    descriptor: fixture.authorityDescriptor,
    authority_pin_sha256: fixture.authorityPinSha256,
    organization_display_name: fixture.config.organization.display_name,
    initialized_at: provisionedAt,
  });
  authority.write(provisionedAt, (transaction) => {
    transaction.insertMembership(owner);
  });
  authority.close();

  const installation = recordSigningKey();
  const installationId = federationId('ins');
  const surface = seedActiveSlackApprovalSurface({
    integrations_database_path: paths.integrations_database_path,
    organization_id: fixture.config.organization.organization_id,
    authority_id: fixture.config.authority.authority_id,
    owner,
    installation: {
      installation_id: installationId,
      installation_key_id: installation.descriptor.key_id,
    },
    adapter_instance_id: 'primary',
    activated_at: provisionedAt,
  });
  const manifest = JSON.parse(
    readFileSync(paths.initialization_manifest_path, 'utf8'),
  ) as { readonly runtime_config: unknown };
  const requestedAt = plus(provisionedAt, 1);
  const activation: OrganizationMemberRecordingActivationCommandV1 = {
    schema_version: 1,
    kind: 'echo-organization-member-recording-activation-command',
    command_id: `rpa_${randomUUID()}`,
    authority_id: fixture.config.authority.authority_id,
    organization_id: fixture.config.organization.organization_id,
    initialized_runtime_config_sha256: canonicalSha256(
      manifest.runtime_config as never,
    ),
    initialization_manifest_sha256: canonicalSha256(manifest as never),
    owner_principal_id: owner.principal_id,
    owner_membership_id: owner.membership_id,
    target_policy: {
      schema_version: 1,
      kind: 'organization-recording-policy-v1',
      decision_processor_adapter_instance_id: 'default',
      approval_surface_adapter_instance_id: 'primary',
      presentation_mode: 'organization-member-readable-v1',
      policy_contract_sha256:
        organizationMemberReadablePolicyContractSha256(),
    },
    requested_at: requestedAt,
    reason: 'Qualify readable-search backup verification.',
  };
  const activationPath = join(
    dirname(fixture.configPath),
    'activate-member-recording.json',
  );
  writeFileSync(activationPath, canonicalJson(activation as never), {
    mode: 0o600,
  });
  await activateOrganizationMemberRecording(
    fixture.configPath,
    activationPath,
    { now: () => requestedAt },
  );

  const control = openOrganizationControlDatabase(
    paths.integrations_database_path,
    { fileMustExist: true },
  );
  const integrations = new OrganizationIntegrationsRepository(control, {
    organization_id: fixture.config.organization.organization_id,
    authority_id: fixture.config.authority.authority_id,
  });
  const grantId = `pgr_${randomUUID()}`;
  control
    .prepare(
      `INSERT INTO organization_permission_grants (
         permission_grant_id, organization_id, adapter_binding_id,
         principal_id, membership_id, action, resource_scope_json, status,
         granted_by_principal_id, granted_by_membership_id, granted_at,
         revoked_at, revocation_reason
       ) VALUES (?, ?, ?, ?, ?, 'approve', '{}', 'active', ?, ?, ?, NULL, NULL)`,
    )
    .run(
      grantId,
      fixture.config.organization.organization_id,
      surface.adapter_binding_id,
      owner.principal_id,
      owner.membership_id,
      owner.principal_id,
      owner.membership_id,
      provisionedAt,
    );

  const brief = recordBrief();
  const pinned = verifyOrganizationAuthorityPin(
    fixture.authorityDescriptor,
    fixture.authorityPinSha256,
  );
  const commonProvider = {
    team_id: 'T12345678',
    enterprise_id: null,
    bot_user_id: 'U12345679',
    bot_id: 'B12345678',
    app_id: 'A12345678',
    actor_user_id: 'U12345678',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'primary',
    adapter_version: '1.0.0',
    channel_id: 'C12345678',
    message_ts: '1721678400.123456',
    reaction_name: 'white_check_mark',
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
  } as const;

  const reviewerApprovalId = createHash('sha256')
    .update('backup-reviewer-v2')
    .digest('hex');
  const reviewerDraft = projectReviewerReleaseDraft({
    approval_id: reviewerApprovalId,
    brief,
  });
  const reviewerPresentation = reviewerApprovalPresentation({
    draft: reviewerDraft,
    approve_reaction: commonProvider.approve_reaction,
    reject_reaction: commonProvider.reject_reaction,
  });
  const reviewerDraftSha256 = reviewerReleaseDraftSha256(reviewerDraft);
  const reviewerPresentationSha256 =
    reviewerApprovalPresentationSha256(reviewerPresentation);
  const reviewerRequestId = `pcr_${randomUUID()}`;
  const reviewerRequestSha256 = sha256Digest('backup reviewer request');
  const reviewerProviderEventSha256 = sha256Digest(
    'backup reviewer provider event',
  );
  const reviewerSemanticIntentSha256 = canonicalSha256(
    reviewerRestrictedSemanticPreimage({
      authority_id: fixture.config.authority.authority_id,
      organization_id: fixture.config.organization.organization_id,
      approval_id: reviewerApprovalId,
      reviewer_principal_id: owner.principal_id,
      reviewer_membership_id: owner.membership_id,
      reviewer_release_draft_sha256: reviewerDraftSha256,
      approval_presentation_sha256: reviewerPresentationSha256,
      evaluated_at: requestedAt,
    }),
  );
  const reviewerMessagePresentationSha256 = canonicalSha256(
    reviewerMessagePresentationPreimage({
      provider_event_sha256: reviewerProviderEventSha256,
      approval_presentation_sha256: reviewerPresentationSha256,
      ...commonProvider,
    }),
  );
  const reviewerAudit = integrations.recordReviewerPermissionDecision({
    organization_id: fixture.config.organization.organization_id,
    authority_id: fixture.config.authority.authority_id,
    request_id: reviewerRequestId,
    request_sha256: reviewerRequestSha256,
    provider_event_sha256: reviewerProviderEventSha256,
    approval_id: reviewerApprovalId,
    installation_id: installationId,
    reviewer_principal_id: owner.principal_id,
    reviewer_membership_id: owner.membership_id,
    identity_link_id: null as never,
    connection_id: surface.connection_id,
    adapter_binding_id: surface.adapter_binding_id,
    permission_grant_id: grantId,
    evaluated_at: requestedAt,
    authority_evidence_sha256: sha256Digest('backup reviewer authority'),
    detail: reviewerRestrictedAuditDetail({
      authority_id: fixture.config.authority.authority_id,
      request_sha256: reviewerRequestSha256,
      provider_event_sha256: reviewerProviderEventSha256,
      principal_id: owner.principal_id,
      ...commonProvider,
      reviewer_release_draft_sha256: reviewerDraftSha256,
      approval_presentation_sha256: reviewerPresentationSha256,
      semantic_intent_sha256: reviewerSemanticIntentSha256,
      message_presentation_sha256: reviewerMessagePresentationSha256,
    }),
  });
  const reviewerAuthorization = {
    schema_version: 2,
    kind: 'echo-organization-authorization-evidence',
    authority_id: fixture.config.authority.authority_id,
    organization_id: fixture.config.organization.organization_id,
    enrollment_id: federationId('enr'),
    installation_id: installationId,
    request_id: reviewerRequestId,
    approval_id: reviewerApprovalId,
    action: 'approve',
    request_sha256: reviewerRequestSha256,
    provider_event_sha256: reviewerProviderEventSha256,
    allowed: true,
    reason_code: 'active_reviewer_restricted_notice_v1',
    principal_id: owner.principal_id,
    membership_id: owner.membership_id,
    adapter_binding_id: surface.adapter_binding_id,
    permission_grant_id: grantId,
    evaluated_at: requestedAt,
    authorization_audit_event_id:
      reviewerAudit.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      reviewerAudit.authorization_audit_entry_sha256,
    reviewer_release_draft_sha256: reviewerDraftSha256,
    approval_presentation_sha256: reviewerPresentationSha256,
    semantic_intent_sha256: reviewerSemanticIntentSha256,
    message_presentation_sha256: reviewerMessagePresentationSha256,
  } as const;
  const reviewerEnvelope = await createOrganizationRecordReviewerApprovalEnvelope(
    {
      envelope_id: organizationRecordEnvelopeId(),
      idempotency_key: reviewerApprovalId,
      payload: {
        brief,
        source: {
          adapter_id: 'granola',
          instance_id: 'primary',
          external_id: 'backup-reviewer-v2',
        },
        alternatives: [],
        links: null,
        reviewed_at: requestedAt,
        surface: 'slack-reviewer-v1',
      },
      reviewer: {
        principal_id: owner.principal_id,
        membership_id: owner.membership_id,
        reviewed_by: owner.display_name,
        authorization: reviewerAuthorization,
      },
      intent: organizationRecordReviewerIntent(
        reviewerSemanticIntentSha256,
      ),
      submitter: {
        installation_id: installationId,
        submitted_at: requestedAt,
      },
      installation_signing_key: installation.descriptor,
    },
    pinned,
    async (bytes) => installation.sign(bytes),
  );

  const memberApprovalId = createHash('sha256')
    .update('backup-member-v3')
    .digest('hex');
  const memberDraft = projectOrganizationMemberReadableReleaseDraft({
    approval_id: memberApprovalId,
    brief,
  });
  const memberPresentation = organizationMemberReadableApprovalPresentation({
    draft: memberDraft,
    approve_reaction: commonProvider.approve_reaction,
    reject_reaction: commonProvider.reject_reaction,
  });
  const memberDraftSha256 =
    organizationMemberReadableReleaseDraftSha256(memberDraft);
  const memberPresentationSha256 =
    organizationMemberReadableApprovalPresentationSha256(memberPresentation);
  const memberRequestId = `pcr_${randomUUID()}`;
  const memberRequestSha256 = sha256Digest('backup member request');
  const memberProviderEventSha256 = sha256Digest(
    'backup member provider event',
  );
  const memberSemanticIntentSha256 = canonicalSha256(
    organizationMemberReadableSemanticPreimage({
      authority_id: fixture.config.authority.authority_id,
      organization_id: fixture.config.organization.organization_id,
      policy_contract_sha256:
        organizationMemberReadablePolicyContractSha256(),
      approval_id: memberApprovalId,
      approving_principal_id: owner.principal_id,
      approving_membership_id: owner.membership_id,
      release_draft_sha256: memberDraftSha256,
      approval_presentation_sha256: memberPresentationSha256,
      evaluated_at: requestedAt,
    }),
  );
  const memberMessagePresentationSha256 = canonicalSha256(
    organizationMemberMessagePresentationPreimage({
      provider_event_sha256: memberProviderEventSha256,
      approval_presentation_sha256: memberPresentationSha256,
      ...commonProvider,
    }),
  );
  const memberAudit =
    integrations.recordOrganizationMemberReadablePermissionDecision({
      organization_id: fixture.config.organization.organization_id,
      authority_id: fixture.config.authority.authority_id,
      request_id: memberRequestId,
      request_sha256: memberRequestSha256,
      provider_event_sha256: memberProviderEventSha256,
      approval_id: memberApprovalId,
      installation_id: installationId,
      approving_principal_id: owner.principal_id,
      approving_membership_id: owner.membership_id,
      identity_link_id: null as never,
      connection_id: surface.connection_id,
      adapter_binding_id: surface.adapter_binding_id,
      permission_grant_id: grantId,
      evaluated_at: requestedAt,
      authority_evidence_sha256: sha256Digest('backup member authority'),
      detail: organizationMemberReadableAuditDetail({
        authority_id: fixture.config.authority.authority_id,
        request_sha256: memberRequestSha256,
        provider_event_sha256: memberProviderEventSha256,
        principal_id: owner.principal_id,
        policy_contract_sha256:
          organizationMemberReadablePolicyContractSha256(),
        ...commonProvider,
        release_draft_sha256: memberDraftSha256,
        approval_presentation_sha256: memberPresentationSha256,
        semantic_intent_sha256: memberSemanticIntentSha256,
        message_presentation_sha256: memberMessagePresentationSha256,
      }),
    });
  const memberAuthorization = {
    schema_version: 3,
    kind: 'echo-organization-authorization-evidence',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256:
      organizationMemberReadablePolicyContractSha256(),
    authority_id: fixture.config.authority.authority_id,
    organization_id: fixture.config.organization.organization_id,
    enrollment_id: federationId('enr'),
    installation_id: installationId,
    request_id: memberRequestId,
    approval_id: memberApprovalId,
    action: 'approve',
    request_sha256: memberRequestSha256,
    provider_event_sha256: memberProviderEventSha256,
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    principal_id: owner.principal_id,
    membership_id: owner.membership_id,
    adapter_binding_id: surface.adapter_binding_id,
    permission_grant_id: grantId,
    evaluated_at: requestedAt,
    authorization_audit_event_id: memberAudit.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      memberAudit.authorization_audit_entry_sha256,
    release_draft_sha256: memberDraftSha256,
    approval_presentation_sha256: memberPresentationSha256,
    semantic_intent_sha256: memberSemanticIntentSha256,
    message_presentation_sha256: memberMessagePresentationSha256,
  } as const;
  const memberEnvelope =
    await createOrganizationRecordOrganizationMemberApprovalEnvelope(
      {
        envelope_id: organizationRecordEnvelopeId(),
        idempotency_key: memberApprovalId,
        payload: {
          brief,
          source: {
            adapter_id: 'granola',
            instance_id: 'primary',
            external_id: 'backup-member-v3',
          },
          alternatives: [],
          links: null,
          reviewed_at: requestedAt,
          surface: 'slack-organization-member-readable-v1',
        },
        reviewer: {
          principal_id: owner.principal_id,
          membership_id: owner.membership_id,
          reviewed_by: owner.display_name,
          authorization: memberAuthorization,
        },
        intent: organizationRecordOrganizationMemberIntent(
          memberSemanticIntentSha256,
        ),
        submitter: {
          installation_id: installationId,
          submitted_at: requestedAt,
        },
        installation_signing_key: installation.descriptor,
      },
      pinned,
      async (bytes) => installation.sign(bytes),
    );

  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: fixture.config.organization.organization_id,
    authority_id: fixture.config.authority.authority_id,
    reviewer_validator: reviewerRestrictedEnvelopeValidator({
      organization_id: fixture.config.organization.organization_id,
      authority_id: fixture.config.authority.authority_id,
    }),
    organization_member_validator: organizationMemberReadableEnvelopeValidator({
      organization_id: fixture.config.organization.organization_id,
      authority_id: fixture.config.authority.authority_id,
    }),
  });
  const verified = new Map<string, unknown>([
    [
      reviewerEnvelope.envelope_id,
      {
        envelope: reviewerEnvelope as unknown as JsonObject,
        envelope_id: reviewerEnvelope.envelope_id,
        event_type: 'approval',
        idempotency_key: reviewerEnvelope.idempotency_key,
        installation_id: installationId,
        reviewer_restricted_proof: {
          policy_id: 'restricted-reviewer-v1',
          reviewer_principal_id: owner.principal_id,
          reviewer_membership_id: owner.membership_id,
          reviewer_release_draft_sha256: reviewerDraftSha256,
          approval_presentation_sha256: reviewerPresentationSha256,
          semantic_intent_sha256: reviewerSemanticIntentSha256,
          message_presentation_sha256: reviewerMessagePresentationSha256,
          authorization_audit_event_id:
            reviewerAudit.authorization_audit_event_id,
          authorization_audit_entry_sha256:
            reviewerAudit.authorization_audit_entry_sha256,
          evaluated_at: requestedAt,
        },
      },
    ],
    [
      memberEnvelope.envelope_id,
      {
        envelope: memberEnvelope as unknown as JsonObject,
        envelope_id: memberEnvelope.envelope_id,
        event_type: 'approval',
        idempotency_key: memberEnvelope.idempotency_key,
        installation_id: installationId,
        organization_member_readable_proof: {
          policy_id: 'organization-member-readable-v1',
          policy_contract_sha256:
            organizationMemberReadablePolicyContractSha256(),
          approving_principal_id: owner.principal_id,
          approving_membership_id: owner.membership_id,
          release_draft_sha256: memberDraftSha256,
          approval_presentation_sha256: memberPresentationSha256,
          semantic_intent_sha256: memberSemanticIntentSha256,
          message_presentation_sha256: memberMessagePresentationSha256,
          authorization_audit_event_id:
            memberAudit.authorization_audit_event_id,
          authorization_audit_entry_sha256:
            memberAudit.authorization_audit_entry_sha256,
          evaluated_at: requestedAt,
        },
      },
    ],
  ]);
  const ingest = new OrganizationRecordIngest({
    log,
    authority: {
      verifyEnvelope: async (value) => {
        const envelope = value as { readonly envelope_id?: string };
        const result =
          envelope.envelope_id === undefined
            ? undefined
            : verified.get(envelope.envelope_id);
        if (result === undefined) {
          throw new Error('test backup envelope was not qualified');
        }
        return result as never;
      },
    },
    receiptSigner: {
      signReceipt: async (payload) =>
        ({
          ...payload,
          integrity: {
            schema_version: 1,
            kind: 'test-readable-search-backup-receipt-integrity',
          },
        }) as JsonObject,
    },
    reviewerValidator: reviewerRestrictedEnvelopeValidator({
      organization_id: fixture.config.organization.organization_id,
      authority_id: fixture.config.authority.authority_id,
    }),
    organizationMemberValidator: organizationMemberReadableEnvelopeValidator({
      organization_id: fixture.config.organization.organization_id,
      authority_id: fixture.config.authority.authority_id,
    }),
    clock: () => plus(requestedAt, 1),
  });
  try {
    await ingest.append(reviewerEnvelope);
    await ingest.append(memberEnvelope);
  } finally {
    log.close();
    integrations.close();
  }
  await rebuildAuthorityDerivedRecordStore(fixture.configPath);
  const built = await rebuildAuthorityReadableSearch(fixture.configPath);
  const stoppedIdentities = {
    authority: fileIdentity(paths.database_path),
    record: fileIdentity(paths.record_log_database_path),
    integrations: fileIdentity(paths.integrations_database_path),
  };
  await expect(
    verifyAuthorityReadableSearchBackup(fixture.configPath),
  ).resolves.toMatchObject({
    status: 'verified',
    generation_id: built.generation_id,
  });
  expect({
    authority: fileIdentity(paths.database_path),
    record: fileIdentity(paths.record_log_database_path),
    integrations: fileIdentity(paths.integrations_database_path),
  }).toEqual(stoppedIdentities);
  return {
    ...fixture,
    reviewerAuditEventId: reviewerAudit.authorization_audit_event_id,
    memberAuditEventId: memberAudit.authorization_audit_event_id,
  };
}

describe('organization record rebuild-derived', () => {
  it('builds and atomically publishes an idempotent stopped readable-search generation', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const stdout: string[] = [];
    const code = await runOrganizationAuthorityCli(
      ['rebuild-readable-search', '--config', fixture.configPath],
      {},
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );
    expect(code).toBe(0);
    const first = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(first).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-authority-readable-search-rebuild',
      config_path: fixture.configPath,
      record_head_position: 0,
      record_head_hash: null,
    });
    expect(first.generation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.manifest_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(paths.state_directory, 'record-retrieval', 'generations', String(first.generation_id), 'manifest.json'))).toBe(true);

    const second = await rebuildAuthorityReadableSearch(fixture.configPath);
    expect(second.generation_id).toBe(first.generation_id);
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    const audits = generationPublicationAudits(paths.database_path);
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit).toMatchObject({
      subject_id: fixture.config.organization.organization_id,
    });
    const detail = validateReadableSearchGenerationPublishedAuditDetail(audit?.detail);
    expect(detail).toMatchObject({
      organization_id: fixture.config.organization.organization_id,
      publication: {
        generation_id: first.generation_id,
        manifest_sha256: first.manifest_sha256,
        record_head_position: 0,
        record_head_hash: null,
      },
      prior_generation: null,
      published_at: audit?.occurred_at,
    });
    await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
  });

  it('reports a text-free not-built readable-search backup through the CLI', async () => {
    const fixture = await initializedFixture();
    const stdout: string[] = [];
    const code = await runOrganizationAuthorityCli(
      ['verify-readable-search-backup', '--config', fixture.configPath],
      {},
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(result).toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-readable-search-backup-verification',
      config_path: fixture.configPath,
      organization_id: fixture.config.organization.organization_id,
      status: 'not_built',
      generation_id: null,
      manifest_sha256: null,
      retrieval_contract_sha256: null,
      record_head_position: 0,
      record_head_hash: null,
    });
    expect(stdout[0]).toBe(`${canonicalJson(result as never)}\n`);
  });

  it('rejects an incomplete unreferenced finalized generation even without a pointer', async () => {
    const fixture = await initializedFixture();
    const generations = join(
      fixture.stateDirectory,
      'record-retrieval',
      'generations',
    );
    mkdirSync(generations, { recursive: true, mode: 0o700 });
    chmodSync(join(fixture.stateDirectory, 'record-retrieval'), 0o700);
    chmodSync(generations, 0o700);
    mkdirSync(join(generations, 'unreferenced-incomplete'), { mode: 0o700 });

    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/generation manifest/);
  });

  it('admits the exact active generation and rejects stale or corrupt backup state', async () => {
    const fixture = await initializedFixture();
    const built = await rebuildAuthorityReadableSearch(fixture.configPath);
    const verified = await verifyAuthorityReadableSearchBackup(fixture.configPath);
    expect(verified).toMatchObject({
      status: 'verified',
      generation_id: built.generation_id,
      manifest_sha256: built.manifest_sha256,
      record_head_position: built.record_head_position,
      record_head_hash: built.record_head_hash,
    });

    appendRecord(fixture.config, rejectionEnvelope(1));
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow('does not match the exact record head');

    const rebuilt = await rebuildAuthorityReadableSearch(fixture.configPath);
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).resolves.toMatchObject({
      status: 'verified',
      generation_id: rebuilt.generation_id,
    });
    const paths = authorityStatePaths(fixture.stateDirectory);
    const manifestPath = join(
      paths.state_directory,
      'record-retrieval',
      'generations',
      rebuilt.generation_id,
      'manifest.json',
    );
    writeFileSync(manifestPath, '{}', { mode: 0o600 });
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/manifest/);
  });

  it.each([
    ['reviewer', 'fact', 'missing'],
    ['reviewer', 'fact', 'corrupt'],
    ['reviewer', 'evidence', 'missing'],
    ['reviewer', 'evidence', 'corrupt'],
    ['member', 'fact', 'missing'],
    ['member', 'fact', 'corrupt'],
    ['member', 'evidence', 'missing'],
    ['member', 'evidence', 'corrupt'],
  ] as const)(
    'rejects a backup with %s %s %s after a valid generation was published',
    async (family, target, condition) => {
      const fixture = await policyQualifiedBackupFixture();
      const paths = authorityStatePaths(fixture.stateDirectory);
      if (target === 'fact') {
        const database = new Database(paths.record_log_database_path);
        try {
          const table =
            family === 'reviewer'
              ? 'organization_record_reviewer_policy_fact'
              : 'organization_member_readable_policy_fact';
          const trigger = `${table}_immutable_${
            condition === 'missing' ? 'delete' : 'update'
          }`;
          bypassImmutableTrigger(database, trigger, () => {
            if (condition === 'missing') {
              database.exec(`DELETE FROM ${table}`);
            } else {
              database
                .prepare(
                  `UPDATE ${table} SET authorization_proof_sha256 = ?`,
                )
                .run(sha256Digest(`corrupt ${family} fact`));
            }
          });
        } finally {
          database.close();
        }
      } else {
        const database = new Database(paths.integrations_database_path);
        try {
          const auditEventId =
            family === 'reviewer'
              ? fixture.reviewerAuditEventId
              : fixture.memberAuditEventId;
          const trigger = `organization_integration_audit_immutable_${
            condition === 'missing' ? 'delete' : 'update'
          }`;
          bypassImmutableTrigger(database, trigger, () => {
            if (condition === 'missing') {
              database
                .prepare(
                  'DELETE FROM organization_integration_audit WHERE audit_event_id = ?',
                )
                .run(auditEventId);
            } else {
              database
                .prepare(
                  `UPDATE organization_integration_audit
                      SET detail_sha256 = ?
                    WHERE audit_event_id = ?`,
                )
                .run(
                  sha256Digest(`corrupt ${family} audit evidence`),
                  auditEventId,
                );
            }
          });
        } finally {
          database.close();
        }
      }

      const beforeVerification = readableSearchBackupIdentity(paths);
      await expect(
        verifyAuthorityReadableSearchBackup(fixture.configPath),
      ).rejects.toThrow(
        target === 'evidence' && !(family === 'member' && condition === 'missing')
          ? /integration audit chain admission failed/
          : family === 'reviewer'
          ? /reviewer fact admission failed/
          : /organization-member fact admission failed/,
      );
      expect(readableSearchBackupIdentity(paths)).toEqual(beforeVerification);
    },
  );

  it('rejects an internally valid active generation built from a different Layer 1 projection root', async () => {
    const fixture = await policyQualifiedBackupFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const sourceBytes = readableSearchReleaseDescriptor();
    const analyzer = createReadableSearchAnalyzerDescriptor({
      analyzer_source_sha256: readableSearchSourceBytesSha256(sourceBytes),
      node_version: process.versions.node,
      unicode_version: process.versions.unicode ?? 'unknown',
      icu_version: process.versions.icu ?? 'unknown',
    });
    const memberContract = organizationMemberReadablePolicyContractSha256();
    const reviewerContract = reviewerPolicyContractSha256();
    const retrievalContract = readableSearchRetrievalContractSha256({
      analyzer_contract_sha256: analyzer.analyzer_contract_sha256,
      organization_member_policy_contract_sha256: memberContract,
      restricted_reviewer_policy_contract_sha256: reviewerContract,
    });
    const record = new Database(paths.record_log_database_path, {
      readonly: true,
    });
    const sqliteVersion = (
      record.prepare('SELECT sqlite_version() AS version').get() as {
        readonly version: string;
      }
    ).version;
    const recordRows = record
      .prepare(
        `SELECT position, record_hash, envelope_sha256
           FROM organization_record_log
          ORDER BY position`,
      )
      .all() as readonly {
        readonly position: number;
        readonly record_hash: `sha256:${string}`;
        readonly envelope_sha256: `sha256:${string}`;
      }[];
    const recordHeadHash = recordRows.at(-1)!.record_hash;
    record.close();
    const counterfeitInputPreimage = Object.freeze({
      schema_version: 1 as const,
      kind: 'readable-search-upstream-input-root-v1' as const,
      organization_id: fixture.config.organization.organization_id,
      input_contract_version: 1 as const,
      record_head: Object.freeze({
        position: 2,
        record_hash: recordHeadHash,
      }),
      rows: Object.freeze(recordRows.map((row) => Object.freeze({
        classification: 'legacy-schema-v1-excluded' as const,
        log_position: row.position,
        record_hash: row.record_hash,
        envelope_sha256: row.envelope_sha256,
        items: Object.freeze([]),
      }))),
    });
    const generated = buildStoppedReadableSearchGeneration({
      state_directory: paths.state_directory,
      organization_id: fixture.config.organization.organization_id,
      record_head: {
        position: 2,
        record_hash: recordHeadHash,
      },
      upstream_input_preimage: counterfeitInputPreimage,
      retrieval_contract_sha256: retrievalContract,
      organization_member_policy_contract_sha256: memberContract,
      restricted_reviewer_policy_contract_sha256: reviewerContract,
      analyzer,
      source_revision: 'test-different-layer-1-projection',
      builder_artifact_sha256: readableSearchSourceBytesSha256(sourceBytes),
      sqlite_version: sqliteVersion,
      atoms: [],
    });
    const authority = new Database(paths.database_path);
    try {
      authority
        .prepare(
          `UPDATE authority_readable_search_active_generation
              SET generation_id = ?, manifest_sha256 = ?,
                  retrieval_contract_sha256 = ?, record_head_position = ?,
                  record_head_hash = ?, published_at = ?
            WHERE singleton = 1`,
        )
        .run(
          generated.manifest.generation_id,
          generated.manifest_sha256,
          generated.manifest.retrieval_contract_sha256,
          generated.manifest.record_head.position,
          generated.manifest.record_head.record_hash,
          new Date().toISOString(),
        );
    } finally {
      authority.close();
    }

    const beforeVerification = readableSearchBackupIdentity(paths);
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/canonical Layer 1 projection/);
    expect(readableSearchBackupIdentity(paths)).toEqual(beforeVerification);
  });

  it.each([
    ['staging directory', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      const directory = join(dirname(generationDirectory), '.staging');
      mkdirSync(directory, { mode: 0o700 });
    }],
    ['retrieval SQLite sidecar', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      writeFileSync(join(generationDirectory, 'unexpected.sqlite-wal'), 'stale', { mode: 0o600 });
    }],
    ['core SQLite sidecar', (_generationDirectory: string, paths: ReturnType<typeof authorityStatePaths>) => {
      writeFileSync(`${paths.database_path}-wal`, 'stale', { mode: 0o600 });
    }],
    ['wrong-mode retrieval file', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      chmodSync(join(generationDirectory, 'manifest.json'), 0o644);
    }],
  ] as const)('rejects readable-search backup %s', async (_label, introduce) => {
    const fixture = await initializedFixture();
    const built = await rebuildAuthorityReadableSearch(fixture.configPath);
    const generationDirectory = join(
      fixture.stateDirectory,
      'record-retrieval',
      'generations',
      built.generation_id,
    );
    introduce(generationDirectory, authorityStatePaths(fixture.stateDirectory));
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/staging directory|SQLite sidecar|0600/);
  });

  it('refuses readable-search backup verification while the authority owns the state', async () => {
    const fixture = await initializedFixture();
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(fixture.config),
    );
    try {
      await expect(
        verifyAuthorityReadableSearchBackup(fixture.configPath),
      ).rejects.toThrow('organization authority is already running');
    } finally {
      await runtime.close();
    }
  });

  it('replays a verified log idempotently without changing protected files', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    appendRecord(fixture.config, rejectionEnvelope(1));
    const protectedBefore = {
      log: fileIdentity(paths.record_log_database_path),
      authority: fileIdentity(paths.database_path),
      marker: fileIdentity(paths.record_installation_marker_path),
    };
    const derivedBefore = fileIdentity(paths.record_derived_database_path);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOrganizationAuthorityCli(
      ['rebuild-derived', '--config', fixture.configPath],
      {},
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const first = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(first).toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-record-derived-rebuild',
      config_path: fixture.configPath,
      record_derived_database_path: paths.record_derived_database_path,
      head_position: 1,
      derived_content_sha256: first['derived_content_sha256'],
    });
    expect(first['derived_content_sha256']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stdout[0]).toBe(`${canonicalJson(first as never)}\n`);

    const second = await rebuildAuthorityDerivedRecordStore(fixture.configPath);
    expect(second.derived_content_sha256).toBe(first['derived_content_sha256']);
    expect({
      log: fileIdentity(paths.record_log_database_path),
      authority: fileIdentity(paths.database_path),
      marker: fileIdentity(paths.record_installation_marker_path),
    }).toEqual(protectedBefore);
    expect(fileIdentity(paths.record_derived_database_path)).not.toEqual(
      derivedBefore,
    );
    expect(derivedCursorPosition(paths.record_derived_database_path)).toBe(1);
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
    expectNoRecordSidecars(paths);
    await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
  });

  it('rebuilds a valid schema-v3 member record as the exact text-free exclusion', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    await appendOrganizationMemberRecord(fixture.config);

    const log = new Database(paths.record_log_database_path, {
      readonly: true,
    });
    expect(
      log
        .prepare(
          'SELECT log_position, atom_order FROM organization_member_readable_policy_fact ORDER BY atom_order',
        )
        .all(),
    ).toEqual([{ log_position: 1, atom_order: 0 }]);
    log.close();

    const rebuilt = await rebuildAuthorityDerivedRecordStore(
      fixture.configPath,
    );
    expect(rebuilt.head_position).toBe(1);
    const derived = new Database(paths.record_derived_database_path, {
      readonly: true,
    });
    try {
      expect(
        derived
          .prepare(
            `SELECT log_position, envelope_version, policy_id, outcome
               FROM organization_derived_member_readable_policy_exclusion`,
          )
          .all(),
      ).toEqual([
        {
          log_position: 1,
          envelope_version: 3,
          policy_id: 'organization-member-readable-v1',
          outcome: 'deferred-to-permission-aware-retrieval',
        },
      ]);
      expect(
        (
          derived
            .prepare('SELECT COUNT(*) AS count FROM organization_derived_atom')
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      derived.close();
    }
  });

  it.each(['missing', 'corrupt'] as const)(
    'recreates a %s derived database from the installed log',
    async (condition) => {
      const fixture = await initializedFixture();
      const paths = authorityStatePaths(fixture.stateDirectory);
      appendRecord(fixture.config, rejectionEnvelope(1));
      const logBefore = fileIdentity(paths.record_log_database_path);
      if (condition === 'missing') {
        unlinkSync(paths.record_derived_database_path);
      } else {
        writeFileSync(paths.record_derived_database_path, 'not sqlite');
      }

      const result = await rebuildAuthorityDerivedRecordStore(
        fixture.configPath,
      );

      expect(result.head_position).toBe(1);
      expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
      expect(derivedCursorPosition(paths.record_derived_database_path)).toBe(1);
      expect(statSync(paths.record_derived_database_path).mode & 0o777).toBe(
        0o600,
      );
      await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
    },
  );

  it('refuses while the authority owns the state', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(fixture.config),
    );
    const derivedBefore = fileIdentity(paths.record_derived_database_path);
    try {
      await expect(
        rebuildAuthorityDerivedRecordStore(fixture.configPath),
      ).rejects.toThrow('organization authority is already running');
    } finally {
      await runtime.close();
    }
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
  });

  it('refuses an invalid log before replacing the derived database', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const database = new Database(paths.record_log_database_path);
    try {
      database
        .prepare(
          `INSERT INTO organization_record_log (
             position, envelope_id, event_type, installation_id,
             idempotency_key, canonical_envelope, envelope_sha256,
             receipt_payload, previous_record_hash, record_hash, recorded_at
           ) VALUES (1, 'rec_00000000-0000-4000-8000-000000000000', 'rejection',
             'ins_00000000-0000-4000-8000-000000000000', ?, '{}', ?, '{}',
             NULL, ?, '2026-08-08T12:00:00.000Z')`,
        )
        .run(
          'a'.repeat(64),
          `sha256:${'b'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
        );
    } finally {
      database.close();
    }
    const logBefore = fileIdentity(paths.record_log_database_path);
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow('chain verification failed');

    expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });

  it('cleans staging and preserves the target when projection halts', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    appendRecord(fixture.config, rejectionEnvelope(1));
    appendRecord(fixture.config, underivableEnvelope(2));
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow(
      /derive halted while rebuilding at cursor 1:.*position 2/,
    );

    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });

  it.each([
    ['log', '-journal'],
    ['log', '-wal'],
    ['log', '-shm'],
    ['derived', '-journal'],
    ['derived', '-wal'],
    ['derived', '-shm'],
  ] as const)('refuses a canonical %s%s sidecar', async (target, suffix) => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const databasePath =
      target === 'log'
        ? paths.record_log_database_path
        : paths.record_derived_database_path;
    writeFileSync(`${databasePath}${suffix}`, 'stale', { mode: 0o600 });
    const logBefore = fileIdentity(paths.record_log_database_path);
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow('has SQLite sidecar');

    expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });
});
