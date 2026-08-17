import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
  organizationSlackLinkChallengeCodeSha256,
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  verifyOrganizationRecentDecisionsRequest,
  verifyOrganizationSlackLinkBeginRequest,
  verifyOrganizationSlackLinkCompleteRequest,
  type OrganizationRecentDecisionsRequestV1,
  type OrganizationSlackLinkBeginRequestV1,
  type OrganizationSlackLinkCompleteRequestV1,
} from '@echo-brain/organization-api';
import {
  organizationEnrollmentGrantSha256,
  type OrganizationRecordEnvelopeAnyVersion,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessStateV1,
} from '@echo-brain/organization-protocol';
import type {
  ApprovalRequest,
  MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import { decisionApprovalId } from '@echo-brain/organization-authority/processing/approval/decision-node.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import {
  runProductCli,
  type ProductCliDependencies,
} from '../../src/product/cli.js';
import type { InstallationSigner } from '../../src/product/machine/security/installation-signer.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/index.js';
import { readPrivateOrganizationEnrollmentInvitation } from '../../src/product/organization/enrollment/private-organization-invitation.js';
import { resolveProductStatePaths } from '../../src/product/paths.js';
import { SqliteCoreStateStore } from '../../src/product/storage/sqlite-core-state-store.js';
import { acquireProductLifecycleLock } from '../../src/product/lifecycle-lock.js';
import {
  fixtureId,
  GRANT,
  ORGANIZATION_IDS,
  protocolInstallationKey,
  requestedAccessLeaseTtlMs,
  TestAuthority,
  TestInstallationSigner,
} from '../support/local-organization-fixtures.js';

const roots: string[] = [];
const ENROLLMENT_TIME = '2026-07-22T00:02:00.000Z';
const REFRESH_TIME = '2026-07-22T00:03:00.000Z';
const AUTHORITY_ORIGIN = 'https://authority.example.test';

function output() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += chunk.toString();
        return true;
      },
    },
    read: () => value,
  };
}

async function command(
  argv: readonly string[],
  dependencies: ProductCliDependencies,
) {
  const stdout = output();
  const stderr = output();
  const status = await runProductCli(argv, {
    ...dependencies,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { status, stdout: stdout.read(), stderr: stderr.read() };
}

function writeRuntimeConfig(
  root: string,
  options: { slackApproval?: boolean } = {},
): {
  configPath: string;
  stateDirectory: string;
} {
  const stateDirectory = join(root, 'state');
  const configPath = join(root, 'runtime.json');
  const slackCredentialPath = join(
    stateDirectory,
    'credentials',
    'slack-bot-token',
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schema_version: 1,
      lane: 'team-product',
      state_dir: stateDirectory,
      meeting_sources: [
        {
          adapter_id: 'granola',
          instance_id: 'primary',
          settings: {},
        },
      ],
      decision_processor: {
        adapter_id: 'structured-text',
        instance_id: 'primary',
        settings: {},
      },
      delivery_surfaces: [
        {
          adapter_id: 'jsonl-outbox',
          instance_id: 'local',
          settings: {
            path: join(stateDirectory, 'outbox.jsonl'),
            destination_id: 'local-outbox',
          },
        },
      ],
      ...(options.slackApproval === true
        ? {
            approval_mode: 'adapter',
            approval_surface: {
              adapter_id: 'slack-reactions',
              instance_id: 'founder-approvals',
              credential_ref: `file:${slackCredentialPath}`,
              settings: {
                channel_id: 'C123CHANNEL',
                reviewer: {
                  slack_user_id: 'U123ZHEN',
                  name: 'Zhenye',
                },
              },
            },
          }
        : { approval_mode: 'manual' }),
    })}\n`,
    { mode: 0o600 },
  );
  return { configPath, stateDirectory };
}

function recordApprovalRequest(suffix = 'yen-live-test'): ApprovalRequest {
  const meetingId = `granola:${suffix}`;
  const signal = {
    id: 'decision-1',
    kind: 'decision' as const,
    text: 'Keep the organization record flush independent from meeting ingest.',
    subject: null,
    confidence: null,
    evidence: [{ meeting_id: meetingId, block_id: 'notes-1' }],
    status: 'decided' as const,
  };
  return {
    processing_key:
      `granola:primary:${suffix}:rev-1:structured-text:primary:1.0.0`,
    requested_at: ENROLLMENT_TIME,
    meeting: {
      schema_version: 1,
      id: meetingId,
      title: 'Yen live test',
      time: { actual_start_at: '2026-07-21T23:00:00.000Z' },
      capture: {
        state: 'complete',
        components: [{ kind: 'notes', state: 'available' }],
      },
      participants: [],
      content: [
        {
          id: 'notes-1',
          kind: 'note',
          text: signal.text,
        },
      ],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'granola',
          instance_id: 'primary',
          version: '1.0.0',
        },
        external_id: suffix,
        canonical_revision: 'rev-1',
        observed_at: ENROLLMENT_TIME,
        normalizer_version: '1.0.0',
        source_updated_at: '2026-07-21T23:30:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: meetingId,
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'primary',
        version: '1.0.0',
      },
      generated_at: ENROLLMENT_TIME,
      signals: [signal],
    },
    brief: {
      schema_version: 1,
      id: `${suffix}-brief-1`,
      meeting: {
        id: meetingId,
        title: 'Yen live test',
        time: { actual_start_at: '2026-07-21T23:00:00.000Z' },
        participants: [],
      },
      decisions: [signal],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'rev-1',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'primary',
          version: '1.0.0',
        },
        generated_at: ENROLLMENT_TIME,
      },
    },
  };
}

function recordAuthorizationEvidence(
  authority: TestAuthority,
  approvalId: string,
  suffix: number,
) {
  return {
    schema_version: 1,
    kind: 'echo-organization-authorization-evidence',
    authority_id: authority.descriptor.authority_id,
    organization_id: authority.descriptor.organization_id,
    enrollment_id: ORGANIZATION_IDS.enrollment,
    installation_id: ORGANIZATION_IDS.installation,
    request_id: fixtureId('pcr', suffix),
    approval_id: approvalId,
    action: 'approve',
    request_sha256: canonicalSha256(`record-flush-request-${suffix}`),
    provider_event_sha256: canonicalSha256(
      `record-flush-provider-event-${suffix}`,
    ),
    allowed: true,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: ORGANIZATION_IDS.principal,
    membership_id: ORGANIZATION_IDS.membership,
    adapter_binding_id: fixtureId('bnd', 1),
    permission_grant_id: fixtureId('pgr', 1),
    evaluated_at: ENROLLMENT_TIME,
  } as const;
}

function invitationPath(
  root: string,
  authority: TestAuthority,
  expiresAt = '2026-07-22T01:00:00.000Z',
  grant: Buffer = GRANT,
  filename = 'echo-organization-invitation.json',
): string {
  const path = join(root, filename);
  const grantSha256 = organizationEnrollmentGrantSha256(grant);
  const invitation = {
    schema_version: 1,
    kind: 'echo-organization-enrollment-invitation',
    status: 'issued',
    authority_base_url: AUTHORITY_ORIGIN,
    authority_id: authority.descriptor.authority_id,
    authority_pin_sha256: authority.pin,
    authority_pin_verification: 'independent_pin_required',
    organization_id: authority.descriptor.organization_id,
    membership_id: ORGANIZATION_IDS.membership,
    command_id: 'adm_00000000-0000-4000-8000-000000000001',
    enrollment_grant_sha256: grantSha256,
    enrollment_grant_base64url: grant.toString('base64url'),
    lifetime_seconds:
      (Date.parse(expiresAt) - Date.parse('2026-07-22T00:00:00.000Z')) /
      1000,
    issued: {
      authority_id: authority.descriptor.authority_id,
      authority_pin_sha256: authority.pin,
      organization_id: authority.descriptor.organization_id,
      principal_id: ORGANIZATION_IDS.principal,
      membership_id: ORGANIZATION_IDS.membership,
      enrollment_grant_sha256: grantSha256,
      issued_at: '2026-07-22T00:00:00.000Z',
      expires_at: expiresAt,
    },
  } as const;
  writeFileSync(path, `${canonicalJson(invitation)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('organization machine CLI', () => {
  it('refuses an invitation file that is readable by other users', () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-invite-mode-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const authority = new TestAuthority();
    const path = invitationPath(root, authority);
    chmodSync(path, 0o644);

    expect(() =>
      readPrivateOrganizationEnrollmentInvitation(path),
    ).toThrow('0600');
  });

  it('enrolls from a private invitation, persists status, and refreshes without the invitation', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-cli-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const { configPath, stateDirectory } = writeRuntimeConfig(root);
    const authority = new TestAuthority();
    const invitePath = invitationPath(root, authority);
    let clock = ENROLLMENT_TIME;
    let request: OrganizationEnrollmentRequestV1 | null = null;
    let accessState: OrganizationInstallationAccessStateV1 | null = null;
    const recentRequests: OrganizationRecentDecisionsRequestV1[] = [];
    let malformedRecentResponse = false;
    const lifecycleKinds: string[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/authority-descriptor') {
        return Response.json({
          authority_descriptor: authority.descriptor,
        });
      }
      if (url.pathname === '/v1/enrollments') {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Echo-Enrollment ${GRANT.toString('base64url')}`,
        );
        const body = JSON.parse(String(init?.body)) as {
          enrollment_request: OrganizationEnrollmentRequestV1;
        };
        request = body.enrollment_request;
        const completion = await authority.complete(request);
        accessState = completion.access_state;
        return Response.json(completion, { status: 201 });
      }
      if (url.pathname === '/v1/access-leases') {
        if (request === null || accessState === null) {
          throw new Error('enrollment must precede refresh');
        }
        const enrollment = await authority.complete(request);
        const activeLeaseTtlMs = requestedAccessLeaseTtlMs(
          JSON.parse(String(init?.body)) as unknown,
        );
        accessState = await authority.nextActiveState(
          request,
          enrollment.enrollment_receipt,
          accessState,
          activeLeaseTtlMs,
        );
        return Response.json({ access_state: accessState });
      }
      if (url.pathname === '/v1/recent-decisions') {
        if (request === null) {
          throw new Error('enrollment must precede recent decisions');
        }
        const body = JSON.parse(
          String(init?.body),
        ) as OrganizationRecentDecisionsRequestV1;
        expect(
          verifyOrganizationRecentDecisionsRequest(
            body,
            request.installation_signing_key,
          ),
        ).toEqual(body);
        recentRequests.push(body);
        return Response.json({
          schema_version: 1,
          policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
          witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
          items: [
            {
              atom_id: `sha256:${'a'.repeat(64)}`,
              kind: 'decision',
              text: 'Ship the exact two-member read.',
              record_hash: `sha256:${'b'.repeat(64)}`,
              ...(malformedRecentResponse ? { log_position: 7 } : {}),
            },
          ],
        });
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const dependencies: ProductCliDependencies = {
      classifyStateFilesystem: async () => ({
        kind: 'local',
        raw: 'apfs',
      }),
      acquireLifecycleLock: async (_stateDirectory, kind) => {
        lifecycleKinds.push(kind);
        return async () => undefined;
      },
      now: () => clock,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        createInstallationId: () => ORGANIZATION_IDS.installation,
      },
    };

    const initialized = await command(
      ['init', '--config', configPath],
      dependencies,
    );
    expect(initialized.status, initialized.stderr).toBe(0);

    const missingAcknowledgement = await command(
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        invitePath,
        '--authority-pin',
        authority.pin,
      ],
      dependencies,
    );
    expect(missingAcknowledgement.status).toBe(2);
    expect(missingAcknowledgement.stderr).toContain(
      'software_key_acknowledgement_required',
    );

    const enrolled = await command(
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        invitePath,
        '--authority-pin',
        authority.pin,
        '--allow-exportable-software-key',
      ],
      dependencies,
    );
    expect(enrolled.status, enrolled.stderr).toBe(0);
    expect(JSON.parse(enrolled.stdout)).toMatchObject({
      ok: true,
      command: 'organization',
      action: 'enroll',
      enrolled: true,
      key_assurance_policy: 'software_key_development_only',
      access: {
        permitted: true,
        status: 'active',
        installation_id: ORGANIZATION_IDS.installation,
        access_state_sequence: 1,
      },
    });
    const status = await command(
      ['organization', 'status', '--config', configPath],
      dependencies,
    );
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      enrolled: true,
      authority_connection: {
        authority_base_url: AUTHORITY_ORIGIN,
      },
      access: {
        permitted: true,
        access_state_sequence: 1,
      },
    });

    const rebound = await command(
      [
        'organization',
        'rebind',
        '--config',
        configPath,
        '--authority-url',
        'https://relocated-authority.example.test',
        '--authority-pin',
        authority.pin,
      ],
      dependencies,
    );
    expect(rebound.status, rebound.stderr).toBe(0);
    expect(JSON.parse(rebound.stdout)).toMatchObject({
      ok: true,
      action: 'rebind',
      authority_connection: {
        authority_base_url: 'https://relocated-authority.example.test',
      },
    });

    rmSync(invitePath);
    clock = REFRESH_TIME;
    const refreshed = await command(
      ['organization', 'refresh', '--config', configPath],
      dependencies,
    );
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({
      ok: true,
      action: 'refresh',
      access: {
        permitted: true,
        access_state_sequence: 2,
      },
    });
    lifecycleKinds.length = 0;
    const recent = await command(
      ['organization', 'recent-decisions', '--config', configPath],
      dependencies,
    );
    expect(recent.status, recent.stderr).toBe(0);
    expect(JSON.parse(recent.stdout)).toEqual({
      schema_version: 1,
      policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
      witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
      items: [
        {
          atom_id: `sha256:${'a'.repeat(64)}`,
          kind: 'decision',
          text: 'Ship the exact two-member read.',
          record_hash: `sha256:${'b'.repeat(64)}`,
        },
      ],
    });
    expect(JSON.parse(recent.stdout)).not.toHaveProperty('ok');
    expect(lifecycleKinds).toEqual(['maintenance']);
    expect(recentRequests).toHaveLength(1);
    expect(recentRequests[0]).toMatchObject({
      request_id: expect.stringMatching(
        /^rdr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      http_method: 'POST',
      http_path: '/v1/recent-decisions',
      requested_at: REFRESH_TIME,
    });

    malformedRecentResponse = true;
    const malformedRecent = await command(
      ['organization', 'recent-decisions', '--config', configPath],
      dependencies,
    );
    expect(malformedRecent.status).toBe(1);
    expect(malformedRecent.stdout).toBe('');
    expect(malformedRecent.stderr).toContain('malformed response');
    expect(
      statSync(
        join(
          stateDirectory,
          'installation',
          'keys',
          `${ORGANIZATION_IDS.installation}.key-state.v1.json`,
        ),
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it('flushes one resolved organization record without loading adapters or advancing the meeting cursor', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-record-flush-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const { configPath, stateDirectory } = writeRuntimeConfig(root);
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    const invitePath = invitationPath(root, authority);
    const lifecycleKinds: string[] = [];
    const authorityPaths: string[] = [];
    let enrollmentRequest: OrganizationEnrollmentRequestV1 | null = null;
    let retryRecordSubmission = false;
    let meetingSourceFactories = 0;
    let meetingSourcePulls = 0;
    const adapterFactories = new ProductAdapterFactoryRegistry();
    adapterFactories.register({
      kind: 'meeting-source',
      adapter_id: 'granola',
      create: (adapterConfig): MeetingSourceAdapter => {
        meetingSourceFactories += 1;
        return {
          identity: {
            kind: 'meeting-source',
            adapter_id: adapterConfig.adapter_id,
            instance_id: adapterConfig.instance_id,
            version: 'test-must-not-load',
          },
          validateConfig: () => ({ ok: true, errors: [] }),
          healthCheck: async () => ({
            status: 'healthy',
            checked_at: ENROLLMENT_TIME,
          }),
          pull: async () => {
            meetingSourcePulls += 1;
            throw new Error('record flush must not pull a meeting source');
          },
        };
      },
    });

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      authorityPaths.push(url.pathname);
      if (url.pathname === '/v1/authority-descriptor') {
        return Response.json({ authority_descriptor: authority.descriptor });
      }
      if (url.pathname === '/v1/enrollments') {
        const body = JSON.parse(String(init?.body)) as {
          enrollment_request: OrganizationEnrollmentRequestV1;
        };
        enrollmentRequest = body.enrollment_request;
        return Response.json(await authority.complete(enrollmentRequest), {
          status: 201,
        });
      }
      if (url.pathname === ORGANIZATION_API_RECORD_ENVELOPES_PATH) {
        if (retryRecordSubmission) {
          throw new Error('simulated organization record outage');
        }
        if (enrollmentRequest === null) {
          throw new Error('record submission must follow enrollment');
        }
        const body = JSON.parse(String(init?.body)) as {
          record_envelope: OrganizationRecordEnvelopeAnyVersion;
        };
        const receipt = await authority.recordReceipt(
          body.record_envelope,
          protocolInstallationKey(installationSigner),
          { position: 23, recordedAt: ENROLLMENT_TIME },
        );
        return Response.json({ record_receipt: receipt });
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const dependencies: ProductCliDependencies = {
      adapterFactories,
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      acquireLifecycleLock: async (_stateDirectory, kind) => {
        lifecycleKinds.push(kind);
        return async () => undefined;
      },
      now: () => ENROLLMENT_TIME,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        installationSigner,
        createInstallationId: () => ORGANIZATION_IDS.installation,
      },
    };

    const initialized = await command(
      ['init', '--config', configPath],
      dependencies,
    );
    expect(initialized.status, initialized.stderr).toBe(0);
    const enrolled = await command(
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        invitePath,
        '--authority-pin',
        authority.pin,
      ],
      dependencies,
    );
    expect(enrolled.status, enrolled.stderr).toBe(0);

    const request = recordApprovalRequest();
    const approvalId = decisionApprovalId(request.processing_key);
    const nodes = new DecisionNodeStore(stateDirectory, {
      now: () => ENROLLMENT_TIME,
    });
    await nodes.ensureRequested(request);
    await nodes.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'Yen Reviewer',
      surface: 'slack',
      metadata: {
        authorization: recordAuthorizationEvidence(authority, approvalId, 1),
      },
    });

    const source = request.meeting.provenance.source;
    const databasePath = resolveProductStatePaths(stateDirectory).database;
    const coreBefore = new SqliteCoreStateStore(databasePath);
    await coreBefore.setSourceCursor(source, 'yen-cursor-before-flush');
    coreBefore.close();
    lifecycleKinds.length = 0;
    authorityPaths.length = 0;

    const flushed = await command(
      ['organization', 'record-flush', '--config', configPath],
      dependencies,
    );

    expect(flushed.status, flushed.stderr).toBe(0);
    expect(flushed.stderr).toBe('');
    expect(JSON.parse(flushed.stdout)).toMatchObject({
      ok: true,
      command: 'organization',
      action: 'record-flush',
      sweep: {
        ok: true,
        examined: 1,
        published: 1,
        rejected: 0,
        retried: 0,
      },
      published_records: [
        {
          approval_id: approvalId,
          receipt_summary: {
            schema_version: 1,
            kind: 'echo-organization-record-receipt',
            position: 23,
            installation_id: ORGANIZATION_IDS.installation,
            idempotency_key: approvalId,
          },
        },
      ],
      rejected_records: [],
    });
    expect(lifecycleKinds).toEqual(['runtime', 'maintenance']);
    expect(authorityPaths).toEqual([ORGANIZATION_API_RECORD_ENVELOPES_PATH]);
    expect(meetingSourceFactories).toBe(0);
    expect(meetingSourcePulls).toBe(0);

    const [published] = await nodes.list();
    expect(published?.organization_record.status).toBe('published');
    expect(published?.organization_record.receipt?.position).toBe(23);
    const coreAfter = new SqliteCoreStateStore(databasePath);
    await expect(coreAfter.getSourceCursor(source)).resolves.toBe(
      'yen-cursor-before-flush',
    );
    coreAfter.close();

    // A transient send is not a successful operator flush even though the
    // submitter intentionally keeps it retryable and alert-free.
    const retryRequest = recordApprovalRequest('yen-retry');
    const retryApprovalId = decisionApprovalId(retryRequest.processing_key);
    await nodes.ensureRequested(retryRequest);
    await nodes.resolve({
      approvalId: retryApprovalId,
      status: 'approved',
      reviewedBy: 'Yen Reviewer',
      surface: 'slack',
      metadata: {
        authorization: recordAuthorizationEvidence(
          authority,
          retryApprovalId,
          2,
        ),
      },
    });
    retryRecordSubmission = true;
    authorityPaths.length = 0;
    const retried = await command(
      ['organization', 'record-flush', '--config', configPath],
      dependencies,
    );
    expect(retried.status).toBe(1);
    expect(retried.stdout).toBe('');
    expect(JSON.parse(retried.stderr)).toMatchObject({
      ok: false,
      command: 'organization',
      action: 'record-flush',
      candidate_records: 1,
      sweep: { ok: true, retried: 1, published: 0, rejected: 0 },
      published_records: [],
      rejected_records: [],
    });
    expect(authorityPaths).toEqual([ORGANIZATION_API_RECORD_ENVELOPES_PATH]);

    // Holding the runtime lease models an active service. The maintenance
    // command fails before access verification or any Authority request.
    authorityPaths.length = 0;
    const releaseRuntime = await acquireProductLifecycleLock(
      stateDirectory,
      'runtime',
    );
    try {
      const blocked = await command(
        ['organization', 'record-flush', '--config', configPath],
        { ...dependencies, acquireLifecycleLock: undefined },
      );
      expect(blocked.status).toBe(1);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toContain('process lock is busy');
      expect(authorityPaths).toEqual([]);
    } finally {
      await releaseRuntime();
    }

    // Close the clean-at-dispatch to residue-after-lock race before the flush
    // opens organization state, inspects/signs with the installation key, or
    // contacts the Authority.
    authorityPaths.length = 0;
    const signCallsBeforeRace = installationSigner.signCalls;
    let residueInjected = false;
    const raced = await command(
      ['organization', 'record-flush', '--config', configPath],
      {
        ...dependencies,
        acquireLifecycleLock: async (_stateDirectory, kind) => {
          if (kind === 'runtime' && !residueInjected) {
            residueInjected = true;
            const manifests = join(
              resolveProductStatePaths(stateDirectory).identityRoot,
              'manifests',
            );
            mkdirSync(manifests, { recursive: true, mode: 0o700 });
            writeFileSync(join(manifests, 'idm_race.v1.json'), '{}', {
              mode: 0o600,
            });
          }
          return async () => undefined;
        },
      },
    );
    expect(residueInjected).toBe(true);
    expect(raced.status).toBe(1);
    expect(raced.stdout).toBe('');
    expect(raced.stderr).toContain('founder identity or cutover material');
    expect(authorityPaths).toEqual([]);
    expect(installationSigner.signCalls).toBe(signCallsBeforeRace);
  });

  it('re-checks founder residue after the descriptor fetch, before any enrollment step', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-cli-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const { configPath, stateDirectory } = writeRuntimeConfig(root);
    const authority = new TestAuthority();
    const invitePath = invitationPath(root, authority);
    const seams: string[] = [];

    // The residue lands while the Authority descriptor is being read: after
    // the early dispatch gate passed a clean root, before an installation
    // identity is chosen. No test-only product seam exists for this; the
    // injection rides the ordinary fetch dependency.
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seams.push(`fetch ${url.pathname}`);
      if (url.pathname === '/v1/authority-descriptor') {
        const manifests = join(stateDirectory, 'identity', 'manifests');
        mkdirSync(manifests, { recursive: true, mode: 0o700 });
        writeFileSync(join(manifests, 'idm_race.v1.json'), '{}', {
          mode: 0o600,
        });
        return Response.json({ authority_descriptor: authority.descriptor });
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const signer: InstallationSigner = {
      generate: async (installationId) => {
        seams.push(`signer.generate ${installationId}`);
        throw new Error('signer must not run on a fenced root');
      },
      inspect: async (installationId) => {
        seams.push(`signer.inspect ${installationId}`);
        throw new Error('signer must not run on a fenced root');
      },
      sign: async (installationId) => {
        seams.push(`signer.sign ${installationId}`);
        throw new Error('signer must not run on a fenced root');
      },
    };
    const dependencies: ProductCliDependencies = {
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      now: () => ENROLLMENT_TIME,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        installationSigner: signer,
        createInstallationId: () => {
          seams.push('createInstallationId');
          return ORGANIZATION_IDS.installation;
        },
      },
    };

    const initialized = await command(
      ['init', '--config', configPath],
      dependencies,
    );
    expect(initialized.status, initialized.stderr).toBe(0);

    const enroll = await command(
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        invitePath,
        '--authority-pin',
        authority.pin,
      ],
      dependencies,
    );
    expect(enroll.status).toBe(1);
    expect(enroll.stderr).toMatch(/is retired/);
    // The descriptor read happened; nothing after the late re-check did: no
    // installation id was generated, no signer key material was created or
    // exercised, and no enrollment request left the machine.
    expect(seams).toEqual(['fetch /v1/authority-descriptor']);
    expect(
      existsSync(join(stateDirectory, 'identity', 'manifests', 'idm_race.v1.json')),
    ).toBe(true);

    // No pending enrollment state was persisted for a later retry to resume.
    const state = new SqliteOrganizationStateStore(
      join(stateDirectory, 'echo-brain.sqlite'),
    );
    try {
      expect(state.readEnrollment()).toBeNull();
    } finally {
      state.close();
    }
  });

  it('recovers an exact enrollment retry after response loss and invitation expiry', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-recovery-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const { configPath } = writeRuntimeConfig(root);
    const authority = new TestAuthority();
    const invitePath = invitationPath(
      root,
      authority,
      '2026-07-22T00:02:30.000Z',
    );
    let clock = ENROLLMENT_TIME;
    let loseFirstResponse = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/authority-descriptor') {
        return Response.json({
          authority_descriptor: authority.descriptor,
        });
      }
      if (url.pathname === '/v1/enrollments') {
        const body = JSON.parse(String(init?.body)) as {
          enrollment_request: OrganizationEnrollmentRequestV1;
        };
        const completion = await authority.complete(body.enrollment_request);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('simulated response loss after authority commit');
        }
        return Response.json(completion, { status: 200 });
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const dependencies: ProductCliDependencies = {
      classifyStateFilesystem: async () => ({
        kind: 'local',
        raw: 'apfs',
      }),
      now: () => clock,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        createInstallationId: () => ORGANIZATION_IDS.installation,
      },
    };
    expect(
      (
        await command(['init', '--config', configPath], dependencies)
      ).status,
    ).toBe(0);
    const enrollArgs = [
      'organization',
      'enroll',
      '--config',
      configPath,
      '--invitation',
      invitePath,
      '--authority-pin',
      authority.pin,
      '--allow-exportable-software-key',
    ] as const;
    const lost = await command(enrollArgs, dependencies);
    expect(lost.status).toBe(1);
    expect(lost.stderr).toContain('simulated response loss');

    clock = REFRESH_TIME;
    const recovered = await command(enrollArgs, dependencies);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      enrolled: true,
      access: { permitted: true, access_state_sequence: 1 },
    });
  });

  it('clears an unconsumed expired pending request before a fresh invitation', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-abandon-')),
    );
    chmodSync(root, 0o700);
    roots.push(root);
    const { configPath } = writeRuntimeConfig(root);
    const authority = new TestAuthority();
    const expiredInvite = invitationPath(
      root,
      authority,
      '2026-07-22T00:02:30.000Z',
    );
    let clock = ENROLLMENT_TIME;
    let enrollmentAttempt = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/authority-descriptor') {
        return Response.json({
          authority_descriptor: authority.descriptor,
        });
      }
      if (url.pathname === '/v1/enrollments') {
        enrollmentAttempt += 1;
        if (enrollmentAttempt === 1) {
          throw new Error('simulated loss before authority commit');
        }
        if (enrollmentAttempt === 2) {
          return Response.json(
            {
              error: {
                code: 'unauthorized',
                message: 'enrollment grant is unavailable',
              },
            },
            { status: 401 },
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          enrollment_request: OrganizationEnrollmentRequestV1;
        };
        return Response.json(
          await authority.complete(body.enrollment_request),
          { status: 201 },
        );
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const dependencies: ProductCliDependencies = {
      classifyStateFilesystem: async () => ({
        kind: 'local',
        raw: 'apfs',
      }),
      now: () => clock,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        createInstallationId: () => ORGANIZATION_IDS.installation,
      },
    };
    expect(
      (
        await command(['init', '--config', configPath], dependencies)
      ).status,
    ).toBe(0);
    const argsFor = (path: string) =>
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        path,
        '--authority-pin',
        authority.pin,
        '--allow-exportable-software-key',
      ] as const;

    expect((await command(argsFor(expiredInvite), dependencies)).status).toBe(
      1,
    );
    clock = REFRESH_TIME;
    const abandoned = await command(
      argsFor(expiredInvite),
      dependencies,
    );
    expect(abandoned.status).toBe(1);
    expect(abandoned.stderr).toContain('pending local request was cleared');

    const freshGrant = Buffer.from(
      'fedcba9876543210fedcba9876543210',
      'utf8',
    );
    const freshInvite = invitationPath(
      root,
      authority,
      '2026-07-22T01:00:00.000Z',
      freshGrant,
      'fresh-organization-invitation.json',
    );
    const enrolled = await command(argsFor(freshInvite), dependencies);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    expect(JSON.parse(enrolled.stdout)).toMatchObject({
      enrolled: true,
      access: { permitted: true },
    });
  });

  it('links Slack with a signed installation flow and reads the one-time completion code only from the environment', async () => {
    const temporaryRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-organization-slack-link-cli-')),
    );
    const root = join(temporaryRoot, 'Application Support');
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    roots.push(temporaryRoot);
    const { configPath, stateDirectory } = writeRuntimeConfig(root, {
      slackApproval: true,
    });
    const authority = new TestAuthority();
    const invitePath = invitationPath(root, authority);
    const environment: NodeJS.ProcessEnv = {};
    let enrollmentRequest: OrganizationEnrollmentRequestV1 | null = null;
    const beginRequests: OrganizationSlackLinkBeginRequestV1[] = [];
    const completeRequests: OrganizationSlackLinkCompleteRequestV1[] = [];
    let completionPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/authority-descriptor') {
        return Response.json({
          authority_descriptor: authority.descriptor,
        });
      }
      if (url.pathname === '/v1/enrollments') {
        const body = JSON.parse(String(init?.body)) as {
          enrollment_request: OrganizationEnrollmentRequestV1;
        };
        enrollmentRequest = body.enrollment_request;
        return Response.json(await authority.complete(enrollmentRequest), {
          status: 201,
        });
      }
      if (url.pathname === '/v1/integration-links/slack/challenges') {
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        const body = JSON.parse(
          String(init?.body),
        ) as OrganizationSlackLinkBeginRequestV1;
        if (enrollmentRequest === null) {
          throw new Error('enrollment must precede Slack linking');
        }
        expect(
          verifyOrganizationSlackLinkBeginRequest(
            body,
            enrollmentRequest.installation_signing_key,
          ),
        ).toEqual(body);
        expect(String(init?.body)).not.toContain('slack-bot-token');
        beginRequests.push(body);
        return Response.json({
          schema_version: 1,
          kind: 'echo-organization-slack-link-begin-response',
          challenge_attempt_id:
            'cat_00000000-0000-4000-8000-000000000001',
          provider: 'slack',
          provider_tenant_id: 'T123TEAM',
          channel_id: 'C123CHANNEL',
          challenge_message_ts: '1753891200.123456',
          expires_at: '2026-07-22T00:07:00.000Z',
        });
      }
      if (url.pathname === '/v1/integration-links/slack/completions') {
        completionPosts += 1;
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        const body = JSON.parse(
          String(init?.body),
        ) as OrganizationSlackLinkCompleteRequestV1;
        if (enrollmentRequest === null) {
          throw new Error('enrollment must precede Slack linking');
        }
        expect(
          verifyOrganizationSlackLinkCompleteRequest(
            body,
            enrollmentRequest.installation_signing_key,
          ),
        ).toEqual(body);
        expect(String(init?.body)).not.toContain('slack-bot-token');
        completeRequests.push(body);
        return Response.json({
          schema_version: 1,
          kind: 'echo-organization-slack-link-result',
          identity_link_id:
            'clm_00000000-0000-4000-8000-000000000001',
          connection_id: 'con_00000000-0000-4000-8000-000000000001',
          adapter_binding_id:
            'bnd_00000000-0000-4000-8000-000000000001',
          organization_id: ORGANIZATION_IDS.organization,
          principal_id: ORGANIZATION_IDS.principal,
          membership_id: ORGANIZATION_IDS.membership,
          installation_id: ORGANIZATION_IDS.installation,
          provider: 'slack',
          provider_tenant_id: 'T123TEAM',
          provider_subject_id: 'U123ZHEN',
          channel_id: 'C123CHANNEL',
          linked_at: ENROLLMENT_TIME,
          identity_link_created: true,
          adapter_binding_created: true,
          permission_grants_created: 0,
        });
      }
      throw new Error(`unexpected organization authority path ${url.pathname}`);
    };
    const dependencies: ProductCliDependencies = {
      classifyStateFilesystem: async () => ({
        kind: 'local',
        raw: 'apfs',
      }),
      environment,
      now: () => ENROLLMENT_TIME,
      operator: {
        launchctl: async () => ({
          status: 113,
          stdout: '',
          stderr: 'not loaded',
        }),
        platform: 'darwin',
        architecture: 'arm64',
        uid: statSync(root).uid,
        homeDirectory: join(root, 'home'),
        nodePath: realpathSync(process.execPath),
        nodeVersion: process.version,
        cliPath: realpathSync(import.meta.filename),
      },
      organization: {
        fetch: fetchImpl,
        createInstallationId: () => ORGANIZATION_IDS.installation,
      },
    };

    expect(
      (
        await command(['init', '--config', configPath], dependencies)
      ).status,
    ).toBe(0);
    const enrolled = await command(
      [
        'organization',
        'enroll',
        '--config',
        configPath,
        '--invitation',
        invitePath,
        '--authority-pin',
        authority.pin,
        '--allow-exportable-software-key',
      ],
      dependencies,
    );
    expect(enrolled.status, enrolled.stderr).toBe(0);

    const begun = await command(
      ['organization', 'slack-link-begin', '--config', configPath],
      dependencies,
    );
    expect(begun.status, begun.stderr).toBe(0);
    const begunResult = JSON.parse(begun.stdout) as {
      challenge_code: string;
      next_steps: string[];
    };
    expect(begunResult.challenge_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(beginRequests).toHaveLength(1);
    expect(beginRequests[0]!.challenge_code_sha256).toBe(
      organizationSlackLinkChallengeCodeSha256(
        begunResult.challenge_code,
      ),
    );
    expect(begunResult.next_steps).toContainEqual(
      expect.stringContaining(`--config '${configPath}'`),
    );

    const completeArgs = [
      'organization',
      'slack-link-complete',
      '--config',
      configPath,
      '--challenge-attempt',
      'cat_00000000-0000-4000-8000-000000000001',
      '--challenge-message-ts',
      '1753891200.123456',
    ] as const;
    expect(completeArgs).not.toContain(begunResult.challenge_code);
    const missingCode = await command(completeArgs, dependencies);
    expect(missingCode.status).toBe(1);
    expect(missingCode.stderr).toContain('requires ECHO_SLACK_LINK_CODE');
    expect(completionPosts).toBe(0);

    environment.ECHO_SLACK_LINK_CODE = begunResult.challenge_code;
    const completed = await command(completeArgs, dependencies);
    expect(completed.status, completed.stderr).toBe(0);
    const completedResult = JSON.parse(completed.stdout);
    expect(completedResult).toMatchObject({
      ok: true,
      action: 'slack-link-complete',
      linked: true,
      result: {
        membership_id: ORGANIZATION_IDS.membership,
        provider_subject_id: 'U123ZHEN',
        permission_grants_created: 0,
      },
    });
    expect(completedResult.next_steps).toContainEqual(
      expect.stringContaining(
        'echo-organization-admin slack approval activate',
      ),
    );
    expect(completedResult.next_steps).toContainEqual(
      expect.stringContaining(ORGANIZATION_IDS.membership),
    );
    expect(completeRequests).toHaveLength(1);
    expect(completeRequests[0]!.challenge_code).toBe(
      begunResult.challenge_code,
    );
    expect(completeRequests[0]).toMatchObject({
      expected_provider_subject_id: 'U123ZHEN',
    });
    expect(completeRequests[0]).not.toHaveProperty('provider_subject_id');
    expect(completionPosts).toBe(1);
    expect(
      statSync(
        join(stateDirectory, 'installation', 'keys'),
      ).isDirectory(),
    ).toBe(true);
  });
});
