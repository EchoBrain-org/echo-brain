// Ceremony-owned copies of the small organization HTTP contract surface used
// before the materialized employee and authority artifacts are running.
//
// Importing the workspace package here would execute gitignored build output
// before the ceremony can attest it. Architecture tests pin these values to the
// package contract, while this tracked module lets the ceremony compare every
// repository-owned byte it executes directly with HEAD.
export const TRUSTED_PROXY_AUTHORIZATION_HEADER =
  "x-echo-proxy-authorization";
export const TRUSTED_PROXY_CLIENT_ID_HEADER =
  "x-echo-authenticated-client-id";
export const ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH =
  "/v1/authority-descriptor";
export const ORGANIZATION_API_ADMIN_OVERVIEW_PATH = "/v1/admin/overview";
