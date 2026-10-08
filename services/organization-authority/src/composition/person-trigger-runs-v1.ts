import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerCitationV6, validatePersonImpactCardV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
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
type RunResearch = Pick<ReturnType<typeof import('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1').createAgenticResearchV1>, 'renderWithResearch'>;
type BoundOptions = CreatePersonLiveAnswerRouteOptionsV1;

export interface CreatePersonTriggerRunsV1Options {
  readonly runs: SqliteTriggerRunsV1;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly records: PersonRecordAnchorV1 & PersonRecordProjectsV1;
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
function stored(json: string): StoredImpactCardV1 {
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

export function createPersonTriggerRunsV1(options: CreatePersonTriggerRunsV1Options): PersonTriggerRunsHttpApplicationV1 {
  const lease = options.lease_ms ?? LEASE_MS;
  const controllers = new Set<AbortController>();
  let closing = false;
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const context = (authorization: PersonAccessAuthorization): PersonLiveRequestContextV1 => ({
    authority_id: options.bind_options.authority_id, organization_id: authorization.organization_id, state_lineage_id: options.bind_options.state_lineage_id,
    principal_id: authorization.principal_id, membership_id: authorization.membership_id, session_family_id: authorization.session_family_id, request_id: `trigger_run_${randomUUID()}`,
  });
  const launch = (row: TriggerRunRowV1, token: string, authorization: PersonAccessAuthorization, lease_token: string) => {
    const controller = new AbortController(); controllers.add(controller);
    void (async () => {
      try {
        const record_sha256 = row.record_sha256;
        if (row.trigger !== 'approved_record' || record_sha256 === null) throw new Error('sweep runs are not served yet');
        const anchor = options.records.recordAnchor({ access_token: token, record_sha256 });
        const scope = scopeFor(options.records, token, record_sha256);
        const requestContext = context(authorization);
        const desk = await options.bindDesk(options.bind_options, compatible, { access_token: token, scope, signal: controller.signal }, requestContext);
        const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'approved_record')!;
        const event = definition.parseEvent({ record: anchor });
        const output = await options.research({ desk, context: requestContext }).renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event, signal: controller.signal });
        const card = validatePersonImpactCardV1(output.rendered);
        const outsideLabels = output.research.items
          .filter(item => (item.citation as { readonly kind?: unknown }).kind !== 'approved_record' && (item.citation as { readonly kind?: unknown }).kind !== 'source_revision').map(item => item.title);
        const value = storableImpactCardV1(card, outsideLabels);
        if (closing && controller.signal.aborted) return;
        options.runs.finish(row.run_id, lease_token, { json: canonicalJson(value), sha256: canonicalSha256(value) });
      } catch (error) {
        if (closing && controller.signal.aborted) return;
        if (error instanceof PersonRecordSearchIndexLagV1) options.runs.release(row.run_id, lease_token, { counted: false });
        else if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'stale_access_state' || error.code === 'not_found')) options.runs.fail(row.run_id, lease_token, 'no_access');
        else if (controller.signal.aborted || error instanceof AgenticAskDeadlineErrorV1) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'timed_out' });
        else if (unavailable(error)) options.runs.release(row.run_id, lease_token, { counted: true, exhausted: 'unavailable' });
        else options.runs.fail(row.run_id, lease_token, 'research_failed');
      } finally { controllers.delete(controller); }
    })();
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
      const record_sha256 = impactRecord(row);
      const card = stored(row.result_json); const scope = scopeFor(options.records, input.access_token, record_sha256); const requestContext = context(authorization);
      const desk = await options.bindDesk(options.bind_options, compatible, { access_token: input.access_token, scope, ...(input.signal === undefined ? {} : { signal: input.signal }) }, requestContext);
      const fresh = await Promise.all(card.citations.map(async citation => {
        try { const opened = await desk.openCitation!({ citation, ...(input.signal === undefined ? {} : { signal: input.signal }) }); const item = opened.items[0]; return item === undefined ? null : { citation: { citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility }, text: item.text, label: item.label, ...(item.attributes === undefined ? {} : { attributes: item.attributes }) } as FreshImpactItemV1; } catch { return null; }
      }));
      const refreshed = refreshImpactCardV1(card, fresh); await desk.revalidate({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return Object.freeze({ card: refreshed.card, checked_at: row.updated_at, hidden: refreshed.hidden });
    },
    close() { closing = true; for (const controller of controllers) controller.abort(); },
  });
}
