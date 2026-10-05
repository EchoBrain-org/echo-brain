import type { PersonAnswerResponseV6, PersonPageCitationV1, PersonSlackMessageCitationV1, PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1, createAgenticAskV3 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceCitationV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { randomUUID } from 'node:crypto';
import type { PersonAnswerV5HttpApplication } from '../presentation/person-answer-v5-http-application.js';
import { askerOf, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonLiveEvidenceDeskV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';

export interface CreatePersonAnswerV5RouteOptions extends Omit<CreatePersonAnswerV3RouteOptions, 'ask_journey_telemetry'> {
  readonly ticket_for?: (input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined>;
  readonly page_for?: (input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonPageCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonPageCitationV1> | undefined>;
  readonly slack_live_for?: (input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonSlackMessageCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonSlackMessageCitationV1> | undefined>;
}

/**
 * An additive request-local Ask route for live knowledge-page sections.
 * Provider selection stays in composition; the agent sees only opaque desk ids.
 */
export function createPersonAnswerV5Route(options: CreatePersonAnswerV5RouteOptions): PersonAnswerV5HttpApplication {
  return Object.freeze({
    async ask(input: Parameters<PersonAnswerV5HttpApplication['ask']>[0]): Promise<PersonAnswerResponseV6> {
      const scope = scopeOf(input.request);
      input.signal?.throwIfAborted();
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      const context = {
        authority_id: options.authority_id,
        organization_id: options.organization_id,
        state_lineage_id: options.state_lineage_id,
        principal_id: authorization.principal_id,
        membership_id: authorization.membership_id,
        session_family_id: authorization.session_family_id,
        request_id: `ask_${randomUUID()}`,
      };
      const project = scope.kind === 'project' ? scope.project_id : undefined;
      const sourceInput = <T extends PersonLiveEvidenceCitationV1>(audit: PersonLiveEvidenceAuditV1<T>) => Object.freeze({
        ...(project === undefined ? {} : { project_id: project }), access_token: input.access_token, audit,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const ticket = await observePersonLiveEvidenceV1('evidence_connection', 'ticket', async () => {
        if (scope.kind === 'mine') { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
        if (options.ticket_for === undefined) { annotateCoreRuntimeV1({ result: 'not_configured' }); return undefined; }
        const source = await options.ticket_for(sourceInput(options.audit.forLiveRequest(context)));
        annotateCoreRuntimeV1({ result: source === undefined ? (project === undefined ? 'unlinked' : 'unavailable') : 'verified' });
        return source;
      });
      const page = await observePersonLiveEvidenceV1('evidence_connection', 'page', async () => {
        if (scope.kind === 'mine') { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
        if (options.page_for === undefined) { annotateCoreRuntimeV1({ result: 'not_configured' }); return undefined; }
        const source = await options.page_for(sourceInput(options.audit.forLiveRequest(context)));
        annotateCoreRuntimeV1({ result: source === undefined ? (project === undefined ? 'unlinked' : 'unavailable') : 'verified' });
        return source;
      });
      const liveSlack = scope.kind === 'global' ? await options.slack_live_for?.({ access_token: input.access_token, audit: options.audit.forLiveRequest(context), ...(input.signal === undefined ? {} : { signal: input.signal }) }) : undefined;
      const base = createPersonEvidenceDeskV1({ access_token: input.access_token, scope, originals: options.originals, records: options.records });
      const desk = createPersonLiveEvidenceDeskV2(base, ticket, liveSlack, project, page, project);
      const asker = askerOf(options, authorization);
      try {
        const response = await createAgenticAskV3({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context), ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}) }).answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
        annotateCoreRuntimeV1({ result: response.outcome });
        return response;
      } catch (error) {
        if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) throw new AuthorityOperationError('unavailable', 'Ask deadline exhausted');
        throw error;
      }
    },
  });
}
