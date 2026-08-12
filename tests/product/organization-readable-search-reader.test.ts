import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS,
  verifyOrganizationReadableSearchRequest,
  type OrganizationReadableSearchResponseV1,
} from '@echo-brain/organization-api';
import { OrganizationReadableSearchReader } from '../../src/product/organization/readable-search-reader.js';
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

const REQUEST_ID = 'osq_00000000-0000-4000-8000-000000000001';
const QUERY = 'Adopt pilot';
const response: OrganizationReadableSearchResponseV1 = {
  schema_version: 1,
  contract_id: 'permission-aware-readable-search-v1',
  items: [
    {
      kind: 'decision',
      text: 'Adopt the organization pilot.',
      policy_id: 'organization-member-readable-v1',
      witness: ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS,
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

describe('organization readable search reader', () => {
  it('signs the exact query without retaining query or response state', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const signingKey = protocolInstallationKey(signer);
    const cancellation = new AbortController();
    let calls = 0;
    const reader = new OrganizationReadableSearchReader({
      state,
      authorityClient: descriptorClient(authority, {
        readReadableSearch: async (request, signal) => {
          calls += 1;
          expect(signal).toBe(cancellation.signal);
          expect(
            verifyOrganizationReadableSearchRequest(request, signingKey),
          ).toEqual(request);
          expect(request).toMatchObject({
            request_id: REQUEST_ID,
            authority_id: ORGANIZATION_IDS.authority,
            organization_id: ORGANIZATION_IDS.organization,
            enrollment_id: ORGANIZATION_IDS.enrollment,
            installation_id: ORGANIZATION_IDS.installation,
            http_method: 'POST',
            http_path: '/v1/readable-search',
            query: QUERY,
            requested_at: NOW,
          });
          expect(request).not.toHaveProperty('cursor');
          expect(request).not.toHaveProperty('limit');
          return response;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
      nextRequestId: () => REQUEST_ID,
    });

    await expect(reader.read(QUERY, cancellation.signal)).resolves.toEqual(
      response,
    );
    expect(calls).toBe(1);
    expect(state.readEnrollment()).not.toHaveProperty('search_response');
    expect(state.readEnrollment()).not.toHaveProperty('search_query');
  });

  it('refuses incomplete enrollment before signing or sending', async () => {
    const { authority, signer, state } = await enrolledFixture();
    const inactiveState = {
      readEnrollment: () => ({
        ...state.readEnrollment()!,
        accepted_access_sequence: 0,
      }),
    } as unknown as OrganizationStateStore;
    let sent = false;
    const reader = new OrganizationReadableSearchReader({
      state: inactiveState,
      authorityClient: descriptorClient(authority, {
        readReadableSearch: async () => {
          sent = true;
          return response;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
    });
    const signingCallsBefore = signer.signCalls;

    await expect(reader.read(QUERY)).rejects.toThrow(
      'organization enrollment is unavailable for readable search',
    );
    expect(signer.signCalls).toBe(signingCallsBefore);
    expect(sent).toBe(false);
  });

  it('rejects an invalid query before sending it', async () => {
    const { authority, signer, state } = await enrolledFixture();
    let sent = false;
    const reader = new OrganizationReadableSearchReader({
      state,
      authorityClient: descriptorClient(authority, {
        readReadableSearch: async () => {
          sent = true;
          return response;
        },
      }),
      installationSigner: signer,
      now: () => NOW,
    });

    await expect(reader.read('   ')).rejects.toThrow('query is invalid');
    expect(sent).toBe(false);
  });
});
