import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type {
  ProjectUploadEnrichmentAuthorizationV1,
  ProjectUploadEnrichmentSnapshotV1,
} from '../../../application/ports/project-context-v1.js';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';

interface EnrichmentAuthorizationRow {
  readonly context_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly audience_kind: 'only_me' | 'team' | 'project';
  readonly audience_project_id: string | null;
  readonly project_membership_id: string | null;
}

function denied(): never {
  throw new AuthorityOperationError('unauthorized', 'request failed');
}

function sameUploader(
  left: AuthorityPersonMembershipBinding,
  right: AuthorityPersonMembershipBinding,
): boolean {
  return left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id &&
    left.membership_type === right.membership_type;
}

function frozenSnapshot(
  contextId: string,
  uploader: AuthorityPersonMembershipBinding,
  audienceKind: EnrichmentAuthorizationRow['audience_kind'],
  audienceProjectId: string | null,
  projectMembershipId: string | null,
): ProjectUploadEnrichmentSnapshotV1 {
  const frozenUploader = Object.freeze({ ...uploader });
  return Object.freeze({
    context_id: contextId,
    uploader: frozenUploader,
    authorization_sha256: canonicalSha256({
      schema_version: 1,
      kind: 'echo-project-upload-enrichment-authorization-v1',
      context_id: contextId,
      uploader: frozenUploader,
      audience: {
        kind: audienceKind,
        project_id: audienceProjectId,
        project_membership_id: projectMembershipId,
      },
    }),
  });
}

/**
 * Current eligibility for the already-custodied V2 upload worker. This never
 * reads or changes an association: association controls project placement,
 * while enrichment eligibility comes only from the immutable upload audience.
 */
export class SqliteProjectUploadEnrichmentAuthorizationV1
  implements ProjectUploadEnrichmentAuthorizationV1 {
  private readonly issued = new WeakSet<ProjectUploadEnrichmentSnapshotV1>();

  constructor(readonly database: Database.Database) {
    if (database.pragma('user_version', { simple: true }) !== 7 || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Project upload enrichment authorization requires fresh Authority V7 state with foreign keys enabled');
    }
  }

  capture(contextId: string): ProjectUploadEnrichmentSnapshotV1 | undefined {
    const row = this.database.prepare(`
      SELECT
        submission.context_id,
        submission.organization_id,
        submission.principal_id,
        submission.membership_id,
        submission.membership_type,
        submission.audience_kind,
        submission.audience_project_id,
        project_membership.project_membership_id
      FROM authority_person_updates_v2 AS submission
      JOIN authority_memberships AS uploader
        ON uploader.organization_id = submission.organization_id
       AND uploader.principal_id = submission.principal_id
       AND uploader.membership_id = submission.membership_id
       AND uploader.membership_type = submission.membership_type
       AND uploader.status = 'active'
      LEFT JOIN authority_project_memberships_v1 AS project_membership
        ON submission.audience_kind = 'project'
       AND project_membership.project_id = submission.audience_project_id
       AND project_membership.organization_id = submission.organization_id
       AND project_membership.principal_id = submission.principal_id
       AND project_membership.membership_id = submission.membership_id
       AND project_membership.membership_type = submission.membership_type
       AND project_membership.status = 'active'
      WHERE submission.context_id = ?
    `).get(contextId) as EnrichmentAuthorizationRow | undefined;

    if (row === undefined ||
        (row.audience_kind !== 'only_me' && row.audience_kind !== 'team' && row.audience_kind !== 'project') ||
        (row.audience_kind === 'project' && row.project_membership_id === null) ||
        (row.audience_kind !== 'project' &&
          (row.audience_project_id !== null || row.project_membership_id !== null))) {
      return undefined;
    }

    const uploader: AuthorityPersonMembershipBinding = {
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      membership_type: row.membership_type,
    };
    const snapshot = frozenSnapshot(
      row.context_id,
      uploader,
      row.audience_kind,
      row.audience_project_id,
      row.project_membership_id,
    );
    this.issued.add(snapshot);
    return snapshot;
  }

  assertCurrent(snapshot: ProjectUploadEnrichmentSnapshotV1): void {
    if (!this.issued.has(snapshot)) denied();
    const current = this.capture(snapshot.context_id);
    if (current === undefined ||
        !sameUploader(current.uploader, snapshot.uploader) ||
        current.authorization_sha256 !== snapshot.authorization_sha256) {
      denied();
    }
  }
}
