import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_SNAPSHOT_SURFACE_V1, isApprovalOwnerTextV1, isApprovalSignalIdV1, APPROVAL_OWNERS_MAX_V1, type MeetingApprovalTranscriptSourceV2,
} from '@echo-brain/organization-protocol';
import { validateApprovedDecisionSnapshotV2 } from '@echo-brain/organization-protocol/record-codec-support-v4';
import { validateProjectIdV1 } from '@echo-brain/organization-api';
import type { DecisionBrief, DecisionSet, MeetingDocument } from '@echo-brain/organization-processing/core';
import type { ApprovalWorkflowContextV1, ApprovalWorkflowProcessingV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import type { ApprovalWorkflowStageInputV1, ApprovalWorkflowStageResultV1, ApprovalWorkflowStagerV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1';
import { compileDecisionBrief } from '@echo-brain/organization-processing/core/processing/brief';
import { ownerProposalsV1, withoutProposedOwnersV1 } from '@echo-brain/organization-processing/core/processing/owner-proposals-v1';
import { retainedMeetingSourceCoordinateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createApprovalPublisherV1, type AfterApprovedRecordHookV1 } from './approval-publisher-v1.js';
export {
  approvalDecisionReceiptJsonV1, APPROVAL_DECISION_RECORD_SHA256_PATH_V1, createApprovalPublisherV1,
  type ApprovalDecisionReceiptV1, type AfterApprovedRecordEventV1, type AfterApprovedRecordHookV1,
} from './approval-publisher-v1.js';

/** approved_payload.surface of every snapshot the core freezes, whichever screen draws it (the approval-decision codec checks it). */
export const APPROVAL_SNAPSHOT_SURFACE_V1 = APPROVAL_DECISION_SNAPSHOT_SURFACE_V1;
/** At most this many projects share one approved meeting; also the cap on frozen suggestions. */
export const APPROVAL_PROJECTS_MAX_V1 = 20;

export type ApprovalSurfaceV1 = 'desktop' | 'slack';
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
export interface ApprovalOwnerChoiceV1 { readonly signal_id: string; readonly owner: string }
export interface ApprovalDecisionRequestV1 {
  readonly approval_id: string;
  /** /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/. Desktop: never `slack:`-prefixed. Slack: `slack:` + verified click key. */
  readonly command_id: string;
  readonly snapshot_sha256: Sha256Digest;
  readonly action: 'approve' | 'reject';
  /** [] = Only me; otherwise 1..20 project ids, strictly ascending (sorted, unique). */
  readonly project_ids: readonly string[];
  readonly share_transcript: boolean;
  /** Confirmed owners of proposed actions, in brief (proposal) order, each signal at most once. */
  readonly owners: readonly ApprovalOwnerChoiceV1[];
}
export interface ApprovalAuthorizationV1 {
  readonly actor: ApprovalActorV1;
  /** Digest of the evidence that authorized this decision: the person session, or the verified Slack click and link.
   *  `person-session` only with surface desktop; `slack-click` only with surface slack. */
  readonly evidence: { readonly kind: 'person-session' | 'slack-click'; readonly sha256: Sha256Digest };
}
export type ApprovalStatusV1 = 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded';
export type ApprovalDecideResultV1 =
  | { readonly kind: 'decided'; readonly status: 'publishing' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'replayed'; readonly status: 'publishing' | 'approved' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'already_decided'; readonly status: 'publishing' | 'approved' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'stale' };
export interface ApprovalOwnerProposalV1 { readonly signal_id: string; readonly action: string; readonly proposed: string }
/** An unauthenticated read: every caller compares `reviewer` with its authenticated person before showing it.
 *  Only frozen proposals are returned. */
export interface ApprovalProposalViewV1 {
  readonly approval_id: string;
  readonly reviewer: ApprovalActorV1;
  /** False once the reviewer's membership is no longer active: nobody can decide it and presenters must not offer it. */
  readonly reviewer_active: boolean;
  /** Meeting title or 'Untitled meeting', at most 256 code units. */
  readonly title: string;
  readonly status: ApprovalStatusV1;
  readonly decided_on: ApprovalSurfaceV1 | null;
  /** The decision body's decided_at. */
  readonly decided_at: string | null;
  /** Decided: the decision's project_ids verbatim (reject: []). Undecided (pending or superseded): the frozen
   *  suggestions filtered to projects the reviewer can read now (active project, active membership). */
  readonly project_ids: readonly string[];
  readonly snapshot_sha256: Sha256Digest;
  readonly snapshot_json: string;
}
/** Exact canonical JSON stored in authority_approval_decisions_v1.body_json; Task 8's publisher reads it. */
export interface ApprovalDecisionBodyV1 {
  readonly request: ApprovalDecisionRequestV1;
  readonly surface: ApprovalSurfaceV1;
  readonly actor: ApprovalActorV1;
  readonly evidence: ApprovalAuthorizationV1['evidence'];
  /** The retained source coordinate of the reviewed meeting, frozen at decide so publishing reads nothing mutable;
   *  non-null exactly for an approval. */
  readonly transcript_source: MeetingApprovalTranscriptSourceV2 | null;
  /** Canonical UTC milliseconds. */
  readonly decided_at: string;
}

/**
 * Static, core-independent options. `presenters` are factories, where
 * `ApprovalPresenterFactoryV1 = (core: Pick<ApprovalCoreV1, 'proposal' | 'ownerProposals'>) => ApprovalPresenterV1`;
 * createApprovalCoreV1 calls each factory once with its own frozen core object. A presenter is never passed as an instance.
 */
export interface ApprovalCoreOptionsV1 {
  /** Project ids to freeze as one meeting's suggestions: the meeting's recorded suggestions plus its still-pending import
   *  choices for projects the person is still a member of (the runtime wires SqlitePersonMeetingIntakeV1.proposalSuggestions).
   *  A frozen suggestion is a pre-tick only and never grants read access. */
  readonly suggestions: (sourceKey: string, externalId: string) => readonly string[];
  /** Synchronous and read-only; may run inside the decide transaction. Throws AuthorityOperationError('unauthorized')
   *  unless every project is active and the actor an active member of it. */
  readonly projects: (actor: ApprovalActorV1, projectIds: readonly string[]) => void;
  /** Test seam for decided_at; must return canonical UTC milliseconds. */
  readonly now?: () => string;
  /** Run inside the receipt transaction only when that transaction's UPDATE changed one row; synchronous functions only
   *  (async functions are refused at creation); Authority rows only. */
  readonly after_record?: readonly AfterApprovedRecordHookV1[];
  /** Optional delivery-only surfaces. Factories receive only safe read views of this core. */
  readonly presenters?: readonly ApprovalPresenterFactoryV1[];
}
export interface ApprovalPresenterV1 {
  reconcile(signal: AbortSignal): Promise<'rendered' | 'idle' | 'uncertain'>;
}
export type ApprovalPresenterFactoryV1 = (core: Pick<ApprovalCoreV1, 'proposal' | 'ownerProposals'>) => ApprovalPresenterV1;
export interface ApprovalCoreV1 {
  /** Runtime-wide stager: stage = freeze; reconcilePendingDeliveries re-freezes queued heads of every configured source
   *  (limit 25). */
  readonly stager: ApprovalWorkflowStagerV1;
  /** Same stager, but its reconcilePendingDeliveries only touches one source, so one person's broken proposal never fails
   *  another person's intake cycle. The runtime's lanes use this. */
  stagerForSource(sourceKey: string): ApprovalWorkflowStagerV1;
  /** The publisher (approval-publisher-v1.ts) with this core's after_record hooks. observeAndFinalizePendingApprovals is a no-op;
   *  reconcileApprovalPresentations runs each presenter in turn, and is undefined when there are none. */
  readonly processing: ApprovalWorkflowProcessingV1;
  decide(surface: ApprovalSurfaceV1, request: ApprovalDecisionRequestV1, authorize: () => ApprovalAuthorizationV1): ApprovalDecideResultV1;
  proposal(approvalId: string): ApprovalProposalViewV1 | undefined;
  /** Caller has authenticated `reviewer`. Undecided staged first, then newest; limit defaults to 100, clamped to 1..100. */
  proposals(reviewer: ApprovalActorV1, limit?: number): readonly ApprovalProposalViewV1[];
  /** From ownerProposalsV1 over the candidate's uncleared brief, in brief order; [] for an unknown approval or when more
   *  than 40 are grounded; proposals whose signal id fails isApprovalSignalIdV1 are left out. */
  ownerProposals(approvalId: string): readonly ApprovalOwnerProposalV1[];
}

const APPROVAL_ID = /^apr_[0-9a-f]{64}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLACK_COMMAND_ID = /^slack:[A-Za-z0-9._:-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REQUEST_KEYS = ['action', 'approval_id', 'command_id', 'owners', 'project_ids', 'share_transcript', 'snapshot_sha256'];

function denied(): never { throw new AuthorityOperationError('unauthorized', 'Meeting review is not available'); }
function invalid(message = 'Invalid meeting review'): never { throw new AuthorityOperationError('invalid_request', message); }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

/** Static, database-free validation shared by decide(), Task 9's v2 route and Task 12's click parser.
 *  Returns a fresh frozen request with exactly the 7 keys; throws AuthorityOperationError('invalid_request', 'Invalid meeting review'). */
export function validateApprovalDecisionRequestV1(surface: ApprovalSurfaceV1, value: unknown): ApprovalDecisionRequestV1 {
  if (surface !== 'desktop' && surface !== 'slack') invalid();
  if (!plain(value) || !hasExactKeys(value, REQUEST_KEYS)) invalid();
  const { approval_id, command_id, snapshot_sha256, action, project_ids, share_transcript, owners } = value;
  if (typeof approval_id !== 'string' || !APPROVAL_ID.test(approval_id)) invalid();
  if (typeof command_id !== 'string' || !COMMAND_ID.test(command_id)) invalid();
  if (surface === 'slack' ? !SLACK_COMMAND_ID.test(command_id) : command_id.startsWith('slack:')) invalid();
  if (typeof snapshot_sha256 !== 'string' || !DIGEST.test(snapshot_sha256)) invalid();
  if (action !== 'approve' && action !== 'reject') invalid();
  if (!Array.isArray(project_ids) || project_ids.length > APPROVAL_PROJECTS_MAX_V1) invalid();
  const projects = project_ids.map((id: unknown) => {
    try { return validateProjectIdV1(id); } catch { return invalid(); }
  });
  if (projects.some((id, index) => index > 0 && projects[index - 1]! >= id)) invalid();
  if (typeof share_transcript !== 'boolean') invalid();
  if (!Array.isArray(owners) || owners.length > APPROVAL_OWNERS_MAX_V1) invalid();
  const chosen = owners.map((owner: unknown) => {
    if (!plain(owner) || !hasExactKeys(owner, ['owner', 'signal_id']) || !isApprovalSignalIdV1(owner.signal_id) || !isApprovalOwnerTextV1(owner.owner)) invalid();
    return Object.freeze({ signal_id: owner.signal_id, owner: owner.owner });
  });
  if (new Set(chosen.map(owner => owner.signal_id)).size !== chosen.length) invalid();
  if (action === 'reject' && (projects.length > 0 || share_transcript || chosen.length > 0)) invalid();
  return Object.freeze({ approval_id, command_id, snapshot_sha256: snapshot_sha256 as Sha256Digest, action, project_ids: Object.freeze(projects),
    share_transcript, owners: Object.freeze(chosen) });
}

function checkAuthorization(surface: ApprovalSurfaceV1, organizationId: string, value: unknown): ApprovalAuthorizationV1 {
  if (!plain(value) || !hasExactKeys(value, ['actor', 'evidence'])) denied();
  const { actor, evidence } = value;
  if (!plain(actor) || !hasExactKeys(actor, ['membership_id', 'organization_id', 'principal_id'])) denied();
  if (!plain(evidence) || !hasExactKeys(evidence, ['kind', 'sha256'])) denied();
  for (const id of [actor.organization_id, actor.principal_id, actor.membership_id]) if (typeof id !== 'string' || !IDENTIFIER.test(id)) denied();
  if (evidence.kind !== (surface === 'desktop' ? 'person-session' : 'slack-click')) denied();
  if (typeof evidence.sha256 !== 'string' || !DIGEST.test(evidence.sha256)) denied();
  if (actor.organization_id !== organizationId) denied();
  return Object.freeze({
    actor: Object.freeze({ organization_id: actor.organization_id as string, principal_id: actor.principal_id as string, membership_id: actor.membership_id as string }),
    evidence: Object.freeze({ kind: evidence.kind as ApprovalAuthorizationV1['evidence']['kind'], sha256: evidence.sha256 as Sha256Digest }),
  });
}

/** personMeetingReviewTextV1 moved; identical except an action prints `  Due: <due_at | Not specified>` and never an owner. */
export function approvalProposalTextV1(snapshotJson: string): string {
  const brief = (JSON.parse(snapshotJson) as { approved_payload: { brief: DecisionBrief } }).approved_payload.brief;
  const lines = [brief.meeting.title ?? 'Meeting', ...Object.entries(brief.meeting.time ?? {}).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`),
    ...brief.meeting.participants.map(person => `Participant: ${person.display_name ?? person.id}`)];
  for (const [name, signals] of [['Decisions', brief.decisions], ['Actions', brief.actions], ['Rationales', brief.rationales]] as const) {
    lines.push('', name);
    if (signals.length === 0) lines.push('None');
    for (const signal of signals) {
      lines.push(`• ${signal.text}`);
      if (signal.subject) lines.push(`  Subject: ${signal.subject}`);
      if ('status' in signal) lines.push(`  Status: ${signal.status}`);
      if ('due_at' in signal) lines.push(`  Due: ${signal.due_at ?? 'Not specified'}`);
      for (const span of signal.evidence) if (span.quote) lines.push(`  From the meeting: “${span.quote}”`);
    }
  }
  return lines.join('\n');
}

/** What a Home row shows of a proposal: its first decision (else first action) on one line, how many actions it has, and when the meeting started.
 *  The line collapses whitespace and control characters and keeps at most 300 characters, never half of one. */
export function approvalProposalSummaryV1(snapshotJson: string): { readonly first_line: string | null; readonly action_count: number; readonly meeting_at: string | null } {
  const brief = (JSON.parse(snapshotJson) as { approved_payload: { brief: DecisionBrief } }).approved_payload.brief;
  const line = (brief.decisions[0]?.text ?? brief.actions[0]?.text)?.replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, 300).replace(/[\uD800-\uDBFF]$/, '');
  const time = brief.meeting.time, started = new Date(time?.actual_start_at ?? time?.scheduled_start_at ?? NaN);
  return { first_line: line || null, action_count: brief.actions.length, meeting_at: Number.isNaN(started.getTime()) ? null : started.toISOString() };
}

interface ProposalRow {
  readonly approval_id: string; readonly candidate_id: string; readonly state: 'queued' | 'staged' | 'superseded';
  readonly approved_snapshot_sha256: Sha256Digest | null; readonly approved_snapshot_json: string | null; readonly suggested_projects_json: string | null;
  readonly source_key: string; readonly organization_id: string; readonly principal_id: string; readonly membership_id: string;
  readonly membership_status: string | null;
  readonly meeting_json: string; readonly meeting_sha256: string; readonly decisions_json: string; readonly decisions_sha256: string; readonly created_at: string;
  readonly title: unknown;
  readonly sequence: number | null; readonly command_id: string | null; readonly surface: ApprovalSurfaceV1 | null; readonly action: 'approve' | 'reject' | null;
  readonly body_json: string | null; readonly receipt_json: string | null;
}
interface DecisionRow { readonly approval_id: string; readonly command_id: string; readonly surface: ApprovalSurfaceV1; readonly action: 'approve' | 'reject'; readonly body_json: string; readonly receipt_json: string | null }
type DecidedStatusV1 = 'publishing' | 'approved' | 'rejected';
function classify(row: { readonly action: 'approve' | 'reject'; readonly receipt_json: string | null }): DecidedStatusV1 {
  return row.action === 'reject' ? 'rejected' : row.receipt_json === null ? 'publishing' : 'approved';
}

export async function createApprovalCoreV1(database: Database.Database, context: ApprovalWorkflowContextV1, options: ApprovalCoreOptionsV1): Promise<ApprovalCoreV1> {
  // Throws TypeError on a non-function or async hook, so a bad registration fails core creation.
  const processing = createApprovalPublisherV1(database, context, options.after_record ?? []);
  const organizationId = context.coordinates.organization_id;
  const now = options.now ?? (() => new Date().toISOString());

  function proposalRow(approvalId: string): ProposalRow | undefined {
    return database.prepare(`SELECT o.approval_id, o.candidate_id, o.state, o.approved_snapshot_sha256, o.approved_snapshot_json, o.suggested_projects_json,
        a.source_key, a.organization_id, a.principal_id, a.membership_id, m.status AS membership_status,
        c.meeting_json, c.meeting_sha256, c.decisions_json, c.decisions_sha256, c.created_at,
        coalesce(json_extract(c.meeting_json,'$.title'),'Untitled meeting') AS title,
        d.sequence, d.command_id, d.surface, d.action, d.body_json, d.receipt_json
      FROM authority_live_approval_outbox_v2 o
      JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
      JOIN authority_live_source_admission_v2 a ON a.semantic_input_sha256=c.admission_semantic_input_sha256
      LEFT JOIN authority_memberships m ON m.membership_id=a.membership_id AND m.organization_id=a.organization_id AND m.principal_id=a.principal_id AND m.membership_type=a.membership_type
      LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id
      WHERE o.approval_id=?`).get(approvalId) as ProposalRow | undefined;
  }
  function extractionOf(row: ProposalRow): { readonly meeting: MeetingDocument; readonly decisions: DecisionSet } {
    const meeting = JSON.parse(row.meeting_json) as MeetingDocument, decisions = JSON.parse(row.decisions_json) as DecisionSet;
    if (canonicalJson(meeting as unknown as JsonValue) !== row.meeting_json || canonicalSha256(meeting as unknown as JsonValue) !== row.meeting_sha256
      || canonicalJson(decisions as unknown as JsonValue) !== row.decisions_json || canonicalSha256(decisions as unknown as JsonValue) !== row.decisions_sha256) {
      throw new Error('approval proposal extraction digest is invalid');
    }
    return { meeting, decisions };
  }
  function ownerProposalsFor(approvalId: string, meeting: MeetingDocument, decisions: DecisionSet) {
    const brief = compileDecisionBrief(`brief:${approvalId}`, meeting, decisions);
    return ownerProposalsV1(brief)
      .map(item => ({ signal_id: brief.actions[item.action_index]!.id, action: item.action_text, proposed: item.owner, index: item.action_index }))
      .filter(item => isApprovalSignalIdV1(item.signal_id));
  }

  // ---- freeze ----
  async function stage(input: ApprovalWorkflowStageInputV1): Promise<ApprovalWorkflowStageResultV1> {
    const approval_id = input.candidate.approval_id;
    const row = proposalRow(approval_id);
    if (row === undefined) throw new Error('approval proposal is absent');
    if (row.membership_status !== 'active') return { kind: 'revoked' };
    if (row.state === 'staged') return { kind: 'staged', stage_id: approval_id };
    if (row.state === 'superseded') return { kind: 'state_drift' };
    const frozen = context.state.readFrozenCandidateForApproval(approval_id);
    if (frozen === undefined) throw new Error('approval proposal source is not configured in this runtime');
    // Built from the stored extraction, so stage and reconcile produce the same bytes.
    const { meeting, decisions } = frozen;
    const brief = withoutProposedOwnersV1(compileDecisionBrief(`brief:${approval_id}`, meeting, decisions));
    const payload = { brief, source: { adapter_id: meeting.provenance.source.adapter_id, instance_id: meeting.provenance.source.instance_id, external_id: meeting.provenance.external_id },
      alternatives: [], links: null, reviewed_at: decisions.generated_at, surface: APPROVAL_SNAPSHOT_SURFACE_V1 };
    const snapshot = { schema_version: 2, kind: 'echo-approved-decision-snapshot-v2', approval_id,
      staged_content_sha256: canonicalSha256({ meeting, decisions } as unknown as JsonValue), final_content_sha256: canonicalSha256(payload as unknown as JsonValue),
      payload_contract_id: 'organization-record-approval-payload-v1', approved_payload: payload };
    // A snapshot the record codec would refuse never reaches a person.
    validateApprovedDecisionSnapshotV2(snapshot);
    const suggested = [...new Set(options.suggestions(row.source_key, meeting.provenance.external_id))];
    for (const id of suggested) validateProjectIdV1(id);
    const outbox = context.state.freezeProposal({ candidate_id: frozen.candidate_id, approved_snapshot: snapshot,
      suggested_project_ids: suggested.sort().slice(0, APPROVAL_PROJECTS_MAX_V1) });
    return outbox.state === 'staged' ? { kind: 'staged', stage_id: approval_id } : { kind: 'state_drift' };
  }
  /** Freezes up to a page of queued proposals; true when one froze or the page was full, so more may be left now. */
  async function reconcile(ctx: { readonly signal: AbortSignal } | undefined, sourceKey: string | undefined): Promise<boolean> {
    const items = context.state.listPendingApprovalDeliveries({ limit: 25, ...(sourceKey === undefined ? {} : { source_key: sourceKey }) });
    let first: unknown, frozen = false;
    for (const item of items) {
      ctx?.signal.throwIfAborted();
      try { frozen = (await stage({ admission: item.admission, candidate: item, meeting: item.meeting, decisions: item.decisions })).kind === 'staged' || frozen; }
      catch (error) { first ??= error; }
    }
    if (first !== undefined) throw first;
    return frozen || items.length === 25;
  }
  const stagerFor = (sourceKey: string | undefined): ApprovalWorkflowStagerV1 => Object.freeze({
    stage, reconcilePendingDeliveries: (ctx?: { readonly signal: AbortSignal }) => reconcile(ctx, sourceKey),
  });

  // ---- decide ----
  function existing(approvalId: string, commandId: string): readonly DecisionRow[] {
    return database.prepare('SELECT approval_id, command_id, surface, action, body_json, receipt_json FROM authority_approval_decisions_v1 WHERE approval_id=? OR command_id=?')
      .all(approvalId, commandId) as DecisionRow[];
  }
  function answer(surface: ApprovalSurfaceV1, req: ApprovalDecisionRequestV1, rows: readonly DecisionRow[]): ApprovalDecideResultV1 | undefined {
    const decided = rows.find(row => row.approval_id === req.approval_id);
    if (decided !== undefined) {
      const status = classify(decided);
      const same = decided.command_id === req.command_id && decided.surface === surface
        && canonicalJson((JSON.parse(decided.body_json) as ApprovalDecisionBodyV1).request as unknown as JsonValue) === canonicalJson(req as unknown as JsonValue);
      return { kind: same ? 'replayed' : 'already_decided', status, surface: decided.surface };
    }
    if (rows.length > 0) invalid('Command id was already used for another meeting review');
    return undefined;
  }
  function decide(surface: ApprovalSurfaceV1, request: ApprovalDecisionRequestV1, authorize: () => ApprovalAuthorizationV1): ApprovalDecideResultV1 {
    if (surface !== 'desktop' && surface !== 'slack') invalid();
    const req = validateApprovalDecisionRequestV1(surface, request);
    // A nested .immediate() would degrade to a savepoint and lose both the write lock and the after-commit wake.
    if (database.inTransaction) throw new Error('Approval decisions need an idle Authority transaction');
    let result: ApprovalDecideResultV1;
    try {
      result = database.transaction((): ApprovalDecideResultV1 => {
        const first = checkAuthorization(surface, organizationId, authorize());
        const row = proposalRow(req.approval_id);
        if (row === undefined || row.organization_id !== first.actor.organization_id || row.principal_id !== first.actor.principal_id
          || row.membership_id !== first.actor.membership_id || row.membership_status !== 'active') denied();
        const answered = answer(surface, req, existing(req.approval_id, req.command_id));
        if (answered !== undefined) return answered;
        if (row.state !== 'staged' || row.approved_snapshot_sha256 !== req.snapshot_sha256) return { kind: 'stale' };
        let retained: MeetingApprovalTranscriptSourceV2 | undefined;
        if (req.action === 'approve') {
          const { meeting, decisions } = extractionOf(row);
          if (req.owners.length > 0) {
            const proposals = new Map(ownerProposalsFor(req.approval_id, meeting, decisions).map(item => [item.signal_id, item.index]));
            let previous = -1;
            for (const owner of req.owners) {
              const index = proposals.get(owner.signal_id);
              if (index === undefined || index <= previous) invalid('Owners must name proposed actions in order');
              previous = index;
            }
          }
          if (req.project_ids.length > 0) {
            try { options.projects(first.actor, req.project_ids); }
            catch (error) {
              if (error instanceof AuthorityOperationError && error.code === 'unauthorized') throw new AuthorityOperationError('unauthorized', 'A chosen project is not available');
              throw error;
            }
          }
          retained = retainedMeetingSourceCoordinateV1(database, organizationId, meeting);
          if (retained === undefined) throw new AuthorityOperationError('unavailable', 'Meeting content is no longer retained');
        }
        const decided_at = now();
        if (typeof decided_at !== 'string' || new Date(decided_at).toISOString() !== decided_at) throw new Error('Approval decision time must be canonical UTC milliseconds');
        // The retained coordinate is frozen into the immutable body, so every publish retry rebuilds identical bytes.
        const transcript_source = req.action === 'approve' ? retained! : null;
        const body: ApprovalDecisionBodyV1 = { request: req, surface, actor: first.actor, evidence: first.evidence, transcript_source, decided_at };
        const second = checkAuthorization(surface, organizationId, authorize());
        if (canonicalJson(second as unknown as JsonValue) !== canonicalJson(first as unknown as JsonValue)) throw new AuthorityOperationError('stale_access_state', 'Approval access changed');
        database.prepare('INSERT INTO authority_approval_decisions_v1 (approval_id, command_id, surface, action, body_json) VALUES (?,?,?,?,?)')
          .run(req.approval_id, req.command_id, surface, req.action, canonicalJson(body as unknown as JsonValue));
        return { kind: 'decided', status: req.action === 'approve' ? 'publishing' : 'rejected', surface };
      }).immediate();
    } catch (error) {
      if (!(error instanceof Database.SqliteError)) throw error;
      if (error.message.includes('authority_approval_decisions_v1.approval_id')) {
        const answered = answer(surface, req, existing(req.approval_id, req.command_id));
        if (answered !== undefined) return answered;
      }
      if (error.message.includes('authority_approval_decisions_v1.command_id')) invalid('Command id was already used for another meeting review');
      if (error.message.includes('needs its staged proposal')) return { kind: 'stale' };
      if (error.message.includes('needs the active reviewer')) denied();
      if (error.message.includes('audience needs active project membership')) throw new AuthorityOperationError('unauthorized', 'A chosen project is not available');
      throw error;
    }
    if (result.kind === 'decided' || result.kind === 'replayed') {
      // The wake is observational and runs only after the decision is durable.
      try { context.on_terminal_action_queued?.(); } catch { /* periodic recovery remains authoritative */ }
    }
    return result;
  }

  // ---- views ----
  function view(row: ProposalRow, readable: (reviewer: ApprovalActorV1, projectId: string) => boolean): ApprovalProposalViewV1 | undefined {
    if (row.approved_snapshot_json === null || row.approved_snapshot_sha256 === null) return undefined;
    const reviewer = Object.freeze({ organization_id: row.organization_id, principal_id: row.principal_id, membership_id: row.membership_id });
    const body = row.body_json === null ? null : JSON.parse(row.body_json) as ApprovalDecisionBodyV1;
    const status: ApprovalStatusV1 = row.action !== null ? classify({ action: row.action, receipt_json: row.receipt_json }) : row.state === 'superseded' ? 'superseded' : 'pending';
    const suggested = row.suggested_projects_json === null ? [] : JSON.parse(row.suggested_projects_json) as string[];
    return Object.freeze({
      approval_id: row.approval_id, reviewer, reviewer_active: row.membership_status === 'active',
      title: String(row.title).slice(0, 256), status, decided_on: row.surface, decided_at: body?.decided_at ?? null,
      project_ids: Object.freeze(body !== null ? [...body.request.project_ids] : suggested.filter(id => readable(reviewer, id))),
      snapshot_sha256: row.approved_snapshot_sha256, snapshot_json: row.approved_snapshot_json,
    });
  }
  function readableCheck() {
    const memo = new Map<string, boolean>();
    return (reviewer: ApprovalActorV1, projectId: string) => {
      const key = canonicalJson({ reviewer, projectId } as unknown as JsonValue);
      let allowed = memo.get(key);
      if (allowed === undefined) {
        try { options.projects(reviewer, [projectId]); allowed = true; }
        catch (error) { if (!(error instanceof AuthorityOperationError)) throw error; allowed = false; }
        memo.set(key, allowed);
      }
      return allowed;
    };
  }
  function proposal(approvalId: string): ApprovalProposalViewV1 | undefined {
    const row = proposalRow(approvalId);
    return row === undefined ? undefined : view(row, readableCheck());
  }
  function proposals(reviewer: ApprovalActorV1, limit = 100): readonly ApprovalProposalViewV1[] {
    const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 100;
    const ids = database.prepare(`SELECT o.approval_id FROM authority_live_approval_outbox_v2 o
      JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
      JOIN authority_live_source_admission_v2 a ON a.semantic_input_sha256=c.admission_semantic_input_sha256
      LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id
      WHERE a.organization_id=? AND a.principal_id=? AND a.membership_id=? AND o.approved_snapshot_json IS NOT NULL
      ORDER BY CASE WHEN d.approval_id IS NULL AND o.state='staged' THEN 0 ELSE 1 END, c.created_at DESC, o.approval_id
      LIMIT ?`).pluck().all(reviewer.organization_id, reviewer.principal_id, reviewer.membership_id, bounded) as string[];
    const readable = readableCheck();
    return Object.freeze(ids.flatMap(id => {
      const row = proposalRow(id);
      const value = row === undefined ? undefined : view(row, readable);
      return value === undefined ? [] : [value];
    }));
  }
  function ownerProposals(approvalId: string): readonly ApprovalOwnerProposalV1[] {
    const row = proposalRow(approvalId);
    if (row === undefined) return [];
    const { meeting, decisions } = extractionOf(row);
    return Object.freeze(ownerProposalsFor(approvalId, meeting, decisions).map(item => Object.freeze({ signal_id: item.signal_id, action: item.action, proposed: item.proposed })));
  }

  const views = Object.freeze({ proposal, ownerProposals });
  const presenters = Object.freeze((options.presenters ?? []).map(factory => factory(views)));
  const withPresentations: ApprovalWorkflowProcessingV1 = presenters.length === 0 ? processing : Object.freeze({
    ...processing,
    async reconcileApprovalPresentations(signal: AbortSignal) {
      let rendered = false;
      for (const presenter of presenters) {
        signal.throwIfAborted();
        const result = await presenter.reconcile(signal);
        if (result === 'uncertain') return 'uncertain';
        rendered ||= result === 'rendered';
      }
      return rendered ? 'rendered' : 'idle';
    },
  });
  return Object.freeze({ stager: stagerFor(undefined), stagerForSource: (sourceKey: string) => stagerFor(sourceKey), processing: withPresentations, decide, proposal, proposals, ownerProposals });
}
