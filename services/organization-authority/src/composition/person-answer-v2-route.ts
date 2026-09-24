import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  createRetrievalGroundedAnswerComposition,
  AnswerCompositionOutputError,
  RetrievalGroundedAnswerCompositionError,
  validateReleasedRetrievalQuery,
  type AnswerCompositionFailureDiagnosticV1,
  type ReleasedRetrievalBatch,
  type RetrievalGroundedAnswerCompositionResult,
  type StructuredGenerationPort,
} from "@echo-brain/organization-authority-kernel/answer-composition/retrieval-grounded-answer-composition";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { AnswerCompositionGenerationProfileV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import type { PersonAnswerRequestV2, PersonAnswerResponseV3, PersonSourceEvidenceReadRequestV1, PersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import { validatePersonAnswerResponseV3, validatePersonSourceEvidenceV1 } from "@echo-brain/organization-api";
import type { SqlitePersonAnswerCompositionAuditV1 } from "../adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import type { PersonOriginalContextRetrievalPortV1, PersonAskScopeV2 } from "../application/ports/person-original-context-retrieval-v1.js";
import type { PersonRecordSearchBatchApplicationV1, PersonRecordSearchBatchReleaseV1 } from "./person-record-search-route.js";
import type { PersonAnswerV2HttpApplication } from "../presentation/person-answer-v2-http-application.js";
import { annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { classifyAskJourneyFailureV1, type AskJourneyTelemetryFactoryV1 } from "./ask-journey-telemetry-v1.js";
import { randomUUID } from "node:crypto";

export interface CreatePersonAnswerV2RouteOptions {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly records: PersonRecordSearchBatchApplicationV1;
  readonly originals: PersonOriginalContextRetrievalPortV1;
  readonly model: StructuredGenerationPort;
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: SqlitePersonAnswerCompositionAuditV1;
  readonly on_failure?: (event: AnswerCompositionFailureDiagnosticV1 & { readonly failure_id: string }) => void;
  readonly ask_journey_telemetry?: AskJourneyTelemetryFactoryV1;
}

function unavailable(): never {
  throw new AuthorityOperationError("unavailable", "answer composition is unavailable");
}

function scopeOf(request: PersonAnswerRequestV2): PersonAskScopeV2 {
  return request.project_id === undefined
    ? Object.freeze({ kind: "global" as const })
    : Object.freeze({ kind: "project" as const, project_id: request.project_id });
}

function samePrincipal(
  left: { readonly principal_id: string; readonly membership_id: string; readonly session_family_id: string },
  right: { readonly principal_id: string; readonly membership_id: string; readonly session_family_id: string },
): boolean {
  return left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id &&
    left.session_family_id === right.session_family_id;
}

/** Keep global originals visible when four record queries fill the core cap. */
function balancedEvidence<T, U>(records: readonly T[], originals: readonly U[]): readonly (T | U)[] {
  const result: (T | U)[] = [];
  for (let index = 0; index < Math.max(records.length, originals.length); index += 1) {
    if (records[index] !== undefined) result.push(records[index]);
    if (originals[index] !== undefined) result.push(originals[index]);
  }
  return Object.freeze(result);
}

/** The same validated V3 projection binds both the audit and the wire body. */
function publicResponse(
  result: RetrievalGroundedAnswerCompositionResult,
  scope: PersonAskScopeV2,
): PersonAnswerResponseV3 {
  return validatePersonAnswerResponseV3({
    schema_version: 3,
    kind: "echo-clean-person-answer-v3",
    answer: result.answer,
    citations: result.citations.map((citation) =>
      !("source_id" in citation)
        ? {
            kind: "approved_record",
            atom_id: citation.atom_id,
            record_sha256: citation.record_sha256,
            policy_id: citation.policy_id,
          }
        : {
            kind: "source_revision",
            source_id: citation.source_id,
            revision_id: citation.revision_id,
            source_sha256: citation.source_sha256,
            representation_sha256: citation.representation_sha256,
            anchor_sha256: citation.anchor_sha256,
            ...(citation.document_id === undefined ? {} : { document_id: citation.document_id }),
            ...(citation.label === undefined ? {} : { label: citation.label }),
          },
    ),
    scope,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
  });
}

/**
 * V2 composes records and Person-upload originals only through released ports.
 * Project scope intentionally excludes approved records until records carry an
 * authoritative project association.
 */
export function createPersonAnswerV2Route(
  options: CreatePersonAnswerV2RouteOptions,
): PersonAnswerV2HttpApplication {
  return Object.freeze({
    async ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV2 }): Promise<PersonAnswerResponseV3> {
      const scope = scopeOf(input.request);
      const journey = options.ask_journey_telemetry?.start();
      if (journey?.journey_id) annotateCoreRuntimeV1({ linked_journey_ids: [journey.journey_id] });
      const journeyStartedAt = journey?.startTimer() ?? 0;
      const validationStartedAt = journey?.startTimer() ?? 0;
      try {
        validateReleasedRetrievalQuery(input.request.question);
      } catch (error) {
        const reported = error instanceof RetrievalGroundedAnswerCompositionError
          ? new AuthorityOperationError("invalid_request", "request is invalid")
          : error;
        journey?.fail("ask_validation", validationStartedAt, classifyAskJourneyFailureV1(reported));
        journey?.terminate(reported, journeyStartedAt);
        throw reported;
      }
      journey?.succeed("ask_validation", validationStartedAt);
      let recordRelease: PersonRecordSearchBatchReleaseV1 | undefined;
      let originalRelease: Awaited<ReturnType<PersonOriginalContextRetrievalPortV1["retrieve"]>>["release"] | undefined;
      let combined: ReleasedRetrievalBatch | undefined;
      const released = Object.freeze({
        retrieve: async (request: { readonly queries: readonly string[]; readonly exact_release_id?: string; readonly signal?: AbortSignal }) => {
          if (combined !== undefined || originalRelease !== undefined) unavailable();
          request.signal?.throwIfAborted();
          const authorizationStartedAt = journey?.startTimer() ?? 0;
          let authorizationCompleted = false;
          let retrievalStartedAt = authorizationStartedAt;
          try {
            const originals = options.originals.retrieve({
              access_token: input.access_token,
              queries: request.queries,
              scope,
              ...(journey === undefined ? {} : { on_authorized: () => {
                if (authorizationCompleted) return;
                authorizationCompleted = true;
                journey.succeed("ask_authorization", authorizationStartedAt);
                retrievalStartedAt = journey.startTimer();
              } }),
            });
            if (!authorizationCompleted) {
              authorizationCompleted = true;
              journey?.succeed("ask_authorization", authorizationStartedAt);
              retrievalStartedAt = journey?.startTimer() ?? 0;
            }
            originalRelease = originals.release;
            let records: ReturnType<PersonRecordSearchBatchApplicationV1["searchBatch"]> | undefined;
            // Existing records have no project provenance. Do not infer it from
            // lexical text or an unrelated source association.
            if (scope.kind === "global") {
              records = options.records.searchBatch({
                access_token: input.access_token,
                queries: request.queries,
                ...(request.exact_release_id === undefined ? {} : { exact_release_id: request.exact_release_id }),
                // Keep combined record/original hits within the core's per-query
                // audit budget. Related expansion is not project-provenanced.
                limit: 5,
              });
              recordRelease = records.release;
              if (!samePrincipal(originals.release.authorization, records.release.current_authorization)) unavailable();
            }
          const approved = records?.response.items.map((item) => Object.freeze({
            kind: "approved_record" as const,
            atom_id: item.atom_id as Sha256Digest,
            record_sha256: item.record_sha256 as Sha256Digest,
            policy_id: item.policy_id,
            text: item.text,
          })) ?? [];
          const generation_id = records?.release.active_pointer.generation_id as Sha256Digest | undefined;
          const record_head = records?.release.active_pointer.record_head;
          const releaseId = canonicalSha256({
            kind: "echo-person-answer-v2-release",
            scope,
            records_release: records?.release.record_read_audit_row_sha256 ?? null,
            originals: originals.release.released_atoms.map((atom) => ({
              source_id: atom.source_id,
              revision_id: atom.revision_id,
              source_sha256: atom.source_sha256,
              representation_sha256: atom.representation_sha256,
              anchor_sha256: atom.anchor_sha256,
            })),
          });
            combined = Object.freeze({
            release_id: releaseId,
            authority_id: options.authority_id,
            organization_id: options.organization_id,
            state_lineage_id: options.state_lineage_id,
            principal_id: originals.release.authorization.principal_id,
            membership_id: originals.release.authorization.membership_id,
            session_family_id: originals.release.authorization.session_family_id,
            generation_id: generation_id ?? canonicalSha256({ kind: "echo-person-originals-v1", release_id: releaseId }),
            record_head: Object.freeze({
              position: record_head?.position ?? 0,
              record_sha256: record_head?.record_sha256 as Sha256Digest | null ?? null,
            }),
            released_atoms: balancedEvidence(approved, originals.release.released_atoms),
            query_hit_counts: Object.freeze(request.queries.map((_, index) =>
              (records?.query_hit_counts[index] ?? 0) + (originals.query_hit_counts[index] ?? 0))),
            checked_at: originals.release.authorization.checked_at,
          });
            journey?.succeed("ask_retrieval", retrievalStartedAt, {
              planned_query_count: request.queries.length,
              query_hit_count: combined.query_hit_counts.reduce((total, count) => total + count, 0),
              released_atom_count: combined.released_atoms.length,
            });
            return combined;
          } catch (error) {
            const failure = request.signal?.aborted === true
              ? { failure_class: "cancelled" as const, retryable: false }
              : classifyAskJourneyFailureV1(error);
            if (authorizationCompleted) journey?.fail("ask_retrieval", retrievalStartedAt, failure);
            else journey?.fail("ask_authorization", authorizationStartedAt, failure);
            throw error;
          }
        },
        revalidate: async (request: { readonly release: ReleasedRetrievalBatch; readonly signal?: AbortSignal }) => {
          request.signal?.throwIfAborted();
          if (combined === undefined || originalRelease === undefined || request.release !== combined) unavailable();
          const original = options.originals.revalidate({ access_token: input.access_token, release: originalRelease });
          if (recordRelease !== undefined) {
            const current = options.records.revalidateBatchRelease({ access_token: input.access_token, release: recordRelease });
            if (!samePrincipal(originalRelease.authorization, current)) unavailable();
          }
          return original;
        },
      });
      try {
      const result = await createRetrievalGroundedAnswerComposition({
        planning: "question",
        planner: options.model,
        answerer: options.model,
        released_retrieval: released,
        audit: options.audit,
        audit_response: result => publicResponse(result, scope),
        generation_adapter_id: options.generation.generation_adapter_id,
        planner_model: options.generation.planner_model,
        answer_model: options.generation.answer_model,
        timeout_ms: options.generation.timeout_ms,
        ...(journey === undefined ? {} : {
          now_ms: () => journey.startTimer(),
          on_stage: (event) => journey.observeComposition(event),
          on_content: (event) => journey.observeContent(event),
        }),
        ...(options.on_failure === undefined ? {} : {
          on_failure: (event: AnswerCompositionFailureDiagnosticV1) => options.on_failure!({ ...event, failure_id: `l4f_${randomUUID()}` }),
        }),
      }).answer({ question: input.request.question });
      const response = publicResponse(result, scope);
      journey?.complete(result.outcome ?? (result.citations.length === 0 ? "insufficient_evidence" : "answered"), journeyStartedAt);
      return response;
      } catch (error) {
        journey?.terminate(error, journeyStartedAt);
        if (error instanceof AuthorityOperationError) throw error;
        if (error instanceof AnswerCompositionOutputError) throw new AuthorityOperationError("invalid_output", "answer composition output is invalid");
        throw new AuthorityOperationError("unavailable", "answer composition is unavailable");
      }
    },
    readSource(input: { readonly access_token: string; readonly request: PersonSourceEvidenceReadRequestV1 }): PersonSourceEvidenceV1 {
      const scope: PersonAskScopeV2 = input.request.scope.kind === "global"
        ? Object.freeze({ kind: "global" })
        : Object.freeze({ kind: "project", project_id: input.request.scope.project_id });
      const proof = options.originals.read({
        access_token: input.access_token,
        scope,
        citation: input.request.citation,
      });
      return validatePersonSourceEvidenceV1({
        schema_version: 1,
        kind: "echo-person-source-evidence-v1",
        scope: proof.scope,
        citation: {
          kind: "source_revision",
          source_id: proof.atom.source_id,
          revision_id: proof.atom.revision_id,
          source_sha256: proof.atom.source_sha256,
          representation_sha256: proof.atom.representation_sha256,
          anchor_sha256: proof.atom.anchor_sha256,
          ...(proof.atom.document_id === undefined ? {} : { document_id: proof.atom.document_id }),
          label: proof.atom.label ?? "Saved context",
        },
        text: proof.atom.text,
      });
    },
  });
}
