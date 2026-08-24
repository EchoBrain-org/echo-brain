import { randomUUID } from "node:crypto";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  createLeanAnswerComposition,
  LeanAnswerCompositionError,
  validateLayer2CompatibleQuery,
  type Layer4FailureDiagnosticV1,
  type Layer4ReleasedBatch,
  type Layer4StructuredOutputPort,
} from "../answer-composition/lean-answer-composition.js";
import type { SqliteCleanPersonAnswerCompositionAuditV1 } from "../adapters/persistence/sqlite/clean-person-answer-composition-audit-v1.js";
import type {
  CleanPersonRecordSearchBatchApplicationV1,
  CleanPersonRecordSearchBatchReleaseV1,
} from "./clean-person-record-search-route.js";
import { AuthorityOperationError } from "../domain/errors.js";
import type {
  CleanPersonAnswerHttpApplicationV1,
  CleanPersonAnswerPolicyV1,
  CleanPersonAnswerResponseV1,
} from "../presentation/clean-person-answer-http-application.js";

export const CLEAN_LAYER4_PROVIDER_V1 = "openrouter" as const;
export const CLEAN_LAYER4_MODEL_V1 = "deepseek/deepseek-r1" as const;
export const CLEAN_LAYER4_TIMEOUT_MS_V1 = 60_000;

export interface CleanLayer4FailureEventV1
  extends Layer4FailureDiagnosticV1 {
  readonly failure_id: string;
}

export interface CreateCleanPersonAnswerRouteV1Options {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly search: CleanPersonRecordSearchBatchApplicationV1;
  readonly model: Layer4StructuredOutputPort;
  readonly audit: SqliteCleanPersonAnswerCompositionAuditV1;
  /** Metadata-only server observer. It never changes the public response. */
  readonly on_failure?: (event: CleanLayer4FailureEventV1) => void;
}

function unavailable(): never {
  throw new AuthorityOperationError(
    "unavailable",
    "answer composition is unavailable",
  );
}

function policy(value: string): CleanPersonAnswerPolicyV1 {
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
    ReturnType<ReturnType<typeof createLeanAnswerComposition>["answer"]>
  >,
): CleanPersonAnswerResponseV1 {
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
  });
}

/**
 * Binds one HTTP bearer to one request-local Layer 3 release. The model sees
 * query text and released atoms only; it never receives caller or policy
 * controls and cannot reuse the release in another request.
 */
export function createCleanPersonAnswerRouteV1(
  options: CreateCleanPersonAnswerRouteV1Options,
): CleanPersonAnswerHttpApplicationV1 {
  return Object.freeze({
    async ask(input: {
      readonly access_token: string;
      readonly question: string;
    }): Promise<CleanPersonAnswerResponseV1> {
      try {
        validateLayer2CompatibleQuery(input.question);
      } catch (error) {
        if (error instanceof LeanAnswerCompositionError) {
          throw new AuthorityOperationError(
            "invalid_request",
            "request is invalid",
          );
        }
        throw error;
      }

      let internalRelease: CleanPersonRecordSearchBatchReleaseV1 | undefined;
      let layer4Release: Layer4ReleasedBatch | undefined;
      const layer3 = Object.freeze({
        retrieve: async (request: {
          readonly queries: readonly string[];
          readonly signal?: AbortSignal;
        }): Promise<Layer4ReleasedBatch> => {
          if (internalRelease !== undefined || layer4Release !== undefined) {
            unavailable();
          }
          request.signal?.throwIfAborted();
          const batch = options.search.searchBatch({
            access_token: input.access_token,
            queries: request.queries,
            limit: 10,
          });
          internalRelease = batch.release;
          const authorization = batch.release.current_authorization;
          layer4Release = Object.freeze({
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
            checked_at: authorization.checked_at,
          });
          return layer4Release;
        },
        revalidate: async (request: {
          readonly release: Layer4ReleasedBatch;
          readonly signal?: AbortSignal;
        }): Promise<{ readonly checked_at: string }> => {
          request.signal?.throwIfAborted();
          if (
            internalRelease === undefined ||
            layer4Release === undefined ||
            request.release !== layer4Release
          ) {
            unavailable();
          }
          const authorization = options.search.revalidateBatchRelease({
            access_token: input.access_token,
            release: internalRelease,
          });
          return Object.freeze({ checked_at: authorization.checked_at });
        },
      });

      try {
        const composition = createLeanAnswerComposition({
          planner: options.model,
          answerer: options.model,
          layer3,
          audit: options.audit,
          provider: CLEAN_LAYER4_PROVIDER_V1,
          planner_model: CLEAN_LAYER4_MODEL_V1,
          answer_model: CLEAN_LAYER4_MODEL_V1,
          timeout_ms: CLEAN_LAYER4_TIMEOUT_MS_V1,
          ...(options.on_failure === undefined
            ? {}
            : {
                on_failure: (event: Layer4FailureDiagnosticV1) =>
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
        );
      } catch (error) {
        if (error instanceof AuthorityOperationError) throw error;
        unavailable();
      }
    },
  });
}
