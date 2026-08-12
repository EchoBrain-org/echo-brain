import type {
  OrganizationMemberReadablePermissionCheckDecisionV3,
  OrganizationMemberReadablePermissionCheckRequestV3,
  OrganizationPermissionCheckRequestV1,
  OrganizationReviewerPermissionCheckDecisionV2,
  OrganizationReviewerPermissionCheckRequestV2,
} from '@echo-brain/organization-api';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrganizationApprovalActionAuthorizer } from '../../src/product/organization/approval-action-authorizer.js';
import { validateReviewerAuthorizationEvidence } from '../../src/product/approval/reviewer-authorization-evidence.js';
import { validateOrganizationMemberAuthorizationEvidence } from '../../src/product/approval/organization-member-authorization-evidence.js';
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

const reviewerDraftSha256 = `sha256:${'d'.repeat(64)}` as const;
const reviewerPresentationSha256 = `sha256:${'e'.repeat(64)}` as const;
const memberPolicyContractSha256 = organizationMemberReadablePolicyContractSha256();
const memberDraftSha256 = `sha256:${'d'.repeat(64)}` as const;
const memberPresentationSha256 = `sha256:${'e'.repeat(64)}` as const;

function reviewerAuthorizationInput() {
  const input = authorizationInput();
  return {
    approval_id: input.approval_id,
    adapter_identity: input.adapter_identity,
    provider_identity: input.provider_identity,
    actor: input.actor,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    approve_reaction: input.reaction_name,
    reject_reaction: 'x',
    reviewer_release_draft_sha256: reviewerDraftSha256,
    approval_presentation_sha256: reviewerPresentationSha256,
  };
}

function allowedReviewerDecision(
  request: OrganizationReviewerPermissionCheckRequestV2,
): OrganizationReviewerPermissionCheckDecisionV2 {
  return {
    schema_version: 2,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: canonicalSha256(request),
    provider_event_sha256: request.provider_event_sha256,
    allowed: true,
    reason_code: 'active_reviewer_restricted_notice_v1',
    principal_id: ORGANIZATION_IDS.principal,
    membership_id: ORGANIZATION_IDS.membership,
    adapter_binding_id: fixtureId('bnd', 1),
    permission_grant_id: fixtureId('pgr', 1),
    evaluated_at: NOW,
    authorization_audit_event_id: fixtureId('aud', 1),
    authorization_audit_entry_sha256: `sha256:${'a'.repeat(64)}`,
    reviewer_release_draft_sha256: request.reviewer_release_draft_sha256,
    approval_presentation_sha256: request.approval_presentation_sha256,
    semantic_intent_sha256: `sha256:${'b'.repeat(64)}`,
    message_presentation_sha256: `sha256:${'c'.repeat(64)}`,
  };
}

function organizationMemberAuthorizationInput() {
  const input = authorizationInput();
  return {
    approval_id: input.approval_id,
    adapter_identity: input.adapter_identity,
    provider_identity: input.provider_identity,
    actor: input.actor,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    approve_reaction: input.reaction_name,
    reject_reaction: 'x',
    policy_id: 'organization-member-readable-v1' as const,
    policy_contract_sha256: memberPolicyContractSha256,
    release_draft_sha256: memberDraftSha256,
    approval_presentation_sha256: memberPresentationSha256,
  };
}

function allowedOrganizationMemberDecision(
  request: OrganizationMemberReadablePermissionCheckRequestV3,
): OrganizationMemberReadablePermissionCheckDecisionV3 {
  return {
    schema_version: 3,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: canonicalSha256(request),
    provider_event_sha256: request.provider_event_sha256,
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    policy_id: request.policy_id,
    policy_contract_sha256: request.policy_contract_sha256,
    principal_id: ORGANIZATION_IDS.principal,
    membership_id: ORGANIZATION_IDS.membership,
    adapter_binding_id: fixtureId('bnd', 1),
    permission_grant_id: fixtureId('pgr', 1),
    evaluated_at: NOW,
    authorization_audit_event_id: fixtureId('aud', 1),
    authorization_audit_entry_sha256: `sha256:${'a'.repeat(64)}`,
    release_draft_sha256: request.release_draft_sha256,
    approval_presentation_sha256: request.approval_presentation_sha256,
    semantic_intent_sha256: `sha256:${'b'.repeat(64)}`,
    message_presentation_sha256: `sha256:${'c'.repeat(64)}`,
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
        // Carried on the evidence so a later consumer can match an act to its
        // authorization without re-deriving the signed request bytes.
        action: 'approve',
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

  it('signs the closed reviewer request and returns a locally revalidated complete proof', async () => {
    const { authority, databasePath, signer } = await enrolledFixture();
    let observed: OrganizationReviewerPermissionCheckRequestV2 | undefined;
    const client = descriptorClient(authority, {
      checkReviewerPermission: async (request) => {
        observed = request;
        return allowedReviewerDecision(request);
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

    const result = await authorizer.authorizeReviewerApproval(
      reviewerAuthorizationInput(),
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('reviewer allow was expected');
    expect(validateReviewerAuthorizationEvidence(result.evidence)).toEqual(
      result.evidence,
    );
    expect(observed).toMatchObject({
      schema_version: 2,
      approval_id: 'f'.repeat(64),
      action: 'approve',
      reaction_name: 'white_check_mark',
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      reviewer_release_draft_sha256: reviewerDraftSha256,
      approval_presentation_sha256: reviewerPresentationSha256,
    });
  });

  it.each([
    [
      'request digest',
      (decision: OrganizationReviewerPermissionCheckDecisionV2) => ({
        ...decision,
        request_sha256: `sha256:${'f'.repeat(64)}` as const,
      }),
      /does not match the signed request/u,
    ],
    [
      'reviewer actor',
      (decision: OrganizationReviewerPermissionCheckDecisionV2) => ({
        ...decision,
        principal_id: fixtureId('prn', 2),
      }),
      /belongs to another enrolled member/u,
    ],
    [
      'frozen presentation',
      (decision: OrganizationReviewerPermissionCheckDecisionV2) => ({
        ...decision,
        approval_presentation_sha256: `sha256:${'f'.repeat(64)}` as const,
      }),
      /does not quote the frozen presentation/u,
    ],
    [
      'complete proof',
      (decision: OrganizationReviewerPermissionCheckDecisionV2) => ({
        ...decision,
        authorization_audit_event_id: null,
      }),
      /authorization_audit_event_id must be a canonical aud identifier/u,
    ],
  ])('refuses a reviewer allow with mismatched %s', async (_label, mutate, message) => {
    const { authority, databasePath, signer } = await enrolledFixture();
    const client = descriptorClient(authority, {
      checkReviewerPermission: async (request) =>
        mutate(allowedReviewerDecision(request)),
    });
    const authorizer = new OrganizationApprovalActionAuthorizer({
      openState: () => new SqliteOrganizationStateStore(databasePath),
      authorityClient: client,
      installationSigner: signer,
      now: () => NOW,
    });
    await expect(
      authorizer.authorizeReviewerApproval(reviewerAuthorizationInput()),
    ).rejects.toThrow(message);
  });

  it('signs the closed organization-member request and returns schema-v3 evidence', async () => {
    const { authority, databasePath, signer } = await enrolledFixture();
    let observed: OrganizationMemberReadablePermissionCheckRequestV3 | undefined;
    const client = descriptorClient(authority, {
      checkOrganizationMemberPermission: async (request) => {
        observed = request;
        return allowedOrganizationMemberDecision(request);
      },
    });
    const authorizer = new OrganizationApprovalActionAuthorizer({
      openState: () => new SqliteOrganizationStateStore(databasePath),
      authorityClient: client,
      installationSigner: signer,
      now: () => NOW,
      nextRequestId: () => 'pcr_00000000-0000-4000-8000-000000000001',
    });

    const result = await authorizer.authorizeOrganizationMemberApproval(
      organizationMemberAuthorizationInput(),
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('organization-member allow was expected');
    expect(validateOrganizationMemberAuthorizationEvidence(result.evidence)).toEqual(
      result.evidence,
    );
    expect(observed).toMatchObject({
      schema_version: 3,
      approval_id: 'f'.repeat(64),
      action: 'approve',
      reaction_name: 'white_check_mark',
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      policy_id: 'organization-member-readable-v1',
      policy_contract_sha256: memberPolicyContractSha256,
      release_draft_sha256: memberDraftSha256,
      approval_presentation_sha256: memberPresentationSha256,
    });
  });

  it.each([
    [
      'request digest',
      (decision: OrganizationMemberReadablePermissionCheckDecisionV3) => ({
        ...decision,
        request_sha256: `sha256:${'f'.repeat(64)}` as const,
      }),
      /does not match the signed request/u,
    ],
    [
      'policy contract',
      (decision: OrganizationMemberReadablePermissionCheckDecisionV3) => ({
        ...decision,
        policy_contract_sha256: `sha256:${'f'.repeat(64)}` as const,
      }),
      /does not quote the frozen presentation contract/u,
    ],
    [
      'frozen presentation',
      (decision: OrganizationMemberReadablePermissionCheckDecisionV3) => ({
        ...decision,
        approval_presentation_sha256: `sha256:${'f'.repeat(64)}` as const,
      }),
      /does not quote the frozen presentation contract/u,
    ],
    [
      'complete proof',
      (decision: OrganizationMemberReadablePermissionCheckDecisionV3) => ({
        ...decision,
        authorization_audit_event_id: null,
      }),
      /organization-member allow decision has no complete proof/u,
    ],
  ])('refuses an organization-member allow with mismatched %s', async (_label, mutate, message) => {
    const { authority, databasePath, signer } = await enrolledFixture();
    const client = descriptorClient(authority, {
      checkOrganizationMemberPermission: async (request) =>
        mutate(allowedOrganizationMemberDecision(request)),
    });
    const authorizer = new OrganizationApprovalActionAuthorizer({
      openState: () => new SqliteOrganizationStateStore(databasePath),
      authorityClient: client,
      installationSigner: signer,
      now: () => NOW,
    });
    await expect(
      authorizer.authorizeOrganizationMemberApproval(
        organizationMemberAuthorizationInput(),
      ),
    ).rejects.toThrow(message);
  });
});
