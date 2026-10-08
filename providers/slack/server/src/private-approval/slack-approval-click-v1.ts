import Database from 'better-sqlite3';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { VerifiedSlackApprovalClickV1 } from './private-slack-approval-interaction-protocol-v1.js';

export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
type LinkV1 = ApprovalActorV1 & { readonly external_identity_link_id: string; readonly contract_sha256: string; readonly connection_id: string; readonly api_app_id: string };
type TargetV1 = { readonly connection_id: string; readonly external_identity_link_id: string; readonly external_identity_link_contract_sha256: string; readonly slack_workspace_id: string; readonly slack_subject_id: string; readonly api_app_id: string };
type CoreV1 = {
  decide(surface: 'slack', request: { readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: Sha256Digest; readonly action: 'approve' | 'reject'; readonly project_ids: readonly string[]; readonly share_transcript: boolean; readonly owners: readonly { readonly signal_id: string; readonly owner: string }[] }, authorize: () => { readonly actor: ApprovalActorV1; readonly evidence: { readonly kind: 'slack-click'; readonly sha256: Sha256Digest } }): { readonly kind: 'decided' | 'replayed' | 'already_decided' | 'stale' };
  proposal(id: string): { readonly reviewer: ApprovalActorV1 } | undefined;
  ownerProposals(id: string): readonly { readonly signal_id: string }[];
};
function sameActor(left: ApprovalActorV1, right: ApprovalActorV1): boolean { return left.organization_id === right.organization_id && left.principal_id === right.principal_id && left.membership_id === right.membership_id; }
function target(value: unknown): TargetV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort(), expected = ['api_app_id', 'connection_id', 'external_identity_link_contract_sha256', 'external_identity_link_id', 'slack_subject_id', 'slack_workspace_id'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || expected.some(key => typeof record[key] !== 'string')) return undefined;
  return record as unknown as TargetV1;
}
/** A target-bound Slack click adapter. It writes only through approval core decide(). */
export function createSlackApprovalClickV1(options: {
  readonly database: Database.Database;
  readonly core: CoreV1;
  readonly link: (click: { readonly workspace_id: string; readonly subject_id: string }) => LinkV1 | null;
  readonly redraw: (approvalId: string) => void;
}): (click: VerifiedSlackApprovalClickV1) => { readonly outcome: 'decided' | 'already_decided' | 'stale' | 'refused' } {
  const presentation = options.database.prepare("SELECT target_json,dm_channel_id,message_ts FROM authority_approval_presentations_v1 WHERE approval_id=? AND surface='slack' AND delivery='posted'");
  return click => {
    const row = presentation.get(click.approval_id) as { target_json: string; dm_channel_id: string | null; message_ts: string | null } | undefined;
    if (row === undefined || row.dm_channel_id === null || row.message_ts === null) return { outcome: 'refused' };
    let posted: TargetV1 | undefined; try { posted = target(JSON.parse(row.target_json)); } catch { posted = undefined; }
    if (posted === undefined || click.lookup.workspace_id !== posted.slack_workspace_id || click.lookup.slack_user_id !== posted.slack_subject_id || click.lookup.channel_id !== row.dm_channel_id || click.lookup.message_ts !== row.message_ts || click.lookup.api_app_id !== posted.api_app_id || click.lookup.message_app_id !== posted.api_app_id) return { outcome: 'refused' };
    const proposal = options.core.proposal(click.approval_id); if (proposal === undefined) return { outcome: 'refused' };
    const permitted = new Set(options.core.ownerProposals(click.approval_id).map(owner => owner.signal_id));
    if (click.owners.some(owner => !permitted.has(owner.signal_id))) return { outcome: 'refused' };
    const evidence = canonicalSha256({ provider_action_key_sha256: click.provider_action_key_sha256, workspace: click.lookup.workspace_id, subject: click.lookup.slack_user_id, channel: click.lookup.channel_id, message_ts: click.lookup.message_ts, link_id: posted.external_identity_link_id, link_contract_sha256: posted.external_identity_link_contract_sha256 });
    const authorize = () => {
      const current = options.link({ workspace_id: click.lookup.workspace_id, subject_id: click.lookup.slack_user_id });
      if (current === null || !sameActor(current, proposal.reviewer) || current.connection_id !== posted.connection_id || current.api_app_id !== posted.api_app_id || current.external_identity_link_id !== posted.external_identity_link_id || current.contract_sha256 !== posted.external_identity_link_contract_sha256) throw new AuthorityOperationError('unauthorized', 'Slack approval link is no longer current');
      return { actor: { organization_id: current.organization_id, principal_id: current.principal_id, membership_id: current.membership_id }, evidence: { kind: 'slack-click' as const, sha256: evidence } };
    };
    try {
      const result = options.core.decide('slack', { approval_id: click.approval_id, command_id: `slack:${click.provider_action_key_sha256.slice(7)}`, snapshot_sha256: click.snapshot_sha256, action: click.action,
        project_ids: click.action === 'approve' && click.audience === 'projects' ? click.project_ids : [], share_transcript: click.action === 'approve' ? click.share_transcript : false,
        owners: click.action === 'approve' ? options.core.ownerProposals(click.approval_id).flatMap(owner => { const chosen = click.owners.find(value => value.signal_id === owner.signal_id); return chosen === undefined ? [] : [chosen]; }) : [] }, authorize);
      const outcome = result.kind === 'decided' || result.kind === 'replayed' ? 'decided' : result.kind;
      if (outcome !== 'decided') options.redraw(click.approval_id);
      return { outcome };
    } catch (error) {
      if (error instanceof AuthorityOperationError) return { outcome: error.code === 'stale_access_state' ? 'stale' : 'refused' };
      throw error;
    }
  };
}
