import type {
  OrganizationPersonSlackLinkBeginRequestV2,
  OrganizationPersonSlackLinkBeginResponseV2,
  OrganizationPersonSlackLinkCompleteRequestV2,
  OrganizationPersonSlackLinkResultV2,
} from '@echo-brain/organization-api';

/** The two identity-only Person Slack operations visible to HTTP. */
export interface PersonSlackIdentityLinkHttpApplication {
  begin(
    input: OrganizationPersonSlackLinkBeginRequestV2,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<OrganizationPersonSlackLinkBeginResponseV2>;
  complete(
    input: OrganizationPersonSlackLinkCompleteRequestV2,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<OrganizationPersonSlackLinkResultV2>;
}
