import {
  validatePersonEvidenceDeskResponseV1,
  type PersonAnswerRequestV3,
  type PersonAnswerResponseV4,
  type PersonEvidenceDeskResponseV1,
  type PersonEvidenceOpenRequestV1,
  type PersonEvidenceSearchRequestV1,
} from "@echo-brain/organization-api";
import { AgenticAskDeadlineErrorV1, createAgenticAskV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { classifyAskJourneyFailureV1, type AskJourneyFailureV1, type AskJourneyTelemetryFactoryV1 } from "./ask-journey-telemetry-v1.js";
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
  /**
   * The asker's own directory entry, so the loop reads "my" as a name. Only
   * the authenticated membership is looked up; its name reaches the model and
   * no audit.
   */
  /** Staging-only request-local Ask journey factory, shared with V1 and V2. */
  readonly ask_journey_telemetry?: AskJourneyTelemetryFactoryV1;
  readonly memberships?: {
    membership(id: string): {
      readonly organization_id: string;
      readonly principal_id: string;
      readonly membership_id: string;
      readonly display_name: string;
    } | undefined;
  };
}

function askerOf(
  options: CreatePersonAnswerV3RouteOptions,
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

/** The agentic deadline is a timeout; everything else keeps the shared Ask classification. */
function askFailure(error: unknown): AskJourneyFailureV1 {
  return error instanceof AgenticAskDeadlineErrorV1 ? { failure_class: "timeout", retryable: true } : classifyAskJourneyFailureV1(error);
}

/** The loop's stages in the order it reports them. */
const V3_STAGES = Object.freeze(["ask_retrieval", "ask_planner", "ask_context", "ask_answer", "ask_revalidation", "ask_audit"] as const);

/** Composition-only V3 entry point: every operation gets a new request-bound desk. */
export function createPersonAnswerV3Route(options: CreatePersonAnswerV3RouteOptions): PersonAnswerV3HttpApplication {
  return Object.freeze({
    async ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV4> {
      // The Ask journey: validation and authorization here, research through
      // audit from the loop's stage reports, and the V4 outcome at the end.
      const journey = options.ask_journey_telemetry?.start();
      if (journey?.journey_id) annotateCoreRuntimeV1({ linked_journey_ids: [journey.journey_id] });
      const journeyStartedAt = journey?.startTimer() ?? 0;
      // The HTTP layer validated the request shape before this route.
      journey?.succeed("ask_validation", journeyStartedAt);
      const authorizationStartedAt = journey?.startTimer() ?? 0;
      let authorization: ReturnType<PersonIdentitySessionApplication["authenticateAccess"]>;
      try {
        authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      } catch (error) {
        journey?.fail("ask_authorization", authorizationStartedAt, askFailure(error));
        journey?.terminate(error, journeyStartedAt);
        throw error;
      }
      journey?.succeed("ask_authorization", authorizationStartedAt);
      const researchStartedAt = journey?.startTimer() ?? 0;
      const slack = options.slack_for?.({ principal_id: authorization.principal_id, membership_id: authorization.membership_id });
      const desk = deskFor(options, input.access_token, input.request, slack);
      const asker = askerOf(options, authorization);
      try {
        const result = await createAgenticAskV1({
          ...(asker === undefined ? {} : { asker }),
          desk,
          ...(journey === undefined ? {} : { on_stage: (event: Parameters<typeof journey.observeComposition>[0]) => journey.observeComposition(event) }),
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
        journey?.complete(result.outcome, journeyStartedAt);
        return result;
      } catch (error) {
        // The loop reports stages as they succeed, in order, so the first one
        // still open is where the request ended: research (desk, deadline or
        // cancel), the answer call, the final fence or the audit.
        journey?.failOpen(V3_STAGES, researchStartedAt, input.signal?.aborted === true ? { failure_class: "cancelled", retryable: false } : askFailure(error));
        journey?.terminate(error, journeyStartedAt);
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
