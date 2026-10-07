import { AgenticAskDeadlineErrorV1, createAgenticAskV2, createAgenticAskV3 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { randomUUID } from 'node:crypto';
import type { PersonLiveConnectorSourceV1 } from '../application/ports/person-context-live-runtime-v1.js';
import type { PersonAnswerV4HttpApplication } from '../presentation/person-answer-v4-http-application.js';
import type { PersonAnswerV5HttpApplication } from '../presentation/person-answer-v5-http-application.js';
import { askerOf, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createRegisteredPersonLiveEvidenceDeskV2, type RegisteredPersonLiveEvidenceSourceV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';

export interface CreatePersonLiveAnswerRouteOptionsV1 extends Omit<CreatePersonAnswerV3RouteOptions, 'ask_journey_telemetry'> {
  readonly live_sources?: readonly PersonLiveConnectorSourceV1[];
}

/** Every live source this route was composed with. */
export function configuredPersonLiveSourcesV1(options: CreatePersonLiveAnswerRouteOptionsV1): readonly PersonLiveConnectorSourceV1[] {
  return options.live_sources ?? [];
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
  input: { readonly access_token: string; readonly scope: ReturnType<typeof scopeOf>; readonly signal?: AbortSignal },
  context: PersonLiveRequestContextV1,
) {
  const { scope } = input;
  const bound: RegisteredPersonLiveEvidenceSourceV2[] = [];
  for (const selected of compatible) {
    const category = selected.descriptor.kind === 'slack_message' ? 'slack' : selected.descriptor.kind;
    await observePersonLiveEvidenceV1('evidence_connection', category, async () => {
      if (scope.kind === 'mine' || !selected.scopes.includes(scope.kind)) { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return; }
      const source = await selected.application.source({
        ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}),
        access_token: input.access_token, audit: options.audit.forLiveRequest(context),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.signal?.throwIfAborted();
      annotateCoreRuntimeV1({ result: source === undefined ? (scope.kind === 'project' ? 'unavailable' : 'unlinked') : 'verified' });
      if (source !== undefined) bound.push({ descriptor: selected.descriptor, source, scope });
    });
  }
  const base = createPersonEvidenceDeskV1({ access_token: input.access_token, scope, originals: options.originals, records: options.records });
  return createRegisteredPersonLiveEvidenceDeskV2(base, bound);
}

export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5): PersonAnswerV4HttpApplication;
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 6): PersonAnswerV5HttpApplication;
/** One authenticated request pipeline; version adapters only select compatible evidence/output. */
export function createPersonLiveAnswerRouteV1(options: CreatePersonLiveAnswerRouteOptionsV1, response_version: 5 | 6) {
  const compatible = configuredPersonLiveSourcesV1(options).filter(source => source.minimum_response_version <= response_version);
  return Object.freeze({
    async ask(input: Parameters<PersonAnswerV5HttpApplication['ask']>[0]) {
      const scope = scopeOf(input.request);
      input.signal?.throwIfAborted();
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      const context = {
        authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
        principal_id: authorization.principal_id, membership_id: authorization.membership_id,
        session_family_id: authorization.session_family_id, request_id: `ask_${randomUUID()}`,
      };
      const desk = await bindPersonLiveEvidenceDeskV1(options, compatible, { access_token: input.access_token, scope, ...(input.signal === undefined ? {} : { signal: input.signal }) }, context);
      const asker = askerOf(options, authorization);
      try {
        const create = response_version === 6 ? createAgenticAskV3 : createAgenticAskV2;
        const response = await create({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context),
          ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
        }).answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
        annotateCoreRuntimeV1({ result: response.outcome });
        return response;
      } catch (error) {
        if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) throw new AuthorityOperationError('unavailable', 'Ask deadline exhausted');
        throw error;
      }
    },
  });
}
