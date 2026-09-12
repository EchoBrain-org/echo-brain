import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { isSyntheticDemoFixtureMeetingV1, SYNTHETIC_DEMO_MEETING_COUNT_V1, syntheticDemoMeetingSourceIdentityV1 } from './source/synthetic-demo-meeting-source-v1.js';
interface SyntheticFixtureApprovalEvidence {
  readonly source_admitted: boolean;
  readonly all_fixture_meetings_approved: boolean;
}
export function syntheticFixtureApprovalEvidence(
  manifest: { readonly organization_id: string; readonly owner_principal_id: string; readonly owner_membership_id: string },
  authority: Database.Database,
  record: Database.Database,
): SyntheticFixtureApprovalEvidence {
  const admission = authority
    .prepare(
      `SELECT semantic_input_sha256
         FROM authority_live_source_admission_v2
        WHERE singleton = 1 AND organization_id = ? AND principal_id = ?
          AND membership_id = ? AND membership_type = 'owner'
          AND source_adapter_id = ? AND source_adapter_instance_id = ?
          AND source_adapter_version = ?
        LIMIT 1`,
    )
    .get(
      manifest.organization_id,
      manifest.owner_principal_id,
      manifest.owner_membership_id,
      syntheticDemoMeetingSourceIdentityV1.adapter_id,
      syntheticDemoMeetingSourceIdentityV1.instance_id,
      syntheticDemoMeetingSourceIdentityV1.version,
    ) as { readonly semantic_input_sha256: string } | undefined;
  if (admission === undefined) {
    return Object.freeze({
      source_admitted: false,
      all_fixture_meetings_approved: false,
    });
  }
  const candidates = authority
    .prepare(
      `SELECT candidate.meeting_json, candidate.meeting_sha256, outbox.approval_id
         FROM authority_live_source_candidates_v2 AS candidate
         JOIN authority_live_approval_outbox_v2 AS outbox
           ON outbox.candidate_id = candidate.candidate_id
        WHERE candidate.admission_semantic_input_sha256 = ?
          AND candidate.disposition = 'actionable'`,
    )
    .all(admission.semantic_input_sha256) as readonly {
    readonly meeting_json: string;
    readonly meeting_sha256: string;
    readonly approval_id: string;
  }[];
  const approvedMeetingIds = new Set<string>();
  for (const candidate of candidates) {
    try {
      const meeting = JSON.parse(candidate.meeting_json) as unknown;
      if (
        canonicalJson(meeting as never) !== candidate.meeting_json ||
        canonicalSha256(meeting as never) !== candidate.meeting_sha256 ||
        !isSyntheticDemoFixtureMeetingV1(meeting) ||
        record
          .prepare(
            `SELECT 1 FROM organization_record_log
              WHERE event_kind = 'approved' AND action = 'approve'
                AND approval_id = ?
              LIMIT 1`,
          )
          .get(candidate.approval_id) === undefined
      ) {
        continue;
      }
      approvedMeetingIds.add(meeting.id);
    } catch {
      // A malformed candidate or record mapping cannot become setup evidence.
    }
  }
  return Object.freeze({
    source_admitted: true,
    all_fixture_meetings_approved:
      approvedMeetingIds.size === SYNTHETIC_DEMO_MEETING_COUNT_V1,
  });
}
export function isSyntheticDemoSetupAdmissionV1(value: { readonly source_adapter_id: unknown; readonly source_adapter_instance_id: unknown; readonly source_custodian_assurance: unknown; readonly source_custodian_observed_at: unknown } | undefined): boolean {
  return value?.source_adapter_id === 'synthetic-demo-source' && value.source_adapter_instance_id === 'customer-demo' &&
    value.source_custodian_assurance === 'authority_initial_owner_identity' && typeof value.source_custodian_observed_at === 'string';
}
