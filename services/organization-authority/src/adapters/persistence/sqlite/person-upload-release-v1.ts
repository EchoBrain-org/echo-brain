import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonUploadAudienceV3, ProjectIdV1 } from '@echo-brain/organization-api';

/**
 * ADR-0023: a released audience names only the reader's current projects. A
 * single visible project reads as `project`, so the kind never tells a reader
 * that the audience also names projects it cannot see. Stored audiences, and
 * the authorization decided from them, are unchanged.
 */
export function releasedUploadAudienceV3(stored: PersonUploadAudienceV3, grantedProjectIds: ReadonlySet<string>): PersonUploadAudienceV3 {
  if (stored.kind === 'only_me' || stored.kind === 'team') return stored;
  const visible: ProjectIdV1[] = stored.kind === 'project' ? [stored.project_id] : [...stored.project_ids];
  const released = visible.filter((project_id) => grantedProjectIds.has(project_id));
  // Every caller has already authorized the read through one of these projects.
  if (released.length === 0) throw new AuthorityOperationError('invalid_output', 'request failed');
  return released.length === 1
    ? Object.freeze({ kind: 'project' as const, project_id: released[0]! })
    : Object.freeze({ kind: 'projects' as const, project_ids: Object.freeze(released) });
}

/** The uploader is the exact organization tenure that submitted the request. */
export function isUploaderV1(row: AuthorityPersonMembershipBinding, reader: AuthorityPersonMembershipBinding): boolean {
  return row.organization_id === reader.organization_id && row.principal_id === reader.principal_id && row.membership_id === reader.membership_id;
}
