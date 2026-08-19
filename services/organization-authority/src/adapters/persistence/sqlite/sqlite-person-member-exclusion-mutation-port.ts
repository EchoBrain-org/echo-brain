import {
  PersonMemberExclusionSourceDeniedError,
  type PersonMemberExclusionMutation,
  type PersonMemberExclusionMutationPort,
} from '../../../application/person-member-exclusions.js';
import { openAuthorityDatabase } from './open-database.js';

/**
 * Exact Authority-owned member valve. This adapter never inserts or changes a
 * source-owner binding; it only accepts an already-bound active membership.
 */
export class SqlitePersonMemberExclusionMutationPort
  implements PersonMemberExclusionMutationPort
{
  constructor(
    private readonly databasePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async change(input: PersonMemberExclusionMutation): Promise<void> {
    const database = openAuthorityDatabase(this.databasePath, {
      fileMustExist: true,
    });
    database.exec('BEGIN IMMEDIATE');
    try {
      const owned = database
        .prepare(
          `SELECT 1
             FROM authority_processing_source_owner_bindings b
             JOIN authority_memberships m
               ON m.membership_id = b.membership_id
              AND m.organization_id = b.organization_id
              AND m.principal_id = b.principal_id
              AND m.membership_type = b.membership_type
            WHERE b.source_adapter_id = ? AND b.source_instance_id = ?
              AND b.organization_id = ? AND b.principal_id = ?
              AND b.membership_id = ? AND b.membership_type = ?
              AND m.status = 'active'`,
        )
        .get(
          input.selector.source_adapter_id,
          input.selector.source_instance_id,
          input.organization_id,
          input.principal_id,
          input.membership_id,
          input.membership_type,
        );
      if (owned === undefined) {
        throw new PersonMemberExclusionSourceDeniedError();
      }

      const externalId =
        input.selector.scope === 'source' ? '' : input.selector.external_id;
      if (input.excluded) {
        database
          .prepare(
            `INSERT INTO authority_processing_member_exclusions (
               organization_id, principal_id, membership_id, membership_type,
               source_adapter_id, source_instance_id, scope_kind, external_id,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (
               membership_id, source_adapter_id, source_instance_id,
               scope_kind, external_id
             ) DO NOTHING`,
          )
          .run(
            input.organization_id,
            input.principal_id,
            input.membership_id,
            input.membership_type,
            input.selector.source_adapter_id,
            input.selector.source_instance_id,
            input.selector.scope,
            externalId,
            this.now(),
          );
      } else {
        database
          .prepare(
            `DELETE FROM authority_processing_member_exclusions
              WHERE organization_id = ? AND principal_id = ?
                AND membership_id = ? AND membership_type = ?
                AND source_adapter_id = ? AND source_instance_id = ?
                AND scope_kind = ? AND external_id = ?`,
          )
          .run(
            input.organization_id,
            input.principal_id,
            input.membership_id,
            input.membership_type,
            input.selector.source_adapter_id,
            input.selector.source_instance_id,
            input.selector.scope,
            externalId,
          );
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      database.close();
    }
  }
}
