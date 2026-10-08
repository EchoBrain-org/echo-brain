import { randomUUID } from 'node:crypto';
import { validatePersonImpactCardV1, type PersonResearchEvalReadResponseV1 } from '@echo-brain/organization-api';
import {
  AGENTIC_RESEARCH_BUDGETS_V1,
  AgenticAskDeadlineErrorV1,
  createAgenticResearchV1,
  type AgenticResearchResultV1,
} from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAskScopeV2 } from '../application/ports/person-original-context-retrieval-v1.js';
import { askerOf, scopeOf } from './person-answer-v3-route.js';
import { bindPersonLiveEvidenceDeskV1, type CreatePersonLiveAnswerRouteOptionsV1 } from './person-live-answer-route-v1.js';
import type { PersonRecordProjectsV1 } from './person-record-search-route.js';
import type { PersonResearchEvalHttpApplicationV1 } from '../presentation/person-research-eval-http-application.js';
import { createPersonResearchEvalTraceV1, type PersonResearchEvalTraceCollectorV1 } from './person-research-eval-trace-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';

export type { PersonResearchEvalHttpApplicationV1 } from '../presentation/person-research-eval-http-application.js';

/** Completed results wait this long for the runner, then are dropped unread. */
export const PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 = 15 * 60_000;
/** After a result is first read it stays this long, so a lost response can be read again. */
export const PERSON_RESEARCH_EVAL_REREAD_MS_V1 = 60_000;
const PURGE_INTERVAL_MS = 60_000;

export interface CreatePersonResearchEvalOptionsV1 extends CreatePersonLiveAnswerRouteOptionsV1 {
  /** The desk's records, plus where an approved record's run reads. */
  readonly records: CreatePersonLiveAnswerRouteOptionsV1['records'] & PersonRecordProjectsV1;
  /** Wall clock for result expiry; tests pin it. */
  readonly now?: () => number;
}

type Run = {
  readonly owner: string;
  readonly controller: AbortController;
  status: 'running' | 'completed' | 'failed';
  expires_at: number;
  /** The run's own access fence, rechecked before its evidence is released to the reader. */
  revalidate?: (signal?: AbortSignal) => Promise<unknown>;
  research?: AgenticResearchResultV1;
  ask?: NonNullable<PersonResearchEvalReadResponseV1['ask']>;
  rendered?: NonNullable<PersonResearchEvalReadResponseV1['rendered']>;
  error?: NonNullable<PersonResearchEvalReadResponseV1['error']>;
  /** Opt-in only; never a runtime log or a durable audit record. */
  trace?: PersonResearchEvalTraceCollectorV1;
};

const FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  conflict: 'The research run conflicted with another operation',
  invalid_request: 'The research run request was not valid for this evidence',
  invalid_output: 'A source returned output the research run could not use',
  not_found: 'Starting evidence is not available',
  stale_access_state: 'Access changed while research was running',
  unauthorized: 'The research run is not permitted for this evidence',
  rate_limited: 'A source rate limited the research run',
  quota_exceeded: 'A source quota stopped the research run',
  unavailable: 'The research run could not be completed',
  timed_out: 'The research run reached its deadline',
});

/** An approved record's project when it is in exactly one the person can read; otherwise everything they can read. */
function recordScope(records: PersonRecordProjectsV1, access_token: string, citation: unknown): PersonAskScopeV2 {
  const record = citation as { readonly kind?: unknown; readonly record_sha256?: unknown } | undefined;
  if (record?.kind !== 'approved_record' || typeof record.record_sha256 !== 'string') throw new AuthorityOperationError('invalid_request', 'Research evaluation record is invalid');
  const projects = records.recordProjects({ access_token, record_sha256: record.record_sha256 as `sha256:${string}` });
  return projects.length === 1 ? Object.freeze({ kind: 'project' as const, project_id: projects[0]! }) : Object.freeze({ kind: 'global' as const });
}

function failure(error: unknown): NonNullable<PersonResearchEvalReadResponseV1['error']> {
  const code = error instanceof AgenticAskDeadlineErrorV1 ? 'timed_out'
    : error instanceof AuthorityOperationError && Object.hasOwn(FAILURE_MESSAGES, error.code) ? error.code : 'unavailable';
  return Object.freeze({ code, message: FAILURE_MESSAGES[code]! });
}

/**
 * Staging-only research evaluation (research loop evaluation v1). Each person
 * may run one trigger at a time; its result lives only in this process's
 * memory until read once or until it expires. Operational metadata uses the
 * shared trace core; payloads stay out of logs and durable audit. The named
 * trigger definition turns the request's input into a brief. A result carries
 * the trimmed bundle, plus Ask's answer for a question or the rendered result
 * of a trigger with a renderer.
 */
export function createPersonResearchEvalV1(options: CreatePersonResearchEvalOptionsV1): PersonResearchEvalHttpApplicationV1 {
  const now = options.now ?? (() => Date.now());
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= 6);
  const runs = new Map<string, Run>();
  const purge = () => {
    const current = now();
    for (const [id, run] of runs) if (run.status !== 'running' && run.expires_at <= current) { run.trace?.close(); runs.delete(id); }
  };
  // Released text never outlives its expiry just because no further request arrives.
  const sweeper = setInterval(purge, PURGE_INTERVAL_MS);
  sweeper.unref?.();
  const ownerOf = (authorization: { readonly principal_id: string; readonly membership_id: string }) => `${authorization.principal_id}\u0000${authorization.membership_id}`;

  return Object.freeze<PersonResearchEvalHttpApplicationV1>({
    async start(input) {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      const owner = ownerOf(authorization);
      const request = input.request;
      const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === request.trigger);
      if (definition === undefined) throw new AuthorityOperationError('invalid_request', 'Research evaluation trigger is not known');
      // The definition refuses an event it cannot run, before any run starts.
      const event = definition.parseEvent(request.input);
      const defined = definition.brief(event);
      // Ask's writer runs Ask's own brief, rebuilt from the question: anything more in a question brief would be dropped, so it is refused.
      if (defined.goal.kind === 'question' && (defined.starting.length > 0 || !defined.options.small_scope_preload)) throw new AuthorityOperationError('invalid_request', 'Research evaluation brief is invalid');
      // Only a person's question reads their own additions alone; a task's starting items are shared evidence.
      // A record's run reads where the record is, so its request names no scope.
      if ((request.mine === true && defined.goal.kind !== 'question') || (definition.scope === 'record_project' && (request.mine === true || request.project_id !== undefined))) {
        throw new AuthorityOperationError('invalid_request', 'Research evaluation scope is invalid');
      }
      purge();
      if ([...runs.values()].some(run => run.owner === owner && run.status === 'running')) {
        throw new AuthorityOperationError('conflict', 'A research run is already running for this person');
      }
      const requested = definition.scope === 'requested' ? scopeOf(request) : undefined;
      const runId = `rr_${randomUUID()}`;
      const run: Run = { owner, controller: new AbortController(), status: 'running', expires_at: Number.POSITIVE_INFINITY,
        ...(request.capture_trace === true ? { trace: createPersonResearchEvalTraceV1(now) } : {}) };
      runs.set(runId, run);
      const context = {
        authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
        principal_id: authorization.principal_id, membership_id: authorization.membership_id,
        session_family_id: authorization.session_family_id, request_id: runId,
      };
      const brief = request.budget === undefined ? defined : { ...defined, budget: AGENTIC_RESEARCH_BUDGETS_V1[request.budget] };
      const signal = run.controller.signal;
      // The run outlives this request: it is bound to its own controller, not the caller's connection.
      void observePersonResearchV1({ trigger: definition.name, run_id: runId, detached: true,
        ...(run.trace === undefined ? {} : { capture: { record: run.trace.record, complete: run.trace.seal, fail: run.trace.seal } }),
      }, async () => {
        try {
          // The record's scope is looked up with the person's own access before the desk exists; an unreadable record stops here.
          const scope = requested ?? recordScope(options.records, input.access_token, brief.starting[0]?.citation);
          const desk = await bindPersonLiveEvidenceDeskV1(options, compatible, { access_token: input.access_token, scope, signal }, context);
          run.revalidate = readSignal => desk.revalidate({ ...(readSignal === undefined ? {} : { signal: readSignal }) });
          const asker = askerOf(options, authorization);
          // Runs exactly as served: the brief asks for the small-scope preload where the deployment allows it.
          const loop = createAgenticResearchV1({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context),
            ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
          });
          if (brief.goal.kind === 'question') {
            // A question is Ask's: its writer answers it.
            const output = await loop.answerWithResearch({ question: brief.goal.question, budget: brief.budget, signal });
            run.research = output.research;
            run.ask = Object.freeze({ writer_evidence: output.writer_evidence, response: output.response });
          } else if (definition.renderer !== undefined) {
            // A task with a renderer: its result (the impact card, the one renderer a definition carries) and the trimmed bundle it was written from.
            const output = await loop.renderWithResearch({ trigger: definition.name, brief, renderer: definition.renderer, trigger_input: event, signal });
            run.research = output.research;
            run.rendered = validatePersonImpactCardV1(output.rendered);
          } else {
            run.research = await loop.research({ trigger: definition.name, brief, signal });
          }
          run.status = 'completed';
        } catch (error) {
          run.error = failure(error);
          // Once access is known to be invalid, do not retain already gathered
          // trace content waiting for a later access state to change again.
          if (run.error.code === 'unauthorized' || run.error.code === 'stale_access_state') { run.trace?.close(); delete run.trace; }
          run.status = 'failed';
          throw error;
        } finally {
          run.expires_at = now() + PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1;
        }
      }).catch(() => undefined); // The terminal failure is retained above for its authenticated reader.
      return Object.freeze({ schema_version: 1 as const, kind: 'echo-person-research-eval-run-v1' as const, run_id: runId, status: 'running' as const });
    },
    async read(input) {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      purge();
      const run = runs.get(input.request.run_id);
      if (run === undefined || run.owner !== ownerOf(authorization)) throw new AuthorityOperationError('not_found', 'Research run is not available');
      const base = { schema_version: 1 as const, kind: 'echo-person-research-eval-result-v1' as const, run_id: input.request.run_id };
      if (run.status === 'running') return Object.freeze({ ...base, status: 'running' as const });
      if (run.status === 'failed' && (run.trace === undefined || run.revalidate === undefined)) {
        // A failure before the desk's fence exists cannot release any trace.
        run.trace?.close(); delete run.trace;
        run.expires_at = Math.min(run.expires_at, now() + PERSON_RESEARCH_EVAL_REREAD_MS_V1);
        return Object.freeze({ ...base, status: 'failed' as const, error: run.error! });
      }
      // Access is rechecked before evidence leaves the Authority, as for every Ask response.
      try { await run.revalidate!(input.signal); }
      catch (error) {
        const accessFailure = error instanceof AuthorityOperationError && ['unauthorized', 'stale_access_state', 'not_found'].includes(error.code);
        if (!accessFailure && input.signal?.aborted && (error === input.signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw error;
        run.trace?.close();
        runs.delete(input.request.run_id);
        const fenced = failure(error);
        return Object.freeze({ ...base, status: 'failed' as const, error: fenced.code === 'unavailable' ? Object.freeze({ code: 'stale_access_state', message: FAILURE_MESSAGES.stale_access_state! }) : fenced });
      }
      // A close or expiry while the access check was in flight must not revive
      // a removed run or release its retained content.
      if (runs.get(input.request.run_id) !== run || run.expires_at <= now()) {
        run.trace?.close(); runs.delete(input.request.run_id);
        throw new AuthorityOperationError('not_found', 'Research run is not available');
      }
      input.signal?.throwIfAborted();
      // Source revalidation uses the execution session; recheck this reader too.
      try {
        if (ownerOf(options.sessions.authenticateAccess({ access_token: input.access_token })) !== run.owner) {
          throw new AuthorityOperationError('unauthorized', 'Research run is not available');
        }
      } catch (error) { run.trace?.close(); runs.delete(input.request.run_id); throw error; }
      // Only a delivered result starts the short, non-extending reread window.
      run.expires_at = Math.min(run.expires_at, now() + PERSON_RESEARCH_EVAL_REREAD_MS_V1);
      const trace = run.trace === undefined ? {} : { trace: run.trace.snapshot() };
      if (run.status === 'failed') return Object.freeze({ ...base, status: 'failed' as const, error: run.error!, ...trace });
      return Object.freeze({ ...base, status: 'completed' as const, research: JSON.parse(JSON.stringify(run.research)) as Readonly<Record<string, unknown>>,
        ...(run.ask === undefined ? {} : { ask: run.ask }), ...(run.rendered === undefined ? {} : { rendered: run.rendered }), ...trace });
    },
    close() {
      clearInterval(sweeper);
      for (const run of runs.values()) { run.trace?.close(); if (run.status === 'running') run.controller.abort(); }
      runs.clear();
    },
  });
}
