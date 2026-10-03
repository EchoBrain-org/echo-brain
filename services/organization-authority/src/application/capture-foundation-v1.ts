import {
  assertPlainContextObjectV1, canonicalSourceContentV1,
  type CaptureBindingsV1, type ContextCaptureEnvelopeV2,
} from '@echo-brain/organization-processing/core';

/**
 * Callers must hold acquisition/inspection permission before local-rule classification.
 * This later fence never retroactively authorizes model/network processing.
 * Trusted composition must check current custody/retention consent, allowed representation,
 * current adapter/container-to-project association, each verified source-identity witness, and processing eligibility.
 * For document originals, also verify accepted artifact custody for the exact descriptor.
 * The configured container allowlist and artifact descriptor are not continuing permission.
 * This is internal processing authorization, never a Person read grant. Checks are synchronous
 * against the same Authority transaction; a historical annotation is not an authorization.
 */
export interface CaptureFoundationAuthorityV1 {
  requireCurrent(input: {
    readonly operation: 'retain' | 'derive';
    readonly source: ContextCaptureEnvelopeV2;
    readonly bindings: CaptureBindingsV1;
  }): void;
}
export function requireCurrentCaptureAuthorityV1(authority: CaptureFoundationAuthorityV1, input: Parameters<CaptureFoundationAuthorityV1['requireCurrent']>[0]): void {
  const result: unknown = authority.requireCurrent(input);
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new Error('Capture Authority fence must complete synchronously');
  }
}
/** Freeze plain data before passing it to another owner, with no shared mutable references. */
export function snapshotCaptureDataV1<T>(value: T): T {
  assertPlainContextObjectV1(value, Object.keys(value as object), 'Capture data');
  function freeze<V>(data: V): V {
    if (data !== null && typeof data === 'object') { for (const child of Object.values(data)) freeze(child); Object.freeze(data); }
    return data;
  }
  return freeze(JSON.parse(canonicalSourceContentV1(value)) as T);
}
