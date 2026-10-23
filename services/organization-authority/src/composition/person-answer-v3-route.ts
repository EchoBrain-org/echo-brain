import { withPersonAskSnapshotRetryV1 } from './person-ask-snapshot-retry-v1.js';
import {
  validatePersonEvidenceDeskResponseV1,
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
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { PersonDiagnosticCaptureHandleV1, PersonDiagnosticsV1 } from './person-diagnostics-v1.js';
import { observePersonResearchV1 } from './person-research-observation-v1.js';

/** Call only after session authentication. Identity never comes from question text or client preferences. */
export function personResearchDriverV1(options: Pick<CreatePersonAnswerV3RouteOptions, 'research_driver' | 'personal_research' | 'generation' | 'model'>, membershipId: string) {
  const personal = options.personal_research?.membership_id === membershipId ? options.personal_research : undefined;
  const driver = personal?.driver ?? options.research_driver;
  return { model: personal?.structured_output ?? options.model, generation: personal?.generation ?? options.generation, ...(driver === undefined ? {} : { research_driver: driver }) };
}

export interface CreatePersonAnswerV3RouteOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly sessions: PersonIdentitySessionApplication;
  readonly originals: PersonOriginalContextEvidenceDeskPortV1;
  readonly records: PersonEvidenceDeskRecordsV1;
  readonly model: StructuredGenerationPort;
  readonly research_driver?: import('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1').AgenticResearchDriverV1;
  readonly personal_research?: import('@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1').AnswerCompositionGenerationBindingV1['personal_research'];
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: SqlitePersonAgenticAskAuditV1;
  readonly diagnostics?: PersonDiagnosticsV1;
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

/** The context an Ask's audits bind: this Authority's coordinates and the asker's session. */
export function personAskRequestContextV1(
  options: Pick<CreatePersonAnswerV3RouteOptions, "authority_id" | "organization_id" | "state_lineage_id">,
  authorization: Pick<PersonAccessAuthorization, "principal_id" | "membership_id" | "session_family_id">,
  request_id: string,
) {
  return {
    authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
    principal_id: authorization.principal_id, membership_id: authorization.membership_id, session_family_id: authorization.session_family_id, request_id,
  };
}

/**
 * One Ask after its own request checks: the asker authenticated, a diagnostic
 * capture claimed when the request names one, then `started`. Every attempt a
 * snapshot restart runs is one observed research run with that capture. A
 * deadline that is not the client's own cancellation answers unavailable.
 */
export async function runPersonAskV1<T>(
  options: Pick<CreatePersonAnswerV3RouteOptions, "authority_id" | "organization_id" | "state_lineage_id" | "sessions" | "diagnostics">,
  input: { readonly access_token: string; readonly request: { readonly capture_id?: string }; readonly signal?: AbortSignal },
  attempt: (run: {
    readonly authorization: PersonAccessAuthorization;
    readonly context: ReturnType<typeof personAskRequestContextV1>;
    readonly capture: PersonDiagnosticCaptureHandleV1 | undefined;
    readonly signal: AbortSignal;
  }) => Promise<T>,
  started?: () => void,
): Promise<T> {
  const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
  const context = personAskRequestContextV1(options, authorization, `ask_${randomUUID()}`);
  const capture = input.request.capture_id === undefined ? undefined : options.diagnostics?.claim({
    access_token: input.access_token, capture_id: input.request.capture_id, target: { kind: 'ask' },
  });
  if (input.request.capture_id !== undefined && capture === undefined) throw new AuthorityOperationError('unavailable', 'Diagnostic capture is not available');
  started?.();
  try {
    return await withPersonAskSnapshotRetryV1({ signal: input.signal, capture: capture !== undefined, run: async signal =>
      observePersonResearchV1({ trigger: 'ask', run_id: context.request_id, ...(capture === undefined ? {} : { capture }) }, () => attempt({ authorization, context, capture, signal })) });
  } catch (error) {
    // Observe the original timeout before translating it into the Person API error.
    if (error instanceof AgenticAskDeadlineErrorV1 && input.signal?.aborted !== true) {
      throw new AuthorityOperationError("unavailable", "Ask deadline exhausted");
    }
    throw error;
  }
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
    // Preserve the public desk contract: named dates and list labels are internal
    // research metadata, and only Ask citations carry ref (ADR-0024, ADR-0041).
    items: result.items.map(({ ref: _ref, dates: _dates, date_kind: _dateKind, list_label: _listLabel, ...item }) => item),
    truncated: result.truncated,
    ...(result.notice === undefined ? {} : { notice: result.notice }),
  });
}

/** Composition-only V3 entry point: every operation gets a new request-bound desk. */
export function createPersonAnswerV3Route(options: CreatePersonAnswerV3RouteOptions): PersonAnswerV3HttpApplication {
  return Object.freeze({
    async ask(input: Parameters<PersonAnswerV3HttpApplication["ask"]>[0]): Promise<PersonAnswerResponseV4> {
      return runPersonAskV1(options, input, async ({ authorization, context, capture, signal }) => {
        const desk = deskFor(options, input.access_token, input.request);
        capture?.bindFence(signal => desk.revalidate({ ...(signal === undefined ? {} : { signal }) }));
        const asker = askerOf(options, authorization);
        return createAgenticAskV1({
          ...(asker === undefined ? {} : { asker }),
          ...(input.time_context === undefined ? {} : { time_context: input.time_context }),
          ...(input.answer_layout === undefined ? {} : { answer_layout: input.answer_layout }),
          ...personResearchDriverV1(options, context.membership_id), desk, audit: options.audit.forRequest(context),
        }).answer({ question: input.request.question, signal });
      });
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
