import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonImpactCardV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { AgenticResearchResultV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { refreshImpactCardV1, storableImpactCardV1, type FreshImpactItemV1, type StoredImpactCardV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { SqliteTriggerRunsV1, type ApprovalActorV1, type TriggerRunRowV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import type { SqlitePersonAgenticAskAuditV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { PersonRecordSearchIndexLagV1, type PersonRecordAnchorV1, type PersonRecordProjectsV1 } from './person-record-search-route.js';
import { bindPersonLiveEvidenceDeskV1, type CreatePersonLiveAnswerRouteOptionsV1, type PersonLiveRequestContextV1 } from './person-live-answer-route-v1.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../presentation/person-trigger-runs-http-application.js';

type Desk = Awaited<ReturnType<typeof bindPersonLiveEvidenceDeskV1>>;
type RunResearch = { renderWithResearch(input: unknown): Promise<{ readonly rendered: unknown; readonly research: AgenticResearchResultV1 }> };
type BoundOptions = CreatePersonLiveAnswerRouteOptionsV1;

export interface CreatePersonTriggerRunsV1Options {
  readonly runs: SqliteTriggerRunsV1;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly records: PersonRecordAnchorV1 & PersonRecordProjectsV1;
  /** Kept injectable for focused service tests and shared with the live evaluator. */
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  readonly audit: SqlitePersonAgenticAskAuditV1;
  readonly bind_options?: BoundOptions;
  readonly live_sources?: BoundOptions['live_sources'];
  readonly research: (input: { readonly desk: Desk; readonly context: PersonLiveRequestContextV1 }) => RunResearch;
  readonly lease_ms?: number;
}

const LEASE_MS = 600_000;
const actorOf = (value: PersonAccessAuthorization): ApprovalActorV1 => ({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id });
const sameActor = (left: ApprovalActorV1, right: ApprovalActorV1) => left.organization_id === right.organization_id && left.principal_id === right.principal_id && left.membership_id === right.membership_id;
const scopeFor = (records: PersonRecordProjectsV1, token: string, record_sha256: TriggerRunRowV1['record_sha256']) => {
  const projects = records.recordProjects({ access_token: token, record_sha256 });
  return projects.length === 1 ? Object.freeze({ kind: 'project' as const, project_id: projects[0]! }) : Object.freeze({ kind: 'global' as const });
};
function stored(json: string): StoredImpactCardV1 {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new AuthorityOperationError('unavailable', 'stored impact card is invalid'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as { schema_version?: unknown }).schema_version !== 1 ||
      !Array.isArray((value as { citations?: unknown }).citations) || !Array.isArray((value as { decided?: unknown }).decided) || !Array.isArray((value as { affected?: unknown }).affected) || !Array.isArray((value as { unconfirmed?: unknown }).unconfirmed)) {
    throw new AuthorityOperationError('unavailable', 'stored impact card is invalid');
  }
  return value as StoredImpactCardV1;
}
function unavailable(error: unknown): boolean {
  return error instanceof AuthorityOperationError && error.code === 'unavailable';
}

export function createPersonTriggerRunsV1(options: CreatePersonTriggerRunsV1Options): PersonTriggerRunsHttpApplicationV1 {
  const lease = options.lease_ms ?? LEASE_MS;
  const controllers = new Set<AbortController>();
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const context = (authorization: PersonAccessAuthorization): PersonLiveRequestContextV1 => ({
    authority_id: options.bind_options?.authority_id ?? '', organization_id: authorization.organization_id, state_lineage_id: options.bind_options?.state_lineage_id ?? '',
    principal_id: authorization.principal_id, membership_id: authorization.membership_id, session_family_id: authorization.session_family_id, request_id: `trigger_run_${randomUUID()}`,
  });
  const launch = (row: TriggerRunRowV1, token: string, authorization: PersonAccessAuthorization, lease_token: string) => {
    const controller = new AbortController(); controllers.add(controller);
    void (async () => {
      try {
        const anchor = options.records.recordAnchor({ access_token: token, record_sha256: row.record_sha256 });
        const scope = scopeFor(options.records, token, row.record_sha256);
        const requestContext = context(authorization);
        const desk = await options.bindDesk(options.bind_options ?? {} as BoundOptions, compatible, { access_token: token, scope, signal: controller.signal }, requestContext);
        const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'approved_record')!;
        const output = await options.research({ desk, context: requestContext }).renderWithResearch({ trigger: definition.name, brief: definition.brief(anchor), renderer: definition.renderer!, trigger_input: anchor, signal: controller.signal });
        const card = validatePersonImpactCardV1(output.rendered);
        const outsideLabels = output.research.items
          .filter(item => (item.citation as { readonly kind?: unknown }).kind !== 'approved_record' && (item.citation as { readonly kind?: unknown }).kind !== 'source_revision').map(item => item.title);
        const value = storableImpactCardV1(card, outsideLabels);
        options.runs.finish(row.run_id, lease_token, { json: canonicalJson(value), sha256: canonicalSha256(value) });
      } catch (error) {
        if (error instanceof PersonRecordSearchIndexLagV1) options.runs.release(row.run_id, lease_token, { counted: false });
        else if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'stale_access_state')) options.runs.fail(row.run_id, lease_token, 'no_access');
        else if (controller.signal.aborted || error instanceof AgenticAskDeadlineErrorV1) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'timed_out' });
        else if (unavailable(error)) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'unavailable' });
        else options.runs.fail(row.run_id, lease_token, 'research_failed');
      } finally { controllers.delete(controller); }
    })();
  };
  return Object.freeze({
    async list(input: Parameters<PersonTriggerRunsHttpApplicationV1['list']>[0]) {
      input.signal?.throwIfAborted(); const actor = actorOf(options.sessions.authenticateAccess({ access_token: input.access_token }));
      return Object.freeze({ runs: Object.freeze(options.runs.list(actor, 100).map(row => Object.freeze({ run_id: row.run_id, trigger: row.trigger, event_ref: row.event_ref, state: row.state, error_code: row.error_code, created_at: row.created_at, updated_at: row.updated_at }))) });
    },
    async start(input: Parameters<PersonTriggerRunsHttpApplicationV1['start']>[0]) {
      input.signal?.throwIfAborted(); const authorization = options.sessions.authenticateAccess({ access_token: input.access_token }); const actor = actorOf(authorization);
      const claim = options.runs.claim(actor, input.request.run_id, lease);
      if (claim.kind !== 'claimed') { if (claim.kind === 'not_found') throw new AuthorityOperationError('not_found', 'run is not available'); return Object.freeze({ state: claim.kind }); }
      const row = options.runs.read(actor, input.request.run_id); if (row === undefined) throw new AuthorityOperationError('not_found', 'run is not available');
      launch(row, input.access_token, authorization, claim.lease_token); return Object.freeze({ state: 'running' as const });
    },
    async retry(input: Parameters<PersonTriggerRunsHttpApplicationV1['retry']>[0]) {
      input.signal?.throwIfAborted(); const actor = actorOf(options.sessions.authenticateAccess({ access_token: input.access_token }));
      if (!options.runs.retry(actor, input.request.run_id)) throw new AuthorityOperationError('not_found', 'run is not available');
      return Object.freeze({ state: 'pending' as const });
    },
    async view(input: Parameters<PersonTriggerRunsHttpApplicationV1['view']>[0]) {
      input.signal?.throwIfAborted(); const authorization = options.sessions.authenticateAccess({ access_token: input.access_token }); const actor = actorOf(authorization);
      const row = options.runs.read(actor, input.request.run_id); if (row === undefined) throw new AuthorityOperationError('not_found', 'run is not available');
      if (!sameActor(row.actor, actor) || row.state !== 'done' || row.result_json === null) throw new AuthorityOperationError('not_found', 'run is not available');
      const card = stored(row.result_json); const scope = scopeFor(options.records, input.access_token, row.record_sha256); const requestContext = context(authorization);
      const desk = await options.bindDesk(options.bind_options ?? {} as BoundOptions, compatible, { access_token: input.access_token, scope, ...(input.signal === undefined ? {} : { signal: input.signal }) }, requestContext);
      const fresh = await Promise.all(card.citations.map(async citation => {
        try { const opened = await desk.openCitation!({ citation, ...(input.signal === undefined ? {} : { signal: input.signal }) }); const item = opened.items[0]; return item === undefined ? null : { citation: { citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility }, text: item.text, label: item.label, ...(item.attributes === undefined ? {} : { attributes: item.attributes }) } as FreshImpactItemV1; } catch { return null; }
      }));
      const refreshed = refreshImpactCardV1(card, fresh); await desk.revalidate({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return Object.freeze({ card: refreshed.card, checked_at: row.updated_at, hidden: refreshed.hidden });
    },
    close() { for (const controller of controllers) controller.abort(); },
  });
}
