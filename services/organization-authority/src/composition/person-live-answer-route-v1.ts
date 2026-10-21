import {
  createAgenticAskProgressRequestV1, createAgenticAskV2, createAgenticAskV3, createAgenticAskV4, createAgenticAskV5,
  type AgenticAskAnswerWithReceiptV2, type AgenticAskAnswerWithReceiptV3, type AgenticAskProgressSinkV2, type AgenticAskProgressSinkV3,
} from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { PersonAnswerResponseV5, PersonAnswerResponseV6, PersonAnswerResponseV7, PersonAnswerResponseV8 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import { WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import type { PersonLiveConnectorSourceV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { samePersonV1 } from '../application/person-release-authorization-v1.js';
import type {
  PersonAnswerHttpInputV1, PersonAnswerV4HttpApplication, PersonAnswerV5HttpApplication, PersonAnswerV6HttpApplication, PersonAnswerV7HttpApplication,
} from '../presentation/person-live-answer-http-application.js';
import { askerOf, runPersonAskV1, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonFollowUpsEvidenceSourceV1, type PersonFollowUpsSourcesV1 } from './person-follow-ups-evidence-v1.js';
import { createRegisteredPersonLiveEvidenceDeskV2, type RegisteredPersonLiveEvidenceSourceV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';
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
  const settled = await Promise.allSettled(compatible.map(selected =>
    observePersonLiveEvidenceV1('evidence_connection', selected.descriptor.kind, async (): Promise<RegisteredPersonLiveEvidenceSourceV2 | undefined> => {
      if (scope.kind === 'mine' || !selected.scopes.includes(scope.kind)) { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
      const source = await selected.application.source({
        ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}),
        access_token: input.access_token, audit: liveAudit,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.signal?.throwIfAborted();
      annotateCoreRuntimeV1({ result: source === undefined ? (scope.kind === 'project' ? 'unavailable' : 'unlinked') : 'verified' });
      return source === undefined ? undefined : { descriptor: selected.descriptor, source, scope };
    })));
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

/** The application each answer version's route serves, `/v4` (the V5 answer) to `/v7` (the V8 answer). */
interface PersonLiveAnswerRoutesV1 {
  readonly 5: PersonAnswerV4HttpApplication;
  readonly 6: PersonAnswerV5HttpApplication;
  readonly 7: PersonAnswerV6HttpApplication;
  readonly 8: PersonAnswerV7HttpApplication;
}
/** One authenticated request pipeline; version adapters only select compatible evidence/output. */
export function createPersonLiveAnswerRouteV1<Version extends keyof PersonLiveAnswerRoutesV1>(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: Version): PersonLiveAnswerRoutesV1[Version] {
  const compatible = (options.live_sources ?? []).filter(source => source.minimum_response_version <= response_version);
  type Input = PersonAnswerHttpInputV1;
  /** A V7 Ask's sink takes progress V2 (ADR-0040), a V8 Ask's progress V3. */
  type Progress = { readonly on_start: () => void; readonly on_progress: AgenticAskProgressSinkV2 | AgenticAskProgressSinkV3 };
  /** A streamed V7 or V8 Ask (ADR-0039) also reports when it starts and what it does; every other request is unchanged. */
  async function run(input: Input): Promise<PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7 | PersonAnswerResponseV8>;
  async function run(input: Input, progress: Progress): Promise<AgenticAskAnswerWithReceiptV2 | AgenticAskAnswerWithReceiptV3>;
  async function run(input: Input, progress?: Progress) {
    // A streamed request spans every attempt a snapshot restart runs: one stream, each item named once, timed from here.
    const streamed = progress === undefined ? undefined : { on_progress: progress.on_progress, request: createAgenticAskProgressRequestV1() };
    const scope = scopeOf(input.request);
    input.signal?.throwIfAborted();
    // Authenticated and validated once it starts: anything that fails from then on fails inside the stream.
    return runPersonAskV1(options, input, async ({ authorization, context, capture, signal }) => {
      const desk = await bindPersonLiveEvidenceDeskV1(options, compatible, { access_token: input.access_token, scope, response_version, signal }, context);
      capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
      const asker = askerOf(options, authorization);
      const askOptions = { ...(options.research_driver === undefined ? {} : { research_driver: options.research_driver }), ...(input.time_context === undefined ? {} : { time_context: input.time_context }), desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context),
        ...(asker === undefined ? {} : { asker }),
      };
      // Each attempt audits what it named; only the released attempt's receipt is returned.
      // The V8 answer streams progress V3, whose names may be workspace items and tool containers; the V7 answer
      // streams V2, whose names may be follow-ups.
      if (streamed !== undefined) {
        const question = { question: input.request.question, signal, request: streamed.request };
        return response_version === 8
          ? createAgenticAskV5(askOptions).answerWithReceipt({ ...question, on_progress: streamed.on_progress as AgenticAskProgressSinkV3 })
          : createAgenticAskV4(askOptions).answerWithReceipt({ ...question, on_progress: streamed.on_progress as AgenticAskProgressSinkV2 });
      }
      const create = response_version === 8 ? createAgenticAskV5 : response_version === 7 ? createAgenticAskV4 : response_version === 6 ? createAgenticAskV3 : createAgenticAskV2;
      return create(askOptions).answer({ question: input.request.question, signal });
    }, progress === undefined ? undefined : () => progress.on_start());
  }
  return Object.freeze({
    ask: (input: Input) => run(input),
    // Only the /v6 (V7) and /v7 (V8) routes stream: /v5, whose progress V1 was retired, and the older routes never do.
    // A method, so each version's application, with its own progress sink, is this one.
    ...(response_version >= 7 ? { askWithProgress(input: Input & Progress) { return run(input, input); } } : {}),
  }) as PersonLiveAnswerRoutesV1[Version];
}
