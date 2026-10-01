// R2b: remove this module with its only caller, the service CLI. Its result is ignored:
// the browser link now uses the connected app's own client from its credential bundle.
import { resolve } from 'node:path';
import { readOptionalPrivateAuthoritySlackBrowserOauthConfiguration } from '../slack-private-credentials-v1.js';
export function readSlackBrowserOauthConfiguration(input: {
  readonly state_directory: string;
  readonly authority_url: string;
}): { readonly client_id: string; readonly client_secret: string; readonly redirect_uri: string } | undefined {
  const path = resolve(
    input.state_directory,
    "..",
    "private",
    "slack-browser-oidc.json",
  );
  const configured = readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
    `file:${path}`,
  );
  if (configured === undefined) return undefined;
  return Object.freeze({
    ...configured,
    redirect_uri: `${input.authority_url}/v2/person/external-identities/slack/browser/callback`,
  });
}
