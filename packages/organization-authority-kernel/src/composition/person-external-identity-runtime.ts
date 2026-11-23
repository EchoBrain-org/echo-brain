import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from "../application/ports/person-access-authorization.js";
import type { ProviderHttpApplicationV1 } from "../application/ports/provider-http-application-v1.js";

/**
 * Provider-neutral inputs available after the Person runtime has opened its
 * Authority session store. External identity providers own all connection,
 * token, and channel details behind this boundary.
 */
export interface PersonExternalIdentityRuntimeInputV1 {
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
  /**
   * Whether the Authority still holds this exact membership active. A removed
   * or unknown one is not; a failed read throws and decides nothing.
   */
  readonly membership_active: (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }) => boolean;
}

export interface OpenedPersonExternalIdentityRuntimeV1 {
  /** The currently-versioned external-identity HTTP application. */
  readonly application: ProviderHttpApplicationV1;
  tools(accessToken: string): Promise<readonly OrganizationPersonToolV4[]>;
  /**
   * The Authority removed this membership: its external identity link and any
   * link proof still under way end at `now`, the Authority's time. A system
   * action with no Person session; repeating it changes nothing.
   */
  endMembershipLinks(input: {
    readonly principal_id: string;
    readonly membership_id: string;
    readonly now: string;
  }): void;
  close(): void;
}

/**
 * Builds an optional external-identity application. Person runtime does not
 * select a provider or inspect provider connection material.
 */
export interface PersonExternalIdentityRuntimeBundleV1 {
  open(
    input: PersonExternalIdentityRuntimeInputV1,
  ): OpenedPersonExternalIdentityRuntimeV1;
}
