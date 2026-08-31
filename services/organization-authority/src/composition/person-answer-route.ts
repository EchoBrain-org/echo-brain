import { randomUUID } from "node:crypto";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  createRetrievalGroundedAnswerComposition,
  RetrievalGroundedAnswerCompositionError,
  validateReleasedRetrievalQuery,
  type AnswerCompositionFailureDiagnosticV1,
  type ReleasedRetrievalBatch,
  type StructuredGenerationPort,
} from "../answer-composition/retrieval-grounded-answer-composition.js";
import type { SqlitePersonAnswerCompositionAuditV1 } from "../adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import type {
  PersonRecordSearchBatchApplicationV1,
  PersonRecordSearchBatchReleaseV1,
} from "./person-record-search-route.js";
import { AuthorityOperationError } from "../domain/errors.js";
import type {
  PersonAnswerHttpApplicationV1,
  PersonAnswerPolicyV1,
  PersonAnswerResponseV1,
} from "../presentation/person-answer-http-application.js";
import type { AnswerCompositionGenerationProfileV1 } from "./answer-composition-generation-bundle-v1.js";

export interface AnswerCompositionFailureEventV1
  extends AnswerCompositionFailureDiagnosticV1 {
  readonly failure_id: string;
}

export interface CreatePersonAnswerRouteV1Options {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly search: PersonRecordSearchBatchApplicationV1;
  readonly model: StructuredGenerationPort;
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: SqlitePersonAnswerCompositionAuditV1;
  /** Metadata-only server observer. It never changes the public response. */
  readonly on_failure?: (event: AnswerCompositionFailureEventV1) => void;
}

function unavailable(): never {
  throw new AuthorityOperationError(
    "unavailable",
    "answer composition is unavailable",
  );
}

class ReleasedRetrievalRouteFailure extends Error {
  constructor(readonly original: unknown) {
    super("released retrieval route operation failed");
    this.name = "ReleasedRetrievalRouteFailure";
  }
}

function callReleasedRetrieval<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new ReleasedRetrievalRouteFailure(error);
  }
}

function policy(value: string): PersonAnswerPolicyV1 {
  if (
    value !== "organization-member-readable-person-v2" &&
    value !== "restricted-reviewer-person-v2"
  ) {
    unavailable();
  }
  return value;
}

function publicResponse(
  value: Awaited<
    ReturnType<ReturnType<typeof createRetrievalGroundedAnswerComposition>["answer"]>
  >,
  acceptOutcomeV2: boolean,
): PersonAnswerResponseV1 {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-answer-v1",
    generation_id: value.generation_id,
    record_head: Object.freeze({ ...value.record_head }),
    answer: value.answer,
    citations: Object.freeze(
      value.citations.map((citation) =>
        Object.freeze({
          atom_id: citation.atom_id,
          record_sha256: citation.record_sha256,
          policy_id: policy(citation.policy_id),
        }),
      ),
    ),
    ...(value.outcome === undefined || !acceptOutcomeV2 ? {} : { outcome: value.outcome }),
  });
}

/**
 * Binds one HTTP bearer to one request-local released-retrieval batch. The model sees
 * query text and released atoms only; it never receives caller or policy
 * controls and cannot reuse the release in another request.
 */
export function createPersonAnswerRouteV1(
  options: CreatePersonAnswerRouteV1Options,
): PersonAnswerHttpApplicationV1 {
  return Object.freeze({
    async ask(input: {
      readonly access_token: string;
      readonly question: string;
      readonly accept_outcome_v2?: boolean;
    }): Promise<PersonAnswerResponseV1> {
      try {
        validateReleasedRetrievalQuery(input.question);
      } catch (error) {
        if (error instanceof RetrievalGroundedAnswerCompositionError) {
          throw new AuthorityOperationError(
            "invalid_request",
            "request is invalid",
          );
        }
        throw error;
      }

      let internalRelease: PersonRecordSearchBatchReleaseV1 | undefined;
      let releasedRetrievalBatch: ReleasedRetrievalBatch | undefined;
      const releasedRetrieval = Object.freeze({
        retrieve: async (request: {
          readonly queries: readonly string[];
          readonly exact_release_id?: string;
          readonly signal?: AbortSignal;
        }): Promise<ReleasedRetrievalBatch> => {
          if (internalRelease !== undefined || releasedRetrievalBatch !== undefined) {
            unavailable();
          }
          request.signal?.throwIfAborted();
          const batch = callReleasedRetrieval(() =>
            options.search.searchBatch({
              access_token: input.access_token,
              queries: request.queries,
              ...(request.exact_release_id === undefined
                ? {}
                : { exact_release_id: request.exact_release_id }),
              limit: 10,
            }),
          );
          internalRelease = batch.release;
          const authorization = batch.release.current_authorization;
          releasedRetrievalBatch = Object.freeze({
            release_id: batch.release
              .record_read_audit_row_sha256 as Sha256Digest,
            authority_id: options.authority_id,
            organization_id: options.organization_id,
            state_lineage_id: options.state_lineage_id,
            principal_id: authorization.principal_id,
            membership_id: authorization.membership_id,
            session_family_id: authorization.session_family_id,
            generation_id: batch.response.generation_id as Sha256Digest,
            record_head: Object.freeze({
              position: batch.response.record_head.position,
              record_sha256: batch.response.record_head
                .record_sha256 as Sha256Digest | null,
            }),
            released_atoms: Object.freeze(
              batch.response.items.map((item) =>
                Object.freeze({
                  atom_id: item.atom_id as Sha256Digest,
                  record_sha256: item.record_sha256 as Sha256Digest,
                  policy_id: item.policy_id,
                  text: item.text,
                }),
              ),
            ),
            query_hit_counts: Object.freeze([...batch.query_hit_counts]),
            checked_at: authorization.checked_at,
          });
          return releasedRetrievalBatch;
        },
        revalidate: async (request: {
          readonly release: ReleasedRetrievalBatch;
          readonly signal?: AbortSignal;
        }): Promise<{ readonly checked_at: string }> => {
          request.signal?.throwIfAborted();
          if (
            internalRelease === undefined ||
            releasedRetrievalBatch === undefined ||
            request.release !== releasedRetrievalBatch
          ) {
            unavailable();
          }
          const frozenRelease = internalRelease;
          const authorization = callReleasedRetrieval(() =>
            options.search.revalidateBatchRelease({
              access_token: input.access_token,
              release: frozenRelease,
            }),
          );
          return Object.freeze({ checked_at: authorization.checked_at });
        },
      });

      try {
        const composition = createRetrievalGroundedAnswerComposition({
          planner: options.model,
          answerer: options.model,
          released_retrieval: releasedRetrieval,
          audit: options.audit,
          generation_adapter_id: options.generation.generation_adapter_id,
          planner_model: options.generation.planner_model,
          answer_model: options.generation.answer_model,
          timeout_ms: options.generation.timeout_ms,
          ...(options.on_failure === undefined
            ? {}
            : {
                on_failure: (event: AnswerCompositionFailureDiagnosticV1) =>
                  options.on_failure!(
                    Object.freeze({
                      ...event,
                      failure_id: `l4f_${randomUUID()}`,
                    }),
                  ),
              }),
        });
        return publicResponse(
          await composition.answer({ question: input.question }),
          input.accept_outcome_v2 === true,
        );
      } catch (error) {
        if (
          error instanceof ReleasedRetrievalRouteFailure &&
          error.original instanceof AuthorityOperationError
        ) {
          throw error.original;
        }
        unavailable();
      }
    },
  });
}
