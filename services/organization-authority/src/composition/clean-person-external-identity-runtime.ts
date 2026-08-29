import type { PersonAccessAuthorization } from "../application/person-identity-sessions.js";
import type { PersonExternalIdentityLinkHttpApplicationV1 } from "../presentation/person-external-identity-link-http-application.js";

/**
 * Provider-neutral inputs available after the Person runtime has opened its
 * Authority session store. External identity providers own all connection,
 * token, and channel details behind this boundary.
 */
export interface CleanPersonExternalIdentityRuntimeInputV1 {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly authentication: {
    authenticateAccess(input: {
      readonly access_token: string;
    }): PersonAccessAuthorization;
  };
  readonly membership_type: (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }) => "employee" | "owner";
}

export interface OpenedCleanPersonExternalIdentityRuntimeV1 {
  /** The currently-versioned external-identity HTTP application. */
  readonly application: PersonExternalIdentityLinkHttpApplicationV1;
  close(): void;
}

/**
 * Builds an optional external-identity application. Person runtime does not
 * select a provider or inspect provider connection material.
 */
export interface CleanPersonExternalIdentityRuntimeBundleV1 {
  open(
    input: CleanPersonExternalIdentityRuntimeInputV1,
  ): OpenedCleanPersonExternalIdentityRuntimeV1;
}
