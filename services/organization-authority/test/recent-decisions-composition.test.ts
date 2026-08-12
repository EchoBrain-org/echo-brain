import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { OrganizationRecentDecisionsRequestV1 } from '@echo-brain/organization-api';
import type {
  OrganizationPermissionPilotActivationMarkerV1,
  OrganizationPermissionPilotEligibleRecord,
} from '@echo-brain/organization-record';
import type { OrganizationAuthorityApplication } from '../src/application/organization-authority.js';
import { OrganizationRecentDecisionsError } from '../src/application/recent-decisions.js';
import type {
  OrganizationRecentDecisionsPilotActivation,
  OrganizationRecentDecisionsProjectedRecord,
} from '../src/application/recent-decisions.js';
import { composeOrganizationRecentDecisions } from '../src/composition/recent-decisions.js';
import type {
  OrganizationPermissionPilotRuntimeHealth,
  OrganizationRecordRuntime,
} from '../src/composition/organization-record.js';

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const;

const audience = [
  {
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    label: 'Audrey',
  },
  {
    membership_id: 'mem_00000000-0000-4000-8000-000000000002',
    label: 'Zhenye',
  },
] as const;

const marker: OrganizationPermissionPilotActivationMarkerV1 = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  command_id: 'ppa_00000000-0000-4000-8000-000000000001',
  command_sha256: digest('a'),
  policy_id: 'pilot-member-readable-v1',
  presentation_policy_id: 'pilot-two-person-audience-v1',
  audience_notice_sha256: digest('b'),
  audience,
  presentation_descriptor: {
    schema_version: 1,
    kind: 'echo-organization-permission-pilot-presentation',
    policy_id: 'pilot-member-readable-v1',
    presentation_policy_id: 'pilot-two-person-audience-v1',
    audience,
    notice_text: 'Pilot notice',
    fallback_text: 'Pilot fallback',
  },
  activated_at: '2026-08-10T08:00:00.000Z',
  effective_after_position: 0,
  effective_after_record_hash: null,
};

function invokingAuthority(
  observeActivation: (
    activation: OrganizationRecentDecisionsPilotActivation,
  ) => void = () => undefined,
): OrganizationAuthorityApplication {
  return {
    serveRecentDecisions: (
      _request: OrganizationRecentDecisionsRequestV1,
      activation: OrganizationRecentDecisionsPilotActivation,
      load: () => readonly OrganizationRecentDecisionsProjectedRecord[],
    ) => {
      observeActivation(activation);
      load();
      return {
        status_code: 200,
        body: Buffer.from('{}'),
        item_references: [],
      };
    },
  } as unknown as OrganizationAuthorityApplication;
}

function runtime(
  read: () => readonly OrganizationPermissionPilotEligibleRecord[],
  permissionPilotHealth: OrganizationPermissionPilotRuntimeHealth = {
    kind: 'ready',
    activation: marker,
  },
): OrganizationRecordRuntime {
  return {
    permissionPilotHealth,
    readPermissionPilotEligibleRecords: read,
    fatalFailure: null,
  } as unknown as OrganizationRecordRuntime;
}

const request = {} as OrganizationRecentDecisionsRequestV1;

describe('recent decisions runtime composition', () => {
  it('binds the policy audit identity to the complete immutable marker', () => {
    const observed: OrganizationRecentDecisionsPilotActivation[] = [];
    const changedBoundary: OrganizationPermissionPilotActivationMarkerV1 = {
      ...marker,
      effective_after_position: 1,
      effective_after_record_hash: digest('c'),
    };
    for (const activation of [marker, changedBoundary]) {
      composeOrganizationRecentDecisions(
        invokingAuthority((value) => observed.push(value)),
        runtime(() => [], { kind: 'ready', activation }),
      )!.recentDecisions(request);
    }

    expect(observed.map((value) => value.marker_sha256)).toEqual([
      canonicalSha256(marker),
      canonicalSha256(changedBoundary),
    ]);
    expect(observed[0]!.marker_sha256).not.toBe(observed[1]!.marker_sha256);
  });

  it('distinguishes clean absence from degraded startup without source reads', () => {
    let authorityCalls = 0;
    let sourceReads = 0;
    const authority = invokingAuthority(() => {
      authorityCalls += 1;
    });
    const read = (): readonly OrganizationPermissionPilotEligibleRecord[] => {
      sourceReads += 1;
      return [];
    };

    expect(
      composeOrganizationRecentDecisions(
        authority,
        runtime(read, { kind: 'absent' }),
      ),
    ).toBeUndefined();

    const degraded = composeOrganizationRecentDecisions(
      authority,
      runtime(read, {
        kind: 'degraded',
        failure: new Error('corrupt eligibility pointer'),
      }),
    );
    expect(() => degraded!.recentDecisions(request)).toThrow(
      expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
        code: 'unavailable',
      }),
    );
    expect(authorityCalls).toBe(0);
    expect(sourceReads).toBe(0);
  });

  it('maps a canonical-log selection failure to retryable unavailability', () => {
    const application = composeOrganizationRecentDecisions(
      invokingAuthority(),
      runtime(() => {
        throw new Error('simulated record database outage');
      }),
    );
    expect(() => application!.recentDecisions(request)).toThrow(
      expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
        code: 'unavailable',
      }),
    );
  });

  it('maps a defined pure-projector failure to retryable unavailability', () => {
    const invalid = {
      row: {
        position: 1,
        envelope_id: 'ore_00000000-0000-4000-8000-000000000001',
        event_type: 'approval',
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        idempotency_key: digest('c'),
        canonical_envelope: '{}',
        envelope_sha256: digest('d'),
        receipt_payload: '{}',
        previous_record_hash: null,
        record_hash: digest('e'),
        recorded_at: '2026-08-10T08:00:00.000Z',
      },
      eligibility: {
        policy_id: 'pilot-member-readable-v1',
        presentation_policy_id: 'pilot-two-person-audience-v1',
        audience_notice_sha256: marker.audience_notice_sha256,
        message_presentation_sha256: digest('f'),
      },
    } as OrganizationPermissionPilotEligibleRecord;
    const application = composeOrganizationRecentDecisions(
      invokingAuthority(),
      runtime(() => [invalid]),
    );
    expect(() => application!.recentDecisions(request)).toThrow(
      expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
        code: 'unavailable',
      }),
    );
  });
});
