import Database from "better-sqlite3";
import { annotateCoreRuntimeV1, coreRuntimeIdentityV1, observeCoreRuntimeSyncV1, observeCoreRuntimeV1, type CoreRuntimeDetailV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { canonicalJson, canonicalSha256, type JsonValue } from "@echo-brain/federation-protocol";
import type { SlackBotTokenSourceV1 } from "../organization-control-plane/application/slack-bot-token-source-v1.js";
import type { StoredSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { PrivateSlackApprovalCardPosterV1 } from "../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";
import type { PrivateSlackApprovalBlockKitCardInputV1 } from "./private-slack-approval-block-kit-card-v1.js";
import { buildClosedApprovalCardV4, buildSlackApprovalCardV4, type SlackApprovalCardV4 } from "./slack-approval-card-v4.js";

export interface SlackApprovalTargetV1 {
  readonly connection_id: string;
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: string;
  readonly slack_workspace_id: string;
  readonly slack_subject_id: string;
  readonly api_app_id: string;
}

export interface SlackApprovalPosterV1 {
  openDirectMessage(subjectId: string, signal?: AbortSignal): Promise<{ kind: "opened"; channel_id: string } | { kind: "retry_allowed" }>;
  postMarker(input: { approval_id: string; dm_channel_id: string }, signal?: AbortSignal): Promise<{ kind: "posted"; provider_message_ts: string } | { kind: "retry_allowed" } | { kind: "uncertain" }>;
  reconcileMarker(input: { approval_id: string; dm_channel_id: string; post_started_at: string; reconciliation_started_at: string }, signal?: AbortSignal): Promise<{ kind: "posted"; provider_message_ts: string } | { kind: "retry_allowed" } | { kind: "uncertain" }>;
  publish(input: { approval_id: string; dm_channel_id: string; provider_message_ts: string; card: SlackApprovalCardV4 }, signal?: AbortSignal): Promise<{ kind: "done" } | { kind: "uncertain" }>;
}

function matchesTarget(connection: StoredSlackConnectionV1, target: SlackApprovalTargetV1): boolean {
  return connection.connection.connection_id === target.connection_id &&
    connection.connection.provider_tenant_id === target.slack_workspace_id &&
    connection.connection.provider_app_id === target.api_app_id;
}

/**
 * Binds a Slack credential lookup to the exact durable presentation target.
 * The second check is deliberately after the asynchronous Nango token read:
 * a reconnect must not let a previously selected DM use a new connection.
 */
export function createTargetBoundSlackApprovalPosterV1(input: {
  readonly target: SlackApprovalTargetV1;
  readonly activeConnection: () => StoredSlackConnectionV1 | undefined;
  readonly targetCurrent: (target: SlackApprovalTargetV1) => boolean;
  readonly botToken: SlackBotTokenSourceV1;
  readonly needsReinstall: (connection: StoredSlackConnectionV1) => boolean;
  readonly markNeedsReinstall: (connection: StoredSlackConnectionV1) => void;
  readonly fetchImpl?: typeof fetch;
}): SlackApprovalPosterV1 {
  const requireBoundConnection = (): StoredSlackConnectionV1 => {
    const connection = input.activeConnection();
    if (connection === undefined || !matchesTarget(connection, input.target) || !input.targetCurrent(input.target)) {
      throw new Error("Slack approval target is no longer current");
    }
    return connection;
  };
  return new PrivateSlackApprovalCardPosterV1(async tokenOptions => {
    const selected = requireBoundConnection();
    const token = await input.botToken.botToken(selected, tokenOptions);
    const current = input.activeConnection();
    if (current === undefined || current.state_sha256 !== selected.state_sha256 || !matchesTarget(current, input.target) || !input.targetCurrent(input.target)) {
      throw new Error("Slack approval target changed during token selection");
    }
    return token;
  }, {
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    needs_reinstall: () => {
      const connection = input.activeConnection();
      return connection !== undefined && matchesTarget(connection, input.target) && input.needsReinstall(connection);
    },
    on_auth_failure: () => {
      const connection = input.activeConnection();
      if (connection !== undefined && matchesTarget(connection, input.target) && input.targetCurrent(input.target)) input.markNeedsReinstall(connection);
    },
  });
}

export interface ApprovalPresenterV1 { reconcile(signal: AbortSignal): Promise<"rendered" | "idle" | "uncertain"> }
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
export interface ApprovalOwnerProposalV1 { readonly signal_id: string; readonly action: string; readonly proposed: string }
export interface ApprovalProposalViewV1 {
  readonly approval_id: string;
  readonly reviewer: ApprovalActorV1;
  readonly reviewer_active: boolean;
  readonly title: string;
  readonly status: "pending" | "publishing" | "approved" | "rejected" | "superseded";
  readonly decided_on: "desktop" | "slack" | null;
  readonly project_ids: readonly string[];
  readonly snapshot_sha256: string;
  readonly snapshot_json: string;
}

type ApprovalCoreV1 = Pick<{ proposal(id: string): ApprovalProposalViewV1 | undefined; ownerProposals(id: string): readonly ApprovalOwnerProposalV1[] }, "proposal" | "ownerProposals">;
type Delivery = "opening" | "posting" | "posted" | "unrepresentable" | "failed";
type MarkerState = "not_started" | "in_flight";
type PresentationRow = {
  readonly approval_id: string;
  readonly target_json: string;
  readonly dm_channel_id: string | null;
  readonly delivery: Delivery;
  readonly marker_state: MarkerState | null;
  readonly marker_started_at: string | null;
  readonly message_ts: string | null;
  readonly card_sha256: string | null;
  readonly shows: "open" | "approved" | "rejected" | "superseded";
  readonly attempts: number;
  readonly retry_at: string | null;
  readonly created_at: string;
};

const MAX_ATTEMPTS = 5;
const asIso = (value: Date): string => value.toISOString();
const nextRetryAt = (now: Date, attempts: number): string => new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** attempts)).toISOString();

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`approval snapshot ${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`approval snapshot ${label} must be an array`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`approval snapshot ${label} must be text`);
  return value;
}
function reviewItem(value: unknown) {
  const item = record(value, "review item");
  const evidence = item.evidence === undefined ? [] : list(item.evidence, "review item evidence");
  const firstEvidence = evidence[0] === undefined ? undefined : record(evidence[0], "review evidence");
  return {
    text: text(item.text, "review item text"),
    evidence_reference: `Transcript block ${firstEvidence === undefined ? "unknown" : text(firstEvidence.block_id, "review evidence block_id")}`,
  };
}
function decisionStatus(value: unknown): "proposed" | "decided" | "unresolved" {
  return value === "proposed" || value === "decided" || value === "unresolved" ? value : "unresolved";
}
function reviewFromSnapshot(proposal: ApprovalProposalViewV1): PrivateSlackApprovalBlockKitCardInputV1 {
  const root = record(JSON.parse(proposal.snapshot_json), "root");
  const approvedPayload = record(root.approved_payload, "approved_payload");
  const brief = record(approvedPayload.brief, "brief");
  const meeting = record(brief.meeting, "meeting");
  const decisions = list(brief.decisions, "decisions");
  const actions = list(brief.actions, "actions");
  const rationales = list(brief.rationales, "rationales");
  const rationaleFor = (decisionId: string) => rationales.filter((rationale) => {
    const supports = record(rationale, "rationale").supports_signal_ids;
    const links = supports === undefined ? [] : list(supports, "rationale supports_signal_ids");
    return links.includes(decisionId);
  }).map(reviewItem);
  const groups = decisions.map((decision, index) => {
    const value = record(decision, "decision");
    const id = text(value.id, "decision id");
    return { id: `decision-${index}`, decision: { ...reviewItem(value), status: decisionStatus(value.status) }, rationales: rationaleFor(id) };
  });
  return {
    schema_version: 1,
    approval_id: proposal.approval_id,
    meeting_title: typeof meeting.title === "string" ? meeting.title : proposal.title,
    decision_groups: groups,
    ...(actions.length === 0 ? {} : { ungrouped_actions: actions.map(reviewItem) }),
    ...(rationales.length === 0 ? {} : { ungrouped_rationales: rationales.map(reviewItem) }),
  };
}

export function createSlackApprovalPresenterV1(options: {
  readonly database: Database.Database;
  readonly core: ApprovalCoreV1;
  readonly target: (reviewer: ApprovalActorV1) => SlackApprovalTargetV1 | null;
  readonly targetCurrent: (target: SlackApprovalTargetV1) => boolean;
  readonly poster: (target: SlackApprovalTargetV1) => SlackApprovalPosterV1;
  readonly projects: (reviewer: ApprovalActorV1) => readonly { project_id: string; name: string }[];
  readonly now?: () => Date;
}): ApprovalPresenterV1 {
  const now = options.now ?? (() => new Date());
  const database = options.database;
  const actionableRows = database.prepare(`
    SELECT p.approval_id,p.target_json,p.dm_channel_id,p.delivery,p.marker_state,p.marker_started_at,p.message_ts,p.card_sha256,p.shows,p.attempts,p.retry_at,p.created_at
    FROM authority_approval_presentations_v1 p
    JOIN authority_live_approval_outbox_v2 o ON o.approval_id=p.approval_id
    LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=p.approval_id
    WHERE p.surface='slack' AND (p.retry_at IS NULL OR p.retry_at<=?) AND (
      p.delivery IN ('opening','posting') OR
      (p.delivery='posted' AND (
        p.card_sha256 IS NULL OR
        (p.shows='open' AND (o.state='superseded' OR d.approval_id IS NOT NULL)) OR
        (p.shows='approved' AND (o.state='superseded' OR d.action='reject')) OR
        (p.shows='rejected' AND o.state='superseded')
      ))
    )
    ORDER BY CASE p.delivery WHEN 'opening' THEN 0 WHEN 'posting' THEN 1 ELSE 2 END,p.created_at LIMIT 25
  `);
  const candidateIds = database.prepare(`
    SELECT o.approval_id FROM authority_live_approval_outbox_v2 o
    LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id
    WHERE o.state='staged' AND d.approval_id IS NULL AND NOT EXISTS(
      SELECT 1 FROM authority_approval_presentations_v1 p WHERE p.approval_id=o.approval_id AND p.surface='slack'
    ) ORDER BY o.updated_at
  `).pluck();
  const claim = database.prepare(`INSERT INTO authority_approval_presentations_v1
    (approval_id,surface,target_json,dm_channel_id,delivery,marker_state,marker_started_at,message_ts,card_sha256,shows,attempts,retry_at,created_at,updated_at)
    VALUES (?,'slack',?,NULL,'opening',NULL,NULL,NULL,NULL,'open',0,NULL,?,?) ON CONFLICT(approval_id,surface) DO NOTHING`);
  const persistChannel = database.prepare(`UPDATE authority_approval_presentations_v1
    SET dm_channel_id=?,delivery='posting',marker_state='not_started',marker_started_at=NULL,updated_at=?
    WHERE approval_id=? AND surface='slack' AND delivery='opening' AND dm_channel_id IS NULL`);
  // A reserved DM is not a Slack presentation until its first marker claim has
  // begun. If the proposal closes before that point, retain the immutable DM
  // reservation but make the row terminal without creating a terminal-only card.
  const finishUnposted = database.prepare(`UPDATE authority_approval_presentations_v1
    SET dm_channel_id=COALESCE(dm_channel_id,?),delivery='unrepresentable',marker_state=NULL,marker_started_at=NULL,retry_at=NULL,updated_at=?
    WHERE approval_id=? AND surface='slack' AND (
      (delivery='opening' AND dm_channel_id IS NULL) OR
      (delivery='posting' AND marker_state='not_started')
    )`);
  const beginMarker = database.prepare(`UPDATE authority_approval_presentations_v1
    SET marker_state='in_flight',marker_started_at=?,updated_at=?
    WHERE approval_id=? AND surface='slack' AND delivery='posting' AND marker_state='not_started'`);
  const resetMarker = database.prepare(`UPDATE authority_approval_presentations_v1
    SET marker_state='not_started',marker_started_at=NULL,updated_at=?
    WHERE approval_id=? AND surface='slack' AND delivery='posting' AND marker_state='in_flight'`);
  const persistMarker = database.prepare(`UPDATE authority_approval_presentations_v1
    SET delivery='posted',marker_state=NULL,marker_started_at=NULL,message_ts=?,updated_at=?
    WHERE approval_id=? AND surface='slack' AND delivery='posting' AND marker_state='in_flight'`);
  const persistCard = database.prepare(`UPDATE authority_approval_presentations_v1
    SET shows=?,card_sha256=?,retry_at=NULL,updated_at=? WHERE approval_id=? AND surface='slack' AND delivery='posted'`);
  const unrepresentable = database.prepare(`UPDATE authority_approval_presentations_v1
    SET delivery='unrepresentable',updated_at=? WHERE approval_id=? AND surface='slack' AND delivery='opening'`);
  const backoffUpdate = database.prepare(`UPDATE authority_approval_presentations_v1
    SET delivery=CASE WHEN ?>=? THEN 'failed' ELSE delivery END,attempts=?,retry_at=?,updated_at=?
    WHERE approval_id=? AND surface='slack'`);
  const backoff = (row: PresentationRow, terminal = false) => {
    const attempts = terminal ? MAX_ATTEMPTS : row.attempts + 1;
    const at = now();
    observeCoreRuntimeSyncV1("approval_delivery", () => {
      backoffUpdate.run(attempts, MAX_ATTEMPTS, attempts, attempts >= MAX_ATTEMPTS ? null : nextRetryAt(at, attempts), asIso(at), row.approval_id);
      annotateCoreRuntimeV1({ approval_surface: "slack", attempt: attempts, result: attempts >= MAX_ATTEMPTS ? "failed" : "retry_pending" });
    }, { correlation: { approval_id: coreRuntimeIdentityV1("approval", row.approval_id) } });
  };
  const cannotRepresent = (row: PresentationRow) => observeCoreRuntimeSyncV1("approval_delivery", () => {
    unrepresentable.run(asIso(now()), row.approval_id);
    annotateCoreRuntimeV1({ approval_surface: "slack", result: "unrepresentable" });
  }, { correlation: { approval_id: coreRuntimeIdentityV1("approval", row.approval_id) } });
  const card = (proposal: ApprovalProposalViewV1): SlackApprovalCardV4 => buildSlackApprovalCardV4({
    approval_id: proposal.approval_id,
    snapshot_sha256: proposal.snapshot_sha256,
    review: reviewFromSnapshot(proposal),
    projects: options.projects(proposal.reviewer),
    suggested_project_ids: proposal.project_ids,
    owners: options.core.ownerProposals(proposal.approval_id),
  });
  const outcome = (proposal: ApprovalProposalViewV1): PresentationRow["shows"] => {
    if (proposal.status === "superseded") return "superseded";
    if (proposal.status === "rejected") return "rejected";
    return proposal.status === "pending" ? "open" : "approved";
  };
  const pendingActive = (proposal: ApprovalProposalViewV1 | undefined): proposal is ApprovalProposalViewV1 => proposal !== undefined && proposal.reviewer_active && proposal.status === "pending";
  const isAborted = (signal: AbortSignal) => signal.aborted;
  const provider = (target: SlackApprovalTargetV1): SlackApprovalPosterV1 => options.poster(target);

  // Only actual delivery attempts emit spans; idle reconciliation and polling stay quiet.
  const deliver = <T extends { kind: string }>(row: PresentationRow,
    step: NonNullable<CoreRuntimeDetailV1["delivery_step"]>, call: () => Promise<T>): Promise<T> => observeCoreRuntimeV1("approval_delivery", async () => {
      annotateCoreRuntimeV1({ approval_surface: "slack", delivery_step: step, attempt: row.attempts + 1 });
      const result = await call();
      annotateCoreRuntimeV1({ result: result.kind === "uncertain" ? "uncertain"
        : result.kind === "retry_allowed" ? "retry_pending" : result.kind === "done" ? "done" : "completed" });
      return result;
    }, { correlation: { approval_id: coreRuntimeIdentityV1("approval", row.approval_id) } });

  return Object.freeze({
    async reconcile(signal: AbortSignal): Promise<"rendered" | "idle" | "uncertain"> {
      let changed = false;
      let uncertain = false;
      // Target resolution is local control-plane work. Scan rowless candidates
      // completely so permanently unlinked reviewers cannot occupy a page;
      // actual Slack calls remain bounded by actionableRows' 25-row limit.
      for (const approvalId of candidateIds.all() as string[]) {
        const proposal = options.core.proposal(approvalId);
        const target = proposal !== undefined && proposal.reviewer_active && proposal.status === "pending" ? options.target(proposal.reviewer) : null;
        if (target === null) continue;
        const timestamp = asIso(now());
        if (claim.run(approvalId, canonicalJson(target as unknown as JsonValue), timestamp, timestamp).changes === 1) changed = true;
      }
      for (const row of actionableRows.all(asIso(now())) as PresentationRow[]) {
        const target = JSON.parse(row.target_json) as SlackApprovalTargetV1;
        if (!options.targetCurrent(target)) { backoff(row, true); continue; }
        const proposal = options.core.proposal(row.approval_id);
        if (row.delivery === "opening") {
          if (!pendingActive(proposal)) { unrepresentable.run(asIso(now()), row.approval_id); changed = true; continue; }
          // Any card-build failure is this row's problem; it must not stall the rows after it.
          try { card(proposal); } catch {
            cannotRepresent(row); changed = true; continue;
          }
          try {
            const opened = await deliver(row, "open_dm", () => provider(target).openDirectMessage(target.slack_subject_id, signal));
            if (!options.targetCurrent(target) || opened.kind !== "opened") { backoff(row); continue; }
            if (!pendingActive(options.core.proposal(row.approval_id))) {
              if (finishUnposted.run(opened.channel_id, asIso(now()), row.approval_id).changes === 1) changed = true;
              continue;
            }
            if (persistChannel.run(opened.channel_id, asIso(now()), row.approval_id).changes === 1) changed = true;
          } catch (error) {
            if (isAborted(signal)) throw error;
            backoff(row);
          }
          continue;
        }
        if (row.delivery === "posting") {
          if (row.dm_channel_id === null || row.marker_state === null) throw new Error("posting presentation has incomplete marker state");
          if (row.marker_state === "not_started") {
            // There is no await between this read and beginMarker. Once the
            // claim is durable, recovery must preserve at-most-one marker.
            if (!pendingActive(options.core.proposal(row.approval_id))) {
              if (finishUnposted.run(row.dm_channel_id, asIso(now()), row.approval_id).changes === 1) changed = true;
              continue;
            }
            const markerStartedAt = asIso(now());
            if (beginMarker.run(markerStartedAt, markerStartedAt, row.approval_id).changes !== 1) continue;
            const inFlight = { ...row, marker_state: "in_flight" as const, marker_started_at: markerStartedAt };
            try {
              const posted = await deliver(row, "post_marker", () => provider(target).postMarker({ approval_id: row.approval_id, dm_channel_id: row.dm_channel_id! }, signal));
              if (!options.targetCurrent(target)) { backoff(inFlight); uncertain = true; continue; }
              if (posted.kind === "posted") {
                if (persistMarker.run(posted.provider_message_ts, asIso(now()), row.approval_id).changes !== 1) { uncertain = true; continue; }
              } else if (posted.kind === "retry_allowed") {
                resetMarker.run(asIso(now()), row.approval_id); backoff(inFlight);
                continue;
              } else { backoff(inFlight); uncertain = true; continue; }
            } catch (error) {
              if (isAborted(signal)) throw error;
              backoff(inFlight); uncertain = true; continue;
            }
          } else {
            try {
              if (row.marker_started_at === null) throw new Error("in-flight marker has no durable start time");
              const reconciled = await deliver(row, "reconcile_marker", () => provider(target).reconcileMarker({ approval_id: row.approval_id, dm_channel_id: row.dm_channel_id!, post_started_at: row.marker_started_at!, reconciliation_started_at: asIso(now()) }, signal));
              if (!options.targetCurrent(target)) { backoff(row); uncertain = true; continue; }
              if (reconciled.kind === "posted") {
                if (persistMarker.run(reconciled.provider_message_ts, asIso(now()), row.approval_id).changes !== 1) { uncertain = true; continue; }
              } else if (reconciled.kind === "retry_allowed") {
                resetMarker.run(asIso(now()), row.approval_id); backoff(row);
                continue;
              } else { backoff(row); uncertain = true; continue; }
            } catch (error) {
              if (isAborted(signal)) throw error;
              backoff(row); uncertain = true; continue;
            }
          }
          const liveProposal = options.core.proposal(row.approval_id);
          const shows = liveProposal === undefined ? "superseded" : outcome(liveProposal);
          const message = database.prepare("SELECT dm_channel_id,message_ts FROM authority_approval_presentations_v1 WHERE approval_id=? AND surface='slack'").get(row.approval_id) as { dm_channel_id: string; message_ts: string };
          try {
            // Built inside the try: a card that cannot be built backs this row off instead of stalling the others.
            const publishedCard = shows === "open" ? card(liveProposal!) : buildClosedApprovalCardV4({ title: liveProposal?.title ?? "Meeting", outcome: shows, surface: liveProposal?.decided_on ?? "desktop", audience_label: liveProposal?.project_ids.length ? "Projects" : "Only me" });
            const published = await deliver(row, "publish_card", () => provider(target).publish({ approval_id: row.approval_id, dm_channel_id: message.dm_channel_id, provider_message_ts: message.message_ts, card: publishedCard }, signal));
            if (!options.targetCurrent(target) || published.kind !== "done") { backoff(row); uncertain = true; continue; }
            persistCard.run(shows, canonicalSha256(publishedCard as unknown as JsonValue), asIso(now()), row.approval_id); changed = true;
          } catch (error) {
            if (isAborted(signal)) throw error;
            backoff(row); uncertain = true;
          }
          continue;
        }
        if (row.delivery !== "posted" || proposal === undefined || row.dm_channel_id === null || row.message_ts === null) continue;
        const shows = outcome(proposal);
        if (shows === row.shows && row.card_sha256 !== null) continue;
        try {
          const redraw = shows === "open" ? card(proposal) : buildClosedApprovalCardV4({ title: proposal.title, outcome: shows, surface: proposal.decided_on ?? "desktop", audience_label: proposal.project_ids.length ? "Projects" : "Only me" });
          const published = await deliver(row, "publish_card", () => provider(target).publish({ approval_id: row.approval_id, dm_channel_id: row.dm_channel_id!, provider_message_ts: row.message_ts!, card: redraw }, signal));
          if (!options.targetCurrent(target) || published.kind !== "done") { backoff(row); uncertain = true; continue; }
          persistCard.run(shows, canonicalSha256(redraw as unknown as JsonValue), asIso(now()), row.approval_id); changed = true;
        } catch (error) {
          if (isAborted(signal)) throw error;
          backoff(row); uncertain = true;
        }
      }
      return uncertain ? "uncertain" : changed ? "rendered" : "idle";
    },
  });
}
