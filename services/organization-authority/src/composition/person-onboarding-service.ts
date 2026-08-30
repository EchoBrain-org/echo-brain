import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-dependencies.js";
import { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import { NodePersonSessionCrypto } from "../adapters/security/node-person-session-crypto.js";
import { createPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import { SqlitePersonSessionRepository } from "../adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-authority-database.js";
import { SystemAuthorityClock } from "../adapters/system/system-authority-clock.js";
import {
  discardPersonOnboardingInvitation,
  reservePersonOnboardingInvitationTarget,
  writePersonOnboardingInvitation,
} from "../adapters/files/private-person-onboarding-invitation.js";
import { verifyOrganizationAuthorityApiLineage } from "./organization-authority-api-runtime.js";

// This on-disk name is part of the installed-state layout and remains stable.
export const PERSON_SESSION_PKCE_KEY_FILENAME = "person-session-pkce-sealing-key";

export interface InitializedPersonSessionCredentials {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-runtime-credentials-v1";
  readonly pkce_sealing_key_reference: string;
}

/** Create-once private runtime material. The secret itself is never returned. */
export function initializePersonSessionCredentials(input: {
  readonly state_directory: string;
}): InitializedPersonSessionCredentials {
  verifyOrganizationAuthorityApiLineage(input.state_directory);
  const directory = join(input.state_directory, "credentials");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, PERSON_SESSION_PKCE_KEY_FILENAME);
  createPrivateAuthorityCredential(path);
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-runtime-credentials-v1",
    pkce_sealing_key_reference: `file:${path}`,
  });
}

export interface IssuePersonOnboardingInvitationInput {
  readonly state_directory: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly pkce_sealing_key: Uint8Array;
  readonly membership_id: string;
  readonly expected_email: string;
  readonly authority_url: string;
  readonly output_path: string;
}

/**
 * A stopped-state, organization-owner invitation operation. It has no administrator
 * bearer token and keeps the one-time grant out of stdout and command flags.
 */
export function issuePersonOnboardingInvitation(
  input: IssuePersonOnboardingInvitationInput,
): {
  readonly output_path: string;
  readonly expires_at: string;
} {
  verifyOrganizationAuthorityApiLineage(input.state_directory);
  const reservation = reservePersonOnboardingInvitationTarget({
    output_path: input.output_path,
    authority_url: input.authority_url,
  });
  let database: ReturnType<typeof openAuthorityDatabase> | undefined;
  try {
    database = openAuthorityDatabase(
      join(input.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const crypto = new NodePersonSessionCrypto(input.pkce_sealing_key);
    const sessions = new PersonIdentitySessionApplication(
      new SqlitePersonSessionRepository(database),
      input.oidc,
      {
        clock: new SystemAuthorityClock(),
        random: crypto,
        hash: crypto,
        pkce_sealer: crypto,
        oidc_provider: {
          async redeemAuthorizationCode() {
            return {
              kind: "terminal_failure",
              diagnostic_stage: "configuration",
            };
          },
        },
      },
    );
    const issued = sessions.issueBootstrapLoginGrant({
      target_membership_id: input.membership_id,
      expected_issuer: input.oidc.issuer,
      expected_email: input.expected_email,
    });
    writePersonOnboardingInvitation(reservation, issued);
    return Object.freeze({
      output_path: reservation.output_path,
      expires_at: issued.expires_at,
    });
  } catch (error) {
    // The writer itself removes an incomplete file. Before it is called, the
    // reservation remains private and must also be discarded.
    try {
      discardPersonOnboardingInvitation(reservation);
    } catch {}
    throw error;
  } finally {
    database?.close();
  }
}
