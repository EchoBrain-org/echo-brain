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

/** Shared wire primitives and binding validation; provider fields remain adapter-owned. */
export function createPersonProviderValidationV1(id: string, scope: RegExp, message: string) {
  const failure: PersonProviderV1['failure'] = code => { throw new AuthorityOperationError(code, message); };
  function string(value: unknown, maximum = 256, pattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u): string {
    if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum ||
        value !== value.normalize('NFC') || !pattern.test(value)) failure('invalid_output');
    return value;
  }
  function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d) || !d.enumerable)) failure('invalid_output');
    return value as Record<string, unknown>;
  }
  function array(value: unknown, maximum: number): readonly unknown[] {
    if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1) failure('invalid_output');
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (d === undefined || !('value' in d) || !d.enumerable) failure('invalid_output');
    }
    return value;
  }
  function copyBinding(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1 {
    record(value);
    for (const field of ['organization_id', 'principal_id', 'membership_id', 'external_subject_id'] as const) string(value[field]);
    if (value.tool_id !== id || typeof value.external_scope_id !== 'string' || !scope.test(value.external_scope_id) ||
        !/^sha256:[0-9a-f]{64}$/.test(value.read_grant_sha256)) failure('unauthorized');
    return Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id,
      tool_id: id, external_scope_id: value.external_scope_id, external_subject_id: value.external_subject_id, read_grant_sha256: value.read_grant_sha256 });
  }
  return Object.freeze({ failure, string, record, array, copyBinding });
}
