import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  verifyOrganizationSlackLinkBeginRequest,
  verifyOrganizationSlackLinkCompleteRequest,
  type OrganizationSlackLinkBeginResponseV1,
  type OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import type { OrganizationAuthorityClient } from '../../src/product/organization/client/authority-client.js';
import { OrganizationSlackIdentityLinkCoordinator } from '../../src/product/organization/slack-identity-link-coordinator.js';
import type { OrganizationStateStore } from '../../src/product/organization/state/organization-state-store.js';
import {
  NOW,
  ORGANIZATION_IDS,
  TestAuthority,
  TestInstallationSigner,
  descriptorClient,
  protocolInstallationKey,
  signedEnrollmentRequest,
} from '../support/local-organization-fixtures.js';

const CHALLENGE_CODE = Buffer.alloc(32, 0xa5).toString('base64url');
const BEGIN_REQUEST_ID = 'slb_00000000-0000-4000-8000-000000000001';
const COMPLETE_REQUEST_ID = 'slc_00000000-0000-4000-8000-000000000001';
const CHALLENGE_ATTEMPT_ID =
  'cat_00000000-0000-4000-8000-000000000001';
const CHALLENGE_MESSAGE_TS = '1753891200.123456';

const beginResponse: OrganizationSlackLinkBeginResponseV1 = {
  schema_version: 1,
  kind: 'echo-organization-slack-link-begin-response',
  challenge_attempt_id: CHALLENGE_ATTEMPT_ID,
  provider: 'slack',
  provider_tenant_id: 'T123TEAM',
  channel_id: 'C123CHANNEL',
  challenge_message_ts: CHALLENGE_MESSAGE_TS,
  expires_at: '2026-07-22T00:07:00.000Z',
};

const linkResult: OrganizationSlackLinkResultV1 = {
  schema_version: 1,
  kind: 'echo-organization-slack-link-result',
  identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
  connection_id: 'con_00000000-0000-4000-8000-000000000001',
  adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
  organization_id: ORGANIZATION_IDS.organization,
  principal_id: ORGANIZATION_IDS.principal,
  membership_id: ORGANIZATION_IDS.membership,
  installation_id: ORGANIZATION_IDS.installation,
  provider: 'slack',
  provider_tenant_id: 'T123TEAM',
  provider_subject_id: 'U123ZHEN',
  channel_id: 'C123CHANNEL',
  linked_at: '2026-07-22T00:03:00.000Z',
  identity_link_created: true,
  adapter_binding_created: true,
  permission_grants_created: 0,
};

async function enrolledFixture() {
  const authority = new TestAuthority();
  const signer = new TestInstallationSigner();
  const request = await signedEnrollmentRequest(authority, signer);
  const completion = await authority.complete(request);
  const state = {
    readEnrollment: () => ({
      request,
      receipt: completion.enrollment_receipt,
      accepted_access_sequence: 1,
      accepted_access_sha256: null,
      trusted_time_high_watermark: NOW,
    }),
  } as unknown as OrganizationStateStore;
  return { authority, signer, state };
}

describe('organization Slack identity-link coordinator', () => {
  it('signs begin and complete with the enrolled installation and sends no org credential', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const signingKey = protocolInstallationKey(signer);
    const observed: string[] = [];
    const authorityClient: OrganizationAuthorityClient = descriptorClient(
      authority,
      {
        beginSlackLink: async (request) => {
          observed.push('begin');
          expect(
            verifyOrganizationSlackLinkBeginRequest(request, signingKey),
          ).toEqual(request);
          expect(request).toMatchObject({
            request_id: BEGIN_REQUEST_ID,
            authority_id: ORGANIZATION_IDS.authority,
            organization_id: ORGANIZATION_IDS.organization,
            enrollment_id: ORGANIZATION_IDS.enrollment,
            installation_id: ORGANIZATION_IDS.installation,
          });
          expect(request).not.toHaveProperty('challenge_code');
          expect(request).not.toHaveProperty('token');
          expect(request).not.toHaveProperty('admin_token');
          expect(request).not.toHaveProperty('bot_token');
          expect(JSON.stringify(request)).not.toContain(CHALLENGE_CODE);
          return beginResponse;
        },
        completeSlackLink: async (request) => {
          observed.push('complete');
          expect(
            verifyOrganizationSlackLinkCompleteRequest(request, signingKey),
          ).toEqual(request);
          expect(request).toMatchObject({
            request_id: COMPLETE_REQUEST_ID,
            enrollment_id: ORGANIZATION_IDS.enrollment,
            installation_id: ORGANIZATION_IDS.installation,
            challenge_attempt_id: CHALLENGE_ATTEMPT_ID,
            challenge_message_ts: CHALLENGE_MESSAGE_TS,
            challenge_code: CHALLENGE_CODE,
            expected_provider_subject_id: 'U123ZHEN',
            adapter_id: 'slack-reactions',
            adapter_instance_id: 'founder-approvals',
            adapter_version: '1.0.0',
          });
          expect(request).not.toHaveProperty('provider_subject_id');
          expect(request).not.toHaveProperty('token');
          expect(request).not.toHaveProperty('admin_token');
          expect(request).not.toHaveProperty('bot_token');
          return linkResult;
        },
      },
    );
    const coordinator = new OrganizationSlackIdentityLinkCoordinator({
      state,
      authorityClient,
      installationSigner: signer,
      now: () => NOW,
      nextBeginRequestId: () => BEGIN_REQUEST_ID,
      nextCompleteRequestId: () => COMPLETE_REQUEST_ID,
    });

    await expect(coordinator.begin(CHALLENGE_CODE)).resolves.toEqual(
      beginResponse,
    );
    await expect(
      coordinator.complete({
        challenge_attempt_id: CHALLENGE_ATTEMPT_ID,
        challenge_message_ts: CHALLENGE_MESSAGE_TS,
        challenge_code: CHALLENGE_CODE,
        expected_provider_subject_id: 'U123ZHEN',
        adapter_instance_id: 'founder-approvals',
        adapter_version: '1.0.0',
      }),
    ).resolves.toEqual(linkResult);

    expect(observed).toEqual(['begin', 'complete']);
    expect(signer.signCalls).toBe(3);
  });

  it('rejects a link result for a different configured Slack reviewer', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const coordinator = new OrganizationSlackIdentityLinkCoordinator({
      state,
      authorityClient: descriptorClient(authority, {
        completeSlackLink: async () => ({
          ...linkResult,
          provider_subject_id: 'U999OTHER',
        }),
      }),
      installationSigner: signer,
      now: () => NOW,
    });

    await expect(
      coordinator.complete({
        challenge_attempt_id: CHALLENGE_ATTEMPT_ID,
        challenge_message_ts: CHALLENGE_MESSAGE_TS,
        challenge_code: CHALLENGE_CODE,
        expected_provider_subject_id: 'U123ZHEN',
        adapter_instance_id: 'founder-approvals',
        adapter_version: '1.0.0',
      }),
    ).rejects.toThrow('different Slack reviewer');
  });

  it('refuses to sign when retained enrollment is not active', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const inactiveState = {
      readEnrollment: () => {
        const enrollment = state.readEnrollment();
        return enrollment === null
          ? null
          : { ...enrollment, accepted_access_sequence: 0 };
      },
    } as unknown as OrganizationStateStore;
    let sent = false;
    const coordinator = new OrganizationSlackIdentityLinkCoordinator({
      state: inactiveState,
      authorityClient: descriptorClient(authority, {
        beginSlackLink: async () => {
          sent = true;
          return beginResponse;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
    });
    const signingCallsBefore = signer.signCalls;

    await expect(coordinator.begin(CHALLENGE_CODE)).rejects.toThrow(
      'organization enrollment is unavailable for Slack linking',
    );
    expect(signer.signCalls).toBe(signingCallsBefore);
    expect(sent).toBe(false);
  });
});
