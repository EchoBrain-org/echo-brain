import { withPersonAskSnapshotRetryV1 } from './person-ask-snapshot-retry-v1.js';
import { AgenticAskDeadlineErrorV1, createAgenticAskProgressRequestV1, createAgenticAskV2, createAgenticAskV3, createAgenticAskV4, type AgenticAskAnswerWithReceiptV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { PersonAnswerResponseV5, PersonAnswerResponseV6, PersonAnswerResponseV7 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import { randomUUID } from 'node:crypto';
import type { PersonLiveConnectorSourceV1 } from '../application/ports/person-context-live-runtime-v1.js';
import type { PersonAnswerV4HttpApplication } from '../presentation/person-answer-v4-http-application.js';
import type { PersonAnswerV5HttpApplication } from '../presentation/person-answer-v5-http-application.js';
import { askerOf, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonFollowUpsEvidenceSourceV1, type PersonFollowUpsSourcesV1 } from './person-follow-ups-evidence-v1.js';
import { createRegisteredPersonLiveEvidenceDeskV2, type RegisteredPersonLiveEvidenceSourceV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';
import { openItemViewerV1 } from './person-open-items-v1.js';

export interface CreatePersonLiveAnswerRouteOptionsV1 extends CreatePersonAnswerV3RouteOptions {
  readonly live_sources?: readonly PersonLiveConnectorSourceV1[];
  /** ECHO's shared follow-ups (ADR-0040). A desk binds them only for an answer that can cite them, outside Mine. */
  readonly follow_ups?: PersonFollowUpsSourcesV1;
}

/** The V7 answer, which may cite follow-ups (ADR-0040), on the V3 request. */
export interface PersonAnswerV7ApplicationV1 {
  ask(input: Parameters<PersonAnswerV5HttpApplication['ask']>[0]): Promise<PersonAnswerResponseV7>;
}

export interface PersonLiveRequestContextV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly session_family_id: string;
  readonly request_id: string;
}

/**
 * One request's evidence desk: ECHO context plus each compatible live source
 * bound to this person and scope. Ask and the staging research evaluation
 * compose it identically.
 */
export async function bindPersonLiveEvidenceDeskV1(
  options: CreatePersonLiveAnswerRouteOptionsV1,
  compatible: readonly PersonLiveConnectorSourceV1[],
  input: {
    readonly access_token: string; readonly scope: ReturnType<typeof scopeOf>; readonly signal?: AbortSignal;
    /** The answer the desk serves. Follow-ups bind only from V7; trigger research, open items and the evidence doors never pass one. */
    readonly response_version?: number;
  },
  context: PersonLiveRequestContextV1,
) {
  const { scope } = input;
  // Each binding verifies its own connection, so sources bind concurrently.
  // They register in catalog order, and the first failure in that order is
  // the request's failure, exactly as when they bound one after another.
  const settled = await Promise.allSettled(compatible.map(selected => {
    const category = selected.descriptor.kind === 'slack_message' ? 'slack' : selected.descriptor.kind;
    return observePersonLiveEvidenceV1('evidence_connection', category, async (): Promise<RegisteredPersonLiveEvidenceSourceV2 | undefined> => {
      if (scope.kind === 'mine' || !selected.scopes.includes(scope.kind)) { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
      const source = await selected.application.source({
        ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}),
        access_token: input.access_token, audit: options.audit.forLiveRequest(context),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.signal?.throwIfAborted();
      annotateCoreRuntimeV1({ result: source === undefined ? (scope.kind === 'project' ? 'unavailable' : 'unlinked') : 'verified' });
      return source === undefined ? undefined : { descriptor: selected.descriptor, source, scope };
    });
  }));
  const bound: RegisteredPersonLiveEvidenceSourceV2[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    if (result.value !== undefined) bound.push(result.value);
  }
  input.signal?.throwIfAborted();
  const base = createPersonEvidenceDeskV1({ access_token: input.access_token, scope, originals: options.originals, records: options.records });
  return createRegisteredPersonLiveEvidenceDeskV2(base, bound, followUpsFor(options, input, context));
}

/**
 * The follow-ups this request's desk binds (ADR-0040): for an answer that can
 * cite them, in a global or project scope, as the authenticated asker. Mine
 * reads only what the asker added, so it never binds them.
 */
function followUpsFor(options: CreatePersonLiveAnswerRouteOptionsV1, input: Parameters<typeof bindPersonLiveEvidenceDeskV1>[2], context: PersonLiveRequestContextV1) {
  const sources = options.follow_ups;
  const { scope } = input;
  if (sources === undefined || (input.response_version ?? 0) < FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 || scope.kind === 'mine') return undefined;
  const authenticate = () => options.sessions.authenticateAccess({ access_token: input.access_token });
  const viewer = openItemViewerV1(input.access_token, authenticate());
  if (viewer.organization !== context.organization_id || viewer.principal !== context.principal_id || viewer.membership !== context.membership_id) {
    throw new AuthorityOperationError('stale_access_state', 'Follow-ups belong to another person');
  }
  const audit = options.audit.forFollowUpRequest(context);
  return (desk: Parameters<typeof createPersonFollowUpsEvidenceSourceV1>[0]['desk']) => createPersonFollowUpsEvidenceSourceV1({ sources, viewer, authenticate, scope, desk, audit });
}

export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5): PersonAnswerV4HttpApplication;
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 6): PersonAnswerV5HttpApplication;
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 7): PersonAnswerV7ApplicationV1;
/** One authenticated request pipeline; version adapters only select compatible evidence/output. */
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5 | 6 | 7) {
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= response_version);
  type Input = Parameters<PersonAnswerV5HttpApplication['ask']>[0];
  type Progress = Pick<Parameters<NonNullable<PersonAnswerV5HttpApplication['askWithProgress']>>[0], 'on_start' | 'on_progress'>;
  /** A streamed V6 Ask (ADR-0039) also reports when it starts and what it does; every other request is unchanged. */
  async function run(input: Input): Promise<PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7>;
  async function run(input: Input, progress: Progress): Promise<AgenticAskAnswerWithReceiptV1>;
  async function run(input: Input, progress?: Progress) {
    // A streamed request spans every attempt a snapshot restart runs: one stream, each item named once, timed from here.
    const streamed = progress === undefined ? undefined : { on_progress: progress.on_progress, request: createAgenticAskProgressRequestV1() };
    const scope = scopeOf(input.request);
    input.signal?.throwIfAborted();
    const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
    const context = {
      authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
      principal_id: authorization.principal_id, membership_id: authorization.membership_id,
      session_family_id: authorization.session_family_id, request_id: `ask_${randomUUID()}`,
    };
    const capture = input.request.capture_id === undefined ? undefined : options.diagnostics?.claim({
      access_token: input.access_token, capture_id: input.request.capture_id, target: { kind: 'ask' },
    });
    if (input.request.capture_id !== undefined && capture === undefined) throw new AuthorityOperationError('unavailable', 'Diagnostic capture is not available');
    // Authenticated and validated: anything that fails from here on fails inside the stream.
    progress?.on_start();
    try {
      return await withPersonAskSnapshotRetryV1({ signal: input.signal, capture: capture !== undefined, run: async signal => {
        return await observePersonResearchV1({ trigger: 'ask', run_id: context.request_id, ...(capture === undefined ? {} : { capture }) }, async () => {
          const desk = await bindPersonLiveEvidenceDeskV1(options, compatible, { access_token: input.access_token, scope, response_version, signal }, context);
          capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
          const asker = askerOf(options, authorization);
          const askOptions = { ...(input.time_context === undefined ? {} : { time_context: input.time_context }), desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context),
            ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
          };
          // Each attempt audits what it named; only the released attempt's receipt is returned.
          if (streamed !== undefined) return createAgenticAskV3(askOptions).answerWithReceipt({ question: input.request.question, signal, ...streamed });
          const create = response_version === 7 ? createAgenticAskV4 : response_version === 6 ? createAgenticAskV3 : createAgenticAskV2;
          return create(askOptions).answer({ question: input.request.question, signal });
        });
      } });
    } catch (error) {
      if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) throw new AuthorityOperationError('unavailable', 'Ask deadline exhausted');
      throw error;
    }
  }
  return Object.freeze({
    ask: (input: Input) => run(input),
    // Only the V6 route streams: /v4 and the older routes never do.
    ...(response_version === 6 ? { askWithProgress: (input: Parameters<NonNullable<PersonAnswerV5HttpApplication['askWithProgress']>>[0]) => run(input, input) } : {}),
  });
}
