import {
  validatePersonEvidenceDeskResponseV1,
  type PersonAnswerRequestV3,
  type PersonAnswerResponseV4,
  type PersonEvidenceDeskResponseV1,
  type PersonEvidenceOpenRequestV1,
  type PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";
import { createAgenticAskV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import type { StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/retrieval-grounded-answer-composition";
import type { AnswerCompositionGenerationProfileV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import type { EvidenceDeskResultV1 } from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import type { PersonOriginalContextEvidenceDeskPortV1, PersonAskScopeV2 } from "../application/ports/person-original-context-retrieval-v1.js";
import type { PersonEvidenceDeskRecordsV1 } from "./person-record-search-route.js";
import { createPersonEvidenceDeskV1, type CreatePersonEvidenceDeskV1Options } from "./person-evidence-desk-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import type { PersonAnswerV3HttpApplication } from "../presentation/person-answer-v3-http-application.js";
import type { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import { randomUUID } from "node:crypto";

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
  /** Server-only experiment; V3 remains behaviorally unchanged unless enabled. */
  readonly small_scope_shortcut?: boolean;
  /**
   * The asking Person's live Slack reads, when they have connected Slack (RFC-0003).
   * Returning undefined leaves Slack out of that request. Only Ask uses it; the
   * evidence HTTP doors stay Echo-only.
   */
  readonly slack_for?: (asker: { readonly principal_id: string; readonly membership_id: string }) => CreatePersonEvidenceDeskV1Options["slack"] | undefined;
}

function scopeOf(request: { readonly project_id?: string }): PersonAskScopeV2 {
  return request.project_id === undefined
    ? Object.freeze({ kind: "global" as const })
    : Object.freeze({ kind: "project" as const, project_id: request.project_id });
}

function deskFor(options: CreatePersonAnswerV3RouteOptions, access_token: string, request: { readonly project_id?: string }, slack?: CreatePersonEvidenceDeskV1Options["slack"]) {
  return createPersonEvidenceDeskV1({
    access_token,
    scope: scopeOf(request),
    originals: options.originals,
    records: options.records,
    ...(slack === undefined ? {} : { slack }),
  });
}

function deskResponse(desk: ReturnType<typeof deskFor>, result: EvidenceDeskResultV1): PersonEvidenceDeskResponseV1 {
  return validatePersonEvidenceDeskResponseV1({
    schema_version: 1,
    kind: "echo-person-evidence-desk-v1",
    scope: desk.scope,
    items: result.items,
    truncated: result.truncated,
    ...(result.notice === undefined ? {} : { notice: result.notice }),
  });
}

/** Composition-only V3 entry point: every operation gets a new request-bound desk. */
export function createPersonAnswerV3Route(options: CreatePersonAnswerV3RouteOptions): PersonAnswerV3HttpApplication {
  return Object.freeze({
    async ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV4> {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      const slack = options.slack_for?.({ principal_id: authorization.principal_id, membership_id: authorization.membership_id });
      const desk = deskFor(options, input.access_token, input.request, slack);
      return createAgenticAskV1({
        desk,
        model: options.model,
        generation: options.generation,
        audit: options.audit.forRequest({
          authority_id: options.authority_id,
          organization_id: options.organization_id,
          state_lineage_id: options.state_lineage_id,
          principal_id: authorization.principal_id,
          membership_id: authorization.membership_id,
          session_family_id: authorization.session_family_id,
          request_id: `ask_${randomUUID()}`,
        }),
        ...(options.small_scope_shortcut === true
          ? { small_scope_shortcut: true }
          : {}),
      })
        .answer({ question: input.request.question, ...(input.signal === undefined ? {} : { signal: input.signal }) });
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
