import { describe, expect, it } from 'vitest';
import type { PinnedOrganizationAuthority } from '@echo-brain/organization-protocol';
import {
  classifyOrganizationComposition,
  type OrganizationCompositionFacts,
} from '../../src/product/organization/state/organization-composition-state.js';
import type {
  StoredOrganizationAuthorityConnection,
  StoredOrganizationEnrollment,
} from '../../src/product/organization/state/organization-state-store.js';

const pinnedAuthority = {} as PinnedOrganizationAuthority;
const authorityConnection = {} as StoredOrganizationAuthorityConnection;

function enrollment(input: {
  receipt: boolean;
  accessSequence: number;
}): StoredOrganizationEnrollment {
  return {
    request: {} as StoredOrganizationEnrollment['request'],
    receipt: input.receipt
      ? ({} as NonNullable<StoredOrganizationEnrollment['receipt']>)
      : null,
    accepted_access_sequence: input.accessSequence,
    accepted_access_sha256:
      input.accessSequence === 0
        ? null
        : (`sha256:${'a'.repeat(64)}` as StoredOrganizationEnrollment['accepted_access_sha256']),
    trusted_time_high_watermark:
      input.accessSequence === 0 ? null : '2026-08-13T07:00:00.000Z',
  };
}

function current(facts: OrganizationCompositionFacts) {
  return classifyOrganizationComposition({
    kind: 'organization-schema',
    schemaVersion: 8,
    facts,
  });
}

describe('organization composition state', () => {
  it('classifies absent and pre-organization databases as unmanaged', () => {
    expect(
      classifyOrganizationComposition({ kind: 'database-absent' }),
    ).toEqual({ kind: 'unmanaged', source: 'database-absent' });
    expect(
      classifyOrganizationComposition({
        kind: 'pre-organization-schema',
        schemaVersion: 4,
      }),
    ).toEqual({
      kind: 'unmanaged',
      source: 'pre-organization-schema',
      schemaVersion: 4,
    });
  });

  it('names every pinned enrollment phase', () => {
    for (const [storedEnrollment, phase] of [
      [null, 'not-requested'],
      [enrollment({ receipt: false, accessSequence: 0 }), 'awaiting-receipt'],
      [enrollment({ receipt: true, accessSequence: 0 }), 'awaiting-access'],
    ] as const) {
      expect(
        current({
          pinnedAuthority,
          authorityConnection,
          enrollment: storedEnrollment,
        }),
      ).toMatchObject({ kind: 'pinned-unenrolled', phase });
    }
  });

  it('distinguishes accepted disconnected and connected enrollment', () => {
    const accepted = enrollment({ receipt: true, accessSequence: 1 });
    expect(
      current({
        pinnedAuthority,
        authorityConnection: null,
        enrollment: accepted,
      }),
    ).toMatchObject({ kind: 'enrolled-disconnected' });
    expect(
      current({
        pinnedAuthority,
        authorityConnection,
        enrollment: accepted,
      }),
    ).toMatchObject({ kind: 'enrolled-connected' });
  });

  it('fails closed for impossible cross-record combinations', () => {
    expect(
      current({
        pinnedAuthority: null,
        authorityConnection,
        enrollment: null,
      }),
    ).toMatchObject({ kind: 'corrupt' });
    expect(
      current({
        pinnedAuthority,
        authorityConnection,
        enrollment: enrollment({ receipt: false, accessSequence: 1 }),
      }),
    ).toMatchObject({ kind: 'corrupt' });
  });
});
