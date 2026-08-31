import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_ADMIN_MEETING_INGESTION_EXCLUSION_BREAK_GLASS_PATH,
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
  canonicalOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequestBytes,
  canonicalOrganizationMeetingIngestionExclusionListResponseBytes,
  canonicalOrganizationPersonMeetingIngestionExclusionListRequestBytes,
  validateOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequest,
  validateOrganizationMeetingIngestionExclusionListResponse,
  validateOrganizationPersonMeetingIngestionExclusionListRequest,
} from '../src/index.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
} as const;

const personRequest = {
  schema_version: 2,
  kind: 'echo-organization-person-member-exclusion-list-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000001',
  authority_id: IDS.authority,
  organization_id: IDS.organization,
  subject_principal_id: IDS.principal,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
} as const;

const adminRequest = {
  schema_version: 2,
  kind: 'echo-organization-admin-member-exclusion-break-glass-read-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000002',
  authority_id: IDS.authority,
  organization_id: IDS.organization,
  target_principal_id: IDS.principal,
  target_membership_id: IDS.membership,
  http_method: 'POST',
  http_path: ORGANIZATION_API_ADMIN_MEETING_INGESTION_EXCLUSION_BREAK_GLASS_PATH,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
} as const;

const response = {
  schema_version: 2,
  kind: 'echo-organization-member-exclusion-list-response',
  authority_id: IDS.authority,
  organization_id: IDS.organization,
  subject_principal_id: IDS.principal,
  membership_id: IDS.membership,
  source_adapter_id: 'granola',
  source_instance_id: 'primary',
  exclusions: [
    {
      scope: 'source',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
    },
    {
      scope: 'meeting',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'opaque/meeting-id',
    },
  ],
} as const;

describe('organization meeting-ingestion exclusion reads', () => {
  it('keeps Person and admin break-glass requests exact and distinct', () => {
    expect(validateOrganizationPersonMeetingIngestionExclusionListRequest(personRequest))
      .toEqual(personRequest);
    expect(
      validateOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequest(adminRequest),
    ).toEqual(adminRequest);
    expect(() =>
      validateOrganizationPersonMeetingIngestionExclusionListRequest(adminRequest),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequest(personRequest),
    ).toThrow('unexpected shape');
  });

  it('emits canonical request and response bytes', () => {
    expect(
      Buffer.from(
        canonicalOrganizationPersonMeetingIngestionExclusionListRequestBytes(personRequest),
      ).toString('utf8'),
    ).toBe(canonicalJson(personRequest));
    expect(
      Buffer.from(
        canonicalOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequestBytes(
          adminRequest,
        ),
      ).toString('utf8'),
    ).toBe(canonicalJson(adminRequest));
    expect(validateOrganizationMeetingIngestionExclusionListResponse(response)).toEqual(
      response,
    );
    expect(
      Buffer.from(
        canonicalOrganizationMeetingIngestionExclusionListResponseBytes(response),
      ).toString('utf8'),
    ).toBe(canonicalJson(response));
  });

  it('rejects broad reads, reasons, content, and cross-source response rows', () => {
    for (const forbidden of [
      { limit: 100 },
      { cursor: 'next' },
      { reason: 'investigation' },
      { include_history: true },
    ]) {
      expect(() =>
        validateOrganizationAdminMeetingIngestionExclusionBreakGlassReadRequest({
          ...adminRequest,
          ...forbidden,
        }),
      ).toThrow('unexpected shape');
    }
    expect(() =>
      validateOrganizationMeetingIngestionExclusionListResponse({
        ...response,
        exclusions: [
          {
            scope: 'meeting',
            source_adapter_id: 'slack',
            source_instance_id: 'other',
            external_id: 'secret',
          },
        ],
      }),
    ).toThrow('belongs to another source');
    expect(() =>
      validateOrganizationMeetingIngestionExclusionListResponse({
        ...response,
        exclusions: [response.exclusions[0], response.exclusions[0]],
      }),
    ).toThrow('duplicate');
  });
});
