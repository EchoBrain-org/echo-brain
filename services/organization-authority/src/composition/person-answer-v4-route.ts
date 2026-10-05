import type { PersonAnswerResponseV5, PersonTicketCitationV1, PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1, createAgenticAskV2 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { randomUUID } from 'node:crypto';
import type { PersonAnswerV4HttpApplication } from '../presentation/person-answer-v4-http-application.js';
import { askerOf, scopeOf, type CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonLiveEvidenceDeskV2 } from './person-live-evidence-desk-v2.js';
import { observePersonLiveEvidenceV1 } from './person-live-evidence-observation-v1.js';

export interface CreatePersonAnswerV4RouteOptions extends Omit<CreatePersonAnswerV3RouteOptions, 'ask_journey_telemetry'> {
  readonly ticket_for?: (input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined>;
  /** Explicit server-selected Slack scope; it never implies a Person-wide user-token grant. */
  readonly slack_live_for?: (input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonSlackMessageCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonSlackMessageCitationV1> | undefined>;
}

/** A new request-owned desk and audit context. No provider coordinates come from the model. */
export function createPersonAnswerV4Route(options: CreatePersonAnswerV4RouteOptions): PersonAnswerV4HttpApplication {
  return Object.freeze({
    async ask(input: Parameters<PersonAnswerV4HttpApplication['ask']>[0]): Promise<PersonAnswerResponseV5> {
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
      // The provider resolves project settings under current membership; an unmapped project never falls back to global Jira.
      const ticket = await observePersonLiveEvidenceV1('evidence_connection', 'ticket', async () => {
        if (scope.kind === 'mine') { annotateCoreRuntimeV1({ result: 'out_of_scope' }); return undefined; }
        if (options.ticket_for === undefined) { annotateCoreRuntimeV1({ result: 'not_configured' }); return undefined; }
        // The Jira source factory verifies the current provider identity before returning a reader.
        const source = await options.ticket_for({ ...(scope.kind === 'project' ? { project_id: scope.project_id } : {}), access_token: input.access_token, audit: options.audit.forLiveRequest(context), ...(input.signal === undefined ? {} : { signal: input.signal }) });
        // A missing project reader can mean either no mapping or no personal connection.
        annotateCoreRuntimeV1({ result: source === undefined ? (scope.kind === 'project' ? 'unavailable' : 'unlinked') : 'verified' });
        return source;
      });
      const liveSlack = scope.kind === 'global' ? await options.slack_live_for?.({ access_token: input.access_token, audit: options.audit.forLiveRequest(context), ...(input.signal === undefined ? {} : { signal: input.signal }) }) : undefined;
      const base = createPersonEvidenceDeskV1({ access_token: input.access_token, scope, originals: options.originals, records: options.records });
      const desk = createPersonLiveEvidenceDeskV2(base, ticket, liveSlack, scope.kind === 'project' ? scope.project_id : undefined);
      const asker = askerOf(options, authorization);
      try {
        const response = await createAgenticAskV2({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context), ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}) }).answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
        annotateCoreRuntimeV1({ result: response.outcome });
        return response;
      } catch (error) {
        if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) throw new AuthorityOperationError('unavailable', 'Ask deadline exhausted');
        throw error;
      }
    },
  });
}
