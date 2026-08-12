import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  verifyOrganizationReviewerRecentDecisionsRequest,
  type OrganizationReviewerRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';
import { RESTRICTED_REVIEWER_POLICY_ID } from '@echo-brain/organization-protocol';
import { OrganizationReviewerRecentDecisionsReader } from '../../src/product/organization/reviewer-recent-decisions-reader.js';
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

const REQUEST_ID = 'rrd_00000000-0000-4000-8000-000000000001';
const response: OrganizationReviewerRecentDecisionsResponseV1 = {
  schema_version: 1,
  policy_id: RESTRICTED_REVIEWER_POLICY_ID,
  witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  items: [
    {
      kind: 'decision',
      text: 'Approve the reviewer-only release.',
    },
  ],
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

describe('organization reviewer recent decisions reader', () => {
  it('signs the exact enrolled-installation request and retains no response state', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const signingKey = protocolInstallationKey(signer);
    let calls = 0;
    const reader = new OrganizationReviewerRecentDecisionsReader({
      state,
      authorityClient: descriptorClient(authority, {
        readReviewerRecentDecisions: async (request) => {
          calls += 1;
          expect(
            verifyOrganizationReviewerRecentDecisionsRequest(
              request,
              signingKey,
            ),
          ).toEqual(request);
          expect(request).toMatchObject({
            request_id: REQUEST_ID,
            authority_id: ORGANIZATION_IDS.authority,
            organization_id: ORGANIZATION_IDS.organization,
            enrollment_id: ORGANIZATION_IDS.enrollment,
            installation_id: ORGANIZATION_IDS.installation,
            http_method: 'POST',
            http_path: '/v1/reviewer-recent-decisions',
            requested_at: NOW,
          });
          expect(request).not.toHaveProperty('limit');
          expect(request).not.toHaveProperty('cursor');
          return response;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
      nextRequestId: () => REQUEST_ID,
    });

    await expect(reader.read()).resolves.toEqual(response);
    await expect(reader.read()).resolves.toEqual(response);
    expect(calls).toBe(2);
    expect(state.readEnrollment()).not.toHaveProperty('reviewer_response');
  });

  it('refuses incomplete enrollment before signing or sending', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const inactiveState = {
      readEnrollment: () => ({
        ...state.readEnrollment(),
        accepted_access_sequence: 0,
      }),
    } as unknown as OrganizationStateStore;
    let sent = false;
    const reader = new OrganizationReviewerRecentDecisionsReader({
      state: inactiveState,
      authorityClient: descriptorClient(authority, {
        readReviewerRecentDecisions: async () => {
          sent = true;
          return response;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
    });
    const signingCallsBefore = signer.signCalls;

    await expect(reader.read()).rejects.toThrow(
      'enrollment is unavailable for reviewer recent decisions',
    );
    expect(signer.signCalls).toBe(signingCallsBefore);
    expect(sent).toBe(false);
  });

  it('refuses a signer that no longer matches the enrolled key', async () => {
    const { authority, state } = await enrolledFixture();
    const replacementSigner = new TestInstallationSigner();
    const reader = new OrganizationReviewerRecentDecisionsReader({
      state,
      authorityClient: descriptorClient(authority),
      installationSigner: replacementSigner,
      now: () => NOW,
    });

    await expect(reader.read()).rejects.toThrow(
      'signer no longer matches the enrollment',
    );
    expect(replacementSigner.signCalls).toBe(0);
  });
});
