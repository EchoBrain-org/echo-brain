import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_RUNS_LIST_LIMIT_V1, validatePersonImpactCardV1, type PersonImpactCardV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { impactItemKeyV1, refreshImpactCardV1, storableImpactCardV1, type FreshImpactItemV1, type StoredImpactCardV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { SqliteTriggerRunsV1, triggerRunStateAtV1, type ApprovalActorV1, type TriggerRunRowV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import type { ImpactItemDraftV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import type { SqlitePersonAgenticAskAuditV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import type { JiraOwnerAccountsV1 } from '../application/ports/jira-owner-accounts-v1.js';
import { matchImpactOwnersV1, type ImpactOwnerPeopleV1 } from './impact-owner-matching-v1.js';
import { PersonRecordSearchIndexLagV1, type PersonReadableDecisionsV1, type PersonRecordAnchorV1, type PersonRecordProjectsV1 } from './person-record-search-route.js';
import { bindPersonLiveEvidenceDeskV1, type CreatePersonLiveAnswerRouteOptionsV1, type PersonLiveRequestContextV1 } from './person-live-answer-route-v1.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../presentation/person-trigger-runs-http-application.js';
import { annotateCoreRuntimeV1, coreRuntimeIdentityV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, currentCoreRuntimeDetailV1, withoutCoreRuntimeContentV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { PersonDiagnosticCaptureHandleV1 } from './person-diagnostics-v1.js';
import { openItemViewerV1 } from './person-open-items-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';
import { readStoredImpactCardV1 } from './person-stored-impact-card-v1.js';
import { sweepOpenItemsV1 } from './person-sweep-runs-v1.js';

type Desk = Awaited<ReturnType<typeof bindPersonLiveEvidenceDeskV1>>;
type RunResearch = Pick<ReturnType<typeof import('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1').createAgenticResearchV1>, 'renderWithResearch'>;
type BoundOptions = CreatePersonLiveAnswerRouteOptionsV1;
type DeskScope = Parameters<typeof bindPersonLiveEvidenceDeskV1>[2]['scope'];
/**
 * What a finished run stores, and what its finishing transaction writes with it: `writes` is asked right before the run
 * finishes, with no await in between, and answers the callback the transaction runs.
 */
type RunOutput = { readonly result: object; readonly writes?: () => (transaction: Database.Database) => void };

export interface CreatePersonTriggerRunsV1Options {
  readonly runs: SqliteTriggerRunsV1;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly records: PersonRecordAnchorV1 & PersonRecordProjectsV1 & PersonReadableDecisionsV1;
  /** The open items: a finished impact run writes the items it found, and a finished sweep its checks, in the run's finishing transaction. */
  readonly items: Pick<SqliteImpactItemsV1, 'insertForRun' | 'involving' | 'forRecords' | 'read' | 'recordCheck'>;
  /** ECHO's member directory: exact owner matches, and the facts the open-items policy weighs for a sweep. */
  readonly people: ImpactOwnerPeopleV1 & Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  /** Jira assignee accounts, read with the approver's own connection; absent without the Jira live connector. */
  readonly jira_owners?: JiraOwnerAccountsV1;
  /** Kept injectable for focused service tests and shared with the live evaluator. */
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  readonly audit: SqlitePersonAgenticAskAuditV1;
  readonly bind_options: BoundOptions;
  readonly live_sources?: BoundOptions['live_sources'];
  readonly research: (input: { readonly desk: Desk; readonly context: PersonLiveRequestContextV1 }) => RunResearch;
  readonly lease_ms?: number;
  /** How many runs this process researches at once; a start past it answers `busy`. */
  readonly max_running?: number;
  /** The clock a sweep's checks are stamped with, and a lapsed lease is told by. */
  readonly now?: () => Date;
}

const LEASE_MS = 600_000;
const MAX_RUNNING = 4;
/** `list` shows at most this many sweeps, so frequent sweeps never push an impact run (and its Try again) off the list (R55). */
const SWEEPS_LISTED = 20;
/** Newest first, as the store lists runs. */
const newestFirst = (left: TriggerRunRowV1, right: TriggerRunRowV1) =>
  (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0) || (left.run_id < right.run_id ? 1 : left.run_id > right.run_id ? -1 : 0);
const actorOf = (value: PersonAccessAuthorization): ApprovalActorV1 => ({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id });
const sameActor = (left: ApprovalActorV1, right: ApprovalActorV1) => left.organization_id === right.organization_id && left.principal_id === right.principal_id && left.membership_id === right.membership_id;
const scopeFor = (records: PersonRecordProjectsV1, token: string, record_sha256: Sha256Digest) => {
  const projects = records.recordProjects({ access_token: token, record_sha256 });
  return projects.length === 1 ? Object.freeze({ kind: 'project' as const, project_id: projects[0]! }) : Object.freeze({ kind: 'global' as const });
};
/** Only an impact run has a card; a sweep stores its counts alone. */
function impactRecord(row: TriggerRunRowV1): Sha256Digest {
  if (row.trigger !== 'approved_record' || row.record_sha256 === null) throw new AuthorityOperationError('not_found', 'run is not available');
  return row.record_sha256;
}
function unavailable(error: unknown): boolean {
  return error instanceof AuthorityOperationError && error.code === 'unavailable';
}
/**
 * The open items a finished card makes (open items and Home v1, section 3):
 * one per affected item that conflicts, needs updating or was not assessed,
 * never one that confirms, and one per item however often the card cites it.
 * The owner name is the card's, from the item's own details, and is used only
 * to match a member; it is never stored.
 */
function itemCandidates(card: PersonImpactCardV1, stored: StoredImpactCardV1) {
  const seen = new Set<Sha256Digest>();
  return card.affected.flatMap((row, index) => {
    if (row.relation === 'confirms') return [];
    const pointer = card.citations[row.citation_index]!.citation as unknown as Readonly<Record<string, unknown>>;
    const item_key = impactItemKeyV1(pointer);
    if (item_key === undefined || seen.has(item_key)) return [];
    seen.add(item_key);
    const relation = row.relation ?? null;
    // The stored phrase: screened against outside titles. Only an assessed item carries one.
    const expected = relation === null ? undefined : stored.affected[index]?.expected;
    return [{ item_key, pointer, relation, expected: expected ?? null, ...(row.owner === undefined ? {} : { owner_name: row.owner }) }];
  });
}

/** The runs themselves; the open items a finished run found are served by `createPersonOpenItemsV1`. */
export type PersonTriggerRunsApplicationV1 = Pick<PersonTriggerRunsHttpApplicationV1, 'list' | 'start' | 'retry' | 'view' | 'close'>;

export function createPersonTriggerRunsV1(options: CreatePersonTriggerRunsV1Options): PersonTriggerRunsApplicationV1 {
  const lease = options.lease_ms ?? LEASE_MS;
  const maxRunning = options.max_running ?? MAX_RUNNING;
  const now = options.now ?? (() => new Date());
  const controllers = new Set<AbortController>();
  let closing = false;
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const context = (authorization: PersonAccessAuthorization): PersonLiveRequestContextV1 => ({
    authority_id: options.bind_options.authority_id, organization_id: authorization.organization_id, state_lineage_id: options.bind_options.state_lineage_id,
    principal_id: authorization.principal_id, membership_id: authorization.membership_id, session_family_id: authorization.session_family_id, request_id: `trigger_run_${randomUUID()}`,
  });
  /** An impact run: the card the approver's research renders, and the open items it found, written as the run finishes. */
  const checkImpact = async (row: TriggerRunRowV1, token: string, research: (scope: DeskScope) => Promise<RunResearch>, signal: AbortSignal): Promise<RunOutput> => {
    const record_sha256 = impactRecord(row);
    const anchor = options.records.recordAnchor({ access_token: token, record_sha256 });
    const run = await research(scopeFor(options.records, token, record_sha256));
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'approved_record')!;
    const event = definition.parseEvent({ record: anchor });
    const output = await run.renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event, signal });
    const card = validatePersonImpactCardV1(output.rendered);
    const outsideLabels = output.research.items
      .filter(item => (item.citation as { readonly kind?: unknown }).kind !== 'approved_record' && (item.citation as { readonly kind?: unknown }).kind !== 'source_revision').map(item => item.title);
    const value = storableImpactCardV1(card, outsideLabels);
    const candidates = itemCandidates(card, value);
    const owners = candidates.length === 0 ? [] : await matchImpactOwnersV1({
      candidates: candidates.map(candidate => ({ pointer: candidate.pointer, ...(candidate.owner_name === undefined ? {} : { owner_name: candidate.owner_name }) })),
      approver: { organization_id: row.actor.organization_id, membership_id: row.actor.membership_id },
      access_token: token, people: options.people, signal,
      ...(options.jira_owners === undefined ? {} : { jira: options.jira_owners }),
    });
    // A cancelled assignee read matches no one; its fallbacks are never stored as the run's owners.
    signal.throwIfAborted();
    const drafts: ImpactItemDraftV1[] = candidates.map((candidate, index) => ({
      item_key: candidate.item_key, pointer: candidate.pointer, relation: candidate.relation, expected: candidate.expected,
      owner_membership_id: owners[index]!.owner_membership_id, owner_match: owners[index]!.owner_match,
    }));
    // The items are written in the transaction that stores the card, so a run is never done without them.
    return { result: value, ...(drafts.length === 0 ? {} : { writes: () => (transaction: Database.Database) => options.items.insertForRun(transaction, row, drafts) }) };
  };
  const launch = (row: TriggerRunRowV1, token: string, authorization: PersonAccessAuthorization, lease_token: string, capture?: PersonDiagnosticCaptureHandleV1) => {
    const controller = new AbortController(); controllers.add(controller);
    const attemptId = randomUUID();
    void observePersonResearchV1({ trigger: row.trigger, run_id: row.run_id, event_id: row.event_ref, attempt_id: attemptId,
      detached: true, ...(capture === undefined ? {} : { capture }),
    }, async () => {
      try {
        const requestContext = { ...context(authorization), request_id: `${row.run_id}_${attemptId}` };
        // Either trigger's research reads as the person who started the run, on one desk; a capture checks access on the same desk.
        const research = async (scope: DeskScope): Promise<RunResearch> => {
          const desk = await options.bindDesk(options.bind_options, compatible, { access_token: token, scope, signal: controller.signal }, requestContext);
          capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
          return options.research({ desk, context: requestContext });
        };
        // A sweep with nothing left to read binds no desk: a capture then checks the person's session alone.
        const fenceSession = () => capture?.bindFence(async () => { options.sessions.authenticateAccess({ access_token: token }); });
        const output = row.trigger === 'sweep'
          ? await sweepOpenItemsV1({ sources: options, viewer: openItemViewerV1(token, authorization), run: row, research, fenceSession, signal: controller.signal, checked_at: now().toISOString() })
          : await checkImpact(row, token, research, controller.signal);
        // What the run stores, and what is written with it, in the one transaction that finishes it.
        const digest = canonicalSha256(output.result);
        const write = output.writes?.();
        const persisted = options.runs.finish(row.run_id, lease_token, { json: canonicalJson(output.result), sha256: digest }, write);
        observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'persistence', event: persisted ? 'succeeded' : 'skipped', data: { run_id: row.run_id, output_sha256: digest } });
        annotateCoreRuntimeV1({ result: persisted ? currentCoreRuntimeDetailV1()?.result ?? 'completed' : 'competing_action', output_id: coreRuntimeIdentityV1('research-output', digest) });
        if (!persisted) throw new AuthorityOperationError('conflict', 'The research attempt no longer owns its run');
      } catch (error) {
        if (closing && controller.signal.aborted) throw error;
        // The desktop's access token rotates every 12 h, revoking the old one: while the membership is active no attempt is spent.
        // This relies on `start` checking access again before any model call, so a lasting `unauthorized` cannot loop paid calls.
        const rotated = error instanceof AuthorityOperationError && error.code === 'unauthorized' && options.people.isActiveMember(row.actor.organization_id, row.actor.membership_id);
        if (error instanceof PersonRecordSearchIndexLagV1 || rotated) options.runs.release(row.run_id, lease_token, { counted: false });
        else if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'stale_access_state' || error.code === 'not_found')) options.runs.fail(row.run_id, lease_token, 'no_access');
        else if (controller.signal.aborted || error instanceof AgenticAskDeadlineErrorV1) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'timed_out' });
        else if (unavailable(error)) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'unavailable' });
        else options.runs.fail(row.run_id, lease_token, 'research_failed');
        throw error;
      } finally { controllers.delete(controller); }
    }).catch(() => undefined); // The durable run and optional capture own the terminal result.
  };
  return Object.freeze({
    async list(input: Parameters<PersonTriggerRunsHttpApplicationV1['list']>[0]) {
      input.signal?.throwIfAborted(); const actor = actorOf(options.sessions.authenticateAccess({ access_token: input.access_token }));
      // The caller's 20 newest sweeps, and as many of their newest impact runs as fill the rest, newest first.
      const sweeps = options.runs.list(actor, SWEEPS_LISTED, 'sweep');
      const rows = [...sweeps, ...options.runs.list(actor, PERSON_RUNS_LIST_LIMIT_V1 - sweeps.length, 'approved_record')].sort(newestFirst);
      // A run whose attempt stopped without finishing is listed as pending, so the desktop starts it again (R60).
      const at = now().toISOString();
      return Object.freeze({ runs: Object.freeze(rows.map(row => Object.freeze({ run_id: row.run_id, trigger: row.trigger, event_ref: row.event_ref, state: triggerRunStateAtV1(row, at), error_code: row.error_code, created_at: row.created_at, updated_at: row.updated_at }))) });
    },
    async start(input: Parameters<PersonTriggerRunsHttpApplicationV1['start']>[0]) {
      input.signal?.throwIfAborted(); const authorization = options.sessions.authenticateAccess({ access_token: input.access_token }); const actor = actorOf(authorization);
      const claim = options.runs.claim(actor, input.request.run_id, lease, () => controllers.size < maxRunning);
      if (claim.kind !== 'claimed') { if (claim.kind === 'not_found') throw new AuthorityOperationError('not_found', 'run is not available'); return Object.freeze({ state: claim.kind }); }
      const row = options.runs.read(actor, input.request.run_id); if (row === undefined) throw new AuthorityOperationError('not_found', 'run is not available');
      let capture: PersonDiagnosticCaptureHandleV1 | undefined;
      try {
        capture = input.request.capture_id === undefined ? undefined : options.bind_options.diagnostics?.claim({
          access_token: input.access_token, capture_id: input.request.capture_id, target: { kind: 'trigger_run', run_id: row.run_id },
        });
        if (input.request.capture_id !== undefined && capture === undefined) throw new AuthorityOperationError('unavailable', 'Diagnostic capture is not available');
      } catch (error) { options.runs.release(row.run_id, claim.lease_token, { counted: false }); throw error; }
      launch(row, input.access_token, authorization, claim.lease_token, capture); return Object.freeze({ state: 'running' as const });
    },
    async retry(input: Parameters<PersonTriggerRunsHttpApplicationV1['retry']>[0]) {
      input.signal?.throwIfAborted(); const actor = actorOf(options.sessions.authenticateAccess({ access_token: input.access_token }));
      if (!options.runs.retry(actor, input.request.run_id)) throw new AuthorityOperationError('not_found', 'run is not available');
      return Object.freeze({ state: 'pending' as const });
    },
    async view(input: Parameters<PersonTriggerRunsHttpApplicationV1['view']>[0]) {
      input.signal?.throwIfAborted(); const authorization = options.sessions.authenticateAccess({ access_token: input.access_token }); const actor = actorOf(authorization);
      // The approver's own finished run, or one whose decision this person can read now (open items and Home v1, section 3).
      const row = options.runs.readUnfenced(input.request.run_id);
      if (row === undefined || row.actor.organization_id !== actor.organization_id || row.state !== 'done' || row.result_json === null) throw new AuthorityOperationError('not_found', 'run is not available');
      const record_sha256 = impactRecord(row);
      if (!sameActor(row.actor, actor) && !options.records.readableDecisions({ access_token: input.access_token, record_sha256s: [record_sha256] }).has(record_sha256)) {
        throw new AuthorityOperationError('not_found', 'run is not available');
      }
      const resultJson = row.result_json;
      return withoutCoreRuntimeContentV1(() => observeCoreRuntimeV1('research_output_view', async () => {
        const card = readStoredImpactCardV1(resultJson);
        annotateCoreRuntimeV1({ trigger: row.trigger, run_id: coreRuntimeIdentityV1('research-run', row.run_id), event_id: coreRuntimeIdentityV1('research-event', row.event_ref), output_id: coreRuntimeIdentityV1('research-output', canonicalSha256(JSON.parse(resultJson))) });
        const scope = scopeFor(options.records, input.access_token, record_sha256); const requestContext = context(authorization);
        const desk = await options.bindDesk(options.bind_options, compatible, { access_token: input.access_token, scope, ...(input.signal === undefined ? {} : { signal: input.signal }) }, requestContext);
        const fresh = await Promise.all(card.citations.map(async citation => {
          try { const opened = await desk.openCitation!({ citation, ...(input.signal === undefined ? {} : { signal: input.signal }) }); const item = opened.items[0]; return item === undefined ? null : { citation: { citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility }, text: item.text, label: item.label, ...(item.attributes === undefined ? {} : { attributes: item.attributes }) } as FreshImpactItemV1; } catch { return null; }
        }));
        const refreshed = refreshImpactCardV1(card, fresh); await desk.revalidate({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
        annotateCoreRuntimeV1({ result: 'returned', counts: { citation_count: refreshed.card.citations.length, excluded_count: refreshed.hidden } });
        return Object.freeze({ card: refreshed.card, checked_at: row.updated_at, hidden: refreshed.hidden });
      }));
    },
    close() { closing = true; for (const controller of controllers) controller.abort(); },
  });
}
