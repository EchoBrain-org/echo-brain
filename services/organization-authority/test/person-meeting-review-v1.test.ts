import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { personMeetingReviewFixture as fixture } from './fixtures/person-meeting-review.js';
import { createPersonMeetingReviewV1 } from '../src/composition/person-meeting-review-v1.js';
import { projectPersonMeetingApproverV1 } from '../src/composition/person-meeting-approval-projection-v1.js';
describe('in-app meeting approval through the shared processing and record path', () => {
  it('acknowledges the durable action even when its post-commit wake fails', async () => {
    const f = await fixture();
    let observed = false;
    const review = await createPersonMeetingReviewV1(f.db, { ...f.context, on_terminal_action_queued() {
      expect(f.db.inTransaction).toBe(false);
      expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_approval_actions_v1').pluck().get()).toBe(1);
      observed = true;
      throw new Error('wake unavailable');
    } });
    expect(review.resolve(f.request, () => f.actor).status).toBe('publishing');
    expect(observed).toBe(true);
    await review.processing.recoverV4Appends(new AbortController().signal);
    expect(review.resolve(f.request, () => f.actor).status).toBe('approved');
  });
  it.each([{ project: false, share: false }, { project: true, share: false }, { project: true, share: true }])('publishes the exact audience and transcript choice and recovers once (project=$project, share=$share)', async ({ project, share }) => {
    const f = await fixture(project);
    f.request = { ...f.request, share_transcript: share };
    expect(() => f.review.resolve(f.request, () => ({ ...f.actor, membership_id: 'mem_someone_else' }))).toThrow('not available');
    expect(f.review.resolve(f.request, () => f.actor).status).toBe('publishing');
    const resumed = await createPersonMeetingReviewV1(f.db, f.context);
    await resumed.processing.recoverV4Appends(new AbortController().signal);
    expect(resumed.resolve(f.request, () => f.actor).status).toBe('approved');
    await resumed.processing.recoverV4Appends(new AbortController().signal);
    expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_approval_actions_v1').pluck().get()).toBe(1);
    const row = f.record.prepare('SELECT canonical_envelope FROM organization_record_log').get() as { canonical_envelope: string };
    const envelope = JSON.parse(row.canonical_envelope);
    expect(envelope.body.human_act_resolution_ref.share_transcript).toBe(share);
    expect(envelope.body.human_act_resolution_ref.audience_project_ids).toEqual(project ? [f.request.project_id] : []);
    expect(projectPersonMeetingApproverV1(envelope)?.membership_id).toBe(f.actor.membership_id);
    expect(() => resumed.resolve({ ...f.request, share_transcript: !share }, () => f.actor)).toThrow('already been resolved');
  });
  it('recovers an append committed just before the local receipt was saved', async () => {
    const f = await fixture();
    const interrupted = await createPersonMeetingReviewV1(f.db, { ...f.context, record_append: { async append(input) {
      await f.context.record_append.append(input);
      throw new Error('interrupted after signed append');
    } } });
    interrupted.resolve(f.request, () => f.actor);
    await expect(interrupted.processing.recoverV4Appends(new AbortController().signal)).rejects.toThrow('interrupted');
    expect(f.db.prepare('SELECT receipt_json FROM authority_person_meeting_approval_actions_v1').pluck().get()).toBeNull();
    await f.review.processing.recoverV4Appends(new AbortController().signal);
    expect(f.record.prepare('SELECT count(*) FROM organization_record_log').pluck().get()).toBe(1);
    expect(f.review.resolve(f.request, () => f.actor).status).toBe('approved');
  });
  it('rejects stale snapshots and records rejection without a signed approved decision', async () => {
    const f = await fixture();
    expect(() => f.review.resolve({ ...f.request, snapshot_sha256: canonicalSha256('different snapshot') }, () => f.actor)).toThrow('changed');
    const request = { ...f.request, action: 'reject' as const };
    expect(f.review.resolve(request, () => f.actor).status).toBe('rejected');
    await f.review.processing.recoverV4Appends(new AbortController().signal);
    expect(f.db.prepare('SELECT receipt_json FROM authority_person_meeting_approval_actions_v1').pluck().get()).toBeNull();
  });
});
