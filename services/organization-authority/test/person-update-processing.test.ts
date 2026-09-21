import { captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AdapterError, type DecisionProcessorAdapter } from '@echo-brain/organization-processing/core';
import type { ApprovalWorkflowComponentsV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { normalizePersonUpdateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/person-update-source-v1';
import { database, databases, fixtureCursorPolicy, ADMITTED_AT, decisions } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { SqlitePersonUpdateInboxV1 } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { PersonUpdateProcessingV1, verifiedPersonUpdateActorV1 } from '../src/composition/person-update-processing-v1.js';

const actor = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test', membership_type: 'owner' as const };
const request = () => ({ schema_version: 1 as const, kind: 'echo-person-update-submit-v1' as const, request_id: randomUUID(), title: 'Decision', text: 'We agreed to ship.' });
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

async function fixture() {
  const db = database(); let now = ADMITTED_AT; let linked = true;
  const inbox = new SqlitePersonUpdateInboxV1(db, () => now);
  const meetingState = new SqliteAuthorityMeetingProcessingStateV1(db, fixtureCursorPolicy, 'llm');
  const admission = await meetingState.readAdmission();
  const extract = vi.fn<DecisionProcessorAdapter['extract']>(async meeting => ({ ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, signals: [{ ...decisions.signals[0]!, evidence: [{ meeting_id: meeting.id, block_id: meeting.content[0]!.id, quote: meeting.content[0]!.text }] }] }));
  const processor: DecisionProcessorAdapter = { identity: decisions.processor, extract, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: now }) };
  const stage = vi.fn<ApprovalWorkflowComponentsV1['stager']['stage']>(async input => ({ kind: 'staged', stage_id: input.candidate.approval_id }));
  const approvals: ApprovalWorkflowComponentsV1 = { stager: { stage, reconcilePendingDeliveries: async () => {}, reconcileSuperseded: async () => {} }, can_review_as: () => linked, processing: { recoverV4Appends: async () => {}, observeAndFinalizePendingApprovals: async () => {}, appendFinalizedApprovalsToV4: async () => {} } };
  const worker = () => new PersonUpdateProcessingV1(inbox, actor.organization_id, admission, processor, approvals, () => now);
  return { db, inbox, extract, stage, processor, worker, meetingState, setLinked: (value: boolean) => { linked = value; }, later: () => { now = new Date(Date.parse(now) + 301_000).toISOString(); } };
}

describe('Person update serialized processing and recovery', () => {
  it('keeps pending text and provider content out of content telemetry', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    const original = f.extract.getMockImplementation()!; const contents: unknown[] = []; const events: unknown[] = [];
    f.extract.mockImplementationOnce(async (...args) => {
      captureCoreRuntimeContentV1('meeting_input', args[0]);
      return observeCoreRuntimeV1('model_call', async () => { captureCoreRuntimeContentV1('model_response', 'private provider payload'); return original(...args); });
    });
    await observeCoreRuntimeV1('worker_execution', () => f.worker().runOnce(new AbortController().signal), { observer: event => { events.push(event); }, content_observer: event => { contents.push(event); } });
    expect(events.length).toBeGreaterThan(0); expect(contents).toEqual([]);
  });
  it('reclaims an interrupted claim and repairs the frozen-candidate handoff without re-extraction', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    f.inbox.claim(); // process exits after claim
    f.stage.mockRejectedValueOnce(new Error('fixture crash after candidate/link commit'));
    await expect(f.worker().runOnce(new AbortController().signal)).rejects.toThrow('fixture crash');
    expect(f.inbox.read(actor, submission.request_id)?.candidate_id).toMatch(/^cnd_/);
    expect(f.extract).toHaveBeenCalledTimes(1);
    await f.worker().runOnce(new AbortController().signal);
    expect(f.extract).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM authority_live_source_candidates_v2').get()).toEqual({ n: 1 });
    expect(f.inbox.status(actor, submission.request_id).status).toBe('awaiting_approval');
    expect((await f.meetingState.readAdmission()).source.cursor).toContain('fixture-source:v1:live:');
  });

  it('blocks before the model when the exact actor lacks a link, and resumes the same item', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission); f.setLinked(false);
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, submission.request_id)).toMatchObject({ status: 'blocked', reason: 'reviewer_unavailable' });
    expect(f.extract).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled();
    f.setLinked(true); f.later(); await f.worker().runOnce(new AbortController().signal);
    expect(f.extract).toHaveBeenCalledTimes(1); expect(f.stage).toHaveBeenCalledTimes(1);
  });

  it('retains frozen work when delivery refuses after extraction rather than reporting a terminal processing failure', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    f.stage.mockRejectedValueOnce(new AdapterError('permanently_rejected', 'provider refusal', false));
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, submission.request_id)).toMatchObject({ status: 'blocked', reason: 'temporarily_unavailable' });
    expect(f.inbox.read(actor, submission.request_id)?.candidate_id).toMatch(/^cnd_/);
    f.later(); await f.worker().runOnce(new AbortController().signal);
    expect(f.extract).toHaveBeenCalledTimes(1);
    expect(f.inbox.status(actor, submission.request_id).status).toBe('awaiting_approval');
  });

  it('retains provider failure with bounded backoff while subsequent submissions progress', async () => {
    const f = await fixture(); const first = request(); const second = request();
    f.inbox.submit(actor, first); f.inbox.submit(actor, second);
    // Force deterministic intake order independent of UUID ordering.
    f.db.prepare('UPDATE authority_person_update_work_v1 SET retry_at = ? WHERE request_id = ?').run('2026-08-22T02:03:04.006Z', second.request_id);
    f.extract.mockRejectedValueOnce(new AdapterError('temporarily_unavailable', 'private provider payload', true));
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, first.request_id)).toMatchObject({ status: 'blocked', reason: 'temporarily_unavailable' });
    await f.worker().runOnce(new AbortController().signal); expect(f.extract).toHaveBeenCalledTimes(1);
    f.db.prepare('UPDATE authority_person_update_work_v1 SET retry_at = ? WHERE request_id = ?').run(ADMITTED_AT, second.request_id);
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, second.request_id).status).toBe('awaiting_approval');
    expect(JSON.stringify(f.inbox.status(actor, first.request_id))).not.toContain('private provider payload');
    f.later(); await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, first.request_id).status).toBe('awaiting_approval');
  });

  it.each(['permanent', 'empty', 'quarantine'] as const)('makes %s outcomes explicit without empty cards', async kind => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    if (kind === 'permanent') f.extract.mockRejectedValueOnce(new AdapterError('permanently_rejected', 'private rejection', false));
    if (kind === 'empty') f.extract.mockImplementationOnce(async meeting => ({ ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, signals: [] }));
    if (kind === 'quarantine') f.stage.mockResolvedValueOnce({ kind: 'quarantined', reason_code: 'approval_package_unrepresentable' });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, submission.request_id)).toMatchObject(kind === 'empty' ? { status: 'no_signals' } : kind === 'permanent' ? { status: 'failed', reason: 'processing_rejected' } : { status: 'blocked', reason: 'approval_delivery_quarantined' });
    if (kind !== 'quarantine') expect(f.stage).not.toHaveBeenCalled();
  });

  it('rechecks revocation after extraction before freezing or delivering', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    const original = f.extract.getMockImplementation()!;
    f.extract.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, actor.membership_id);
      return result;
    });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.read(actor, submission.request_id)).toMatchObject({ state: 'blocked', reason: 'reviewer_unavailable', candidate_id: null });
    expect(f.stage).not.toHaveBeenCalled();
    const document = normalizePersonUpdateV1(f.inbox.read(actor, submission.request_id)!);
    expect(verifiedPersonUpdateActorV1(f.inbox, document)).toBe('unavailable');
  });

  it('preserves cancelled work and fails visibly on corrupt persisted text', async () => {
    const f = await fixture(); const submission = request(); f.inbox.submit(actor, submission);
    const abort = new AbortController(); const original = f.extract.getMockImplementation()!;
    f.extract.mockImplementationOnce(async (...args) => { abort.abort(new Error('shutdown')); return original(...args); });
    await expect(f.worker().runOnce(abort.signal)).rejects.toThrow();
    expect(f.stage).not.toHaveBeenCalled();
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, submission.request_id).status).toBe('awaiting_approval');
    const bad = request(); f.inbox.submit(actor, bad);
    f.db.exec('DROP TRIGGER authority_person_updates_v1_immutable');
    f.db.prepare('UPDATE authority_person_updates_v1 SET text = ? WHERE request_id = ?').run('corrupt', bad.request_id);
    await expect(f.worker().runOnce(new AbortController().signal)).rejects.toThrow('persisted payload is invalid');
    expect(f.inbox.status(actor, bad.request_id)).toMatchObject({ status: 'failed', reason: 'processing_rejected' });
  });
});
