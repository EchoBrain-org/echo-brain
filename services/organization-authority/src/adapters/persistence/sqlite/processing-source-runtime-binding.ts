import { assertFederationId } from '@echo-brain/federation-protocol';
import { openAndMigrateAuthorityDatabase } from './open-database.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface AuthorityProcessingSourceRuntimeBinding {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly source_adapter_id: 'granola';
  readonly source_instance_id: string;
  readonly owner_email_sha256: `sha256:${string}`;
  readonly credential_scope: 'organization';
  readonly credential_reference_sha256: `sha256:${string}`;
}

export interface AuthorityProcessingSourceStoredBinding
  extends AuthorityProcessingSourceRuntimeBinding {
  /** Source custody follows the immutable owner membership's current status. */
  readonly custody_status: 'active' | 'inactive';
}

interface SourceRuntimeBindingRow extends AuthorityProcessingSourceRuntimeBinding {
  membership_status: string;
}

/**
 * Reads the immutable source/configuration tuple even after its custodian has
 * been revoked. This is the only static reader suitable for terminal-record
 * recovery; it grants no processing capability by itself.
 */
export function readAuthorityProcessingSourceStoredBinding(
  databasePath: string,
  organizationId: string,
): AuthorityProcessingSourceStoredBinding | null {
  assertFederationId(
    organizationId,
    'org',
    'processing runtime organization_id',
  );
  const database = openAndMigrateAuthorityDatabase(databasePath, {
    fileMustExist: true,
  });
  try {
    const count = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM authority_processing_source_owner_bindings
          WHERE organization_id = ?`,
      )
      .get(organizationId) as { count: number };
    if (count.count === 0) return null;
    if (count.count !== 1) {
      throw new Error(
        'minimum Authority processing runtime requires exactly one meeting source',
      );
    }
    const row = database
      .prepare(
        `SELECT b.organization_id, b.principal_id, b.membership_id,
                b.membership_type, b.source_adapter_id,
                b.source_instance_id, c.owner_email_sha256,
                c.credential_scope, c.credential_reference_sha256,
                m.status AS membership_status
           FROM authority_processing_source_owner_bindings AS b
           JOIN authority_processing_source_configuration_bindings AS c
             ON c.source_adapter_id = b.source_adapter_id
            AND c.source_instance_id = b.source_instance_id
           JOIN authority_memberships AS m
             ON m.organization_id = b.organization_id
            AND m.principal_id = b.principal_id
            AND m.membership_id = b.membership_id
            AND m.membership_type = b.membership_type
          WHERE b.organization_id = ?`,
      )
      .get(organizationId) as SourceRuntimeBindingRow | undefined;
    if (row === undefined) {
      throw new Error(
        'Authority processing source lacks its exact configuration or membership binding',
      );
    }
    if (
      (row.membership_status !== 'active' &&
        row.membership_status !== 'revoked') ||
      row.source_adapter_id !== 'granola' ||
      row.credential_scope !== 'organization' ||
      (row.membership_type !== 'owner' && row.membership_type !== 'employee') ||
      !/^[a-z][a-z0-9-]{0,127}$/.test(row.source_instance_id) ||
      !DIGEST.test(row.owner_email_sha256) ||
      !DIGEST.test(row.credential_reference_sha256)
    ) {
      throw new Error('Authority processing source runtime binding is invalid');
    }
    assertFederationId(row.principal_id, 'prn', 'processing source principal_id');
    assertFederationId(row.membership_id, 'mem', 'processing source membership_id');
    const { membership_status: _membershipStatus, ...binding } = row;
    return Object.freeze({
      ...binding,
      custody_status:
        row.membership_status === 'active' ? 'active' : 'inactive',
    });
  } finally {
    database.close();
  }
}

/** Reads only the active source admitted by the normal polling runtime. */
export function readAuthorityProcessingSourceRuntimeBinding(
  databasePath: string,
  organizationId: string,
): AuthorityProcessingSourceRuntimeBinding | null {
  const stored = readAuthorityProcessingSourceStoredBinding(
    databasePath,
    organizationId,
  );
  if (stored === null || stored.custody_status !== 'active') return null;
  const { custody_status: _custodyStatus, ...binding } = stored;
  return Object.freeze(binding);
}
