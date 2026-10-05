import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

export type PersonProviderFailureCodeV1 = 'invalid_request' | 'invalid_output' | 'unauthorized' | 'not_found' | 'stale_access_state' | 'unavailable' | 'rate_limited';

/** Fixed server composition. Product adapters retain their existing validation and error contracts. */
export interface PersonProviderV1 {
  readonly id: string;
  /** Compiled provider registration, never a request field or Nango integration ID. */
  readonly storage_namespace: string;
  readonly display_name: string;
  readonly nango_provider_id: string;
  readonly scope_id_pattern: RegExp;
  readonly oauth_scopes: string;
  readonly credential_origin: string;
  /** A trailing slash denotes a prefix; every other entry is an exact path. */
  credential_paths(cloudId: string): readonly string[];
  failure(code: PersonProviderFailureCodeV1): never;
  string(value: unknown, maximum?: number, pattern?: RegExp): string;
  record(value: unknown): Record<string, unknown>;
  array(value: unknown, maximum: number): readonly unknown[];
  copyBinding(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1;
}

/** Validate the SQL identifier once before constructing provider-owned table names. */
export function personProviderStorageNamespaceV1(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new AuthorityOperationError('invalid_request', 'Provider storage namespace is invalid');
  }
  return value;
}
