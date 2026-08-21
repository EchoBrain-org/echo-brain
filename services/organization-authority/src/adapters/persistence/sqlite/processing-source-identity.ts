import Database from 'better-sqlite3';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import { personLoginGrantExpectedEmailSha256 } from '../../../domain/person-email-binding.js';

export interface AuthorityProcessingIdentityBinding {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
}

/**
 * Proves the raw provider-owner email matches an active OIDC identity's exact
 * administrator-approved bootstrap email without storing or returning it.
 */
export function assertAuthorityProcessingOwnerEmailBinding(
  databasePath: string,
  binding: AuthorityProcessingIdentityBinding,
  ownerEmail: string,
): Sha256Digest {
  const expectedEmailSha256 = personLoginGrantExpectedEmailSha256(ownerEmail);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const matched = database
      .prepare(
        `SELECT 1
           FROM authority_oidc_identity_bindings identity_binding
           JOIN authority_person_login_grants login_grant
             ON login_grant.login_grant_sha256 =
                  identity_binding.initial_login_grant_sha256
            AND login_grant.organization_id = identity_binding.organization_id
            AND login_grant.principal_id = identity_binding.principal_id
            AND login_grant.membership_id = identity_binding.membership_id
            AND login_grant.membership_type = identity_binding.membership_type
           JOIN authority_memberships membership
             ON membership.membership_id = identity_binding.membership_id
            AND membership.organization_id = identity_binding.organization_id
            AND membership.principal_id = identity_binding.principal_id
            AND membership.membership_type = identity_binding.membership_type
          WHERE identity_binding.organization_id = ?
            AND identity_binding.principal_id = ?
            AND identity_binding.membership_id = ?
            AND identity_binding.membership_type = ?
            AND identity_binding.status = 'active'
            AND membership.status = 'active'
            AND login_grant.consumed_at = identity_binding.bound_at
            AND login_grant.expected_email_sha256 = ?
          LIMIT 1`,
      )
      .get(
        binding.organization_id,
        binding.principal_id,
        binding.membership_id,
        binding.membership_type,
        expectedEmailSha256,
      );
    if (matched === undefined) {
      throw new Error(
        'processing source owner email does not match an active approved Person identity',
      );
    }
    return expectedEmailSha256;
  } finally {
    database.close();
  }
}
