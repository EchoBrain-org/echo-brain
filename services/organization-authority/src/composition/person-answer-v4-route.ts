import type { PersonAnswerResponseV5, PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AgenticAskDeadlineErrorV1, createAgenticAskV2 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { randomUUID } from 'node:crypto';
import type { PersonAnswerV4HttpApplication } from '../presentation/person-answer-v4-http-application.js';
import type { CreatePersonAnswerV3RouteOptions } from './person-answer-v3-route.js';
import { createPersonEvidenceDeskV1 } from './person-evidence-desk-v1.js';
import { createPersonLiveEvidenceDeskV2 } from './person-live-evidence-desk-v2.js';

export interface CreatePersonAnswerV4RouteOptions extends CreatePersonAnswerV3RouteOptions {
  readonly ticket_for: (input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }) => Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined>;
}

/** A new request-owned desk and audit context. No provider coordinates come from the model. */
export function createPersonAnswerV4Route(options: CreatePersonAnswerV4RouteOptions): PersonAnswerV4HttpApplication {
  return Object.freeze({
    async ask(input: Parameters<PersonAnswerV4HttpApplication['ask']>[0]): Promise<PersonAnswerResponseV5> {
      if (input.request.mine !== undefined && (input.request.mine !== true || input.request.project_id !== undefined)) throw new AuthorityOperationError('invalid_request', 'Ask scope is invalid');
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
      const scope = input.request.project_id !== undefined ? { kind: 'project' as const, project_id: input.request.project_id } : input.request.mine === true ? { kind: 'mine' as const } : { kind: 'global' as const };
      // A project has no verified Jira mapping in this slice. Never widen project or mine to global Jira.
      const ticket = scope.kind === 'global' ? await options.ticket_for({ access_token: input.access_token, audit: options.audit.forLiveRequest(context), ...(input.signal === undefined ? {} : { signal: input.signal }) }) : undefined;
      const slack = scope.kind === 'mine' ? undefined : options.slack_for?.({ principal_id: authorization.principal_id, membership_id: authorization.membership_id });
      const base = createPersonEvidenceDeskV1({ access_token: input.access_token, scope, originals: options.originals, records: options.records, ...(slack === undefined ? {} : { slack }) });
      const desk = createPersonLiveEvidenceDeskV2(base, ticket);
      const membership = options.memberships?.membership(authorization.membership_id);
      const asker = membership?.organization_id === options.organization_id && membership.principal_id === authorization.principal_id && membership.membership_id === authorization.membership_id ? { display_name: membership.display_name } : undefined;
      try {
        return await createAgenticAskV2({ desk, model: options.model, generation: options.generation, audit: options.audit.forRequest(context), ...(asker === undefined ? {} : { asker }), ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}) }).answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
      } catch (error) {
        if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) throw new AuthorityOperationError('unavailable', 'Ask deadline exhausted');
        throw error;
      }
    },
  });
}
