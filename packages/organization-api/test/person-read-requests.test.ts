import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
  ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
  canonicalOrganizationPersonReadableSearchRequestBytes,
  canonicalOrganizationPersonRecentDecisionsRequestBytes,
  canonicalOrganizationPersonReviewerRecentDecisionsRequestBytes,
  validateOrganizationPersonReadableSearchRequest,
  validateOrganizationPersonRecentDecisionsRequest,
  validateOrganizationPersonReviewerRecentDecisionsRequest,
} from '../src/index.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
} as const;

const recentRequest = {
  schema_version: 2,
  kind: 'echo-organization-person-recent-decisions-request',
  request_id: 'rdr_00000000-0000-4000-8000-000000000001',
  authority_id: IDS.authority,
  organization_id: IDS.organization,
  subject_principal_id: IDS.principal,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
} as const;

const reviewerRecentRequest = {
  subject_principal_id: IDS.principal,
} as const;

const searchRequest = {
  subject_principal_id: IDS.principal,
  query: 'Launch pricing',
} as const;

describe('organization Person read requests', () => {
  it('keeps pilot recent intact and validates semantic-only reviewer and search bodies', () => {
    expect(
      validateOrganizationPersonRecentDecisionsRequest(recentRequest),
    ).toEqual(recentRequest);
    expect(
      validateOrganizationPersonReviewerRecentDecisionsRequest(
        reviewerRecentRequest,
      ),
    ).toEqual(reviewerRecentRequest);
    expect(
      validateOrganizationPersonReadableSearchRequest(searchRequest),
    ).toEqual(searchRequest);
  });

  it('emits the exact canonical bytes for each validated body', () => {
    expect(
      Buffer.from(
        canonicalOrganizationPersonRecentDecisionsRequestBytes(recentRequest),
      ).toString('utf8'),
    ).toBe(canonicalJson(recentRequest));
    expect(
      Buffer.from(
        canonicalOrganizationPersonReviewerRecentDecisionsRequestBytes(
          reviewerRecentRequest,
        ),
      ).toString('utf8'),
    ).toBe(canonicalJson(reviewerRecentRequest));
    expect(
      Buffer.from(
        canonicalOrganizationPersonReadableSearchRequestBytes(searchRequest),
      ).toString('utf8'),
    ).toBe(canonicalJson(searchRequest));
  });

  it.each([
    ['enrollment_id', 'enr_00000000-0000-4000-8000-000000000001'],
    ['installation_id', 'ins_00000000-0000-4000-8000-000000000001'],
    ['membership_id', 'mem_00000000-0000-4000-8000-000000000001'],
    ['membership_type', 'employee'],
    ['session_id', 'ses_00000000-0000-4000-8000-000000000001'],
    ['session_credential', 'secret'],
    ['integrity', { algorithm: 'none' }],
    ['signature', 'unsigned'],
    ['caller_policy', 'all'],
    ['limit', 10],
    ['cursor', 'next'],
    ['sort', 'newest'],
    ['requested_at', '2026-08-18T12:00:00.000Z'],
  ])('rejects forbidden or caller-controlled field %s', (field, value) => {
    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest({
        ...recentRequest,
        [field]: value,
      }),
    ).toThrow('unexpected shape');
  });

  it('rejects cross-route, cross-kind, and cross-version bodies', () => {
    expect(() =>
      validateOrganizationPersonReviewerRecentDecisionsRequest(recentRequest),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest({
        ...recentRequest,
        http_path: ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
      }),
    ).toThrow('HTTP operation is unsupported');
    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest({
        ...recentRequest,
        schema_version: 1,
        kind: 'echo-organization-recent-decisions-request',
      }),
    ).toThrow('version or kind is unsupported');

  });

  it('rejects the retired reviewer and search transport envelopes', () => {
    expect(() =>
      validateOrganizationPersonReviewerRecentDecisionsRequest({
        schema_version: 2,
        kind: 'echo-organization-person-reviewer-recent-decisions-request',
        request_id: 'rrd_00000000-0000-4000-8000-000000000001',
        authority_id: IDS.authority,
        organization_id: IDS.organization,
        subject_principal_id: IDS.principal,
        http_method: 'POST',
        http_path: ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationPersonReadableSearchRequest({
        schema_version: 2,
        kind: 'echo-organization-person-readable-search-request',
        request_id: 'osq_00000000-0000-4000-8000-000000000001',
        authority_id: IDS.authority,
        organization_id: IDS.organization,
        subject_principal_id: IDS.principal,
        http_method: 'POST',
        http_path: ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
        query: 'Launch pricing',
      }),
    ).toThrow('unexpected shape');
  });

  it('rejects a caller/subject naming mismatch and a non-POST method', () => {
    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest({
        ...recentRequest,
        subject_principal_id:
          'mem_00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('canonical prn identifier');
    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest({
        ...recentRequest,
        http_method: 'GET',
      }),
    ).toThrow('HTTP operation is unsupported');
  });

  it.each([
    '',
    ' leading',
    'trailing ',
    'line\nbreak',
    'e\u0301',
    'x'.repeat(241),
    '---',
    Array.from({ length: 17 }, (_value, index) => `term${index}`).join(' '),
    `a${'界'.repeat(22)}`,
  ])('applies the existing bounded readable-search query contract to %j', (query) => {
    expect(() =>
      validateOrganizationPersonReadableSearchRequest({
        ...searchRequest,
        query,
      }),
    ).toThrow('query');
  });

  it('rejects non-enumerable properties before canonicalization can omit them', () => {
    const withHiddenCredential = { ...recentRequest } as Record<
      string,
      unknown
    >;
    Object.defineProperty(withHiddenCredential, 'session_credential', {
      value: 'secret',
      enumerable: false,
    });

    expect(() =>
      validateOrganizationPersonRecentDecisionsRequest(withHiddenCredential),
    ).toThrow('must contain only enumerable data properties');
  });
});
