import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type JsonValue } from '@echo-brain/federation-protocol';
import { buildSlackApprovalCardV4, buildClosedApprovalCardV4, type SlackApprovalCardV4 } from './slack-approval-card-v4.js';

export interface SlackApprovalTargetV1 {
  readonly connection_id: string; readonly external_identity_link_id: string; readonly external_identity_link_contract_sha256: string;
  readonly slack_workspace_id: string; readonly slack_subject_id: string; readonly api_app_id: string;
  /** Resolved before INSERT so later click matching cannot drift to another DM. */
  readonly dm_channel_id: string;
}
export interface SlackApprovalPosterV1 {
  openDirectMessage(subject: string, signal?: AbortSignal): Promise<{ readonly kind: 'opened'; readonly channel_id: string } | { readonly kind: 'retry_allowed' }>;
  postMarker(input: { readonly approval_id: string; readonly dm_channel_id: string }, signal?: AbortSignal): Promise<{ readonly kind: 'posted'; readonly provider_message_ts: string } | { readonly kind: 'retry_allowed' } | { readonly kind: 'uncertain' }>;
  reconcileMarker(input: { readonly approval_id: string; readonly dm_channel_id: string; readonly post_started_at: string; readonly reconciliation_started_at: string }, signal?: AbortSignal): Promise<{ readonly kind: 'posted'; readonly provider_message_ts: string } | { readonly kind: 'retry_allowed' } | { readonly kind: 'uncertain' }>;
  publish(input: { readonly approval_id: string; readonly dm_channel_id: string; readonly provider_message_ts: string; readonly card: SlackApprovalCardV4 }, signal?: AbortSignal): Promise<{ readonly kind: 'done' } | { readonly kind: 'uncertain' }>;
}
export interface ApprovalPresenterV1 { reconcile(signal: AbortSignal): Promise<'rendered' | 'idle' | 'uncertain'> }
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
export interface ApprovalOwnerProposalV1 { readonly signal_id: string; readonly action: string; readonly proposed: string }
export interface ApprovalProposalViewV1 { readonly approval_id: string; readonly reviewer: ApprovalActorV1; readonly reviewer_active: boolean; readonly title: string; readonly status: 'pending'|'publishing'|'approved'|'rejected'|'superseded'; readonly decided_on: 'desktop'|'slack'|null; readonly project_ids: readonly string[]; readonly snapshot_sha256: string; readonly snapshot_json: string }
type Core = Pick<{ proposal(id: string): ApprovalProposalViewV1 | undefined; ownerProposals(id: string): readonly ApprovalOwnerProposalV1[] }, 'proposal' | 'ownerProposals'>;
interface Row { approval_id: string; target_json: string; delivery: 'posting'|'posted'|'unrepresentable'|'failed'; message_ts: string|null; card_sha256: string|null; shows: 'open'|'approved'|'rejected'|'superseded'; attempts: number; retry_at: string|null; created_at: string }
const utc = (date: Date) => date.toISOString();
const retry = (now: Date, attempts: number) => new Date(now.getTime() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))).toISOString();
function review(view: ApprovalProposalViewV1) {
  const brief = (JSON.parse(view.snapshot_json) as { approved_payload: { brief: { meeting: { title?: string }; decisions: unknown[]; actions: unknown[]; rationales: unknown[] } } }).approved_payload.brief;
  const item = (signal: any) => ({ text: signal.text, evidence_reference: `Transcript block ${signal.evidence?.[0]?.block_id ?? 'unknown'}` });
  return { schema_version: 1 as const, approval_id: view.approval_id, meeting_title: brief.meeting.title ?? view.title,
    decision_groups: brief.decisions.map((decision: any, index: number) => ({ id: `decision-${index}`, decision: { ...item(decision), status: decision.status }, rationales: brief.rationales.filter((r: any) => r.supports_signal_ids?.includes(decision.id)).map(item) })),
    ...(brief.actions.length === 0 ? {} : { ungrouped_actions: brief.actions.map(item) }),
    ...(brief.rationales.length === 0 ? {} : { ungrouped_rationales: brief.rationales.map(item) }),
  };
}
function targetOf(value: string): SlackApprovalTargetV1 { return JSON.parse(value) as SlackApprovalTargetV1; }

export function createSlackApprovalPresenterV1(options: { readonly database: Database.Database; readonly core: Core; readonly target: (reviewer: ApprovalActorV1) => SlackApprovalTargetV1 | null; readonly poster: SlackApprovalPosterV1; readonly projects: (reviewer: ApprovalActorV1) => readonly { readonly project_id: string; readonly name: string }[]; readonly now?: () => Date }): ApprovalPresenterV1 {
  const now = options.now ?? (() => new Date());
  const rows = () => options.database.prepare(`SELECT approval_id,target_json,delivery,message_ts,card_sha256,shows,attempts,retry_at,created_at FROM authority_approval_presentations_v1 WHERE surface='slack' ORDER BY created_at LIMIT 25`).all() as Row[];
  const insert = options.database.prepare(`INSERT INTO authority_approval_presentations_v1(approval_id,surface,target_json,delivery,message_ts,card_sha256,shows,attempts,retry_at,created_at,updated_at) VALUES(?,'slack',?,'posting',NULL,NULL,'open',0,NULL,?,?)`);
  const posted = options.database.prepare(`UPDATE authority_approval_presentations_v1 SET delivery='posted',message_ts=?,card_sha256=NULL,updated_at=? WHERE approval_id=? AND surface='slack' AND delivery='posting'`);
  const update = options.database.prepare(`UPDATE authority_approval_presentations_v1 SET delivery=?,attempts=?,retry_at=?,updated_at=? WHERE approval_id=? AND surface='slack'`);
  const shown = options.database.prepare(`UPDATE authority_approval_presentations_v1 SET shows=?,card_sha256=?,updated_at=? WHERE approval_id=? AND surface='slack' AND delivery='posted'`);
  const candidates = options.database.prepare(`SELECT o.approval_id FROM authority_live_approval_outbox_v2 o LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id WHERE o.state='staged' AND d.approval_id IS NULL AND NOT EXISTS (SELECT 1 FROM authority_approval_presentations_v1 p WHERE p.approval_id=o.approval_id AND p.surface='slack') ORDER BY o.updated_at LIMIT 25`).pluck();
  const fail = (row: Row, definite = false) => { const time = now(), attempts = row.attempts + 1; update.run(definite && attempts >= 5 ? 'failed' : row.delivery, attempts, retry(time, attempts), utc(time), row.approval_id); };
  const openCard = (view: ApprovalProposalViewV1) => buildSlackApprovalCardV4({ approval_id: view.approval_id, snapshot_sha256: view.snapshot_sha256, review: review(view), projects: options.projects(view.reviewer), suggested_project_ids: view.project_ids, owners: options.core.ownerProposals(view.approval_id) });
  return Object.freeze({ async reconcile(signal: AbortSignal) {
    let changed = false;
    const begun = new Set<string>();
    for (const id of candidates.all() as string[]) {
      const view = options.core.proposal(id); if (!view || !view.reviewer_active || view.status !== 'pending') continue;
      let representable = true;
      try { openCard(view); } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('exceeds Slack limits')) throw error;
        representable = false;
      }
      const resolved = options.target(view.reviewer); if (!resolved) continue;
      const opened = await options.poster.openDirectMessage(resolved.slack_subject_id, signal); if (opened.kind !== 'opened') continue;
      const target = { ...resolved, dm_channel_id: opened.channel_id }; const time = utc(now());
      insert.run(id, canonicalJson(target as unknown as JsonValue), time, time); begun.add(id); changed = true;
      if (!representable) update.run('unrepresentable', 0, null, time, id);
    }
    for (const row of rows()) {
      signal.throwIfAborted(); const view = options.core.proposal(row.approval_id); const target = targetOf(row.target_json);
      if (row.retry_at !== null && new Date(row.retry_at).getTime() > now().getTime()) continue;
      if (row.delivery === 'posting') {
        const outcome = begun.has(row.approval_id)
          ? await options.poster.postMarker({ approval_id: row.approval_id, dm_channel_id: target.dm_channel_id }, signal)
          : await options.poster.reconcileMarker({ approval_id: row.approval_id, dm_channel_id: target.dm_channel_id, post_started_at: row.created_at, reconciliation_started_at: utc(now()) }, signal);
        if (outcome.kind === 'posted') {
          const card = view && view.status === 'pending' ? openCard(view) : buildClosedApprovalCardV4({ title: view?.title ?? 'Meeting', outcome: 'superseded' });
          posted.run(outcome.provider_message_ts, utc(now()), row.approval_id);
          const result = await options.poster.publish({ approval_id: row.approval_id, dm_channel_id: target.dm_channel_id, provider_message_ts: outcome.provider_message_ts, card }, signal);
          if (result.kind === 'done') shown.run(view && view.status === 'pending' ? 'open' : 'superseded', canonicalSha256(card as unknown as JsonValue), utc(now()), row.approval_id);
          else return 'uncertain';
          changed = true;
        }
        else if (outcome.kind === 'uncertain') return 'uncertain'; else fail(row, true);
        continue;
      }
      if (row.delivery !== 'posted' || !view) continue;
      const outcome = view.status === 'superseded' ? 'superseded' : view.status === 'rejected' ? 'rejected' : view.status === 'pending' || view.status === 'publishing' ? 'open' : 'approved';
      if (outcome === row.shows && row.card_sha256 !== null) continue;
      const card = outcome === 'open' ? openCard(view) : buildClosedApprovalCardV4({ title: view.title, outcome, ...(outcome === 'superseded' ? {} : { surface: view.decided_on ?? 'desktop', audience_label: view.project_ids.length === 0 ? 'Only me' : 'Projects' }) });
      const result = await options.poster.publish({ approval_id: row.approval_id, dm_channel_id: target.dm_channel_id, provider_message_ts: row.message_ts!, card }, signal);
      if (result.kind === 'done') { shown.run(outcome, canonicalSha256(card as unknown as JsonValue), utc(now()), row.approval_id); changed = true; } else return 'uncertain';
    }
    return changed ? 'rendered' : 'idle';
  }});
}
