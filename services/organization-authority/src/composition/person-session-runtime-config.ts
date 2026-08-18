import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type { PersonSessionOidcConfiguration } from '../application/ports/person-session-runtime.js';
import {
  readPrivateAuthorityOidcClientSecret,
  readPrivateAuthorityPersonSessionPkceKey,
} from '../adapters/security/private-file-credentials.js';
import type { AuthorityRuntimeConfigV1 } from './operator-config.js';

export const AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME =
  'person-session-runtime.v1.json';
export const AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME =
  'person-session-pkce-sealing-key';
export const AUTHORITY_PERSON_SESSION_OIDC_CLIENT_SECRET_FILENAME =
  'person-session-oidc-client-secret';

const MAXIMUM_OVERLAY_BYTES = 32 * 1024;
const PERSON_SESSION_CALLBACK_PATH = '/v2/session/oidc/callback';

export type AuthorityPersonSessionClientAuthenticationV1 =
  | { method: 'none' }
  | {
      method: 'client_secret_basic';
      client_secret_ref: string;
    };

export interface AuthorityPersonSessionRuntimeOverlayV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-person-session-runtime-overlay';
  authority_id: string;
  organization_id: string;
  oidc: PersonSessionOidcConfiguration & {
    client_authentication: AuthorityPersonSessionClientAuthenticationV1;
  };
  pkce_sealing_key_ref: string;
}

export interface ResolvedAuthorityPersonSessionRuntimeV1 {
  overlay_sha256: `sha256:${string}`;
  oidc_configuration: PersonSessionOidcConfiguration;
  client_authentication:
    | { method: 'none' }
    | { method: 'client_secret_basic'; client_secret: string };
  pkce_sealing_key: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactHttpsUrl(
  value: unknown,
  label: string,
  callback = false,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value ||
    parsed.search !== '' ||
    (callback && parsed.pathname !== PERSON_SESSION_CALLBACK_PATH)
  ) {
    throw new Error(`${label} must be an exact absolute HTTPS URL`);
  }
  return value;
}

function tenantConstraint(
  value: unknown,
): PersonSessionOidcConfiguration['tenant'] {
  const tenant = record(value, 'Person-session OIDC tenant');
  if (tenant.kind === 'issuer') {
    exactKeys(tenant, ['kind'], 'Person-session OIDC issuer tenant');
    return { kind: 'issuer' };
  }
  if (tenant.kind === 'claim') {
    exactKeys(
      tenant,
      ['kind', 'claim_name', 'claim_value'],
      'Person-session OIDC claim tenant',
    );
    return {
      kind: 'claim',
      claim_name: boundedText(
        tenant.claim_name,
        'Person-session OIDC tenant claim name',
      ),
      claim_value: boundedText(
        tenant.claim_value,
        'Person-session OIDC tenant claim value',
      ),
    };
  }
  throw new Error('Person-session OIDC tenant kind is unsupported');
}

function clientAuthentication(
  value: unknown,
  clientSecretReference: string,
): AuthorityPersonSessionClientAuthenticationV1 {
  const authentication = record(
    value,
    'Person-session OIDC client authentication',
  );
  if (authentication.method === 'none') {
    exactKeys(authentication, ['method'], 'Person-session public client');
    return { method: 'none' };
  }
  if (authentication.method === 'client_secret_basic') {
    exactKeys(
      authentication,
      ['method', 'client_secret_ref'],
      'Person-session confidential client',
    );
    if (authentication.client_secret_ref !== clientSecretReference) {
      throw new Error(
        'Person-session OIDC client secret must use the fixed private file',
      );
    }
    return {
      method: 'client_secret_basic',
      client_secret_ref: clientSecretReference,
    };
  }
  throw new Error(
    'Person-session OIDC client authentication method is unsupported',
  );
}

function validateOverlay(
  value: unknown,
  config: AuthorityRuntimeConfigV1,
  pkceKeyReference: string,
  clientSecretReference: string,
): AuthorityPersonSessionRuntimeOverlayV1 {
  const root = record(value, 'Person-session runtime overlay');
  exactKeys(
    root,
    [
      'schema_version',
      'kind',
      'authority_id',
      'organization_id',
      'oidc',
      'pkce_sealing_key_ref',
    ],
    'Person-session runtime overlay',
  );
  if (
    root.schema_version !== 1 ||
    root.kind !==
      'echo-organization-authority-person-session-runtime-overlay'
  ) {
    throw new Error('Person-session runtime overlay identity is unsupported');
  }
  if (
    root.authority_id !== config.authority.authority_id ||
    root.organization_id !== config.organization.organization_id
  ) {
    throw new Error(
      'Person-session runtime overlay belongs to another Authority',
    );
  }
  if (root.pkce_sealing_key_ref !== pkceKeyReference) {
    throw new Error(
      'Person-session PKCE key must use the fixed private file',
    );
  }

  const oidc = record(root.oidc, 'Person-session OIDC configuration');
  exactKeys(
    oidc,
    [
      'issuer',
      'client_id',
      'redirect_uri',
      'tenant',
      'id_token_algorithms',
      'client_authentication',
    ],
    'Person-session OIDC configuration',
  );
  if (
    !Array.isArray(oidc.id_token_algorithms) ||
    oidc.id_token_algorithms.length !== 1 ||
    oidc.id_token_algorithms.some(
      (algorithm) =>
        typeof algorithm !== 'string' ||
        algorithm.length === 0 ||
        algorithm.length > 100,
    )
  ) {
    throw new Error(
      'Person-session ID-token algorithm allowlist must contain one algorithm',
    );
  }
  const authentication = clientAuthentication(
    oidc.client_authentication,
    clientSecretReference,
  );
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-person-session-runtime-overlay',
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    oidc: {
      issuer: exactHttpsUrl(oidc.issuer, 'Person-session OIDC issuer'),
      client_id: boundedText(oidc.client_id, 'Person-session OIDC client ID'),
      redirect_uri: exactHttpsUrl(
        oidc.redirect_uri,
        'Person-session OIDC redirect URI',
        true,
      ),
      tenant: tenantConstraint(oidc.tenant),
      id_token_algorithms: [...oidc.id_token_algorithms] as string[],
      client_authentication: authentication,
    },
    pkce_sealing_key_ref: pkceKeyReference,
  };
}

function readPrivateOverlay(path: string): string | undefined {
  let state;
  try {
    state = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAXIMUM_OVERLAY_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      'Person-session runtime overlay must be a bounded current-user 0600 canonical file',
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error('Person-session runtime overlay changed while opening');
    }
    return readFileSync(file, 'utf8');
  } finally {
    closeSync(file);
  }
}

/** Presence of the one fixed overlay opts the Authority into Person sessions. */
export function readAuthorityPersonSessionRuntimeOverlay(
  config: AuthorityRuntimeConfigV1,
): ResolvedAuthorityPersonSessionRuntimeV1 | undefined {
  const overlayPath = join(
    config.state_dir,
    AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME,
  );
  const contents = readPrivateOverlay(overlayPath);
  if (contents === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Person-session runtime overlay is not valid JSON');
  }
  const credentialDirectory = join(config.state_dir, 'credentials');
  const pkceKeyReference = `file:${join(
    credentialDirectory,
    AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME,
  )}`;
  const clientSecretReference = `file:${join(
    credentialDirectory,
    AUTHORITY_PERSON_SESSION_OIDC_CLIENT_SECRET_FILENAME,
  )}`;
  const overlay = validateOverlay(
    parsed,
    config,
    pkceKeyReference,
    clientSecretReference,
  );
  const authentication = overlay.oidc.client_authentication;
  const oidcConfiguration: PersonSessionOidcConfiguration = {
    issuer: overlay.oidc.issuer,
    client_id: overlay.oidc.client_id,
    redirect_uri: overlay.oidc.redirect_uri,
    tenant: overlay.oidc.tenant,
    id_token_algorithms: [...overlay.oidc.id_token_algorithms],
  };
  return Object.freeze({
    overlay_sha256: `sha256:${createHash('sha256')
      .update(canonicalJson(overlay))
      .digest('hex')}`,
    oidc_configuration: Object.freeze(oidcConfiguration),
    client_authentication:
      authentication.method === 'none'
        ? Object.freeze({ method: 'none' as const })
        : Object.freeze({
            method: 'client_secret_basic' as const,
            client_secret: readPrivateAuthorityOidcClientSecret(
              authentication.client_secret_ref,
            ),
          }),
    pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
      overlay.pkce_sealing_key_ref,
    ),
  });
}
