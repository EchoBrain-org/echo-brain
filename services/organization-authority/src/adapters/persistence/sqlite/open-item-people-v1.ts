import type Database from 'better-sqlite3';

/** A display name compared whole: NFC, case ignored, runs of whitespace as one space. */
function comparableName(value: string): string {
  return value.normalize('NFC').toLowerCase().normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * ECHO's own directory facts that open items need, read from
 * `authority_memberships`, `authority_principals` and
 * `authority_project_memberships_v1`. Nothing here reads outside ECHO.
 */
export class SqliteOpenItemPeopleV1 {
  constructor(private readonly database: Database.Database) {
    if (database.pragma('user_version', { simple: true }) !== 14 || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Open item people require Authority V14 state with foreign keys enabled');
    }
  }

  /** Display names and whether each membership is active, for these memberships of the organization. */
  people(organizationId: string, membershipIds: readonly string[]): ReadonlyMap<string, { readonly name: string; readonly active: boolean }> {
    const found = new Map<string, { readonly name: string; readonly active: boolean }>();
    if (membershipIds.length === 0) return found;
    const rows = this.database.prepare(`SELECT membership.membership_id, principal.display_name, membership.status
      FROM authority_memberships AS membership
      JOIN authority_principals AS principal ON principal.principal_id = membership.principal_id AND principal.organization_id = membership.organization_id
      WHERE membership.organization_id = ? AND membership.membership_id IN (SELECT value FROM json_each(?))
      ORDER BY membership.membership_id`).all(organizationId, JSON.stringify([...new Set(membershipIds)])) as { readonly membership_id: string; readonly display_name: string; readonly status: string }[];
    for (const row of rows) found.set(row.membership_id, Object.freeze({ name: row.display_name, active: row.status === 'active' }));
    return found;
  }

  /** Active memberships whose display name equals `name` ignoring case and runs of whitespace (NFC). */
  activeByName(organizationId: string, name: string): readonly string[] {
    const wanted = comparableName(name);
    if (wanted === '') return [];
    const rows = this.database.prepare(`SELECT membership.membership_id, principal.display_name
      FROM authority_memberships AS membership
      JOIN authority_principals AS principal ON principal.principal_id = membership.principal_id AND principal.organization_id = membership.organization_id
      WHERE membership.organization_id = ? AND membership.status = 'active'
      ORDER BY membership.membership_id`).all(organizationId) as { readonly membership_id: string; readonly display_name: string }[];
    return rows.filter(row => comparableName(row.display_name) === wanted).map(row => row.membership_id);
  }

  isActiveMember(organizationId: string, membershipId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM authority_memberships WHERE organization_id = ? AND membership_id = ? AND status = 'active'`)
      .get(organizationId, membershipId) !== undefined;
  }

  /** The member is an active lead of at least one of these projects (active project, active grant, active membership). */
  leadsAny(membershipId: string, projectIds: readonly string[]): boolean {
    if (projectIds.length === 0) return false;
    return this.database.prepare(`SELECT 1 FROM authority_project_memberships_v1 AS grant_row
      JOIN authority_memberships AS membership ON membership.membership_id = grant_row.membership_id
       AND membership.organization_id = grant_row.organization_id AND membership.principal_id = grant_row.principal_id
       AND membership.membership_type = grant_row.membership_type AND membership.status = 'active'
      JOIN authority_projects_v1 AS project ON project.project_id = grant_row.project_id
       AND project.organization_id = grant_row.organization_id AND project.status = 'active'
      WHERE grant_row.membership_id = ? AND grant_row.status = 'active' AND grant_row.role = 'lead'
        AND grant_row.project_id IN (SELECT value FROM json_each(?))
      LIMIT 1`).get(membershipId, JSON.stringify([...new Set(projectIds)])) !== undefined;
  }
}
