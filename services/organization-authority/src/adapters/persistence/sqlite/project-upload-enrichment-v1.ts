import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import { validateAssociationProjectIdsV1 } from '@echo-brain/organization-api';
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
  readonly audience_kind: 'only_me' | 'team' | 'project' | 'projects';
  readonly audience_project_id: string | null;
  readonly audience_project_ids_json: string;
}
type AudienceTenure =
  | { readonly kind: 'only_me' | 'team' }
  | { readonly kind: 'project'; readonly project_id: string; readonly project_membership_id: string }
  | { readonly kind: 'projects'; readonly project_ids: readonly string[]; readonly project_membership_ids: readonly string[] };

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
  audience: AudienceTenure,
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
      audience,
    }),
  });
}

/**
 * Current eligibility for the already-custodied V2/V3 upload worker. This never
 * reads or changes an association: association controls project placement,
 * while enrichment eligibility comes only from the immutable upload audience.
 */
export class SqliteProjectUploadEnrichmentAuthorizationV1
  implements ProjectUploadEnrichmentAuthorizationV1 {
  private readonly issued = new WeakSet<ProjectUploadEnrichmentSnapshotV1>();

  constructor(readonly database: Database.Database) {
    if (database.pragma('user_version', { simple: true }) !== 9 || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Project upload enrichment authorization requires Authority V9 state with foreign keys enabled');
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
        submission.audience_project_ids_json
      FROM authority_person_updates_v2 AS submission
      JOIN authority_memberships AS uploader
        ON uploader.organization_id = submission.organization_id
       AND uploader.principal_id = submission.principal_id
       AND uploader.membership_id = submission.membership_id
       AND uploader.membership_type = submission.membership_type
       AND uploader.status = 'active'
      WHERE submission.context_id = ?
    `).get(contextId) as EnrichmentAuthorizationRow | undefined;

    if (row === undefined) return undefined;

    const uploader: AuthorityPersonMembershipBinding = {
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      membership_type: row.membership_type,
    };
    const audience = this.audienceTenure(row);
    if (audience === undefined) return undefined;
    const snapshot = frozenSnapshot(row.context_id, uploader, audience);
    this.issued.add(snapshot);
    return snapshot;
  }

  private audienceTenure(row: EnrichmentAuthorizationRow): AudienceTenure | undefined {
    if (row.audience_kind === 'only_me' || row.audience_kind === 'team') {
      return row.audience_project_id === null && row.audience_project_ids_json === '[]' ? { kind: row.audience_kind } : undefined;
    }
    if (row.audience_kind === 'project') {
      if (row.audience_project_id === null || row.audience_project_ids_json !== canonicalJson([row.audience_project_id])) return undefined;
      const membership = this.projectMembership(row, row.audience_project_id);
      return membership === undefined ? undefined : { kind: 'project', project_id: row.audience_project_id, project_membership_id: membership };
    }
    if (row.audience_kind !== 'projects' || row.audience_project_id !== null) return undefined;
    let projectIds: readonly string[];
    try {
      const parsed: unknown = JSON.parse(row.audience_project_ids_json);
      if (!Array.isArray(parsed) || canonicalJson(parsed) !== row.audience_project_ids_json) throw new Error();
      projectIds = validateAssociationProjectIdsV1(parsed);
    } catch { return undefined; }
    if (projectIds.length === 0) return undefined;
    const projectMembershipIds: string[] = [];
    for (const projectId of projectIds) {
      const membership = this.projectMembership(row, projectId);
      if (membership === undefined) return undefined;
      projectMembershipIds.push(membership);
    }
    return { kind: 'projects', project_ids: projectIds, project_membership_ids: Object.freeze(projectMembershipIds) };
  }

  private projectMembership(row: EnrichmentAuthorizationRow, projectId: string): string | undefined {
    const result = this.database.prepare(`SELECT project_membership_id FROM authority_project_memberships_v1
      WHERE project_id = ? AND organization_id = ? AND principal_id = ? AND membership_id = ? AND membership_type = ? AND status = 'active'`)
      .get(projectId, row.organization_id, row.principal_id, row.membership_id, row.membership_type) as { project_membership_id?: unknown } | undefined;
    return typeof result?.project_membership_id === 'string' ? result.project_membership_id : undefined;
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
