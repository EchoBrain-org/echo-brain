import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
  canonicalOrganizationPersonMeetingIngestionExclusionChangeRequestBytes,
  validateOrganizationPersonMeetingIngestionExclusionChangeRequest,
} from '../src/index.js';

const BASE_REQUEST = {
  schema_version: 2,
  kind: 'echo-organization-person-member-exclusion-change-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000001',
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  subject_principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
  excluded: true,
} as const;

const SOURCE_REQUEST = {
  ...BASE_REQUEST,
  selector: {
    scope: 'source',
    source_adapter_id: 'granola',
    source_instance_id: 'primary',
  },
} as const;

const MEETING_REQUEST = {
  ...BASE_REQUEST,
  excluded: false,
  selector: {
    scope: 'meeting',
    source_adapter_id: 'granola',
    source_instance_id: 'primary',
    external_id: 'meeting/provider-owned-id',
  },
} as const;

describe('organization Person meeting-ingestion exclusion change request', () => {
  it('validates the exact source and meeting desired-state shapes', () => {
    expect(
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest(SOURCE_REQUEST),
    ).toEqual(SOURCE_REQUEST);
    expect(
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest(MEETING_REQUEST),
    ).toEqual(MEETING_REQUEST);
  });

  it('emits canonical bytes only after validation', () => {
    expect(
      Buffer.from(
        canonicalOrganizationPersonMeetingIngestionExclusionChangeRequestBytes(
          MEETING_REQUEST,
        ),
      ).toString('utf8'),
    ).toBe(canonicalJson(MEETING_REQUEST));
    expect(() =>
      canonicalOrganizationPersonMeetingIngestionExclusionChangeRequestBytes({
        ...SOURCE_REQUEST,
        excluded: 'true',
      }),
    ).toThrow('excluded must be a boolean');
  });

  it.each([
    ['membership_id', 'mem_00000000-0000-4000-8000-000000000001'],
    ['access_token', 'secret'],
    ['reason', 'private meeting'],
    ['requested_at', '2026-08-18T12:00:00.000Z'],
  ])('rejects unexpected top-level field %s', (field, value) => {
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...SOURCE_REQUEST,
        [field]: value,
      }),
    ).toThrow('unexpected shape');
  });

  it('keeps the two selector variants closed', () => {
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...SOURCE_REQUEST,
        selector: {
          ...SOURCE_REQUEST.selector,
          external_id: 'not-valid-on-a-source-selector',
        },
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...MEETING_REQUEST,
        selector: {
          scope: 'meeting',
          source_adapter_id: 'granola',
          source_instance_id: 'primary',
        },
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...SOURCE_REQUEST,
        selector: { ...SOURCE_REQUEST.selector, scope: 'all' },
      }),
    ).toThrow('scope is unsupported');
  });

  it('binds the canonical V2 identity and HTTP operation', () => {
    for (const change of [
      { schema_version: 1 },
      { kind: 'echo-organization-person-member-exclusion-request' },
      { request_id: 'mem_00000000-0000-4000-8000-000000000001' },
      { subject_principal_id: 'mem_00000000-0000-4000-8000-000000000001' },
      { http_method: 'PUT' },
      { http_path: '/v2/member-exclusion' },
    ]) {
      expect(() =>
        validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
          ...SOURCE_REQUEST,
          ...change,
        }),
      ).toThrow();
    }
  });

  it('matches the durable identifier bounds', () => {
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...SOURCE_REQUEST,
        selector: {
          ...SOURCE_REQUEST.selector,
          source_adapter_id: 'a'.repeat(128),
          source_instance_id: 'i'.repeat(128),
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...SOURCE_REQUEST,
        selector: {
          ...SOURCE_REQUEST.selector,
          source_adapter_id: 'a'.repeat(129),
        },
      }),
    ).toThrow('source_adapter_id is invalid');
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...MEETING_REQUEST,
        selector: {
          ...MEETING_REQUEST.selector,
          external_id: 'x'.repeat(4096),
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...MEETING_REQUEST,
        selector: {
          ...MEETING_REQUEST.selector,
          external_id: 'x'.repeat(4097),
        },
      }),
    ).toThrow('external_id is invalid');
  });

  it('preserves an opaque external ID byte-for-byte while rejecting NUL', () => {
    const externalId = '  Mixed/e\u0301\nwith trailing space  ';
    const request = {
      ...MEETING_REQUEST,
      selector: { ...MEETING_REQUEST.selector, external_id: externalId },
    };
    const validated = validateOrganizationPersonMeetingIngestionExclusionChangeRequest(
      request,
    );
    expect(validated.selector).toMatchObject({ external_id: externalId });
    expect(
      Buffer.from(
        canonicalOrganizationPersonMeetingIngestionExclusionChangeRequestBytes(request),
      ).toString('utf8'),
    ).toBe(canonicalJson(request));
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...MEETING_REQUEST,
        selector: {
          ...MEETING_REQUEST.selector,
          external_id: 'before\0after',
        },
      }),
    ).toThrow('external_id is invalid');
  });

  it('rejects hidden properties recursively before canonicalization can omit them', () => {
    const selector = { ...MEETING_REQUEST.selector } as Record<string, unknown>;
    Object.defineProperty(selector, 'hidden_meeting_title', {
      value: 'private',
      enumerable: false,
    });
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionChangeRequest({
        ...MEETING_REQUEST,
        selector,
      }),
    ).toThrow('must contain only enumerable data properties');
  });
});
