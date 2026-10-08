import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { approvalCoreFixture, PROJECT_A } from '../../../../../services/organization-authority/test/fixtures/approval-core.js';
import { createSlackApprovalClickV1 } from '../../src/private-approval/slack-approval-click-v1.js';

const TARGET = { connection_id: 'con_00000000-0000-4000-8000-000000000001', external_identity_link_id: 'lnk_00000000-0000-4000-8000-000000000001', external_identity_link_contract_sha256: canonicalSha256('link contract'), slack_workspace_id: 'T012ABCDEF', slack_subject_id: 'U012ABCDEF', api_app_id: 'A012ABCDEF' };
function click(approval_id: string, snapshot_sha256: `sha256:${string}`, patch: Record<string, unknown> = {}) {
  return { schema_version: 4 as const, disposition: 'resolution' as const, action: 'approve' as const, approval_id, snapshot_sha256, audience: 'projects' as const,
    project_ids: [PROJECT_A], share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }], provider_action_key_sha256: canonicalSha256('click action'),
    lookup: { api_app_id: TARGET.api_app_id, workspace_id: TARGET.slack_workspace_id, slack_user_id: TARGET.slack_subject_id, channel_id: 'D012ABCDEF', message_ts: '1712345678.123456', message_user_id: 'U098BOTAPP', message_app_id: TARGET.api_app_id, message_bot_id: 'B012ABCDEF' }, ...patch };
}
async function fixture() {
  const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' }, projects: 2 });
  f.db.prepare("INSERT INTO authority_approval_presentations_v1(approval_id,surface,target_json,dm_channel_id,delivery,marker_state,marker_started_at,message_ts,card_sha256,shows,attempts,retry_at,created_at,updated_at) VALUES (?,'slack',?,'D012ABCDEF','posted',NULL,NULL,'1712345678.123456',NULL,'open',0,NULL,?,?)")
    .run(f.approvalId, JSON.stringify(TARGET), '2026-10-07T09:00:00.000Z', '2026-10-07T09:00:00.000Z');
  const link = vi.fn(() => ({ ...f.person, external_identity_link_id: TARGET.external_identity_link_id, contract_sha256: TARGET.external_identity_link_contract_sha256 }));
  const redraw = vi.fn();
  return { ...f, link, redraw, decide: createSlackApprovalClickV1({ database: f.db, core: f.core, link, redraw }) };
}

describe('Slack approval click V1', () => {
  it('decides through the real core with project choices and proposal-keyed owners', async () => {
    const f = await fixture();
    expect(f.core.proposal(f.approvalId)).toMatchObject({ reviewer: f.person });
    expect(f.link()).toMatchObject(f.core.proposal(f.approvalId)!.reviewer);
    expect(f.core.ownerProposals(f.approvalId)).toContainEqual({ signal_id: 'act-1', action: expect.any(String), proposed: 'Rafael Moreno' });
    expect(f.decide(click(f.approvalId, f.snapshotOf(f.approvalId)!))).toEqual({ outcome: 'decided' });
    expect(f.db.prepare('SELECT surface,action,command_id FROM authority_approval_decisions_v1').get()).toMatchObject({ surface: 'slack', action: 'approve', command_id: `slack:${canonicalSha256('click action').slice(7)}` });
  });
  it.each(['workspace_id', 'slack_user_id', 'channel_id', 'message_ts', 'api_app_id', 'message_app_id'] as const)('refuses a %s mismatch before decide writes', async field => {
    const f = await fixture(), source = click(f.approvalId, f.snapshotOf(f.approvalId)!);
    const lookup = { ...source.lookup, [field]: `${source.lookup[field]}X` };
    expect(f.decide({ ...source, lookup })).toEqual({ outcome: 'refused' });
    expect(f.decisionCount()).toBe(0);
  });
  it('refuses a removed link, changed contract, unknown owner, or a link that changes at core second authorization', async () => {
    const f = await fixture(), source = click(f.approvalId, f.snapshotOf(f.approvalId)!);
    f.link.mockReturnValueOnce(null as never);
    expect(f.decide(source)).toEqual({ outcome: 'refused' }); expect(f.decisionCount()).toBe(0);
    f.link.mockReset(); f.link.mockReturnValue({ ...f.person, external_identity_link_id: TARGET.external_identity_link_id, contract_sha256: TARGET.external_identity_link_contract_sha256 });
    expect(f.decide({ ...source, owners: [{ signal_id: 'act_unknown', owner: 'Ada' }] })).toEqual({ outcome: 'refused' }); expect(f.decisionCount()).toBe(0);
    let calls = 0; f.link.mockImplementation(() => (++calls === 1 ? ({ ...f.person, external_identity_link_id: TARGET.external_identity_link_id, contract_sha256: TARGET.external_identity_link_contract_sha256 }) : null) as never);
    expect(f.decide(source)).toEqual({ outcome: 'refused' }); expect(f.decisionCount()).toBe(0);
  });
  it('makes a desktop click race produce exactly one decision and one published record', async () => {
    const f = await fixture(), slack = click(f.approvalId, f.snapshotOf(f.approvalId)!);
    const results = await Promise.all([Promise.resolve().then(() => f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session)), Promise.resolve().then(() => f.decide(slack))]);
    expect(f.decisionCount()).toBe(1);
    await f.core.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(f.recordCount()).toBe(1);
    expect(results.map(result => 'kind' in result ? result.kind : result.outcome).sort()).toEqual(['already_decided', 'decided']);
  });
  it('redraws a stale snapshot without a decision', async () => {
    const f = await fixture();
    expect(f.decide(click(f.approvalId, canonicalSha256('old snapshot')))).toEqual({ outcome: 'stale' });
    expect(f.decisionCount()).toBe(0); expect(f.redraw).toHaveBeenCalledWith(f.approvalId);
  });
});
