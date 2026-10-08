import type { Sha256Digest } from '@echo-brain/federation-protocol';
import { enqueueApprovedRecordRunV1, SqliteTriggerRunsV1 } from '../../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { approvalCoreFixture } from './approval-core.js';

const signal = () => new AbortController().signal;

/** Published approvals of the fixture's person, each with its pending approved-record run, on a clock the test moves. */
export async function approvedRunFixture(options: { readonly runs?: number; readonly now?: string } = {}) {
  let now = new Date(options.now ?? '2026-10-07T10:00:00.000Z');
  const f = await approvalCoreFixture();
  const runs = new SqliteTriggerRunsV1(f.db, () => now);
  const hook = enqueueApprovedRecordRunV1(runs);
  const approvals = [f.approvalId];
  for (let index = 1; index < (options.runs ?? 1); index++) approvals.push((await f.otherProposal()).approvalId);
  for (const approvalId of approvals) {
    f.core.decide('desktop', f.approve({ approval_id: approvalId, command_id: `approve-${approvalId}` }), () => f.session);
  }
  const publisher = f.publisher([hook]);
  await publisher.appendFinalizedApprovalsToV4(signal());
  return {
    ...f, runs, approvals,
    /** The first approval's published record. */
    recordSha256: f.db.prepare('SELECT record_sha256 FROM authority_trigger_runs_v1 WHERE event_ref=?').pluck().get(f.approvalId) as Sha256Digest,
    owner: f.person,
    stranger: { ...f.person, principal_id: 'prn_00000000-0000-4000-8000-0000000000f1', membership_id: 'mem_00000000-0000-4000-8000-0000000000f2' },
    clock: () => now,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
  };
}
