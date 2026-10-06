import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV11 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { bindApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1';
import { applyOrganizationRecordLogBaselineV4, OrganizationRecordAppenderV4, createRecordPolicyFactProjectorRegistryV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { testAuthority } from '../../../../packages/organization-protocol/test/fixtures/record-v4-fixture.js';
import { database as sourceFixture, databases as fixtures, decisions as fixtureDecisions, fixtureCursorPolicy, meeting as fixtureMeeting, REVIEW_POLICY } from '../../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import type { ApprovalWorkflowContextV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import { createPersonMeetingReviewV1, type PersonMeetingReviewActionV1 } from '../../src/composition/person-meeting-review-v1.js';
import { createPersonMeetingApprovalPolicyProjectorV1 } from '../../src/composition/person-meeting-approval-projection-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../../src/adapters/persistence/sqlite/source-admission-v1.js';
import { meetingSourceEnvelopeV1 } from '@echo-brain/organization-processing/core';

const meeting = { ...fixtureMeeting, provenance: { ...fixtureMeeting.provenance, canonical_revision: canonicalSha256('test revision') } };
const decisions = { ...fixtureDecisions, meeting_revision: meeting.provenance.canonical_revision };
const opened: Database.Database[] = [];
afterEach(() => { for (const db of [...opened.splice(0), ...fixtures.splice(0)]) db.close(); });
export async function personMeetingReviewFixture(project = false): Promise<{
  db: Database.Database; record: Database.Database;
  actor: { organization_id: string; principal_id: string; membership_id: string; authorization_sha256: `sha256:${string}` };
  review: Awaited<ReturnType<typeof createPersonMeetingReviewV1>>;
  request: PersonMeetingReviewActionV1; context: ApprovalWorkflowContextV1;
}> {
  const authority = testAuthority();
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); opened.push(db); applyAuthorityBaselineV11(db);
  const old = sourceFixture();
  const actor = { organization_id: authority.descriptor.organization_id, principal_id: 'prn_00000000-0000-4000-8000-000000000003', membership_id: 'mem_00000000-0000-4000-8000-000000000004', authorization_sha256: canonicalSha256('session proof') };
  const substitutions: Record<string, string> = { org_test: actor.organization_id, oau_test: authority.descriptor.authority_id, prn_test: actor.principal_id, mem_test: actor.membership_id };
  for (const table of ['authority_metadata', 'authority_principals', 'authority_memberships', 'authority_live_source_admission_v2']) {
    const row = old.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row).map(value => typeof value === 'string' && substitutions[value] !== undefined ? substitutions[value] : value));
  }
  const record = new Database(':memory:'); opened.push(record); record.pragma('foreign_keys=ON'); applyOrganizationRecordLogBaselineV4(record);
  const coordinates = { authority_id: authority.descriptor.authority_id, organization_id: actor.organization_id, state_lineage_id: 'lineage-test' };
  record.prepare('INSERT INTO organization_record_log_metadata VALUES (1,?,?,?,?)').run(coordinates.authority_id, coordinates.organization_id, coordinates.state_lineage_id, '2026-10-06T00:00:00.000Z');
  const append = new OrganizationRecordAppenderV4(record, coordinates, createRecordPolicyFactProjectorRegistryV1([createPersonMeetingApprovalPolicyProjectorV1()]));
  const state = new SqliteAuthorityMeetingProcessingStateV1(db, fixtureCursorPolicy, 'llm');
  const admission = await state.readAdmission();
  new SqliteSourceAdmissionStoreV1(db).admit({ source: meetingSourceEnvelopeV1(meeting), scope: { organization_id: actor.organization_id,
    custody_ref: `person:${actor.membership_id}`, access_policy_ref: `person:${actor.membership_id}`, analysis_policy: 'automatic' } });
  const candidate = await state.stageCandidate({ admission, meeting, decisions, review_policy: REVIEW_POLICY });
  if (candidate.disposition !== 'actionable') throw new Error('Expected a review');
  const context = { coordinates, signer: { inspect: async () => authority.descriptor, sign: authority.sign },
    record_append: append, next_envelope_id: () => 'envelope-person-review',
    state: bindApprovalWorkflowStateV1(state, () => { if (db.inTransaction) throw new Error('Shared approval port called inside a transaction'); }) };
  const review = await createPersonMeetingReviewV1(db, context);
  await review.stager.stage({ candidate, admission, meeting, decisions });
  const frozen = state.readFrozenCandidateForApproval(candidate.approval_id)!;
  const request = { command_id: 'review-test', approval_id: candidate.approval_id, snapshot_sha256: frozen.approved_snapshot_sha256! as `sha256:${string}`,
    action: 'approve' as const, project_id: project ? 'prj_00000000-0000-4000-8000-000000000005' : null, share_transcript: false };
  return { db, record, actor, review, request, context };
}
