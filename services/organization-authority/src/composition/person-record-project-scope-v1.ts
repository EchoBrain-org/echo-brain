import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { validateProjectIdV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { ProjectContextRepositoryV1 } from "../application/ports/project-context-v1.js";

/** Server-only projection of the existing project authorization snapshot. */
export interface RecordProjectAuthorizationV1 {
  readonly project_ids: readonly string[];
  readonly grants_sha256: Sha256Digest;
}

export type CaptureRecordProjectsV1 = (person: PersonAccessAuthorization) => RecordProjectAuthorizationV1;

export function createRecordProjectAuthorizationV1(repository: ProjectContextRepositoryV1): CaptureRecordProjectsV1 {
  return (person) => repository.withReadTransaction((transaction) => {
    const snapshot = transaction.captureAuthorization(person, { operation: "project_list" });
    const grants = snapshot.grants.map(({ project_id, project_membership_id }) => ({ project_id, project_membership_id }));
    return Object.freeze({
      project_ids: Object.freeze(grants.map((grant) => grant.project_id)),
      // Only this person's exact grants affect a release; unrelated organization
      // project mutations are not an authorization change for this request.
      grants_sha256: canonicalSha256(grants),
    });
  });
}

export function captureRecordProjectsV1(
  capture: CaptureRecordProjectsV1 | undefined,
  person: PersonAccessAuthorization,
  projectId?: string,
): RecordProjectAuthorizationV1 {
  if (projectId !== undefined) validateProjectIdV1(projectId);
  const state = capture?.(person) ?? Object.freeze({ project_ids: Object.freeze([]), grants_sha256: canonicalSha256([]) });
  if (projectId !== undefined && !state.project_ids.includes(projectId)) {
    throw new AuthorityOperationError("unauthorized", "person authentication failed");
  }
  return state;
}
