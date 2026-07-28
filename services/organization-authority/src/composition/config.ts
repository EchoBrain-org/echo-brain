import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface DevelopmentSignerConfig {
  authority_id: string;
  organization_id: string;
  key_directory: string;
}

export interface AuthorityServeConfig extends DevelopmentSignerConfig {
  state_directory: string;
  organization_display_name: string;
  authority_pin_sha256: `sha256:${string}`;
  database_path: string;
  admin_token: string;
  trusted_proxy_token: string;
  host: '127.0.0.1' | '::1';
  port: number;
  active_lease_ttl_ms: number;
  access_request_maximum_age_ms: number;
}

function normalizedAbsolute(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function pathIsWithin(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

export function assertAuthorityServeStateBoundary(
  config: Pick<
    AuthorityServeConfig,
    'state_directory' | 'database_path' | 'key_directory'
  >,
): void {
  if (
    !normalizedAbsolute(config.state_directory) ||
    config.state_directory === resolve('/')
  ) {
    throw new Error(
      'authority state directory must be a normalized absolute path',
    );
  }
  if (
    !normalizedAbsolute(config.database_path) ||
    !pathIsWithin(config.database_path, config.state_directory) ||
    config.database_path !== join(config.state_directory, 'authority.sqlite')
  ) {
    throw new Error(
      'authority database must use the canonical state-directory path',
    );
  }
  if (
    !normalizedAbsolute(config.key_directory) ||
    !pathIsWithin(config.key_directory, config.state_directory) ||
    config.key_directory !== join(config.state_directory, 'keys')
  ) {
    throw new Error(
      'authority key directory must use the canonical state-directory path',
    );
  }
}

export function assertPersistentAuthorityDatabasePath(
  databasePath: string,
): void {
  if (databasePath === ':memory:') {
    throw new Error(
      'authority config database_path must use persistent storage when serving',
    );
  }
}

export function assertIndependentAuthorityTokens(
  adminToken: string,
  trustedProxyToken: string,
): void {
  if (adminToken === trustedProxyToken) {
    throw new Error(
      'administrator and trusted proxy tokens must be distinct credentials',
    );
  }
}
