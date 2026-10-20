import { withPersonAskSnapshotRetryV1 } from './person-ask-snapshot-retry-v1.js';
import {
  AgenticAskDeadlineErrorV1, createAgenticAskProgressRequestV1, createAgenticAskV2, createAgenticAskV3, createAgenticAskV4, createAgenticAskV5,
  type AgenticAskAnswerWithReceiptV1, type AgenticAskAnswerWithReceiptV2, type AgenticAskAnswerWithReceiptV3,
  type AgenticAskProgressSinkV1, type AgenticAskProgressSinkV2, type AgenticAskProgressSinkV3,
} from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { PersonAnswerResponseV5, PersonAnswerResponseV6, PersonAnswerResponseV7, PersonAnswerResponseV8 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import { WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import { randomUUID } from 'node:crypto';
import type { PersonLiveConnectorSourceV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { samePersonV1 } from '../application/person-release-authorization-v1.js';
import type { PersonAnswerV4HttpApplication } from '../presentation/person-answer-v4-http-application.js';
import type { PersonAnswerV5HttpApplication } from '../presentation/person-answer-v5-http-application.js';
import type { PersonAnswerV6HttpApplication } from '../presentation/person-answer-v6-http-application.js';
import type { PersonAnswerV7HttpApplication } from '../presentation/person-answer-v7-http-application.js';
import { askerOf, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonFollowUpsEvidenceSourceV1, type PersonFollowUpsSourcesV1 } from './person-follow-ups-evidence-v1.js';
import { createRegisteredPersonLiveEvidenceDeskV2, type RegisteredPersonLiveEvidenceSourceV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';
import { openItemViewerV1 } from './person-open-items-v1.js';
import { createPersonWorkspaceEvidenceSourcesV1, type PersonWorkspaceSourcesV1 } from './person-workspace-evidence-v1.js';

export interface CreatePersonLiveAnswerRouteOptionsV1 extends CreatePersonAnswerV3RouteOptions {
  readonly live_sources?: readonly PersonLiveConnectorSourceV1[];
  /** ECHO's shared follow-ups (ADR-0040). A desk binds them only for an answer that can cite them, outside Mine. */
  readonly follow_ups?: PersonFollowUpsSourcesV1;
  /**
   * The asker's projects, people and tools (research tool contract v1). A desk binds them only for an answer that can
   * cite them, outside Mine.
   */
  readonly workspace?: PersonWorkspaceSourcesV1;
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
    /**
     * The answer the desk serves. Follow-ups bind only from V7 and the workspace only from V8; trigger research, open
     * items and the evidence doors never pass one.
     */
    readonly response_version?: number;
  },
  context: PersonLiveRequestContextV1,
) {
  const { scope } = input;
  // One release witness for the request's live sources: two sources on one connection (a tool's items and its containers)
  // share its sequence, so two empty releases in the same millisecond never write the same witness.
  const liveAudit = options.audit.forLiveRequest(context);
  // Each binding verifies its own connection, so sources bind concurrently.
  // They register in catalog order, and the first failure in that order is
  // the request's failure, exactly as when they bound one after another.
  const settled = await Promise.allSettled(compatible.map(selected => {
    const category = selected.descriptor.kind === 'slack_message' ? 'slack' : selected.descriptor.kind;
    return observePersonLiveEvidenceV1('evidence_connection', category, async (): Promise<RegisteredPersonLiveEvidenceSourceV2 | undefined> => {
      if (scope.kind === 'mine' || !selected.scopes.includes(scope.kind)) { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
      const source = await selected.application.source({
        ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}),
        access_token: input.access_token, audit: liveAudit,
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
  return createRegisteredPersonLiveEvidenceDeskV2(base, bound, followUpsFor(options, input, context), workspaceFor(options, input, context));
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
  const asker = authenticate();
  if (!samePersonV1(asker, context)) throw new AuthorityOperationError('stale_access_state', 'Follow-ups belong to another person');
  const viewer = openItemViewerV1(input.access_token, asker);
  const audit = options.audit.forFollowUpRequest(context);
  return (desk: Parameters<typeof createPersonFollowUpsEvidenceSourceV1>[0]['desk']) => createPersonFollowUpsEvidenceSourceV1({ sources, viewer, authenticate, scope, desk, audit });
}

/**
 * The workspace this request's desk binds (research tool contract v1): for an answer that can cite it, in a global or
 * project scope, as the authenticated asker. Mine reads only what the asker added, so it never binds it.
 */
function workspaceFor(options: CreatePersonLiveAnswerRouteOptionsV1, input: Parameters<typeof bindPersonLiveEvidenceDeskV1>[2], context: PersonLiveRequestContextV1) {
  const sources = options.workspace;
  const { scope } = input;
  if (sources === undefined || (input.response_version ?? 0) < WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 || scope.kind === 'mine') return undefined;
  const authenticate = () => options.sessions.authenticateAccess({ access_token: input.access_token });
  const asker = authenticate();
  if (!samePersonV1(asker, context)) throw new AuthorityOperationError('stale_access_state', 'The workspace belongs to another person');
  return createPersonWorkspaceEvidenceSourcesV1({ sources, access_token: input.access_token, authenticate, scope, audit: options.audit.forWorkspaceRequest(context) });
}

export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5): PersonAnswerV4HttpApplication;
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 6): PersonAnswerV5HttpApplication;
/** `/v6`: the V7 answer, which may read and cite follow-ups (ADR-0040), and streams its progress in V2. */
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 7): PersonAnswerV6HttpApplication;
/**
 * `/v7`: the V8 answer, which may also read and cite the asker's projects, people and tools and their connected tools'
 * containers (research tool contract v1), and streams its progress in V3.
 */
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 8): PersonAnswerV7HttpApplication;
/** One authenticated request pipeline; version adapters only select compatible evidence/output. */
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5 | 6 | 7 | 8) {
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= response_version);
  type Input = Parameters<PersonAnswerV5HttpApplication['ask']>[0];
  /** A V6 Ask's sink takes progress V1, a V7 Ask's progress V2 (ADR-0040), a V8 Ask's progress V3. */
  type Progress = { readonly on_start: () => void; readonly on_progress: AgenticAskProgressSinkV1 | AgenticAskProgressSinkV2 | AgenticAskProgressSinkV3 };
  /** A streamed V6, V7 or V8 Ask (ADR-0039) also reports when it starts and what it does; every other request is unchanged. */
  async function run(input: Input): Promise<PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7 | PersonAnswerResponseV8>;
  async function run(input: Input, progress: Progress): Promise<AgenticAskAnswerWithReceiptV1 | AgenticAskAnswerWithReceiptV2 | AgenticAskAnswerWithReceiptV3>;
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
          // The V8 answer streams progress V3, whose names may be workspace items and tool containers; the V7 answer
          // streams V2, whose names may be follow-ups; the V6 answer streams V1.
          if (streamed !== undefined) {
            const question = { question: input.request.question, signal, request: streamed.request };
            return response_version === 8
              ? createAgenticAskV5(askOptions).answerWithReceipt({ ...question, on_progress: streamed.on_progress as AgenticAskProgressSinkV3 })
              : response_version === 7
                ? createAgenticAskV4(askOptions).answerWithReceipt({ ...question, on_progress: streamed.on_progress as AgenticAskProgressSinkV2 })
                : createAgenticAskV3(askOptions).answerWithReceipt({ ...question, on_progress: streamed.on_progress as AgenticAskProgressSinkV1 });
          }
          const create = response_version === 8 ? createAgenticAskV5 : response_version === 7 ? createAgenticAskV4 : response_version === 6 ? createAgenticAskV3 : createAgenticAskV2;
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
    // Only the /v5 (V6), /v6 (V7) and /v7 (V8) routes stream: /v4 and the older routes never do.
    // A method, so each version's application, with its own progress sink, is this one.
    ...(response_version >= 6 ? { askWithProgress(input: Input & Progress) { return run(input, input); } } : {}),
  });
}
