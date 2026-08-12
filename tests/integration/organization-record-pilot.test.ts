import { Buffer } from 'node:buffer';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
} from '@echo-brain/organization-api';
import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  sha256Digest,
  type JsonObject,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  organizationEnrollmentGrantSha256,
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
  type PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import {
  OrganizationIntegrationsRepository,
  openOrganizationControlDatabase,
} from '../../services/organization-control-plane/src/index.js';
import {
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
} from '../../services/organization-record/src/index.js';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  ORGANIZATION_RECORD_LOG_DATABASE,
  openOrganizationRecordDatabase,
} from '../../services/organization-record/src/maintenance.js';
import { OrganizationAdminApiClient } from '../../services/organization-authority/src/adapters/http/organization-admin-api-client.js';
import { authorityRuntimeFingerprint } from '../../services/organization-authority/src/adapters/runtime/runtime-fingerprint.js';
import {
  acquireAuthorityRuntimeLock,
  inspectAuthorityRuntimeLock,
} from '../../services/organization-authority/src/adapters/runtime/singleton-runtime-lock.js';
import type { AuthorityServeConfig } from '../../services/organization-authority/src/composition/config.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from '../../services/organization-authority/src/composition/operator-config.js';
import { initializeDevelopmentAuthority } from '../../services/organization-authority/src/composition/operator-state.js';
import { startOrganizationAuthority } from '../../services/organization-authority/src/composition/runtime.js';
import {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../../services/organization-authority/src/presentation/trusted-proxy-client-identity.js';
import type { ApprovalRequest } from '../../src/core/index.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/machine/security/installation-signer.js';
import { HttpOrganizationAuthorityClient } from '../../src/product/organization/client/http-organization-authority-client.js';
import { HttpOrganizationRecordClient } from '../../src/product/organization/client/http-organization-record-client.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import {
  createOrganizationIngestExclusion,
  OrganizationRecordSubmitter,
  ProtocolOrganizationRecordEnvelopeBuilder,
  type OrganizationRecordAuthorizationEvidence,
} from '../../src/product/organization/record/index.js';

const PROXY_CLIENT_ID = `cid_${createHash('sha256')
  .update('record-pilot-client')
  .digest('base64url')}`;
const NOW = '2026-08-08T12:00:00.000Z';
const PROCESSING_KEY =
  'granola:primary:pricing-2026-08-08:rev-1:structured-text:default:1.0.0';
const DECISION_TEXT = 'Adopt usage-based pricing.';
const SLACK_TOOL_CONFIGURATION_JSON =
  '{"channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';
const SLACK_BINDING_CONFIGURATION_JSON =
  '{"approve_reaction":"white_check_mark","channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

class MemoryInstallationSigner implements InstallationSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: Buffer;
  private descriptor: InstallationKeyDescriptor | null = null;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(exported)) throw new Error('test key export failed');
    this.publicKey = exported;
  }

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    this.descriptor ??= {
      installation_id: installationId,
      key_id: p256KeyId(this.publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: this.publicKey.toString('base64'),
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    };
    return structuredClone(this.descriptor);
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    if (
      this.descriptor === null ||
      this.descriptor.installation_id !== installationId
    ) {
      return null;
    }
    return structuredClone(this.descriptor);
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    const descriptor = await this.inspect(installationId);
    if (descriptor === null || descriptor.key_id !== expectedKeyId) {
      throw new Error('test installation key mismatch');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

function approvalRequest(decisionText = DECISION_TEXT): ApprovalRequest {
  const meetingId = 'granola:meeting-2026-08-08-pricing';
  return {
    processing_key: PROCESSING_KEY,
    requested_at: NOW,
    meeting: {
      schema_version: 1,
      id: meetingId,
      title: 'Pricing review',
      time: { actual_start_at: '2026-08-08T11:00:00.000Z' },
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'granola',
          instance_id: 'primary',
          version: '1.0.0',
        },
        external_id: 'pricing-2026-08-08',
        canonical_revision: 'rev-1',
        observed_at: '2026-08-08T11:30:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-08T11:30:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: meetingId,
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: NOW,
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-pricing',
      meeting: {
        id: meetingId,
        title: 'Pricing review',
        time: { actual_start_at: '2026-08-08T11:00:00.000Z' },
        participants: [],
      },
      decisions: [
        {
          id: 'signal-decision-1',
          kind: 'decision',
          text: decisionText,
          subject: 'pricing',
          confidence: 1,
          evidence: [{ meeting_id: meetingId, block_id: 'block-12' }],
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
        generated_at: NOW,
      },
    },
  } as unknown as ApprovalRequest;
}

interface RecordPilot {
  readonly origin: string;
  readonly stateDirectory: string;
  /** The exact config a supervisor's replacement process would serve from. */
  readonly serveConfig: AuthorityServeConfig;
  readonly nodes: DecisionNodeStore;
  readonly installationId: string;
  readonly installationSigningKey: P256SigningKeyDescriptor;
  readonly signCanonicalBytes: (bytes: Buffer) => Promise<Buffer>;
  readonly pinnedAuthority: PinnedOrganizationAuthority;
  readonly fetch: typeof fetch;
  /** Loses exactly one record-route response *after* the authority handled it. */
  loseNextRecordResponse(): void;
  /** Resolves when a post-start derive failure took the host down. */
  readonly fatalFailure: Promise<Error>;
  /** Plants a chain-valid record the follower cannot derive. */
  plantUnderivableRecord(): void;
  close(): Promise<void>;
}

/**
 * A whole pilot in one function: a real authority process published by the real
 * operator command, a real enrolled member machine, a real allowed audit row in
 * the real control-plane database, and a real resolved decision node carrying
 * that row as its evidence.
 *
 * Nothing here is stubbed except the loopback transport wrapper. A fixture
 * shortcut at any of these seams would let the append path look correct against
 * something it never meets in production — which is the whole reason this test
 * exists beside the unit suites.
 */
async function startRecordPilot(
  decisionText = DECISION_TEXT,
): Promise<RecordPilot> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-rec-pilot-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'st');
  await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
    port: await reserveLoopbackPort(),
  });
  const serveConfig = resolveAuthorityServeConfig(
    readAuthorityRuntimeConfig(configPath),
  );
  const paths = authorityStatePaths(stateDirectory);
  const runtime = await startOrganizationAuthority(serveConfig);
  const origin = `http://127.0.0.1:${runtime.address.port}/`;

  let dropNextRecordResponse = false;
  const proxyFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(
      TRUSTED_PROXY_AUTHORIZATION_HEADER,
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${serveConfig.trusted_proxy_token}`,
    );
    headers.set(TRUSTED_PROXY_CLIENT_ID_HEADER, PROXY_CLIENT_ID);
    const response = await fetch(input, { ...init, headers });
    const url = typeof input === 'string' ? input : String(input);
    if (
      dropNextRecordResponse &&
      url.includes(ORGANIZATION_API_RECORD_ENVELOPES_PATH)
    ) {
      // The append has already committed inside the authority; only the answer
      // is lost. This is exactly the failure the frozen envelope exists for.
      dropNextRecordResponse = false;
      throw new TypeError('fetch failed');
    }
    return response;
  };

  const state = new SqliteOrganizationStateStore(
    join(root, 'installation.sqlite'),
  );
  let integrations: OrganizationIntegrationsRepository | undefined;
  try {
    const admin = new OrganizationAdminApiClient({
      base_url: origin,
      admin_token: serveConfig.admin_token,
      trusted_proxy_token: serveConfig.trusted_proxy_token,
      client_identity: PROXY_CLIENT_ID,
    });
    const membership = await admin.provisionMembership({
      command_id: `adm_${randomUUID()}`,
      display_name: 'Ada Founder',
      membership_type: 'employee',
    });
    const grant = Uint8Array.from(randomBytes(32));
    await admin.registerEnrollmentGrant(membership.membership_id, {
      command_id: `adm_${randomUUID()}`,
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(grant),
      lifetime_seconds: 3600,
    });

    const identity = JSON.parse(readFileSync(paths.identity_path, 'utf8')) as {
      authority_descriptor: unknown;
      authority_pin_sha256: Sha256Digest;
    };
    const authorityDescriptor = validateOrganizationAuthorityDescriptor(
      identity.authority_descriptor,
    );
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      authorityDescriptor,
      identity.authority_pin_sha256,
    );
    const installationId = `ins_${randomUUID()}`;
    const installationSigner = new MemoryInstallationSigner();
    const enrolled = await new LocalOrganizationCoordinator({
      state,
      authorityClient: new HttpOrganizationAuthorityClient({
        baseUrl: origin,
        fetch: proxyFetch,
        allowInsecureLoopback: true,
      }),
      installationSigner,
      maximumActiveLeaseTtlMs: serveConfig.active_lease_ttl_ms,
    }).enroll({
      authorityBaseUrl: new URL(origin).origin,
      authorityDescriptor,
      independentlyTrustedAuthorityPin: identity.authority_pin_sha256,
      enrollmentGrant: grant,
      principalId: membership.principal_id,
      membershipId: membership.membership_id,
      installationId,
    });
    if (!enrolled.permitted) throw new Error('pilot enrollment was refused');
    const enrollment = state.readEnrollment();
    const enrollmentId = enrollment?.receipt?.enrollment_id;
    const installationSigningKey = enrollment?.request.installation_signing_key;
    if (enrollmentId === undefined || installationSigningKey === undefined) {
      throw new Error('pilot enrollment produced no receipt');
    }

    // The real integration audit, written through the same control-plane
    // repository the authority uses. A second connection beside a running
    // authority is exactly how an operator tool touches this file.
    const controlDatabase = openOrganizationControlDatabase(
      serveConfig.integrations_database_path,
      { fileMustExist: true },
    );
    integrations = new OrganizationIntegrationsRepository(controlDatabase, {
      organization_id: serveConfig.organization_id,
      authority_id: serveConfig.authority_id,
    });
    const surface = seedSlackApprovalSurface(controlDatabase, {
      organizationId: serveConfig.organization_id,
      installationId,
      installationKeyId: installationSigningKey.key_id,
      principalId: membership.principal_id,
      membershipId: membership.membership_id,
    });

    const nodes = new DecisionNodeStore(join(root, 'member'), {
      now: () => NOW,
    });
    const requested = await nodes.ensureRequested(approvalRequest(decisionText));
    const approvalId = requested.approval_id;
    const evidence: OrganizationRecordAuthorizationEvidence = {
      schema_version: 1,
      kind: 'echo-organization-authorization-evidence',
      authority_id: serveConfig.authority_id,
      organization_id: serveConfig.organization_id,
      enrollment_id: enrollmentId,
      installation_id: installationId,
      request_id: `pcr_${randomUUID()}`,
      approval_id: approvalId,
      action: 'approve',
      request_sha256: digest('pilot-request'),
      provider_event_sha256: digest('pilot-provider-event'),
      allowed: true,
      reason_code: 'active_membership_and_direct_grant',
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      adapter_binding_id: surface.adapter_binding_id,
      permission_grant_id: surface.approve_permission_grant_id,
      evaluated_at: NOW,
    };
    integrations.recordPermissionDecision({
      request_id: evidence.request_id,
      request_sha256: evidence.request_sha256 as Sha256Digest,
      provider_event_sha256: evidence.provider_event_sha256 as Sha256Digest,
      action: 'approve',
      allowed: true,
      reason_code: 'active_membership_and_direct_grant',
      principal_id: evidence.principal_id,
      membership_id: evidence.membership_id,
      adapter_binding_id: evidence.adapter_binding_id,
      permission_grant_id: evidence.permission_grant_id,
      evaluated_at: evidence.evaluated_at,
      authority_evidence_sha256: digest('pilot-authority-status'),
      authority_checked_at: evidence.evaluated_at,
      organization_id: serveConfig.organization_id,
      caller_principal_id: evidence.principal_id,
      caller_membership_id: evidence.membership_id,
      installation_id: installationId,
      identity_link_id: null,
      connection_id: null,
      approval_id: approvalId,
      detail: {
        provider: 'slack',
        provider_tenant_id: 'T12345678',
        provider_subject_id: 'U12345678',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        channel_id: 'C12345678',
        message_ts: '1721678400.123456',
        reaction_name: 'white_check_mark',
      },
    });
    await nodes.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'Ada Founder',
      surface: 'slack-reactions',
      metadata: JSON.parse(
        canonicalJson({ authorization: evidence }),
      ) as JsonObject,
    });

    const closedRepository = integrations;
    let closed = false;
    return {
      origin,
      stateDirectory,
      serveConfig,
      nodes,
      installationId,
      installationSigningKey,
      signCanonicalBytes: (bytes) =>
        installationSigner.sign(
          installationId,
          bytes,
          installationSigningKey.key_id,
        ),
      pinnedAuthority,
      fetch: proxyFetch,
      loseNextRecordResponse: () => {
        dropNextRecordResponse = true;
      },
      fatalFailure: runtime.fatalFailure,
      plantUnderivableRecord: () =>
        plantUnderivableRecord(
          paths.record_log_database_path,
          serveConfig.organization_id,
          serveConfig.authority_id,
        ),
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        closedRepository.close();
        state.close();
        await runtime.close();
      },
    };
  } catch (error) {
    integrations?.close();
    state.close();
    await runtime.close();
    throw error;
  }
}

function seedSlackApprovalSurface(
  database: Database.Database,
  input: {
    organizationId: string;
    installationId: string;
    installationKeyId: string;
    principalId: string;
    membershipId: string;
  },
): { adapter_binding_id: string; approve_permission_grant_id: string } {
  const attemptId = 'cat_record-pilot-attempt';
  const connectionId = 'con_record-pilot';
  const adapterBindingId = `bnd_${randomUUID()}`;
  const approvePermissionGrantId = `pgr_${randomUUID()}`;
  const scopesJson =
    '["channels:history","channels:read","chat:write","reactions:read","users:read"]';
  database
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
      input.organizationId,
      input.principalId,
      input.membershipId,
      scopesJson,
      digest(scopesJson),
      digest('state'),
      digest('nonce'),
      digest('pkce'),
      digest('admin-session'),
      NOW,
      new Date(Date.parse(NOW) + 600_000).toISOString(),
    );
  database
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
      NOW,
      attemptId,
    );
  database
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
         'sch_record-pilot', 'active', ?, ?, ?, NULL, NULL, ?, ?
       )`,
    )
    .run(
      connectionId,
      input.organizationId,
      scopesJson,
      digest(scopesJson),
      attemptId,
      digest('verification-evidence'),
      input.principalId,
      input.membershipId,
      NOW,
      SLACK_TOOL_CONFIGURATION_JSON,
      digest(SLACK_TOOL_CONFIGURATION_JSON),
    );
  database
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
      input.organizationId,
      input.installationId,
      input.installationKeyId,
      connectionId,
      SLACK_BINDING_CONFIGURATION_JSON,
      digest(SLACK_BINDING_CONFIGURATION_JSON),
      input.principalId,
      input.membershipId,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO organization_permission_grants (
         permission_grant_id, organization_id, adapter_binding_id,
         principal_id, membership_id, action, resource_scope_json, status,
         granted_by_principal_id, granted_by_membership_id, granted_at,
         revoked_at, revocation_reason
       ) VALUES (?, ?, ?, ?, ?, 'approve', '{}', 'active', ?, ?, ?, NULL, NULL)`,
    )
    .run(
      approvePermissionGrantId,
      input.organizationId,
      adapterBindingId,
      input.principalId,
      input.membershipId,
      input.principalId,
      input.membershipId,
      NOW,
    );
  return {
    adapter_binding_id: adapterBindingId,
    approve_permission_grant_id: approvePermissionGrantId,
  };
}

function recordClient(pilot: RecordPilot): HttpOrganizationRecordClient {
  return new HttpOrganizationRecordClient({
    baseUrl: pilot.origin,
    pinnedAuthority: pilot.pinnedAuthority,
    installationSigningKey: pilot.installationSigningKey,
    fetch: pilot.fetch,
    allowInsecureLoopback: true,
  });
}

function envelopeBuilder(
  pilot: RecordPilot,
): ProtocolOrganizationRecordEnvelopeBuilder {
  return new ProtocolOrganizationRecordEnvelopeBuilder({
    pinnedAuthority: pilot.pinnedAuthority,
    installationSigningKey: pilot.installationSigningKey,
    sign: pilot.signCanonicalBytes,
  });
}

function recordSubmitter(pilot: RecordPilot): OrganizationRecordSubmitter {
  return new OrganizationRecordSubmitter({
    nodes: pilot.nodes,
    envelopes: envelopeBuilder(pilot),
    client: recordClient(pilot),
    installationId: pilot.installationId,
    exclusion: createOrganizationIngestExclusion({ sources: [], meetings: [] }),
    now: () => NOW,
  });
}

function logRows(
  stateDirectory: string,
): ReadonlyArray<{ position: number; envelope_sha256: string }> {
  const database = openOrganizationRecordDatabase(
    authorityStatePaths(stateDirectory).record_log_database_path,
    ORGANIZATION_RECORD_LOG_DATABASE,
    { readonly: true },
  );
  try {
    return database
      .prepare(
        `SELECT position, envelope_sha256 FROM organization_record_log
         ORDER BY position`,
      )
      .all() as Array<{ position: number; envelope_sha256: string }>;
  } finally {
    database.close();
  }
}

function derivedAtomTexts(stateDirectory: string): readonly string[] {
  const database = openOrganizationRecordDatabase(
    authorityStatePaths(stateDirectory).record_derived_database_path,
    ORGANIZATION_RECORD_DERIVED_DATABASE,
    { readonly: true },
  );
  try {
    return (
      database
        .prepare(`SELECT text FROM organization_derived_atom ORDER BY atom_id`)
        .all() as Array<{ text: string }>
    ).map(({ text }) => text);
  } finally {
    database.close();
  }
}

describe('organization record pilot over the real authority listener', () => {
  it('durably submits and derives one record, including lost-response recovery', async () => {
    const pilot = await startRecordPilot();
    try {
      const submitter = recordSubmitter(pilot);
      pilot.loseNextRecordResponse();
      const lost = await submitter.sweep();

      // Retryable, never terminal: the append committed on the authority, so
      // writing a rejection slot here would strand a durable record forever.
      expect(lost).toMatchObject({ ok: true, retried: 1, published: 0 });
      const outbound = await pilot.nodes.getState(PROCESSING_KEY);
      expect(outbound?.organization_record.status).toBe('outbound');
      const frozen = outbound?.organization_record.envelope;
      expect(frozen?.envelope_sha256).toBeDefined();

      const recovered = await submitter.sweep();

      expect(recovered).toMatchObject({ ok: true, published: 1 });
      const node = await pilot.nodes.getState(PROCESSING_KEY);
      expect(node?.organization_record.status).toBe('published');
      expect(node?.organization_record.receipt?.position).toBe(1);
      // The resend used the exact frozen bytes, not a rebuilt envelope.
      expect(node?.organization_record.envelope?.envelope_sha256).toBe(
        frozen?.envelope_sha256,
      );
      expect(node?.organization_record.receipt?.envelope_sha256).toBe(
        frozen?.envelope_sha256,
      );
    } finally {
      await pilot.close();
    }

    expect(logRows(pilot.stateDirectory)).toHaveLength(1);
    expect(derivedAtomTexts(pilot.stateDirectory)).toEqual([DECISION_TEXT]);
  });

  it('takes the host down when derive halts under a live listener', async () => {
    const originalExitCode = process.exitCode;
    const pilot = await startRecordPilot();
    try {
      // Startup catch-up already passed on an empty log. This row arrives
      // afterwards, so only the post-start rule can catch it.
      pilot.plantUnderivableRecord();
      const submitter = recordSubmitter(pilot);
      const published = await submitter.sweep();
      expect(published).toMatchObject({ ok: true, published: 1 });

      const failure = await pilot.fatalFailure;

      expect(failure.message).toContain('organization record derive halted');
      // A supervisor must be able to tell: non-zero exit, and a listener that
      // no longer answers. A process that keeps accepting appends nothing will
      // ever derive is the silent staleness the design forbids.
      expect(process.exitCode).toBe(1);
      const afterHalt = await recordClient(pilot).submitRecord({
        envelope_id: 'rec_00000000-0000-4000-8000-000000000001',
        idempotency_key: 'b'.repeat(64),
        envelope_sha256: `sha256:${'0'.repeat(64)}`,
        envelope: { kind: 'echo-organization-record-envelope' },
      });
      expect(afterHalt.outcome).toBe('retry');
      await expect(fetch(pilot.origin)).rejects.toThrow();
      // `fatalFailure` resolves only after the automatic shutdown settles. No
      // explicit `close()` has run, so this proves the fatal path itself frees
      // singleton ownership for the supervisor replacement.
      expect(
        await inspectAuthorityRuntimeLock(pilot.stateDirectory),
      ).toMatchObject({ present: false, active: false });
      const replacement = await acquireAuthorityRuntimeLock(
        pilot.stateDirectory,
        authorityRuntimeFingerprint(pilot.serveConfig),
      );
      await replacement.release();
    } finally {
      process.exitCode = originalExitCode;
      // The stop reports the halt it already signalled; that is the contract,
      // not a teardown failure.
      await pilot.close().catch(() => undefined);
    }
  });

});

/**
 * A chain-valid row the follower cannot project, written through a second
 * connection so the running host never sees a nudge for it. Ingest-time payload
 * validation should make this impossible; the point of the test is what happens
 * when it is not.
 */
function plantUnderivableRecord(
  logDatabasePath: string,
  organizationId: string,
  authorityId: string,
): void {
  const envelopeId = 'rec_00000000-0000-4000-8000-000000000000';
  const installationId = 'ins_00000000-0000-4000-8000-000000000000';
  const idempotencyKey = 'a'.repeat(64);
  const canonicalEnvelope = canonicalJson({
    envelope_id: envelopeId,
    event_type: 'approval',
    idempotency_key: idempotencyKey,
    submitter: { installation_id: installationId },
    payload: null,
  });
  const envelopeSha256 = sha256Digest(canonicalEnvelope);
  const recordHash = organizationRecordHash(
    organizationRecordFrame({
      organization_id: organizationId,
      position: 1,
      previous_record_hash: null,
      recorded_at: NOW,
      envelope_sha256: envelopeSha256,
    }),
  );
  const database = new Database(logDatabasePath);
  try {
    database
      .prepare(
        `INSERT INTO organization_record_log (
           position, envelope_id, event_type, installation_id,
           idempotency_key, canonical_envelope, envelope_sha256,
           receipt_payload, previous_record_hash, record_hash, recorded_at
         ) VALUES (1, 'rec_00000000-0000-4000-8000-000000000000', 'approval',
           'ins_00000000-0000-4000-8000-000000000000', ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        idempotencyKey,
        canonicalEnvelope,
        envelopeSha256,
        canonicalJson(
          organizationRecordReceiptPayload({
            authority_id: authorityId,
            organization_id: organizationId,
            envelope_id: envelopeId,
            envelope_sha256: envelopeSha256,
            installation_id: installationId,
            idempotency_key: idempotencyKey,
            position: 1,
            record_hash: recordHash,
            recorded_at: NOW,
          }),
        ),
        recordHash,
        NOW,
      );
  } finally {
    database.close();
  }
}
