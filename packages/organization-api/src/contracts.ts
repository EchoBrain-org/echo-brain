import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';

export type OrganizationApiSha256Digest = Sha256Digest;

export type OrganizationPersonOidcBeginRequestV2 =
  | {
      kind: 'identity_bootstrap';
      login_grant: string;
      /**
       * Optional one-shot local receiver. The Authority holds this exact
       * binding process-locally by OIDC state and posts the resulting session
       * there only after a verified callback.
       */
      loopback_handoff?: {
        url: string;
        token: string;
      };
      /**
       * Optional address the client read from its own invitation artifact. The
       * Authority never trusts it: it forwards the value as an OIDC
       * `login_hint` only when the digest matches the grant's stored
       * `expected_email_sha256`, and otherwise ignores it entirely. It can
       * therefore only pre-select the account the invitation already names.
       */
      login_hint?: string;
    }
  | {
      kind: 'existing_identity_login';
      loopback_handoff?: {
        url: string;
        token: string;
      };
    };

export interface OrganizationPersonOidcBeginResponseV2 {
  authorization_url: string;
  expires_at: string;
}

/** The exact Authority-issued credential pair returned by callback/refresh. */
export interface OrganizationPersonSessionV2 {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  /** Server-owned name from the authenticated membership row. */
  display_name: string;
  membership_type: 'owner' | 'employee';
  identity_binding_id: string;
  session_family_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  hard_reauthentication_at: string;
}

export interface OrganizationPersonSessionRefreshRequestV2 {
  refresh_token: string;
}

export interface OrganizationAuthorityDescriptorResponseV1 {
  authority_descriptor: OrganizationAuthorityDescriptorV1;
}

export interface OrganizationApiErrorV1 {
  error: {
    code: string;
    message: string;
  };
}
