import {
  validatePersonEvidenceDeskResponseV1,
  type PersonAnswerRequestV3,
  type PersonAnswerResponseV4,
  type PersonEvidenceDeskResponseV1,
  type PersonEvidenceOpenRequestV1,
  type PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";
import { AgenticAskDeadlineErrorV1, createAgenticAskV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import type { AnswerCompositionGenerationProfileV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import type { EvidenceDeskResultV1 } from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import type { PersonOriginalContextEvidenceDeskPortV1, PersonAskScopeV2 } from "../application/ports/person-original-context-retrieval-v1.js";
import type { PersonEvidenceDeskRecordsV1 } from "./person-record-search-route.js";
import { createPersonEvidenceDeskV1 } from "./person-evidence-desk-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import type { PersonAnswerV3HttpApplication } from "../presentation/person-answer-v3-http-application.js";
import type { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import { randomUUID } from "node:crypto";
import type { PersonDiagnosticsV1 } from './person-diagnostics-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';

export interface CreatePersonAnswerV3RouteOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly sessions: PersonIdentitySessionApplication;
  readonly originals: PersonOriginalContextEvidenceDeskPortV1;
  readonly records: PersonEvidenceDeskRecordsV1;
  readonly model: StructuredGenerationPort;
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: SqlitePersonAgenticAskAuditV1;
  readonly diagnostics?: PersonDiagnosticsV1;
  /** Server-only experiment; V3 remains behaviorally unchanged unless enabled. */
  readonly small_scope_shortcut?: boolean;
  /**
   * The asker's own directory entry, so the loop reads "my" as a name. Only
   * the authenticated membership is looked up; its name reaches the model and
   * no audit.
   */
  readonly memberships?: {
    membership(id: string): {
      readonly organization_id: string;
      readonly principal_id: string;
      readonly membership_id: string;
      readonly display_name: string;
    } | undefined;
  };
}

export function askerOf(
  options: Pick<CreatePersonAnswerV3RouteOptions, "organization_id" | "memberships">,
  authorization: { readonly principal_id: string; readonly membership_id: string },
): { readonly display_name: string } | undefined {
  const membership = options.memberships?.membership(authorization.membership_id);
  if (
    membership === undefined ||
    membership.organization_id !== options.organization_id ||
    membership.principal_id !== authorization.principal_id ||
    membership.membership_id !== authorization.membership_id
  ) return undefined;
  return Object.freeze({ display_name: membership.display_name });
}

/** Every request shape maps to exactly one scope; mine with a project is refused, never widened. */
export function scopeOf(request: { readonly project_id?: string; readonly mine?: true }): PersonAskScopeV2 {
  if (request.mine !== undefined && (request.mine !== true || request.project_id !== undefined)) throw new AuthorityOperationError("invalid_request", "Ask scope is invalid");
  if (request.project_id !== undefined) return Object.freeze({ kind: "project" as const, project_id: request.project_id });
  return request.mine === true ? Object.freeze({ kind: "mine" as const }) : Object.freeze({ kind: "global" as const });
}

function deskFor(options: CreatePersonAnswerV3RouteOptions, access_token: string, request: { readonly project_id?: string; readonly mine?: true }) {
  return createPersonEvidenceDeskV1({
    access_token,
    scope: scopeOf(request),
    originals: options.originals,
    records: options.records,
  });
}

function deskResponse(desk: ReturnType<typeof deskFor>, result: EvidenceDeskResultV1): PersonEvidenceDeskResponseV1 {
  return validatePersonEvidenceDeskResponseV1({
    schema_version: 1,
    kind: "echo-person-evidence-desk-v1",
    scope: desk.scope,
    // The desk contract carries no ref; only Ask citations do (ADR-0024).
    items: result.items.map(({ ref: _ref, ...item }) => item),
    truncated: result.truncated,
    ...(result.notice === undefined ? {} : { notice: result.notice }),
  });
}

/** Composition-only V3 entry point: every operation gets a new request-bound desk. */
export function createPersonAnswerV3Route(options: CreatePersonAnswerV3RouteOptions): PersonAnswerV3HttpApplication {
  return Object.freeze({
    async ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV4> {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      const requestId = `ask_${randomUUID()}`;
      const capture = input.request.capture_id === undefined ? undefined : options.diagnostics?.claim({
        access_token: input.access_token, capture_id: input.request.capture_id, target: { kind: 'ask' },
      });
      if (input.request.capture_id !== undefined && capture === undefined) throw new AuthorityOperationError('unavailable', 'Diagnostic capture is not available');
      try {
        return await observePersonResearchV1({ trigger: 'ask', run_id: requestId, ...(capture === undefined ? {} : { capture }) }, async () => {
          const desk = deskFor(options, input.access_token, input.request);
          capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
          const asker = askerOf(options, authorization);
          return createAgenticAskV1({
            ...(asker === undefined ? {} : { asker }),
            desk, model: options.model, generation: options.generation,
            audit: options.audit.forRequest({
              authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
              principal_id: authorization.principal_id, membership_id: authorization.membership_id,
              session_family_id: authorization.session_family_id, request_id: requestId,
            }),
            ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
          }).answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
        });
      } catch (error) {
        // Observe the original timeout before translating it into the Person API error.
        if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) {
          throw new AuthorityOperationError("unavailable", "Ask deadline exhausted");
        }
        throw error;
      }
    },
    async searchEvidence(input: { readonly access_token: string; readonly request: PersonEvidenceSearchRequestV1; readonly signal?: AbortSignal }): Promise<PersonEvidenceDeskResponseV1> {
      const desk = deskFor(options, input.access_token, input.request);
      const result = await desk.search({
        ...(input.request.query === undefined ? {} : { query: input.request.query }),
        ...(input.request.kinds === undefined ? {} : { kinds: input.request.kinds }),
        ...(input.request.limit === undefined ? {} : { limit: input.request.limit }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await desk.revalidate({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return deskResponse(desk, result);
    },
    async openEvidence(input: { readonly access_token: string; readonly request: PersonEvidenceOpenRequestV1; readonly signal?: AbortSignal }): Promise<PersonEvidenceDeskResponseV1> {
      const desk = deskFor(options, input.access_token, input.request);
      const result = await desk.openCitation({
        citation: input.request.citation,
        ...(input.request.neighbours === undefined ? {} : { neighbours: input.request.neighbours }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await desk.revalidate({ ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return deskResponse(desk, result);
    },
  });
}
