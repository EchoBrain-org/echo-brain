import type { PinnedOrganizationAuthority } from '@echo-brain/organization-protocol';
import type {
  StoredOrganizationAuthorityConnection,
  StoredOrganizationEnrollment,
} from './organization-state-store.js';

export interface OrganizationCompositionFacts {
  readonly pinnedAuthority: PinnedOrganizationAuthority | null;
  readonly authorityConnection: StoredOrganizationAuthorityConnection | null;
  readonly enrollment: StoredOrganizationEnrollment | null;
}

export type OrganizationCompositionObservation =
  | { readonly kind: 'database-absent' }
  | {
      readonly kind: 'pre-organization-schema';
      readonly schemaVersion: number;
    }
  | {
      readonly kind: 'organization-schema';
      readonly schemaVersion: number;
      readonly facts: OrganizationCompositionFacts;
    }
  | { readonly kind: 'corrupt'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type AcceptedOrganizationEnrollment = StoredOrganizationEnrollment & {
  receipt: NonNullable<StoredOrganizationEnrollment['receipt']>;
};

export type OrganizationCompositionState =
  | {
      readonly kind: 'unmanaged';
      readonly source:
        | 'database-absent'
        | 'pre-organization-schema'
        | 'organization-schema';
      readonly schemaVersion?: number;
    }
  | {
      readonly kind: 'pinned-unenrolled';
      readonly pinnedAuthority: PinnedOrganizationAuthority;
      readonly authorityConnection: StoredOrganizationAuthorityConnection | null;
      readonly enrollment: StoredOrganizationEnrollment | null;
      readonly phase: 'not-requested' | 'awaiting-receipt' | 'awaiting-access';
    }
  | {
      readonly kind: 'enrolled-disconnected';
      readonly pinnedAuthority: PinnedOrganizationAuthority;
      readonly enrollment: AcceptedOrganizationEnrollment;
    }
  | {
      readonly kind: 'enrolled-connected';
      readonly pinnedAuthority: PinnedOrganizationAuthority;
      readonly authorityConnection: StoredOrganizationAuthorityConnection;
      readonly enrollment: AcceptedOrganizationEnrollment;
    }
  | { readonly kind: 'corrupt'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export function hasAcceptedOrganizationEnrollment(
  enrollment: StoredOrganizationEnrollment | null,
): enrollment is AcceptedOrganizationEnrollment {
  return (
    enrollment !== null &&
    enrollment.receipt !== null &&
    enrollment.accepted_access_sequence > 0
  );
}

/**
 * One pure interpretation of organization composition state.
 *
 * Runtime and diagnostics deliberately share this classifier. Persistence
 * readers authenticate the rows first; this function only decides which
 * capabilities that authenticated snapshot is allowed to compose.
 */
export function classifyOrganizationComposition(
  observation: OrganizationCompositionObservation,
): OrganizationCompositionState {
  switch (observation.kind) {
    case 'database-absent':
      return { kind: 'unmanaged', source: observation.kind };
    case 'pre-organization-schema':
      return {
        kind: 'unmanaged',
        source: observation.kind,
        schemaVersion: observation.schemaVersion,
      };
    case 'corrupt':
    case 'unavailable':
      return observation;
    case 'organization-schema': {
      const { pinnedAuthority, authorityConnection, enrollment } =
        observation.facts;
      if (pinnedAuthority === null) {
        if (authorityConnection !== null || enrollment !== null) {
          return {
            kind: 'corrupt',
            detail:
              'organization connection or enrollment exists without a pinned authority',
          };
        }
        return {
          kind: 'unmanaged',
          source: observation.kind,
          schemaVersion: observation.schemaVersion,
        };
      }
      if (
        enrollment !== null &&
        enrollment.receipt === null &&
        enrollment.accepted_access_sequence > 0
      ) {
        return {
          kind: 'corrupt',
          detail:
            'organization access was accepted without an enrollment receipt',
        };
      }
      if (!hasAcceptedOrganizationEnrollment(enrollment)) {
        return {
          kind: 'pinned-unenrolled',
          pinnedAuthority,
          authorityConnection,
          enrollment,
          phase:
            enrollment === null
              ? 'not-requested'
              : enrollment.receipt === null
                ? 'awaiting-receipt'
                : 'awaiting-access',
        };
      }
      if (authorityConnection === null) {
        return {
          kind: 'enrolled-disconnected',
          pinnedAuthority,
          enrollment,
        };
      }
      return {
        kind: 'enrolled-connected',
        pinnedAuthority,
        authorityConnection,
        enrollment,
      };
    }
  }
}
