import {
  isOrganizationRecordError,
  projectOrganizationRecord,
} from '@echo-brain/organization-record';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type {
  OrganizationPermissionPilotActivationMarkerV1,
  OrganizationPermissionPilotEligibleRecord,
} from '@echo-brain/organization-record';
import type { OrganizationRecentDecisionsRequestV1 } from '@echo-brain/organization-api';
import type { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import {
  OrganizationRecentDecisionsError,
  type OrganizationRecentDecisionsPilotActivation,
  type OrganizationRecentDecisionsProjectedRecord,
  type PreparedOrganizationRecentDecisionsResponse,
} from '../application/recent-decisions.js';
import type { OrganizationRecentDecisionsHttpApplication } from '../presentation/organization-recent-decisions-http-application.js';
import type { OrganizationRecordRuntime } from './organization-record.js';

function activationView(
  marker: OrganizationPermissionPilotActivationMarkerV1,
): OrganizationRecentDecisionsPilotActivation {
  return {
    organization_id: marker.organization_id,
    policy_id: marker.policy_id,
    marker_sha256: canonicalSha256(marker),
    audience_notice_sha256: marker.audience_notice_sha256,
    membership_ids: [
      marker.audience[0].membership_id,
      marker.audience[1].membership_id,
    ],
  };
}

function unavailable(message: string, cause: unknown): never {
  throw new OrganizationRecentDecisionsError('unavailable', message, {
    cause,
  });
}

function projectEligibleRecord(
  eligible: OrganizationPermissionPilotEligibleRecord,
): OrganizationRecentDecisionsProjectedRecord {
  let projection: ReturnType<typeof projectOrganizationRecord>;
  try {
    projection = projectOrganizationRecord(eligible.row);
  } catch (error) {
    if (isOrganizationRecordError(error)) {
      unavailable(
        'recent decisions canonical projection is unavailable',
        error,
      );
    }
    throw error;
  }
  if (
    projection.log_position !== eligible.row.position ||
    projection.record_hash !== eligible.row.record_hash
  ) {
    unavailable(
      'recent decisions canonical projection differs from its selected row',
      new Error('projection binding mismatch'),
    );
  }
  return {
    log_position: projection.log_position,
    record_hash: projection.record_hash,
    atoms: projection.atoms.map((atom) => ({
      atom_id: atom.atom_id,
      record_hash: atom.record_hash,
      kind: atom.kind,
      text: atom.text,
    })),
  };
}

/**
 * Wires startup-cached pilot health and the bounded canonical-log reader into
 * the Authority application. Clean absence leaves the route at its fixed 404;
 * degraded validation keeps a live handler that fails with the fixed 503 and
 * never reaches membership or record source reads.
 */
export function composeOrganizationRecentDecisions(
  authority: OrganizationAuthorityApplication,
  records: OrganizationRecordRuntime,
): OrganizationRecentDecisionsHttpApplication | undefined {
  const health = records.permissionPilotHealth;
  if (health.kind === 'absent') return undefined;
  if (health.kind === 'degraded') {
    return {
      recentDecisions(): never {
        throw new OrganizationRecentDecisionsError(
          'unavailable',
          'recent decisions permission pilot is unavailable',
          { cause: health.failure },
        );
      },
    };
  }
  const marker = health.activation;
  const activation = activationView(marker);
  return {
    recentDecisions(
      request: OrganizationRecentDecisionsRequestV1,
    ): PreparedOrganizationRecentDecisionsResponse {
      return authority.serveRecentDecisions(request, activation, () => {
        if (records.fatalFailure !== null) {
          throw new OrganizationRecentDecisionsError(
            'unavailable',
            'recent decisions record runtime is unavailable',
            { cause: records.fatalFailure },
          );
        }
        let eligible: readonly OrganizationPermissionPilotEligibleRecord[];
        try {
          eligible = records.readPermissionPilotEligibleRecords();
        } catch (error) {
          unavailable(
            'recent decisions record selection is unavailable',
            error,
          );
        }
        return eligible.map(projectEligibleRecord);
      });
    },
  };
}
