import { randomUUID } from 'node:crypto';
import type { PersonResearchEvalReadResponseV1 } from '@echo-brain/organization-api';
import {
  AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  AgenticAskDeadlineErrorV1,
  createAgenticResearchV1,
  type AgenticResearchResultV1,
} from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { askerOf, scopeOf } from './person-answer-v3-route.js';
import { bindPersonLiveEvidenceDeskV1, configuredPersonLiveSourcesV1, type CreatePersonLiveAnswerRouteOptionsV1 } from './person-live-answer-route-v1.js';
import type { PersonResearchEvalHttpApplicationV1 } from '../presentation/person-research-eval-http-application.js';

export type { PersonResearchEvalHttpApplicationV1 } from '../presentation/person-research-eval-http-application.js';

/** Completed results wait this long for the runner, then are dropped unread. */
export const PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 = 15 * 60_000;
/** After a result is first read it stays this long, so a lost response can be read again. */
export const PERSON_RESEARCH_EVAL_REREAD_MS_V1 = 60_000;
const PURGE_INTERVAL_MS = 60_000;

export interface CreatePersonResearchEvalOptionsV1 extends CreatePersonLiveAnswerRouteOptionsV1 {
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
  error?: NonNullable<PersonResearchEvalReadResponseV1['error']>;
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

function failure(error: unknown): NonNullable<PersonResearchEvalReadResponseV1['error']> {
  const code = error instanceof AgenticAskDeadlineErrorV1 ? 'timed_out'
    : error instanceof AuthorityOperationError && Object.hasOwn(FAILURE_MESSAGES, error.code) ? error.code : 'unavailable';
  return Object.freeze({ code, message: FAILURE_MESSAGES[code]! });
}

/**
 * Staging-only research evaluation (research loop evaluation v1). Each person
 * may run one trigger at a time; its result lives only in this process's
 * memory until read once or until it expires. Nothing is written to disk,
 * telemetry or logs beyond the loop's existing content-free audit. The named
 * trigger definition turns the request's input into a brief.
 */
export function createPersonResearchEvalV1(options: CreatePersonResearchEvalOptionsV1): PersonResearchEvalHttpApplicationV1 {
  const now = options.now ?? (() => Date.now());
  const compatible = configuredPersonLiveSourcesV1(options).filter(source => source.minimum_response_version <= 6);
  const runs = new Map<string, Run>();
  const purge = () => {
    const current = now();
    for (const [id, run] of runs) if (run.status !== 'running' && run.expires_at <= current) runs.delete(id);
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
      const defined = definition.brief(definition.parseEvent(request.input));
      // Only a person's question reads their own additions alone; a task's starting items are shared evidence.
      if (request.mine === true && defined.goal.kind !== 'question') throw new AuthorityOperationError('invalid_request', 'Research evaluation scope is invalid');
      purge();
      if ([...runs.values()].some(run => run.owner === owner && run.status === 'running')) {
        throw new AuthorityOperationError('conflict', 'A research run is already running for this person');
      }
      const scope = scopeOf(request);
      const runId = `rr_${randomUUID()}`;
      const run: Run = { owner, controller: new AbortController(), status: 'running', expires_at: Number.POSITIVE_INFINITY };
      runs.set(runId, run);
      const context = {
        authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
        principal_id: authorization.principal_id, membership_id: authorization.membership_id,
        session_family_id: authorization.session_family_id, request_id: `research_${randomUUID()}`,
      };
      const brief = request.budget === undefined ? defined : { ...defined, budget: request.budget === 'live' ? AGENTIC_RESEARCH_LIVE_BUDGET_V1 : AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 };
      const signal = run.controller.signal;
      // The run outlives this request: it is bound to its own controller, not the caller's connection.
      void (async () => {
        try {
          const desk = await bindPersonLiveEvidenceDeskV1(options, compatible, { access_token: input.access_token, scope, signal }, context);
          run.revalidate = readSignal => desk.revalidate({ ...(readSignal === undefined ? {} : { signal: readSignal }) });
          const asker = askerOf(options, authorization);
          // Runs exactly as served: the brief asks for the small-scope preload where the deployment allows it.
          const loop = createAgenticResearchV1({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context),
            ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}) });
          if (brief.goal.kind === 'question') {
            // A question is Ask's: its writer answers it.
            const output = await loop.answerWithResearch({ question: brief.goal.question, budget: brief.budget, signal });
            run.research = output.research;
            run.ask = Object.freeze({ writer_evidence: output.writer_evidence, response: output.response });
          } else {
            run.research = await loop.research({ trigger: definition.name, brief, signal });
          }
          run.status = 'completed';
        } catch (error) {
          run.error = failure(error);
          run.status = 'failed';
        } finally {
          run.expires_at = now() + PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1;
        }
      })();
      return Object.freeze({ schema_version: 1 as const, kind: 'echo-person-research-eval-run-v1' as const, run_id: runId, status: 'running' as const });
    },
    async read(input) {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      purge();
      const run = runs.get(input.request.run_id);
      if (run === undefined || run.owner !== ownerOf(authorization)) throw new AuthorityOperationError('not_found', 'Research run is not available');
      const base = { schema_version: 1 as const, kind: 'echo-person-research-eval-result-v1' as const, run_id: input.request.run_id };
      if (run.status === 'running') return Object.freeze({ ...base, status: 'running' as const });
      // A delivered result can be read again briefly if its response was lost, then it is dropped.
      run.expires_at = Math.min(run.expires_at, now() + PERSON_RESEARCH_EVAL_REREAD_MS_V1);
      if (run.status === 'failed') return Object.freeze({ ...base, status: 'failed' as const, error: run.error! });
      // Access is rechecked before evidence leaves the Authority, as for every Ask response.
      try { await run.revalidate!(input.signal); }
      catch (error) {
        runs.delete(input.request.run_id);
        const fenced = failure(error);
        return Object.freeze({ ...base, status: 'failed' as const, error: fenced.code === 'unavailable' ? Object.freeze({ code: 'stale_access_state', message: FAILURE_MESSAGES.stale_access_state! }) : fenced });
      }
      return Object.freeze({ ...base, status: 'completed' as const, research: JSON.parse(JSON.stringify(run.research)) as Readonly<Record<string, unknown>>, ...(run.ask === undefined ? {} : { ask: run.ask }) });
    },
    close() {
      clearInterval(sweeper);
      for (const run of runs.values()) if (run.status === 'running') run.controller.abort();
      runs.clear();
    },
  });
}
