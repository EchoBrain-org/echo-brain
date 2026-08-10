import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  verifyOrganizationRecentDecisionsRequest,
  type OrganizationRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';
import { OrganizationRecentDecisionsReader } from '../../src/product/organization/recent-decisions-reader.js';
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

const REQUEST_ID = 'rdr_00000000-0000-4000-8000-000000000001';
const recentDecisions: OrganizationRecentDecisionsResponseV1 = {
  schema_version: 1,
  policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
  items: [
    {
      atom_id: `sha256:${'a'.repeat(64)}`,
      kind: 'decision',
      text: 'Adopt the two-member permission pilot.',
      record_hash: `sha256:${'b'.repeat(64)}`,
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

describe('organization recent decisions reader', () => {
  it('signs the exact enrolled-installation read and returns only the closed DTO', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const signingKey = protocolInstallationKey(signer);
    const cancellation = new AbortController();
    let calls = 0;
    const reader = new OrganizationRecentDecisionsReader({
      state,
      authorityClient: descriptorClient(authority, {
        readRecentDecisions: async (request, signal) => {
          calls += 1;
          expect(signal).toBe(cancellation.signal);
          expect(
            verifyOrganizationRecentDecisionsRequest(request, signingKey),
          ).toEqual(request);
          expect(request).toMatchObject({
            request_id: REQUEST_ID,
            authority_id: ORGANIZATION_IDS.authority,
            organization_id: ORGANIZATION_IDS.organization,
            enrollment_id: ORGANIZATION_IDS.enrollment,
            installation_id: ORGANIZATION_IDS.installation,
            http_method: 'POST',
            http_path: '/v1/recent-decisions',
            requested_at: NOW,
          });
          expect(request).not.toHaveProperty('limit');
          expect(request).not.toHaveProperty('cursor');
          return recentDecisions;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
      nextRequestId: () => REQUEST_ID,
    });

    await expect(reader.read(cancellation.signal)).resolves.toEqual(
      recentDecisions,
    );
    expect(calls).toBe(1);
  });

  it('refuses an incomplete enrollment before signing or sending', async () => {
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
    const reader = new OrganizationRecentDecisionsReader({
      state: inactiveState,
      authorityClient: descriptorClient(authority, {
        readRecentDecisions: async () => {
          sent = true;
          return recentDecisions;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
    });
    const signingCallsBefore = signer.signCalls;

    await expect(reader.read()).rejects.toThrow(
      'organization enrollment is unavailable for recent decisions',
    );
    expect(signer.signCalls).toBe(signingCallsBefore);
    expect(sent).toBe(false);
  });

  it('refuses a signer that no longer matches the enrolled key', async () => {
    const { authority, state } = await enrolledFixture();
    const replacementSigner = new TestInstallationSigner();
    let sent = false;
    const reader = new OrganizationRecentDecisionsReader({
      state,
      authorityClient: descriptorClient(authority, {
        readRecentDecisions: async () => {
          sent = true;
          return recentDecisions;
        },
      }),
      installationSigner: replacementSigner,
      now: () => NOW,
    });

    await expect(reader.read()).rejects.toThrow(
      'signer no longer matches the enrollment',
    );
    expect(replacementSigner.signCalls).toBe(0);
    expect(sent).toBe(false);
  });
});
