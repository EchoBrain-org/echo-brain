import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerCitationV6, validatePersonImpactCardV1, type PersonImpactCardV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { impactItemKeyV1, refreshImpactCardV1, storableImpactCardV1, type FreshImpactItemV1, type StoredImpactCardV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { SqliteTriggerRunsV1, type ApprovalActorV1, type TriggerRunRowV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import type { ImpactItemDraftV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqlitePersonAgenticAskAuditV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import type { JiraOwnerAccountsV1 } from '../application/ports/jira-owner-accounts-v1.js';
import { matchImpactOwnersV1, type ImpactOwnerPeopleV1 } from './impact-owner-matching-v1.js';
import { PersonRecordSearchIndexLagV1, type PersonReadableDecisionsV1, type PersonRecordAnchorV1, type PersonRecordProjectsV1 } from './person-record-search-route.js';
import { bindPersonLiveEvidenceDeskV1, type CreatePersonLiveAnswerRouteOptionsV1, type PersonLiveRequestContextV1 } from './person-live-answer-route-v1.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../presentation/person-trigger-runs-http-application.js';
import { annotateCoreRuntimeV1, coreRuntimeIdentityV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, currentCoreRuntimeDetailV1, withoutCoreRuntimeContentV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { PersonDiagnosticCaptureHandleV1 } from './person-diagnostics-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';

type Desk = Awaited<ReturnType<typeof bindPersonLiveEvidenceDeskV1>>;
type RunResearch = Pick<ReturnType<typeof import('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1').createAgenticResearchV1>, 'renderWithResearch'>;
type BoundOptions = CreatePersonLiveAnswerRouteOptionsV1;

export interface CreatePersonTriggerRunsV1Options {
  readonly runs: SqliteTriggerRunsV1;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly records: PersonRecordAnchorV1 & PersonRecordProjectsV1 & Pick<PersonReadableDecisionsV1, 'readableDecisions'>;
  /** Where a finished impact run writes its open items, in the run's finishing transaction. */
  readonly items: Pick<SqliteImpactItemsV1, 'insertForRun'>;
  /** ECHO's member directory, for exact owner matches. */
  readonly people: ImpactOwnerPeopleV1;
  /** Jira assignee accounts, read with the approver's own connection; absent without the Jira live connector. */
  readonly jira_owners?: JiraOwnerAccountsV1;
  /** Kept injectable for focused service tests and shared with the live evaluator. */
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  readonly audit: SqlitePersonAgenticAskAuditV1;
  readonly bind_options: BoundOptions;
  readonly live_sources?: BoundOptions['live_sources'];
  readonly research: (input: { readonly desk: Desk; readonly context: PersonLiveRequestContextV1 }) => RunResearch;
  readonly lease_ms?: number;
}

const LEASE_MS = 600_000;
const actorOf = (value: PersonAccessAuthorization): ApprovalActorV1 => ({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id });
const sameActor = (left: ApprovalActorV1, right: ApprovalActorV1) => left.organization_id === right.organization_id && left.principal_id === right.principal_id && left.membership_id === right.membership_id;
const scopeFor = (records: PersonRecordProjectsV1, token: string, record_sha256: Sha256Digest) => {
  const projects = records.recordProjects({ access_token: token, record_sha256 });
  return projects.length === 1 ? Object.freeze({ kind: 'project' as const, project_id: projects[0]! }) : Object.freeze({ kind: 'global' as const });
};
/**
 * A run's stored impact card, checked to hold pointers and ECHO's own lines
 * only, or `unavailable`. Open items read its first decided line from here.
 */
export function readStoredImpactCardV1(json: string): StoredImpactCardV1 {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new AuthorityOperationError('unavailable', 'stored impact card is invalid'); }
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('stored card is not an object');
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['affected', 'citations', 'decided', 'schema_version', 'status', 'unconfirmed']) || raw.schema_version !== 1 ||
        !Array.isArray(raw.citations) || !Array.isArray(raw.decided) || !Array.isArray(raw.affected) || !Array.isArray(raw.unconfirmed)) throw new Error('stored card has an invalid shape');
    const rawCitations = raw.citations as unknown[];
    const rawDecided = raw.decided as unknown[];
    const rawAffected = raw.affected as unknown[];
    const rawUnconfirmed = raw.unconfirmed as unknown[];
    const citations = rawCitations.map(pointer => {
      if (typeof pointer !== 'object' || pointer === null || Array.isArray(pointer) || typeof (pointer as { readonly kind?: unknown }).kind !== 'string') throw new Error('stored citation is invalid');
      const kind = (pointer as { readonly kind: string }).kind;
      const citationKind = kind === 'ticket' || kind === 'page' || kind === 'slack_message' ? kind : 'decision';
      return validatePersonAnswerCitationV6({ citation: pointer, kind: citationKind, label: 'Stored pointer', visibility: 'only_me' }).citation;
    });
    const affected = rawAffected.map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('stored affected row is invalid');
      const row = entry as Record<string, unknown>;
      const allowed = ['citation_index', 'date_at_risk', 'expected', 'relation', 'says_now'];
      if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error('stored affected row has an extra field');
      return { ...row, says_now: row.says_now ?? 'Stored local value.' };
    });
    const validated = validatePersonImpactCardV1({
      status: raw.status, decided: rawDecided, affected, unconfirmed: rawUnconfirmed, people: [],
      citations: citations.map(citation => ({ citation, kind: citation.kind === 'ticket' || citation.kind === 'page' || citation.kind === 'slack_message' ? citation.kind : 'decision', label: 'Stored pointer', visibility: 'only_me' })),
    });
    const local = (index: number) => citations[index]?.kind === 'approved_record' || citations[index]?.kind === 'source_revision';
    if (validated.decided.some(row => !local(row.citation_index)) || rawAffected.some((entry, index) => Object.hasOwn(entry as object, 'says_now') && !local(validated.affected[index]!.citation_index))) throw new Error('stored card contains outside text');
    return Object.freeze({ schema_version: 1 as const, status: validated.status,
      decided: Object.freeze(validated.decided.map(row => Object.freeze({ text: row.text, citation_index: row.citation_index }))),
      affected: Object.freeze(validated.affected.map((row, index) => Object.freeze({ citation_index: row.citation_index,
        ...(row.relation === undefined ? {} : { relation: row.relation }), ...(row.expected === undefined ? {} : { expected: row.expected }),
        ...(row.date_at_risk === undefined ? {} : { date_at_risk: row.date_at_risk }),
        ...(Object.hasOwn(rawAffected[index] as object, 'says_now') ? { says_now: row.says_now } : {}),
      }))),
      unconfirmed: validated.unconfirmed, citations: Object.freeze(citations),
    });
  } catch {
    throw new AuthorityOperationError('unavailable', 'stored impact card is invalid');
  }
}
/** Until sweeps get their own path (open items plan, Task 11), this service serves approved-record runs only. */
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
  const controllers = new Set<AbortController>();
  let closing = false;
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const context = (authorization: PersonAccessAuthorization): PersonLiveRequestContextV1 => ({
    authority_id: options.bind_options.authority_id, organization_id: authorization.organization_id, state_lineage_id: options.bind_options.state_lineage_id,
    principal_id: authorization.principal_id, membership_id: authorization.membership_id, session_family_id: authorization.session_family_id, request_id: `trigger_run_${randomUUID()}`,
  });
  const launch = (row: TriggerRunRowV1, token: string, authorization: PersonAccessAuthorization, lease_token: string, capture?: PersonDiagnosticCaptureHandleV1) => {
    const controller = new AbortController(); controllers.add(controller);
    const attemptId = randomUUID();
    void observePersonResearchV1({ trigger: row.trigger, run_id: row.run_id, event_id: row.event_ref, attempt_id: attemptId,
      detached: true, ...(capture === undefined ? {} : { capture }),
    }, async () => {
      try {
        const record_sha256 = row.record_sha256;
        if (row.trigger !== 'approved_record' || record_sha256 === null) throw new Error('sweep runs are not served yet');
        const anchor = options.records.recordAnchor({ access_token: token, record_sha256 });
        const scope = scopeFor(options.records, token, record_sha256);
        const requestContext = { ...context(authorization), request_id: `${row.run_id}_${attemptId}` };
        const desk = await options.bindDesk(options.bind_options, compatible, { access_token: token, scope, signal: controller.signal }, requestContext);
        capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
        const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'approved_record')!;
        const event = definition.parseEvent({ record: anchor });
        const output = await options.research({ desk, context: requestContext }).renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event, signal: controller.signal });
        const card = validatePersonImpactCardV1(output.rendered);
        const outsideLabels = output.research.items
          .filter(item => (item.citation as { readonly kind?: unknown }).kind !== 'approved_record' && (item.citation as { readonly kind?: unknown }).kind !== 'source_revision').map(item => item.title);
        const value = storableImpactCardV1(card, outsideLabels);
        const candidates = itemCandidates(card, value);
        const owners = candidates.length === 0 ? [] : await matchImpactOwnersV1({
          candidates: candidates.map(candidate => ({ pointer: candidate.pointer, ...(candidate.owner_name === undefined ? {} : { owner_name: candidate.owner_name }) })),
          approver: { organization_id: row.actor.organization_id, membership_id: row.actor.membership_id },
          access_token: token, people: options.people, signal: controller.signal,
          ...(options.jira_owners === undefined ? {} : { jira: options.jira_owners }),
        });
        // A cancelled assignee read matches no one; its fallbacks are never stored as the run's owners.
        controller.signal.throwIfAborted();
        const drafts: ImpactItemDraftV1[] = candidates.map((candidate, index) => ({
          item_key: candidate.item_key, pointer: candidate.pointer, relation: candidate.relation, expected: candidate.expected,
          owner_membership_id: owners[index]!.owner_membership_id, owner_match: owners[index]!.owner_match,
        }));
        // The items are written in the transaction that stores the card, so a run is never done without them.
        const digest = canonicalSha256(value);
        const persisted = options.runs.finish(row.run_id, lease_token, { json: canonicalJson(value), sha256: digest },
          drafts.length === 0 ? undefined : transaction => options.items.insertForRun(transaction, row, drafts));
        observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'persistence', event: persisted ? 'succeeded' : 'skipped', data: { run_id: row.run_id, output_sha256: digest } });
        annotateCoreRuntimeV1({ result: persisted ? currentCoreRuntimeDetailV1()?.result ?? 'completed' : 'competing_action', output_id: coreRuntimeIdentityV1('research-output', digest) });
        if (!persisted) throw new AuthorityOperationError('conflict', 'The research attempt no longer owns its run');
      } catch (error) {
        if (closing && controller.signal.aborted) throw error;
        if (error instanceof PersonRecordSearchIndexLagV1) options.runs.release(row.run_id, lease_token, { counted: false });
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
      // The runs API lists approved-record runs only until it learns sweeps (open items plan, Task 11).
      return Object.freeze({ runs: Object.freeze(options.runs.list(actor, 100).flatMap(row => row.trigger !== 'approved_record' ? [] : [Object.freeze({ run_id: row.run_id, trigger: row.trigger, event_ref: row.event_ref, state: row.state, error_code: row.error_code, created_at: row.created_at, updated_at: row.updated_at })])) });
    },
    async start(input: Parameters<PersonTriggerRunsHttpApplicationV1['start']>[0]) {
      input.signal?.throwIfAborted(); const authorization = options.sessions.authenticateAccess({ access_token: input.access_token }); const actor = actorOf(authorization);
      const claim = options.runs.claim(actor, input.request.run_id, lease);
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
