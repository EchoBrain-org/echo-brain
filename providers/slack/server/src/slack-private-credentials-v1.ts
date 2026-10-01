// R2b: remove this module with its only caller, `setup/slack-browser-oauth-configuration-v1.ts`.
// The browser link now uses the connected app's own client from its credential bundle.
import {
  authorityCredentialPath,
  MAXIMUM_CREDENTIAL_BYTES,
  privateAuthorityCredentialFailure as fail,
  readPrivateAuthorityCredentialFile,
} from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { lstatSync } from 'node:fs';

export interface SlackBrowserOauthConfigurationV1 {
  readonly client_id: string;
  readonly client_secret: string;
}

/** Keeps the optional Slack browser OAuth secret in process memory only. */
export function readPrivateAuthoritySlackBrowserOauthConfiguration(
  reference: string,
): SlackBrowserOauthConfigurationV1 {
  const value = readPrivateAuthorityCredentialFile(reference, 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail('Slack browser OAuth configuration must be valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'client_id,client_secret'
  ) {
    fail('Slack browser OAuth configuration has an unexpected shape');
  }
  const record = parsed as Record<string, unknown>;
  const clientId = record.client_id;
  const clientSecret = record.client_secret;
  if (
    typeof clientId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(clientId) ||
    typeof clientSecret !== 'string' ||
    clientSecret.length === 0 ||
    clientSecret.length > MAXIMUM_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/.test(clientSecret)
  ) {
    fail('Slack browser OAuth configuration is invalid');
  }
  return Object.freeze({ client_id: clientId, client_secret: clientSecret });
}

/** Missing configuration reads as undefined. */
export function readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
  reference: string,
): SlackBrowserOauthConfigurationV1 | undefined {
  const path = authorityCredentialPath(reference);
  try {
    lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readPrivateAuthoritySlackBrowserOauthConfiguration(reference);
}
