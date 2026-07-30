import type {
  OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrganizationApprovalActionAuthorizer } from '../../src/product/organization/approval-action-authorizer.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import {
  MAX_TTL_MS,
  NOW,
  ORGANIZATION_IDS,
  TestAuthority,
  TestInstallationSigner,
  allowedPermissionDecision,
  descriptorClient,
  enrollmentInput,
  fixtureId,
} from '../support/local-organization-fixtures.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function enrolledFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-org-authorizer-'));
  directories.push(directory);
  const databasePath = join(directory, 'product.sqlite');
  const authority = new TestAuthority();
  const signer = new TestInstallationSigner();
  const state = new SqliteOrganizationStateStore(databasePath);
  const coordinator = new LocalOrganizationCoordinator({
    state,
    authorityClient: descriptorClient(authority),
    installationSigner: signer,
    maximumActiveLeaseTtlMs: MAX_TTL_MS,
    clock: { now: () => NOW },
  });
  await coordinator.enroll(enrollmentInput(authority));
  state.close();
  return { authority, databasePath, signer };
}

function authorizationInput() {
  return {
    approval_id: 'f'.repeat(64),
    action: 'approve' as const,
    adapter_identity: {
      kind: 'approval-surface' as const,
      adapter_id: 'slack-reactions',
      instance_id: 'primary',
      version: '1.0.0',
    },
    provider_identity: {
      provider: 'slack' as const,
      team_id: 'T123TEAM',
      enterprise_id: null,
      bot_user_id: 'U123BOT',
      bot_id: 'B123BOT',
      app_id: 'A123APP',
    },
    actor: {
      provider: 'slack' as const,
      team_id: 'T123TEAM',
      user_id: 'U123ZHEN',
    },
    channel_id: 'C123CHANNEL',
    message_ts: '1753822800.000001',
    reaction_name: 'white_check_mark',
  };
}

describe('organization approval action authorizer', () => {
  it('signs the exact Slack action and returns only its correlated live decision', async () => {
    const { authority, databasePath, signer } = await enrolledFixture();

    let observed: OrganizationPermissionCheckRequestV1 | undefined;
    const cancellation = new AbortController();
    const client = descriptorClient(authority, {
      checkPermission: async (request, signal) => {
        expect(signal).toBe(cancellation.signal);
        observed = request;
        return allowedPermissionDecision(request);
      },
    });
    const authorizer = new OrganizationApprovalActionAuthorizer({
      openState: () => new SqliteOrganizationStateStore(databasePath),
      authorityClient: client,
      installationSigner: signer,
      now: () => NOW,
      nextRequestId: () =>
        'pcr_00000000-0000-4000-8000-000000000001',
    });
    const authorization = await authorizer.authorize(
      authorizationInput(),
      cancellation.signal,
    );
    expect(authorization).toEqual({
      allowed: true,
      reason: 'active membership and direct grant',
      evidence: {
        schema_version: 1,
        kind: 'echo-organization-authorization-evidence',
        authority_id: ORGANIZATION_IDS.authority,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        request_id: 'pcr_00000000-0000-4000-8000-000000000001',
        approval_id: 'f'.repeat(64),
        request_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        provider_event_sha256: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/,
        ),
        allowed: true,
        reason_code: 'active_membership_and_direct_grant',
        principal_id: ORGANIZATION_IDS.principal,
        membership_id: ORGANIZATION_IDS.membership,
        adapter_binding_id: fixtureId('bnd', 1),
        permission_grant_id: fixtureId('pgr', 1),
        evaluated_at: NOW,
      },
    });
    expect(observed).toMatchObject({
      request_id: 'pcr_00000000-0000-4000-8000-000000000001',
      enrollment_id: ORGANIZATION_IDS.enrollment,
      installation_id: ORGANIZATION_IDS.installation,
      provider_tenant_id: 'T123TEAM',
      provider_enterprise_id: null,
      provider_connection_subject_id: 'U123BOT',
      provider_connection_bot_id: 'B123BOT',
      provider_connection_app_id: 'A123APP',
      provider_subject_id: 'U123ZHEN',
      adapter_id: 'slack-reactions',
      adapter_instance_id: 'primary',
      action: 'approve',
      approval_id: 'f'.repeat(64),
      channel_id: 'C123CHANNEL',
      message_ts: '1753822800.000001',
      reaction_name: 'white_check_mark',
    });
    expect(observed).not.toHaveProperty('processing_key');
    expect(observed?.provider_event_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(signer.signCalls).toBeGreaterThan(1);
  });

  it.each([
    ['principal_id', fixtureId('prn', 2)],
    ['membership_id', fixtureId('mem', 2)],
  ] as const)(
    'fails closed when an allow decision attributes another %s',
    async (field, foreignId) => {
      const { authority, databasePath, signer } = await enrolledFixture();
      const client = descriptorClient(authority, {
        checkPermission: async (request) => ({
          ...allowedPermissionDecision(request),
          [field]: foreignId,
        }),
      });
      const authorizer = new OrganizationApprovalActionAuthorizer({
        openState: () => new SqliteOrganizationStateStore(databasePath),
        authorityClient: client,
        installationSigner: signer,
        now: () => NOW,
      });

      await expect(
        authorizer.authorize(authorizationInput()),
      ).rejects.toThrow(
        'organization permission decision belongs to another enrolled member',
      );
    },
  );
});
